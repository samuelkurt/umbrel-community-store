'use strict';
// A real shell in the browser. Each session is one shell on a pseudo terminal (via lib/pty-helper.py, so Blockhaus needs no
// native Node module), kept alive while the page is closed: reload the page and you are back in the same shell, with the
// last screen contents replayed. Sessions end when the shell exits, when you close them, or 30 minutes after the last browser left.
//
// SECURITY: this is a shell with the rights of the user Blockhaus runs as. The server only enables it behind the login
// (see server.js) and the Debian installer runs Blockhaus as its own unprivileged user.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, 'pty-helper.py');
const REPLAY_BYTES = 256 * 1024;
const MAX_BUFFERED = 2 * 1024 * 1024;

const clampInt = (v, lo, hi, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };

class Session {
  constructor(manager, id, { cols, rows, title }) {
    this.manager = manager;
    this.id = id;
    this.title = title;
    this.created = Date.now();
    this.cols = cols; this.rows = rows;
    this.clients = new Set();
    this.chunks = []; this.size = 0;       // replay buffer
    this.exited = null;                     // exit code once the shell is gone
    this.detachedAt = Date.now();
    this.paused = false;

    const env = { ...manager.env, BH_COLS: String(cols), BH_ROWS: String(rows), BH_SHELL: manager.shell, BH_CWD: manager.cwd };
    this.proc = spawn(manager.python, ['-u', HELPER], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env });
    this.ctl = this.proc.stdio[3];
    this.ctl.on('error', () => {});
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (d) => this._onOutput(d));
    let err = '';
    this.proc.stderr.on('data', (d) => { err += d; if (err.length > 2000) err = err.slice(-2000); });
    this.proc.on('error', (e) => { this._exit(127, `Terminal konnte nicht gestartet werden: ${e.message}`); });
    this.proc.on('close', (code) => this._exit(code === null ? 137 : code, code ? err.trim() : ''));
  }

  _onOutput(d) {
    this.chunks.push(d); this.size += d.length;
    while (this.size > REPLAY_BYTES && this.chunks.length > 1) this.size -= this.chunks.shift().length;
    for (const c of this.clients) {
      c.sendBinary(d);
      if (c.buffered > MAX_BUFFERED && !this.paused) {
        // a slow browser: stop reading the shell until it caught up, so memory does not grow
        this.paused = true; this.proc.stdout.pause();
        c.once('drain', () => { this.paused = false; this.proc.stdout.resume(); });
      }
    }
  }

  _exit(code, message) {
    if (this.exited !== null) return;
    this.exited = code;
    for (const c of this.clients) { c.sendText(JSON.stringify({ t: 'exit', code, message: message || '' })); c.close(1000); }
    this.clients.clear();
    this.manager._remove(this.id);
  }

  attach(ws) {
    this.clients.add(ws);
    ws.sendText(JSON.stringify({ t: 'hello', id: this.id, cols: this.cols, rows: this.rows, title: this.title }));
    if (this.chunks.length) ws.sendBinary(Buffer.concat(this.chunks));
    ws.on('message', (data, binary) => {
      if (this.exited !== null) return;
      if (binary) { this.write(data); return; }
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'in' && typeof m.d === 'string') this.write(Buffer.from(m.d, 'utf8'));
      else if (m.t === 'resize') this.resize(m.cols, m.rows);
    });
    ws.on('close', () => { this.clients.delete(ws); if (!this.clients.size) this.detachedAt = Date.now(); });
  }

  write(buf) { if (this.exited === null) this.proc.stdin.write(buf); }

  resize(cols, rows) {
    this.cols = clampInt(cols, 2, 1000, this.cols); this.rows = clampInt(rows, 2, 500, this.rows);
    try { this.ctl.write(JSON.stringify({ cols: this.cols, rows: this.rows }) + '\n'); } catch { /* gone */ }
  }

  kill() {
    if (this.exited !== null) return;
    try { this.proc.stdin.end(); } catch { /* */ }          // hang-up via EOF
    setTimeout(() => { if (this.exited === null) try { this.proc.kill('SIGKILL'); } catch { /* */ } }, 3000).unref();
  }

  view() { return { id: this.id, title: this.title, created: this.created, cols: this.cols, rows: this.rows, clients: this.clients.size }; }
}

class Terminals {
  /**
   * @param {object} [o]
   * @param {string} [o.shell]     default /bin/bash
   * @param {string} [o.cwd]       start folder, default the home folder
   * @param {number} [o.max]       sessions at the same time
   * @param {number} [o.detachedMs] how long a session survives without a browser
   */
  constructor({ shell = process.env.BLOCKHAUS_SHELL || '/bin/bash', cwd = os.homedir(), max = 4, detachedMs = 30 * 60 * 1000, python = 'python3' } = {}) {
    this.shell = shell; this.cwd = cwd; this.max = max; this.detachedMs = detachedMs; this.python = python;
    this.sessions = new Map();
    this.seq = 0;
    // do not hand the panel's own settings to a shell
    this.env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(BLOCKHAUS_|BH_|NODE_ENV$|INVOCATION_ID$|JOURNAL_STREAM$|SYSTEMD_EXEC_PID$|MANAGERPID$|LISTEN_)/.test(k)) continue;
      this.env[k] = v;
    }
    this.env.HOME = this.env.HOME || os.homedir();
    this.env.LANG = this.env.LANG || 'C.UTF-8';
    this.reaper = setInterval(() => this._reap(), 60000);
    this.reaper.unref();
  }

  create({ cols, rows } = {}) {
    if (this.sessions.size >= this.max) {
      const e = new Error(`Es laufen schon ${this.max} Terminals. Schließe zuerst eines.`); e.status = 409; throw e;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const s = new Session(this, id, { cols: clampInt(cols, 2, 1000, 80), rows: clampInt(rows, 2, 500, 24), title: `Terminal ${++this.seq}` });
    this.sessions.set(id, s);
    return s;
  }

  get(id) { return this.sessions.get(String(id)) || null; }
  list() { return [...this.sessions.values()].map((s) => s.view()); }
  close(id) { const s = this.get(id); if (s) s.kill(); return !!s; }
  _remove(id) { this.sessions.delete(id); }

  _reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) if (!s.clients.size && now - s.detachedAt > this.detachedMs) s.kill();
  }

  closeAll() { for (const s of [...this.sessions.values()]) s.kill(); }
}

module.exports = { Terminals };
