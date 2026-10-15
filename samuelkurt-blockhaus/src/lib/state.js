'use strict';

/** Crafty returns the player list as a string such as "[]" or "['Steve', 'Alex']". Accept JSON and Python style. */
function parsePlayers(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const j = JSON.parse(v);
    if (Array.isArray(j)) return j.map(String);
  } catch { /* fall through */ }
  try {
    const j = JSON.parse(v.replace(/'/g, '"'));
    if (Array.isArray(j)) return j.map(String);
  } catch { /* fall through */ }
  return [];
}

/** Which phase is the Minecraft server in, according to the tail of its log? */
function analyzeLog(text) {
  const start = Math.max(text.lastIndexOf('Starting minecraft server'), text.lastIndexOf('Starting Minecraft server'));
  let done = -1;
  const re = /Done \([\d.,]+s\)!/g;
  let m;
  while ((m = re.exec(text))) done = m.index;
  const stopping = text.lastIndexOf('Stopping server');
  return {
    ready: done > start && done >= 0,
    stopping: stopping >= 0 && stopping > start && stopping > done,
  };
}

/**
 * Collapse Crafty's stats (+ log tail) into one state.
 * offline | starting | online | stopping | crashed | updating
 */
function deriveState(stats, logTail = '') {
  if (stats.updating) return 'updating';
  if (!stats.running) return stats.crashed ? 'crashed' : 'offline';
  const log = analyzeLog(logTail);
  if (log.stopping) return 'stopping';
  if (stats.int_ping_results === true || log.ready) return 'online';
  return 'starting';
}

/** Guess the server software from the jar name / start command. */
function guessSoftware(...texts) {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  const table = [
    ['purpur', 'Purpur'], ['paper', 'Paper'], ['spigot', 'Spigot'], ['bukkit', 'CraftBukkit'],
    ['neoforge', 'NeoForge'], ['forge', 'Forge'], ['fabric', 'Fabric'], ['quilt', 'Quilt'],
    ['velocity', 'Velocity'], ['bungee', 'BungeeCord'], ['vanilla', 'Vanilla'], ['server.jar', 'Vanilla'], ['minecraft_server', 'Vanilla'],
  ];
  for (const [needle, name] of table) if (t.includes(needle)) return name;
  return 'Unbekannt';
}

/** Max heap from a java command line, e.g. -Xmx6000M or -Xmx6G. Returns MB or null. */
function parseMaxMemoryMb(cmd) {
  const m = /-Xmx(\d+)([kKmMgG]?)/.exec(cmd || '');
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'g') return n * 1024;
  if (u === 'k') return Math.round(n / 1024);
  return n;
}

module.exports = { parsePlayers, analyzeLog, deriveState, guessSoftware, parseMaxMemoryMb };
