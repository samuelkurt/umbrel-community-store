'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Crafty reports server paths as seen inside its own container (e.g. /crafty/servers/<uuid>).
 * Here the same folders are mounted under SERVERS_DIR, so match by the last path segment.
 */
function resolveDir(serversRoot, craftyServer) {
  const p = String((craftyServer && craftyServer.path) || '').replace(/\/+$/, '');
  const base = path.basename(p);
  if (!base || base === '.' || base === '..') return null;
  const candidate = path.join(serversRoot, base);
  try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* not there */ }
  return null;
}

const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.log(\.gz)?$/;

function listLogs(dir) {
  const logDir = path.join(dir, 'logs');
  let names;
  try { names = fs.readdirSync(logDir); } catch { return []; }
  return names
    .filter((n) => LOG_NAME_RE.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(logDir, n));
      return { name: n, size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => (a.name === 'latest.log' ? -1 : b.name === 'latest.log' ? 1 : b.modified - a.modified));
}

/** Read a log file (or the last `maxBytes` of it). .gz files are decompressed. */
function readLog(dir, name, maxBytes = 512 * 1024) {
  if (!LOG_NAME_RE.test(name)) throw new Error('Ungültiger Dateiname.');
  const file = path.join(dir, 'logs', name);
  const st = fs.statSync(file);
  if (name.endsWith('.gz')) {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  }
  const len = Math.min(st.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let text = buf.toString('utf8');
    if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
    return text;
  } finally { fs.closeSync(fd); }
}

function logSize(dir) {
  try { return fs.statSync(path.join(dir, 'logs', 'latest.log')).size; } catch { return 0; }
}

/** Text appended to latest.log after byte offset `from` (the file is rotated on restart: then read from 0). */
function readLogFrom(dir, from) {
  const file = path.join(dir, 'logs', 'latest.log');
  let st;
  try { st = fs.statSync(file); } catch { return ''; }
  const start = st.size < from ? 0 : from;
  const len = Math.min(st.size - start, 1024 * 1024);
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/**
 * Send a console command and wait for a matching line to show up in latest.log.
 * Resolves with the text appended after the command (so callers can parse it); rejects on timeout.
 */
async function ask({ dir, send, command, until, timeoutMs = 6000 }) {
  const from = logSize(dir);
  await send(command);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const text = readLogFrom(dir, from);
    if (until.test(text)) return text;
  }
  throw Object.assign(new Error('Der Server hat nicht rechtzeitig geantwortet.'), { status: 504 });
}

module.exports = { ask, resolveDir, listLogs, readLog, logSize, readLogFrom };
