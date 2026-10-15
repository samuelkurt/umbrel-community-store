'use strict';
// Stage 3 routes: files, worlds, backups, mods, inventories, tools. Uses real level.dat / playerdata files
// recorded from a Minecraft 1.21.4 server (test/fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../server');
const { createMockCrafty } = require('./mock-crafty');
const zipLib = require('../lib/zip');

const FX = path.join(__dirname, 'fixtures');
const PLAYER_UUID = 'a56f51f0-6e4c-36c0-8941-ded96614542b';
const hasCli = (c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } };

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockhaus3-'));
  const dataDir = path.join(tmp, 'data');
  const serversDir = path.join(tmp, 'servers');
  const sdir = path.join(serversDir, 'uuid-1');
  fs.mkdirSync(path.join(sdir, 'world/playerdata'), { recursive: true });
  fs.mkdirSync(path.join(sdir, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(sdir, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(FX, 'level-1.21.4.dat'), path.join(sdir, 'world/level.dat'));
  fs.copyFileSync(path.join(FX, 'playerdata-1.21.4.dat'), path.join(sdir, `world/playerdata/${PLAYER_UUID}.dat`));
  fs.writeFileSync(path.join(sdir, 'world/region/r.0.0.mca'), crypto.randomBytes(20000));
  fs.writeFileSync(path.join(sdir, 'server.properties'), 'level-name=world\nonline-mode=false\nlevel-seed=\nmax-players=20\n');
  fs.writeFileSync(path.join(sdir, 'usercache.json'), JSON.stringify([{ name: 'Steve_Bot', uuid: PLAYER_UUID, expiresOn: '2027-01-01 00:00:00 +0000' }]));
  fs.writeFileSync(path.join(sdir, 'logs/latest.log'), '[10:00:00] [Server thread/INFO]: Done (3s)! For help, type "help"\n');
  fs.writeFileSync(path.join(sdir, 'vanilla.jar'), 'jar');

  const mock = createMockCrafty();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = createApp({ dataDir, serversDir, settleMs: 5 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  app.config.update({ craftyUrl: `http://127.0.0.1:${mock.server.address().port}`, apiToken: 'tok123' });
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const raw = async (method, p, buf, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/octet-stream', 'X-Blockhaus': '1', ...headers }, body: buf });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
  const waitJob = async (id, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await call('GET', `/api/servers/uuid-1/jobs/${id}`);
      if (r.json.status !== 'running') return r.json;
      if (Date.now() - t0 > ms) throw new Error('job timeout');
      await new Promise((x) => setTimeout(x, 50));
    }
  };
  const close = () => { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); };
  return { tmp, sdir, mock, app, call, raw, base, waitJob, close, dataDir };
}
const S = '/api/servers/uuid-1';

test('files: list, read, write, mkdir, rename, delete, download', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', `${S}/files`);
    assert.equal(r.json.path, '');
    assert.deepEqual(r.json.entries.map((e) => e.name).slice(0, 2), ['logs', 'world']); // folders first
    assert.equal(r.json.entries.find((e) => e.name === 'server.properties').text, true);
    r = await t.call('GET', `${S}/files/read?path=server.properties`);
    assert.match(r.json.text, /level-name=world/);
    r = await t.call('PUT', `${S}/files/write`, { path: 'notes.txt', text: 'hallo äöü' });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(t.sdir, 'notes.txt'), 'utf8'), 'hallo äöü');
    r = await t.call('POST', `${S}/files/mkdir`, { path: 'extra/sub' });
    assert.equal(r.status, 404, 'parent must exist');
    r = await t.call('POST', `${S}/files/mkdir`, { path: 'extra' });
    assert.equal(r.status, 200);
    r = await t.call('POST', `${S}/files/rename`, { from: 'notes.txt', to: 'extra/notes2.txt' });
    assert.equal(r.status, 200);
    r = await t.call('POST', `${S}/files/rename`, { from: 'extra', to: 'extra/inner' });
    assert.equal(r.status, 400);
    const res = await fetch(`${t.base}${S}/files/download?path=${encodeURIComponent('extra/notes2.txt')}`);
    assert.equal(await res.text(), 'hallo äöü');
    assert.match(res.headers.get('content-disposition'), /notes2\.txt/);
    r = await t.call('POST', `${S}/files/delete`, { path: 'extra' });
    assert.equal(fs.existsSync(path.join(t.sdir, 'extra')), false);
    r = await t.call('POST', `${S}/files/delete`, { path: '' });
    assert.equal(r.status, 400, 'server folder itself cannot be deleted');
    fs.writeFileSync(path.join(t.sdir, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    r = await t.call('GET', `${S}/files/read?path=bin.dat`);
    assert.equal(r.status, 400);
  } finally { t.close(); }
});

test('files: traversal and symlink escapes are refused everywhere', async () => {
  const t = await setup();
  try {
    fs.mkdirSync(path.join(t.tmp, 'secret')); fs.writeFileSync(path.join(t.tmp, 'secret/x.txt'), 'top secret');
    fs.symlinkSync(path.join(t.tmp, 'secret'), path.join(t.sdir, 'link'));
    for (const p of ['../servers', '../../etc/passwd', '/etc/passwd', 'link', 'link/x.txt']) {
      assert.equal((await t.call('GET', `${S}/files?path=${encodeURIComponent(p)}`)).status, 400, p);
      assert.equal((await t.call('GET', `${S}/files/read?path=${encodeURIComponent(p)}`)).status, 400, p);
      assert.equal((await fetch(`${t.base}${S}/files/download?path=${encodeURIComponent(p)}`)).status, 400, p);
    }
    assert.equal((await t.call('PUT', `${S}/files/write`, { path: 'link/pwn.txt', text: 'x' })).status, 400);
    assert.equal((await t.call('POST', `${S}/files/delete`, { path: 'link/x.txt' })).status, 400);
    assert.equal((await t.call('POST', `${S}/files/rename`, { from: 'server.properties', to: '../out.txt' })).status, 400);
    assert.equal((await t.raw('PUT', `${S}/files/upload?path=link&name=a.txt`, 'x')).status, 400);
    assert.equal((await t.raw('PUT', `${S}/files/upload?path=&name=${encodeURIComponent('../a.txt')}`, 'x')).status, 400);
    assert.ok(!fs.existsSync(path.join(t.tmp, 'secret/pwn.txt')) && !fs.existsSync(path.join(t.tmp, 'out.txt')));
  } finally { t.close(); }
});

test('files: upload needs the CSRF headers, refuses overwrite unless asked', async () => {
  const t = await setup();
  try {
    let res = await fetch(`${t.base}${S}/files/upload?path=&name=a.txt`, { method: 'PUT', body: 'x' });
    assert.equal(res.status, 415);
    res = await fetch(`${t.base}${S}/files/upload?path=&name=a.txt`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' });
    assert.equal(res.status, 415, 'header X-Blockhaus missing');
    let r = await t.raw('PUT', `${S}/files/upload?path=&name=a.txt`, 'one');
    assert.equal(r.status, 200); assert.equal(r.json.size, 3);
    r = await t.raw('PUT', `${S}/files/upload?path=&name=a.txt`, 'two');
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(path.join(t.sdir, 'a.txt'), 'utf8'), 'one');
    r = await t.raw('PUT', `${S}/files/upload?path=&name=a.txt&overwrite=1`, 'two');
    assert.equal(fs.readFileSync(path.join(t.sdir, 'a.txt'), 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(t.sdir).filter((n) => n.includes('.upload')), [], 'no temp files left');
  } finally { t.close(); }
});

test('worlds: list reads the real seed from level.dat; new/activate/delete rules', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', `${S}/worlds`);
    assert.equal(r.json.active, 'world');
    assert.equal(r.json.worlds.length, 1);
    assert.equal(r.json.worlds[0].seed, '12345');
    assert.equal(r.json.worlds[0].version, '1.21.4');
    assert.equal(r.json.worlds[0].gameType, 'Überleben');
    assert.ok(r.json.worlds[0].size > 20000);
    // new world
    r = await t.call('POST', `${S}/worlds/new`, { name: 'welt2', seed: '-4172144997902289642', levelType: 'minecraft:flat', structures: false });
    assert.equal(r.status, 200);
    const props = fs.readFileSync(path.join(t.sdir, 'server.properties'), 'utf8');
    assert.match(props, /level-name=welt2/); assert.match(props, /level-seed=-4172144997902289642/); assert.match(props, /level-type=minecraft\\:flat/); assert.match(props, /generate-structures=false/);
    assert.match(props, /max-players=20/, 'other settings untouched');
    r = await t.call('POST', `${S}/worlds/new`, { name: 'world', seed: '' });
    assert.equal(r.status, 409, 'existing folder');
    r = await t.call('POST', `${S}/worlds/new`, { name: '../evil' });
    assert.equal(r.status, 400);
    r = await t.call('POST', `${S}/worlds/new`, { name: 'x', seed: 'a\nb' });
    assert.equal(r.status, 400);
    // activate + delete
    r = await t.call('POST', `${S}/worlds/activate`, { name: 'welt2' });
    assert.equal(r.status, 404, 'no level.dat yet');
    r = await t.call('POST', `${S}/worlds/delete`, { name: 'world' });
    assert.equal(r.status, 200, 'world is no longer active, may be deleted');
    assert.equal(fs.existsSync(path.join(t.sdir, 'world')), false);
    r = await t.call('POST', `${S}/worlds/delete`, { name: 'welt2' });
    assert.equal(r.status, 409, 'welt2 is the active world now');
  } finally { t.close(); }
});

test('worlds: refuses to change anything while the server runs', async () => {
  const t = await setup();
  try {
    t.mock.state.running = true;
    for (const [p, b] of [['worlds/new', { name: 'n' }], ['worlds/activate', { name: 'world' }], ['worlds/delete', { name: 'world' }], ['backups/restore', { id: 'x' }], ['software/install', { kind: 'paper', version: '1.21.4' }]]) {
      const r = await t.call('POST', `${S}/${p}`, b);
      assert.equal(r.status, 409, p);
    }
    const r = await t.raw('PUT', `${S}/worlds/upload?name=zz`, 'x');
    assert.equal(r.status, 409);
    assert.ok(fs.existsSync(path.join(t.sdir, 'world/level.dat')));
  } finally { t.close(); }
});

test('worlds: download is a valid zip; upload (nested folder) imports it and keeps the seed', async (t0) => {
  if (!hasCli('unzip') || !hasCli('zip')) return t0.skip('zip/unzip missing');
  const t = await setup();
  try {
    const res = await fetch(`${t.base}${S}/worlds/download?name=world`);
    assert.equal(res.status, 200);
    const zf = path.join(t.tmp, 'dl.zip');
    fs.writeFileSync(zf, Buffer.from(await res.arrayBuffer()));
    execFileSync('unzip', ['-tqq', zf]);
    assert.ok(execFileSync('unzip', ['-Z1', zf]).toString().includes('world/level.dat'));
    // zip a world nested in an extra folder, as users often do
    const nest = path.join(t.tmp, 'nest'); fs.mkdirSync(path.join(nest, 'Mein Backup'), { recursive: true });
    fs.cpSync(path.join(t.sdir, 'world'), path.join(nest, 'Mein Backup/MeineWelt'), { recursive: true });
    const up = path.join(t.tmp, 'up.zip');
    execFileSync('zip', ['-qr', up, 'Mein Backup'], { cwd: nest });
    let r = await t.raw('PUT', `${S}/worlds/upload?name=importiert&activate=1`, fs.readFileSync(up));
    assert.equal(r.status, 202);
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.seed, '12345');
    assert.ok(fs.readFileSync(path.join(t.sdir, 'importiert/region/r.0.0.mca')).equals(fs.readFileSync(path.join(t.sdir, 'world/region/r.0.0.mca'))));
    assert.match(fs.readFileSync(path.join(t.sdir, 'server.properties'), 'utf8'), /level-name=importiert/);
    // same name again -> refused up front
    r = await t.raw('PUT', `${S}/worlds/upload?name=importiert`, fs.readFileSync(up));
    assert.equal(r.status, 409);
    // a zip without level.dat fails cleanly and leaves nothing behind
    const junk = path.join(t.tmp, 'junk.zip'); fs.writeFileSync(path.join(t.tmp, 'a.txt'), 'x');
    execFileSync('zip', ['-qj', junk, path.join(t.tmp, 'a.txt')]);
    r = await t.raw('PUT', `${S}/worlds/upload?name=nichts`, fs.readFileSync(junk));
    const j2 = await t.waitJob(r.json.job.id);
    assert.equal(j2.status, 'error'); assert.match(j2.error, /level\.dat/);
    assert.equal(fs.existsSync(path.join(t.sdir, 'nichts')), false);
    assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'tmp')), [], 'upload temp file removed');
  } finally { t.close(); }
});

test('backups: stopped server -> backup, restore (with safety backup), download, delete', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', `${S}/backups`, { kind: 'worlds', note: 'vor dem Umbau' });
    assert.equal(r.status, 202);
    let job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    r = await t.call('GET', `${S}/backups`);
    assert.equal(r.json.items.length, 1);
    const b = r.json.items[0];
    assert.equal(b.kind, 'worlds'); assert.equal(b.note, 'vor dem Umbau'); assert.deepEqual(b.worlds, ['world']); assert.equal(b.version, '1.21.4');
    assert.deepEqual(t.mock.state.stdin, [], 'no console commands while stopped');
    // damage the world, then restore
    const mca = path.join(t.sdir, 'world/region/r.0.0.mca');
    const original = fs.readFileSync(mca);
    fs.writeFileSync(mca, 'corrupted'); fs.writeFileSync(path.join(t.sdir, 'world/extra-after-backup.txt'), 'x');
    await new Promise((x) => setTimeout(x, 1100)); // distinct timestamp for the safety backup id
    r = await t.call('POST', `${S}/backups/restore`, { id: b.id });
    assert.equal(r.status, 202);
    job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'done', job.error);
    assert.ok(fs.readFileSync(mca).equals(original), 'world file restored');
    assert.equal(fs.existsSync(path.join(t.sdir, 'world/extra-after-backup.txt')), false, 'old world replaced, not merged');
    r = await t.call('GET', `${S}/backups`);
    assert.equal(r.json.items.length, 2);
    assert.ok(r.json.items.some((i) => /vor Wiederherstellung/.test(i.note)), 'safety backup exists');
    const res = await fetch(`${t.base}${S}/backups/download?id=${b.id}`);
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString() === 'PK');
    r = await t.call('POST', `${S}/backups/delete`, { id: b.id });
    assert.equal(r.status, 200);
    assert.equal((await t.call('POST', `${S}/backups/delete`, { id: '../../x' })).status, 400);
    assert.equal((await t.call('GET', `${S}/backups`)).json.items.length, 1);
  } finally { t.close(); }
});

test('backups: running server -> save-off, save-all flush, wait for log, save-on afterwards', async () => {
  const t = await setup();
  try {
    t.mock.state.running = true;
    const order = [];
    t.mock.state.onStdin = (cmd) => {
      order.push(cmd);
      if (cmd === 'save-all flush') setTimeout(() => fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), '[10:01:00] [Server thread/INFO]: Saved the game\n'), 300);
    };
    const r = await t.call('POST', `${S}/backups`, { kind: 'worlds' });
    const job = await t.waitJob(r.json.job.id, 20000);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(order, ['save-off', 'save-all flush', 'save-on']);
  } finally { t.close(); }
});

test('backups: save-on is sent even when packing fails', async () => {
  const t = await setup();
  try {
    t.mock.state.running = true;
    fs.rmSync(path.join(t.sdir, 'world'), { recursive: true }); // nothing to back up -> job error before any command
    let r = await t.call('POST', `${S}/backups`, { kind: 'worlds' });
    let job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'error'); assert.match(job.error, /keine Welt|Es gibt noch keine Welt/);
    assert.deepEqual(t.mock.state.stdin, []);
    // full backup works without worlds; unreadable file makes packing fail after save-off
    fs.writeFileSync(path.join(t.sdir, 'secret.bin'), 'x'); fs.chmodSync(path.join(t.sdir, 'secret.bin'), 0o000);
    t.mock.state.onStdin = (cmd) => { if (cmd === 'save-all flush') fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), 'Saved the game\n'); };
    r = await t.call('POST', `${S}/backups`, { kind: 'full' });
    job = await t.waitJob(r.json.job.id);
    if (process.getuid && process.getuid() === 0) assert.equal(job.status, 'done'); // root can read it
    else assert.equal(job.status, 'error');
    assert.equal(t.mock.state.stdin[t.mock.state.stdin.length - 1], 'save-on');
  } finally { t.close(); }
});

test('jobs: only one at a time per server', async () => {
  const t = await setup();
  try {
    t.mock.state.running = true; // makes the backup wait on the log, so it stays "running"
    let r = await t.call('POST', `${S}/backups`, { kind: 'worlds' });
    assert.equal(r.status, 202);
    r = await t.call('POST', `${S}/backups`, { kind: 'worlds' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /läuft schon eine Aufgabe/);
    fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), 'Saved the game\n');
  } finally { await new Promise((x) => setTimeout(x, 1200)); t.close(); }
});

async function jarWith(file, entries) {
  const out = fs.createWriteStream(file);
  const z = new zipLib.ZipWriter(out);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-'));
  for (const [n, c] of Object.entries(entries)) { const f = path.join(tmp, n.replace(/\//g, '_')); fs.writeFileSync(f, c); await z.addFile(n, f); }
  await z.finish();
}

test('mods: layout per software, jar metadata, toggle, delete, upload', async () => {
  const t = await setup();
  try {
    // vanilla: nothing to manage
    fs.writeFileSync(path.join(t.sdir, '.blockhaus-software.json'), JSON.stringify({ software: 'vanilla', version: '1.21.4' }));
    let r = await t.call('GET', `${S}/mods`);
    assert.equal(r.json.folder, null); assert.match(r.json.reason, /Vanilla/);
    // fabric
    fs.writeFileSync(path.join(t.sdir, '.blockhaus-software.json'), JSON.stringify({ software: 'fabric', version: '1.21.4' }));
    fs.mkdirSync(path.join(t.sdir, 'mods'));
    await jarWith(path.join(t.sdir, 'mods/sodium.jar'), { 'fabric.mod.json': JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.6.0', description: 'fast' }) });
    await jarWith(path.join(t.sdir, 'mods/neo.jar.disabled'), { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="coolmod"\nversion="2.1"\ndisplayName="Cool Mod"\n' });
    await jarWith(path.join(t.sdir, 'mods/plain.jar'), { 'readme.txt': 'x' });
    fs.writeFileSync(path.join(t.sdir, 'mods/notes.txt'), 'ignored');
    r = await t.call('GET', `${S}/mods`);
    assert.equal(r.json.folder, 'mods'); assert.equal(r.json.kind, 'mod');
    const byFile = Object.fromEntries(r.json.items.map((i) => [i.file, i]));
    assert.equal(byFile['sodium.jar'].name, 'Sodium'); assert.equal(byFile['sodium.jar'].version, '0.6.0'); assert.equal(byFile['sodium.jar'].enabled, true);
    assert.equal(byFile['neo.jar.disabled'].name, 'Cool Mod'); assert.equal(byFile['neo.jar.disabled'].enabled, false);
    assert.equal(byFile['plain.jar'].name, null);
    assert.equal(r.json.items.length, 3);
    r = await t.call('POST', `${S}/mods/toggle`, { file: 'sodium.jar' });
    assert.equal(r.json.file, 'sodium.jar.disabled');
    assert.ok(fs.existsSync(path.join(t.sdir, 'mods/sodium.jar.disabled')));
    assert.equal((await t.call('POST', `${S}/mods/toggle`, { file: '../server.properties' })).status, 400);
    assert.equal((await t.call('POST', `${S}/mods/delete`, { file: '../../x.jar' })).status, 400);
    r = await t.call('POST', `${S}/mods/delete`, { file: 'plain.jar' });
    assert.equal(fs.existsSync(path.join(t.sdir, 'mods/plain.jar')), false);
    r = await t.raw('PUT', `${S}/mods/upload?name=new-mod.jar`, Buffer.from('PK'));
    assert.equal(r.status, 200);
    assert.equal((await t.raw('PUT', `${S}/mods/upload?name=evil.sh`, 'x')).status, 400);
    assert.equal((await t.raw('PUT', `${S}/mods/upload?name=${encodeURIComponent('../x.jar')}`, 'x')).status, 400);
    // paper -> plugins
    fs.writeFileSync(path.join(t.sdir, '.blockhaus-software.json'), JSON.stringify({ software: 'paper', version: '1.21.4' }));
    fs.mkdirSync(path.join(t.sdir, 'plugins'));
    await jarWith(path.join(t.sdir, 'plugins/ess.jar'), { 'plugin.yml': 'name: EssentialsX\nversion: 2.20.1\ndescription: "Essentials"\nmain: x.Y\n' });
    r = await t.call('GET', `${S}/mods`);
    assert.equal(r.json.folder, 'plugins'); assert.equal(r.json.kind, 'plugin');
    assert.equal(r.json.items[0].name, 'EssentialsX'); assert.equal(r.json.items[0].version, '2.20.1'); assert.equal(r.json.items[0].description, 'Essentials');
  } finally { t.close(); }
});

test('inventory: players from playerdata + usercache, real file and live console agree', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', `${S}/inventory/players`);
    assert.deepEqual(r.json.players.map((p) => [p.uuid, p.name]), [[PLAYER_UUID, 'Steve_Bot']]);
    assert.equal(r.json.world, 'world');
    r = await t.call('GET', `${S}/inventory/${PLAYER_UUID}`);
    assert.equal(r.status, 200);
    const sword = r.json.items.find((i) => i.slot === 0);
    assert.equal(sword.id, 'minecraft:diamond_sword'); assert.equal(sword.name, 'Excalibur');
    assert.deepEqual(sword.enchants, [{ id: 'minecraft:sharpness', level: 5 }, { id: 'minecraft:unbreaking', level: 3 }]);
    assert.equal(r.json.items.find((i) => i.slot === 102).id, 'minecraft:netherite_chestplate');
    assert.equal(r.json.items.find((i) => i.slot === -106).id, 'minecraft:shield');
    assert.equal(r.json.name, 'Steve_Bot'); assert.equal(r.json.stats.dimension, 'Oberwelt');
    assert.equal((await t.call('GET', `${S}/inventory/00000000-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await t.call('GET', `${S}/inventory/not-a-uuid`)).status, 404);
    // live: server must run
    assert.equal((await t.call('POST', `${S}/inventory/live`, { name: 'Steve_Bot' })).status, 409);
    t.mock.state.running = true;
    const snbt = fs.readFileSync(path.join(FX, 'snbt-inventory-1.21.4.txt'), 'utf8').trim();
    const line = snbt.slice(snbt.indexOf('Steve_Bot has the following entity data: '));
    t.mock.state.onStdin = (cmd) => {
      if (cmd === 'data get entity Steve_Bot Inventory') fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), `[10:02:00] [Server thread/INFO]: ${line}\n`);
      if (cmd === 'data get entity Steve_Bot EnderItems') fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), '[10:02:01] [Server thread/INFO]: Steve_Bot has the following entity data: [{count: 5, Slot: 0b, id: "minecraft:ender_pearl"}]\n');
      if (cmd === 'data get entity Ghost Inventory') fs.appendFileSync(path.join(t.sdir, 'logs/latest.log'), '[10:02:02] [Server thread/INFO]: No entity was found\n');
    };
    r = await t.call('POST', `${S}/inventory/live`, { name: 'Steve_Bot' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.source, 'live');
    const file = (await t.call('GET', `${S}/inventory/${PLAYER_UUID}`)).json;
    assert.deepEqual(r.json.items, file.items, 'live inventory equals saved inventory');
    assert.equal(r.json.ender[0].id, 'minecraft:ender_pearl'); assert.equal(r.json.ender[0].count, 5);
    r = await t.call('POST', `${S}/inventory/live`, { name: 'Ghost' });
    assert.equal(r.status, 404); assert.match(r.json.error, /nicht online/);
    r = await t.call('POST', `${S}/inventory/live`, { name: 'bad name;stop' });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});

test('inventory: old-format items (tag/Count) are understood too', () => {
  const inv = require('../lib/inventory');
  const it = inv.normalizeItem({ Slot: 4, id: 'minecraft:diamond_pickaxe', Count: 1, tag: { Damage: 12, display: { Name: '{"text":"Pick"}' }, Enchantments: [{ id: 'minecraft:efficiency', lvl: 5 }] } });
  assert.equal(it.name, 'Pick'); assert.equal(it.damage, 12); assert.deepEqual(it.enchants, [{ id: 'minecraft:efficiency', level: 5 }]); assert.equal(it.count, 1);
  const newer = inv.normalizeInventory([], { head: { id: 'minecraft:iron_helmet', count: 1 }, offhand: { id: 'minecraft:shield', count: 1 } });
  assert.deepEqual(newer.map((i) => i.slot).sort((a, b) => a - b), [-106, 103]);
});

test('tools/sha1: hashes what a URL serves; refuses private addresses by default', async () => {
  const t = await setup();
  const payload = crypto.randomBytes(50000);
  const web = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/zip' }); s.end(payload); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${web.address().port}/pack.zip`;
  try {
    let r = await t.call('POST', '/api/tools/sha1', { url });
    assert.equal(r.status, 502); assert.match(r.json.error, /lokalen Netz/);
    process.env.BLOCKHAUS_ALLOW_PRIVATE = '1';
    r = await t.call('POST', '/api/tools/sha1', { url });
    assert.equal(r.status, 200);
    assert.equal(r.json.sha1, crypto.createHash('sha1').update(payload).digest('hex'));
    assert.equal(r.json.size, 50000);
    assert.equal((await t.call('POST', '/api/tools/sha1', { url: 'file:///etc/passwd' })).status, 400);
  } finally { delete process.env.BLOCKHAUS_ALLOW_PRIVATE; web.close(); t.close(); }
});

test('software: kinds list, installed state, Spigot is honestly unsupported', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', `${S}/software`);
    assert.equal(r.json.jar, 'vanilla.jar');
    assert.equal(r.json.installed.software, 'vanilla'); assert.equal(r.json.installed.guessed, true);
    assert.ok(r.json.kinds.find((k) => k.id === 'spigot').unsupported);
    assert.deepEqual(r.json.kinds.filter((k) => !k.unsupported).map((k) => k.id), ['vanilla', 'snapshot', 'paper', 'purpur', 'fabric', 'quilt', 'neoforge', 'forge']);
    r = await t.call('GET', `${S}/software/versions?kind=spigot`);
    assert.equal(r.status, 400);
    r = await t.call('POST', `${S}/software/install`, { kind: 'spigot', version: '1.21.4' });
    assert.equal(r.status, 400);
    r = await t.call('POST', `${S}/software/install`, { kind: 'paper', version: '../../x' });
    const job = await t.waitJob(r.json.job.id);
    assert.equal(job.status, 'error'); assert.match(job.error, /Versionsnummer/);
    assert.equal(fs.readFileSync(path.join(t.sdir, 'vanilla.jar'), 'utf8'), 'jar', 'jar untouched after a failed install');
  } finally { t.close(); }
});

test('software: neoforge build numbers map to Minecraft versions (incl. year-style 26.x)', () => {
  const sw = require('../lib/software');
  assert.equal(sw.neoforgeToMc('21.4.161'), '1.21.4');
  assert.equal(sw.neoforgeToMc('21.1.262'), '1.21.1');
  assert.equal(sw.neoforgeToMc('21.0.5-beta'), '1.21');
  assert.equal(sw.neoforgeToMc('20.2.86'), '1.20.2');
  assert.equal(sw.neoforgeToMc('26.1.2.121'), '26.1.2');
  assert.equal(sw.neoforgeToMc('26.1.0.0-alpha.1+snapshot-1'), '26.1');
  assert.equal(sw.neoforgeToMc('0.25w14craftmine.3-beta'), null);
  assert.ok(sw.cmpVersion('1.21.10', '1.21.9') > 0); assert.ok(sw.cmpVersion('26.1', '1.21.11') > 0); assert.ok(sw.cmpVersion('1.21', '1.21.1') < 0);
});
