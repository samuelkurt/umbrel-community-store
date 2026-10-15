'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const zipLib = require('../lib/zip');
const nbt = require('../lib/nbt');
const { resolveInside, PathError } = require('../lib/safepath');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lib-'));
const hasCli = (c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } };

function makeTree(root) {
  fs.mkdirSync(path.join(root, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(root, 'world/empty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'world/level.dat'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(root, 'world/region/r.0.0.mca'), Buffer.concat([crypto.randomBytes(100000), Buffer.alloc(300000)]));
  fs.writeFileSync(path.join(root, 'world/unicode-äöü.txt'), 'hallo');
  fs.writeFileSync(path.join(root, 'zero.bin'), '');
}

async function zipTo(file, root, prefix) {
  const out = fs.createWriteStream(file);
  const z = new zipLib.ZipWriter(out);
  await z.addTree(root, prefix);
  await z.finish();
}

test('zip: our writer produces archives the unzip CLI accepts, and our reader round-trips them', async (t) => {
  if (!hasCli('unzip')) return t.skip('unzip not installed');
  const d = tmpdir(); const src = path.join(d, 'src'); makeTree(src);
  const zf = path.join(d, 'a.zip');
  await zipTo(zf, src, 'srv/');
  execFileSync('unzip', ['-tqq', zf]); // throws if corrupt
  const listing = execFileSync('unzip', ['-Z1', zf]).toString().split('\n').filter(Boolean);
  assert.ok(listing.includes('srv/world/level.dat'));
  assert.ok(listing.includes('srv/world/empty/'));
  assert.ok(listing.includes('srv/world/unicode-äöü.txt'));
  const dest = path.join(d, 'out');
  await zipLib.extractZip(zf, dest, { stripPrefix: 'srv/' });
  for (const f of ['world/level.dat', 'world/region/r.0.0.mca', 'world/unicode-äöü.txt', 'zero.bin']) {
    assert.ok(fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(dest, f))), f);
  }
  assert.ok(fs.statSync(path.join(dest, 'world/empty')).isDirectory());
});

test('zip: reader extracts archives made by the zip CLI (incl. stored files)', async (t) => {
  if (!hasCli('zip')) return t.skip('zip not installed');
  const d = tmpdir(); const src = path.join(d, 'src'); makeTree(src);
  const zf = path.join(d, 'b.zip');
  execFileSync('zip', ['-qr', zf, 'world', 'zero.bin'], { cwd: src });
  execFileSync('zip', ['-q0', zf, 'world/level.dat'], { cwd: src }); // stored copy
  const dest = path.join(d, 'out');
  const r = await zipLib.extractZip(zf, dest);
  assert.ok(r.files >= 3);
  assert.ok(fs.readFileSync(path.join(src, 'world/region/r.0.0.mca')).equals(fs.readFileSync(path.join(dest, 'world/region/r.0.0.mca'))));
  assert.ok(fs.readFileSync(path.join(src, 'world/level.dat')).equals(fs.readFileSync(path.join(dest, 'world/level.dat'))));
});

test('zip: zip-slip entries, absolute paths and symlinks never leave the target folder', async (t) => {
  if (!hasCli('python3')) return t.skip('python3 missing');
  const d = tmpdir(); const zf = path.join(d, 'bad.zip');
  execFileSync('python3', ['-c', `
import zipfile
z=zipfile.ZipFile(${JSON.stringify(zf)},'w')
z.writestr('../evil1.txt','x'); z.writestr('/abs-evil.txt','x'); z.writestr('a/../../evil2.txt','x'); z.writestr('..\\\\evil3.txt','x')
z.writestr('ok/fine.txt','fine')
i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=(0o120777<<16); z.writestr(i,'/etc/passwd')
z.close()`]);
  const dest = path.join(d, 'out', 'inner');
  await zipLib.extractZip(zf, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'ok/fine.txt'), 'utf8'), 'fine');
  const all = execFileSync('find', [d, '-type', 'f', '-o', '-type', 'l']).toString();
  assert.ok(!/evil/.test(all), all);
  assert.ok(!fs.existsSync(path.join(dest, 'link')));
});

test('zip: a corrupted archive is detected by CRC', async (t) => {
  if (!hasCli('zip')) return t.skip('zip not installed');
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'f.bin'), Buffer.alloc(2000, 7));
  const zf = path.join(d, 'c.zip');
  execFileSync('zip', ['-q0', zf, 'f.bin'], { cwd: d }); // stored: flipping a data byte keeps it parseable
  const buf = fs.readFileSync(zf); buf[100] ^= 0xff; fs.writeFileSync(zf, buf);
  await assert.rejects(zipLib.extractZip(zf, path.join(d, 'o')), /Prüfsumme/);
});

test('zip: rejects non-zip input', async () => {
  const d = tmpdir(); const f = path.join(d, 'x.zip'); fs.writeFileSync(f, 'not a zip at all, just text'.repeat(5));
  await assert.rejects(zipLib.readEntries(f), /ZIP/);
});

test('safepath: blocks traversal, absolute paths and symlink escapes', () => {
  const d = tmpdir(); const root = path.join(d, 'srv'); fs.mkdirSync(root); fs.mkdirSync(path.join(d, 'secret'));
  fs.writeFileSync(path.join(d, 'secret/x'), 'x');
  fs.symlinkSync(path.join(d, 'secret'), path.join(root, 'link'));
  fs.mkdirSync(path.join(root, 'ok'));
  assert.equal(resolveInside(root, 'ok'), path.join(fs.realpathSync(root), 'ok'));
  assert.equal(resolveInside(root, 'ok/new/file.txt'), path.join(fs.realpathSync(root), 'ok/new/file.txt'));
  assert.equal(resolveInside(root, ''), fs.realpathSync(root));
  for (const bad of ['../secret', '/etc/passwd', 'ok/../../secret', 'link', 'link/x', 'link/new', 'a\0b', 'C:\\x']) {
    assert.throws(() => resolveInside(root, bad), PathError, bad);
  }
});

test('nbt: round trip incl. gzip, negative bytes, 64-bit longs', () => {
  const tree = {
    DataVersion: { t: 'int', v: 4189 },
    Seed: { t: 'long', v: '-4172144997902289642' },
    Small: { t: 'long', v: 42 },
    Name: { t: 'string', v: 'Zöe' },
    Inventory: { t: 'list', of: 'compound', v: [
      { Slot: { t: 'byte', v: 0 }, id: { t: 'string', v: 'minecraft:diamond_sword' }, count: { t: 'int', v: 1 } },
      { Slot: { t: 'byte', v: -106 }, id: { t: 'string', v: 'minecraft:shield' }, count: { t: 'int', v: 1 } },
    ] },
    Pos: { t: 'list', of: 'double', v: [1.5, 64, -3.25] },
    UUID: { t: 'int_array', v: [1, -2, 3, -4] },
  };
  for (const gz of [false, true]) {
    const { name, value } = nbt.parse(nbt.encode('', tree, { gzip: gz }));
    assert.equal(name, '');
    assert.equal(value.DataVersion, 4189);
    assert.equal(value.Seed, '-4172144997902289642');
    assert.equal(value.Small, 42);
    assert.equal(value.Name, 'Zöe');
    assert.equal(value.Inventory[1].Slot, -106);
    assert.deepEqual(value.Pos, [1.5, 64, -3.25]);
    assert.deepEqual(value.UUID, [1, -2, 3, -4]);
  }
  assert.throws(() => nbt.parse(nbt.encode('', tree).subarray(0, 30)), /abgeschnitten/);
});

test('snbt: parses what `data get entity` prints', () => {
  const v = nbt.parseSnbt('[{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}, "minecraft:custom_name": \'"Excalibur"\'}}, {Slot: -106b, id: "minecraft:shield", count: 1}, {Slot: 3b, id: "minecraft:arrow", count: 64, x: [I; 1, -2], d: 1.5d, f: 2.0f, t: true}]');
  assert.equal(v.length, 3);
  assert.equal(v[0].components['minecraft:enchantments'].levels['minecraft:sharpness'], 5);
  assert.equal(v[0].components['minecraft:custom_name'], '"Excalibur"');
  assert.equal(v[1].Slot, -106);
  assert.deepEqual(v[2].x, [1, -2]);
  assert.equal(v[2].d, 1.5);
  assert.equal(v[2].t, true);
  assert.deepEqual(nbt.parseSnbt('[]'), []);
  assert.throws(() => nbt.parseSnbt('[{Slot: 0b,'), /SNBT/);
});
