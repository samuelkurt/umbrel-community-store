'use strict';
// Standalone mode: Blockhaus runs the Minecraft servers itself instead of asking Crafty Controller to do it.
// This class offers the same methods the rest of the panel uses on the Crafty client (servers, stats, action, stdin,
// logs), so the routes work unchanged. It also manages the server list (create, adopt, rename, remove).
//
// One server runs at a time: the app publishes a single Minecraft port.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const mcping = require('./mcping');
const javaLib = require('./java');
const software = require('./software');
const props = require('./props');
const zip = require('./zip');
const { writeFileKeepOwner } = require('./fsutil');

class LocalError extends Error {
  constructor(message, { status = 400, code = 'LOCAL_ERROR' } = {}) {
    super(message);
    this.name = 'LocalError';
    this.status = status;
    this.code = code;
  }
}

const MAX_LINES = 1000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const DIR_RE = /^[A-Za-z0-9][\w.\- ]{0,79}$/;
const JAR_RE = /^[\w.\- ]+\.jar$/;
const JOIN_RE = /: ([A-Za-z0-9_.]{1,32}) joined the game\s*$/;
const LEAVE_RE = /: ([A-Za-z0-9_.]{1,32}) left the game\s*$/;
const DONE_RE = /Done \([\d.,]+s\)!/;
const JAVA_CHOICES = [8, 11, 17, 21, 25];

const slug = (s) => String(s).replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

async function dirSize(dir, budget = { files: 300000 }) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files-- <= 0) return total;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p, budget);
    else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* vanished */ } }
  }
  return total;
}

/** Sum of CPU ticks and resident memory of a process and everything it started (the launcher starts the real java). */
function procTree(rootPid) {
  const procs = new Map();
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return null; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const s = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const statm = fs.readFileSync(`/proc/${n}/statm`, 'utf8').split(' ');
      procs.set(Number(n), { ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]), rss: Number(statm[1]) * 4096 });
    } catch { /* process ended meanwhile */ }
  }
  if (!procs.has(rootPid)) return null;
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of procs) if (!inTree.has(pid) && inTree.has(p.ppid)) { inTree.add(pid); grew = true; }
  }
  let ticks = 0; let rss = 0;
  for (const pid of inTree) { ticks += procs.get(pid).ticks; rss += procs.get(pid).rss; }
  return { ticks, rss };
}

class Local {
  /**
   * @param {object} o
   * @param {string} o.dataDir     where servers.json and downloaded Java live
   * @param {string} o.serversDir  folder with one subfolder per server
   * @param {number} [o.port]      the Minecraft port the app publishes (written into every server's server.properties)
   * @param {number} [o.pollMs]    how often CPU/memory/players are sampled
   * @param {number} [o.stopTimeoutMs] after "stop" the process gets this long before it is killed
   * @param {Function} [o.ensureJava]
   */
  constructor({ dataDir, serversDir, port = 25665, pollMs = 5000, stopTimeoutMs = 90000, ensureJava = javaLib.ensure } = {}) {
    this.dataDir = dataDir;
    this.serversDir = serversDir;
    this.port = port;
    this.pollMs = pollMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.ensureJava = ensureJava;
    this.file = path.join(dataDir, 'local-servers.json');
    this.rt = new Map();
    /** Functions (serverId, text) -> true to keep that console line out of the in-memory console view (used by the anticheat). */
    this.lineHooks = new Set();
    this.jwt = null; // the panel resets this on config changes when it talks to Crafty; harmless here
    this.registry = this._load();
    this.timer = null;
  }

  // ---- registry ----------------------------------------------------------------------------------------------
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { servers: Array.isArray(j.servers) ? j.servers : [] };
    } catch { return { servers: [] }; }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() { return this.registry.servers.map((s) => ({ ...s })); }

  need(id) {
    const s = this.registry.servers.find((x) => x.id === String(id));
    if (!s) throw new LocalError('Diesen Server gibt es nicht.', { status: 404, code: 'NOT_FOUND' });
    return s;
  }

  dirOf(rec) { return path.join(this.serversDir, rec.dir); }

  /** Running Minecraft processes (for the computer's performance page). */
  runtimePids() {
    const out = [];
    for (const [id, r] of this.rt) {
      const rec = this.registry.servers.find((s) => s.id === id);
      if (r.proc && r.proc.pid) out.push({ id, name: rec ? rec.name : id, pid: r.proc.pid });
    }
    return out;
  }


  _shape(s) {
    return {
      server_id: s.id, server_name: s.name, server_port: this.port,
      path: `/servers/${s.dir}`, executable: s.jar,
      execution_command: `java -Xmx${s.memoryMb}M -jar ${s.jar} nogui`,
      // extra fields the local UI uses
      memory_mb: s.memoryMb, autostart: !!s.autostart, java_major: s.javaMajor || null, fresh: !!s.fresh,
    };
  }

  async servers() { return this.registry.servers.map((s) => this._shape(s)); }

  _validMemory(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 256 || n > 262144) throw new LocalError('Arbeitsspeicher: eine ganze Zahl in MB zwischen 256 und 262144.');
    return n;
  }

  /** Make an empty server folder and register it. The caller installs the software afterwards (see discard). */
  create({ name, memoryMb = 2048 } = {}) {
    const nm = String(name || '').trim();
    if (!nm || nm.length > 60) throw new LocalError('Bitte einen Namen mit höchstens 60 Zeichen angeben.');
    const mem = this._validMemory(memoryMb);
    let base = slug(nm) || 'server';
    let dir = base; let i = 2;
    while (this.registry.servers.some((s) => s.dir === dir) || fs.existsSync(path.join(this.serversDir, dir))) dir = `${base}-${i++}`;
    fs.mkdirSync(path.join(this.serversDir, dir), { recursive: true });
    const rec = { id: crypto.randomBytes(5).toString('hex'), name: nm, dir, jar: 'server.jar', memoryMb: mem, javaMajor: null, autostart: false, fresh: true };
    this.registry.servers.push(rec);
    this._save();
    return this._shape(rec);
  }

  /** The install worked: the server is no longer "fresh". */
  keep(id) {
    const rec = this.need(id);
    if (rec.fresh) { delete rec.fresh; this._save(); }
  }

  /** The install failed: forget a server that has just been created, and delete its (still empty) folder. */
  async discard(id) {
    const rec = this.registry.servers.find((x) => x.id === String(id));
    if (!rec || !rec.fresh) return false;
    this.registry.servers = this.registry.servers.filter((x) => x !== rec);
    this.rt.delete(rec.id);
    this._save();
    await fsp.rm(this.dirOf(rec), { recursive: true, force: true });
    return true;
  }

  /** Folders under the servers folder that are not registered yet (to take over an existing server). */
  async candidates() {
    const used = new Set(this.registry.servers.map((s) => s.dir));
    let names = [];
    try { names = await fsp.readdir(this.serversDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of names) {
      if (!e.isDirectory() || used.has(e.name) || e.name.startsWith('.') || !DIR_RE.test(e.name)) continue;
      const dir = path.join(this.serversDir, e.name);
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      const jars = files.filter((f) => JAR_RE.test(f));
      const st = software.readInstalled(dir);
      let suggested = null;
      if (st && st.jar && jars.includes(st.jar)) suggested = st.jar;
      else if (jars.includes('server.jar')) suggested = 'server.jar';
      else if (jars.length === 1) suggested = jars[0];
      out.push({
        dir: e.name, jars, suggestedJar: suggested,
        hasProperties: files.includes('server.properties'), software: st ? st.software : null, version: st ? st.version : null,
        empty: files.length === 0,
      });
    }
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
  }

  adopt({ dir, jar, name, memoryMb = 2048 } = {}) {
    if (!DIR_RE.test(String(dir || ''))) throw new LocalError('Ungültiger Ordnername.');
    const full = path.join(this.serversDir, dir);
    let isDir = false;
    try { isDir = fs.statSync(full).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw new LocalError(`Der Ordner „${dir}“ existiert im Servers-Ordner nicht.`, { status: 404 });
    if (this.registry.servers.some((s) => s.dir === dir)) throw new LocalError('Dieser Ordner gehört schon zu einem Server.', { status: 409 });
    const jars = fs.readdirSync(full).filter((f) => JAR_RE.test(f));
    const st = software.readInstalled(full);
    let j = jar && String(jar);
    if (!j) j = st && st.jar && jars.includes(st.jar) ? st.jar : jars.includes('server.jar') ? 'server.jar' : jars.length === 1 ? jars[0] : null;
    if (!j || !JAR_RE.test(j) || path.basename(j) !== j) throw new LocalError(jars.length ? 'Bitte wähle die Start-Datei (jar) des Servers aus.' : 'Im Ordner liegt keine jar-Datei.', { code: 'JAR' });
    if (!fs.existsSync(path.join(full, j))) throw new LocalError(`Die Datei ${j} gibt es in diesem Ordner nicht.`, { status: 404 });
    const rec = { id: crypto.randomBytes(5).toString('hex'), name: String(name || dir).trim().slice(0, 60) || dir, dir, jar: j, memoryMb: this._validMemory(memoryMb), javaMajor: null, autostart: false };
    this.registry.servers.push(rec);
    this._save();
    return this._shape(rec);
  }

  update(id, patch = {}) {
    const rec = this.need(id);
    if (typeof patch.name === 'string') {
      const nm = patch.name.trim();
      if (!nm || nm.length > 60) throw new LocalError('Der Name darf nicht leer sein und höchstens 60 Zeichen haben.');
      rec.name = nm;
    }
    if (patch.memoryMb !== undefined) rec.memoryMb = this._validMemory(patch.memoryMb);
    if (typeof patch.autostart === 'boolean') rec.autostart = patch.autostart;
    if (patch.javaMajor !== undefined) {
      if (patch.javaMajor === null || patch.javaMajor === '' || patch.javaMajor === 'auto') rec.javaMajor = null;
      else if (JAVA_CHOICES.includes(Number(patch.javaMajor))) rec.javaMajor = Number(patch.javaMajor);
      else throw new LocalError('Java-Version: auto, 8, 11, 17, 21 oder 25.');
    }
    this._save();
    return this._shape(rec);
  }

  /** Forget a server. Its files stay where they are. */
  remove(id) {
    const rec = this.need(id);
    if (this._live(rec.id)) throw new LocalError('Der Server läuft. Stoppe ihn zuerst.', { status: 409 });
    this.registry.servers = this.registry.servers.filter((x) => x !== rec);
    this.rt.delete(rec.id);
    this._save();
    return { dir: rec.dir };
  }

  // ---- EULA --------------------------------------------------------------------------------------------------
  eulaAccepted(id) {
    try { return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(this.dirOf(this.need(id)), 'eula.txt'), 'utf8')); } catch { return false; }
  }

  acceptEula(id) {
    const rec = this.need(id);
    const file = path.join(this.dirOf(rec), 'eula.txt');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
    if (/^\s*eula\s*=/im.test(text)) text = text.replace(/^(\s*eula\s*=).*$/im, '$1true');
    else text = `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toUTCString()}\neula=true\n`;
    writeFileKeepOwner(file, text);
    return true;
  }

  // ---- process state -----------------------------------------------------------------------------------------
  _live(id) {
    const r = this.rt.get(String(id));
    return !!(r && (r.proc || r.phase === 'prepare'));
  }

  _fresh(rec) {
    return {
      rec, proc: null, pid: null, phase: null, state: 'offline', lines: [], players: new Set(), slp: null,
      stopRequested: false, restartAfter: false, crashed: false, notice: '', startedAt: 0,
      cpu: 0, rss: 0, last: null, killTimer: null, worldSize: 0, worldAt: 0, partial: { out: '', err: '' },
    };
  }

  _rt(rec) {
    let r = this.rt.get(rec.id);
    if (!r) { r = this._fresh(rec); this.rt.set(rec.id, r); }
    r.rec = rec;
    return r;
  }

  _line(r, text) {
    const t = String(text).replace(ANSI, '').replace(/\r/g, '');
    let hide = false;
    for (const h of this.lineHooks) { try { if (h(r.rec.id, t) === true) hide = true; } catch { /* a hook must never break the console */ } }
    if (!hide) {
      r.lines.push(t);
      if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
    }
    if (r.proc && r.state === 'starting' && DONE_RE.test(t)) { r.state = 'online'; r.notice = ''; this._ping(r); }
    if (/Stopping (the )?server/.test(t) && r.proc) r.state = 'stopping';
    let m;
    if ((m = JOIN_RE.exec(t))) r.players.add(m[1]);
    else if ((m = LEAVE_RE.exec(t))) r.players.delete(m[1]);
  }

  _feed(r, which, chunk) {
    const buf = r.partial[which] + chunk.toString('utf8');
    const parts = buf.split('\n');
    r.partial[which] = parts.pop();
    for (const p of parts) this._line(r, p);
  }

  _flush(r) {
    for (const k of ['out', 'err']) if (r.partial[k]) { this._line(r, r.partial[k]); r.partial[k] = ''; }
  }

  _readProps(rec) {
    try { return props.parse(fs.readFileSync(path.join(this.dirOf(rec), 'server.properties'), 'utf8')).values; } catch { return {}; }
  }

  /** The app publishes exactly one port, so every server must listen on it. */
  _forcePort(rec, r) {
    const file = path.join(this.dirOf(rec), 'server.properties');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* the server creates it */ }
    const parsed = props.parse(text);
    if (parsed.values['server-port'] === String(this.port)) return;
    if (parsed.values['server-port'] && r) this._line(r, `[Blockhaus] server-port war ${parsed.values['server-port']}, wird auf ${this.port} gesetzt (das ist der Port, den die App nach außen öffnet).`);
    if (text) writeFileKeepOwner(file + '.blockhaus.bak', text);
    writeFileKeepOwner(file, props.apply(parsed, { 'server-port': String(this.port) }));
  }

  async _jarJava(rec) {
    try {
      const f = path.join(this.dirOf(rec), rec.jar);
      const entries = await zip.readEntries(f);
      const e = entries.find((x) => x.name === 'version.json');
      if (!e) return null;
      const j = JSON.parse((await zip.readEntryBuffer(f, e)).toString('utf8'));
      const v = Number(j.java_version && typeof j.java_version === 'object' ? j.java_version.majorVersion : j.java_version);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  }

  async start(id) {
    const rec = this.need(id);
    const cur = this.rt.get(rec.id);
    if (cur && (cur.proc || cur.phase === 'prepare')) {
      if (cur.state === 'stopping') throw new LocalError('Der Server fährt gerade herunter. Warte einen Moment.', { status: 409 });
      return { already: true };
    }
    for (const o of this.registry.servers) {
      if (o.id !== rec.id && this._live(o.id)) throw new LocalError(`Es läuft schon ein anderer Server („${o.name}“). Es kann nur einer gleichzeitig laufen. Stoppe ihn zuerst.`, { status: 409, code: 'OTHER_RUNNING' });
    }
    const dir = this.dirOf(rec);
    if (!fs.existsSync(path.join(dir, rec.jar))) throw new LocalError(`Die Start-Datei ${rec.jar} fehlt im Ordner. Installiere unter „Software“ eine Version.`, { status: 409, code: 'NO_JAR' });
    if (!this.eulaAccepted(rec.id)) throw new LocalError('Du musst zuerst der Minecraft-EULA zustimmen (https://aka.ms/MinecraftEULA).', { status: 409, code: 'EULA' });
    const r = this._fresh(rec);
    this.rt.set(rec.id, r);
    r.state = 'starting'; r.phase = 'prepare'; r.startedAt = Date.now();
    this._line(r, '[Blockhaus] Server wird gestartet …');
    this._ensureTimer();
    this._launch(rec, r).catch((e) => this._failed(r, e));
    return { started: true };
  }

  _failed(r, e) {
    r.phase = null; r.proc = null; r.state = 'crashed'; r.crashed = true;
    r.notice = e && e.message ? e.message : String(e);
    this._line(r, `[Blockhaus] Fehler: ${r.notice}`);
  }

  async _launch(rec, r) {
    const dir = this.dirOf(rec);
    this._forcePort(rec, r);
    const want = javaLib.wanted({ override: rec.javaMajor, installed: software.readInstalled(dir), jarJava: await this._jarJava(rec), mc: (software.readInstalled(dir) || {}).version });
    let lastMsg = '';
    const j = await this.ensureJava(this.dataDir, want, { say: (m) => { const k = m.replace(/\d+ MB/, ''); if (k !== lastMsg) { lastMsg = k; this._line(r, `[Blockhaus] ${m}`); } r.notice = m; } });
    if (r.stopRequested) { r.phase = null; r.state = 'offline'; r.notice = ''; this._line(r, '[Blockhaus] Start abgebrochen.'); return; }
    const args = [`-Xmx${rec.memoryMb}M`, '-Dfile.encoding=UTF-8', '-jar', rec.jar, 'nogui'];
    this._line(r, `[Blockhaus] Java ${j.major}: ${path.basename(j.bin)} ${args.join(' ')}`);
    const proc = spawn(j.bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, LANG: 'C.UTF-8' } });
    r.proc = proc; r.pid = proc.pid; r.phase = null; r.notice = '';
    this._ensureTimer();
    proc.stdout.on('data', (c) => this._feed(r, 'out', c));
    proc.stderr.on('data', (c) => this._feed(r, 'err', c));
    proc.stdin.on('error', () => { /* process is gone */ });
    proc.on('error', (e) => { if (r.proc === proc) { r.proc = null; this._failed(r, new Error(`Java konnte nicht gestartet werden: ${e.message}`)); } });
    proc.on('exit', (code, sig) => this._exited(rec, r, proc, code, sig));
  }

  _exited(rec, r, proc, code, sig) {
    if (r.proc !== proc) return;
    this._flush(r);
    clearTimeout(r.killTimer);
    r.proc = null; r.pid = null; r.slp = null; r.cpu = 0; r.rss = 0; r.last = null; r.players.clear();
    const expected = r.stopRequested;
    r.state = !expected && (code !== 0 || sig) ? 'crashed' : 'offline';
    r.crashed = r.state === 'crashed';
    if (r.crashed) r.notice = `Der Server ist abgestürzt (${sig ? 'Signal ' + sig : 'Code ' + code}). Der Grund steht in der Konsole.`;
    this._line(r, `[Blockhaus] Server beendet (${sig ? 'Signal ' + sig : 'Code ' + code}).`);
    // a stray child of a killed launcher must not keep the port
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* none left */ }
    if (r.restartAfter) {
      r.restartAfter = false;
      setTimeout(() => this.start(rec.id).catch((e) => this._failed(this._rt(rec), e)), 300);
    }
  }

  async stop(id) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    if (!r || (!r.proc && r.phase !== 'prepare')) return { already: true };
    r.stopRequested = true;
    if (!r.proc) return { ok: true }; // still downloading Java: _launch notices
    r.state = 'stopping';
    this._line(r, '[Blockhaus] Stoppe den Server …');
    try { r.proc.stdin.write('stop\n'); } catch { /* process is gone */ }
    clearTimeout(r.killTimer);
    r.killTimer = setTimeout(() => { this._line(r, `[Blockhaus] Der Server hat sich nach ${Math.round(this.stopTimeoutMs / 1000)} s nicht beendet und wird beendet.`); this._signal(r, 'SIGKILL'); }, this.stopTimeoutMs);
    r.killTimer.unref();
    return { ok: true };
  }

  _signal(r, sig) {
    if (!r.proc) return;
    try { process.kill(-r.proc.pid, sig); } catch { try { r.proc.kill(sig); } catch { /* gone */ } }
  }

  async kill(id) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    if (!r || (!r.proc && r.phase !== 'prepare')) return { already: true };
    r.stopRequested = true;
    if (!r.proc) return { ok: true };
    this._line(r, '[Blockhaus] Server wird beendet (kill).');
    this._signal(r, 'SIGKILL');
    return { ok: true };
  }

  async restart(id) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    if (!r || (!r.proc && r.phase !== 'prepare')) return this.start(id);
    r.restartAfter = true;
    return this.stop(id);
  }

  /** Crafty-compatible action entry point. */
  async action(id, action) {
    switch (action) {
      case 'start_server': return this.start(id);
      case 'stop_server': return this.stop(id);
      case 'restart_server': return this.restart(id);
      case 'kill_server': return this.kill(id);
      case 'backup_server': throw new LocalError('Backups legst du auf der Backups-Seite an.', { status: 400 });
      default: throw new LocalError('Unbekannte Aktion: ' + action);
    }
  }

  async stdin(id, command) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    if (!r || !r.proc) throw new LocalError('Der Server läuft nicht, der Befehl kann nicht gesendet werden.', { status: 409 });
    r.proc.stdin.write(String(command).replace(/[\r\n]+/g, ' ') + '\n');
    return { ok: true };
  }

  async logs(id) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    if (r && r.lines.length) return r.lines.slice();
    try { return require('./serverfiles').readLog(this.dirOf(rec), 'latest.log', 64 * 1024).split('\n').slice(-300); } catch { return []; }
  }

  // ---- stats -------------------------------------------------------------------------------------------------
  async stats(id) {
    const rec = this.need(id);
    const r = this.rt.get(rec.id);
    const pv = this._readProps(rec);
    const running = !!(r && (r.proc || r.phase === 'prepare'));
    const world = pv['level-name'] || 'world';
    if (running && r) this._refreshWorldSize(rec, r, world);
    const slp = r && r.slp;
    const players = slp && slp.sample.length === slp.online ? slp.sample : r ? [...r.players] : [];
    const total = os.totalmem();
    return {
      running, crashed: !!(r && r.crashed), updating: false,
      blockhausState: r ? (running ? r.state : r.crashed ? 'crashed' : 'offline') : 'offline',
      int_ping_results: !!slp,
      online: slp ? slp.online : players.length,
      max: slp ? slp.max : Number(pv['max-players']) || 0,
      players,
      version: slp ? slp.version : '',
      server_port: this.port,
      cpu: r ? r.cpu : 0,
      mem: r && r.rss ? fmtBytes(r.rss) : '',
      mem_percent: r && r.rss && total ? Math.round((r.rss / total) * 1000) / 10 : 0,
      world_name: world,
      world_size: r && r.worldSize ? fmtBytes(r.worldSize) : '',
      desc: slp ? slp.motd : pv.motd || '',
      notice: r ? r.notice : '',
      eula_ok: this.eulaAccepted(rec.id),
      startedAt: r && running ? r.startedAt : 0,
    };
  }

  _refreshWorldSize(rec, r, world) {
    if (r.worldBusy || Date.now() - r.worldAt < (r.worldSize ? 60000 : 3000)) return; // empty = the world is probably still being created
    r.worldBusy = true;
    dirSize(path.join(this.dirOf(rec), world)).then((n) => { r.worldSize = n; }).catch(() => {}).finally(() => { r.worldAt = Date.now(); r.worldBusy = false; });
  }

  async _ping(r) {
    if (!r.proc || r.pinging) return;
    r.pinging = true;
    try { r.slp = await mcping.ping('127.0.0.1', this.port, { timeout: 2000 }); } catch { r.slp = null; } finally { r.pinging = false; }
  }

  _sample(r) {
    const t = procTree(r.pid);
    const now = Date.now();
    if (!t) return;
    r.rss = t.rss;
    if (r.last) {
      const dt = (now - r.last.at) / 1000;
      if (dt > 0) r.cpu = Math.min(100, Math.round(((t.ticks - r.last.ticks) / 100 / dt / os.cpus().length) * 1000) / 10);
    }
    r.last = { at: now, ticks: t.ticks };
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let any = false;
      for (const r of this.rt.values()) {
        if (r.phase === 'prepare') any = true; // Java is still being fetched: keep ticking, the process comes later
        if (!r.proc) continue;
        any = true;
        this._sample(r);
        if (r.state === 'online') this._ping(r);
      }
      if (!any) { clearInterval(this.timer); this.timer = null; }
    }, this.pollMs);
    this.timer.unref();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------
  /** Start the servers marked "autostart" (at most one runs). */
  async autostart(log = () => {}) {
    for (const s of this.registry.servers) {
      if (!s.autostart) continue;
      try { await this.start(s.id); log(`Server „${s.name}“ wird gestartet (Autostart).`); return s.id; }
      catch (e) { log(`Autostart von „${s.name}“ nicht möglich: ${e.message}`); }
    }
    return null;
  }

  /** Stop everything cleanly (for SIGTERM). Resolves when all processes are gone. */
  async shutdown(timeoutMs = this.stopTimeoutMs) {
    const live = [...this.rt.values()].filter((r) => r.proc || r.phase === 'prepare');
    await Promise.all(live.map((r) => new Promise((resolve) => {
      r.restartAfter = false;
      r.stopRequested = true;
      if (!r.proc) return resolve();
      r.proc.once('exit', () => resolve());
      r.state = 'stopping';
      try { r.proc.stdin.write('stop\n'); } catch { /* gone */ }
      const t = setTimeout(() => { this._signal(r, 'SIGKILL'); setTimeout(resolve, 500); }, timeoutMs);
      t.unref();
    })));
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { Local, LocalError, fmtBytes, procTree };
