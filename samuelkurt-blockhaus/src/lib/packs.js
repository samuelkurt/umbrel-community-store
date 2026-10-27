'use strict';
// Texture packs (server resource packs).
//
// Vanilla only knows ONE pack (`resource-pack` in server.properties), and the players' clients download it from a URL.
// So Blockhaus stores uploaded packs in its own data folder, checks each one, merges the enabled ones into a single
// "bundle" ZIP, puts that bundle into a public folder (served by lib/packserver.js) and writes URL / SHA-1 / id into
// server.properties.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const zip = require('./zip');
const { getStream } = require('./download');
const { chownLike } = require('./fsutil');

// The Minecraft client refuses server packs above 250 MiB.
const MAX_PACK = 250 * 1024 * 1024;
const MAX_UNPACKED = 700 * 1024 * 1024;
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

const sidOf = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) || 'server';
const paths = (dataDir, sid) => {
  const root = path.join(dataDir, 'packs', sidOf(sid));
  return { root, lib: path.join(root, 'lib'), index: path.join(root, 'index.json') };
};
const publicDir = (dataDir) => path.join(dataDir, 'packs-public');
const PUBLIC_RE = /^[A-Za-z0-9_-]{1,40}-[0-9a-f]{40}\.zip$/;

// ---- index ------------------------------------------------------------------------------------

function readIndex(dataDir, sid) {
  try {
    const j = JSON.parse(fs.readFileSync(paths(dataDir, sid).index, 'utf8'));
    return { packs: Array.isArray(j.packs) ? j.packs : [], applied: j.applied || null };
  } catch { return { packs: [], applied: null }; }
}
function writeIndex(dataDir, sid, idx) {
  const p = paths(dataDir, sid);
  fs.mkdirSync(p.lib, { recursive: true });
  const tmp = p.index + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, p.index);
}

// ---- pack formats -----------------------------------------------------------------------------
// A format is [major, minor]. Old packs only have a whole number (pack_format 46), newer Minecraft versions
// (26.x) report major + minor (e.g. 97.1).

const pair = (v) => (Array.isArray(v) ? [Number(v[0]), Number(v[1] === undefined ? 0 : v[1])] : [Number(v), 0]);
const cmp = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const showFmt = (f) => (f[1] ? `${f[0]}.${f[1]}` : String(f[0]));

/** The range of formats a pack says it supports, from its raw `pack` section. */
function formatRange(pack) {
  if (!pack || typeof pack !== 'object') return null;
  let lo = null; let hi = null;
  if (pack.min_format !== undefined) lo = pair(pack.min_format);
  if (pack.max_format !== undefined) hi = Array.isArray(pack.max_format) ? pair(pack.max_format) : [Number(pack.max_format), Infinity];
  const sf = pack.supported_formats;
  if (lo === null && sf !== undefined) {
    if (typeof sf === 'number') { lo = [sf, 0]; hi = [sf, Infinity]; }
    else if (Array.isArray(sf)) { lo = [Number(sf[0]), 0]; hi = [Number(sf[sf.length > 1 ? 1 : 0]), Infinity]; }
    else if (sf && typeof sf === 'object') { lo = [Number(sf.min_inclusive), 0]; hi = [Number(sf.max_inclusive), Infinity]; }
  }
  if (lo === null && pack.pack_format !== undefined) {
    const n = pair(pack.pack_format);
    lo = Array.isArray(pack.pack_format) ? n : [n[0], 0];
    hi = [n[0], Infinity];
  }
  if (!lo || lo.some(Number.isNaN)) return null;
  if (!hi || hi.some(Number.isNaN)) hi = [lo[0], Infinity];
  return { lo, hi };
}

/** 'ok' | 'too-old' (pack was made for an older Minecraft) | 'too-new' | 'unknown' */
function compat(pack, expected) {
  const r = formatRange(pack);
  if (!r || !expected) return 'unknown';
  if (cmp(expected, r.lo) < 0) return 'too-new';
  if (cmp(expected, r.hi) > 0) return 'too-old';
  return 'ok';
}

// Minecraft 26.x refuses a pack.mcmeta it cannot parse and then silently ignores the whole pack ("Invalid pack
// metadata ..., ignoring all" in the client log). Those rules were taken from the real 26.3 code
// (PackFormat / PackMetadataSection, run on test inputs) and are checked against it in test/packmeta-java.sh.
// Pack formats up to 64 use pack_format / supported_formats, from 65 on min_format / max_format.
const LAST_LEGACY = 64;

/**
 * Reasons why Minecraft 26.x would ignore a pack with this "pack" section. Empty list = accepted.
 * `hasDescription`: the "description" key exists. Older Minecraft versions are more tolerant than this.
 */
function metaProblems(pack, hasDescription = true) {
  const out = [];
  if (!hasDescription) out.push('Das Feld „description“ fehlt.');
  const has = (k) => pack[k] !== undefined;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const fmtOk = (v) => isNum(v) || (Array.isArray(v) && v.length === 2 && v.every(isNum));
  const hasMin = has('min_format'); const hasMax = has('max_format');
  if (has('pack_format') && !isNum(pack.pack_format)) { out.push('pack_format ist keine Zahl.'); return out; }
  if (hasMin !== hasMax) { out.push('min_format und max_format müssen immer beide angegeben werden.'); return out; }
  if (hasMin && (!fmtOk(pack.min_format) || !fmtOk(pack.max_format))) { out.push('min_format / max_format müssen eine Zahl oder [Haupt, Neben] sein.'); return out; }
  let sf = null;
  if (has('supported_formats')) {
    const s = pack.supported_formats;
    if (isNum(s)) sf = [Math.trunc(s), Math.trunc(s)];
    else if (Array.isArray(s) && s.length === 2 && s.every(isNum)) sf = [Math.trunc(s[0]), Math.trunc(s[1])];
    else if (s && typeof s === 'object' && isNum(s.min_inclusive) && isNum(s.max_inclusive)) sf = [Math.trunc(s.min_inclusive), Math.trunc(s.max_inclusive)];
    else { out.push('supported_formats ist ungültig.'); return out; }
  }
  const pf = has('pack_format') ? Math.trunc(pack.pack_format) : null;
  if (hasMin) {
    const lo = pair(pack.min_format); const hi = Array.isArray(pack.max_format) ? pair(pack.max_format) : [Number(pack.max_format), Infinity];
    if (cmp(lo, hi) > 0) { out.push('min_format ist größer als max_format.'); return out; }
    if (sf && lo[0] > LAST_LEGACY) out.push(`supported_formats ist ab Format ${LAST_LEGACY + 1} veraltet und muss entfernt werden.`);
    if (pf !== null && !(lo[0] <= pf && pf <= hi[0])) out.push(`pack_format ${pf} liegt nicht im Bereich von min_format bis max_format.`);
    if (lo[0] <= LAST_LEGACY) {
      if (pf === null) out.push(`Das Paket unterstützt Formate bis ${LAST_LEGACY}, dafür fehlt pack_format.`);
      if (!sf) out.push(`Das Paket unterstützt Formate ab ${lo[0]} bis ${LAST_LEGACY}, dafür fehlt supported_formats.`);
      else if (sf[0] !== lo[0] || !(sf[1] === LAST_LEGACY || sf[1] === hi[0])) out.push('supported_formats passt nicht zu min_format / max_format.');
    }
    return out;
  }
  if (pf === null && !sf) { out.push('Es steht kein Pack-Format in der pack.mcmeta.'); return out; }
  if (pf === null) { out.push('pack_format fehlt.'); return out; }
  if (pf > LAST_LEGACY || (sf && sf[1] > LAST_LEGACY)) { out.push(`Für Formate über ${LAST_LEGACY} (neue Minecraft-Versionen) müssen min_format und max_format statt pack_format stehen.`); return out; }
  if (sf && !(sf[0] <= pf && pf <= sf[1])) out.push(`pack_format ${pf} liegt nicht in supported_formats.`);
  return out;
}

/** The resource-pack format the server's Minecraft version uses, read from the server jar (version.json). */
async function serverPackFormat(jarFile) {
  try {
    const es = await zip.readEntries(jarFile);
    const e = es.find((x) => x.name === 'version.json');
    if (!e) return null;
    const j = JSON.parse((await zip.readEntryBuffer(jarFile, e, 64 * 1024)).toString('utf8'));
    const pv = j.pack_version || {};
    if (pv.resource_major !== undefined) return { format: [Number(pv.resource_major), Number(pv.resource_minor || 0)], style: 'minor', mc: j.id || j.name || null };
    if (pv.resource !== undefined) return { format: [Number(pv.resource), 0], style: 'legacy', mc: j.id || j.name || null };
  } catch { /* not a vanilla-style jar */ }
  return null;
}

// ---- inspecting a pack ZIP --------------------------------------------------------------------

function plainText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(plainText).join('');
  if (typeof c === 'object') return String(c.text || '') + plainText(c.extra);
  return String(c);
}

/**
 * Looks into an uploaded ZIP and says whether Minecraft can use it as a resource pack.
 * Returns { errors[], warnings[], prefix, pack (raw "pack" section), description, hasAssets, hasIcon, files }.
 */
async function inspect(file) {
  const out = { errors: [], warnings: [], prefix: '', pack: null, description: '', hasDescription: false, hasAssets: false, hasIcon: false, files: 0 };
  let entries;
  try { entries = await zip.readEntries(file); } catch (e) { out.errors.push(e.message); return out; }
  const list = entries.filter((e) => !e.symlink).map((e) => ({ e, n: zip.safeName(e.name) })).filter((x) => x.n !== null);
  const files = list.filter((x) => !x.e.dir);
  out.files = files.length;

  const metas = files.filter((x) => x.n === 'pack.mcmeta' || x.n.endsWith('/pack.mcmeta'))
    .sort((a, b) => a.n.split('/').length - b.n.split('/').length);
  if (!metas.length) {
    if (files.some((x) => /(^|\/)manifest\.json$/.test(x.n)) && !files.some((x) => x.n.includes('assets/'))) {
      out.errors.push('Das ist ein Bedrock-Paket (manifest.json). Auf einem Java-Server funktioniert nur ein Java-Texturpaket mit einer pack.mcmeta.');
    } else if (files.some((x) => /\.zip$/i.test(x.n))) {
      out.errors.push('In diesem ZIP liegt noch ein ZIP. Entpacke es zuerst und lade das innere ZIP hoch.');
    } else if (files.some((x) => x.n.startsWith('data/')) && !files.some((x) => x.n.startsWith('assets/'))) {
      out.errors.push('Das ist ein Datenpaket (Datapack), kein Texturpaket. Datapacks gehören in den Ordner datapacks der Welt.');
    } else {
      out.errors.push('In diesem ZIP fehlt die Datei pack.mcmeta. Ohne sie erkennt Minecraft es nicht als Texturpaket.');
    }
    return out;
  }
  const depth = (x) => x.n.split('/').length;
  if (metas.length > 1 && depth(metas[0]) === depth(metas[1]) && depth(metas[0]) > 1) {
    out.errors.push('Das ZIP enthält mehrere Pakete in Unterordnern. Lade jedes Paket einzeln hoch.');
    return out;
  }
  const meta = metas[0];
  out.prefix = meta.n.slice(0, meta.n.length - 'pack.mcmeta'.length);
  if (out.prefix) out.warnings.push(`Die pack.mcmeta lag im Unterordner „${out.prefix}“. Minecraft hätte das Paket so nicht erkannt. Blockhaus hat es neu verpackt.`);

  let json;
  try {
    let text = (await zip.readEntryBuffer(file, meta.e, 1024 * 1024)).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    json = JSON.parse(text);
  } catch (e) {
    out.errors.push('Die pack.mcmeta ist kein gültiges JSON (' + e.message + ').');
    return out;
  }
  if (!json || typeof json.pack !== 'object' || json.pack === null) {
    out.errors.push('In der pack.mcmeta fehlt der Abschnitt „pack“.');
    return out;
  }
  out.pack = {};
  for (const k of ['pack_format', 'min_format', 'max_format', 'supported_formats']) if (json.pack[k] !== undefined) out.pack[k] = json.pack[k];
  out.hasDescription = json.pack.description !== undefined;
  out.description = plainText(json.pack.description).replace(/§./g, '').slice(0, 200);
  if (!formatRange(out.pack)) out.warnings.push('Die pack.mcmeta nennt kein Pack-Format. Minecraft kann das Paket ablehnen.');

  const below = files.filter((x) => x.n.startsWith(out.prefix)).map((x) => x.n.slice(out.prefix.length));
  out.hasAssets = below.some((n) => n.startsWith('assets/'));
  out.hasIcon = below.includes('pack.png');
  if (!out.hasAssets) out.warnings.push('Im Paket gibt es keinen Ordner „assets“. Es enthält also keine Texturen.');
  const badNames = below.filter((n) => {
    const m = /^assets\/([^/]+)\/(.+)$/.exec(n);
    return m && !(/^[a-z0-9_.-]+$/.test(m[1]) && /^[a-z0-9/._-]+$/.test(m[2]));
  });
  if (badNames.length) {
    out.warnings.push(`${badNames.length} Datei(en) haben Namen mit Großbuchstaben, Leerzeichen oder Sonderzeichen (z. B. „${badNames[0].slice(0, 80)}“). Minecraft erlaubt in assets nur a-z, 0-9, _ - . und /. Diese Dateien werden ignoriert, oder das Paket lädt gar nicht.`);
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------------------------

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}
const uuidFrom = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
const cleanName = (n) => String(n || '').replace(/\.zip$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);

async function repack(src, dest, prefix) {
  const work = await fsp.mkdtemp(path.join(path.dirname(dest), '.repack-'));
  try {
    await zip.extractZip(src, work, { stripPrefix: prefix, maxTotal: MAX_UNPACKED });
    const out = fs.createWriteStream(dest);
    const zw = new zip.ZipWriter(out);
    await zw.addTree(work, '');
    await zw.finish();
  } catch (e) { await fsp.rm(dest, { force: true }); throw e; } finally { await fsp.rm(work, { recursive: true, force: true }); }
}

// ---- storing packs ----------------------------------------------------------------------------

/** Stream an uploaded ZIP into the library after checking it. New packs go on top (= highest priority). */
async function addPack(dataDir, sid, body, filename) {
  const p = paths(dataDir, sid);
  fs.mkdirSync(p.lib, { recursive: true });
  const name = cleanName(filename);
  if (!name) throw bad('Bitte einen Namen angeben.');
  if (!/\.zip$/i.test(String(filename))) throw bad('Nur ZIP-Dateien sind erlaubt.');
  const id = crypto.randomBytes(4).toString('hex');
  const up = path.join(p.lib, `.${id}.upload`);
  const final = path.join(p.lib, `${id}.zip`);
  let n = 0; let info;
  const meter = new Transform({ transform(c, _e, cb) { n += c.length; if (n > MAX_PACK) return cb(bad('Das Paket ist größer als 250 MB. Der Minecraft-Client lehnt größere Server-Pakete ab.', 413)); cb(null, c); } });
  try {
    await pipeline(body, meter, fs.createWriteStream(up));
    info = await inspect(up);
    if (info.errors.length) throw bad(info.errors.join(' '), 422);
    if (info.prefix) { await repack(up, final, info.prefix); await fsp.rm(up, { force: true }); } else fs.renameSync(up, final);
  } catch (e) { await fsp.rm(up, { force: true }); await fsp.rm(final, { force: true }); throw e; }
  const st = fs.statSync(final);
  if (st.size > MAX_PACK) { fs.rmSync(final, { force: true }); throw bad('Das Paket ist nach dem Neuverpacken größer als 250 MB.', 413); }
  try { chownLike(dataDir)(final); } catch { /* best effort */ }
  const entry = {
    id, name, file: `${id}.zip`, size: st.size, sha1: await sha1File(final), description: info.description, pack: info.pack,
    hasIcon: info.hasIcon, hasDescription: info.hasDescription, enabled: true, repaired: !!info.prefix, warnings: info.warnings, addedAt: new Date().toISOString(),
  };
  const idx = readIndex(dataDir, sid);
  idx.packs.unshift(entry);
  writeIndex(dataDir, sid, idx);
  return entry;
}

function findPack(idx, id) {
  const i = idx.packs.findIndex((x) => x.id === id);
  if (i < 0) throw bad('Paket nicht gefunden.', 404);
  return i;
}

function list(dataDir, sid, expected) {
  const idx = readIndex(dataDir, sid);
  return {
    packs: idx.packs.map((x) => ({ ...x, compat: compat(x.pack, expected && expected.format), formats: describeFormats(x.pack),
      problems: expected && expected.style === 'minor' ? metaProblems(x.pack || {}, x.hasDescription !== false) : [] })),
    applied: idx.applied,
  };
}
function describeFormats(pack) {
  const r = formatRange(pack);
  if (!r) return '–';
  const hi = r.hi[1] === Infinity ? r.hi[0] : r.hi;
  const a = showFmt(r.lo); const b = Array.isArray(hi) ? showFmt(hi) : String(hi);
  return a === b ? a : `${a}–${b}`;
}

function move(dataDir, sid, id, dir) {
  const idx = readIndex(dataDir, sid);
  const i = findPack(idx, id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= idx.packs.length) return;
  [idx.packs[i], idx.packs[j]] = [idx.packs[j], idx.packs[i]];
  writeIndex(dataDir, sid, idx);
}
function toggle(dataDir, sid, id) {
  const idx = readIndex(dataDir, sid);
  const x = idx.packs[findPack(idx, id)];
  x.enabled = !x.enabled;
  writeIndex(dataDir, sid, idx);
  return x.enabled;
}
function rename(dataDir, sid, id, name) {
  const idx = readIndex(dataDir, sid);
  const x = idx.packs[findPack(idx, id)];
  const n = cleanName(name);
  if (!n) throw bad('Bitte einen Namen angeben.');
  x.name = n;
  writeIndex(dataDir, sid, idx);
}
function remove(dataDir, sid, id) {
  const idx = readIndex(dataDir, sid);
  const i = findPack(idx, id);
  const [x] = idx.packs.splice(i, 1);
  fs.rmSync(path.join(paths(dataDir, sid).lib, x.file), { force: true });
  writeIndex(dataDir, sid, idx);
}
function libFile(dataDir, sid, id) {
  const idx = readIndex(dataDir, sid);
  const x = idx.packs[findPack(idx, id)];
  return { file: path.join(paths(dataDir, sid).lib, x.file), name: x.name };
}

// ---- merging ----------------------------------------------------------------------------------

const RE_LANG = /^assets\/[^/]+\/lang\/[^/]+\.json$/;
const RE_SOUNDS = /^assets\/[^/]+\/sounds\.json$/;
const RE_ATLAS = /^assets\/[^/]+\/atlases\/[^/]+\.json$/;
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

/** Merge two JSON files of a mergeable kind. `low` is from the lower-priority pack. Returns a string or null (= just overwrite). */
function mergeJson(rel, low, high) {
  let a; let b;
  try {
    a = JSON.parse(low.replace(/^﻿/, '')); b = JSON.parse(high.replace(/^﻿/, ''));
  } catch { return null; }
  if (!isObj(a) || !isObj(b)) return null;
  if (RE_LANG.test(rel)) return JSON.stringify({ ...a, ...b });
  if (RE_SOUNDS.test(rel)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!isObj(v) || !isObj(a[k]) || v.replace === true) { out[k] = v; continue; }
      out[k] = { ...a[k], ...v, sounds: [...(Array.isArray(a[k].sounds) ? a[k].sounds : []), ...(Array.isArray(v.sounds) ? v.sounds : [])] };
    }
    return JSON.stringify(out);
  }
  if (RE_ATLAS.test(rel)) return JSON.stringify({ ...a, ...b, sources: [...(Array.isArray(a.sources) ? a.sources : []), ...(Array.isArray(b.sources) ? b.sources : [])] });
  return null;
}

async function overlay(srcDir, dstDir, stats) {
  const walk = async (rel) => {
    for (const it of await fsp.readdir(path.join(srcDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) { await fsp.mkdir(path.join(dstDir, r), { recursive: true }); await walk(r); continue; }
      if (!it.isFile()) continue;
      const from = path.join(srcDir, r); const to = path.join(dstDir, r);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (fs.existsSync(to) && r !== 'pack.mcmeta' && r !== 'pack.png') {
        if (RE_LANG.test(r) || RE_SOUNDS.test(r) || RE_ATLAS.test(r)) {
          const merged = mergeJson(r, await fsp.readFile(to, 'utf8'), await fsp.readFile(from, 'utf8'));
          if (merged !== null) { await fsp.writeFile(to, merged); stats.merged++; continue; }
        }
        stats.overwritten++;
      }
      await fsp.copyFile(from, to);
    }
  };
  await walk('');
}

/** Rewrite the format fields so Minecraft accepts the pack on the server's version (and says it supports exactly that). */
function patchFormat(pack, expected) {
  const exp = expected.format;
  delete pack.pack_format; delete pack.supported_formats; delete pack.min_format; delete pack.max_format;
  if (expected.style === 'minor') { pack.min_format = [exp[0], exp[1]]; pack.max_format = [exp[0], exp[1]]; } else pack.pack_format = exp[0];
  if (pack.description === undefined) pack.description = 'Blockhaus';
}

async function merge(sel, libDir, outFile, { patch, expected, job }) {
  const work = await fsp.mkdtemp(path.join(path.dirname(outFile), '.merge-'));
  const stats = { merged: 0, overwritten: 0 };
  try {
    const outDir = path.join(work, 'out');
    await fsp.mkdir(outDir);
    const ordered = sel.slice().reverse(); // lowest priority first, the top one is applied last and wins
    let i = 0;
    for (const p of ordered) {
      if (job) { job.message = `Füge „${p.name}“ ein (${i + 1}/${ordered.length}) …`; job.progress = i / ordered.length; }
      const dir = path.join(work, 'p' + i);
      await zip.extractZip(path.join(libDir, p.file), dir, { maxTotal: MAX_UNPACKED });
      await overlay(dir, outDir, stats);
      await fsp.rm(dir, { recursive: true, force: true });
      i++;
    }
    const metaFile = path.join(outDir, 'pack.mcmeta');
    let meta;
    try { meta = JSON.parse((await fsp.readFile(metaFile, 'utf8')).replace(/^﻿/, '')); } catch { meta = {}; }
    if (!isObj(meta.pack)) meta.pack = {};
    if (sel.length > 1) meta.pack.description = ('Blockhaus: ' + sel.map((p) => p.name).join(' + ')).slice(0, 200);
    if (patch && expected) patchFormat(meta.pack, expected);
    await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2));
    if (job) { job.message = 'Packe das Paket …'; job.progress = null; }
    const out = fs.createWriteStream(outFile);
    const zw = new zip.ZipWriter(out);
    await zw.addTree(outDir, '');
    await zw.finish();
  } finally { await fsp.rm(work, { recursive: true, force: true }); }
  return stats;
}

/**
 * Build the bundle from all enabled packs and publish it. Returns the new "applied" record, or null if no pack is enabled.
 * File name = <server>-<sha1>.zip, so a changed pack always gets a new URL and clients cannot keep an old copy.
 */
async function build(dataDir, sid, { patch = false, expected = null, job } = {}) {
  const idx = readIndex(dataDir, sid);
  const sel = idx.packs.filter((x) => x.enabled);
  const pub = publicDir(dataDir);
  const prefix = sidOf(sid);
  fs.mkdirSync(pub, { recursive: true });
  const clearOld = (keep) => {
    for (const f of fs.readdirSync(pub)) if (f.startsWith(prefix + '-') && f !== keep) fs.rmSync(path.join(pub, f), { force: true });
  };
  if (!sel.length) { clearOld(null); idx.applied = null; writeIndex(dataDir, sid, idx); return null; }
  const tmp = path.join(pub, `.${prefix}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  let stats = { merged: 0, overwritten: 0 };
  // The bundle's pack.mcmeta is the one of the top pack. If Minecraft 26.x would reject it, fix it automatically.
  const fix = !!expected && (!!patch || (expected.style === 'minor' && metaProblems(sel[0].pack || {}, sel[0].hasDescription !== false).length > 0));
  try {
    if (sel.length === 1 && !fix) await fsp.copyFile(path.join(paths(dataDir, sid).lib, sel[0].file), tmp);
    else stats = await merge(sel, paths(dataDir, sid).lib, tmp, { patch: fix, expected, job });
    const size = fs.statSync(tmp).size;
    if (size > MAX_PACK) throw bad(`Das zusammengeführte Paket ist ${(size / 1048576).toFixed(0)} MB groß. Der Minecraft-Client nimmt höchstens 250 MB. Schalte ein Paket ab.`, 413);
    const sha1 = await sha1File(tmp);
    const file = `${prefix}-${sha1}.zip`;
    fs.renameSync(tmp, path.join(pub, file));
    try { chownLike(dataDir)(path.join(pub, file)); } catch { /* best effort */ }
    clearOld(file);
    idx.applied = { file, sha1, size, id: uuidFrom(sha1), packs: sel.map((x) => x.id), patched: fix, merged: stats.merged, overwritten: stats.overwritten, at: new Date().toISOString() };
    writeIndex(dataDir, sid, idx);
    return idx.applied;
  } finally { await fsp.rm(tmp, { force: true }); }
}

// ---- address players download from ---------------------------------------------------------------

const MC_DEFAULT_PORT = 25565;

/**
 * The address the pack URL is built from. "Download-Adresse" (packBaseUrl) wins. Otherwise the public address is used; but when
 * Blockhaus runs Minecraft itself (mcPort known), a public address that carries the Minecraft port (direct port forwarding: the
 * default 25565 or the port of the server) cannot serve a download: Java answers nothing for HTTP there. The pack is served by
 * Blockhaus on its own port, so the same host with that port is used. Addresses with another port (a playit tunnel pointed at
 * the pack port, say) stay as they are.
 * @returns {{url: string, source: string|null, note: string|null}}
 */
function resolveBase(cfg, { mcPort = null, packPort = null } = {}) {
  let b = String(cfg.packBaseUrl || '').trim();
  let source = b ? 'packBaseUrl' : null;
  let note = null;
  if (!b && cfg.publicAddress) {
    b = String(cfg.publicAddress).trim(); source = 'publicAddress';
    const m = /^(?:https?:\/\/)?(\[[^\]]+\]|[^:/\s]+)(?::(\d{1,5}))?$/i.exec(b);
    if (m && mcPort && packPort && mcPort !== packPort) {
      const port = m[2] ? Number(m[2]) : MC_DEFAULT_PORT;
      if (port === mcPort || port === MC_DEFAULT_PORT) {
        b = `${m[1]}:${packPort}`; source = 'publicAddress+packPort';
        note = `Die öffentliche Adresse nennt den Minecraft-Port (${port}); dort läuft kein Download. Pakete kommen von Port ${packPort} (TCP), den du wie Minecraft freigeben musst. Eine andere Adresse trägst du unter Einstellungen → Texturpakete ein.`;
      }
    }
  }
  if (!b) return { url: '', source: null, note: null };
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  return { url: b.replace(/\/+$/, ''), source, note };
}

/** After a failed download test: does the pack server itself answer on this machine, and what does that say about the way from outside? */
async function diagnose(url, { file, sha1, mcPort = null, packPort = null, error = '' }) {
  let local = null;
  if (packPort && file) {
    try { const r = await checkUrl(`http://127.0.0.1:${packPort}/p/${file}`, sha1, { timeout: 8000 }); local = { ok: r.ok }; } catch (e) { local = { ok: false, error: e.message }; }
  }
  let port = null; try { const u = new URL(url); port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80); } catch { /* invalid */ }
  let hint;
  if (local && !local.ok) hint = `Der Pack-Server auf Port ${packPort} antwortet nicht einmal auf diesem Rechner${local.error ? ' (' + local.error + ')' : ''}. Läuft Blockhaus, und ist der Port frei?`;
  else if (mcPort && packPort && mcPort !== packPort && port === mcPort) hint = `Die Adresse nutzt den Minecraft-Port ${mcPort}. Dort antwortet Minecraft, nicht der Pack-Server (Port ${packPort}). Trage unter Einstellungen → Texturpakete die Adresse mit Port ${packPort} ein.`;
  else if (local && local.ok) hint = `Der Pack-Server antwortet auf diesem Rechner, aber nicht über ${url}. Meist fehlt die Weiterleitung für Port ${port || packPort}/TCP im Router (auf diesen Rechner, Port ${packPort}) oder eine Firewall blockt ihn. Manche Router lassen den Zugriff auf die eigene öffentliche Adresse von innen nicht zu: dann von außen testen (Handy über Mobilfunk).`;
  else hint = null;
  return { local, hint, port };
}

// ---- reachability check -------------------------------------------------------------------------

/** Download `url` like a player's client would and compare the SHA-1. Used to test the whole tunnel. */
function checkUrl(url, expectSha1, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(bad('Die Adresse ist ungültig.')); }
    if (!/^https?:$/.test(u.protocol)) return reject(bad('Nur http(s)-Adressen.'));
    const t0 = Date.now();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout, agent: false, headers: { 'User-Agent': 'Blockhaus-Check' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Die Adresse antwortet mit HTTP ${res.statusCode}.`)); }
      const h = crypto.createHash('sha1'); let n = 0;
      res.on('data', (c) => { n += c.length; h.update(c); });
      res.on('end', () => {
        const sha1 = h.digest('hex'); const ms = Date.now() - t0;
        resolve({ ok: sha1 === expectSha1, sha1, bytes: n, ms, mbps: n / 131072 / Math.max(ms / 1000, 0.001) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung: Von außen ist nichts erreichbar.')));
    req.on('error', reject);
  });
}

// ---- checking the address that is currently in server.properties -------------------------------------

/** Download `url` into the library folder (temp file). Returns { tmp, size, sha1, contentType, isZip, tooBig }. */
async function fetchToTemp(dataDir, sid, url) {
  const p = paths(dataDir, sid);
  fs.mkdirSync(p.lib, { recursive: true });
  const res = await getStream(url, { timeout: 60000 });
  const tmp = path.join(p.lib, `.probe-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const h = crypto.createHash('sha1');
  let n = 0; let head = Buffer.alloc(0); let tooBig = false;
  const out = fs.createWriteStream(tmp);
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        n += c.length;
        if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
        if (n > MAX_PACK) { tooBig = true; res.destroy(); return; }
        h.update(c);
        if (!out.write(c)) { res.pause(); out.once('drain', () => res.resume()); }
      });
      res.on('close', () => out.end(resolve));
      res.on('error', (e) => { if (!tooBig) reject(e); });
      out.on('error', reject);
    });
  } catch (e) { out.destroy(); await fsp.rm(tmp, { force: true }); throw e; }
  return { tmp, size: n, sha1: tooBig ? null : h.digest('hex'), contentType: String(res.headers['content-type'] || ''), isZip: head[0] === 0x50 && head[1] === 0x4b, head: head.toString('latin1'), tooBig };
}

/**
 * Looks at the pack a URL serves the way a player's Minecraft would and says why it would (not) be used.
 * `configuredSha1` is what server.properties says. Returns { findings[{level,text}], ... } and leaves no files behind.
 */
async function probeUrl(dataDir, sid, url, configuredSha1, expected) {
  const f = await fetchToTemp(dataDir, sid, url);
  try {
    const rep = { url, size: f.size, sha1: f.sha1, contentType: f.contentType, configuredSha1: configuredSha1 || '', findings: [], pack: null, description: '' };
    const add = (level, text) => rep.findings.push({ level, text });
    if (f.tooBig) { add('err', `Die Datei ist größer als 250 MB. Der Minecraft-Client bricht den Download dann ab. Nutze ein kleineres Paket.`); return rep; }
    if (!f.isZip) {
      add('err', /html/i.test(f.contentType) || /^\s*</.test(f.head)
        ? `Die Adresse liefert eine Webseite statt einer ZIP-Datei (${f.contentType || 'HTML'}). Das passiert bei Dropbox-, Google-Drive- oder GitHub-Seitenlinks. Minecraft braucht den Direktlink auf die ZIP-Datei.`
        : `Die Adresse liefert keine ZIP-Datei (${f.contentType || 'unbekannter Typ'}).`);
      return rep;
    }
    if (configuredSha1) {
      if (!/^[0-9a-f]{40}$/i.test(configuredSha1)) add('err', 'Die SHA-1-Prüfsumme in der server.properties ist keine gültige 40-stellige Hex-Zahl. Der Server ignoriert sie dann.');
      else if (configuredSha1.toLowerCase() !== f.sha1) add('err', `Die Prüfsumme in der server.properties (${configuredSha1.toLowerCase().slice(0, 12)}…) passt nicht zur Datei, die die Adresse liefert (${f.sha1.slice(0, 12)}…). Der Client verwirft das Paket dann nach dem Download. Genau so sieht „wird geladen, aber nicht angewendet“ aus.`);
      else add('ok', 'Die Prüfsumme in der server.properties passt zur Datei.');
    } else add('warn', 'In der server.properties steht keine Prüfsumme. Dann lädt der Client ein geändertes Paket unter derselben Adresse nur neu, wenn sich der Name ändert.');
    const info = await inspect(f.tmp);
    rep.pack = info.pack; rep.description = info.description;
    for (const e of info.errors) add('err', e);
    if (!info.errors.length) {
      if (info.prefix) add('err', `Die pack.mcmeta liegt im Unterordner „${info.prefix}“ statt ganz oben im ZIP. Minecraft erkennt das Paket so nicht und ignoriert es stillschweigend.`);
      const rest = info.warnings.filter((w) => !/Unterordner/.test(w));
      for (const w of rest) add('warn', w);
      if (expected && expected.style === 'minor') for (const pr of metaProblems(info.pack || {}, info.hasDescription)) add('err', `Die pack.mcmeta ist für Minecraft ${expected.mc || '26.x'} fehlerhaft: ${pr}`);
    }
    if (!rep.findings.some((x) => x.level === 'err')) add('ok', 'Die Datei sieht für Minecraft in Ordnung aus. Erscheint das Paket trotzdem nicht, liegt es am Client: Schau in dessen Log (logs/latest.log) nach Zeilen mit „pack“ oder „resource“.');
    rep.importable = !info.errors.length;
    return rep;
  } finally { await fsp.rm(f.tmp, { force: true }); }
}

/** Fetch the pack from `url` and put it into the library (the same checks and repairs as an upload). */
async function importUrl(dataDir, sid, url) {
  const f = await fetchToTemp(dataDir, sid, url);
  try {
    if (f.tooBig) throw bad('Die Datei ist größer als 250 MB.', 413);
    if (!f.isZip) throw bad('Die Adresse liefert keine ZIP-Datei.', 422);
    let base = 'Importiertes Paket';
    try { base = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/\.zip$/i, '') || base; } catch { /* keep default */ }
    return await addPack(dataDir, sid, fs.createReadStream(f.tmp), base + '.zip');
  } finally { await fsp.rm(f.tmp, { force: true }); }
}

module.exports = {
  resolveBase, diagnose, MAX_PACK, PUBLIC_RE, sidOf, paths, publicDir, readIndex, inspect, addPack, list, move, toggle, rename, remove, libFile,
  build, checkUrl, probeUrl, importUrl, serverPackFormat, compat, formatRange, metaProblems, mergeJson, patchFormat, describeFormats,
};
