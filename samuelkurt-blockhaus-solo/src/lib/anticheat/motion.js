'use strict';
// Pure helpers for the position polling. A "sample" is {t (ms), x, y, z, dim, ground (bool)}.
const num = '-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
const POS_RE = new RegExp(`^\\[\\s*(${num})d?\\s*,\\s*(${num})d?\\s*,\\s*(${num})d?\\s*\\]$`);

function parsePos(v) {
  const m = POS_RE.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function parseBool(v) {
  const m = /^(\d+)b$|^(true|false)$/.exec(String(v || '').trim());
  if (!m) return null;
  return m[1] !== undefined ? m[1] !== '0' : m[2] === 'true';
}
function parseStr(v) {
  const m = /^"(.*)"$/.exec(String(v || '').trim());
  return m ? m[1] : null;
}

const horiz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Compares two samples. Returns {dt, dist, speed, sameDim}. dt in seconds.
 */
function step(prev, cur) {
  const dt = (cur.t - prev.t) / 1000;
  const dist = horiz(prev, cur);
  return { dt, dist, speed: dt > 0 ? dist / dt : 0, dy: cur.y - prev.y, sameDim: prev.dim === cur.dim };
}

/** Speed allowance in blocks/s: the configured limit, raised for Speed potions (+20 % per level, like vanilla's attribute). */
function speedLimit(baseBps, effects) {
  const e = (effects || []).find((x) => x.id === 'speed');
  return e ? baseBps * (1 + 0.2 * (e.amp + 1)) : baseBps;
}

/**
 * The server cannot tell "walks very fast" from "rides / glides / is allowed". The confirm step asks for those facts.
 * @param {object} facts {vehicle:boolean|null, fallFlying:boolean|null, mode:number|null, abilities:{mayfly,flying}|null, effects:[{id,amp}]}
 * @returns {string|null} reason why the player may legitimately move like this, or null
 */
function excuse(facts, { forFly = false } = {}) {
  if (!facts) return 'keine Angaben';
  if (facts.dead) return 'ist tot';
  if (facts.vehicle) return 'sitzt in einem Fahrzeug / Reittier';
  if (facts.fallFlying) return 'gleitet mit Elytra';
  if (facts.mode === 1) return 'Kreativmodus';
  if (facts.mode === 3) return 'Zuschauermodus';
  if (facts.abilities && (facts.abilities.mayfly || facts.abilities.flying)) return 'darf fliegen';
  const bad = forFly ? (facts.effects || []).find((e) => e.id === 'levitation' || e.id === 'slow_falling') : null;
  if (bad) return 'Trank-Effekt ' + bad.id;
  return null;
}

module.exports = { parsePos, parseBool, parseStr, step, speedLimit, excuse, horiz };
