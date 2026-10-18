'use strict';
// Tiny in-memory job registry for long-running work (backup, restore, install). Jobs are lost on restart.
const crypto = require('node:crypto');

class Jobs {
  constructor() { this.map = new Map(); }

  /** Start `fn(job)` in the background. fn may set job.message / job.progress (0..1). */
  start(type, serverId, fn) {
    for (const j of this.map.values()) {
      if (j.status === 'running' && j.serverId === String(serverId)) {
        const err = new Error(`Es läuft schon eine Aufgabe für diesen Server (${j.title}).`);
        err.status = 409;
        throw err;
      }
    }
    const job = { id: crypto.randomBytes(6).toString('hex'), type, serverId: String(serverId), title: type, status: 'running', message: '', progress: null, error: null, result: null, started: Date.now(), ended: null };
    this.map.set(job.id, job);
    Promise.resolve().then(() => fn(job)).then((r) => { job.status = 'done'; job.result = r === undefined ? null : r; })
      .catch((e) => { job.status = 'error'; job.error = e && e.message ? e.message : String(e); })
      .finally(() => { job.ended = Date.now(); this._gc(); });
    return job;
  }

  get(id) { return this.map.get(id) || null; }

  active(serverId) {
    return [...this.map.values()].filter((j) => j.serverId === String(serverId) && (j.status === 'running' || Date.now() - (j.ended || 0) < 5 * 60 * 1000))
      .sort((a, b) => b.started - a.started);
  }

  _gc() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, j] of this.map) if (j.ended && j.ended < cutoff) this.map.delete(id);
  }
}

module.exports = { Jobs };
