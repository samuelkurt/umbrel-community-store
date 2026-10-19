'use strict';
// Performance numbers of the computer Blockhaus runs on, read from /proc and /sys (Linux only).
// A sampler runs every 2 s and keeps the last hour in memory so the "Leistung" page has a history the moment it opens.
// Everything is read-only; nothing here needs root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLK_TCK = 100;           // USER_HZ is 100 on every Linux the panel will run on
const PAGE = 4096;
const SAMPLE_MS = 2000;
const KEEP = 1800;             // 1 h at 2 s
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'zfs', 'f2fs', 'fuseblk']);

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// ---- pure parsers (tested against fixtures) ----------------------------------------------------------------------
function parseStat(text) {
  const out = { total: null, cores: [] };
  for (const line of String(text || '').split('\n')) {
    const m = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    if (v.length < 4) continue;
    const idle = v[3] + (v[4] || 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    const rec = { idle, total, iowait: v[4] || 0, steal: v[7] || 0 };
    if (m[1] === '') out.total = rec; else out.cores.push(rec);
  }
  return out;
}

function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const total = kb.MemTotal || 0;
  const available = kb.MemAvailable !== undefined ? kb.MemAvailable : (kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0);
  return {
    total, available, used: Math.max(0, total - available), cached: (kb.Cached || 0) + (kb.Buffers || 0),
    swapTotal: kb.SwapTotal || 0, swapUsed: Math.max(0, (kb.SwapTotal || 0) - (kb.SwapFree || 0)),
  };
}

function parseLoadavg(text) {
  const p = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? p : [0, 0, 0];
}

const VIRTUAL_NIC = /^(lo|veth|docker|br-|virbr|tun|tap|ifb|dummy|bond0_|vnet|cni|flannel|cali)/;
function parseNetDev(text) {
  const nics = {};
  for (const line of String(text || '').split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    if (v.length < 9) continue;
    nics[m[1]] = { rx: v[0], tx: v[8] };
  }
  return nics;
}

const PHYS_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
function parseDiskstats(text) {
  let rd = 0; let wr = 0; let busyMs = 0;
  for (const line of String(text || '').split('\n')) {
    const v = line.trim().split(/\s+/);
    if (v.length < 14 || !PHYS_DISK.test(v[2])) continue;
    rd += Number(v[5]) * 512; wr += Number(v[9]) * 512; busyMs += Number(v[12]) || 0;
  }
  return { rd, wr, busyMs };
}

/** "cpu" temperature candidates first. `tree` = { hwmon: [{name, temps:[{label,milli}]}], thermal: [{type, milli}] } */
function pickTemps(tree) {
  const list = [];
  for (const h of tree.hwmon || []) for (const t of h.temps) list.push({ label: `${h.name}${t.label ? ' ' + t.label : ''}`, c: t.milli / 1000, chip: h.name });
  if (!list.length) for (const z of tree.thermal || []) list.push({ label: z.type, c: z.milli / 1000, chip: z.type });
  const sane = list.filter((t) => t.c > -20 && t.c < 150);
  const cpuChip = /^(coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp|cpu-thermal|soc_thermal)/;
  const cpu = sane.filter((t) => cpuChip.test(t.chip));
  const main = (cpu.length ? cpu : sane).reduce((m, t) => (m === null || t.c > m ? t.c : m), null);
  return { main, all: sane.slice(0, 12).map((t) => ({ label: t.label, c: Math.round(t.c * 10) / 10 })) };
}

function readTemps() {
  const tree = { hwmon: [], thermal: [] };
  try {
    for (const d of fs.readdirSync('/sys/class/hwmon')) {
      const base = path.join('/sys/class/hwmon', d);
      const name = (read(path.join(base, 'name')) || d).trim();
      const temps = [];
      let files = [];
      try { files = fs.readdirSync(base).filter((f) => /^temp\d+_input$/.test(f)); } catch { /* none */ }
      for (const f of files) {
        const milli = Number(read(path.join(base, f)));
        if (!Number.isFinite(milli)) continue;
        const label = (read(path.join(base, f.replace('_input', '_label'))) || '').trim();
        temps.push({ label, milli });
      }
      if (temps.length) tree.hwmon.push({ name, temps });
    }
  } catch { /* no hwmon (VM, container) */ }
  try {
    for (const d of fs.readdirSync('/sys/class/thermal').filter((x) => x.startsWith('thermal_zone'))) {
      const milli = Number(read(path.join('/sys/class/thermal', d, 'temp')));
      if (Number.isFinite(milli)) tree.thermal.push({ type: (read(path.join('/sys/class/thermal', d, 'type')) || d).trim(), milli });
    }
  } catch { /* none */ }
  return pickTemps(tree);
}

// ---- power draw (watts) ----------------------------------------------------------------------------------------------
// What a Linux machine can report about itself, and ONLY that: Intel/AMD RAPL energy counters (CPU package, RAM, on newer
// Intel "psys" = whole platform), GPU power from hwmon, and the battery of a laptop. This is NOT what a plug-in power meter
// shows: PSU losses, fans, disks and the mainboard are not in these numbers.
const GPU_CHIP = /^(amdgpu|radeon|nouveau|nvidia|i915|xe)/;

/** Snapshot of every power source readable under `root` ('/sys'). `rd` reads a file (tests inject failures). */
function readPowerTree(root = '/sys', rd = (f) => fs.readFileSync(f, 'utf8')) {
  const tree = { rapl: [], hwmon: [], battery: [], denied: false };
  const num = (f) => { const v = Number(String(rd(f)).trim()); return Number.isFinite(v) ? v : null; };
  const txt = (f) => { try { return String(rd(f)).trim(); } catch { return ''; } };
  const rapl = (dir, name) => {
    try {
      const uj = num(path.join(dir, 'energy_uj'));
      if (uj === null) return;
      let max = 0; try { max = num(path.join(dir, 'max_energy_range_uj')) || 0; } catch { /* unknown range: a wrap-around is then skipped for one sample */ }
      tree.rapl.push({ name: txt(path.join(dir, 'name')) || name, uj, max });
    } catch (e) { if (e && (e.code === 'EACCES' || e.code === 'EPERM')) tree.denied = true; }
  };
  try {
    const base = path.join(root, 'class/powercap');
    for (const d of fs.readdirSync(base)) {
      if (!/^intel-rapl:\d+$/.test(d)) continue;                    // "intel-rapl-mmio:N" is the same counter again
      rapl(path.join(base, d), d);
      let subs = []; try { subs = fs.readdirSync(path.join(base, d)).filter((x) => x.startsWith(d + ':')); } catch { /* none */ }
      for (const sd of subs) rapl(path.join(base, d, sd), sd);
    }
  } catch { /* no powercap (VM, ARM, container) */ }
  try {
    const base = path.join(root, 'class/hwmon');
    for (const d of fs.readdirSync(base)) {
      const dir = path.join(base, d);
      const chip = txt(path.join(dir, 'name')) || d;
      let files = []; try { files = fs.readdirSync(dir); } catch { /* gone */ }
      for (const f of files) {
        const m = /^power(\d+)_(average|input)$/.exec(f);
        if (!m) continue;
        if (m[2] === 'input' && files.includes(`power${m[1]}_average`)) continue;   // one value per sensor
        try {
          const uw = num(path.join(dir, f));
          if (uw !== null) tree.hwmon.push({ chip, label: txt(path.join(dir, `power${m[1]}_label`)), uw, id: `${d}/${m[1]}` });
        } catch { /* unreadable */ }
      }
    }
  } catch { /* no hwmon */ }
  try {
    const base = path.join(root, 'class/power_supply');
    for (const d of fs.readdirSync(base)) {
      const dir = path.join(base, d);
      if (txt(path.join(dir, 'type')) !== 'Battery' || txt(path.join(dir, 'status')) !== 'Discharging') continue;
      let uw = null;
      try { uw = num(path.join(dir, 'power_now')); } catch { /* try current x voltage */ }
      if (uw === null) { try { const i = num(path.join(dir, 'current_now')); const v = num(path.join(dir, 'voltage_now')); if (i !== null && v !== null) uw = Math.abs(i) * v / 1e6; } catch { /* none */ } }
      if (uw !== null && uw > 0) tree.battery.push({ name: d, uw: Math.abs(uw) });
    }
  } catch { /* no battery */ }
  return tree;
}

/**
 * Watts from two snapshots `dtS` seconds apart.
 * @returns {{status:'ok'|'denied'|'none', w:number|null, label:string, parts:Array<{label:string,w:number,total:boolean}>}}
 */
function computePower(prev, cur, dtS) {
  const parts = [];
  const sources = cur.rapl.length + cur.hwmon.length + cur.battery.length;
  if (!sources) return { status: cur.denied ? 'denied' : 'none', w: null, label: '', parts };
  const out = { status: 'ok', w: null, label: '', parts, denied: cur.denied };
  const ok = prev && dtS > 0;
  const rate = (i) => {                             // domain i of the same name in the previous snapshot
    if (!ok) return null;
    const a = cur.rapl[i]; const b = prev.rapl[i];
    if (!b || b.name !== a.name) return null;
    const d = a.uj >= b.uj ? a.uj - b.uj : (a.max ? a.uj + a.max - b.uj : null);   // the counter wraps at max_energy_range_uj
    return d === null ? null : d / 1e6 / dtS;
  };
  let psys = null; let pkg = null; let dram = null;
  cur.rapl.forEach((r, i) => {
    const w = rate(i);
    if (w === null) return;
    if (r.name === 'psys') psys = (psys || 0) + w;
    else if (/^package/.test(r.name)) pkg = (pkg || 0) + w;
    else if (r.name === 'dram') dram = (dram || 0) + w;
  });
  let total = null; let label = '';
  if (psys !== null) {
    total = psys; label = 'Plattform gesamt (psys)';
    if (pkg !== null) parts.push({ label: 'Prozessor', w: pkg, total: false });
    if (dram !== null) parts.push({ label: 'Arbeitsspeicher', w: dram, total: false });
  } else if (pkg !== null) {
    total = pkg + (dram || 0); label = dram !== null ? 'Prozessor + Arbeitsspeicher' : 'Prozessor';
    parts.push({ label: 'Prozessor', w: pkg, total: true });
    if (dram !== null) parts.push({ label: 'Arbeitsspeicher', w: dram, total: true });
  }
  for (const h of cur.hwmon) {
    const w = h.uw / 1e6;
    if (!(w >= 0 && w < 5000)) continue;
    const isGpu = GPU_CHIP.test(h.chip);
    parts.push({ label: `${h.chip}${h.label ? ' ' + h.label : ''}`, w, total: isGpu });
    if (isGpu) total = (total || 0) + w;
  }
  for (const b of cur.battery) {
    const w = b.uw / 1e6;
    parts.push({ label: `Akku ${b.name} (Entladung)`, w, total: total === null });
    if (total === null) { total = w; label = 'Akku-Entladung'; }
  }
  out.w = total === null ? null : Math.round(total * 10) / 10;
  out.label = label;
  out.parts = parts.slice(0, 8).map((x) => ({ ...x, w: Math.round(x.w * 10) / 10 }));
  return out;
}

/** One process line of /proc/<pid>/stat. The name sits in parentheses and may contain spaces and ")" itself. */
function parseProcStat(s) {
  const i = s.indexOf('('); const j = s.lastIndexOf(')');
  if (i < 0 || j < i) return null;
  const rest = s.slice(j + 2).split(' ');
  return { comm: s.slice(i + 1, j), state: rest[0], ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]), threads: Number(rest[17]) };
}

function parseMounts(text) {
  const byDev = new Map();
  for (const line of String(text || '').split('\n')) {
    const p = line.split(' ');
    if (p.length < 3 || !REAL_FS.has(p[2])) continue;
    const mp = p[1].replace(/\\040/g, ' ');
    const cur = byDev.get(p[0]);
    if (!cur || mp.length < cur.mount.length) byDev.set(p[0], { device: p[0], mount: mp, fstype: p[2] }); // bind mounts: keep the shortest path
  }
  return [...byDev.values()];
}

// ---- the sampler -------------------------------------------------------------------------------------------------
class HostStats {
  /**
   * @param {object} [o]
   * @param {() => Array<{id:string,name:string,pid:number}>} [o.minecraft] running Minecraft processes
   * @param {string[]} [o.paths] extra folders whose filesystem is shown (the servers folder)
   * @param {number} [o.sampleMs]
   * @param {string} [o.sysRoot] where /sys is (tests)
   */
  constructor({ minecraft = () => [], paths = [], sampleMs = SAMPLE_MS, sysRoot = '/sys' } = {}) {
    this.minecraft = minecraft;
    this.sysRoot = sysRoot;
    this.paths = paths;
    this.sampleMs = sampleMs;
    this.series = [];            // ring of samples (compact)
    this.latest = null;
    this.prev = null;
    this.prevProcs = new Map();  // pid -> ticks
    this.prevPower = null;       // { t, tree }
    this.users = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => { try { this.sample(); } catch (e) { console.error('HostStats:', e.message); } }, this.sampleMs);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  _userName(uid) {
    if (!this.users) {
      this.users = new Map();
      for (const l of (read('/etc/passwd') || '').split('\n')) { const p = l.split(':'); if (p.length > 2) this.users.set(Number(p[2]), p[0]); }
    }
    return this.users.get(uid) || String(uid);
  }

  _scanProcs() {
    const procs = [];
    let names = [];
    try { names = fs.readdirSync('/proc'); } catch { return procs; }
    for (const n of names) {
      if (n.charCodeAt(0) < 48 || n.charCodeAt(0) > 57) continue;
      try {
        const st = parseProcStat(fs.readFileSync(`/proc/${n}/stat`, 'utf8'));
        if (!st) continue;
        const statm = fs.readFileSync(`/proc/${n}/statm`, 'utf8').split(' ');
        procs.push({ pid: Number(n), ppid: st.ppid, comm: st.comm, ticks: st.ticks, rss: Number(statm[1]) * PAGE, threads: st.threads });
      } catch { /* ended meanwhile */ }
    }
    return procs;
  }

  sample() {
    const t = Date.now();
    const stat = parseStat(read('/proc/stat'));
    const net = parseNetDev(read('/proc/net/dev'));
    const disk = parseDiskstats(read('/proc/diskstats'));
    const procs = this._scanProcs();
    const cur = { t, stat, net, disk };
    const prev = this.prev;
    this.prev = cur;

    const mem = parseMeminfo(read('/proc/meminfo'));
    const load = parseLoadavg(read('/proc/loadavg'));
    const temp = readTemps();
    const ptree = readPowerTree(this.sysRoot);
    const power = computePower(this.prevPower && this.prevPower.tree, ptree, this.prevPower ? (t - this.prevPower.t) / 1000 : 0);
    this.prevPower = { t, tree: ptree };
    const s = {
      ts: t, cpu: 0, iowait: 0, steal: 0, cores: [], load, mem, temp: temp.main, temps: temp.all, power,
      netRx: 0, netTx: 0, nics: [], diskRd: 0, diskWr: 0, diskBusy: 0, mc: [], procs: [],
    };

    const dt = prev ? (t - prev.t) / 1000 : 0;
    if (prev && dt > 0) {
      const pct = (a, b) => { const d = a.total - b.total; return d > 0 ? Math.max(0, Math.min(100, (1 - (a.idle - b.idle) / d) * 100)) : 0; };
      if (stat.total && prev.stat.total) {
        s.cpu = pct(stat.total, prev.stat.total);
        const dtot = stat.total.total - prev.stat.total.total;
        if (dtot > 0) { s.iowait = ((stat.total.iowait - prev.stat.total.iowait) / dtot) * 100; s.steal = ((stat.total.steal - prev.stat.total.steal) / dtot) * 100; }
      }
      s.cores = stat.cores.map((c, i) => (prev.stat.cores[i] ? pct(c, prev.stat.cores[i]) : 0));
      for (const [name, v] of Object.entries(net)) {
        const p = prev.net[name];
        if (!p || VIRTUAL_NIC.test(name)) continue;
        const rx = Math.max(0, (v.rx - p.rx) / dt); const tx = Math.max(0, (v.tx - p.tx) / dt);
        s.netRx += rx; s.netTx += tx;
        s.nics.push({ name, rx, tx });
      }
      s.diskRd = Math.max(0, (disk.rd - prev.disk.rd) / dt);
      s.diskWr = Math.max(0, (disk.wr - prev.disk.wr) / dt);
      s.diskBusy = Math.max(0, Math.min(100, (disk.busyMs - prev.disk.busyMs) / (dt * 10)));
    }

    // processes: CPU % (of one core) from the tick difference since the last scan
    const prevTicks = this.prevProcs;
    const nextTicks = new Map();
    const withCpu = procs.map((p) => {
      nextTicks.set(p.pid, p.ticks);
      const before = prevTicks.get(p.pid);
      const cpu = before !== undefined && dt > 0 ? Math.max(0, ((p.ticks - before) / CLK_TCK / dt) * 100) : 0;
      return { ...p, cpu };
    });
    this.prevProcs = nextTicks;

    // Minecraft: the launcher starts the real java, so sum the whole tree below the recorded pid
    const children = new Map();
    for (const p of withCpu) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
    const byPid = new Map(withCpu.map((p) => [p.pid, p]));
    for (const m of this.minecraft() || []) {
      if (!byPid.has(m.pid)) continue;
      let cpu = 0; let rss = 0; let threads = 0; const stack = [m.pid];
      const seen = new Set();
      while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid)) continue; seen.add(pid);
        const p = byPid.get(pid); if (!p) continue;
        cpu += p.cpu; rss += p.rss; threads += p.threads;
        for (const c of children.get(pid) || []) stack.push(c.pid);
      }
      s.mc.push({ id: m.id, name: m.name, pid: m.pid, cpu, rss, threads });
    }

    // top lists (by CPU and by memory), with user and command line for those only
    const top = new Map();
    for (const p of [...withCpu].sort((a, b) => b.cpu - a.cpu).slice(0, 12)) top.set(p.pid, p);
    for (const p of [...withCpu].sort((a, b) => b.rss - a.rss).slice(0, 12)) top.set(p.pid, p);
    s.procs = [...top.values()].map((p) => {
      let user = ''; let cmd = '';
      try { user = this._userName(fs.statSync(`/proc/${p.pid}`).uid); } catch { /* gone */ }
      try { cmd = (read(`/proc/${p.pid}/cmdline`) || '').replace(/[\0\s]+/g, ' ').trim().slice(0, 160); } catch { /* gone */ }
      return { pid: p.pid, name: p.comm, user, cmd: cmd || `[${p.comm}]`, cpu: p.cpu, rss: p.rss, threads: p.threads };
    });

    this.latest = s;
    this.series.push({ ts: t, cpu: s.cpu, iowait: s.iowait, memUsed: mem.used, load1: load[0], netRx: s.netRx, netTx: s.netTx, diskRd: s.diskRd, diskWr: s.diskWr, temp: s.temp, watts: s.power.w, mc: s.mc.reduce((a, m) => a + m.cpu, 0), mcRss: s.mc.reduce((a, m) => a + m.rss, 0) });
    if (this.series.length > KEEP) this.series.splice(0, this.series.length - KEEP);
    return s;
  }

  /** Static facts about the machine. Cheap, but not needed more than once per request. */
  info() {
    const cpuinfo = read('/proc/cpuinfo') || '';
    const model = (/^model name\s*:\s*(.+)$/m.exec(cpuinfo) || /^Hardware\s*:\s*(.+)$/m.exec(cpuinfo) || [])[1] || os.cpus()[0]?.model || '';
    const mhz = [...cpuinfo.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1]));
    const osrel = read('/etc/os-release') || '';
    const pretty = (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(osrel) || [])[1] || os.type();
    const mounts = parseMounts(read('/proc/mounts'));
    const wanted = new Set(this.paths);
    const disks = [];
    for (const m of mounts) {
      try {
        const st = fs.statfsSync(m.mount);
        const total = st.blocks * st.bsize; const free = st.bavail * st.bsize;
        if (!total) continue;
        disks.push({ mount: m.mount, device: m.device, fstype: m.fstype, total, free, used: total - free, hasServers: [...wanted].some((p) => p === m.mount || p.startsWith(m.mount === '/' ? '/' : m.mount + '/')) });
      } catch { /* not readable */ }
    }
    // the filesystem that holds the servers folder is always shown, even if it was not in /proc/mounts as a real fs
    for (const p of this.paths) {
      if (disks.some((d) => d.hasServers)) break;
      try {
        const st = fs.statfsSync(p);
        disks.push({ mount: p, device: '', fstype: '', total: st.blocks * st.bsize, free: st.bavail * st.bsize, used: (st.blocks - st.bavail) * st.bsize, hasServers: true });
      } catch { /* missing */ }
    }
    return {
      hostname: os.hostname(), os: pretty, kernel: os.release(), arch: os.arch(),
      cpuModel: String(model).replace(/\s+/g, ' ').trim(), cpuThreads: os.cpus().length || 1,
      cpuMhz: mhz.length ? Math.round(mhz.reduce((a, b) => a + b, 0) / mhz.length) : null,
      memTotal: os.totalmem(), uptimeS: Math.round(os.uptime()), node: process.version, disks,
    };
  }

  /** History as columns, thinned to at most `points` entries. */
  history(windowS = 300, points = 240) {
    const from = Date.now() - windowS * 1000;
    const rows = this.series.filter((r) => r.ts >= from);
    const step = Math.max(1, Math.ceil(rows.length / points));
    const out = [];
    for (let i = 0; i < rows.length; i += step) {
      const chunk = rows.slice(i, i + step);
      const avg = (k) => { const v = chunk.map((r) => r[k]).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      out.push({ ts: chunk[chunk.length - 1].ts, cpu: avg('cpu'), iowait: avg('iowait'), memUsed: avg('memUsed'), load1: avg('load1'), netRx: avg('netRx'), netTx: avg('netTx'), diskRd: avg('diskRd'), diskWr: avg('diskWr'), temp: avg('temp'), watts: avg('watts'), mc: avg('mc'), mcRss: avg('mcRss') });
    }
    return out;
  }

  snapshot(windowS) {
    if (!this.latest) this.sample();
    return { info: this.info(), now: this.latest, history: this.history(windowS), sampleMs: this.sampleMs };
  }
}

module.exports = { HostStats, parseStat, parseMeminfo, parseLoadavg, parseNetDev, parseDiskstats, pickTemps, readPowerTree, computePower, parseProcStat, parseMounts };
