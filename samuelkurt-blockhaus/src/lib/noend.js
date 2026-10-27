'use strict';
// "Lock the End": vanilla has no switch for it (the Nether has a game rule since 26.x, the End has nothing). A small data pack in
// <world>/datapacks/blockhaus_noend sends every player who is in the End straight back to their own respawn point (bed, anchor, /spawnpoint) or, without one, the world spawn of the overworld, and
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
const REV = 2; // revision of the pack contents; an installed pack with another one is rewritten (1: world spawn only, 2: own respawn point)
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

/**
 * Known only from the version number when the jar cannot be read (Forge, NeoForge and some launchers keep the vanilla jar
 * somewhere else or not at all). A pack that every game version from 1.21 on accepts: the old fields for 1.21 to 1.21.8
 * (formats 48 to 81) and min_format/max_format for everything newer. Both forms were checked on a 26.3 server (loads without a
 * warning); the old fields are what 1.21.x reads.
 */
const COMPAT = { style: 'compat' };

/** false only for a version that is known to be older than 1.21 (function folders were called functions/ before). */
function canLock(mcVersion) {
  const m = /^1\.(\d+)/.exec(String(mcVersion || ''));
  return !(m && Number(m[1]) < 21);
}

/** The pack format to write: exact from the jar when it can be read, else the compatible one, else null (version too old). */
async function resolveFormat(jarFile, mcVersion) {
  const fmt = jarFile ? await dataFormat(jarFile) : null;
  if (fmt) return fmt;
  return canLock(mcVersion) ? COMPAT : null;
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
  const meta = fmt.style === 'compat'
    ? { pack: { description: DESCRIPTION, pack_format: 48, supported_formats: [48, 81], min_format: 48, max_format: 9999 } }
    : fmt.style === 'minor'
      ? { pack: { description: DESCRIPTION, min_format: fmt.format, max_format: fmt.format } }
      : { pack: { description: DESCRIPTION, pack_format: fmt.format } };
  const [x, y, z] = spawn;
  const T = `${NS}:t`; // command storage for the position read from the player
  const fn = (name, lines) => [`data/${NS}/function/${name}.mcfunction`, lines.join('\n') + '\n'];
  return Object.fromEntries([
    ['pack.mcmeta', JSON.stringify(meta, null, 2) + '\n'],
    ['blockhaus.rev', REV + '\n'],
    ['data/minecraft/tags/function/tick.json', JSON.stringify({ values: [`${NS}:tick`] }) + '\n'],
    fn('tick', [`execute as @a[tag=!${TAG}] at @s if dimension minecraft:the_end run function ${NS}:zurueck`]),
    // Own respawn point first (bed, respawn anchor or /spawnpoint), the world spawn when there is none or it is gone.
    fn('zurueck', [
      `data remove storage ${T} fertig`,
      `data remove storage ${T} r`,
      `execute if data entity @s respawn.pos run function ${NS}:lesen`,
      `execute unless data entity @s respawn.pos if data entity @s SpawnX run function ${NS}:lesen_alt`,
      `execute unless data storage ${T} fertig run execute in minecraft:overworld run tp @s ${x} ${y} ${z}`,
      `title @s actionbar {"text":"${MESSAGE}","color":"red"}`,
    ]),
    // Minecraft 26.x: respawn {pos:[I;x,y,z], dimension, forced}
    fn('lesen', [
      `execute store result storage ${T} r.x int 1 run data get entity @s respawn.pos[0]`,
      `execute store result storage ${T} r.y int 1 run data get entity @s respawn.pos[1]`,
      `execute store result storage ${T} r.z int 1 run data get entity @s respawn.pos[2]`,
      `data modify storage ${T} r.d set value "minecraft:overworld"`,
      `data modify storage ${T} r.d set from entity @s respawn.dimension`,
      `execute unless data storage ${T} r{d:"minecraft:the_end"} run function ${NS}:ziel with storage ${T} r`,
    ]),
    // Minecraft 1.21: SpawnX/SpawnY/SpawnZ, SpawnDimension, SpawnForced
    fn('lesen_alt', [
      `execute store result storage ${T} r.x int 1 run data get entity @s SpawnX`,
      `execute store result storage ${T} r.y int 1 run data get entity @s SpawnY`,
      `execute store result storage ${T} r.z int 1 run data get entity @s SpawnZ`,
      `data modify storage ${T} r.d set value "minecraft:overworld"`,
      `data modify storage ${T} r.d set from entity @s SpawnDimension`,
      `execute unless data storage ${T} r{d:"minecraft:the_end"} run function ${NS}:ziel with storage ${T} r`,
    ]),
    // The chunk of the respawn point is usually not loaded (the player is far away in the End): load it for the check, but only
    // take the ticket away again if an admin had not already set one with /forceload.
    fn('ziel', [
      `$execute store success storage ${T} fest byte 1 run execute in $(d) run forceload query $(x) $(z)`,
      `$execute unless data storage ${T} {fest:1b} in $(d) run forceload add $(x) $(z)`,
      `$execute in $(d) positioned $(x) $(y) $(z) run function ${NS}:pruefen`,
      `$execute unless data storage ${T} {fest:1b} in $(d) run forceload remove $(x) $(z)`,
    ]),
    // Runs at the respawn point. A bed or an anchor must still be there; a point set by /spawnpoint is taken as it is.
    fn('pruefen', [
      `execute if block ~ ~ ~ #minecraft:beds run function ${NS}:auf_block`,
      `execute if block ~ ~ ~ minecraft:respawn_anchor run function ${NS}:auf_block`,
      `execute if data entity @s respawn{forced:1b} run function ${NS}:genau`,
      `execute if data entity @s {SpawnForced:1b} run function ${NS}:genau`,
    ]),
    fn('auf_block', [`tp @s ~ ~1 ~`, `data modify storage ${T} fertig set value 1b`]),
    fn('genau', [`tp @s ~ ~ ~`, `data modify storage ${T} fertig set value 1b`]),
  ]);
}

function isOurs(worldDir) {
  try { return JSON.parse(fs.readFileSync(path.join(folderOf(worldDir), 'pack.mcmeta'), 'utf8')).pack.description === DESCRIPTION; } catch { return false; }
}
const installed = (worldDir) => isOurs(worldDir);
/** An installed pack of an older Blockhaus version (written without the current revision). */
function stale(worldDir) {
  if (!isOurs(worldDir)) return false;
  try { return fs.readFileSync(path.join(folderOf(worldDir), 'blockhaus.rev'), 'utf8').trim() !== String(REV); } catch { return true; }
}

async function install(worldDir, { jarFile, spawn, mcVersion }) {
  const fmt = await resolveFormat(jarFile, mcVersion);
  if (!fmt) throw Object.assign(new Error('Das End lässt sich erst ab Minecraft 1.21 sperren (ältere Versionen nutzen andere Ordnernamen).'), { status: 409 });
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

module.exports = { REV, stale, NS, PACK_ID, TAG, MESSAGE, COMPAT, canLock, resolveFormat, files, dataFormat, worldSpawn, installed, install, remove, folderOf };
