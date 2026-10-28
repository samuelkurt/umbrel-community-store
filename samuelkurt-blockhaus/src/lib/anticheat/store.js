'use strict';
// Config and flags of one server. Files: <dataDir>/anticheat/<id>/config.json and flags.json. Nothing here acts on players.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  enabled: true,
  exemptOps: true,
  exempt: [],
  skipCreative: true,
  ignorePrivateIps: true,
  checks: { items: true, itemsLive: true, vanillaWarnings: true, flood: true, spam: true, xray: true, speed: true, fly: true, mods: true, packs: true },
  thresholds: {
    pollSec: 5, itemLiveSec: 10, speedBps: 12, speedStrikes: 2, teleportBlocks: 100, flyOffGroundSamples: 4,
    vanillaWarnCount: 5, floodJoins: 8, floodWindowS: 30, namesPerIp: 4,
    chatPer10s: 8, cmdPer10s: 12, repeatMsgs: 4, xrayMinOre: 15, xrayRatio: 0.04,
    warnPoints: 5, highPoints: 15, halfLifeMin: 30,
  },
  keepFlags: 2000,
  allow: {
    mods: { enabled: false, entries: [] },   // [{file, sha256}]
    packs: { enabled: false, entries: [] },  // [{sha1, name}]
  },
};

const RANGE = {
  pollSec: [2, 60], itemLiveSec: [3, 300], speedBps: [6, 100], speedStrikes: [1, 10], teleportBlocks: [20, 5000], flyOffGroundSamples: [2, 30],
  vanillaWarnCount: [3, 100], floodJoins: [2, 200], floodWindowS: [5, 600], namesPerIp: [2, 50],
  chatPer10s: [2, 100], cmdPer10s: [2, 100], repeatMsgs: [2, 50], xrayMinOre: [1, 500], xrayRatio: [0.005, 0.5],
  warnPoints: [1, 1000], highPoints: [2, 5000], halfLifeMin: [1, 10080],
};
const NAME = /^[A-Za-z0-9_.]{1,16}$/;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Merge `input` over `base`, keeping only known keys with valid values. Unknown or invalid values are ignored. */
function normalizeConfig(input, base = DEFAULTS) {
  const out = clone(base);
  const i = input && typeof input === 'object' ? input : {};
  for (const k of ['enabled', 'exemptOps', 'skipCreative', 'ignorePrivateIps']) if (typeof i[k] === 'boolean') out[k] = i[k];
  if (Array.isArray(i.exempt)) out.exempt = [...new Set(i.exempt.map(String).filter((n) => NAME.test(n)))].slice(0, 200);
  if (i.checks && typeof i.checks === 'object') for (const k of Object.keys(out.checks)) if (typeof i.checks[k] === 'boolean') out.checks[k] = i.checks[k];
  if (i.thresholds && typeof i.thresholds === 'object') {
    for (const [k, [lo, hi]] of Object.entries(RANGE)) {
      const v = Number(i.thresholds[k]);
      if (i.thresholds[k] !== undefined && Number.isFinite(v)) out.thresholds[k] = Math.min(hi, Math.max(lo, v));
    }
  }
  if (out.thresholds.highPoints <= out.thresholds.warnPoints) out.thresholds.highPoints = out.thresholds.warnPoints * 3;
  const kf = Number(i.keepFlags);
  if (i.keepFlags !== undefined && Number.isFinite(kf)) out.keepFlags = Math.min(20000, Math.max(100, Math.round(kf)));
  if (i.allow && typeof i.allow === 'object') {
    const a = i.allow;
    if (a.mods && typeof a.mods === 'object') {
      if (typeof a.mods.enabled === 'boolean') out.allow.mods.enabled = a.mods.enabled;
      if (Array.isArray(a.mods.entries)) out.allow.mods.entries = a.mods.entries.filter((e) => e && typeof e.file === 'string' && e.file.length <= 160 && HEX(64).test(String(e.sha256))).map((e) => ({ file: e.file, sha256: String(e.sha256) })).slice(0, 2000);
    }
    if (a.packs && typeof a.packs === 'object') {
      if (typeof a.packs.enabled === 'boolean') out.allow.packs.enabled = a.packs.enabled;
      if (Array.isArray(a.packs.entries)) out.allow.packs.entries = a.packs.entries.filter((e) => e && HEX(40).test(String(e.sha1))).map((e) => ({ sha1: String(e.sha1), name: String(e.name || '').slice(0, 80) })).slice(0, 500);
    }
  }
  return out;
}

const sidOf = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) || 'server';

class Store {
  constructor(dataDir, sid, now = Date.now) {
    this.dir = path.join(dataDir, 'anticheat', sidOf(sid));
    this.now = now;
    this.config = normalizeConfig(this._read('config.json'));
    const f = this._read('flags.json');
    this.flags = Array.isArray(f && f.flags) ? f.flags.filter((x) => x && x.id && x.type) : [];
    this.dirty = false;
    this.timer = null;
  }

  _read(name) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return null; } }
  _write(name, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
    fs.renameSync(tmp, path.join(this.dir, name));
  }

  setConfig(patch) {
    this.config = normalizeConfig(patch, this.config);
    this._write('config.json', this.config);
    return this.config;
  }

  _touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref();
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    try { this._write('flags.json', { flags: this.flags }); } catch { this.dirty = true; }
  }

  /**
   * Records a finding. The same finding (player + type + key) within 24 h is merged into one entry; it counts as another
   * occurrence only when at least `gapMs` have passed, so a file that is rescanned does not inflate the score.
   * @returns {{flag:object, isNew:boolean}}
   */
  add({ player = null, type, key = '', severity = 'warn', points = 1, message, evidence = {} }, { gapMs = 10 * 60 * 1000, windowMs = 24 * 3600 * 1000 } = {}) {
    const t = this.now();
    const pl = player ? String(player) : null;
    const same = (f) => f.type === type && (f.key || '') === key && String(f.player || '').toLowerCase() === String(pl || '').toLowerCase();
    let f = null;
    for (let i = this.flags.length - 1; i >= 0; i--) { if (same(this.flags[i]) && t - this.flags[i].last < windowMs) { f = this.flags[i]; break; } }
    if (f) {
      if (t - f.last >= gapMs) { f.count += 1; f.ack = false; f.resolved = null; }
      f.last = t; f.message = message; f.evidence = evidence; f.severity = severity;
      this._touch();
      return { flag: f, isNew: false };
    }
    f = { id: crypto.randomBytes(5).toString('hex'), ts: t, last: t, count: 1, player: pl, type, key, severity, points, message, evidence, ack: false };
    this.flags.push(f);
    if (this.flags.length > this.config.keepFlags) {
      const drop = this.flags.length - this.config.keepFlags;
      const order = this.flags.map((x, i) => ({ i, x })).sort((a, b) => (a.x.ack === b.x.ack ? a.x.last - b.x.last : a.x.ack ? -1 : 1)).slice(0, drop).map((e) => e.i);
      const gone = new Set(order);
      this.flags = this.flags.filter((_, i) => !gone.has(i));
    }
    this._touch();
    return { flag: f, isNew: true };
  }

  /** Changes fields of one flag (used by the manual actions). */
  update(id, patch) {
    const f = this.flags.find((x) => x.id === id);
    if (!f) return null;
    Object.assign(f, patch);
    this._touch();
    return f;
  }

  /** Deletes the flags for which fn(flag) is true. */
  drop(fn) {
    const before = this.flags.length;
    this.flags = this.flags.filter((f) => !fn(f));
    if (this.flags.length !== before) this._touch();
    return before - this.flags.length;
  }

  ack({ id, player, all }) {
    let n = 0;
    for (const f of this.flags) {
      if (f.ack) continue;
      if (all || (id && f.id === id) || (player !== undefined && String(f.player || '').toLowerCase() === String(player || '').toLowerCase())) { f.ack = true; n++; }
    }
    if (n) this._touch();
    return n;
  }

  clear({ all, player, acked }) {
    const before = this.flags.length;
    this.flags = this.flags.filter((f) => {
      if (all) return false;
      if (acked && f.ack) return false;
      if (player !== undefined && String(f.player || '').toLowerCase() === String(player || '').toLowerCase()) return false;
      return true;
    });
    if (this.flags.length !== before) this._touch();
    return before - this.flags.length;
  }

  /** Points per player: open flags, each counted up to 3 times, halved every `halfLifeMin` minutes. */
  scores() {
    const t = this.now();
    const th = this.config.thresholds;
    const hl = th.halfLifeMin * 60000;
    const by = new Map();
    for (const f of this.flags) {
      if (!f.player) continue;
      const k = f.player.toLowerCase();
      let e = by.get(k);
      if (!e) { e = { name: f.player, score: 0, open: 0, total: 0, last: 0 }; by.set(k, e); }
      e.total++;
      e.last = Math.max(e.last, f.last);
      if (f.ack) continue;
      e.open++;
      e.score += f.points * Math.min(f.count, 3) * Math.pow(0.5, Math.max(0, t - f.last) / hl);
    }
    for (const e of by.values()) {
      e.score = Math.round(e.score * 10) / 10;
      e.level = e.score >= th.highPoints ? 'high' : e.score >= th.warnPoints ? 'warn' : 'ok';
    }
    return by;
  }

  openCount() {
    let open = 0; let high = 0;
    for (const f of this.flags) if (!f.ack) { open++; if (f.severity === 'high') high++; }
    return { open, high };
  }
}

module.exports = { Store, DEFAULTS, normalizeConfig, sidOf };
