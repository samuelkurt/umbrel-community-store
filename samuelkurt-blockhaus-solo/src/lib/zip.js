'use strict';
// Streaming ZIP writer and a safe ZIP reader. No dependencies.
// Limits (reported as errors, never silently wrong): no ZIP64, so < 65535 entries and < 4 GB per file/archive.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable, Readable } = require('node:stream');

const LIMIT32 = 0xffffffff;

function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ZipWriter {
  /** @param {import('node:stream').Writable} out */
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
    this.failed = null;
    this.onFile = null;
    out.on('error', (e) => { this.failed = e; });
  }

  _write(buf) {
    if (this.failed) return Promise.reject(this.failed);
    this.offset += buf.length;
    if (this.out.write(buf)) return Promise.resolve();
    return new Promise((res, rej) => {
      const onDrain = () => { this.out.off('error', onErr); res(); };
      const onErr = (e) => { this.out.off('drain', onDrain); rej(e); };
      this.out.once('drain', onDrain);
      this.out.once('error', onErr);
    });
  }

  _checkCount() {
    if (this.entries.length >= 65535) throw new Error('Zu viele Dateien für ein ZIP (mehr als 65534).');
  }

  async addDir(name, mtime = new Date()) {
    this._checkCount();
    name = name.replace(/\\/g, '/').replace(/\/*$/, '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(nameBuf.length, 26);
    const offset = this.offset;
    await this._write(h); await this._write(nameBuf);
    this.entries.push({ nameBuf, flags: 0x0800, method: 0, time, date, crc: 0, csize: 0, usize: 0, offset, dir: true });
  }

  async addFile(name, file, { level = 6 } = {}) {
    this._checkCount();
    name = name.replace(/\\/g, '/');
    if (this.onFile) this.onFile(name);
    const st = await fsp.stat(file);
    if (st.size > LIMIT32) throw new Error(`Die Datei ${name} ist größer als 4 GB und passt nicht in ein ZIP.`);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(st.mtime);
    const offset = this.offset;
    if (offset > LIMIT32) throw new Error('Das ZIP würde größer als 4 GB.');
    const flags = 0x0808; // UTF-8 names + data descriptor
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(nameBuf.length, 26);
    await this._write(h); await this._write(nameBuf);

    let crc = 0; let usize = 0; let csize = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) { crc = zlib.crc32(chunk, crc); usize += chunk.length; cb(null, chunk); },
    });
    const self = this;
    const sink = new Writable({
      write(chunk, _enc, cb) { csize += chunk.length; self._write(chunk).then(() => cb(), cb); },
    });
    await pipeline(fs.createReadStream(file), meter, zlib.createDeflateRaw({ level }), sink);
    if (usize > LIMIT32 || csize > LIMIT32) throw new Error(`Die Datei ${name} ist größer als 4 GB.`);
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc >>> 0, 4); d.writeUInt32LE(csize, 8); d.writeUInt32LE(usize, 12);
    await this._write(d);
    this.entries.push({ nameBuf, flags, method: 8, time, date, crc: crc >>> 0, csize, usize, offset, dir: false });
  }

  /** Add a whole folder tree. `filter(relPath, isDir)` can skip entries. Symlinks are skipped. */
  async addTree(root, prefix = '', { filter, level } = {}) {
    const walk = async (abs, rel) => {
      const items = await fsp.readdir(abs, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isSymbolicLink()) continue;
        if (filter && !filter(r, it.isDirectory())) continue;
        if (it.isDirectory()) {
          await this.addDir(prefix + r);
          await walk(path.join(abs, it.name), r);
        } else if (it.isFile()) {
          await this.addFile(prefix + r, path.join(abs, it.name), { level });
        }
      }
    };
    await walk(root, '');
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6);
      h.writeUInt16LE(e.flags, 8); h.writeUInt16LE(e.method, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(((e.dir ? 0o40755 : 0o100644) << 16) >>> 0, 38);
      h.writeUInt32LE(e.offset, 42);
      await this._write(h); await this._write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;
    if (this.offset > LIMIT32) throw new Error('Das ZIP würde größer als 4 GB.');
    const t = Buffer.alloc(22);
    t.writeUInt32LE(0x06054b50, 0); t.writeUInt16LE(this.entries.length, 8); t.writeUInt16LE(this.entries.length, 10);
    t.writeUInt32LE(cdSize, 12); t.writeUInt32LE(cdStart, 16);
    await this._write(t);
    await new Promise((res, rej) => { this.out.end((e) => (e ? rej(e) : res())); });
  }
}

// ---- reader ---------------------------------------------------------------------------------

async function readEntries(zipFile) {
  const fd = await fsp.open(zipFile, 'r');
  try {
    const { size } = await fd.stat();
    if (size < 22) throw new Error('Das ist keine gültige ZIP-Datei.');
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Das ist keine gültige ZIP-Datei (Ende nicht gefunden).');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === LIMIT32 || cdOffset === LIMIT32) throw new Error('ZIP64-Archive (über 4 GB) werden nicht unterstützt.');
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Beschädigtes ZIP (Verzeichnis).');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const attrs = cd.readUInt32LE(p + 38) >>> 16;
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      entries.push({ name, flags, method, crc, csize, usize, offset, mode: attrs, dir: name.endsWith('/'), symlink: (attrs & 0o170000) === 0o120000 });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  } finally { await fd.close(); }
}

async function openEntryStream(zipFile, e) {
  if (e.csize === 0) return Readable.from([]);
  const fd = await fsp.open(zipFile, 'r');
  let start;
  try {
    const lh = Buffer.alloc(30);
    await fd.read(lh, 0, 30, e.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Beschädigtes ZIP (Dateikopf).');
    start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally { await fd.close(); }
  const raw = fs.createReadStream(zipFile, { start, end: start + e.csize - 1 });
  if (e.method === 0) return raw;
  if (e.method === 8) return raw.pipe(zlib.createInflateRaw());
  raw.destroy();
  throw new Error(`Nicht unterstützte ZIP-Kompression (${e.method}).`);
}

/** Read one entry fully into memory (small files such as plugin.yml). */
async function readEntryBuffer(zipFile, e, maxBytes = 2 * 1024 * 1024) {
  if (e.usize > maxBytes) throw new Error('Eintrag zu groß.');
  const stream = await openEntryStream(zipFile, e);
  const chunks = []; let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > maxBytes) throw new Error('Eintrag zu groß.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Normalise an archive name; returns null for anything unsafe or to be skipped. */
function safeName(name) {
  let n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  if (n.startsWith('__MACOSX/') || n.endsWith('.DS_Store')) return null;
  const parts = n.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.includes('..')) return null;
  if (parts.some((x) => x.includes('\0'))) return null;
  return parts.join('/') + (n.endsWith('/') ? '/' : '');
}

/**
 * Extract entries into destDir.
 * @param {object} o
 * @param {string} o.stripPrefix only extract entries below this prefix (e.g. "world/"), and drop the prefix
 * @param {number} o.maxTotal  maximum total uncompressed bytes
 * @param {(name:string)=>void} o.onFile progress hook
 */
async function extractZip(zipFile, destDir, { stripPrefix = '', maxTotal = 20 * 1024 ** 3, maxEntries = 200000, onFile, chown } = {}) {
  const entries = await readEntries(zipFile);
  if (entries.length > maxEntries) throw new Error('Das ZIP enthält zu viele Dateien.');
  let total = 0;
  for (const e of entries) total += e.usize;
  if (total > maxTotal) throw new Error('Das entpackte ZIP wäre zu groß.');
  const root = path.resolve(destDir);
  await fsp.mkdir(root, { recursive: true });
  let written = 0;
  for (const e of entries) {
    if (e.symlink) continue;
    const safe = safeName(e.name);
    if (safe === null) continue;
    if (stripPrefix && !safe.startsWith(stripPrefix)) continue;
    const rel = safe.slice(stripPrefix.length);
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Unsicherer Pfad im ZIP: ' + e.name);
    if (e.dir) { await fsp.mkdir(target, { recursive: true }); if (chown) chown(target); continue; }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (onFile) onFile(rel);
    let crc = 0; let n = 0;
    const declared = e.usize;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (n > declared) return cb(new Error('ZIP-Eintrag größer als angegeben: ' + e.name));
        crc = zlib.crc32(chunk, crc);
        cb(null, chunk);
      },
    });
    await pipeline(await openEntryStream(zipFile, e), meter, fs.createWriteStream(target));
    if (n !== declared || (crc >>> 0) !== e.crc) throw new Error('Prüfsumme stimmt nicht (beschädigtes ZIP): ' + e.name);
    if (chown) chown(target);
    written++;
  }
  return { files: written };
}

module.exports = { ZipWriter, readEntries, readEntryBuffer, extractZip, safeName };
