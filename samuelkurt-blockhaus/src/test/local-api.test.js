'use strict';
// The panel in standalone mode over HTTP, with a fake Java (test/fake-mc.js) instead of Minecraft.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { createApp } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(30); }
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lapi-'));
  const dataDir = path.join(tmp, 'data'); const serversDir = path.join(tmp, 'servers');
  fs.mkdirSync(serversDir, { recursive: true });
  const bin = path.join(tmp, 'java');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-mc.js')}" "$@"\n`, { mode: 0o755 });
  const mcPort = await freePort();
  const installs = [];
  const app = createApp({
    dataDir, serversDir, mode: 'local', mcPort, settleMs: 5,
    localOpts: { pollMs: 60, stopTimeoutMs: 4000, ensureJava: async () => ({ bin, major: 21 }) },
    softwareInstall: async ({ dir, server, kind, version, job }) => {
      installs.push({ kind, version, jar: server.executable });
      if (version === 'boom') throw new Error('Download kaputt.');
      job.message = 'fake install';
      fs.writeFileSync(path.join(dir, server.executable), 'jar');
      fs.writeFileSync(path.join(dir, '.blockhaus-software.json'), JSON.stringify({ software: kind, version, jar: server.executable, java: 21 }));
      return { software: kind, version };
    },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const close = async () => { await app.local.shutdown(2000).catch(() => {}); app.close(); app.closeAllConnections?.(); };
  return { tmp, dataDir, serversDir, app, call, close, mcPort, installs };
}
const job = async (t, id) => waitFor(async () => { const r = await t.call('GET', `/api/local/jobs/${id}`); return r.json.status !== 'running' && r.json; }, 8000, 'job');

test('local mode: needs no Crafty setup; config view says so', async () => {
  const t = await setup();
  try {
    const r = await t.call('GET', '/api/config');
    assert.equal(r.json.mode, 'local'); assert.equal(r.json.configured, true); assert.equal(r.json.mcPort, t.mcPort);
    assert.equal(r.json.packUpstream, `127.0.0.1:${t.mcPort}`); assert.equal(r.json.voicePort, 24454);
    assert.equal(r.json.appVersion, '0.8.5');
    assert.deepEqual((await t.call('GET', '/api/servers')).json, []);
    const test = await t.call('POST', '/api/config/test', {});
    assert.equal(test.json.ok, true);
    const info = (await t.call('GET', '/api/local/info')).json;
    assert.equal(info.port, t.mcPort); assert.deepEqual(info.candidates, []);
  } finally { await t.close(); }
});

test('create → install job → EULA → start → status/console/command → stop; files and properties in the right place', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', '/api/local/servers', { name: 'Freunde', kind: 'vanilla', version: '26.3', memoryMb: 1536 });
    assert.equal(r.status, 202);
    const id = r.json.server.id;
    const done = await job(t, r.json.job.id);
    assert.equal(done.status, 'done'); assert.equal(done.result.serverId, id);
    assert.deepEqual(t.installs, [{ kind: 'vanilla', version: '26.3', jar: 'server.jar' }]);
    assert.ok(fs.existsSync(path.join(t.serversDir, 'freunde', 'server.jar')));
    assert.deepEqual((await t.call('GET', '/api/servers')).json.map((s) => [s.id, s.name, s.port]), [[id, 'Freunde', t.mcPort]]);

    let st = (await t.call('GET', `/api/servers/${id}/status`)).json;
    assert.equal(st.state, 'offline'); assert.equal(st.eulaOk, false); assert.equal(st.memoryMb, 1536); assert.equal(st.software, 'Vanilla'); assert.equal(st.version, '26.3'); assert.equal(st.filesAvailable, true);

    r = await t.call('POST', `/api/servers/${id}/action/start`, {});
    assert.equal(r.status, 409); assert.equal(r.json.code, 'EULA'); assert.match(r.json.error, /EULA/);
    assert.equal((await t.call('POST', `/api/servers/${id}/eula`, {})).status, 200);
    assert.equal((await t.call('GET', `/api/servers/${id}/status`)).json.eulaOk, true);

    assert.equal((await t.call('POST', `/api/servers/${id}/action/start`, {})).status, 200);
    st = await waitFor(async () => { const s = (await t.call('GET', `/api/servers/${id}/status`)).json; return s.state === 'online' && s.online === 0 && s.max >= 0 && s; });
    assert.equal(st.running, true); assert.equal(st.port, t.mcPort);
    await t.call('POST', `/api/servers/${id}/command`, { command: '/join Anna' });
    st = await waitFor(async () => { const s = (await t.call('GET', `/api/servers/${id}/status`)).json; return s.online === 1 && s; });
    assert.deepEqual(st.players, ['Anna']); assert.equal(st.version, '26.3'); assert.equal(st.motd, 'Fake MOTD');
    const con = (await t.call('GET', `/api/servers/${id}/console`)).json.lines;
    assert.ok(con.some((l) => /Anna joined the game/.test(l)));
    const pr = (await t.call('GET', `/api/servers/${id}/properties`)).json;
    assert.equal(pr.running, true); assert.equal(pr.values['server-port'], String(t.mcPort));

    // a running server cannot be removed; settings changes say "restart needed"
    assert.equal((await t.call('DELETE', `/api/servers/${id}`)).status, 409);
    r = await t.call('PUT', `/api/servers/${id}/local`, { memoryMb: 3072, autostart: true });
    assert.deepEqual([r.status, r.json.restartNeeded], [200, true]);
    assert.equal((await t.call('GET', `/api/servers/${id}/status`)).json.memoryMb, 3072);

    await t.call('POST', `/api/servers/${id}/action/stop`, {});
    await waitFor(async () => (await t.call('GET', `/api/servers/${id}/status`)).json.state === 'offline');
    assert.ok(Array.isArray((await t.call('GET', `/api/servers/${id}/logs`)).json.files), 'log list works without Crafty');

    // removing a server forgets it but keeps its files; they can be adopted again
    r = await t.call('DELETE', `/api/servers/${id}`);
    assert.deepEqual([r.status, r.json.dir], [200, 'freunde']);
    assert.ok(fs.existsSync(path.join(t.serversDir, 'freunde', 'server.jar')), 'files are kept');
    assert.deepEqual((await t.call('GET', '/api/servers')).json, []);
    const c = (await t.call('GET', '/api/local/candidates')).json.candidates;
    assert.deepEqual(c.map((x) => [x.dir, x.suggestedJar, x.software]), [['freunde', 'server.jar', 'vanilla']]);
    r = await t.call('POST', '/api/local/adopt', { dir: 'freunde', name: 'Wieder da' });
    assert.equal(r.status, 200);
    assert.equal((await t.call('GET', '/api/servers')).json[0].name, 'Wieder da');
  } finally { await t.close(); }
});

test('create: a failed install leaves nothing behind; bad input is refused with a reason', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', '/api/local/servers', { name: 'X', kind: 'vanilla', version: 'boom' });
    assert.equal(r.status, 202);
    const j = await job(t, r.json.job.id);
    assert.equal(j.status, 'error'); assert.match(j.error, /Download kaputt/);
    assert.deepEqual((await t.call('GET', '/api/servers')).json, []);
    assert.deepEqual(fs.readdirSync(t.serversDir), []);
    for (const [body, re] of [[{ name: '', kind: 'vanilla', version: '1' }, /Namen/], [{ name: 'A', kind: 'spigot', version: '1' }, /BuildTools|Spigot/], [{ name: 'A', kind: 'vanilla' }, /Version/], [{ name: 'A', kind: 'vanilla', version: '1', memoryMb: 10 }, /Arbeitsspeicher/]]) {
      r = await t.call('POST', '/api/local/servers', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, re);
    }
    assert.deepEqual(fs.readdirSync(t.serversDir), [], 'refused requests create no folder');
    r = await t.call('GET', '/api/local/jobs/abc123'); assert.equal(r.status, 404);
    r = await t.call('POST', '/api/local/adopt', { dir: '../x' }); assert.equal(r.status, 400);
    r = await t.call('POST', '/api/servers/nope/eula', {}); assert.equal(r.status, 404);
  } finally { await t.close(); }
});

test('voice page in standalone mode suggests the published UDP port 24454', async () => {
  const t = await setup();
  try {
    const r0 = await t.call('POST', '/api/local/servers', { name: 'V', kind: 'vanilla', version: '26.3' });
    await job(t, r0.json.job.id);
    const id = r0.json.server.id;
    const v = (await t.call('GET', `/api/servers/${id}/voicechat`)).json;
    assert.equal(v.suggestedPort, 24454); assert.equal(v.mode, 'local');
  } finally { await t.close(); }
});

test('crafty mode is unchanged: no /local routes, config says crafty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lapi-'));
  const app = createApp({ dataDir: path.join(tmp, 'd'), serversDir: path.join(tmp, 's'), mode: 'crafty' });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.mode, 'crafty'); assert.equal(cfg.configured, false);
    assert.equal((await fetch(base + '/api/local/info')).status, 404);
  } finally { app.close(); app.closeAllConnections?.(); }
});
