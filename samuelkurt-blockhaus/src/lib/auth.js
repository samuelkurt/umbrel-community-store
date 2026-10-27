'use strict';
// Login for Blockhaus when it runs without Umbrel's login in front of it (a dedicated Debian server).
//
// One owner password, stored as a scrypt hash in <dataDir>/auth.json (mode 0600). It is set on the server's command line
// (`node server.js --set-password`), never through the web page: whoever reaches the page first must not be able to claim it.
// Sessions live in memory (a restart logs everybody out), the cookie is HttpOnly + SameSite=Strict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN_PASSWORD = 10;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const COOKIE = 'bh_session';
const SESSION_IDLE_MS = 12 * 3600 * 1000;      // logged out after 12 h without activity
const SESSION_MAX_MS = 7 * 24 * 3600 * 1000;   // and after 7 days at the latest
const MAX_SESSIONS = 50;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return { salt: salt.toString('hex'), hash: key.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

function verifyHash(password, rec) {
  let key;
  try {
    key = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'hex'), SCRYPT.keylen, { N: rec.N, r: rec.r, p: rec.p, maxmem: SCRYPT.maxmem });
  } catch { return false; }
  const want = Buffer.from(rec.hash, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

class Auth {
  /**
   * @param {string} dataDir
   * @param {object} [o]
   * @param {() => number} [o.now]  clock (tests)
   */
  constructor(dataDir, { now = Date.now } = {}) {
    this.file = path.join(dataDir, 'auth.json');
    this.now = now;
    this.sessions = new Map();   // token -> { created, seen, ip, gen }  (gen = hash of the password the session was opened with)
    this.fails = new Map();      // ip -> { count, until }
    this.globalFails = { count: 0, until: 0 };
  }

  /** Re-read on every use so `blockhaus-passwd` takes effect without a restart. Sessions carry the hash they were opened with
   *  (see sessionOf), so changing the password from another process (the CLI) also ends every open session. */
  _rec() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && j.hash && j.salt ? j : null;
    } catch { return null; }
  }

  isConfigured() { return !!this._rec(); }

  setPassword(password) {
    const p = String(password || '');
    if (p.length < MIN_PASSWORD) throw new Error(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
    if (p.length > 256) throw new Error('Das Passwort ist zu lang (höchstens 256 Zeichen).');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...hashPassword(p), changed: new Date(this.now()).toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.sessions.clear();
  }

  // ---- brute-force protection: per IP and overall --------------------------------------------------------------
  _lockLeft(ip) {
    const t = this.now();
    const a = this.fails.get(ip);
    const b = this.globalFails;
    return Math.max(0, (a && a.until > t ? a.until - t : 0), (b.until > t ? b.until - t : 0));
  }

  _fail(ip) {
    const t = this.now();
    const a = this.fails.get(ip) || { count: 0, until: 0 };
    a.count++;
    // 5 free tries, then 2 s, 4 s, 8 s ... up to 5 minutes
    if (a.count > 5) a.until = t + Math.min(300000, 1000 * 2 ** (a.count - 5));
    this.fails.set(ip, a);
    const g = this.globalFails;
    g.count++;
    if (g.count > 30) g.until = t + Math.min(300000, 1000 * 2 ** Math.min(18, g.count - 30));
    if (this.fails.size > 1000) this.fails.clear();
  }

  /**
   * @returns {{ok:true, token:string, maxAgeS:number} | {ok:false, status:number, error:string, retryAfterS?:number}}
   */
  login(password, ip) {
    const left = this._lockLeft(ip);
    if (left > 0) return { ok: false, status: 429, error: `Zu viele Versuche. Bitte in ${Math.ceil(left / 1000)} s noch einmal versuchen.`, retryAfterS: Math.ceil(left / 1000) };
    const rec = this._rec();
    if (!rec) return { ok: false, status: 503, error: 'Es ist noch kein Passwort gesetzt. Auf dem Server „blockhaus-passwd“ ausführen.' };
    // the length cap keeps an enormous input from costing scrypt time
    const good = typeof password === 'string' && password.length <= 256 && verifyHash(password, rec);
    if (!good) { this._fail(ip); return { ok: false, status: 401, error: 'Falsches Passwort.' }; }
    this.fails.delete(ip);
    this.globalFails = { count: 0, until: 0 };
    if (this.sessions.size >= MAX_SESSIONS) { // drop the oldest
      const oldest = [...this.sessions.entries()].sort((x, y) => x[1].seen - y[1].seen)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(token, { created: t, seen: t, ip, gen: rec.hash });
    return { ok: true, token, maxAgeS: Math.floor(SESSION_MAX_MS / 1000) };
  }

  /** Session token from the Cookie header, or null. Refreshes the idle timer. */
  sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    const rec = this._rec();
    if (!rec || rec.hash !== s.gen) { this.sessions.delete(token); return null; }   // password changed (or removed) since login
    const t = this.now();
    if (t - s.seen > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS) { this.sessions.delete(token); return null; }
    s.seen = t;
    return token;
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.sessions.delete(token);
  }

  setCookie(token, maxAgeS, secure) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

/**
 * Cross-site request guard for browsers: a request that carries an Origin must come from the page's own host.
 * (Requests without Origin, such as curl, are fine: they cannot ride on a victim's cookie.)
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

/** Read a password from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('Keine Terminal-Eingabe möglich. Mit --set-password-stdin das Passwort über stdin übergeben.'));
    process.stdout.write(question);
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); fn(v); };
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') return done(resolve, buf);
        if (c === '\u0003') return done(reject, new Error('Abgebrochen.'));
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

module.exports = { Auth, sameOrigin, parseCookies, promptHidden, MIN_PASSWORD, COOKIE, hashPassword, verifyHash };
