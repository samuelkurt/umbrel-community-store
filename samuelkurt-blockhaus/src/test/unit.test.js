'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const props = require('../lib/props');
const state = require('../lib/state');
const players = require('../lib/players');

const SAMPLE = `#Minecraft server properties
#Mon Oct 13 12:00:00 CEST 2026
allow-flight=false
motd=A Minecraft Server
max-players=20
level-seed=
white-list=false
`;

test('props: parse reads values and skips comments', () => {
  const p = props.parse(SAMPLE);
  assert.equal(p.values['max-players'], '20');
  assert.equal(p.values['level-seed'], '');
  assert.equal(p.values['#Minecraft server properties'], undefined);
});

test('props: apply changes only the touched lines and keeps the rest byte-identical', () => {
  const p = props.parse(SAMPLE);
  const out = props.apply(p, { 'max-players': '8', 'new-key': 'x' });
  assert.equal(out, SAMPLE.replace('max-players=20', 'max-players=8') + 'new-key=x\n');
});

test('props: special characters survive a round trip', () => {
  const motd = 'Hallo: Welt = §aGrün\\ #1!';
  const out = props.apply(props.parse(SAMPLE), { motd });
  assert.ok(!/[^\x00-\x7f]/.test(out), 'file stays ASCII');
  assert.equal(props.parse(out).values.motd, motd);
});

test('props: CRLF files stay CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const out = props.apply(props.parse(crlf), { 'max-players': '5' });
  assert.ok(out.includes('max-players=5\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('props: rejects keys with newlines', () => {
  assert.throws(() => props.apply(props.parse(SAMPLE), { 'a\nb': '1' }));
});

test('props: value with newline cannot inject a new key', () => {
  const out = props.apply(props.parse(SAMPLE), { motd: 'x\nop-permission-level=4' });
  const back = props.parse(out);
  assert.equal(back.values['op-permission-level'], undefined);
  assert.equal(back.values.motd, 'x\nop-permission-level=4');
});

test('state: parsePlayers handles JSON, python-style and garbage', () => {
  assert.deepEqual(state.parsePlayers('[]'), []);
  assert.deepEqual(state.parsePlayers("['Steve', 'Alex']"), ['Steve', 'Alex']);
  assert.deepEqual(state.parsePlayers('["Steve"]'), ['Steve']);
  assert.deepEqual(state.parsePlayers('nonsense'), []);
  assert.deepEqual(state.parsePlayers(undefined), []);
});

test('state: deriveState phases', () => {
  const log = (s) => s;
  assert.equal(state.deriveState({ running: false }), 'offline');
  assert.equal(state.deriveState({ running: false, crashed: true }), 'crashed');
  assert.equal(state.deriveState({ running: true }, log('Starting minecraft server version 1.21')), 'starting');
  assert.equal(state.deriveState({ running: true }, log('Starting minecraft server version 1.21\nDone (4.2s)! For help')), 'online');
  assert.equal(state.deriveState({ running: true, int_ping_results: true }, ''), 'online');
  assert.equal(state.deriveState({ running: true, int_ping_results: true }, 'Starting minecraft server\nDone (4.2s)!\n[Server thread/INFO]: Stopping server'), 'stopping');
  // an old Done from the previous run must not make a fresh start look ready
  assert.equal(state.deriveState({ running: true }, 'Done (3s)!\nStopping server\nStarting minecraft server version 1.21'), 'starting');
});

test('state: software and memory guesses', () => {
  assert.equal(state.guessSoftware('vanilla.jar'), 'Vanilla');
  assert.equal(state.guessSoftware('paper-1.21.jar'), 'Paper');
  assert.equal(state.guessSoftware('fabric-server-launch.jar'), 'Fabric');
  assert.equal(state.guessSoftware('neoforge-installer.jar'), 'NeoForge');
  assert.equal(state.parseMaxMemoryMb('java -Xms1000M -Xmx6000M -jar x'), 6000);
  assert.equal(state.parseMaxMemoryMb('java -Xmx4G -jar x'), 4096);
  assert.equal(state.parseMaxMemoryMb('java -jar x'), null);
});

test('players: offline UUID matches the value Minecraft computes', () => {
  assert.equal(players.offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('players: input validation blocks command injection', () => {
  assert.throws(() => players.normalizeKey('whitelist', 'Steve\nstop'));
  assert.throws(() => players.normalizeKey('ops', 'a b'));
  assert.throws(() => players.normalizeKey('banned-ips', '999.1.1.1'));
  assert.equal(players.normalizeKey('banned-ips', '10.0.0.7'), '10.0.0.7');
  assert.equal(players.normalizeKey('whitelist', 'Steve_01'), 'Steve_01');
  assert.equal(players.commandFor('banned-players', 'remove', 'Steve'), 'pardon Steve');
  assert.equal(players.commandFor('ops', 'add', 'Steve'), 'op Steve');
});
