'use strict';
// Minimal RFC 6455 server side: enough for the terminal (text + binary messages, ping/pong, close, fragmentation).
// No extensions (no permessage-deflate), no subprotocols. Client frames must be masked, as the RFC demands.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

/** Complete the HTTP upgrade. Returns a WebSocket, or null after answering with an error status. */
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const bad = (code, text) => { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return null; };
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return bad(400, 'Bad Request');
  if (!key || Buffer.from(String(key), 'base64').length !== 16) return bad(400, 'Bad Request');
  if (req.headers['sec-websocket-version'] !== '13') return bad(426, 'Upgrade Required');
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WebSocket(socket);
}

class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;          // { opcode, chunks, size } while a fragmented message is being assembled
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('end', () => socket.end());   // http sockets are half-open: without this a vanished browser would never be noticed
    socket.on('close', () => this._finish(1006));
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('drain', () => this.emit('drain'));
  }

  get buffered() { return this.socket.writableLength; }

  _fail(code) { this.close(code); }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.closed) return;
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2); const lo = b.readUInt32BE(6);
        if (hi !== 0) return this._fail(1009);
        len = lo; off = 10;
      }
      if (rsv || !masked) return this._fail(1002);
      if (len > MAX_MESSAGE) return this._fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (opcode >= 0x8) { // control frame
        if (!fin || len > 125) return this._fail(1002);
        if (opcode === 0x8) { this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1005); return; }
        if (opcode === 0x9) this._send(0xA, payload);
        else if (opcode !== 0xA) return this._fail(1002);
        continue;
      }
      if (opcode === 0x0) { // continuation
        if (!this.frag) return this._fail(1002);
        this.frag.size += payload.length;
        if (this.frag.size > MAX_MESSAGE) return this._fail(1009);
        this.frag.chunks.push(payload);
        if (fin) { const f = this.frag; this.frag = null; this._message(f.opcode, Buffer.concat(f.chunks)); }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.frag) return this._fail(1002);
        if (fin) this._message(opcode, payload); else this.frag = { opcode, chunks: [payload], size: payload.length };
      } else return this._fail(1002);
    }
  }

  _message(opcode, data) {
    if (opcode === 0x1) this.emit('message', data.toString('utf8'), false);
    else this.emit('message', data, true);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeUInt32BE(n, 6); }
    return this.socket.write(Buffer.concat([head, payload]));
  }

  sendText(s) { return this._send(0x1, Buffer.from(String(s), 'utf8')); }
  sendBinary(b) { return this._send(0x2, Buffer.isBuffer(b) ? b : Buffer.from(b)); }
  ping() { this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const c = Buffer.alloc(2); c.writeUInt16BE(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, 0);
    this._send(0x8, c);
    this._finish(code);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  _finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

module.exports = { accept, WebSocket, MAX_MESSAGE };
