'use strict';
// Whitelist / operators / bans.
// Server stopped  -> edit the JSON files directly.
// Server running  -> send console commands (the server holds these lists in memory and would
//                    overwrite file edits on its next save).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileKeepOwner } = require('./fsutil');
const { request } = require('./http');

const NAME_RE = /^[.A-Za-z0-9_]{1,17}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,39}$/;

const LISTS = {
  whitelist: { file: 'whitelist.json', keyField: 'name', kind: 'player' },
  ops: { file: 'ops.json', keyField: 'name', kind: 'player' },
  'banned-players': { file: 'banned-players.json', keyField: 'name', kind: 'player' },
  'banned-ips': { file: 'banned-ips.json', keyField: 'ip', kind: 'ip' },
};

function isIp(s) { return IPV4_RE.test(s) || (s.includes(':') && IPV6_RE.test(s)); }

function listFile(dir, list) { return path.join(dir, LISTS[list].file); }

function readList(dir, list) {
  if (!LISTS[list]) throw new Error('Unbekannte Liste: ' + list);
  try {
    const v = JSON.parse(fs.readFileSync(listFile(dir, list), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`${LISTS[list].file} konnte nicht gelesen werden (${e.message}).`);
  }
}

function writeList(dir, list, entries) {
  writeFileKeepOwner(listFile(dir, list), JSON.stringify(entries, null, 2) + '\n');
}

function dashUuid(hex) {
  const h = hex.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID a cracked ("offline-mode") server assigns: MD5 of "OfflinePlayer:<name>", version 3. */
function offlineUuid(name) {
  const b = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  return dashUuid(b.toString('hex'));
}

/** Look a name up at Mojang. Returns { uuid, name } or null if there is no such account. */
async function mojangLookup(name) {
  const res = await request('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), { timeout: 8000 });
  if (res.status === 204 || res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Mojang-Abfrage fehlgeschlagen (HTTP ${res.status}).`);
  const j = JSON.parse(res.body);
  return { uuid: dashUuid(j.id), name: j.name };
}

const nowStamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
};

function normalizeKey(list, key) {
  const k = String(key || '').trim();
  if (LISTS[list].kind === 'ip') {
    if (!isIp(k)) throw new Error('Das ist keine gültige IP-Adresse.');
  } else if (!NAME_RE.test(k)) {
    throw new Error('Ungültiger Spielername (erlaubt: Buchstaben, Zahlen, _ , 1–16 Zeichen).');
  }
  return k;
}

/** Console commands for an add / remove on a running server. */
function commandFor(list, action, key) {
  const add = action === 'add';
  switch (list) {
    case 'whitelist': return `whitelist ${add ? 'add' : 'remove'} ${key}`;
    case 'ops': return `${add ? 'op' : 'deop'} ${key}`;
    case 'banned-players': return `${add ? 'ban' : 'pardon'} ${key}`;
    case 'banned-ips': return `${add ? 'ban-ip' : 'pardon-ip'} ${key}`;
    default: throw new Error('Unbekannte Liste');
  }
}

/**
 * Add/remove without the server running. `onlineMode` decides how a UUID is determined.
 * `lookup` is injectable for tests.
 */
async function editOffline(dir, list, action, key, { onlineMode = true, lookup = mojangLookup } = {}) {
  const spec = LISTS[list];
  const entries = readList(dir, list);
  const idx = entries.findIndex((e) => String(e[spec.keyField]).toLowerCase() === key.toLowerCase());
  if (action === 'remove') {
    if (idx >= 0) entries.splice(idx, 1);
    writeList(dir, list, entries);
    return entries;
  }
  if (idx >= 0) return entries; // already in the list
  if (spec.kind === 'ip') {
    entries.push({ ip: key, created: nowStamp(), source: 'Blockhaus', expires: 'forever', reason: 'Banned by an operator.' });
  } else {
    let profile;
    if (onlineMode) {
      profile = await lookup(key);
      if (!profile) throw new Error(`Einen Minecraft-Account namens „${key}“ gibt es nicht.`);
    } else {
      profile = { uuid: offlineUuid(key), name: key };
    }
    const e = { uuid: profile.uuid, name: profile.name };
    if (list === 'ops') Object.assign(e, { level: 4, bypassesPlayerLimit: false });
    if (list === 'banned-players') Object.assign(e, { created: nowStamp(), source: 'Blockhaus', expires: 'forever', reason: 'Banned by an operator.' });
    entries.push(e);
  }
  writeList(dir, list, entries);
  return entries;
}

module.exports = { LISTS, NAME_RE, readList, normalizeKey, commandFor, editOffline, offlineUuid, mojangLookup, isIp };
