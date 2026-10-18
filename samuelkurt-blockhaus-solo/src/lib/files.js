'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { resolveInside, validName, PathError } = require('./safepath');
const { writeFileKeepOwner, chownLike } = require('./fsutil');

const TEXT_EXT = new Set(['.txt', '.json', '.json5', '.yml', '.yaml', '.properties', '.toml', '.cfg', '.conf', '.config', '.ini', '.log', '.md', '.mcmeta', '.xml', '.csv', '.sh', '.bat', '.lang', '.mcfunction', '.snbt', '.js', '.html', '.css', '.secret', '.args']);
const MAX_EDIT = 1024 * 1024;

function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function wrap(fn) {
  try { return fn(); } catch (e) { if (e instanceof PathError) throw bad(e.message, 400); throw e; }
}

function list(root, rel) {
  const abs = wrap(() => resolveInside(root, rel));
  let st;
  try { st = fs.statSync(abs); } catch { throw bad('Ordner nicht gefunden.', 404); }
  if (!st.isDirectory()) throw bad('Das ist kein Ordner.');
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
    const p = path.join(abs, d.name);
    let s = null;
    try { s = fs.lstatSync(p); } catch { /* vanished */ }
    const type = d.isSymbolicLink() ? 'link' : d.isDirectory() ? 'dir' : 'file';
    return { name: d.name, type, size: s && type === 'file' ? s.size : null, mtime: s ? s.mtimeMs : null,
      text: type === 'file' && TEXT_EXT.has(path.extname(d.name).toLowerCase()) && (s ? s.size <= MAX_EDIT : true) };
  });
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, 'de'));
  const rootReal = fs.realpathSync(root);
  const relPath = path.relative(rootReal, abs).split(path.sep).join('/');
  return { path: relPath, entries };
}

function readText(root, rel) {
  const abs = wrap(() => resolveInside(root, rel));
  let st;
  try { st = fs.statSync(abs); } catch { throw bad('Datei nicht gefunden.', 404); }
  if (!st.isFile()) throw bad('Das ist keine Datei.');
  if (st.size > MAX_EDIT) throw bad('Die Datei ist größer als 1 MB und lässt sich hier nicht bearbeiten. Lade sie herunter.');
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw bad('Das ist eine Binärdatei und lässt sich nicht als Text bearbeiten.');
  return { text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
}

function writeText(root, rel, text) {
  const abs = wrap(() => resolveInside(root, rel));
  if (typeof text !== 'string') throw bad('Text fehlt.');
  if (Buffer.byteLength(text) > MAX_EDIT) throw bad('Zu groß (höchstens 1 MB).');
  let st = null;
  try { st = fs.statSync(abs); } catch { /* new file */ }
  if (st && !st.isFile()) throw bad('Das ist keine Datei.');
  if (!fs.existsSync(path.dirname(abs))) throw bad('Der Ordner existiert nicht.', 404);
  writeFileKeepOwner(abs, text);
}

function mkdir(root, rel) {
  const abs = wrap(() => resolveInside(root, rel));
  if (abs === fs.realpathSync(root)) throw bad('Ungültiger Ordnername.');
  if (fs.existsSync(abs)) throw bad('Das gibt es schon.', 409);
  const parent = path.dirname(abs);
  if (!fs.existsSync(parent)) throw bad('Der übergeordnete Ordner existiert nicht.', 404);
  fs.mkdirSync(abs);
  chownLike(parent)(abs);
}

async function remove(root, rel) {
  const abs = wrap(() => resolveInside(root, rel));
  if (abs === fs.realpathSync(root)) throw bad('Der Server-Ordner selbst kann nicht gelöscht werden.');
  let st;
  try { st = fs.lstatSync(abs); } catch { throw bad('Nicht gefunden.', 404); }
  await fsp.rm(abs, { recursive: st.isDirectory(), force: false });
}

function rename(root, from, to) {
  const a = wrap(() => resolveInside(root, from));
  const b = wrap(() => resolveInside(root, to));
  const rootReal = fs.realpathSync(root);
  if (a === rootReal || b === rootReal) throw bad('Ungültig.');
  if (!fs.existsSync(a)) throw bad('Nicht gefunden.', 404);
  if (fs.existsSync(b)) throw bad('Das Ziel gibt es schon.', 409);
  if (!fs.existsSync(path.dirname(b))) throw bad('Der Zielordner existiert nicht.', 404);
  if (b.startsWith(a + path.sep)) throw bad('Ein Ordner kann nicht in sich selbst verschoben werden.');
  fs.renameSync(a, b);
}

/** Resolve a file for download. Returns { abs, name, size }. */
function downloadInfo(root, rel) {
  const abs = wrap(() => resolveInside(root, rel));
  let st;
  try { st = fs.statSync(abs); } catch { throw bad('Datei nicht gefunden.', 404); }
  if (!st.isFile()) throw bad('Das ist keine Datei.');
  return { abs, name: path.basename(abs), size: st.size };
}

/** Stream an upload (raw request body) into `dirRel/name`. Refuses to overwrite unless `overwrite`. */
async function upload(root, dirRel, name, body, { overwrite = false, maxBytes = 20 * 1024 ** 3 } = {}) {
  const dirAbs = wrap(() => resolveInside(root, dirRel));
  let st;
  try { st = fs.statSync(dirAbs); } catch { throw bad('Zielordner nicht gefunden.', 404); }
  if (!st.isDirectory()) throw bad('Das Ziel ist kein Ordner.');
  const clean = wrap(() => validName(name));
  const target = path.join(dirAbs, clean);
  wrap(() => resolveInside(root, path.relative(fs.realpathSync(root), target)));
  if (!overwrite && fs.existsSync(target)) throw bad(`„${clean}“ gibt es schon. Lösche die Datei zuerst oder wähle „Überschreiben“.`, 409);
  const tmp = path.join(dirAbs, '.' + clean + '.upload');
  let n = 0;
  const { Transform } = require('node:stream');
  const meter = new Transform({ transform(c, _e, cb) { n += c.length; if (n > maxBytes) return cb(bad('Die Datei ist zu groß.', 413)); cb(null, c); } });
  try {
    await pipeline(body, meter, fs.createWriteStream(tmp));
    chownLike(dirAbs)(tmp);
    fs.renameSync(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return { name: clean, size: n };
}

module.exports = { list, readText, writeText, mkdir, remove, rename, downloadInfo, upload, MAX_EDIT };
