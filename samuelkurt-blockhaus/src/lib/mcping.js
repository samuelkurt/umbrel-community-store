'use strict';
// Minecraft "Server List Ping": asks a running server who is online, its MOTD and version. This is what the
// multiplayer menu does, and it replaces the ping Crafty did for us.
const net = require('node:net');

function writeVarInt(n) {
  const out = [];
  let v = n >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function readVarInt(buf, off = 0) {
  let n = 0; let shift = 0; let i = off;
  for (;;) {
    if (i >= buf.length) return null; // need more bytes
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt zu lang');
  }
  return { value: n, next: i };
}
const packet = (id, body = Buffer.alloc(0)) => { const p = Buffer.concat([writeVarInt(id), body]); return Buffer.concat([writeVarInt(p.length), p]); };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([writeVarInt(b.length), b]); };

function plain(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(plain).join('');
  if (typeof c === 'object') return String(c.text || '') + plain(c.extra);
  return String(c);
}

/** @returns {Promise<{online:number,max:number,sample:string[],version:string,protocol:number,motd:string}>} */
function ping(host, port, { timeout = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(timeout, () => finish(new Error('Zeitüberschreitung')));
    sock.on('error', finish);
    sock.on('close', () => finish(new Error('Verbindung geschlossen')));
    sock.on('connect', () => {
      const port2 = Buffer.alloc(2); port2.writeUInt16BE(port);
      sock.write(Buffer.concat([
        packet(0, Buffer.concat([writeVarInt(767), str(host), port2, writeVarInt(1)])),
        packet(0),
      ]));
    });
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > 1024 * 1024) return finish(new Error('Antwort zu groß'));
      try {
        const len = readVarInt(buf); if (!len) return;
        if (buf.length < len.next + len.value) return;
        const id = readVarInt(buf, len.next);
        if (!id || id.value !== 0) return finish(new Error('Unerwartete Antwort'));
        const sl = readVarInt(buf, id.next); if (!sl) return;
        const json = JSON.parse(buf.subarray(sl.next, sl.next + sl.value).toString('utf8'));
        const p = json.players || {};
        finish(null, {
          online: Number(p.online) || 0, max: Number(p.max) || 0,
          sample: Array.isArray(p.sample) ? p.sample.map((x) => String(x.name)) : [],
          version: json.version ? String(json.version.name || '') : '', protocol: json.version ? Number(json.version.protocol) || 0 : 0,
          motd: plain(json.description).replace(/§./g, ''),
        });
      } catch (e) { finish(e); }
    });
  });
}

module.exports = { ping, writeVarInt, readVarInt, packet, str };
