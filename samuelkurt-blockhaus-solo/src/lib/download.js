'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/** Refuse to fetch from loopback / LAN addresses (SSRF). Tests may set BLOCKHAUS_ALLOW_PRIVATE=1. */
async function assertPublic(hostname) {
  if (process.env.BLOCKHAUS_ALLOW_PRIVATE === '1') return;
  const h = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`Adressen im lokalen Netz sind nicht erlaubt (${hostname}).`);
}

const UA = 'Blockhaus/0.2 (+https://github.com/samuelkurt/umbrel-community-store)';

async function getStream(urlStr, opts = {}) {
  let u0;
  try { u0 = new URL(urlStr); } catch { throw new Error('Ungültige URL: ' + urlStr); }
  if (u0.protocol === 'http:' || u0.protocol === 'https:') await assertPublic(u0.hostname);
  return getStreamRaw(urlStr, opts);
}

function getStreamRaw(urlStr, { headers = {}, timeout = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Ungültige URL: ' + urlStr)); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Nur http(s)-Adressen sind erlaubt.'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Zu viele Weiterleitungen.'));
        return getStream(new URL(res.headers.location, u).toString(), { headers, timeout, redirects: redirects - 1 }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download fehlgeschlagen (HTTP ${res.statusCode}) von ${u.host}.`)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Download von ' + u.host)));
    req.on('error', reject);
  });
}

/** GET and parse JSON. */
async function getJson(url, opts = {}) {
  const res = await getStream(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  const chunks = [];
  let n = 0;
  for await (const c of res) { n += c.length; if (n > 50 * 1024 * 1024) throw new Error('Antwort zu groß.'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Ungültige JSON-Antwort von ' + new URL(url).host); }
}

async function getText(url, opts = {}) {
  const res = await getStream(url, opts);
  const chunks = [];
  let n = 0;
  for await (const c of res) { n += c.length; if (n > 20 * 1024 * 1024) throw new Error('Antwort zu groß.'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Download to `dest` (via a temp file in the same folder). Verifies sha1/sha256/sha512 if given.
 * Returns { size, sha1, sha256 }.
 */
async function downloadFile(url, dest, { sha1, sha256, sha512, md5, maxBytes = 2 * 1024 ** 3, onProgress } = {}) {
  const res = await getStream(url);
  const total = Number(res.headers['content-length']) || 0;
  if (total && total > maxBytes) { res.destroy(); throw new Error('Die Datei ist zu groß.'); }
  const tmp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.part');
  const hm = crypto.createHash('md5'); const h1 = crypto.createHash('sha1'); const h256 = crypto.createHash('sha256'); const h512 = crypto.createHash('sha512');
  let n = 0;
  const out = fs.createWriteStream(tmp);
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) { res.destroy(new Error('Die Datei ist zu groß.')); return; }
        hm.update(c); h1.update(c); h256.update(c); h512.update(c);
        if (onProgress) onProgress(n, total);
        if (!out.write(c)) { res.pause(); out.once('drain', () => res.resume()); }
      });
      res.on('end', () => out.end(resolve));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Download abgebrochen.')));
      out.on('error', reject);
    });
    const got = { md5: hm.digest('hex'), sha1: h1.digest('hex'), sha256: h256.digest('hex'), sha512: h512.digest('hex') };
    if (md5 && got.md5 !== md5.toLowerCase()) throw new Error('Prüfsumme (MD5) stimmt nicht. Der Download ist beschädigt oder verändert.');
    if (sha1 && got.sha1 !== sha1.toLowerCase()) throw new Error('Prüfsumme (SHA-1) stimmt nicht. Der Download ist beschädigt oder verändert.');
    if (sha256 && got.sha256 !== sha256.toLowerCase()) throw new Error('Prüfsumme (SHA-256) stimmt nicht. Der Download ist beschädigt oder verändert.');
    if (sha512 && got.sha512 !== sha512.toLowerCase()) throw new Error('Prüfsumme (SHA-512) stimmt nicht. Der Download ist beschädigt oder verändert.');
    await fsp.rename(tmp, dest);
    return { size: n, sha1: got.sha1, sha256: got.sha256 };
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** Hash what a URL serves (for the resource-pack SHA-1 helper). */
async function hashUrl(url, { maxBytes = 250 * 1024 * 1024, timeout = 60000 } = {}) {
  const res = await getStream(url, { timeout });
  const h = crypto.createHash('sha1');
  let n = 0;
  for await (const c of res) {
    n += c.length;
    if (n > maxBytes) { res.destroy(); throw new Error('Die Datei ist größer als 250 MB.'); }
    h.update(c);
  }
  return { sha1: h.digest('hex'), size: n, type: res.headers['content-type'] || '' };
}

module.exports = { hashUrl, getJson, getText, getStream, downloadFile, assertPublic, isPrivateIp, UA };
