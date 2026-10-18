'use strict';
// Player inventories: read from <world>/playerdata/<uuid>.dat, or live from the running server
// with `data get entity <name> Inventory` (the console prints SNBT, which we parse).
const fs = require('node:fs');
const path = require('node:path');
const nbt = require('./nbt');
const serverfiles = require('./serverfiles');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function nameMap(dir) {
  const m = new Map();
  for (const f of ['usercache.json', 'whitelist.json', 'ops.json', 'banned-players.json']) {
    const arr = readJsonSafe(path.join(dir, f));
    if (Array.isArray(arr)) for (const e of arr) if (e && e.uuid && e.name) m.set(String(e.uuid).toLowerCase(), e.name);
  }
  return m;
}

function playerdataDir(dir, world) {
  for (const rel of ['playerdata', path.join('players', 'data')]) {
    const p = path.join(dir, world, rel);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

function listPlayers(dir, world) {
  const pd = playerdataDir(dir, world);
  const names = nameMap(dir);
  const out = [];
  if (pd) {
    for (const f of fs.readdirSync(pd)) {
      const m = /^([0-9a-f-]{36})\.dat$/i.exec(f);
      if (!m) continue;
      const uuid = m[1].toLowerCase();
      out.push({ uuid, name: names.get(uuid) || null, mtime: fs.statSync(path.join(pd, f)).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Chat component (JSON string, or NBT compound in newer versions) -> plain text. */
function textOf(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    let s = typeof v.text === 'string' ? v.text : '';
    if (Array.isArray(v.extra)) s += v.extra.map(textOf).join('');
    return s || null;
  }
  const str = String(v);
  try { const j = JSON.parse(str); if (typeof j === 'string') return j; if (j && typeof j === 'object') return textOf(j); } catch { /* plain text */ }
  return str;
}

function enchantsOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((e) => ({ id: String(e.id), level: Number(e.lvl) }));
  const levels = v.levels && typeof v.levels === 'object' ? v.levels : v;
  return Object.entries(levels).filter(([, l]) => typeof l === 'number').map(([id, level]) => ({ id, level }));
}

/** Handles both the component format (1.20.5+) and the old `tag` format. */
function normalizeItem(it) {
  const comp = it.components || {};
  const tag = it.tag || {};
  const count = it.count !== undefined ? it.count : (it.Count !== undefined ? it.Count : 1);
  const ench = enchantsOf(comp['minecraft:enchantments'] || tag.Enchantments);
  const stored = enchantsOf(comp['minecraft:stored_enchantments'] || tag.StoredEnchantments);
  const lore = comp['minecraft:lore'] || (tag.display && tag.display.Lore) || [];
  const damage = comp['minecraft:damage'] !== undefined ? comp['minecraft:damage'] : tag.Damage;
  return {
    slot: it.Slot !== undefined ? Number(it.Slot) : null,
    id: String(it.id || ''),
    count: Number(count),
    name: textOf(comp['minecraft:custom_name'] !== undefined ? comp['minecraft:custom_name'] : (tag.display && tag.display.Name)),
    enchants: ench,
    storedEnchants: stored,
    damage: typeof damage === 'number' ? damage : null,
    lore: (Array.isArray(lore) ? lore : []).map(textOf).filter(Boolean),
    container: Array.isArray(comp['minecraft:container']) ? comp['minecraft:container'].length : null,
  };
}

const EQUIP_SLOT = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };

function normalizeInventory(inv, equipment) {
  const items = (Array.isArray(inv) ? inv : []).map(normalizeItem);
  if (equipment && typeof equipment === 'object') {
    for (const [k, slot] of Object.entries(EQUIP_SLOT)) {
      if (equipment[k] && equipment[k].id && !items.some((i) => i.slot === slot)) items.push({ ...normalizeItem(equipment[k]), slot });
    }
  }
  return items;
}

const DIM_NAMES = { 'minecraft:overworld': 'Oberwelt', 'minecraft:the_nether': 'Nether', 'minecraft:the_end': 'Ende' };
const MODES = ['Überleben', 'Kreativ', 'Abenteuer', 'Zuschauer'];

function readInventory(dir, world, uuid) {
  if (!UUID_RE.test(uuid)) throw Object.assign(new Error('Ungültige Spieler-ID.'), { status: 400 });
  const pd = playerdataDir(dir, world);
  if (!pd) throw Object.assign(new Error(`In der Welt „${world}“ gibt es noch keine Spielerdaten.`), { status: 404 });
  const file = path.join(pd, uuid.toLowerCase() + '.dat');
  let data;
  try { data = nbt.parse(fs.readFileSync(file)).value; }
  catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('Für diesen Spieler gibt es keine Daten in dieser Welt.'), { status: 404 });
    throw Object.assign(new Error('Spielerdatei nicht lesbar: ' + e.message), { status: 500 });
  }
  const names = nameMap(dir);
  return {
    uuid: uuid.toLowerCase(),
    name: names.get(uuid.toLowerCase()) || null,
    source: 'file',
    savedAt: fs.statSync(file).mtimeMs,
    items: normalizeInventory(data.Inventory, data.equipment),
    ender: normalizeInventory(data.EnderItems),
    stats: {
      health: typeof data.Health === 'number' ? Math.round(data.Health * 10) / 10 : null,
      food: data.foodLevel !== undefined ? data.foodLevel : null,
      xpLevel: data.XpLevel !== undefined ? data.XpLevel : null,
      gameMode: data.playerGameType !== undefined ? MODES[data.playerGameType] || String(data.playerGameType) : null,
      dimension: data.Dimension ? (DIM_NAMES[data.Dimension] || String(data.Dimension)) : null,
      pos: Array.isArray(data.Pos) ? data.Pos.map((n) => Math.round(n)) : null,
    },
  };
}

/**
 * Ask the running server. `sendCommand(cmd)` writes to its console; the answer is read from latest.log.
 * Returns the same shape as readInventory (source: 'live').
 */
async function liveInventory({ dir, name, sendCommand, timeoutMs = 6000 }) {
  if (!/^[.A-Za-z0-9_]{1,17}$/.test(name)) throw Object.assign(new Error('Ungültiger Spielername.'), { status: 400 });
  async function ask(path_) {
    const from = serverfiles.logSize(dir);
    await sendCommand(`data get entity ${name} ${path_}`);
    const t0 = Date.now();
    const marker = `${name} has the following entity data: `;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(250);
      const text = serverfiles.readLogFrom(dir, from);
      if (/No entity was found/.test(text)) throw Object.assign(new Error(`${name} ist gerade nicht online.`), { status: 404 });
      const i = text.indexOf(marker);
      if (i >= 0) {
        const line = text.slice(i + marker.length).split('\n')[0];
        try { return nbt.parseSnbt(line.trim()); }
        catch (e) { throw Object.assign(new Error('Die Antwort des Servers ließ sich nicht lesen: ' + e.message), { status: 502 }); }
      }
    }
    throw Object.assign(new Error('Der Server hat nicht rechtzeitig geantwortet.'), { status: 504 });
  }
  const inv = await ask('Inventory');
  const ender = await ask('EnderItems');
  return { uuid: null, name, source: 'live', savedAt: Date.now(), items: normalizeInventory(inv), ender: normalizeInventory(ender), stats: {} };
}

module.exports = { listPlayers, readInventory, liveInventory, normalizeItem, normalizeInventory, nameMap, playerdataDir, textOf };
