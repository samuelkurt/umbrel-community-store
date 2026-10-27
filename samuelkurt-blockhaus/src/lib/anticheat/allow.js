'use strict';
// Allow-lists for mods/plugins and for the server's resource pack. Both only produce flags.
// "Clients" cannot be checked: a vanilla server does not log the client brand and does not keep it anywhere it can be read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mods = require('../mods');
const software = require('../software');
const props = require('../props');

function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Enabled add-on jars of the server with their SHA-256. Hashed each time: the files can change at any moment. */
async function currentMods(dir) {
  const lay = mods.layout(dir, software.readInstalled(dir));
  if (!lay.folder) return { folder: null, kind: null, items: [], reason: lay.reason || '' };
  const fdir = path.join(dir, lay.folder);
  let names = [];
  try { names = fs.readdirSync(fdir); } catch { /* folder does not exist yet */ }
  const items = [];
  for (const n of names.sort()) {
    if (!mods.FILE_RE.test(n) || n.endsWith('.disabled')) continue;
    try { if (!fs.statSync(path.join(fdir, n)).isFile()) continue; items.push({ file: n, sha256: await hashFile(path.join(fdir, n)) }); } catch { /* vanished */ }
  }
  return { folder: lay.folder, kind: lay.kind, items };
}

function checkMods(allow, cur) {
  if (!allow.enabled) return [];
  const out = [];
  const byFile = new Map(allow.entries.map((e) => [e.file, e.sha256]));
  const hashes = new Set(allow.entries.map((e) => e.sha256));
  for (const it of cur.items) {
    const label = cur.kind === 'plugin' ? 'Plugin' : 'Mod';
    if (byFile.has(it.file)) {
      if (byFile.get(it.file) !== it.sha256) out.push({ key: `mod-changed:${it.file}`, type: 'mod-changed', message: `${label} „${it.file}“ ist nicht mehr die Datei, die erlaubt wurde (Prüfsumme weicht ab)`, evidence: { file: it.file, sha256: it.sha256 } });
    } else if (hashes.has(it.sha256)) {
      // renamed copy of an allowed file: fine
    } else {
      out.push({ key: `mod-unknown:${it.file}`, type: 'mod-unknown', message: `${label} „${it.file}“ steht nicht auf der Erlaubt-Liste`, evidence: { file: it.file, sha256: it.sha256 } });
    }
  }
  return out;
}

/** The pack the server hands to players, as written in server.properties. */
function currentPack(dir) {
  let v = {};
  try { v = props.parse(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).values; } catch { /* no file yet */ }
  const url = String(v['resource-pack'] || '').trim();
  const sha1 = String(v['resource-pack-sha1'] || '').trim().toLowerCase();
  return { url, sha1: /^[0-9a-f]{40}$/.test(sha1) ? sha1 : '' };
}

function checkPacks(allow, cur) {
  if (!allow.enabled || !cur.url) return [];
  if (!cur.sha1) return [{ key: 'pack-nosha', type: 'pack-unknown', message: 'Der Server verteilt ein Texturpaket ohne Prüfsumme (resource-pack-sha1). Es lässt sich nicht gegen die Erlaubt-Liste prüfen', evidence: { url: cur.url } }];
  if (allow.entries.some((e) => e.sha1 === cur.sha1)) return [];
  return [{ key: `pack-unknown:${cur.sha1}`, type: 'pack-unknown', message: `Das Texturpaket des Servers (${cur.sha1.slice(0, 8)}…) steht nicht auf der Erlaubt-Liste`, evidence: { url: cur.url, sha1: cur.sha1 } }];
}

module.exports = { currentMods, checkMods, currentPack, checkPacks, hashFile };
