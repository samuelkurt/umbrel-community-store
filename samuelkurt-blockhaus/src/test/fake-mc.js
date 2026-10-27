'use strict';
// Stand-in for `java -jar server.jar nogui`, used by the tests of lib/local.js. Behaves like a Minecraft server as far
// as the panel can tell: log lines, "Done", Server List Ping, console commands, stop.
// Control files in the working directory: `delay` (ms until "Done"), `hang` (ignore "stop"), `grandchild` (start a child
// process and write its pid to grandchild.pid), `slow-exit` (ms between "Stopping server" and exit).
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mcping = require('../lib/mcping');

const ts = () => new Date().toTimeString().slice(0, 8);
// like the real server, every line also goes to logs/latest.log (the panel reads command answers from there)
fs.mkdirSync('logs', { recursive: true }); fs.writeFileSync('logs/latest.log', '');
const log = (m, lvl = 'INFO', th = 'Server thread') => { const line = `[${ts()}] [${th}/${lvl}]: ${m}\n`; process.stdout.write(line); try { fs.appendFileSync('logs/latest.log', line); } catch { /* folder gone */ } };
const read = (f, d) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };

let port = 25565; let max = 20;
const pr = read('server.properties', '');
let m = /^server-port=(\d+)/m.exec(pr); if (m) port = Number(m[1]);
m = /^max-players=(\d+)/m.exec(pr); if (m) max = Number(m[1]);
if (!/eula\s*=\s*true/i.test(read('eula.txt', ''))) { log('You need to agree to the EULA in order to run the server. Go to eula.txt for more info.', 'WARN'); process.exit(1); }
if (!pr) fs.writeFileSync('server.properties', `server-port=${port}\nmax-players=${max}\nlevel-name=world\nmotd=Fake\n`);
fs.mkdirSync('world', { recursive: true });
if (!fs.existsSync('world/level.dat')) fs.writeFileSync('world/level.dat', 'x'.repeat(2048));

const players = new Set();
const pos = new Map(); // name -> [x, y, z]; set with `posset <name> x y z`, read with `data get entity <name> Pos`
let ready = false;
log('Starting minecraft server version 26.3');
log(`JVM args: ${JSON.stringify(process.argv.slice(2))}`, 'INFO', 'main');

if (fs.existsSync('grandchild')) {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  fs.writeFileSync('grandchild.pid', String(c.pid));
}

const srv = net.createServer((s) => {
  let buf = Buffer.alloc(0);
  s.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    const l1 = mcping.readVarInt(buf, 0); if (!l1 || buf.length < l1.next + l1.value) return;
    const rest = buf.subarray(l1.next + l1.value);
    const l2 = mcping.readVarInt(rest, 0); if (!l2 || rest.length < l2.next + l2.value) return;
    s.write(mcping.packet(0, mcping.str(JSON.stringify({
      version: { name: '26.3', protocol: 800 }, description: { text: 'Fake MOTD' },
      players: { online: players.size, max, sample: [...players].map((n) => ({ name: n, id: '0' })) },
    }))));
  });
  s.on('error', () => {});
});
srv.listen(port, '0.0.0.0');

setTimeout(() => { ready = true; log('Done (0.15s)! For help, type "help"'); }, Number(read('delay', '150')));

let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!cmd) continue;
    if (cmd === 'stop') {
      if (fs.existsSync('hang')) { log('(ignoring stop)', 'WARN'); continue; }
      log('Stopping server');
      srv.close();
      setTimeout(() => process.exit(0), Number(read('slow-exit', '30')));
    } else if (cmd === 'crash') { log('Encountered an unexpected exception', 'ERROR'); process.exit(3); }
    else if (cmd.startsWith('join ')) { const n = cmd.slice(5); players.add(n); log(`${n} joined the game`); }
    else if (cmd === 'save-all flush') { log('System chat: Saving the game (this may take a moment!)'); log('System chat: Saved the game'); }
    else if (/^gamerule [a-z_]+ \S+$/.test(cmd)) { const [, n, v] = cmd.split(' '); log(`System chat: Game rule ${n} is now set to ${v}`); }
    else if (cmd === 'reload') log('System chat: Reloading!');
    else if (cmd === 'datapack list enabled') {
      const on = fs.existsSync('world/datapacks/blockhaus_noend/pack.mcmeta') && !fs.existsSync('disabled-blockhaus_noend');
      log(`System chat: There are ${on ? 2 : 1} data pack(s) enabled: [vanilla (built-in)]${on ? ', [file/blockhaus_noend (world)]' : ''}`);
    }
    else if (cmd.startsWith('datapack disable ')) { fs.writeFileSync('disabled-blockhaus_noend', '1'); log('System chat: Disabling data pack [file/blockhaus_noend (world)]'); }
    else if (cmd.startsWith('posset ')) { const [, n, x, y, z] = cmd.split(' '); pos.set(n, [Number(x), Number(y), Number(z)]); }
    else if (cmd.startsWith('data get entity ')) {
      const [n, p] = cmd.slice(16).split(' ');
      const say = (t) => log(`System chat: ${t}`);
      if (!players.has(n)) { say('No entity was found'); continue; }
      const P = pos.get(n) || [0, 64, 0];
      const A = { Pos: `[${P[0]}d, ${P[1]}d, ${P[2]}d]`, OnGround: '1b', Dimension: '"minecraft:overworld"', FallFlying: '0b', playerGameType: '0', Health: '20.0f',
        abilities: '{invulnerable: 0b, mayfly: 0b, instabuild: 0b, walkSpeed: 0.1f, mayBuild: 1b, flying: 0b, flySpeed: 0.05f}' };
      if (A[p] !== undefined) say(`${n} has the following entity data: ${A[p]}`); else say(`Found no elements matching ${p}`);
    }
    else if (cmd.startsWith('leave ')) { const n = cmd.slice(6); players.delete(n); log(`${n} left the game`); }
    else log(`echo: ${cmd}`);
  }
});
process.stdin.on('end', () => { /* parent gone */ });
process.on('SIGTERM', () => process.exit(143));
void ready;
