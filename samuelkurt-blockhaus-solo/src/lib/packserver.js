'use strict';
// Public side of the texture pack feature: a TCP listener that serves resource-pack ZIPs over HTTP and, optionally,
// forwards everything that is NOT HTTP to the Minecraft server.
//
// Why both on one port: the playit.gg tunnel your friends use forwards ONE TCP port to this machine. If that tunnel's
// local port points here, Minecraft traffic AND the pack download use the same public address. (A tunnel to port 25565
// directly keeps working as before; this is only needed for the pack download.)
//
// What is public: GET/HEAD /p/<server>-<sha1>.zip for files that exist in the public pack folder. Nothing else.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { PUBLIC_RE } = require('./packs');

// A Minecraft handshake starts with a length byte and then packet id 0x00; HTTP starts with letters, so 4 bytes are enough.
const HTTP_START = /^(GET |HEAD|POST|PUT |DELE|OPTI|PATC|CONN|TRAC)/;

function parseUpstream(s) {
  const m = /^\s*(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535 ? { host: m[1] || m[2], port } : null;
}

/**
 * @param {object} o
 * @param {string} o.publicDir      folder with the bundle ZIPs
 * @param {() => string} o.upstream "host:port" of the Minecraft server (called per connection), empty = no forwarding
 * @param {(msg:string)=>void} [o.log]
 */
function createPackFront({ publicDir, upstream, log = () => {} }) {
  const httpServer = http.createServer((req, res) => {
    const send = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' }); res.end(text); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    let name;
    try { name = decodeURIComponent((req.url || '').split('?')[0]); } catch { return send(400, 'Bad request'); }
    const m = /^\/p\/([^/]+)$/.exec(name);
    if (!m || !PUBLIC_RE.test(m[1])) return send(404, 'Not found');
    const file = path.join(publicDir, m[1]);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
  httpServer.headersTimeout = 10000;
  httpServer.requestTimeout = 0; // downloads can be slow; the socket timeout below limits idle time
  httpServer.keepAliveTimeout = 5000;
  httpServer.maxHeadersCount = 50;

  const front = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    const chunks = []; let have = 0;
    const timer = setTimeout(() => sock.destroy(), 8000); // a client that sends nothing is dropped
    const onData = (c) => {
      chunks.push(c); have += c.length;
      if (have < 4) return;
      sock.off('data', onData); clearTimeout(timer); sock.pause();
      const first = Buffer.concat(chunks);
      if (HTTP_START.test(first.toString('latin1', 0, 4))) {
        sock.setTimeout(60000, () => sock.destroy());
        sock.unshift(first);
        httpServer.emit('connection', sock);
        sock.resume();
        return;
      }
      const up = parseUpstream(typeof upstream === 'function' ? upstream() : upstream);
      if (!up) { sock.destroy(); return; }
      const out = net.connect(up.port, up.host);
      out.setNoDelay(true);
      out.on('error', (e) => { log('Weiterleitung an Minecraft fehlgeschlagen: ' + e.message); sock.destroy(); });
      out.on('connect', () => { out.write(first); sock.pipe(out); out.pipe(sock); sock.resume(); });
      sock.on('close', () => out.destroy());
      out.on('close', () => sock.destroy());
    };
    sock.on('data', onData);
    sock.on('close', () => clearTimeout(timer));
  });
  front.maxConnections = 500;
  return front;
}

module.exports = { createPackFront, parseUpstream };
