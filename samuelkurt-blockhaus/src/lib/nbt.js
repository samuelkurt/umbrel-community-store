'use strict';
// NBT (binary) reader/writer and an SNBT parser (the text form `data get` prints in the console).
const zlib = require('node:zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

function longToJs(b) {
  return (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(b) : b.toString();
}

/** Parse a (possibly gzip-compressed) NBT file. Returns { name, value }. Longs beyond 2^53 come back as strings. */
function parse(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let p = 0;
  const need = (n) => { if (p + n > buf.length) throw new Error('NBT-Datei ist abgeschnitten.'); };
  const readString = () => { need(2); const l = buf.readUInt16BE(p); p += 2; need(l); const s = buf.toString('utf8', p, p + l); p += l; return s; };
  function payload(type, depth) {
    if (depth > 512) throw new Error('NBT zu tief verschachtelt.');
    switch (type) {
      case T.BYTE: need(1); return buf.readInt8(p++);
      case T.SHORT: need(2); { const v = buf.readInt16BE(p); p += 2; return v; }
      case T.INT: need(4); { const v = buf.readInt32BE(p); p += 4; return v; }
      case T.LONG: need(8); { const v = buf.readBigInt64BE(p); p += 8; return longToJs(v); }
      case T.FLOAT: need(4); { const v = buf.readFloatBE(p); p += 4; return v; }
      case T.DOUBLE: need(8); { const v = buf.readDoubleBE(p); p += 8; return v; }
      case T.BYTE_ARRAY: { need(4); const n = buf.readInt32BE(p); p += 4; need(n); const v = Array.from(buf.subarray(p, p + n), (x) => (x > 127 ? x - 256 : x)); p += n; return v; }
      case T.STRING: return readString();
      case T.LIST: {
        need(5); const et = buf.readUInt8(p++); const n = buf.readInt32BE(p); p += 4;
        const out = [];
        for (let i = 0; i < n; i++) out.push(payload(et, depth + 1));
        return out;
      }
      case T.COMPOUND: {
        const o = {};
        for (;;) {
          need(1); const t = buf.readUInt8(p++);
          if (t === T.END) break;
          const k = readString();
          o[k] = payload(t, depth + 1);
        }
        return o;
      }
      case T.INT_ARRAY: { need(4); const n = buf.readInt32BE(p); p += 4; need(n * 4); const v = []; for (let i = 0; i < n; i++) { v.push(buf.readInt32BE(p)); p += 4; } return v; }
      case T.LONG_ARRAY: { need(4); const n = buf.readInt32BE(p); p += 4; need(n * 8); const v = []; for (let i = 0; i < n; i++) { v.push(longToJs(buf.readBigInt64BE(p))); p += 8; } return v; }
      default: throw new Error('Unbekannter NBT-Typ ' + type);
    }
  }
  need(1);
  const rootType = buf.readUInt8(p++);
  if (rootType !== T.COMPOUND) throw new Error('NBT-Wurzel ist kein Compound.');
  const name = readString();
  return { name, value: payload(T.COMPOUND, 0) };
}

// ---- writer (used by tests and for fixtures) ---------------------------------------------------
// Values are tagged: { t: 'int', v: 5 }, { t: 'list', of: 'compound', v: [...] }, { t: 'compound', v: {...} }
function encode(rootName, compound, { gzip = false } = {}) {
  const parts = [];
  const u8 = (n) => { const b = Buffer.alloc(1); b.writeUInt8(n); parts.push(b); };
  const str = (s) => { const d = Buffer.from(s, 'utf8'); const b = Buffer.alloc(2); b.writeUInt16BE(d.length); parts.push(b, d); };
  const tid = (name) => T[name.toUpperCase()];
  function payload(tag) {
    const t = tid(tag.t);
    const b = (n, fn) => { const x = Buffer.alloc(n); fn(x); parts.push(x); };
    switch (t) {
      case T.BYTE: b(1, (x) => x.writeInt8(tag.v)); break;
      case T.SHORT: b(2, (x) => x.writeInt16BE(tag.v)); break;
      case T.INT: b(4, (x) => x.writeInt32BE(tag.v)); break;
      case T.LONG: b(8, (x) => x.writeBigInt64BE(BigInt(tag.v))); break;
      case T.FLOAT: b(4, (x) => x.writeFloatBE(tag.v)); break;
      case T.DOUBLE: b(8, (x) => x.writeDoubleBE(tag.v)); break;
      case T.STRING: str(tag.v); break;
      case T.LIST: u8(tid(tag.of)); b(4, (x) => x.writeInt32BE(tag.v.length)); for (const e of tag.v) payload({ t: tag.of, v: e }); break;
      case T.COMPOUND:
        for (const [k, v] of Object.entries(tag.v)) { u8(tid(v.t)); str(k); payload(v); }
        u8(0); break;
      case T.INT_ARRAY: b(4, (x) => x.writeInt32BE(tag.v.length)); for (const n of tag.v) b(4, (x) => x.writeInt32BE(n)); break;
      default: throw new Error('encode: nicht unterstützt: ' + tag.t);
    }
  }
  u8(T.COMPOUND); str(rootName); payload({ t: 'compound', v: compound });
  const out = Buffer.concat(parts);
  return gzip ? zlib.gzipSync(out) : out;
}

// ---- SNBT --------------------------------------------------------------------------------------
function parseSnbt(text) {
  let p = 0;
  const ws = () => { while (p < text.length && /\s/.test(text[p])) p++; };
  const fail = (m) => { throw new Error(`SNBT: ${m} bei Zeichen ${p}`); };
  function str(q) {
    p++; let out = '';
    while (p < text.length && text[p] !== q) {
      if (text[p] === '\\') { p++; const c = text[p]; out += c === 'n' ? '\n' : c === 't' ? '\t' : c; p++; }
      else out += text[p++];
    }
    if (text[p] !== q) fail('String nicht beendet');
    p++; return out;
  }
  function bare(allowColon = false) {
    const s = p;
    const re = allowColon ? /[A-Za-z0-9_.+\-:]/ : /[A-Za-z0-9_.+\-]/;
    while (p < text.length && re.test(text[p])) p++;
    if (p === s) fail('unerwartetes Zeichen ' + JSON.stringify(text[p]));
    return text.slice(s, p);
  }
  function scalar(w) {
    if (w === 'true') return true;
    if (w === 'false') return false;
    let m = /^(-?\d+)([bBsSlL])$/.exec(w);
    if (m) return Number(m[1]);
    m = /^(-?\d*\.?\d+(?:[eE][-+]?\d+)?)[fFdD]?$/.exec(w);
    if (m && /[\d]/.test(w)) return Number(m[1]);
    return w;
  }
  function value(depth = 0) {
    if (depth > 200) fail('zu tief');
    ws();
    const c = text[p];
    if (c === '{') {
      p++; const o = {}; ws();
      if (text[p] === '}') { p++; return o; }
      for (;;) {
        ws();
        const k = text[p] === '"' || text[p] === "'" ? str(text[p]) : bare();
        ws(); if (text[p] !== ':') fail('":" erwartet'); p++;
        o[k] = value(depth + 1); ws();
        if (text[p] === ',') { p++; continue; }
        if (text[p] === '}') { p++; return o; }
        fail('"," oder "}" erwartet');
      }
    }
    if (c === '[') {
      p++; ws();
      if (/^[BIL];/.test(text.slice(p, p + 2))) p += 2; // typed array prefix
      const a = []; ws();
      if (text[p] === ']') { p++; return a; }
      for (;;) {
        a.push(value(depth + 1)); ws();
        if (text[p] === ',') { p++; continue; }
        if (text[p] === ']') { p++; return a; }
        fail('"," oder "]" erwartet');
      }
    }
    if (c === '"' || c === "'") return str(c);
    return scalar(bare(true));
  }
  const v = value();
  ws();
  return v;
}

module.exports = { parse, encode, parseSnbt, T };
