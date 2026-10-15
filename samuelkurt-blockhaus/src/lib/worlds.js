'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const nbt = require('./nbt');
const zipLib = require('./zip');
const { chownLike } = require('./fsutil');

const WORLD_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const GAME_TYPES = ['Überleben', 'Kreativ', 'Abenteuer', 'Zuschauer'];

async function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) stack.push(p);
      else if (it.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

/** Read what we can from a world's level.dat. Never throws; `error` is set if the file is unreadable. */
function readLevel(worldDir) {
  const out = { seed: null, version: null, gameType: null, hardcore: null, lastPlayed: null, levelName: null, error: null };
  let data;
  try { data = nbt.parse(fs.readFileSync(path.join(worldDir, 'level.dat'))).value.Data || {}; }
  catch (e) { out.error = e.message; return out; }
  const wgs = data.WorldGenSettings;
  if (wgs && wgs.seed !== undefined) out.seed = String(wgs.seed);
  else if (data.RandomSeed !== undefined) out.seed = String(data.RandomSeed);
  if (out.seed === null) {
    // newer versions may keep the seed in a separate data file (shape not verified for those versions)
    try {
      const w = nbt.parse(fs.readFileSync(path.join(worldDir, 'data', 'minecraft', 'world_gen_settings.dat'))).value;
      const d = w.data || w;
      if (d.seed !== undefined) out.seed = String(d.seed);
    } catch { /* not there */ }
  }
  out.version = data.Version && data.Version.Name ? data.Version.Name : null;
  out.gameType = data.GameType !== undefined ? GAME_TYPES[data.GameType] || String(data.GameType) : null;
  out.hardcore = !!data.hardcore;
  out.lastPlayed = typeof data.LastPlayed === 'number' ? data.LastPlayed : (data.LastPlayed ? Number(data.LastPlayed) : null);
  out.levelName = data.LevelName || null;
  return out;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function companionsOf(dir, name) {
  return [`${name}_nether`, `${name}_the_end`].filter((n) => isDir(path.join(dir, n)));
}

async function listWorlds(dir, activeName) {
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'level.dat')))
    .map((e) => e.name).sort();
  const out = [];
  for (const name of names) {
    const wd = path.join(dir, name);
    const lv = readLevel(wd);
    const companions = companionsOf(dir, name);
    let size = await dirSize(wd);
    for (const c of companions) size += await dirSize(path.join(dir, c));
    out.push({ name, active: name === activeName, size, companions, ...lv });
  }
  return out;
}

function checkName(name) {
  if (!WORLD_NAME_RE.test(String(name || ''))) {
    const e = new Error('Ungültiger Weltname (erlaubt: Buchstaben, Zahlen, _ . - , höchstens 64 Zeichen).');
    e.status = 400;
    throw e;
  }
  return String(name);
}

async function deleteWorld(dir, name) {
  checkName(name);
  const wd = path.join(dir, name);
  if (!fs.existsSync(path.join(wd, 'level.dat'))) { const e = new Error('Diese Welt gibt es nicht.'); e.status = 404; throw e; }
  for (const c of companionsOf(dir, name)) await fsp.rm(path.join(dir, c), { recursive: true, force: true });
  await fsp.rm(wd, { recursive: true, force: true });
}

/** Stream the world (and Paper-style nether/end folders) as one ZIP into `out`. */
async function streamWorldZip(dir, name, out, onFile) {
  checkName(name);
  const wd = path.join(dir, name);
  if (!fs.existsSync(path.join(wd, 'level.dat'))) { const e = new Error('Diese Welt gibt es nicht.'); e.status = 404; throw e; }
  const z = new zipLib.ZipWriter(out);
  z.onFile = onFile || null;
  await z.addDir(name + '/');
  await z.addTree(wd, name + '/', { filter: (rel) => rel !== 'session.lock' });
  for (const c of companionsOf(dir, name)) {
    await z.addDir(c + '/');
    await z.addTree(path.join(dir, c), c + '/', { filter: (rel) => rel !== 'session.lock' });
  }
  await z.finish();
}

/** Where is level.dat inside an uploaded ZIP? Shallowest wins. Returns the folder prefix ('' or 'a/b/'). */
async function findWorldPrefix(zipFile) {
  const entries = await zipLib.readEntries(zipFile);
  let best = null;
  for (const e of entries) {
    const n = zipLib.safeName(e.name);
    if (!n || e.dir) continue;
    if (n === 'level.dat' || n.endsWith('/level.dat')) {
      const prefix = n.slice(0, n.length - 'level.dat'.length);
      const depth = prefix.split('/').length;
      if (!best || depth < best.depth) best = { prefix, depth };
    }
  }
  if (!best) throw new Error('In diesem ZIP wurde keine level.dat gefunden. Es ist wohl keine Minecraft-Welt.');
  return best.prefix;
}

async function importWorldZip(dir, zipFile, name, { onFile } = {}) {
  checkName(name);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) { const e = new Error(`Es gibt schon einen Ordner „${name}“. Wähle einen anderen Namen oder lösche die alte Welt zuerst.`); e.status = 409; throw e; }
  const prefix = await findWorldPrefix(zipFile);
  const chown = chownLike(dir);
  try {
    const r = await zipLib.extractZip(zipFile, target, { stripPrefix: prefix, onFile, chown });
    chown(target);
    return { files: r.files, level: readLevel(target) };
  } catch (e) {
    await fsp.rm(target, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { WORLD_NAME_RE, readLevel, listWorlds, deleteWorld, streamWorldZip, importWorldZip, findWorldPrefix, checkName, dirSize, companionsOf };
