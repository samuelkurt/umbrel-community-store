'use strict';
// Voice chat config, the curated "Schneller" mod list and the check of a hand-entered texture pack address.
// A fake Modrinth server stands in for the real one (the module reads BLOCKHAUS_MODRINTH when it loads).
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.BLOCKHAUS_ALLOW_PRIVATE = '1'; // the test servers are on 127.0.0.1

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-vm-'));

// ---- fake Modrinth -----------------------------------------------------------------------------
// projects: slug -> {title, server, client}; versions: slug -> loaders that have a build for 26.3
const PROJECTS = {
  lithium: { title: 'Lithium', loaders: ['neoforge'] },
  'ferrite-core': { title: 'FerriteCore', loaders: ['forge', 'neoforge'] },
  clumps: { title: 'Clumps', loaders: ['neoforge'] },
  'ly-clumps': { title: 'Clumps', loaders: ['forge'], server: 'required', client: 'optional' },
  chunky: { title: 'Chunky', loaders: ['forge'], client: 'optional' },
  spark: { title: 'spark', loaders: ['forge'], beta: true },
};
function fakeModrinth() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/projects') {
      const ids = JSON.parse(u.searchParams.get('ids'));
      return json(ids.filter((s) => PROJECTS[s]).map((s) => ({ id: 'id-' + s, slug: s, title: PROJECTS[s].title, server_side: PROJECTS[s].server || 'optional', client_side: PROJECTS[s].client || 'unsupported', icon_url: null })));
    }
    const m = /^\/project\/([^/]+)\/version$/.exec(u.pathname);
    if (m) {
      const p = PROJECTS[m[1]];
      const loaders = JSON.parse(u.searchParams.get('loaders') || '[]');
      const mc = JSON.parse(u.searchParams.get('game_versions') || '[]');
      if (!p || (mc.length && !mc.includes('26.3')) || !loaders.some((l) => p.loaders.includes(l))) return json([]);
      return json([{ version_number: '1.0.0', version_type: p.beta ? 'beta' : 'release', files: [], dependencies: [] }]);
    }
    res.writeHead(404); res.end();
  });
}

// Set the fake before the app code loads.
let modrinth; let modrinthPort;
test.before(async () => {
  modrinth = fakeModrinth(); modrinthPort = await listen(modrinth);
  process.env.BLOCKHAUS_MODRINTH = `http://127.0.0.1:${modrinthPort}`;
});
test.after(() => { modrinth.close(); modrinth.closeAllConnections?.(); });

async function setup({ software = 'forge', version = '26.3' } = {}) {
  const { createApp } = require('../server');
  const { createMockCrafty } = require('./mock-crafty');
  const zip = require('../lib/zip');
  const tmp = tmpdir(); const serversDir = path.join(tmp, 'servers'); const sdir = path.join(serversDir, 'uuid-1');
  fs.mkdirSync(path.join(sdir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'server.properties'), 'level-name=world\nmax-players=20\n');
  fs.writeFileSync(path.join(sdir, '.blockhaus-software.json'), JSON.stringify({ software, version, build: null }));
  // a vanilla-style jar so the pack format of "26.3" is known
  const src = path.join(tmp, 'jarsrc'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'version.json'), JSON.stringify({ id: '26.3', pack_version: { resource_major: 97, resource_minor: 1, data_major: 121, data_minor: 0 } }));
  const w = new zip.ZipWriter(fs.createWriteStream(path.join(sdir, 'vanilla.jar'))); await w.addTree(src, ''); await w.finish();
  const mock = createMockCrafty(); await listen(mock.server);
  const app = createApp({ dataDir: path.join(tmp, 'data'), serversDir, settleMs: 5 });
  const port = await listen(app);
  app.config.update({ craftyUrl: `http://127.0.0.1:${mock.server.address().port}`, apiToken: 'tok123' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const waitJob = async (id) => {
    for (let i = 0; i < 200; i++) {
      const r = await call('GET', `/api/servers/uuid-1/jobs/${id}`);
      if (r.json.status !== 'running') return r.json;
      await new Promise((x) => setTimeout(x, 50));
    }
    throw new Error('job timeout');
  };
  const close = () => { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); };
  return { tmp, sdir, mock, call, waitJob, close };
}
const S = '/api/servers/uuid-1';

test('voice chat: reads the config and the log, writes port and voice_host, keeps the rest', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', S + '/voicechat');
    assert.equal(r.status, 200); assert.equal(r.json.config, null); assert.deepEqual(r.json.jars, []);
    r = await t.call('POST', S + '/voicechat', { port: 19132 });
    assert.equal(r.status, 404); assert.match(r.json.error, /noch nicht/);

    fs.writeFileSync(path.join(t.sdir, 'mods', 'voicechat-forge-26.3-2.6.24.jar'), 'x');
    fs.mkdirSync(path.join(t.sdir, 'config', 'voicechat'), { recursive: true });
    const cfg = path.join(t.sdir, 'config', 'voicechat', 'voicechat-server.properties');
    const orig = '# The port number to use\nport=24454\n# bind\nbind_address=\n# host\nvoice_host=\nkeep_alive=1000\n';
    fs.writeFileSync(cfg, orig);
    fs.mkdirSync(path.join(t.sdir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(t.sdir, 'logs', 'latest.log'), '[18Oct2026 16:16:45.157] [VoiceChatServerThread/INFO] [voicechat/]: [voicechat] Voice chat server started at port 24454\n');

    r = await t.call('GET', S + '/voicechat');
    assert.equal(r.json.config, 'config/voicechat/voicechat-server.properties');
    assert.equal(r.json.port, '24454'); assert.equal(r.json.voiceHost, ''); assert.equal(r.json.log.startedPort, 24454);
    assert.equal(r.json.jars.length, 1); assert.equal(r.json.suggestedPort, 19132);

    r = await t.call('POST', S + '/voicechat', { port: 19132, voice_host: ' abc.joinmc.link:12345 ' });
    assert.equal(r.status, 200); assert.equal(r.json.restartNeeded, false);
    const now = fs.readFileSync(cfg, 'utf8');
    assert.equal(now, '# The port number to use\nport=19132\n# bind\nbind_address=\n# host\nvoice_host=abc.joinmc.link:12345\nkeep_alive=1000\n');
    assert.equal(fs.readFileSync(cfg + '.blockhaus.bak', 'utf8'), orig);

    // only voice_host changed, running server -> restart hint
    t.mock.state.running = true;
    r = await t.call('POST', S + '/voicechat', { voice_host: '' });
    assert.equal(r.status, 200); assert.equal(r.json.restartNeeded, true);
    assert.match(fs.readFileSync(cfg, 'utf8'), /port=19132\n[\s\S]*voice_host=\nkeep_alive/);

    for (const bad of [{ port: 0 }, { port: 70000 }, { port: 'abc' }, { voice_host: 'http://x.y' }, { voice_host: 'a b' }, { voice_host: 'x.y:99999' }, { voice_host: 'x.y/z' }]) {
      r = await t.call('POST', S + '/voicechat', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    // -1 is allowed (use the Minecraft port)
    r = await t.call('POST', S + '/voicechat', { port: -1 });
    assert.equal(r.status, 200); assert.match(fs.readFileSync(cfg, 'utf8'), /^port=-1$/m);
  } finally { t.close(); }
});

test('mods/recommended: only what exists for this loader and version, with a NeoForge hint', async () => {
  const t = await setup({ software: 'forge' });
  try {
    fs.writeFileSync(path.join(t.sdir, 'mods', 'ferritecore-9.0.0-forge.jar'), 'x');
    const r = await t.call('GET', S + '/mods/recommended');
    assert.equal(r.status, 200, r.text);
    const by = Object.fromEntries(r.json.items.map((x) => [x.slug, x]));
    assert.deepEqual(Object.keys(by).sort(), ['chunky', 'ferrite-core', 'ly-clumps', 'spark']);
    assert.equal(by['ferrite-core'].installed, true, 'detected from the jar name');
    assert.equal(by.chunky.installed, false);
    assert.equal(by['ly-clumps'].client, 'optional'); assert.equal(by.chunky.client, 'optional'); assert.equal(by.spark.versionType, 'beta');
    assert.ok(r.json.missing.includes('Lithium'));
    assert.deepEqual(r.json.alt, { loader: 'neoforge', titles: ['Lithium'] });
    assert.equal(r.json.software, 'forge'); assert.equal(r.json.mcVersion, '26.3');
  } finally { t.close(); }
});

test('mods/recommended: wrong Minecraft version -> nothing; vanilla -> clear error', async () => {
  let t = await setup({ software: 'forge', version: '1.20.1' });
  try {
    const r = await t.call('GET', S + '/mods/recommended');
    assert.equal(r.status, 200); assert.deepEqual(r.json.items, []);
  } finally { t.close(); }
  t = await setup({ software: 'vanilla' });
  try {
    const r = await t.call('GET', S + '/mods/recommended');
    assert.equal(r.status, 400); assert.match(r.json.error, /Vanilla/);
  } finally { t.close(); }
});

test('packs/probe + import-current: says why a hand-entered pack address is ignored', async () => {
  const t = await setup();
  const zip = require('../lib/zip');
  const mk = async (files) => {
    const dir = tmpdir(); const src = path.join(dir, 'src'); fs.mkdirSync(src);
    for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true }); fs.writeFileSync(path.join(src, n), c); }
    const out = path.join(dir, 'x.zip'); const w = new zip.ZipWriter(fs.createWriteStream(out)); await w.addTree(src, ''); await w.finish();
    return fs.readFileSync(out);
  };
  const mc = (pack) => JSON.stringify({ pack: { description: 'T', ...pack } });
  const files = {
    '/good.zip': await mk({ 'pack.mcmeta': mc({ min_format: [97, 1], max_format: [97, 1] }), 'assets/minecraft/textures/block/stone.png': 'a' }),
    '/nested.zip': await mk({ 'My Pack/pack.mcmeta': mc({ pack_format: 46 }), 'My Pack/assets/minecraft/textures/block/stone.png': 'a' }),
    '/nodesc.zip': await mk({ 'pack.mcmeta': JSON.stringify({ pack: { min_format: [97, 1], max_format: [97, 1] } }), 'assets/minecraft/x.png': 'a' }),
  };
  const web = http.createServer((req, res) => {
    if (files[req.url]) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(files[req.url]); }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Download</html>'); }
    res.writeHead(404); res.end();
  });
  const wp = await listen(web); const url = (p) => `http://127.0.0.1:${wp}${p}`;
  const setProps = (u, sha) => fs.writeFileSync(path.join(t.sdir, 'server.properties'), `level-name=world\nresource-pack=${u.replace(/:/g, '\\:')}\nresource-pack-sha1=${sha}\nresource-pack-id=\n`);
  const probe = async () => { const r = await t.call('POST', S + '/packs/probe', {}); assert.equal(r.status, 202, r.text); return (await t.waitJob(r.json.job.id)).result; };
  const lv = (x) => x.findings.map((f) => f.level + ':' + f.text);
  try {
    // nothing set
    let r = await t.call('POST', S + '/packs/probe', {});
    assert.equal(r.status, 409);
    // GET shows the manual address
    setProps(url('/good.zip'), sha1(files['/good.zip']));
    r = await t.call('GET', S + '/packs');
    assert.equal(r.json.current.url, url('/good.zip')); assert.equal(r.json.current.id, '');

    let x = await probe();
    assert.ok(!x.findings.some((f) => f.level === 'err'), lv(x).join('\n'));
    assert.ok(x.findings.some((f) => f.level === 'ok' && /Prüfsumme/.test(f.text)));
    assert.equal(x.sha1, sha1(files['/good.zip']));

    setProps(url('/good.zip'), 'a'.repeat(40));
    x = await probe();
    assert.ok(x.findings.some((f) => f.level === 'err' && /passt nicht zur Datei/.test(f.text)), lv(x).join('\n'));

    setProps(url('/good.zip'), '');
    x = await probe();
    assert.ok(x.findings.some((f) => f.level === 'warn' && /keine Prüfsumme/.test(f.text)));

    setProps(url('/nested.zip'), sha1(files['/nested.zip']));
    x = await probe();
    assert.ok(x.findings.some((f) => f.level === 'err' && /Unterordner/.test(f.text)), lv(x).join('\n'));
    assert.equal(x.importable, true);

    setProps(url('/nodesc.zip'), sha1(files['/nodesc.zip']));
    x = await probe();
    assert.ok(x.findings.some((f) => f.level === 'err' && /description/.test(f.text)), lv(x).join('\n'));

    setProps(url('/page'), '');
    x = await probe();
    assert.ok(x.findings.some((f) => f.level === 'err' && /Webseite/.test(f.text)), lv(x).join('\n'));

    setProps(url('/missing.zip'), '');
    x = await probe();
    assert.match(x.error, /404/);

    // import the nested one: it lands in the library repaired
    setProps(url('/nested.zip'), sha1(files['/nested.zip']));
    r = await t.call('POST', S + '/packs/import-current', {});
    assert.equal(r.status, 202);
    const fin = await t.waitJob(r.json.job.id);
    assert.equal(fin.status, 'done', JSON.stringify(fin));
    assert.equal(fin.result.pack.name, 'nested');
    assert.equal(fin.result.pack.repaired, true);
    r = await t.call('GET', S + '/packs');
    assert.equal(r.json.packs.length, 1); assert.equal(r.json.packs[0].repaired, true);
    // no temp files left behind
    const lib = path.join(t.tmp, 'data', 'packs', 'uuid-1', 'lib');
    assert.deepEqual(fs.readdirSync(lib).filter((n) => n.startsWith('.')), []);
  } finally { web.close(); web.closeAllConnections?.(); t.close(); }
});
