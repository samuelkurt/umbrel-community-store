'use strict';
// Server-side anticheat for Blockhaus' own Minecraft servers (local mode). It only watches and records: no kick, no ban, no message
// to players. What it sees: the server's console (log lines), the player data files, the server's statistics, the mod folder,
// server.properties, and answers to `data get entity` queries it sends for online players.
// What it cannot see: packets. So no reach, killaura, autoclicker, scaffold, nuker, no-fall, client brand or client-side packs.
const fs = require('node:fs');
const path = require('node:path');
const nbt = require('../nbt');
const inventory = require('../inventory');
const serverfiles = require('../serverfiles');
const props = require('../props');
const { parseLine, NAME_RE } = require('./logscan');
const items = require('./items');
const motion = require('./motion');
const xray = require('./xray');
const allow = require('./allow');
const actions = require('./actions');
const { SelfTest } = require('./selftest');
const { Rates, isPrivateIp } = require('./rates');
const { Store, normalizeConfig, DEFAULTS } = require('./store');

const SEV = {
  'illegal-item': ['high', 8], 'over-enchant': ['high', 6], 'over-stack': ['warn', 4], unbreakable: ['warn', 3], 'custom-attr': ['warn', 3],
  'vanilla-move': ['warn', 1], 'floating-kick': ['high', 3], 'spam-kick': ['warn', 2], 'chat-spam': ['warn', 2], 'command-spam': ['warn', 2],
  speed: ['warn', 3], teleport: ['info', 1], fly: ['high', 4], xray: ['warn', 3],
  flood: ['warn', 0], 'many-names': ['info', 0], 'mod-unknown': ['warn', 0], 'mod-changed': ['warn', 0], 'pack-unknown': ['warn', 0],
};
const FILES_EVERY_MS = 60 * 1000;
const ALLOW_EVERY_MS = 30 * 60 * 1000;
const ASK_TIMEOUT_MS = 2500;
// questions an admin waits for (buttons, self-test): the server may be busy, so be patient
const ADMIN_ASK_MS = 8000;
const EQUIP = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };
const MAX_POLLED = 40;

/** One query at a time: the console answers in order, and the answers carry no id. */
class Asker {
  constructor(send) { this.send = send; this.q = []; this.cur = null; this.sent = 0; }
  /** priority: an admin is waiting (button, self-test); the question goes before the routine polling questions. */
  ask(command, accept, timeoutMs = ASK_TIMEOUT_MS, priority = false) {
    return new Promise((resolve) => { const c = { command, accept, timeoutMs, resolve }; if (priority) this.q.unshift(c); else this.q.push(c); this._next(); });
  }
  _next() {
    if (this.cur || !this.q.length) return;
    const c = this.q.shift();
    this.cur = c;
    c.timer = setTimeout(() => { if (this.cur === c) { this.cur = null; c.resolve(null); this._next(); } }, c.timeoutMs);
    this.sent++;
    Promise.resolve().then(() => this.send(c.command)).catch(() => { if (this.cur === c) { clearTimeout(c.timer); this.cur = null; c.resolve(null); this._next(); } });
  }
  /** @returns {boolean} true if the event was the answer to the pending query (the line is then hidden from the console) */
  feed(ev) {
    const c = this.cur;
    if (!c || !c.accept(ev)) return false;
    clearTimeout(c.timer);
    this.cur = null;
    c.resolve(ev);
    this._next();
    return true;
  }
  reset() {
    if (this.cur) { clearTimeout(this.cur.timer); this.cur.resolve(null); this.cur = null; }
    for (const c of this.q.splice(0)) c.resolve(null);
  }
}

const lc = (s) => String(s || '').toLowerCase();

class Anticheat {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} o.local   the Local class instance (lineHooks, rt, registry, dirOf, stdin)
   * @param {Function} [o.now]
   * @param {number} [o.tickMs]
   */
  constructor({ dataDir, local, now = Date.now, tickMs = 1000 } = {}) {
    this.dataDir = dataDir;
    this.local = local;
    this.now = now;
    this.tickMs = tickMs;
    this.stores = new Map();
    this.state = new Map();
    this.timer = null;
    this._hook = (sid, text) => this._onLine(sid, text);
  }

  start() {
    this.local.lineHooks.add(this._hook);
    if (!this.timer) {
      this.timer = setInterval(() => { this._tick().catch(() => {}); }, this.tickMs);
      this.timer.unref();
    }
    return this;
  }

  stop() {
    this.local.lineHooks.delete(this._hook);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const s of this.stores.values()) s.flush();
    for (const s of this.state.values()) s.asker.reset();
  }

  store(sid) {
    let s = this.stores.get(sid);
    if (!s) { s = new Store(this.dataDir, sid, this.now); this.stores.set(sid, s); }
    return s;
  }

  S(sid) {
    let s = this.state.get(sid);
    if (!s) {
      s = {
        rates: new Rates(), asker: new Asker((cmd) => this.local.stdin(sid, cmd)), players: new Map(), ipNames: new Map(), lastPoll: 0, polling: false,
        lastFiles: 0, lastAllow: 0, wasOnline: false, seenDat: new Map(), seenStats: new Map(), tp: new Map(), leaveScanAt: 0,
        lastRoundMs: 0, lastRoundPlayers: 0, pendingDue: new Map(),
      };
      this.state.set(sid, s);
    }
    return s;
  }

  rec(sid) { try { return this.local.need(sid); } catch { return null; } }
  dirOf(sid) { const r = this.rec(sid); return r ? this.local.dirOf(r) : null; }

  isOnline(sid) { const r = this.local.rt.get(sid); return !!(r && r.proc && r.state === 'online'); }
  onlineNames(sid) { const r = this.local.rt.get(sid); return r ? [...r.players] : []; }

  // ---- who is exempt -----------------------------------------------------------------------------------------
  opsOf(sid) {
    const dir = this.dirOf(sid);
    const out = new Set();
    if (!dir) return out;
    try { for (const e of JSON.parse(fs.readFileSync(path.join(dir, 'ops.json'), 'utf8'))) if (e && e.name) out.add(lc(e.name)); } catch { /* none */ }
    return out;
  }
  exempt(sid, name) {
    const cfg = this.store(sid).config;
    if (cfg.exempt.some((n) => lc(n) === lc(name))) return true;
    return cfg.exemptOps && this.opsOf(sid).has(lc(name));
  }

  // ---- recording ---------------------------------------------------------------------------------------------
  flag(sid, type, { player = null, key = '', message, evidence = {}, severity, points }) {
    if (player && this.exempt(sid, player)) return null;
    const [sev, pts] = SEV[type] || ['warn', 1];
    return this.store(sid).add({ player, type, key, severity: severity || sev, points: points === undefined ? pts : points, message, evidence }).flag;
  }

  // ---- console lines -----------------------------------------------------------------------------------------
  /** Called by Local for every console line. Returns true to keep the line out of Blockhaus' console view. */
  _onLine(sid, text) {
    const ev = parseLine(text);
    if (!ev) return false;
    const store = this.store(sid);
    if (!store.config.enabled) return false;
    const S = this.S(sid);
    if (S.asker.feed(ev)) return true;
    try { this._event(sid, S, store, ev); } catch { /* never disturb the console */ }
    return false;
  }

  _event(sid, S, store, ev) {
    const cfg = store.config;
    const th = cfg.thresholds;
    const t = this.now();
    switch (ev.type) {
      case 'login': {
                this._connection(sid, S, store, ev.ip, ev.name, t);
        break;
      }
      case 'disconnecting': this._connection(sid, S, store, ev.ip, null, t); this._kickReason(sid, store, ev); break;
      case 'lost': this._kickReason(sid, store, ev); break;
      case 'join': if (store.flags.some((f) => f.pending && lc(f.player) === lc(ev.name))) S.pendingDue.set(lc(ev.name), t + 4000); break;
      case 'leave': S.leaveScanAt = t + 3000; S.players.delete(lc(ev.name)); break;
      case 'teleported': S.tp.set(lc(ev.name), t); break;
      case 'chat': {
        if (!cfg.checks.spam || this.exempt(sid, ev.name)) break;
        const n = S.rates.hit('chat:' + lc(ev.name), t, 10000);
        if (n >= th.chatPer10s) this.flag(sid, 'chat-spam', { player: ev.name, key: 'rate', message: `${ev.name} schrieb ${n} Nachrichten in 10 s`, evidence: { count: n } });
        const msg = ev.text.trim().toLowerCase();
        if (msg) {
          const same = S.rates.hit(`rep:${lc(ev.name)}:${msg.slice(0, 80)}`, t, 30000);
          if (same >= th.repeatMsgs) this.flag(sid, 'chat-spam', { player: ev.name, key: 'repeat', message: `${ev.name} wiederholte dieselbe Nachricht ${same}× in 30 s`, evidence: { count: same, text: ev.text.slice(0, 60) } });
        }
        break;
      }
      case 'command': {
        if (!cfg.checks.spam || this.exempt(sid, ev.name)) break;
        const n = S.rates.hit('cmd:' + lc(ev.name), t, 10000);
        if (n >= th.cmdPer10s) this.flag(sid, 'command-spam', { player: ev.name, key: 'rate', message: `${ev.name} gab ${n} Befehle in 10 s ein`, evidence: { count: n } });
        break;
      }
      case 'moved-quickly': case 'moved-wrongly': {
        if (!cfg.checks.vanillaWarnings || this.exempt(sid, ev.name)) break;
        const n = S.rates.hit(`${ev.type}:${lc(ev.name)}`, t, 60000);
        if (n >= th.vanillaWarnCount) {
          const what = ev.type === 'moved-quickly' ? '„moved too quickly“' : '„moved wrongly“';
          this.flag(sid, 'vanilla-move', { player: ev.name, key: ev.type, message: `Der Server meldete für ${ev.name} ${n}× ${what} in 60 s`, evidence: { count: n, last: ev.detail || '' } });
        }
        break;
      }
      case 'floating-kick':
        if (cfg.checks.vanillaWarnings) this.flag(sid, 'floating-kick', { player: ev.name, key: 'kick', message: `${ev.name} wurde vom Server wegen zu langem Schweben getrennt`, evidence: {} });
        break;
      default:
    }
  }

  /** Kicks the vanilla server itself did ("lost connection: Kicked for spamming" / "Flying is not enabled on this server"). */
  _kickReason(sid, store, ev) {
    const cfg = store.config;
    if (/Flying is not enabled/i.test(ev.reason) && cfg.checks.vanillaWarnings) {
      this.flag(sid, 'floating-kick', { player: ev.name, key: 'kick', message: `${ev.name} wurde vom Server wegen „Flying is not enabled“ getrennt (schwebte zu lange)`, evidence: { reason: ev.reason } });
    } else if (/spamming/i.test(ev.reason) && cfg.checks.spam) {
      this.flag(sid, 'spam-kick', { player: ev.name, key: 'kick', message: `${ev.name} wurde vom Server wegen Spam getrennt`, evidence: { reason: ev.reason } });
    }
  }

  _connection(sid, S, store, ip, name, t) {
    const cfg = store.config;
    const th = cfg.thresholds;
    if (!ip) return;
    if (cfg.checks.flood) {
      const n = S.rates.hit('ip:' + ip, t, th.floodWindowS * 1000);
      if (n >= th.floodJoins) this.flag(sid, 'flood', { key: ip, message: `${n} Verbindungsversuche von ${ip} in ${th.floodWindowS} s`, evidence: { ip, count: n, windowS: th.floodWindowS } });
      if (name && !(cfg.ignorePrivateIps && isPrivateIp(ip))) {
        let m = S.ipNames.get(ip);
        if (!m) { m = new Map(); S.ipNames.set(ip, m); }
        m.set(lc(name), t);
        for (const [k, ts] of m) if (t - ts > 24 * 3600 * 1000) m.delete(k);
        if (m.size >= th.namesPerIp) this.flag(sid, 'many-names', { key: ip, message: `${m.size} verschiedene Spielernamen von ${ip} in 24 h`, evidence: { ip, names: [...m.keys()].slice(0, 12) } });
      }
    }
  }

  // ---- queries -----------------------------------------------------------------------------------------------
  /** `data get entity <name> <path>`. Resolves {value}, {none:true} (path absent), {offline:true} or null (no answer). */
  /** @param {{priority?:boolean, timeout?:number}} [o] */
  async query(sid, name, p, o = {}) {
    const S = this.S(sid);
    const ev = await S.asker.ask(`data get entity ${name} ${p}`, (e) => (e.type === 'data' && lc(e.name) === lc(name)) || e.type === 'noEntity' || e.type === 'noElements', o.timeout || ASK_TIMEOUT_MS, !!o.priority);
    if (!ev) return null;
    if (ev.type === 'noEntity') return { offline: true };
    if (ev.type === 'noElements') return { none: true };
    return { value: ev.value };
  }

  async _confirmFacts(sid, name) {
    const g = async (p) => { const r = await this.query(sid, name, p); return r && !r.offline ? r : null; };
    const veh = await g('RootVehicle'); if (!veh) return null;
    const ff = await g('FallFlying'); if (!ff) return null;
    const gm = await g('playerGameType'); if (!gm) return null;
    const ab = await g('abilities'); if (!ab) return null;
    const ef = await g('active_effects'); if (!ef) return null;
    const hp = await g('Health'); if (!hp) return null;
    const facts = { vehicle: !veh.none, fallFlying: ff.none ? false : motion.parseBool(ff.value) === true, mode: null, abilities: null, effects: [], dead: !hp.none && parseFloat(hp.value) <= 0 };
    if (!gm.none) { const n = parseInt(gm.value, 10); facts.mode = Number.isFinite(n) ? n : null; }
    if (!ab.none) { try { const o = nbt.parseSnbt(ab.value); facts.abilities = { mayfly: !!o.mayfly, flying: !!o.flying }; } catch { return null; } }
    if (!ef.none) {
      try {
        const arr = nbt.parseSnbt(ef.value);
        facts.effects = (Array.isArray(arr) ? arr : []).map((e) => ({ id: String(e.id || '').replace(/^minecraft:/, ''), amp: Number(e.amplifier) || 0 }));
      } catch { return null; }
    }
    return facts;
  }

  /** True only if the server positively says the blocks at the player's feet and head (and, for a hover, the one below) are air (so no water, ladder, web, floor …). */
  async _openAir(sid, name, below = false) {
    const S = this.S(sid);
    const ev = await S.asker.ask(`execute as ${name} at @s if block ~ ~ ~ #minecraft:air if block ~ ~1 ~ #minecraft:air${below ? ' if block ~ ~-1 ~ #minecraft:air' : ''}`, (e) => e.type === 'testPassed' || e.type === 'testFailed' || e.type === 'noEntity', 1200);
    return !!ev && ev.type === 'testPassed';
  }

  async _sample(sid, name) {
    const pos = await this.query(sid, name, 'Pos');
    if (!pos || pos.offline || pos.none) return null;
    const og = await this.query(sid, name, 'OnGround');
    if (!og || og.offline || og.none) return null;
    const dim = await this.query(sid, name, 'Dimension');
    if (!dim || dim.offline || dim.none) return null;
    const p = motion.parsePos(pos.value);
    const ground = motion.parseBool(og.value);
    if (!p || ground === null) return null;
    return { t: this.now(), x: p[0], y: p[1], z: p[2], dim: motion.parseStr(dim.value) || '?', ground };
  }

  async _poll(sid) {
    const S = this.S(sid);
    const store = this.store(sid);
    S.polling = true;
    const t0 = this.now();
    try {
      const names = this.onlineNames(sid).filter((n) => NAME_RE.test(n) && !this.exempt(sid, n)).slice(0, MAX_POLLED);
      S.lastRoundPlayers = names.length;
      for (const name of names) {
        if (!this.isOnline(sid) || !store.config.enabled) break;
        const cur = await this._sample(sid, name);
        if (cur) await this._judge(sid, S, store, name, cur);
      }
    } finally {
      S.polling = false;
      S.lastPoll = this.now();
      S.lastRoundMs = S.lastPoll - t0;
    }
  }

  async _judge(sid, S, store, name, cur) {
    const cfg = store.config;
    const th = cfg.thresholds;
    const k = lc(name);
    const ps = S.players.get(k) || { prev: null, strikes: 0, hist: [], flyCool: 0 };
    S.players.set(k, ps);
    const prev = ps.prev;
    ps.prev = cur;
    if (prev && prev.dim !== cur.dim) { ps.strikes = 0; ps.hist = []; }
    else if (prev) {
      const st = motion.step(prev, cur);
      // a /tp (console or op) between the two samples explains any jump
      const tped = (S.tp.get(k) || 0) >= prev.t - 500;
      if (st.dt > 0 && st.dt <= 60 && !tped) {
        if (cfg.checks.speed && st.dist > th.teleportBlocks) {
          const facts = await this._confirmFacts(sid, name);
          if (facts && !motion.excuse(facts)) {
            this.flag(sid, 'teleport', { player: name, key: 'tp', message: `${name} sprang ${Math.round(st.dist)} Blöcke in ${st.dt.toFixed(1)} s`, evidence: { dim: prev.dim || cur.dim, blocks: Math.round(st.dist), seconds: Math.round(st.dt * 10) / 10, from: [prev.x, prev.y, prev.z].map(Math.round), to: [cur.x, cur.y, cur.z].map(Math.round) } });
          }
          ps.strikes = 0;
        } else if (cfg.checks.speed && st.speed > th.speedBps) {
          const facts = await this._confirmFacts(sid, name);
          const limit = motion.speedLimit(th.speedBps, facts && facts.effects);
          if (facts && st.speed > limit && !motion.excuse(facts)) {
            ps.strikes++;
            if (ps.strikes >= th.speedStrikes) {
              this.flag(sid, 'speed', { player: name, key: 'speed', message: `${name} bewegte sich mit ${st.speed.toFixed(1)} Blöcken/s (Grenze ${limit.toFixed(1)})`, evidence: { speed: Math.round(st.speed * 10) / 10, limit: Math.round(limit * 10) / 10, strikes: ps.strikes, pos: [cur.x, cur.y, cur.z].map(Math.round) } });
              ps.strikes = 0;
            }
          } else ps.strikes = 0;
        } else ps.strikes = 0;
      }
    }
    // flying: (a) hovering = same height for several samples, mostly reported as "not on ground"; (b) rising without ground contact
    ps.hist.push(cur);
    if (ps.hist.length > 20) ps.hist.shift();
    const n = th.flyOffGroundSamples;
    if (cfg.checks.fly && cur.t >= ps.flyCool) {
      const win = ps.hist.slice(-n);
      let kind = null;
      if (win.length === n) {
        const ys = win.map((x) => x.y);
        const off = win.filter((x) => !x.ground).length;
        // bunny-hopping is off the ground most of the time too, but its height keeps changing; a hover does not
        if (Math.max(...ys) - Math.min(...ys) < 0.15 && off >= Math.ceil(n * 0.6)) kind = 'hover';
      }
      const tail = ps.hist.slice(-3);
      if (!kind && tail.length === 3 && tail.every((x) => !x.ground) && tail[1].y - tail[0].y > 1 && tail[2].y - tail[1].y > 1) kind = 'rise';
      if (kind) {
        ps.flyCool = cur.t + 30000;
        const facts = await this._confirmFacts(sid, name);
        if (facts && !motion.excuse(facts, { forFly: true }) && await this._openAir(sid, name, kind === 'hover')) {
          const first = (kind === 'hover' ? ps.hist.slice(-n) : tail)[0];
          const secs = Math.round((cur.t - first.t) / 1000);
          this.flag(sid, 'fly', { player: name, key: kind, message: kind === 'hover' ? `${name} schwebte ${secs} s lang in der Luft (Höhe ${Math.round(cur.y)})` : `${name} stieg ohne Bodenkontakt ${Math.round(tail[2].y - tail[0].y)} Blöcke in ${secs} s nach oben`, evidence: { seconds: secs, y: Math.round(cur.y * 10) / 10, mode: kind, pos: [cur.x, cur.y, cur.z].map(Math.round) } });
          ps.hist = [];
        }
      }
    }
  }

  // ---- files -------------------------------------------------------------------------------------------------
  worldOf(rec) {
    try { return props.parse(fs.readFileSync(path.join(this.local.dirOf(rec), 'server.properties'), 'utf8')).values['level-name'] || 'world'; } catch { return 'world'; }
  }

  /** Findings in the data of one player: Inventory, EnderItems and worn equipment (from the file or from live queries). */
  _dataFindings(data) {
    const eq = data.equipment && typeof data.equipment === 'object' ? data.equipment : {};
    const equip = Object.entries(EQUIP).filter(([k]) => eq[k] && eq[k].id).map(([k, slot]) => ({ ...eq[k], Slot: slot }));
    const raw = [...(Array.isArray(data.Inventory) ? data.Inventory : []), ...equip];
    return [...items.scan(raw, 'Inventar'), ...items.scan(Array.isArray(data.EnderItems) ? data.EnderItems : [], 'Endertruhe')];
  }

  /** What the player's data file on disk says about this player (exemptions are not applied). null if there is no file. */
  fileFindings(sid, name) {
    const rec = this.rec(sid); if (!rec) return null;
    const dir = this.local.dirOf(rec);
    const pd = inventory.playerdataDir(dir, this.worldOf(rec));
    if (!pd) return null;
    let uuid = null;
    for (const [u, n] of inventory.nameMap(dir)) if (lc(n) === lc(name)) uuid = u.toLowerCase();
    if (!uuid) return null;
    let data;
    try { data = nbt.parse(fs.readFileSync(path.join(pd, uuid + '.dat'))).value; } catch { return null; }
    return { uuid, mode: data.playerGameType, findings: this._dataFindings(data) };
  }

  /** Asks the server what the player carries right now (Inventory, EnderItems, equipment). null if it did not answer in time. */
  async liveFindings(sid, name) {
    const get = async (p) => {
      const r = await this.query(sid, name, p, { priority: true, timeout: ADMIN_ASK_MS });
      if (!r || r.offline) return null;
      if (r.none) return { value: null };
      try { return { value: nbt.parseSnbt(r.value) }; } catch { return null; }
    };
    const inv = await get('Inventory'); if (!inv) return null;
    const ender = await get('EnderItems'); if (!ender) return null;
    const eq = await get('equipment'); if (!eq) return null;
    const data = { Inventory: inv.value, EnderItems: ender.value, equipment: eq.value };
    return { data, findings: this._dataFindings(data) };
  }

  scanItems(sid, { force = false } = {}) {
    const rec = this.rec(sid); if (!rec) return 0;
    const store = this.store(sid); const S = this.S(sid);
    if (!store.config.checks.items) return 0;
    const dir = this.local.dirOf(rec);
    const pd = inventory.playerdataDir(dir, this.worldOf(rec));
    if (!pd) return 0;
    const names = inventory.nameMap(dir);
    let n = 0;
    for (const f of fs.readdirSync(pd)) {
      const m = /^([0-9a-f-]{36})\.dat$/i.exec(f); if (!m) continue;
      const uuid = m[1].toLowerCase();
      let st; try { st = fs.statSync(path.join(pd, f)); } catch { continue; }
      if (!force && S.seenDat.get(uuid) === st.mtimeMs) continue;
      S.seenDat.set(uuid, st.mtimeMs);
      let data; try { data = nbt.parse(fs.readFileSync(path.join(pd, f))).value; } catch { continue; }
      const name = names.get(uuid) || uuid.slice(0, 8);
      const nameKnown = names.has(uuid);
      if (this.exempt(sid, name)) continue;
      if (store.config.skipCreative && data.playerGameType === 1) continue;
      for (const fnd of this._dataFindings(data)) {
        this.flag(sid, fnd.type, { player: name, key: fnd.key, message: `${name}: ${fnd.message}`, evidence: { ...fnd.evidence, nameKnown, uuid } });
        n++;
      }
    }
    return n;
  }

  scanXray(sid, { force = false } = {}) {
    const rec = this.rec(sid); if (!rec) return 0;
    const store = this.store(sid); const S = this.S(sid);
    if (!store.config.checks.xray) return 0;
    const dir = this.local.dirOf(rec);
    // 26.x keeps them in <world>/players/stats, older versions in <world>/stats
    const world = this.worldOf(rec);
    const sd = [path.join(dir, world, 'players', 'stats'), path.join(dir, world, 'stats')].find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    if (!sd) return 0;
    let files; try { files = fs.readdirSync(sd); } catch { return 0; }
    const names = inventory.nameMap(dir);
    let n = 0;
    for (const f of files) {
      const m = /^([0-9a-f-]{36})\.json$/i.exec(f); if (!m) continue;
      const uuid = m[1].toLowerCase();
      let st; try { st = fs.statSync(path.join(sd, f)); } catch { continue; }
      if (!force && S.seenStats.get(uuid) === st.mtimeMs) continue;
      S.seenStats.set(uuid, st.mtimeMs);
      let j; try { j = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      const sum = xray.judge(xray.summarize(j), store.config.thresholds);
      if (!sum) continue;
      const name = names.get(uuid) || uuid.slice(0, 8);
      this.flag(sid, 'xray', { player: name, key: 'ores', message: `${name}: ${sum.rare} seltene Erze bei ${sum.total} abgebauten Blöcken (${(sum.ratio * 100).toFixed(1)} %). Nur ein Hinweis, kein Beweis`, evidence: { rare: sum.rare, total: sum.total, ratio: Math.round(sum.ratio * 1000) / 1000, ores: sum.ores } });
      n++;
    }
    return n;
  }

  async scanAllow(sid) {
    const dir = this.dirOf(sid); if (!dir) return 0;
    const store = this.store(sid);
    const cfg = store.config;
    let n = 0;
    if (cfg.checks.mods && cfg.allow.mods.enabled) {
      for (const f of allow.checkMods(cfg.allow.mods, await allow.currentMods(dir))) { this.flag(sid, f.type, { key: f.key, message: f.message, evidence: f.evidence }); n++; }
    }
    if (cfg.checks.packs && cfg.allow.packs.enabled) {
      for (const f of allow.checkPacks(cfg.allow.packs, allow.currentPack(dir))) { this.flag(sid, f.type, { key: f.key, message: f.message, evidence: f.evidence }); n++; }
    }
    return n;
  }

  /** "Check now": everything that reads files, ignoring what was seen before. */
  /** `item replace entity`: the server's feedback line is taken as the answer (and kept out of the console). Resolves true if it said it replaced something. */
  async replaceSlot(sid, name, slotCmd, item) {
    const ev = await this.S(sid).asker.ask(`item replace entity ${name} ${slotCmd} with ${item}`, (e) => e.type === 'replaced' || e.type === 'noEntity', 4000, true);
    return !!ev && ev.type === 'replaced';
  }

  /** Asks the server to write everything to disk and waits for its "Saved the game" (at most 10 s). @returns {Promise<{ok:boolean, ms:number}>} */
  async saveNow(sid) {
    const t0 = Date.now();
    if (!this.isOnline(sid)) return { ok: false, ms: 0 };
    const ev = await this.S(sid).asker.ask('save-all flush', (e) => e.type === 'saved', 10000, true);
    return { ok: !!ev, ms: Date.now() - t0 };
  }

  async scanNow(sid) {
    // the server only writes player data every few minutes; ask it to save so the check sees the current state
    await this.saveNow(sid);
    const items_ = this.scanItems(sid, { force: true });
    const xray_ = this.scanXray(sid, { force: true });
    const allow_ = await this.scanAllow(sid);
    const S = this.S(sid);
    S.lastFiles = this.now(); S.lastAllow = this.now();
    return { items: items_, xray: xray_, allow: allow_ };
  }

  // ---- timer -------------------------------------------------------------------------------------------------
  async _tick() {
    const t = this.now();
    for (const rec of this.local.registry.servers) {
      const sid = rec.id;
      const store = this.store(sid);
      if (!store.config.enabled) continue;
      const S = this.S(sid);
      const online = this.isOnline(sid);
      const th = store.config.thresholds;
      if (!online) {
        if (S.wasOnline) { S.asker.reset(); S.players.clear(); S.polling = false; }
        S.wasOnline = false;
      } else if (!S.wasOnline) {
        S.wasOnline = true; S.lastAllow = 0;
      }
      if (S.leaveScanAt && t >= S.leaveScanAt) { S.leaveScanAt = 0; try { this.scanItems(sid); this.scanXray(sid); } catch { /* ignore */ } }
      for (const [n, due] of S.pendingDue) if (t >= due) { S.pendingDue.delete(n); this._runPending(sid, n).catch(() => {}); }
      if (t - S.lastFiles >= FILES_EVERY_MS) {
        S.lastFiles = t;
        try { this.scanItems(sid); this.scanXray(sid); } catch { /* ignore */ }
      }
      if (online && t - S.lastAllow >= ALLOW_EVERY_MS) {
        S.lastAllow = t;
        this.scanAllow(sid).catch(() => {});
      }
      if (online && !S.polling && (store.config.checks.speed || store.config.checks.fly) && t - S.lastPoll >= th.pollSec * 1000) {
        this._poll(sid).catch(() => { S.polling = false; });
      }
      if (t - (S.gcAt || 0) > 60000) { S.gcAt = t; S.rates.gc(t, 24 * 3600 * 1000); for (const [ip, m] of S.ipNames) { for (const [n, ts] of m) if (t - ts > 24 * 3600 * 1000) m.delete(n); if (!m.size) S.ipNames.delete(ip); } }
    }
  }

  // ---- self-test (started by an admin, runs on the real server) -----------------------------------------------
  startSelfTest(sid, player) {
    const S = this.S(sid);
    if (S.selftest && S.selftest.running) throw Object.assign(new Error('Der Selbsttest läuft schon.'), { status: 409 });
    const state = { running: true, player: String(player), startedAt: Date.now(), finishedAt: 0, steps: [], summary: null };
    S.selftest = state;
    new SelfTest(this, sid, String(player), state).run().catch((e) => { state.steps.push({ name: 'Unerwarteter Fehler', status: 'fail', ms: 0, detail: e.message }); state.running = false; });
    return state;
  }

  selfTestState(sid) { return this.S(sid).selftest || null; }

  // ---- manual actions (only ever started by an admin) ---------------------------------------------------------
  async act(sid, id, action, text) {
    const store = this.store(sid);
    const flag = store.flags.find((f) => f.id === id);
    if (!flag) throw Object.assign(new Error('Meldung nicht gefunden.'), { status: 404 });
    const r = await actions.act(this, sid, flag, action, text);
    if (r.pending) { store.update(id, { pending: action }); return { ok: true, pending: true, message: r.message }; }
    this._done(store, flag, { action, ts: this.now(), note: r.note, backup: r.backup || null });
    return { ok: true, message: r.message, restartNeeded: !!r.restartNeeded };
  }

  /** Remembers what an admin did with a flag (newest last) and marks it as seen. */
  _done(store, flag, entry) {
    store.update(flag.id, { pending: null, ack: true, resolved: entry, actions: [...(flag.actions || []), entry].slice(-10) });
  }

  async _runPending(sid, name) {
    const store = this.store(sid);
    for (const f of store.flags.filter((x) => x.pending && lc(x.player) === lc(name))) {
      try {
        const r = await actions.removeItem(this, sid, f);
        this._done(store, f, { action: f.pending, ts: this.now(), note: r.note, backup: r.backup || null });
      } catch (e) {
        // the item moved or the player left again: keep it pending only if they were not online
        const failed = { action: f.pending, ts: this.now(), note: 'Vorgemerktes Entfernen fehlgeschlagen: ' + e.message, failed: true };
        store.update(f.id, { pending: null, resolved: failed, actions: [...(f.actions || []), failed].slice(-10) });
      }
    }
  }

  // ---- views for the API -------------------------------------------------------------------------------------
  view(sid) {
    const store = this.store(sid); const S = this.S(sid);
    const scores = store.scores();
    const online = new Set(this.onlineNames(sid).map(lc));
    const ops = this.opsOf(sid);
    const names = new Map();
    for (const e of scores.values()) names.set(lc(e.name), e);
    for (const n of this.onlineNames(sid)) if (!names.has(lc(n))) names.set(lc(n), { name: n, score: 0, open: 0, total: 0, last: 0, level: 'ok' });
    const players = [...names.values()].map((e) => ({ ...e, online: online.has(lc(e.name)), exempt: this.exempt(sid, e.name), op: ops.has(lc(e.name)) }))
      .sort((a, b) => b.score - a.score || (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
    let known = [];
    try { known = [...new Set([...inventory.nameMap(this.dirOf(sid)).values()])].filter((n) => NAME_RE.test(n)).slice(0, 100); } catch { /* no server folder */ }
    const flags = store.flags.filter((f) => !f.selftest).sort((a, b) => b.last - a.last).slice(0, 600);
    return {
      available: true, config: store.config, defaults: DEFAULTS, running: this.isOnline(sid), counts: store.openCount(), players, known, flags,
      status: { lastPoll: S.lastPoll, polledPlayers: S.lastRoundPlayers, roundMs: S.lastRoundMs, queries: S.asker.sent, lastFiles: S.lastFiles, lastAllow: S.lastAllow },
    };
  }

  setConfig(sid, patch) { return this.store(sid).setConfig(patch); }

  async allowView(sid) {
    const dir = this.dirOf(sid); const store = this.store(sid);
    const cur = await allow.currentMods(dir);
    const pack = allow.currentPack(dir);
    return { mods: { ...store.config.allow.mods, current: cur.items, folder: cur.folder, kind: cur.kind, reason: cur.reason || '' }, packs: { ...store.config.allow.packs, current: pack } };
  }

  async allowSnapshot(sid, kind) {
    const dir = this.dirOf(sid); const store = this.store(sid);
    const a = JSON.parse(JSON.stringify(store.config.allow));
    if (kind === 'mods') a.mods.entries = (await allow.currentMods(dir)).items;
    else if (kind === 'packs') {
      const p = allow.currentPack(dir);
      if (p.sha1 && !a.packs.entries.some((e) => e.sha1 === p.sha1)) a.packs.entries.push({ sha1: p.sha1, name: p.url.split('/').pop().slice(0, 80) });
    } else throw Object.assign(new Error('Unbekannte Liste.'), { status: 400 });
    return store.setConfig({ allow: a }).allow;
  }

  summary() {
    return this.local.registry.servers.map((r) => { const st = this.store(r.id); return { id: r.id, name: r.name, enabled: st.config.enabled, ...st.openCount() }; });
  }
}

module.exports = { Anticheat, Asker, normalizeConfig, DEFAULTS, SEV };
