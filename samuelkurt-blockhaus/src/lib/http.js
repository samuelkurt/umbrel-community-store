'use strict';
// Minimal HTTP(S) client. Node's built-in fetch cannot skip certificate checks
// per request, and Crafty ships a self-signed certificate, so we use http(s).request.
const http = require('node:http');
const https = require('node:https');

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function request(urlStr, { method = 'GET', headers = {}, body, insecure = false, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Ungültige URL: ' + urlStr)); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = { method, headers: { ...headers }, timeout };
    if (isHttps && insecure) opts.agent = insecureAgent;
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(body);
      opts.headers['Content-Length'] = payload.length;
    }
    const req = lib.request(u, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Zeitüberschreitung'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
