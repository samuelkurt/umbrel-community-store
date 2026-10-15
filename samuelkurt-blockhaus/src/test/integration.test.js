'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createApp } = require('../server');
const { createMockCrafty } = require('./mock-crafty');

const PROPS = `#Minecraft server properties
motd=A Minecraft Server
max-players=20
online-mode=true
white-list=false
level-seed=
`;

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockhaus-'));
  const dataDir = path.join(tmp, 'data');
  const serversDir = path.join(tmp, 'servers');
  const sdir = path.join(serversDir, 'uuid-1');
  fs.mkdirSync(path.join(sdir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'server.properties'), PROPS);
  fs.writeFileSync(path.join(sdir, 'logs', 'latest.log'), '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n[10:00:05] [Server thread/INFO]: Done (4.1s)! For help, type "help"\n');
  fs.writeFileSync(path.join(sdir, 'logs', '2026-10-12-1.log.gz'), zlib.gzipSync('old log line\n'));

  const mock = createMockCrafty();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.server.address().port}`;

  const app = createApp({ dataDir, serversDir, lookup: async (n) => (n === 'Ghost' ? null : { uuid: '11111111-2222-3333-4444-555555555555', name: n }), settleMs: 5 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const close = () => { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); };
  return { tmp, sdir, mock, mockUrl, app, call, base, close };
}

test('config: unconfigured -> configure -> secrets never returned', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', '/api/config');
    assert.equal(r.json.configured, false);
    r = await t.call('PUT', '/api/config', { craftyUrl: t.mockUrl, apiToken: 'tok123', publicAddress: 'x.ply.gg:1' });
    assert.equal(r.json.configured, true);
    assert.equal(r.json.hasToken, true);
    assert.ok(!r.text.includes('tok123'));
    const file = path.join(t.tmp, 'data', 'config.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // empty token field keeps the stored one
    r = await t.call('PUT', '/api/config', { apiToken: '', publicAddress: 'y.ply.gg:2' });
    assert.equal(r.json.hasToken, true);
    assert.equal(r.json.publicAddress, 'y.ply.gg:2');
  } finally { t.close(); }
});

test('config test: reports success, wrong token, and unreachable Crafty', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', '/api/config/test', { craftyUrl: t.mockUrl, apiToken: 'tok123' });
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.servers, [{ id: 'uuid-1', name: 'Samuels Welt', filesFound: true }]);
    r = await t.call('POST', '/api/config/test', { craftyUrl: t.mockUrl, apiToken: 'wrong' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'FORBIDDEN');
    r = await t.call('POST', '/api/config/test', { craftyUrl: 'http://127.0.0.1:1', apiToken: 'x' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'UNREACHABLE');
  } finally { t.close(); }
});

test('username/password login works and re-logs-in after the token expired', async () => {
  const t = await setup();
  try {
    await t.call('PUT', '/api/config', { craftyUrl: t.mockUrl, username: 'admin', password: 'secret' });
    let r = await t.call('GET', '/api/servers');
    assert.equal(r.status, 200);
    assert.equal(t.mock.state.logins, 1);
    r = await t.call('GET', '/api/servers/uuid-1/status');
    assert.equal(r.status, 200);
    assert.equal(t.mock.state.logins, 1, 'JWT is reused');
    await t.call('PUT', '/api/config', { password: 'nope' });
    r = await t.call('GET', '/api/servers');
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'LOGIN_FAILED');
  } finally { t.close(); }
});

async function configured() {
  const t = await setup();
  await t.call('PUT', '/api/config', { craftyUrl: t.mockUrl, apiToken: 'tok123' });
  return t;
}

test('status: offline -> start -> starting -> online (from the log) with software info', async () => {
  const t = await configured();
  try {
    let r = await t.call('GET', '/api/servers/uuid-1/status');
    assert.equal(r.json.state, 'offline');
    assert.equal(r.json.software, 'Vanilla');
    assert.equal(r.json.memoryMb, 6000);
    assert.equal(r.json.version, '1.21.4');
    assert.equal(r.json.filesAvailable, true);
    r = await t.call('POST', '/api/servers/uuid-1/action/start', {});
    assert.equal(r.status, 200);
    assert.deepEqual(t.mock.state.actions, ['start_server']);
    // log from the earlier run says Done -> panel reports online even without ping
    r = await t.call('GET', '/api/servers/uuid-1/status');
    assert.equal(r.json.state, 'online');
    t.mock.state.players = ['Steve', 'Alex'];
    r = await t.call('GET', '/api/servers/uuid-1/status');
    assert.deepEqual(r.json.players, ['Steve', 'Alex']);
    assert.equal(r.json.online, 2);
  } finally { t.close(); }
});

test('actions: only whitelisted actions; non-JSON POST is refused (CSRF)', async () => {
  const t = await configured();
  try {
    let r = await t.call('POST', '/api/servers/uuid-1/action/delete', {});
    assert.equal(r.status, 404);
    const res = await fetch(t.base + '/api/servers/uuid-1/action/stop', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 415);
    assert.deepEqual(t.mock.state.actions, []);
  } finally { t.close(); }
});

test('console: lines, commands (slash stripped, newlines removed)', async () => {
  const t = await configured();
  try {
    let r = await t.call('GET', '/api/servers/uuid-1/console');
    assert.equal(r.json.lines.length, 1);
    r = await t.call('POST', '/api/servers/uuid-1/command', { command: '/say hi\nstop' });
    assert.equal(r.status, 200);
    assert.deepEqual(t.mock.state.stdin, ['say hi stop']);
    r = await t.call('POST', '/api/servers/uuid-1/command', { command: '  ' });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});

test('properties: read, write keeps file layout, makes a backup, flags restart when running', async () => {
  const t = await configured();
  try {
    let r = await t.call('GET', '/api/servers/uuid-1/properties');
    assert.equal(r.json.values['max-players'], '20');
    assert.equal(r.json.running, false);
    r = await t.call('PUT', '/api/servers/uuid-1/properties', { changes: { 'max-players': 8, 'online-mode': false, 'level-seed': '-4172144997902289642' } });
    assert.equal(r.json.changed, 3);
    assert.equal(r.json.restartNeeded, false);
    const now = fs.readFileSync(path.join(t.sdir, 'server.properties'), 'utf8');
    assert.equal(now, PROPS.replace('max-players=20', 'max-players=8').replace('online-mode=true', 'online-mode=false').replace('level-seed=', 'level-seed=-4172144997902289642'));
    assert.equal(fs.readFileSync(path.join(t.sdir, 'server.properties.blockhaus.bak'), 'utf8'), PROPS);
    t.mock.state.running = true;
    r = await t.call('PUT', '/api/servers/uuid-1/properties', { changes: { pvp: 'false' } });
    assert.equal(r.json.restartNeeded, true);
    r = await t.call('PUT', '/api/servers/uuid-1/properties', { changes: { 'bad key': 'x' } });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});

test('players (server stopped): files are edited, UUID comes from the lookup', async () => {
  const t = await configured();
  try {
    let r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'Steve' });
    assert.equal(r.json.via, 'file');
    const wl = JSON.parse(fs.readFileSync(path.join(t.sdir, 'whitelist.json'), 'utf8'));
    assert.deepEqual(wl, [{ uuid: '11111111-2222-3333-4444-555555555555', name: 'Steve' }]);
    r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'steve' });
    assert.equal(r.json.entries.length, 1, 'no duplicates (case-insensitive)');
    r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'Ghost' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /gibt es nicht/);
    r = await t.call('POST', '/api/servers/uuid-1/players/ops', { name: 'Steve' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.sdir, 'ops.json'), 'utf8'))[0].level, 4);
    r = await t.call('POST', '/api/servers/uuid-1/players/banned-ips', { name: '10.0.0.9' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.sdir, 'banned-ips.json'), 'utf8'))[0].ip, '10.0.0.9');
    r = await t.call('DELETE', '/api/servers/uuid-1/players/whitelist/Steve');
    assert.deepEqual(r.json.entries, []);
    r = await t.call('GET', '/api/servers/uuid-1/players');
    assert.equal(r.json.lists.ops.length, 1);
    assert.equal(r.json.onlineMode, true);
    assert.equal(r.json.whitelistEnabled, false);
    assert.deepEqual(t.mock.state.stdin, [], 'no console commands while stopped');
  } finally { t.close(); }
});

test('players: cracked server gets the offline UUID without any Mojang lookup', async () => {
  const t = await configured();
  try {
    fs.writeFileSync(path.join(t.sdir, 'server.properties'), PROPS.replace('online-mode=true', 'online-mode=false'));
    const r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'Ghost' });
    assert.equal(r.status, 200);
    assert.equal(r.json.entries[0].uuid, require('../lib/players').offlineUuid('Ghost'));
    assert.match(r.json.entries[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { t.close(); }
});

test('players (server running): uses console commands, never touches the files', async () => {
  const t = await configured();
  try {
    t.mock.state.running = true;
    let r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'Alex' });
    assert.equal(r.json.via, 'console');
    r = await t.call('POST', '/api/servers/uuid-1/players/banned-players', { name: 'Grief_er' });
    r = await t.call('DELETE', '/api/servers/uuid-1/players/banned-players/Grief_er');
    r = await t.call('POST', '/api/servers/uuid-1/kick', { name: 'Alex' });
    assert.deepEqual(t.mock.state.stdin, ['whitelist add Alex', 'ban Grief_er', 'pardon Grief_er', 'kick Alex']);
    assert.equal(fs.existsSync(path.join(t.sdir, 'whitelist.json')), false);
    r = await t.call('POST', '/api/servers/uuid-1/players/whitelist', { name: 'x\nop Evil' });
    assert.equal(r.status, 400);
    assert.equal(t.mock.state.stdin.length, 4);
  } finally { t.close(); }
});

test('logs: list, read plain and gz, reject traversal', async () => {
  const t = await configured();
  try {
    let r = await t.call('GET', '/api/servers/uuid-1/logs');
    assert.deepEqual(r.json.files.map((f) => f.name), ['latest.log', '2026-10-12-1.log.gz']);
    r = await t.call('GET', '/api/servers/uuid-1/logs/latest.log');
    assert.match(r.json.text, /Done \(4\.1s\)/);
    r = await t.call('GET', '/api/servers/uuid-1/logs/2026-10-12-1.log.gz');
    assert.equal(r.json.text, 'old log line\n');
    r = await t.call('GET', '/api/servers/uuid-1/logs/' + encodeURIComponent('../server.properties'));
    assert.equal(r.status, 404);
    r = await t.call('GET', '/api/servers/uuid-1/logs/' + encodeURIComponent('..%2f..%2fetc%2fpasswd'));
    assert.equal(r.status, 404);
  } finally { t.close(); }
});

test('missing server folder gives a clear error instead of a crash', async () => {
  const t = await configured();
  try {
    fs.rmSync(t.sdir, { recursive: true });
    let r = await t.call('GET', '/api/servers/uuid-1/properties');
    assert.equal(r.status, 500);
    assert.match(r.json.error, /nicht eingehängt/);
    r = await t.call('GET', '/api/servers/uuid-1/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.filesAvailable, false);
  } finally { t.close(); }
});

test('static: index served, traversal blocked', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /Blockhaus/);
    const res = await fetch(t.base + '/..%2fserver.js');
    assert.notEqual(res.status, 200);
  } finally { t.close(); }
});
