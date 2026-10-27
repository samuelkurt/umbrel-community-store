'use strict';
// "Lock the End": vanilla has no switch for it (the Nether has a game rule since 26.x, the End has nothing). A small data pack in
// <world>/datapacks/blockhaus_noend sends every player who is in the End straight back to the world spawn of the overworld, and
// shows an action-bar message. Nothing runs in Java; the pack only runs one command per tick for the players in the End.
// Players with the tag `end_erlaubt` (/tag <name> add end_erlaubt) may stay, so an admin can still look at the End.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const nbt = require('./nbt');
const zip = require('./zip');
const { writeFileKeepOwner, chownLike } = require('./fsutil');

const NS = 'blockhaus_noend';
const PACK_ID = `file/${NS}`;
const TAG = 'end_erlaubt';
const DESCRIPTION = 'Blockhaus: sperrt das End';
const MESSAGE = 'Das End ist auf diesem Server gesperrt.';
const FIRST_FUNCTION_FORMAT = 48; // data pack format of 1.21: folders are called function/, before that functions/

const folderOf = (worldDir) => path.join(worldDir, 'datapacks', NS);

/** The data pack format of the server jar (version.json). Null when it cannot be read. */
async function dataFormat(jarFile) {
  try {
    const es = await zip.readEntries(jarFile);
    const e = es.find((x) => x.name === 'version.json');
    if (!e) return null;
    const j = JSON.parse((await zip.readEntryBuffer(jarFile, e, 64 * 1024)).toString('utf8'));
    const pv = j.pack_version || {};
    if (pv.data_major !== undefined) return { style: 'minor', format: Number(pv.data_major), minor: Number(pv.data_minor || 0), mc: j.id || j.name || null };
    if (pv.data !== undefined) return { style: 'legacy', format: Number(pv.data), minor: 0, mc: j.id || j.name || null };
  } catch { /* not a vanilla-style jar */ }
  return null;
}

/** World spawn in the overworld from level.dat (26.x: Data.spawn.pos, before: SpawnX/Y/Z). */
function worldSpawn(worldDir) {
  try {
    const d = nbt.parse(fs.readFileSync(path.join(worldDir, 'level.dat'))).value.Data || {};
    if (d.spawn && Array.isArray(d.spawn.pos) && d.spawn.pos.length === 3) return d.spawn.pos.map((n) => Math.round(Number(n)));
    if (Number.isFinite(d.SpawnX) && Number.isFinite(d.SpawnY) && Number.isFinite(d.SpawnZ)) return [d.SpawnX, d.SpawnY, d.SpawnZ];
  } catch { /* new world */ }
  return null;
}

/** The files of the pack, as { relative path: text }. Pure, so it is easy to test. */
function files({ fmt, spawn }) {
  if (!fmt) throw Object.assign(new Error('Die Datenpaket-Version des Servers ließ sich nicht aus der server.jar lesen.'), { status: 409 });
  if (fmt.style === 'legacy' && fmt.format < FIRST_FUNCTION_FORMAT) throw Object.assign(new Error('Das End lässt sich erst ab Minecraft 1.21 sperren (ältere Versionen nutzen andere Ordnernamen).'), { status: 409 });
  if (!Array.isArray(spawn) || spawn.length !== 3 || !spawn.every(Number.isFinite)) throw Object.assign(new Error('Der Welt-Spawn ist noch nicht bekannt. Starte den Server einmal, damit die Welt erzeugt wird.'), { status: 409 });
  const meta = fmt.style === 'minor'
    ? { pack: { description: DESCRIPTION, min_format: fmt.format, max_format: fmt.format } }
    : { pack: { description: DESCRIPTION, pack_format: fmt.format } };
  const [x, y, z] = spawn;
  return {
    'pack.mcmeta': JSON.stringify(meta, null, 2) + '\n',
    'data/minecraft/tags/function/tick.json': JSON.stringify({ values: [`${NS}:tick`] }) + '\n',
    [`data/${NS}/function/tick.mcfunction`]: `execute as @a[tag=!${TAG}] at @s if dimension minecraft:the_end run function ${NS}:zurueck\n`,
    [`data/${NS}/function/zurueck.mcfunction`]: `execute in minecraft:overworld run tp @s ${x} ${y} ${z}\ntitle @s actionbar {"text":"${MESSAGE}","color":"red"}\n`,
  };
}

function isOurs(worldDir) {
  try { return JSON.parse(fs.readFileSync(path.join(folderOf(worldDir), 'pack.mcmeta'), 'utf8')).pack.description === DESCRIPTION; } catch { return false; }
}
const installed = (worldDir) => isOurs(worldDir);

async function install(worldDir, { jarFile, spawn }) {
  const fmt = await dataFormat(jarFile);
  const f = files({ fmt, spawn: spawn || worldSpawn(worldDir) });
  const root = folderOf(worldDir);
  if (fs.existsSync(root) && !isOurs(worldDir)) throw Object.assign(new Error(`Im Ordner datapacks gibt es schon „${NS}“, aber nicht von Blockhaus. Es wird nicht überschrieben.`), { status: 409 });
  const own = chownLike(path.join(worldDir, 'level.dat'));
  for (const [rel, text] of Object.entries(f)) {
    const file = path.join(root, ...rel.split('/'));
    let d = path.dirname(file); const made = [];
    while (!fs.existsSync(d)) { made.unshift(d); d = path.dirname(d); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const m of made) own(m);
    writeFileKeepOwner(file, text);
  }
  return { fmt, spawn: spawn || worldSpawn(worldDir) };
}

async function remove(worldDir) {
  if (!fs.existsSync(folderOf(worldDir))) return false;
  if (!isOurs(worldDir)) throw Object.assign(new Error('Der Ordner stammt nicht von Blockhaus und bleibt, wie er ist.'), { status: 409 });
  await fsp.rm(folderOf(worldDir), { recursive: true, force: true });
  return true;
}

module.exports = { NS, PACK_ID, TAG, MESSAGE, files, dataFormat, worldSpawn, installed, install, remove, folderOf };
