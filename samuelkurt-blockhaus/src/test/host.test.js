'use strict';
// Dedicated-server mode: login, computer performance, terminal. Uses a real shell on a real pseudo terminal (needs python3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { Auth, sameOrigin, parseCookies } = require('../lib/auth');
const hs = require('../lib/hoststats');
const { createApp } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-host-'));
async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(25); }
}

// ---- auth ---------------------------------------------------------------------------------------------------------
test('auth: password is stored hashed (0600), verified, and too-short or too-long ones are refused', () => {
  const dir = tmpdir();
  const a = new Auth(dir);
  assert.equal(a.isConfigured(), false);
  assert.match(a.login('anything', '1.1.1.1').error, /noch kein Passwort/);
  assert.throws(() => a.setPassword('short'), /mindestens 10/);
  assert.throws(() => a.setPassword('x'.repeat(300)), /zu lang/);
  a.setPassword('correct horse battery');
  const raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes('correct horse'), 'plain password must not be on disk');
  assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(a.login('wrong password!', '1.1.1.1').status, 401);
  assert.equal(a.login(12345, '1.1.1.1').status, 401);
  const ok = a.login('correct horse battery', '1.1.1.1');
  assert.equal(ok.ok, true);
  assert.ok(ok.token.length >= 40);
});

test('auth: brute force is slowed down per IP, a good login resets it, other IPs are not locked', () => {
  let now = 1_000_000;
  const a = new Auth(tmpdir(), { now: () => now });
  a.setPassword('correct horse battery');
  for (let i = 0; i < 5; i++) assert.equal(a.login('nope nope nope', '9.9.9.9').status, 401);
  assert.equal(a.login('nope nope nope', '9.9.9.9').status, 401);     // the 6th wrong one starts the lock
  const locked = a.login('correct horse battery', '9.9.9.9');          // even the right password is refused during the lock
  assert.equal(locked.status, 429); assert.ok(locked.retryAfterS >= 1);
  assert.equal(a.login('correct horse battery', '8.8.8.8').ok, true);  // someone else is fine
  now += 3000;
  assert.equal(a.login('correct horse battery', '9.9.9.9').ok, true);
  assert.equal(a.fails.has('9.9.9.9'), false);
});

test('auth: sessions expire when idle, logout and a new password end them', () => {
  let now = 5_000_000;
  const a = new Auth(tmpdir(), { now: () => now });
  a.setPassword('correct horse battery');
  const mk = () => { const o = a.login('correct horse battery', '1.1.1.1'); return { headers: { cookie: `bh_session=${o.token}` } }; };
  let req = mk();
  assert.ok(a.sessionOf(req));
  now += 11 * 3600 * 1000; assert.ok(a.sessionOf(req), 'activity keeps it alive');
  now += 13 * 3600 * 1000; assert.equal(a.sessionOf(req), null, 'idle for 13 h');
  req = mk(); a.logout(req); assert.equal(a.sessionOf(req), null);
  req = mk(); a.setPassword('another good password'); assert.equal(a.sessionOf(req), null, 'password change logs everybody out');
  assert.deepEqual(parseCookies('a=1; bh_session=xyz; b=2'), { a: '1', bh_session: 'xyz', b: '2' });
});

test('auth: a password changed by ANOTHER process (blockhaus-passwd) ends the sessions of the running server', () => {
  const dir = tmpdir();
  const server = new Auth(dir); const cli = new Auth(dir);
  cli.setPassword('correct horse battery');
  const o = server.login('correct horse battery', '1.1.1.1');
  const req = { headers: { cookie: `bh_session=${o.token}` } };
  assert.ok(server.sessionOf(req));
  cli.setPassword('another good password');
  assert.equal(server.sessionOf(req), null, 'old session must not survive the new password');
  assert.equal(server.login('correct horse battery', '1.1.1.1').ok, false);
  const o2 = server.login('another good password', '1.1.1.1'); assert.ok(o2.ok);
  assert.ok(server.sessionOf({ headers: { cookie: `bh_session=${o2.token}` } }));
  fs.rmSync(path.join(dir, 'auth.json'));
  assert.equal(server.sessionOf({ headers: { cookie: `bh_session=${o2.token}` } }), null, 'removed password file = nobody is logged in');
});

test('auth: same-origin check', () => {
  assert.equal(sameOrigin({ headers: { host: 'srv:3000' } }), true, 'no Origin (curl) is fine');
  assert.equal(sameOrigin({ headers: { host: 'srv:3000', origin: 'http://srv:3000' } }), true);
  assert.equal(sameOrigin({ headers: { host: 'srv:3000', origin: 'http://evil.example' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'srv:3000', origin: 'null' } }), false);
});

// ---- host stats parsers ---------------------------------------------------------------------------------------------
test('hoststats: /proc parsers', () => {
  const st = hs.parseStat('cpu  100 0 50 800 20 0 5 1 0 0\ncpu0 60 0 30 400 10 0 3 0 0 0\ncpu1 40 0 20 400 10 0 2 1 0 0\nintr 1 2 3\n');
  assert.deepEqual(st.total, { idle: 820, total: 976, iowait: 20, steal: 1 });
  assert.equal(st.cores.length, 2);
  const mi = hs.parseMeminfo('MemTotal: 8000 kB\nMemFree: 1000 kB\nMemAvailable: 6000 kB\nBuffers: 100 kB\nCached: 900 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n');
  assert.deepEqual(mi, { total: 8000 * 1024, available: 6000 * 1024, used: 2000 * 1024, cached: 1000 * 1024, swapTotal: 2000 * 1024, swapUsed: 1500 * 1024 });
  assert.deepEqual(hs.parseLoadavg('0.52 0.40 0.31 1/234 5678\n'), [0.52, 0.4, 0.31]);
  const nd = hs.parseNetDev('Inter-|   Receive\n face |bytes packets\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n');
  assert.deepEqual(nd.eth0, { rx: 1000, tx: 2000 });
  const dk = hs.parseDiskstats('   8       0 sda 100 0 2000 50 200 0 4000 80 0 120 0\n   8       1 sda1 90 0 1800 40 150 0 3000 60 0 100 0\n 259 0 nvme0n1 5 0 100 1 6 0 200 2 0 7 0\n   7 0 loop0 1 0 8 0 0 0 0 0 0 0 0\n');
  assert.deepEqual(dk, { rd: (2000 + 100) * 512, wr: (4000 + 200) * 512, busyMs: 127 }); // partitions and loop devices are not counted twice
  assert.deepEqual(hs.parseProcStat('1234 (my (weird) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 7 0 100 1000 200 18446744073709551615'), { comm: 'my (weird) name', state: 'S', ppid: 1, ticks: 200, threads: 7 });
  const m = hs.parseMounts('/dev/sda1 / ext4 rw 0 0\n/dev/sda1 /var/lib/docker/x ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\noverlay /overlay overlay rw 0 0\n');
  assert.deepEqual(m.map((x) => x.mount).sort(), ['/', '/mnt/my disk']);
});

test('hoststats: CPU temperature prefers the CPU chip, ignores nonsense values', () => {
  const t = hs.pickTemps({ hwmon: [{ name: 'nvme', temps: [{ label: 'Composite', milli: 61000 }] }, { name: 'coretemp', temps: [{ label: 'Package id 0', milli: 54000 }, { label: 'Core 0', milli: 52000 }] }, { name: 'bogus', temps: [{ label: '', milli: 255000 }] }] });
  assert.equal(t.main, 54);
  assert.ok(!t.all.some((x) => x.c > 150));
  assert.equal(hs.pickTemps({ hwmon: [], thermal: [] }).main, null);
  assert.equal(hs.pickTemps({ hwmon: [], thermal: [{ type: 'x86_pkg_temp', milli: 47000 }] }).main, 47);
});

// ---- power draw ---------------------------------------------------------------------------------------------------
/** Build a fake /sys: { 'class/powercap/intel-rapl:0/energy_uj': '123', ... } */
function fakeSys(files) {
  const root = tmpdir();
  for (const [rel, v] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(v)); }
  return root;
}
const raplFiles = (dir, name, uj, max = 262143328850) => ({ [`class/powercap/${dir}/name`]: name, [`class/powercap/${dir}/energy_uj`]: uj, [`class/powercap/${dir}/max_energy_range_uj`]: max });

test('power: RAPL package + RAM -> watts from the energy counters over the time between two samples', () => {
  const at = (pk, dr) => hs.readPowerTree(fakeSys({ ...raplFiles('intel-rapl:0', 'package-0', pk), ...raplFiles('intel-rapl:0/intel-rapl:0:0', 'core', pk / 2), ...raplFiles('intel-rapl:0/intel-rapl:0:2', 'dram', dr) }));
  const a = at(10_000_000, 1_000_000); const b = at(20_000_000, 3_000_000);   // +10 J and +2 J in 2 s
  const p = hs.computePower(a, b, 2);
  assert.equal(p.status, 'ok'); assert.equal(p.w, 6); assert.equal(p.label, 'Prozessor + Arbeitsspeicher');
  assert.deepEqual(p.parts.map((x) => [x.label, x.w, x.total]), [['Prozessor', 5, true], ['Arbeitsspeicher', 1, true]]);
  assert.equal(p.parts.some((x) => /core/i.test(x.label)), false, 'sub-domain "core" is part of the package, not added again');
  const first = hs.computePower(null, b, 0);
  assert.equal(first.status, 'ok'); assert.equal(first.w, null, 'the first sample has nothing to compare with');
});

test('power: the RAPL counter wraps around, and "psys" (whole platform) wins over package + RAM', () => {
  const at = (uj) => hs.readPowerTree(fakeSys(raplFiles('intel-rapl:0', 'package-0', uj, 1_000_000)));
  const p = hs.computePower(at(990_000), at(40_000), 1);          // 990000 -> 1000000 -> 40000 = 50000 uJ
  assert.equal(p.w, 0.1);                                          // 0.05 W rounded to one decimal
  const both = (pk, ps) => hs.readPowerTree(fakeSys({ ...raplFiles('intel-rapl:0', 'package-0', pk), ...raplFiles('intel-rapl:1', 'psys', ps) }));
  const q = hs.computePower(both(0, 0), both(12_000_000, 20_000_000), 1);
  assert.equal(q.w, 20); assert.match(q.label, /psys/);
  assert.deepEqual(q.parts.map((x) => [x.label, x.w, x.total]), [['Prozessor', 12, false]]);
});

test('power: the mmio copy of a RAPL domain is not counted twice', () => {
  const at = (uj) => hs.readPowerTree(fakeSys({ ...raplFiles('intel-rapl:0', 'package-0', uj), ...raplFiles('intel-rapl-mmio:0', 'package-0', uj) }));
  assert.equal(hs.computePower(at(0), at(8_000_000), 1).w, 8);
});

test('power: a domain without max_energy_range_uj is still measured', () => {
  const at = (uj) => hs.readPowerTree(fakeSys({ 'class/powercap/intel-rapl:0/name': 'package-0', 'class/powercap/intel-rapl:0/energy_uj': uj }));
  assert.equal(hs.computePower(at(0), at(3_000_000), 1).w, 3);
});

test('power: GPU from hwmon is added, other hwmon chips are only listed, power1_input is skipped next to power1_average', () => {
  const sys = (gpuW) => fakeSys({
    ...raplFiles('intel-rapl:0', 'package-0', 0),
    'class/hwmon/hwmon3/name': 'amdgpu', 'class/hwmon/hwmon3/power1_average': gpuW * 1e6, 'class/hwmon/hwmon3/power1_input': 999e6, 'class/hwmon/hwmon3/power1_label': 'PPT',
    'class/hwmon/hwmon4/name': 'zenpower', 'class/hwmon/hwmon4/power1_input': 40e6,
  });
  const a = hs.readPowerTree(sys(30));
  const b = { ...a, rapl: [{ ...a.rapl[0], uj: 5_000_000 }] };   // CPU: +5 J in 1 s
  const p = hs.computePower(a, b, 1);
  assert.equal(p.w, 35);
  const byLabel = Object.fromEntries(p.parts.map((x) => [x.label, x]));
  assert.equal(byLabel['amdgpu PPT'].w, 30); assert.equal(byLabel['amdgpu PPT'].total, true);
  assert.equal(byLabel['zenpower'].w, 40); assert.equal(byLabel['zenpower'].total, false);
});

test('power: laptop battery counts only while discharging (power_now, or current x voltage)', () => {
  const bat = (extra) => hs.readPowerTree(fakeSys(extra));
  const a = bat({ 'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/status': 'Discharging', 'class/power_supply/BAT0/power_now': 12_000_000 });
  assert.equal(hs.computePower(a, a, 1).w, 12);
  const b = bat({ 'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/status': 'Discharging', 'class/power_supply/BAT0/current_now': 1_000_000, 'class/power_supply/BAT0/voltage_now': 11_000_000 });
  assert.equal(hs.computePower(b, b, 1).w, 11);
  const c = bat({ 'class/power_supply/BAT0/type': 'Battery', 'class/power_supply/BAT0/status': 'Charging', 'class/power_supply/BAT0/power_now': 30_000_000, 'class/power_supply/AC/type': 'Mains' });
  assert.equal(hs.computePower(c, c, 1).status, 'none');
});

test('power: no sensor says "none", unreadable RAPL counters say "denied" (the usual case for a non-root service user)', () => {
  assert.equal(hs.computePower(null, hs.readPowerTree(tmpdir()), 0).status, 'none');
  const root = fakeSys(raplFiles('intel-rapl:0', 'package-0', 1));
  const denied = hs.readPowerTree(root, (f) => { if (f.endsWith('energy_uj')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return fs.readFileSync(f, 'utf8'); });
  assert.equal(denied.denied, true);
  const p = hs.computePower(null, denied, 0);
  assert.equal(p.status, 'denied'); assert.equal(p.w, null);
});

test('hoststats: real machine - samples, history, Minecraft process tree, disks', async () => {
  const h = new hs.HostStats({ sampleMs: 100, paths: [os.tmpdir()], minecraft: () => [{ id: 'a', name: 'Test', pid: process.pid }] });
  h.sample();
  const spin = Date.now() + 250; while (Date.now() < spin) { /* burn some CPU so the numbers move */ }
  const s = h.sample();
  assert.ok(s.cpu >= 0 && s.cpu <= 100);
  assert.equal(s.cores.length, os.cpus().length);
  assert.ok(s.mem.total > 0 && s.mem.used > 0 && s.mem.used <= s.mem.total);
  assert.equal(s.mc.length, 1);
  assert.ok(s.mc[0].rss > 10 * 1024 * 1024, 'this node process has some memory');
  assert.ok(s.mc[0].cpu > 20, `the busy loop should show up as CPU of the "Minecraft" process, got ${s.mc[0].cpu}`);
  assert.ok(s.procs.some((p) => p.pid === process.pid && p.cmd.includes('node')));
  const snap = h.snapshot(60);
  assert.ok(snap.info.hostname && snap.info.cpuThreads >= 1 && snap.info.memTotal > 0);
  assert.ok(snap.info.disks.some((d) => d.hasServers && d.total > 0), 'the filesystem of the servers folder is listed');
  assert.ok(snap.history.length >= 2);
  assert.ok(snap.history.every((r) => r.ts > 0));
});

// ---- the whole thing over HTTP, with a real shell ----------------------------------------------------------------------
async function setup(extra = {}) {
  const tmp = tmpdir();
  const dataDir = path.join(tmp, 'data'); const serversDir = path.join(tmp, 'servers');
  fs.mkdirSync(serversDir, { recursive: true });
  const app = createApp({ dataDir, serversDir, mode: 'local', hostTools: true, settleMs: 5, localOpts: { pollMs: 60 }, terminalOpts: { cwd: tmp, max: 3, ...extra.terminalOpts }, hostOpts: { sampleMs: 100 } });
  app.auth.setPassword('correct horse battery');
  app.hostStats.start();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const port = app.address().port; const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => {
    const r = await call('POST', '/api/login', { password: 'correct horse battery' });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  const close = async () => { app.terminals.closeAll(); app.hostStats.stop(); await app.local.shutdown(1000).catch(() => {}); app.close(); app.closeAllConnections?.(); await sleep(200); };
  return { tmp, app, call, login, close, base, port, cookie: () => cookie };
}

// a tiny WebSocket client on the raw socket, so the test does not share code (or bugs) with lib/websocket.js
function wsConnect(t, id, { cookie = t.cookie(), origin = t.base } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(t.port, '127.0.0.1');
    let head = Buffer.alloc(0); let upgraded = false; let buf = Buffer.alloc(0);
    const c = { sock, out: Buffer.alloc(0), texts: [], closed: false, status: 0 };
    c.send = (text) => { // masked text frame
      const p = Buffer.from(text); const mask = crypto.randomBytes(4);
      const h = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
      const body = Buffer.from(p); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      sock.write(Buffer.concat([h, mask, body]));
    };
    c.waitOut = (re, ms = 8000) => until(() => re.test(c.out.toString('utf8')), ms, `output ${re}`);
    const parse = () => {
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f; const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if (op === 2) c.out = Buffer.concat([c.out, payload]);
        else if (op === 1) c.texts.push(JSON.parse(payload.toString('utf8')));
        else if (op === 8) { c.closed = true; }
      }
    };
    sock.on('data', (d) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n'); if (i < 0) return;
        const text = head.subarray(0, i).toString();
        c.status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)[1]);
        if (c.status !== 101) { resolve(c); return; }
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        assert.match(text, new RegExp('Sec-WebSocket-Accept: ' + accept.replace(/[+/=]/g, '\\$&'), 'i'));
        upgraded = true; buf = head.subarray(i + 4); parse(); resolve(c); return;
      }
      buf = Buffer.concat([buf, d]); parse();
    });
    sock.on('close', () => { c.closed = true; if (!upgraded) resolve(c); });
    sock.on('error', reject);
    sock.write([`GET /api/host/terminals/${id}/ws HTTP/1.1`, `Host: 127.0.0.1:${t.port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
      origin ? `Origin: ${origin}` : null, cookie ? `Cookie: ${cookie}` : null, '', ''].filter((x) => x !== null).join('\r\n'));
  });
}

test('http: without login nothing is reachable, with login everything is; logout ends it', async () => {
  const t = await setup();
  try {
    assert.deepEqual((await t.call('GET', '/api/session')).json, { auth: true, host: true, configured: true, authenticated: false });
    assert.equal((await t.call('GET', '/api/config')).status, 401);
    assert.equal((await t.call('GET', '/api/host/stats')).status, 401);
    assert.equal((await t.call('POST', '/api/host/terminals', {})).status, 401);
    assert.equal((await t.call('GET', '/api/servers')).status, 401);
    assert.equal((await fetch(t.base + '/')).status, 200, 'the page itself (login form) is public');
    assert.equal((await t.call('POST', '/api/login', { password: 'wrong wrong wrong' })).status, 401);
    const r = await t.login();
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.doesNotMatch(sc, /Secure/);
    assert.equal((await t.call('GET', '/api/config')).json.host, true);
    assert.equal((await t.call('GET', '/api/session')).json.authenticated, true);
    // browser cross-site request: refused even with a valid cookie
    assert.equal((await t.call('POST', '/api/logout', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.call('POST', '/api/logout', {})).status, 200);
    assert.equal((await t.call('GET', '/api/config')).status, 401);
  } finally { await t.close(); }
});

test('http: performance endpoint returns machine info, live values and history', async () => {
  const t = await setup();
  try {
    await t.login();
    await sleep(450);
    const r = await t.call('GET', '/api/host/stats?window=60');
    assert.equal(r.status, 200);
    assert.ok(r.json.info.hostname && r.json.info.os);
    assert.ok(r.json.now.mem.total > 0 && Array.isArray(r.json.now.cores) && r.json.now.cores.length >= 1);
    assert.ok(r.json.history.length >= 3, `history has ${r.json.history.length} points`);
    assert.equal(r.json.sampleMs, 100);
  } finally { await t.close(); }
});

test('terminal: real shell - input, output, resize, reconnect with replay, exit, limits', async () => {
  const t = await setup();
  try {
    await t.login();
    const created = await t.call('POST', '/api/host/terminals', { cols: 100, rows: 30 });
    assert.equal(created.status, 201);
    const id = created.json.id;
    let c = await wsConnect(t, id);
    assert.equal(c.status, 101);
    await until(() => c.texts.find((m) => m.t === 'hello'), 3000, 'hello');
    c.send(JSON.stringify({ t: 'in', d: "printf 'A%sB\\n' $((6*7))\n" }));
    await c.waitOut(/A42B/);
    c.send(JSON.stringify({ t: 'in', d: "printf 'S[%s]\\n' \"$(stty size)\"\n" }));
    await c.waitOut(/S\[30 100\]/);                                    // the size from creation
    c.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    await sleep(150);
    c.send(JSON.stringify({ t: 'in', d: "printf 'T[%s]\\n' \"$(stty size)\"\n" }));
    await c.waitOut(/T\[40 120\]/);
    c.send(JSON.stringify({ t: 'in', d: "printf 'P[%s]\\n' \"$(pwd)\"\n" }));
    await c.waitOut(new RegExp('P\\[' + t.tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]'));
    assert.equal((await t.call('GET', '/api/host/terminals')).json.terminals[0].clients, 1);
    c.sock.destroy();                                                   // closing the browser tab...
    await until(async () => (await t.call('GET', '/api/host/terminals')).json.terminals[0].clients === 0, 3000, 'detach');
    c = await wsConnect(t, id);                                         // ...and coming back
    await c.waitOut(/A42B/, 3000);                                      // the old screen is replayed
    c.send(JSON.stringify({ t: 'in', d: "echo $$ > pid.txt; export BH_TEST=still-here\n" }));
    await sleep(200);
    c.send(JSON.stringify({ t: 'in', d: "printf 'V[%s]\\n' \"$BH_TEST\"\n" }));
    await c.waitOut(/V\[still-here\]/);                                 // same shell, same environment
    assert.ok(!('BLOCKHAUS_HOST' in process.env) || !/BLOCKHAUS_HOST/.test(c.out.toString()), 'panel settings are not handed to the shell');
    // session limit
    assert.equal((await t.call('POST', '/api/host/terminals', {})).status, 201);
    assert.equal((await t.call('POST', '/api/host/terminals', {})).status, 201);
    const over = await t.call('POST', '/api/host/terminals', {});
    assert.equal(over.status, 409); assert.match(over.json.error, /schon 3/);
    // exit ends the session and tells the browser
    c.send(JSON.stringify({ t: 'in', d: 'exit 3\n' }));
    await until(() => c.texts.find((m) => m.t === 'exit'), 4000, 'exit message');
    assert.equal(c.texts.find((m) => m.t === 'exit').code, 3);
    await until(async () => (await t.call('GET', '/api/host/terminals')).json.terminals.every((x) => x.id !== id), 3000, 'session removed');
    assert.equal((await wsConnect(t, id)).status, 404);
  } finally { await t.close(); }
});

test('terminal: WebSocket needs login, a same-origin Origin header and a real session', async () => {
  const t = await setup();
  try {
    await t.login();
    const id = (await t.call('POST', '/api/host/terminals', {})).json.id;
    assert.equal((await wsConnect(t, id, { cookie: '' })).status, 401, 'no cookie');
    assert.equal((await wsConnect(t, id, { cookie: 'bh_session=forged' })).status, 401, 'forged cookie');
    assert.equal((await wsConnect(t, id, { origin: 'http://evil.example' })).status, 403, 'cross-site page');
    assert.equal((await wsConnect(t, id, { origin: '' })).status, 403, 'no Origin header');
    assert.equal((await wsConnect(t, 'abcdef')).status, 404, 'unknown session');
    assert.equal((await wsConnect(t, id)).status, 101, 'and the legitimate one works');
    // a client that sends an unmasked frame is dropped
    const c = await wsConnect(t, id);
    c.sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await until(() => c.closed, 3000, 'close after protocol violation');
  } finally { await t.close(); }
});

test('terminal: a killed Blockhaus does not leave shells behind (stdin EOF hangs the shell up)', async () => {
  const t = await setup();
  let pid;
  try {
    await t.login();
    const s = t.app.terminals.create({});
    pid = s.proc.pid;
    assert.ok(fs.existsSync(`/proc/${pid}`));
    s.proc.stdin.end();
    await until(() => !fs.existsSync(`/proc/${pid}`), 5000, 'helper gone');
  } finally { await t.close(); }
});

test('http: Umbrel mode (no host tools) has no login, no host routes, nothing changes', async () => {
  const tmp = tmpdir();
  const app = createApp({ dataDir: path.join(tmp, 'd'), serversDir: path.join(tmp, 's'), mode: 'local', settleMs: 5, hostTools: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.deepEqual(await (await fetch(base + '/api/session')).json(), { auth: false, host: false, configured: true, authenticated: true });
    assert.equal((await fetch(base + '/api/config')).status, 200);
    assert.equal((await fetch(base + '/api/host/stats')).status, 404);
    const up = await new Promise((resolve) => { const s = net.connect(app.address().port, '127.0.0.1'); s.write('GET /api/host/terminals/ab/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); s.on('data', (d) => { resolve(String(d).split('\r\n')[0]); s.destroy(); }); });
    assert.match(up, /404/);
  } finally { await app.local.shutdown(500).catch(() => {}); app.close(); app.closeAllConnections?.(); }
});
