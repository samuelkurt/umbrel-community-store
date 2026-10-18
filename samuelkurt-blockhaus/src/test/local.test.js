'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { Local, LocalError } = require('../lib/local');
const software = require('../lib/software');
const files = require('../lib/serverfiles');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-local-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await sleep(25);
  }
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function fakeJava() {
  const dir = tmp();
  const bin = path.join(dir, 'java');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-mc.js')}" "$@"\n`, { mode: 0o755 });
  return bin;
}

async function setup(opts = {}) {
  const data = tmp(); const servers = tmp();
  const bin = fakeJava();
  const port = await freePort();
  const calls = [];
  const local = new Local({
    dataDir: data, serversDir: servers, port, pollMs: 60, stopTimeoutMs: 5000,
    ensureJava: async (d, want, o) => { calls.push(want); if (opts.javaError) throw new Error(opts.javaError); if (opts.javaDelay) await sleep(opts.javaDelay); return { bin, major: 21 }; },
    ...opts.local,
  });
  return { data, servers, local, port, calls };
}
const state = async (l, id) => (await l.stats(id)).blockhausState;
const make = (l, name = 'Test Server') => { const s = l.create({ name }); l.acceptEula(s.server_id); return s; };
const cleanup = async (l) => { await l.shutdown(2000).catch(() => {}); };

test('registry: create, list, rename, memory, remove; survives a new instance; Crafty-shaped for the rest of the panel', async () => {
  const { local, data, servers, port } = await setup();
  const s = local.create({ name: 'Mein Süßer Server!', memoryMb: 3072 });
  assert.equal(s.server_name, 'Mein Süßer Server!');
  assert.equal(s.path, '/servers/mein-suesser-server');
  assert.ok(fs.statSync(path.join(servers, 'mein-suesser-server')).isDirectory());
  assert.equal(s.server_port, port);
  assert.equal(software.jarNameOf(s), 'server.jar');
  assert.equal(files.resolveDir(servers, s), path.join(servers, s.path.split('/').pop()));
  const s2 = local.create({ name: 'Mein Süßer Server!' });
  assert.notEqual(s.path, s2.path, 'same name gets a different folder');
  local.update(s.server_id, { name: 'Neu', memoryMb: 4096, autostart: true, javaMajor: 17 });
  const again = new Local({ dataDir: data, serversDir: servers, port });
  const rec = again.list().find((x) => x.id === s.server_id);
  assert.deepEqual([rec.name, rec.memoryMb, rec.autostart, rec.javaMajor], ['Neu', 4096, true, 17]);
  assert.match((await again.servers()).find((x) => x.server_id === s.server_id).execution_command, /-Xmx4096M -jar server\.jar nogui/);
  assert.throws(() => local.update(s.server_id, { memoryMb: 12 }), /256/);
  assert.throws(() => local.update(s.server_id, { javaMajor: 9 }), /Java-Version/);
  assert.throws(() => local.update(s.server_id, { name: '  ' }), LocalError);
  assert.throws(() => local.need('nope'), (e) => e.status === 404);
  const { dir } = local.remove(s.server_id);
  assert.ok(fs.existsSync(path.join(servers, dir)), 'files stay');
  assert.equal(local.list().length, 1);
});

test('create: name rules; discard removes only a fresh, failed server', async () => {
  const { local, servers } = await setup();
  assert.throws(() => local.create({ name: '' }), LocalError);
  assert.throws(() => local.create({ name: 'x'.repeat(61) }), LocalError);
  const s = local.create({ name: 'A' });
  assert.equal(await local.discard(s.server_id), true);
  assert.deepEqual(fs.readdirSync(servers), []);
  const t = local.create({ name: 'B' });
  local.keep(t.server_id);
  assert.equal(await local.discard(t.server_id), false, 'kept servers are never deleted');
  assert.ok(fs.existsSync(path.join(servers, t.path.split('/').pop())));
});

test('adopt: finds unregistered folders, picks the jar, refuses bad input', async () => {
  const { local, servers } = await setup();
  const d = path.join(servers, 'alt'); fs.mkdirSync(path.join(d, 'world'), { recursive: true });
  fs.writeFileSync(path.join(d, 'server.properties'), 'motd=x\n');
  fs.writeFileSync(path.join(d, 'forge-launcher.jar'), 'x');
  fs.writeFileSync(path.join(d, '.blockhaus-software.json'), JSON.stringify({ software: 'forge', version: '26.3', jar: 'forge-launcher.jar', java: 25 }));
  fs.mkdirSync(path.join(servers, 'zwei')); fs.writeFileSync(path.join(servers, 'zwei', 'a.jar'), 'x'); fs.writeFileSync(path.join(servers, 'zwei', 'b.jar'), 'x');
  fs.mkdirSync(path.join(servers, '.hidden'));
  const c = await local.candidates();
  assert.deepEqual(c.map((x) => x.dir), ['alt', 'zwei']);
  assert.equal(c[0].suggestedJar, 'forge-launcher.jar'); assert.equal(c[0].software, 'forge'); assert.equal(c[0].hasProperties, true);
  assert.equal(c[1].suggestedJar, null);
  assert.throws(() => local.adopt({ dir: 'zwei' }), (e) => e.code === 'JAR');
  assert.throws(() => local.adopt({ dir: '../etc' }), LocalError);
  assert.throws(() => local.adopt({ dir: 'gibtsnicht' }), (e) => e.status === 404);
  assert.throws(() => local.adopt({ dir: 'zwei', jar: '../a.jar' }), LocalError);
  const s = local.adopt({ dir: 'alt', name: 'Mein Forge' });
  assert.equal(s.executable, 'forge-launcher.jar');
  assert.throws(() => local.adopt({ dir: 'alt' }), (e) => e.status === 409);
  assert.deepEqual((await local.candidates()).map((x) => x.dir), ['zwei']);
  assert.equal(local.adopt({ dir: 'zwei', jar: 'b.jar' }).executable, 'b.jar');
});

test('EULA: start is refused until accepted; accepting keeps the rest of eula.txt', async () => {
  const { local, servers } = await setup();
  const s = local.create({ name: 'E' }); fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await assert.rejects(local.start(s.server_id), (e) => e.code === 'EULA' && e.status === 409);
  assert.equal((await local.stats(s.server_id)).eula_ok, false);
  const f = path.join(servers, s.path.split('/').pop(), 'eula.txt');
  fs.writeFileSync(f, '# hi\neula=false\n');
  local.acceptEula(s.server_id);
  assert.equal(fs.readFileSync(f, 'utf8'), '# hi\neula=true\n');
  assert.equal(local.eulaAccepted(s.server_id), true);
  fs.rmSync(f); local.acceptEula(s.server_id);
  assert.match(fs.readFileSync(f, 'utf8'), /aka\.ms\/MinecraftEULA[\s\S]*\neula=true\n/);
});

test('start without the jar says what is missing', async () => {
  const { local } = await setup();
  const s = make(local);
  await assert.rejects(local.start(s.server_id), (e) => e.code === 'NO_JAR');
});

test('lifecycle: starting → online → players/ping/stats → stop → offline; port is forced; console collects output', async () => {
  const { local, servers, port, calls } = await setup();
  const s = make(local, 'Life'); const dir = path.join(servers, s.path.split('/').pop());
  fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'delay'), '700');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Hallo\nserver-port=25565\nmax-players=7\n');
  assert.equal(await state(local, s.server_id), 'offline');
  await local.action(s.server_id, 'start_server');
  assert.equal((await local.stats(s.server_id)).running, true);
  assert.equal(await state(local, s.server_id), 'starting');
  await waitFor(async () => (await state(local, s.server_id)) === 'online', 8000, 'online');
  const pv = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(pv, new RegExp(`server-port=${port}`));
  assert.ok(fs.existsSync(path.join(dir, 'server.properties.blockhaus.bak')));
  assert.ok(calls.length === 1 && calls[0] === 21, 'java wanted: fallback table for unknown version → 21; got ' + calls);
  await local.stdin(s.server_id, 'join Anna'); await local.stdin(s.server_id, 'join Ben');
  const st = await waitFor(async () => { const x = await local.stats(s.server_id); return x.int_ping_results && x.online === 2 && x; }, 8000, 'ping with 2 players');
  assert.deepEqual(st.players.sort(), ['Anna', 'Ben']);
  assert.equal(st.max, 7); assert.equal(st.version, '26.3'); assert.equal(st.desc, 'Fake MOTD'); assert.equal(st.server_port, port);
  assert.equal(st.world_name, 'world');
  await local.stdin(s.server_id, 'leave Anna');
  await waitFor(async () => (await local.stats(s.server_id)).online === 1, 8000, 'one left');
  if (fs.existsSync('/proc/self/stat')) {
    const x = await waitFor(async () => { const y = await local.stats(s.server_id); return y.mem && y; }, 5000, 'memory sample');
    assert.match(x.mem, /\d (MB|GB|KB)/);
    const w = await waitFor(async () => { const y = await local.stats(s.server_id); return y.world_size && y; }, 5000, 'world size');
    assert.match(w.world_size, /KB/);
  }
  const lines = await local.logs(s.server_id);
  assert.ok(lines.some((l) => /Starting minecraft server/.test(l)) && lines.some((l) => /Done \(/.test(l)) && lines.some((l) => /Anna joined the game/.test(l)));
  assert.ok(lines.some((l) => /-Xmx2048M/.test(l)), 'JVM args reached the process');
  await local.action(s.server_id, 'stop_server');
  assert.equal(await state(local, s.server_id), 'stopping');
  await waitFor(async () => (await state(local, s.server_id)) === 'offline', 8000, 'offline');
  const off = await local.stats(s.server_id);
  assert.equal(off.running, false); assert.equal(off.crashed, false); assert.equal(off.online, 0); assert.deepEqual(off.players, []);
  assert.ok((await local.logs(s.server_id)).some((l) => /Server beendet \(Code 0\)/.test(l)));
  await assert.rejects(local.stdin(s.server_id, 'say hi'), (e) => e.status === 409);
  assert.deepEqual(await local.stop(s.server_id), { already: true });
  await cleanup(local);
});

test('only one server runs at a time', async () => {
  const { local, servers } = await setup();
  const a = make(local, 'A'); const b = make(local, 'B');
  for (const s of [a, b]) fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await local.start(a.server_id);
  await assert.rejects(local.start(b.server_id), (e) => e.code === 'OTHER_RUNNING' && /„A“/.test(e.message));
  assert.throws(() => local.remove(a.server_id), (e) => e.status === 409);
  assert.deepEqual(await local.start(a.server_id), { already: true });
  await waitFor(async () => (await state(local, a.server_id)) === 'online');
  await local.stop(a.server_id);
  await waitFor(async () => (await state(local, a.server_id)) === 'offline');
  await local.start(b.server_id);
  await waitFor(async () => (await state(local, b.server_id)) === 'online');
  await cleanup(local);
});

test('crash: exit code ≠ 0 without a stop request is "crashed", explained, and a new start clears it', async () => {
  const { local, servers } = await setup();
  const s = make(local, 'C'); const dir = path.join(servers, s.path.split('/').pop());
  fs.writeFileSync(path.join(dir, 'server.jar'), 'x');
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  await local.stdin(s.server_id, 'crash');
  const st = await waitFor(async () => { const x = await local.stats(s.server_id); return x.crashed && x; });
  assert.equal(st.blockhausState, 'crashed'); assert.equal(st.running, false); assert.match(st.notice, /abgestürzt \(Code 3\)/);
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  assert.equal((await local.stats(s.server_id)).crashed, false);
  await cleanup(local);
});

test('restart: stops, then starts again with a new process', async () => {
  const { local, servers } = await setup();
  const s = make(local, 'R'); fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  const pid1 = local.rt.get(s.server_id).pid;
  await local.action(s.server_id, 'restart_server');
  await waitFor(async () => { const r = local.rt.get(s.server_id); return r.pid && r.pid !== pid1 && r.state === 'online'; }, 10000, 'restarted');
  assert.equal((await local.stats(s.server_id)).crashed, false);
  await local.action(s.server_id, 'restart_server').catch(() => {});
  await cleanup(local);
  const idle = make(local, 'Idle'); fs.writeFileSync(path.join(servers, idle.path.split('/').pop(), 'server.jar'), 'x');
  await local.action(idle.server_id, 'restart_server'); // not running: restart = start
  await waitFor(async () => (await state(local, idle.server_id)) === 'online');
  await cleanup(local);
});

test('a server that ignores "stop" is killed after the timeout, together with its child process', async () => {
  const { local, servers } = await setup({ local: { stopTimeoutMs: 400 } });
  const s = make(local, 'H'); const dir = path.join(servers, s.path.split('/').pop());
  fs.writeFileSync(path.join(dir, 'server.jar'), 'x'); fs.writeFileSync(path.join(dir, 'hang'), ''); fs.writeFileSync(path.join(dir, 'grandchild'), '');
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  const child = Number(await waitFor(() => { try { return fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'); } catch { return null; } }));
  assert.doesNotThrow(() => process.kill(child, 0), 'child is alive');
  await local.stop(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'offline', 8000, 'killed');
  assert.ok((await local.logs(s.server_id)).some((l) => /nicht beendet und wird beendet/.test(l)));
  assert.equal((await local.stats(s.server_id)).crashed, false, 'a requested stop is not a crash');
  await waitFor(() => { try { process.kill(child, 0); return false; } catch { return true; } }, 3000, 'child gone');
  await cleanup(local);
});

test('kill: immediate, not a crash', async () => {
  const { local, servers } = await setup();
  const s = make(local, 'K'); const dir = path.join(servers, s.path.split('/').pop());
  fs.writeFileSync(path.join(dir, 'server.jar'), 'x'); fs.writeFileSync(path.join(dir, 'hang'), '');
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  await local.action(s.server_id, 'kill_server');
  await waitFor(async () => (await state(local, s.server_id)) === 'offline');
  const st = await local.stats(s.server_id);
  assert.equal(st.crashed, false);
  await cleanup(local);
});

test('Java problems surface as a clear "crashed" state with the reason; stop while Java is downloading cancels the start', async () => {
  let x = await setup({ javaError: 'Kein Netz zu Adoptium.' });
  let s = make(x.local, 'J'); fs.writeFileSync(path.join(x.servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await x.local.start(s.server_id);
  let st = await waitFor(async () => { const y = await x.local.stats(s.server_id); return y.crashed && y; });
  assert.match(st.notice, /Kein Netz zu Adoptium/);
  assert.ok((await x.local.logs(s.server_id)).some((l) => /Fehler: Kein Netz/.test(l)));

  x = await setup({ javaDelay: 400 });
  s = make(x.local, 'J2'); fs.writeFileSync(path.join(x.servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await x.local.start(s.server_id);
  assert.equal((await x.local.stats(s.server_id)).running, true, 'counts as starting while Java loads');
  await x.local.stop(s.server_id);
  await waitFor(async () => (await x.local.stats(s.server_id)).running === false);
  assert.equal(x.local.rt.get(s.server_id).pid, null, 'no process was started');
  assert.equal((await x.local.stats(s.server_id)).crashed, false);
});

test('autostart starts the marked server; shutdown stops it cleanly (exit code 0, not killed)', async () => {
  const { local, servers } = await setup();
  const s = make(local, 'Auto'); fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
  local.update(s.server_id, { autostart: true });
  const msgs = [];
  assert.equal(await local.autostart((m) => msgs.push(m)), s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online');
  const t0 = Date.now();
  await local.shutdown(5000);
  assert.ok(Date.now() - t0 < 4000, 'did not need the kill timer');
  assert.equal(await state(local, s.server_id), 'offline');
  assert.ok((await local.logs(s.server_id)).some((l) => /Code 0/.test(l)));
});

test('logs() falls back to logs/latest.log when this process has not run the server', async () => {
  const { local, servers } = await setup();
  const s = local.create({ name: 'L' }); const dir = path.join(servers, s.path.split('/').pop());
  fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), 'eins\nzwei\n');
  assert.deepEqual((await local.logs(s.server_id)).filter(Boolean), ['eins', 'zwei']);
});

test('real java.ensure path: BLOCKHAUS_JAVA_<major> points the panel at a Java of your choice', async () => {
  const bin = fakeJava();
  process.env.BLOCKHAUS_JAVA_21 = bin;
  try {
    const data = tmp(); const servers = tmp(); const port = await freePort();
    const local = new Local({ dataDir: data, serversDir: servers, port, pollMs: 60 });
    const s = make(local, 'Env'); fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
    await local.start(s.server_id);
    await waitFor(async () => (await state(local, s.server_id)) === 'online');
    await cleanup(local);
  } finally { delete process.env.BLOCKHAUS_JAVA_21; }
});

test('ping and stats keep working when Java had to be fetched first (the sampling timer must not die during the wait)', async () => {
  const { local, servers } = await setup({ javaDelay: 400, local: { pollMs: 50 } });
  const s = make(local, 'Slow'); fs.writeFileSync(path.join(servers, s.path.split('/').pop(), 'server.jar'), 'x');
  await local.start(s.server_id);
  await waitFor(async () => (await state(local, s.server_id)) === 'online', 8000, 'online');
  await local.stdin(s.server_id, 'join Anna');
  const st = await waitFor(async () => { const x = await local.stats(s.server_id); return x.int_ping_results && x.online === 1 && x; }, 5000, 'ping after slow java');
  assert.deepEqual(st.players, ['Anna']);
  if (fs.existsSync('/proc/self/stat')) await waitFor(async () => (await local.stats(s.server_id)).mem, 5000, 'memory sample');
  await cleanup(local);
});
