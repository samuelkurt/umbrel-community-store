'use strict';
// Reads one console line of the Minecraft server and says what it is. Formats checked against a real 26.3 server:
//   [12:16:38] [Server thread/INFO]: Bot01[/127.0.0.1:37386] logged in with entity id 15 at (-524.5, 65.0, 69.5)
//   [12:16:38] [Server thread/INFO]: System chat: Bot01 joined the game
//   [12:16:41] [Server thread/INFO]: System chat: Bot01 has the following entity data: [-526.2d, 64.0d, 75.1d]
//   [12:16:09] [Server thread/INFO]: Disconnecting Bot01 (/127.0.0.1:35368): You are not white-listed on this server!
// Anything that is not recognised returns null. Chat text is only ever looked at behind "<Name> ", so a player cannot
// type something that looks like a server message.
const N = '([A-Za-z0-9_.]{1,16})';
// Log line prefixes of the servers Blockhaus can start (checked against real 26.3 logs of Vanilla and Forge):
//   [12:16:38] [Server thread/INFO]: text                                                    Vanilla, Fabric, Paper
//   [18Oct2026 20:19:06.771] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: text   Forge, NeoForge
//   [12:16:38] [Server thread/INFO] (Minecraft) text                                         Fabric/Quilt with logger name
//   [12:16:38 INFO]: text                                                                    older Spigot/Paper
const PREFIXES = [
  /^\[[^\]]*\] \[[^\]]*\](?: \[[^\]]*\])?: /,
  /^\[[^\]]*\] \[[^\]]*\] \([^)]*\) /,
  /^\[\d\d:\d\d:\d\d(?:\.\d+)? (?:INFO|WARN|WARNING|ERROR|DEBUG)\]: /,
];
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const RULES = [
  // [regex, build(match) -> event]; "sys" rules only apply to lines the server itself printed
  [new RegExp(`^${N}\\[\\/(.+):(\\d+)\\] logged in with entity id (\\d+) at \\((-?[\\d.]+), (-?[\\d.]+), (-?[\\d.]+)\\)$`), 'login', (m) => ({ name: m[1], ip: m[2], port: Number(m[3]), entityId: Number(m[4]), pos: [Number(m[5]), Number(m[6]), Number(m[7])] })],
  [new RegExp(`^${N} joined the game$`), 'join', (m) => ({ name: m[1] }), true],
  [new RegExp(`^${N} left the game$`), 'leave', (m) => ({ name: m[1] }), true],
  [new RegExp(`^Disconnecting ${N} \\(\\/(.+):(\\d+)\\): (.*)$`), 'disconnecting', (m) => ({ name: m[1], ip: m[2], reason: m[4] })],
  [new RegExp(`^${N} \\(\\/(.+):(\\d+)\\) lost connection: (.*)$`), 'lost', (m) => ({ name: m[1], ip: m[2], reason: m[4] })],
  [new RegExp(`^${N} lost connection: (.*)$`), 'lost', (m) => ({ name: m[1], ip: null, reason: m[2] })],
  [new RegExp(`^(?:\\[Not Secure\\] )?<${N}> (.*)$`), 'chat', (m) => ({ name: m[1], text: m[2] })],
  [new RegExp(`^${N} issued server command: (\\/.*)$`), 'command', (m) => ({ name: m[1], command: m[2] })],
  [new RegExp(`^${N} moved too quickly! (.*)$`), 'moved-quickly', (m) => ({ name: m[1], detail: m[2] })],
  [new RegExp(`^${N} moved wrongly!$`), 'moved-wrongly', (m) => ({ name: m[1] })],
  [new RegExp(`^Teleported ${N} to `), 'teleported', (m) => ({ name: m[1] }), true],
  [new RegExp(`^${N} was kicked for floating too long!$`), 'floating-kick', (m) => ({ name: m[1] })],
  [new RegExp(`^${N} has the following entity data: (.*)$`), 'data', (m) => ({ name: m[1], value: m[2] }), true],
  [/^No entity was found$/, 'noEntity', () => ({}), true],
  [/^Found no elements matching (.+)$/, 'noElements', (m) => ({ path: m[1] }), true],
  [/^Test passed$/, 'testPassed', () => ({}), true],
  [/^Test failed/, 'testFailed', () => ({}), true],
  [/^Saved the (?:game|world)$/, 'saved', () => ({}), true],
  [/^Replaced (\d+) slots?\b/, 'replaced', (m) => ({ count: Number(m[1]) }), true],
];

/** @returns {{type:string, [k:string]:any}|null} */
function parseLine(line) {
  line = String(line).replace(ANSI, '');
  let p = null;
  for (const re of PREFIXES) { p = re.exec(line); if (p) break; }
  if (!p) return null;
  let t = line.slice(p[0].length);
  let sys = false;
  if (t.startsWith('System chat: ')) { t = t.slice(13); sys = true; }
  // Chat and /say lines start with "<", "[Not Secure] <", "[" or "*": whatever a player typed is behind that, so it can never
  // be taken for the server's own answer, even on servers that print answers without the "System chat:" prefix (Paper).
  const chatLike = /^(?:[<\[*])/.test(t);
  for (const [re, type, build, sysOnly] of RULES) {
    // "System chat:" lines are the server's own answers and system messages; the others are plain log lines.
    if (sysOnly) { if (!sys && chatLike) continue; }
    else if (sys && !(type === 'join' || type === 'leave')) continue;
    const m = re.exec(t);
    if (m) return { type, ...build(m) };
  }
  return null;
}

const NAME_RE = /^[A-Za-z0-9_.]{1,16}$/;
module.exports = { parseLine, NAME_RE };
