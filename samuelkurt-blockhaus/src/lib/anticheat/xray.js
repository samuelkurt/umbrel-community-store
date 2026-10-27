'use strict';
// X-ray hints from the server's own statistics (<world>/stats/<uuid>.json): how many rare ores a player mined compared with
// everything they mined. A good miner with luck or a map can look like this too, so it is only ever a hint.
const RARE = new Set(['diamond_ore', 'deepslate_diamond_ore', 'ancient_debris', 'emerald_ore', 'deepslate_emerald_ore']);
const bare = (s) => String(s).replace(/^minecraft:/, '');

/** @param {object} stats parsed stats json   @returns {{rare:number,total:number,ratio:number,ores:object}|null} */
function summarize(stats) {
  const mined = stats && stats.stats && stats.stats['minecraft:mined'];
  if (!mined || typeof mined !== 'object') return null;
  let rare = 0; let total = 0; const ores = {};
  for (const [k, v] of Object.entries(mined)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;
    if (RARE.has(bare(k))) { rare += n; ores[bare(k)] = n; }
  }
  return { rare, total, ratio: total ? rare / total : 0, ores };
}

function judge(sum, { xrayMinOre = 15, xrayRatio = 0.04 } = {}) {
  if (!sum || sum.rare < xrayMinOre || sum.total < 200) return null;
  return sum.ratio >= xrayRatio ? sum : null;
}

module.exports = { summarize, judge, RARE };
