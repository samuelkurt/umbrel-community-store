'use strict';
// Switching software on a running server: stop first (on request), install, optionally start again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createMockCrafty } = require('./mock-crafty');

async function setup(softwareInstall) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-swstop-'));
  const sdir = path.join(tmp, 'servers/uuid-1');
  fs.mkdirSync(path.join(sdir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'world/level.dat'), 'x');
  fs.writeFileSync(path.join(sdir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(sdir, 'vanilla.jar'), 'jar');
  const mock = createMockCrafty(); await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = createApp({ dataDir: path.join(tmp, 'data'), serversDir: path.join(tmp, 'servers'), settleMs: 5, softwareInstall });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  app.config.update({ craftyUrl: `http://127.0.0.1:${mock.server.address().port}`, apiToken: 'tok123' });
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };
  const waitJob = async (id) => { for (let i = 0; i < 200; i++) { const r = await call('GET', `/api/servers/uuid-1/jobs/${id}`); if (r.json.status !== 'running') return r.json; await new Promise((x) => setTimeout(x, 25)); } throw new Error('timeout'); };
  const close = () => { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); };
  return { sdir, mock, call, waitJob, close };
}
const S = '/api/servers/uuid-1/software/install';

test('running server: install is refused unless stopFirst is set', async () => {
  const t = await setup(async () => { throw new Error('must not run'); });
  try {
    t.mock.state.running = true;
    const r = await t.call('POST', S, { kind: 'fabric', version: '1.21.4' });
    assert.equal(r.status, 409);
    assert.deepEqual(t.mock.state.actions, []);
  } finally { t.close(); }
});

test('stopFirst + startAfter: stop, back up the worlds, install, start again', async () => {
  const calls = [];
  const t = await setup(async (o) => { calls.push({ kind: o.kind, version: o.version, running: t.mock.state.running }); return { software: o.kind, version: o.version }; });
  try {
    t.mock.state.running = true;
    const r = await t.call('POST', S, { kind: 'fabric', version: '1.21.4', stopFirst: true, startAfter: true });
    assert.equal(r.status, 202);
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(t.mock.state.actions, ['stop_server', 'start_server']);
    assert.deepEqual(calls, [{ kind: 'fabric', version: '1.21.4', running: false }], 'install ran with the server stopped');
    assert.equal(job.result.started, true);
    const backups = fs.readdirSync(path.join(path.dirname(path.dirname(t.sdir)), 'data/backups/uuid-1')).filter((f) => f.endsWith('.zip'));
    assert.equal(backups.length, 1, 'worlds were backed up before the switch');
  } finally { t.close(); }
});

test('stopFirst without startAfter leaves the server stopped; a failed install says the server was stopped', async () => {
  let fail = false;
  const t = await setup(async (o) => { if (fail) throw new Error('Download kaputt'); return { software: o.kind, version: o.version }; });
  try {
    t.mock.state.running = true;
    let r = await t.call('POST', S, { kind: 'paper', version: '1.21.4', stopFirst: true, backup: false });
    let job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done'); assert.deepEqual(t.mock.state.actions, ['stop_server']);
    t.mock.state.running = true; t.mock.state.actions.length = 0; fail = true;
    r = await t.call('POST', S, { kind: 'paper', version: '1.21.4', stopFirst: true, startAfter: true, backup: false });
    job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'error'); assert.match(job.error, /Download kaputt.*gestoppt/);
    assert.deepEqual(t.mock.state.actions, ['stop_server'], 'no start after a failure');
    // an already stopped server is not stopped again
    t.mock.state.running = false; t.mock.state.actions.length = 0; fail = false;
    r = await t.call('POST', S, { kind: 'paper', version: '1.21.4', stopFirst: true, backup: false });
    job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done'); assert.deepEqual(t.mock.state.actions, []);
  } finally { t.close(); }
});
