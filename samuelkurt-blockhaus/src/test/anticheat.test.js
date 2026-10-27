'use strict';
// Anticheat: parser (real log lines of a Minecraft 26.3 server), item rules, score/flag store, the checks with a simulated
// server, the file checks, and the whole way through Local + HTTP with the fake Java.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const nbt = require('../lib/nbt');
const software = require('../lib/software');
const { parseLine } = require('../lib/anticheat/logscan');
const items = require('../lib/anticheat/items');
const xray = require('../lib/anticheat/xray');
const motion = require('../lib/anticheat/motion');
const { Store, normalizeConfig, DEFAULTS } = require('../lib/anticheat/store');
const { Anticheat, Asker } = require('../lib/anticheat');
const { createApp } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-ac-'));
const L = (body, lvl = 'INFO') => `[12:16:38] [Server thread/${lvl}]: ${body}`;

// ---- parser ---------------------------------------------------------------------------------------------------
test('logscan: recognises the lines a real 26.3 server prints', () => {
  assert.deepEqual(parseLine(L('Bot01[/127.0.0.1:37386] logged in with entity id 15 at (-524.5, 65.0, 69.5)')), { type: 'login', name: 'Bot01', ip: '127.0.0.1', port: 37386, entityId: 15, pos: [-524.5, 65, 69.5] });
  assert.deepEqual(parseLine(L('Bot01[/0:0:0:0:0:0:0:1:5555] logged in with entity id 1 at (0.0, 64.0, 0.0)')).ip, '0:0:0:0:0:0:0:1');
  assert.deepEqual(parseLine(L('System chat: Bot01 joined the game')), { type: 'join', name: 'Bot01' });
  assert.deepEqual(parseLine(L('System chat: Bot01 left the game')), { type: 'leave', name: 'Bot01' });
  assert.deepEqual(parseLine(L('System chat: Bot01 has the following entity data: [-526.2d, 64.0d, 75.1d]')), { type: 'data', name: 'Bot01', value: '[-526.2d, 64.0d, 75.1d]' });
  assert.deepEqual(parseLine(L('System chat: Found no elements matching RootVehicle')), { type: 'noElements', path: 'RootVehicle' });
  assert.equal(parseLine(L('System chat: No entity was found')).type, 'noEntity');
  assert.equal(parseLine(L('System chat: Test passed')).type, 'testPassed');
  assert.deepEqual(parseLine(L('Disconnecting Bot01 (/127.0.0.1:35368): You are not white-listed on this server!')), { type: 'disconnecting', name: 'Bot01', ip: '127.0.0.1', reason: 'You are not white-listed on this server!' });
  assert.deepEqual(parseLine(L('Spam1 lost connection: Kicked for spamming')), { type: 'lost', name: 'Spam1', ip: null, reason: 'Kicked for spamming' });
  assert.deepEqual(parseLine(L('[Not Secure] <Spam1> hallo 3')), { type: 'chat', name: 'Spam1', text: 'hallo 3' });
  assert.deepEqual(parseLine(L('<Anna> hi')), { type: 'chat', name: 'Anna', text: 'hi' });
  assert.deepEqual(parseLine(L('Hov1 moved too quickly! -520.5,64.0,70.5', 'WARN')), { type: 'moved-quickly', name: 'Hov1', detail: '-520.5,64.0,70.5' });
  assert.deepEqual(parseLine(L('Run6 moved wrongly!', 'WARN')), { type: 'moved-wrongly', name: 'Run6' });
  assert.deepEqual(parseLine(L('System chat: Teleported Idle1 to -529.500000, 64.000000, 70.500000')), { type: 'teleported', name: 'Idle1' });
  assert.equal(parseLine(L('Done (0.429s)! For help, type "help"')), null);
  assert.equal(parseLine('[Blockhaus] Server wird gestartet …'), null);
});

test('logscan: the log formats of Vanilla, Forge/NeoForge, Fabric and Paper, and colour codes', () => {
  const forge = (b) => `[18Oct2026 20:19:06.771] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: ${b}`;
  assert.deepEqual(parseLine(forge('System chat: Fg05 left the game')), { type: 'leave', name: 'Fg05' });
  assert.deepEqual(parseLine(forge('System chat: Bot01 has the following entity data: [1.5d, 64.0d, 2.5d]')), { type: 'data', name: 'Bot01', value: '[1.5d, 64.0d, 2.5d]' });
  assert.equal(parseLine('[18Oct2026 20:19:06.784] [Server thread/INFO] [net.minecraft.server.network.ServerGamePacketListenerImpl/]: Fg07 lost connection: Disconnected').type, 'lost');
  assert.equal(parseLine(forge('System chat: Found no elements matching Inventory[{Slot:3b}]')).type, 'noElements');
  assert.equal(parseLine(forge('System chat: Saved the game')).type, 'saved');
  assert.equal(parseLine('[12:16:38] [Server thread/INFO] (Minecraft) System chat: Test passed').type, 'testPassed');
  assert.equal(parseLine('[12:16:38 INFO]: Bot01 has the following entity data: 5').type, 'data');
  assert.equal(parseLine('[12:16:38 WARN]: Hov1 moved too quickly! 1,2,3').type, 'moved-quickly');
  assert.equal(parseLine('[12:16:38] [Server thread/INFO]: \x1b[0mSystem chat: Bot01 joined the game').type, 'join');
  assert.equal(parseLine('\x1b[32m[12:16:38] [Server thread/INFO]: System chat: Saved the world\x1b[0m').type, 'saved');
});

test('logscan: a player cannot fake server messages with chat', () => {
  // everything after "<Name> " is chat text, however much it looks like a server line
  for (const body of ['<Evil> System chat: Test passed', '<Evil> Bob has the following entity data: [1d, 2d, 3d]', '<Evil> Bob moved too quickly! 1,2,3', '[Not Secure] <Evil> Bob joined the game']) {
    assert.equal(parseLine(L(body)).type, 'chat', body);
  }
  // and a "System chat:" prefix is only accepted for the server's own answers
  assert.equal(parseLine(L('System chat: <Evil> hi')), null);
  assert.equal(parseLine('Bob moved too quickly! 1,2,3'), null); // no log prefix at all
  // servers that print their answers without "System chat:" (Paper) are understood, but never from chat-like lines
  assert.equal(parseLine(L('Bob has the following entity data: [1d, 2d, 3d]')).type, 'data');
  for (const body of ['[Evil] Bob has the following entity data: [1d]', '* Evil Bob has the following entity data: [1d]', '<Evil> No entity was found', '[Not Secure] <Evil> Test passed']) {
    assert.ok(!parseLine(L(body)) || ['chat'].includes(parseLine(L(body)).type), body);
  }
});

// ---- items ----------------------------------------------------------------------------------------------------
test('items: flags what survival cannot produce and ignores normal gear', () => {
  const msgs = (raw, where) => items.scan(raw, where).map((f) => f.type);
  assert.deepEqual(msgs([{ id: 'minecraft:bedrock', count: 1 }]), ['illegal-item']);
  assert.deepEqual(msgs([{ id: 'minecraft:zombie_spawn_egg', count: 1 }, { id: 'minecraft:spawner', count: 1 }, { id: 'minecraft:debug_stick', count: 1 }]), ['illegal-item', 'illegal-item', 'illegal-item']);
  assert.deepEqual(msgs([{ id: 'minecraft:diamond_sword', count: 1, components: { 'minecraft:enchantments': { 'minecraft:sharpness': 5, 'minecraft:looting': 3, 'minecraft:unbreaking': 3 } } }]), []);
  assert.deepEqual(msgs([{ id: 'minecraft:diamond_sword', count: 1, components: { 'minecraft:enchantments': { 'minecraft:sharpness': 6 } } }]), ['over-enchant']);
  assert.deepEqual(msgs([{ id: 'minecraft:enchanted_book', count: 1, components: { 'minecraft:stored_enchantments': { 'minecraft:protection': 9 } } }]), ['over-enchant']);
  assert.deepEqual(msgs([{ id: 'minecraft:enchanted_book', count: 1, components: { 'minecraft:stored_enchantments': { 'minecraft:mending': 1, 'minecraft:fortune': 3 } } }]), []);
  assert.deepEqual(msgs([{ id: 'minecraft:ender_pearl', count: 17 }]), ['over-stack']);
  assert.deepEqual(msgs([{ id: 'minecraft:ender_pearl', count: 16 }, { id: 'minecraft:cobblestone', count: 64 }, { id: 'minecraft:diamond_pickaxe', count: 1 }]), []);
  assert.deepEqual(msgs([{ id: 'minecraft:cobblestone', count: 65 }]), ['over-stack']);
  assert.deepEqual(msgs([{ id: 'minecraft:stick', count: 1, components: { 'minecraft:unbreakable': {} } }]), ['unbreakable']);
  // old format
  assert.deepEqual(msgs([{ id: 'minecraft:diamond_sword', Count: 1, tag: { Enchantments: [{ id: 'minecraft:sharpness', lvl: 32767 }] } }]), ['over-enchant']);
  // hidden inside a shulker box inside a shulker box
  const deep = { id: 'minecraft:shulker_box', count: 1, components: { 'minecraft:container': [{ slot: 0, item: { id: 'minecraft:shulker_box', count: 1, components: { 'minecraft:container': [{ slot: 3, item: { id: 'minecraft:command_block', count: 1 } }] } } }] } };
  const f = items.scan([deep], 'Endertruhe');
  assert.equal(f.length, 1); assert.match(f[0].message, /Endertruhe › shulker_box › shulker_box: command_block/);
});

test('xray: needs enough ore and a high share; ordinary mining is not flagged', () => {
  const mk = (rare, stone) => ({ stats: { 'minecraft:mined': { 'minecraft:stone': stone, 'minecraft:diamond_ore': rare, 'minecraft:dirt': 50 } } });
  assert.equal(xray.judge(xray.summarize(mk(10, 100))), null);        // too few ores, even though the share is high
  assert.equal(xray.judge(xray.summarize(mk(20, 2000))), null);       // many blocks, normal share
  const j = xray.judge(xray.summarize(mk(30, 400)));
  assert.ok(j && j.rare === 30 && j.total === 480);
  assert.equal(xray.summarize({ stats: { 'minecraft:custom': {} } }), null);
  assert.equal(xray.summarize(null), null);
});

// ---- store ----------------------------------------------------------------------------------------------------
test('store: merging, scores, decay, ack, clear, trimming', () => {
  const dir = tmpdir(); let T = 1e9;
  const st = new Store(dir, 'srv', () => T);
  const a = st.add({ player: 'Bob', type: 'speed', key: 'speed', points: 3, message: 'm1' });
  assert.equal(a.isNew, true);
  assert.equal(st.add({ player: 'bob', type: 'speed', key: 'speed', points: 3, message: 'm2' }).isNew, false); // same finding, other case
  assert.equal(st.flags.length, 1); assert.equal(st.flags[0].count, 1); // rescan within 10 min is no new occurrence
  T += 11 * 60000;
  st.add({ player: 'Bob', type: 'speed', key: 'speed', points: 3, message: 'm3' });
  assert.equal(st.flags[0].count, 2);
  assert.equal(st.add({ player: 'Bob', type: 'speed', key: 'other', points: 3, message: 'x' }).isNew, true);
  const s1 = st.scores().get('bob');
  assert.equal(s1.open, 2); assert.ok(s1.score > 8 && s1.score <= 9, String(s1.score));
  assert.equal(s1.level, 'warn');
  T += 30 * 60000; // one half-life later
  assert.ok(st.scores().get('bob').score < s1.score * 0.55);
  assert.equal(st.ack({ player: 'Bob' }), 2);
  assert.equal(st.scores().get('bob').score, 0); assert.deepEqual(st.openCount(), { open: 0, high: 0 });
  // a new occurrence after the gap re-opens the flag
  T += 11 * 60000; st.add({ player: 'Bob', type: 'speed', key: 'speed', points: 3, message: 'again' });
  assert.equal(st.flags.find((f) => f.key === 'speed').ack, false);
  // server-level flag (no player) does not score anyone
  st.add({ type: 'flood', key: '1.2.3.4', points: 0, message: 'f' });
  assert.equal(st.scores().size, 1);
  // persisted
  st.flush();
  const again = new Store(dir, 'srv', () => T);
  assert.equal(again.flags.length, 3);
  assert.equal(again.clear({ acked: true }), 1);
  assert.equal(again.clear({ player: 'Bob' }), 1);
  assert.equal(again.clear({ all: true }), 1);
  // trimming prefers acknowledged, then oldest
  const st2 = new Store(tmpdir(), 'x', () => T); st2.config.keepFlags = 100;
  for (let i = 0; i < 105; i++) { T += 1; st2.add({ player: 'P' + i, type: 't', points: 1, message: String(i) }); }
  assert.equal(st2.flags.length, 100);
  assert.equal(st2.flags[0].message, '5');
});

test('config: unknown or invalid values are ignored, numbers are clamped, lists validated', () => {
  const c = normalizeConfig({ enabled: 'yes', bogus: 1, checks: { fly: false, nope: true, speed: 'x' }, thresholds: { speedBps: 9999, pollSec: 'abc', floodJoins: 1, highPoints: 2, warnPoints: 40 }, exempt: ['Anna', '../etc', 'a b', 'Bob_2'],
    allow: { mods: { enabled: true, entries: [{ file: 'a.jar', sha256: 'a'.repeat(64) }, { file: 'b.jar', sha256: 'zz' }, { sha256: 'a'.repeat(64) }] }, packs: { entries: [{ sha1: 'b'.repeat(40), name: 'P' }, { sha1: 'x' }] } } });
  assert.equal(c.enabled, true); assert.equal(c.bogus, undefined); assert.equal(c.checks.fly, false); assert.equal(c.checks.speed, true); assert.equal(c.checks.nope, undefined);
  assert.equal(c.thresholds.speedBps, 100); assert.equal(c.thresholds.pollSec, DEFAULTS.thresholds.pollSec); assert.equal(c.thresholds.floodJoins, 2);
  assert.ok(c.thresholds.highPoints > c.thresholds.warnPoints);
  assert.deepEqual(c.exempt, ['Anna', 'Bob_2']);
  assert.equal(c.allow.mods.enabled, true); assert.equal(c.allow.mods.entries.length, 1);
  assert.deepEqual(c.allow.packs.entries, [{ sha1: 'b'.repeat(40), name: 'P' }]);
  assert.deepEqual(normalizeConfig(undefined), DEFAULTS);
});

test('motion: parsing of the server\'s answers; speed limit grows with Speed potions', () => {
  assert.deepEqual(motion.parsePos('[-526.2d, 64.0d, 75.1d]'), [-526.2, 64, 75.1]);
  assert.deepEqual(motion.parsePos('[1.0E-4d, 2d, 3d]'), [0.0001, 2, 3]);
  assert.equal(motion.parsePos('[1d, 2d]'), null); assert.equal(motion.parsePos('nonsense'), null);
  assert.equal(motion.parseBool('1b'), true); assert.equal(motion.parseBool('0b'), false); assert.equal(motion.parseBool('x'), null);
  assert.equal(motion.parseStr('"minecraft:the_nether"'), 'minecraft:the_nether');
  assert.equal(motion.speedLimit(12, []), 12); assert.ok(Math.abs(motion.speedLimit(12, [{ id: 'speed', amp: 1 }]) - 16.8) < 1e-9);
  assert.match(motion.excuse({ vehicle: true }), /Fahrzeug/); assert.match(motion.excuse({ mode: 1 }), /Kreativ/); assert.match(motion.excuse({ fallFlying: true }), /Elytra/);
  assert.equal(motion.excuse({ vehicle: false, mode: 0, abilities: { mayfly: false, flying: false }, effects: [] }), null);
  assert.match(motion.excuse({ mode: 0, effects: [{ id: 'levitation', amp: 0 }] }, { forFly: true }), /levitation/);
});

test('asker: one query at a time, in order, with timeout', async () => {
  const sent = []; let a;
  a = new Asker((c) => { sent.push(c); });
  const p1 = a.ask('one', (e) => e.type === 'x', 500);
  const p2 = a.ask('two', (e) => e.type === 'y', 60);
  await sleep(5);
  assert.deepEqual(sent, ['one']);
  assert.equal(a.feed({ type: 'y' }), false);     // not the pending query's answer
  assert.equal(a.feed({ type: 'x' }), true);
  assert.deepEqual(await p1, { type: 'x' });
  await sleep(5);
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(await p2, null);                   // no answer: resolves null, does not block
  assert.equal(a.feed({ type: 'y' }), false);
  const p3 = a.ask('three', () => true, 1000); await sleep(5); a.reset(); assert.equal(await p3, null);
});

// ---- the checks with a simulated server ------------------------------------------------------------------------
function rig({ now = 1e9 } = {}) {
  const root = tmpdir();
  const serversDir = path.join(root, 'servers'); const dir = path.join(serversDir, 't'); fs.mkdirSync(dir, { recursive: true });
  const world = new Map();
  const writePlayers = () => {
    const names = [...world.keys()];
    fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify(names.map((n, i) => ({ name: n, uuid: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}` }))));
    fs.mkdirSync(path.join(dir, 'world', 'players', 'data'), { recursive: true });
    names.forEach((n, i) => {
      const its = [...(world.get(n).items || new Map())];
      const mk = (pre) => ({ t: 'list', of: 'compound', v: its.filter(([k]) => k.startsWith(pre + '[')).map(([k, v]) => ({ Slot: { t: 'byte', v: Number(/Slot:(-?\d+)b/.exec(k)[1]) }, id: { t: 'string', v: v.id }, count: { t: 'int', v: 1 },
        ...(v.box ? { components: { t: 'compound', v: { 'minecraft:container': { t: 'list', of: 'compound', v: [{ slot: { t: 'int', v: 0 }, item: { t: 'compound', v: { id: { t: 'string', v: 'minecraft:bedrock' }, count: { t: 'int', v: 1 } } } }] } } } } : {}) })) });
      const eq = {}; for (const [k, v] of its) if (k.startsWith('equipment.')) eq[k.slice(10)] = { t: 'compound', v: { id: { t: 'string', v: v.id }, count: { t: 'int', v: 1 } } };
      fs.writeFileSync(path.join(dir, 'world', 'players', 'data', `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}.dat`), nbt.encode('', { playerGameType: { t: 'int', v: world.get(n).mode || 0 }, Inventory: mk('Inventory'), EnderItems: mk('EnderItems'), equipment: { t: 'compound', v: eq } }, { gzip: true }));
    });
  };
  const local = {
    lineHooks: new Set(), rt: new Map(), registry: { servers: [{ id: 's1', name: 'T', dir: 't' }] }, sent: [], shown: [], hidden: [],
    need(id) { const r = this.registry.servers.find((s) => s.id === id); if (!r) throw new Error('weg'); return r; },
    dirOf(rec) { return path.join(serversDir, rec.dir); },
    line(body, lvl) { const text = L(body, lvl); let hide = false; for (const h of this.lineHooks) if (h('s1', text) === true) hide = true; (hide ? this.hidden : this.shown).push(text); return hide; },
    async stdin(id, cmd) {
      this.sent.push(cmd);
      setImmediate(() => {
        let m = /^item replace entity (\S+) (\S+) with (\S+)$/.exec(cmd);
        if (m) {
          const p = world.get(m[1]); if (!p || !p.items) return this.line('System chat: No entity was found');
          const sl = /^(container|enderchest)\.(\d+)$/.exec(m[2]);
          const key = sl ? `${sl[1] === 'container' ? 'Inventory' : 'EnderItems'}[{Slot:${sl[2]}b}]` : m[2].replace(/^armor\./, 'equipment.').replace('weapon.offhand', 'equipment.offhand');
          const id = m[3].replace(/\[.*$/, '');
          if (!p.stuck) { if (id === 'minecraft:air') p.items.delete(key); else p.items.set(key, { id, box: /^minecraft:shulker_box\[/.test(m[3]) }); }
          return this.line(`System chat: Replaced 1 slot(s) on ${m[1]} with [Air]`);
        }
        if (cmd === 'save-all flush') { writePlayers(); return this.line('System chat: Saved the game'); }
        m = /^data get entity (\S+) (Inventory|EnderItems|equipment)$/.exec(cmd);
        if (m) {
          const p = world.get(m[1]); if (!p) return this.line('System chat: No entity was found');
          const its = [...(p.items || new Map())];
          if (m[2] === 'equipment') {
            const eq = its.filter(([k]) => k.startsWith('equipment.'));
            if (!eq.length) return this.line('System chat: Found no elements matching equipment');
            return this.line(`System chat: ${m[1]} has the following entity data: {${eq.map(([k, v]) => `${k.slice(10)}: {id: "${v.id}", count: 1}`).join(', ')}}`);
          }
          const l = its.filter(([k]) => k.startsWith(m[2] + '[')).map(([k, v]) => `{Slot: ${/Slot:(-?\d+)b/.exec(k)[1]}b, id: "${v.id}", count: 1${v.box ? ', components: {"minecraft:container": [{slot: 0, item: {id: "minecraft:bedrock", count: 1}}]}' : ''}}`);
          return this.line(`System chat: ${m[1]} has the following entity data: [${l.join(', ')}]`);
        }
        m = /^data get entity (\S+) ((?:Inventory|EnderItems)\[\{Slot:-?\d+b\}\]|equipment\.\w+)(\.id)?$/.exec(cmd);
        if (m) {
          const p = world.get(m[1]); if (!p) return this.line('System chat: No entity was found');
          const it = p.items && p.items.get(m[2]);
          if (!it) return this.line(`System chat: Found no elements matching ${m[2]}${m[3] || ''}`);
          return this.line(`System chat: ${m[1]} has the following entity data: ${m[3] ? `"${it.id}"` : `{id: "${it.id}", count: 1}`}`);
        }
        m = /^data get entity (\S+) (\S+)$/.exec(cmd);
        if (m) {
          const p = world.get(m[1]);
          if (!p) return this.line('System chat: No entity was found');
          const v = { Pos: `[${p.pos[0]}d, ${p.pos[1]}d, ${p.pos[2]}d]`, OnGround: p.ground ? '1b' : '0b', Dimension: `"${p.dim || 'minecraft:overworld'}"`, FallFlying: p.fall ? '1b' : '0b', playerGameType: String(p.mode || 0),
            Health: `${p.hp === undefined ? 20 : p.hp}.0f`, abilities: `{invulnerable: 0b, mayfly: ${p.mayfly ? 1 : 0}b, instabuild: 0b, flying: 0b}` }[m[2]];
          if (m[2] === 'RootVehicle') return p.vehicle ? this.line(`System chat: ${m[1]} has the following entity data: {Entity: {id: "minecraft:boat"}}`) : this.line('System chat: Found no elements matching RootVehicle');
          if (m[2] === 'active_effects') return p.effects ? this.line(`System chat: ${m[1]} has the following entity data: [${p.effects.map((e) => `{id: "minecraft:${e[0]}", amplifier: ${e[1]}b, duration: 99}`).join(', ')}]`) : this.line('System chat: Found no elements matching active_effects');
          return this.line(`System chat: ${m[1]} has the following entity data: ${v}`);
        }
        m = /^execute as (\S+) at @s if block/.exec(cmd);
        if (m) { const p = world.get(m[1]); if (!p) return this.line('System chat: No entity was found'); this.line(p.air !== false ? 'System chat: Test passed' : 'System chat: Test failed'); }
      });
    },
  };
  let T = now;
  const ac = new Anticheat({ dataDir: path.join(root, 'data'), local, now: () => T, tickMs: 3600000 }).start();
  const online = (...names) => local.rt.set('s1', { proc: {}, state: 'online', players: new Set(names), lines: [] });
  const add = (name, o = {}) => world.set(name, { pos: [0, 64, 0], ground: true, ...o });
  const flags = (type) => ac.store('s1').flags.filter((f) => !type || f.type === type);
  const poll = async (dt = 4000) => { T += dt; await ac._poll('s1'); };
  return { root, dir, ac, local, world, add, online, flags, poll, tick: (ms) => { T += ms; }, get now() { return T; }, done: () => ac.stop() };
}

test('console checks: chat spam, repeats, vanilla warnings, kicks, flood, many names, exemptions', () => {
  const r = rig();
  try {
    for (let i = 0; i < 7; i++) r.local.line(`[Not Secure] <Anna> nachricht ${i}`);
    assert.equal(r.flags('chat-spam').length, 0);
    r.local.line('[Not Secure] <Anna> nachricht 8');
    assert.equal(r.flags('chat-spam').length, 1); assert.match(r.flags('chat-spam')[0].message, /8 Nachrichten in 10 s/);
    for (let i = 0; i < 4; i++) r.local.line('<Bert> kauf bei xyz');
    assert.equal(r.flags('chat-spam').filter((f) => f.player === 'Bert').length, 1);
    // vanilla warnings: only a series counts
    for (let i = 0; i < 4; i++) r.local.line('Cara moved too quickly! 1.0,0.0,0.0', 'WARN');
    assert.equal(r.flags('vanilla-move').length, 0);
    r.local.line('Cara moved too quickly! 1.0,0.0,0.0', 'WARN');
    assert.equal(r.flags('vanilla-move').length, 1);
    r.local.line('Cara was kicked for floating too long!', 'WARN');
    r.local.line('Dan lost connection: Flying is not enabled on this server');
    r.local.line('Eve lost connection: Kicked for spamming');
    assert.equal(r.flags('floating-kick').length, 2); assert.equal(r.flags('spam-kick').length, 1);
    // chat lines that merely look like server messages change nothing
    r.local.line('<Mal> Cara moved too quickly! 1,2,3');
    assert.equal(r.flags('vanilla-move')[0].count, 1);
    // flood: 8 attempts from one address in 30 s (logins and refused attempts both count)
    for (let i = 0; i < 4; i++) r.local.line(`P${i}[/203.0.113.9:${5000 + i}] logged in with entity id ${i} at (0.0, 64.0, 0.0)`);
    for (let i = 0; i < 3; i++) r.local.line(`Disconnecting X${i} (/203.0.113.9:${6000 + i}): You are not white-listed on this server!`);
    assert.equal(r.flags('flood').length, 0);
    r.local.line('Disconnecting X9 (/203.0.113.9:6009): You are not white-listed on this server!');
    assert.equal(r.flags('flood').length, 1); assert.equal(r.flags('flood')[0].player, null);
    assert.equal(r.flags('many-names').length, 1); // P0..P3 = 4 names from a public address
    // private addresses (LAN, tunnels that show 127.0.0.1) are not "many names"
    for (let i = 0; i < 6; i++) r.local.line(`L${i}[/192.168.1.7:${7000 + i}] logged in with entity id ${i} at (0.0, 64.0, 0.0)`);
    assert.equal(r.flags('many-names').length, 1);
    // nothing of this is ever sent to the server or the players
    assert.deepEqual(r.local.sent, []);
  } finally { r.done(); }
});

test('exemptions: operators and listed names are skipped; disabled anticheat records nothing', () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'ops.json'), JSON.stringify([{ uuid: 'x', name: 'Boss', level: 4 }]));
    for (let i = 0; i < 20; i++) { r.local.line(`<Boss> spam ${i}`); r.local.line(`<Frank> spam ${i}`); }
    assert.deepEqual(r.flags('chat-spam').map((f) => f.player), ['Frank']);
    r.ac.setConfig('s1', { exempt: ['Frank'], exemptOps: false });
    for (let i = 0; i < 20; i++) { r.local.line(`<Boss> neu ${i}`); r.local.line(`<Frank> neu ${i}`); }
    assert.deepEqual(r.flags('chat-spam').map((f) => f.player).sort(), ['Boss', 'Frank']);
    r.ac.setConfig('s1', { enabled: false });
    const n = r.flags().length;
    for (let i = 0; i < 30; i++) r.local.line(`<Zed> x${i}`);
    assert.equal(r.flags().length, n);
  } finally { r.done(); }
});

test('polling: query answers stay out of the console, user lines do not; nothing pending means nothing hidden', async () => {
  const r = rig();
  try {
    r.add('Bob'); r.online('Bob');
    await r.poll();
    assert.deepEqual(r.local.sent, ['data get entity Bob Pos', 'data get entity Bob OnGround', 'data get entity Bob Dimension']);
    assert.equal(r.local.hidden.length, 3); assert.equal(r.local.shown.length, 0);
    // an operator running the same command by hand: nothing pending, so it shows
    assert.equal(r.local.line('System chat: Bob has the following entity data: [0d, 64d, 0d]'), false);
    // names that are not valid player names are never put into a command
    r.local.rt.set('s1', { proc: {}, state: 'online', players: new Set(['Bob', 'x; stop', 'Bad Name']), lines: [] });
    r.local.sent.length = 0; await r.poll();
    assert.ok(r.local.sent.every((c) => /^data get entity Bob /.test(c)), r.local.sent.join('|'));
    assert.equal(r.ac.view('s1').status.polledPlayers, 1);
  } finally { r.done(); }
});

test('speed: needs two fast samples in a row and no excuse', async () => {
  const r = rig();
  try {
    r.add('Bob'); r.online('Bob');
    const moveTo = async (x) => { r.world.get('Bob').pos = [x, 64, 0]; await r.poll(); };
    await moveTo(0);
    await moveTo(60);      // 15 blocks/s
    assert.equal(r.flags('speed').length, 0);
    await moveTo(120);
    assert.equal(r.flags('speed').length, 1); assert.match(r.flags('speed')[0].message, /15\.0 Blöcken\/s \(Grenze 12\.0\)/);
    // walking pace never triggers a confirm query
    r.local.sent.length = 0;
    await moveTo(140); await moveTo(160);
    assert.ok(!r.local.sent.some((c) => /RootVehicle/.test(c)));
    // an isolated fast sample resets
    r.flags().length = 0; r.ac.store('s1').clear({ all: true });
    await moveTo(260); await moveTo(262); await moveTo(322);
    assert.equal(r.flags('speed').length, 0);
  } finally { r.done(); }
});

test('speed: vehicle, elytra, creative, Speed potion and dimension changes are excused; teleports by command too', async () => {
  const cases = [['vehicle', { vehicle: true }], ['elytra', { fall: true }], ['creative', { mode: 1 }], ['potion', { effects: [['speed', 1]] }], ['spectator', { mode: 3 }]];
  for (const [name, extra] of cases) {
    const r = rig();
    try {
      r.add('Bob', extra); r.online('Bob');
      for (const x of [0, 60, 120, 180]) { r.world.get('Bob').pos = [x, 64, 0]; await r.poll(); }
      assert.equal(r.flags('speed').length, 0, name);
    } finally { r.done(); }
  }
  const r = rig();
  try {
    r.add('Bob'); r.online('Bob');
    await r.poll();
    r.world.get('Bob').dim = 'minecraft:the_nether'; r.world.get('Bob').pos = [500, 64, 0]; await r.poll();
    r.world.get('Bob').pos = [1500, 64, 0]; r.world.get('Bob').dim = 'minecraft:overworld'; await r.poll();
    assert.equal(r.flags().length, 0, 'portal');
    // a plain jump of 800 blocks is reported as a teleport (information only) ...
    r.world.get('Bob').pos = [3000, 64, 0]; await r.poll();
    assert.equal(r.flags('teleport').length, 1); assert.equal(r.flags('teleport')[0].severity, 'info');
    // ... but not when the console says someone teleported the player
    r.ac.store('s1').clear({ all: true });
    r.local.line('System chat: Teleported Bob to 9000.000000, 64.000000, 0.000000'); r.tick(100);
    r.world.get('Bob').pos = [9000, 64, 0]; await r.poll();
    assert.equal(r.flags().length, 0);
  } finally { r.done(); }
});

test('flying: hovering and climbing are flagged, jumping, water, vehicles and creative are not', async () => {
  const run = async (extra, ys, ground = false) => {
    const r = rig();
    try {
      r.add('Bob', { ground, ...extra }); r.online('Bob');
      for (const y of ys) { r.world.get('Bob').pos = [0, y, 0]; await r.poll(); }
      return r.flags('fly');
    } finally { r.done(); }
  };
  const hover = await run({}, [100, 100, 100, 100, 100]);
  assert.equal(hover.length, 1); assert.equal(hover[0].key, 'hover'); assert.equal(hover[0].severity, 'high');
  const rise = await run({}, [100, 108, 116]);
  assert.equal(rise.length, 1); assert.equal(rise[0].key, 'rise');
  assert.equal((await run({ air: false }, [100, 100, 100, 100, 100])).length, 0, 'water / ladder / floor below');
  assert.equal((await run({ vehicle: true }, [100, 100, 100, 100, 100])).length, 0);
  assert.equal((await run({ mode: 1 }, [100, 100, 100, 100, 100])).length, 0);
  assert.equal((await run({ mayfly: true }, [100, 100, 100, 100, 100])).length, 0);
  assert.equal((await run({ fall: true }, [100, 108, 116])).length, 0);
  assert.equal((await run({ effects: [['levitation', 0]] }, [100, 108, 116])).length, 0);
  assert.equal((await run({ hp: 0 }, [100, 100, 100, 100, 100])).length, 0, 'dead');
  assert.equal((await run({}, [64, 65.2, 64.3, 64.9, 65.1, 64.2])).length, 0, 'bunny hop: off the ground but the height changes');
  assert.equal((await run({}, [64, 64, 64, 64, 64], true)).length, 0, 'standing on the ground');
  // falling is not flying
  assert.equal((await run({}, [100, 70, 40, 10])).length, 0);
});

test('flying: swimming up, treading water and the jump out of the water at the surface are not flying', async () => {
  const r = rig();
  try {
    r.add('Bob', { ground: false }); r.online('Bob');
    const bob = r.world.get('Bob');
    const at = async (y, air) => { bob.pos = [0, y, 0]; bob.air = air; await r.poll(); };
    // a swim up to the surface: two samples in water rising, the third one is the jump out, which is open air for a moment
    await at(70, false); await at(78, false); await at(86, true);
    assert.equal(r.flags('fly').length, 0, 'swim up and jump out');
    // a longer swim, then the jump out
    await at(100, false); await at(108, false); await at(116, false); await at(124, false); await at(131, true);
    assert.equal(r.flags('fly').length, 0, 'long swim and jump out');
    // treading water at the surface
    for (let i = 0; i < 6; i++) await at(95, false);
    assert.equal(r.flags('fly').length, 0, 'floating in water');
    // a real hover later is still found (after the quiet time following the water)
    for (let i = 0; i < 6; i++) await at(150, true);
    assert.equal(r.flags('fly').length, 1); assert.equal(r.flags('fly')[0].key, 'hover');
  } finally { r.done(); }
});

test('files: items in player data, creative and operators skipped, allow-lists for plugins and the resource pack', async () => {
  const r = rig();
  try {
    const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    fs.writeFileSync(path.join(r.dir, 'usercache.json'), JSON.stringify([{ name: 'Cheater', uuid: uuid(1) }, { name: 'Creative', uuid: uuid(2) }, { name: 'Boss', uuid: uuid(3) }, { name: 'Fine', uuid: uuid(4) }]));
    fs.writeFileSync(path.join(r.dir, 'ops.json'), JSON.stringify([{ uuid: uuid(3), name: 'Boss', level: 4 }]));
    fs.mkdirSync(path.join(r.dir, 'world', 'players', 'data'), { recursive: true });
    const inv = (...its) => ({ t: 'list', of: 'compound', v: its.map(([id, count, comp]) => ({ Slot: { t: 'byte', v: 0 }, id: { t: 'string', v: id }, count: { t: 'int', v: count }, ...(comp ? { components: { t: 'compound', v: comp } } : {}) })) });
    const dat = (n, mode, ...its) => fs.writeFileSync(path.join(r.dir, 'world', 'players', 'data', uuid(n) + '.dat'), nbt.encode('', { playerGameType: { t: 'int', v: mode }, Inventory: inv(...its), EnderItems: inv() }, { gzip: true }));
    dat(1, 0, ['minecraft:bedrock', 1], ['minecraft:diamond_sword', 1, { 'minecraft:enchantments': { t: 'compound', v: { 'minecraft:sharpness': { t: 'int', v: 9 } } } }]);
    dat(2, 1, ['minecraft:bedrock', 1]);
    dat(3, 0, ['minecraft:bedrock', 1]);
    dat(4, 0, ['minecraft:diamond_sword', 1], ['minecraft:cobblestone', 64]);
    assert.equal(r.ac.scanItems('s1'), 2);
    assert.deepEqual([...new Set(r.flags().map((f) => f.player))], ['Cheater']);
    assert.deepEqual(r.flags().map((f) => f.type).sort(), ['illegal-item', 'over-enchant']);
    assert.equal(r.ac.scanItems('s1'), 0, 'unchanged files are not read again');
    assert.equal(r.ac.scanItems('s1', { force: true }), 2); // rescanning merges into the same flags
    assert.equal(r.flags().length, 2);
    r.ac.setConfig('s1', { skipCreative: false });
    assert.equal(r.ac.scanItems('s1', { force: true }), 3);

    // statistics
    fs.mkdirSync(path.join(r.dir, 'world', 'players', 'stats'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'world', 'players', 'stats', uuid(4) + '.json'), JSON.stringify({ stats: { 'minecraft:mined': { 'minecraft:stone': 300, 'minecraft:ancient_debris': 40 } } }));
    assert.equal(r.ac.scanXray('s1'), 1); assert.equal(r.flags('xray')[0].player, 'Fine');

    // plugins
    fs.writeFileSync(path.join(r.dir, software.STATE_FILE), JSON.stringify({ software: 'paper', version: '1.21', jar: 'server.jar' }));
    fs.mkdirSync(path.join(r.dir, 'plugins'));
    fs.writeFileSync(path.join(r.dir, 'plugins', 'good.jar'), 'good');
    fs.writeFileSync(path.join(r.dir, 'plugins', 'off.jar.disabled'), 'off');
    assert.equal(await r.ac.scanAllow('s1'), 0, 'off by default');
    const snap = await r.ac.allowSnapshot('s1', 'mods');
    assert.deepEqual(snap.mods.entries.map((e) => e.file), ['good.jar']);
    r.ac.setConfig('s1', { allow: { mods: { enabled: true } } });
    assert.equal(await r.ac.scanAllow('s1'), 0);
    fs.writeFileSync(path.join(r.dir, 'plugins', 'bad.jar'), 'bad');
    fs.writeFileSync(path.join(r.dir, 'plugins', 'good.jar'), 'good but changed');
    fs.copyFileSync(path.join(r.dir, 'plugins', 'bad.jar'), path.join(r.dir, 'plugins', 'bad-copy.jar'));
    assert.equal(await r.ac.scanAllow('s1'), 3);
    assert.deepEqual(r.flags('mod-unknown').map((f) => f.evidence.file).sort(), ['bad-copy.jar', 'bad.jar']);
    assert.equal(r.flags('mod-changed')[0].evidence.file, 'good.jar');
    assert.ok(r.flags('mod-unknown').every((f) => f.player === null));
    const view = await r.ac.allowView('s1');
    assert.equal(view.mods.current.length, 3); assert.equal(view.mods.kind, 'plugin');

    // resource pack
    const sha = 'c'.repeat(40);
    fs.writeFileSync(path.join(r.dir, 'server.properties'), `resource-pack=http://example.org/p.zip\nresource-pack-sha1=${sha}\n`);
    r.ac.setConfig('s1', { allow: { packs: { enabled: true } } });
    const n0 = r.flags('pack-unknown').length;
    await r.ac.scanAllow('s1');
    assert.equal(r.flags('pack-unknown').length, n0 + 1);
    await r.ac.allowSnapshot('s1', 'packs');
    r.ac.store('s1').clear({ all: true });
    await r.ac.scanAllow('s1');
    assert.equal(r.flags('pack-unknown').length, 0);
    fs.writeFileSync(path.join(r.dir, 'server.properties'), 'resource-pack=http://example.org/p.zip\n');
    await r.ac.scanAllow('s1');
    assert.match(r.flags('pack-unknown')[0].message, /ohne Prüfsumme/);
  } finally { r.done(); }
});

// ---- manual actions ----------------------------------------------------------------------------------------------
test('actions: remove item (checked against the live slot, backup kept), pending until join, kick/ban/tell/tp/mod, nothing automatic', async () => {
  const r = rig();
  try {
    const sid = 's1';
    const itemFlag = (o = {}) => r.ac.flag(sid, 'illegal-item', { player: 'Cheater', key: 'illegal:bedrock@inventory4', message: 'Cheater hat Bedrock', evidence: { item: 'minecraft:bedrock', topId: 'minecraft:bedrock', slot: 4, container: 'inventory', nested: false, nameKnown: true, ...o } });
    r.add('Cheater', { items: new Map([['Inventory[{Slot:4b}]', { id: 'minecraft:bedrock' }], ['EnderItems[{Slot:2b}]', { id: 'minecraft:bedrock' }], ['equipment.head', { id: 'minecraft:bedrock' }]]) });
    r.online('Cheater');
    assert.equal(r.local.sent.filter((c) => c.startsWith('item ')).length, 0, 'nothing happens by itself');

    // the item is removed and a copy is kept
    let f = itemFlag();
    let res = await r.ac.act(sid, f.id, 'remove-item');
    assert.ok(res.ok);
    assert.ok(r.local.sent.includes('item replace entity Cheater container.4 with minecraft:air'));
    assert.equal(r.world.get('Cheater').items.has('Inventory[{Slot:4b}]'), false);
    assert.equal(f.ack, true); assert.equal(f.resolved.action, 'remove-item'); assert.match(f.resolved.backup, /bedrock/);
    { const ghost = itemFlag({ item: 'minecraft:barrier', topId: 'minecraft:barrier', slot: 20 }); ghost.key = 'ghost';
      await assert.rejects(r.ac.act(sid, ghost.id, 'remove-item'), (e) => e.status === 409 && /nicht mehr beim Spieler/.test(e.message), 'nothing of that kind is carried any more'); }

    // ender chest and worn slot
    f = itemFlag({ container: 'ender', slot: 2 }); f.key; await r.ac.act(sid, f.id, 'remove-item');
    assert.ok(r.local.sent.includes('item replace entity Cheater enderchest.2 with minecraft:air'));
    f = r.ac.flag(sid, 'illegal-item', { player: 'Cheater', key: 'k-head', message: 'm', evidence: { item: 'minecraft:bedrock', topId: 'minecraft:bedrock', slot: 103, container: 'inventory', nameKnown: true } });
    await r.ac.act(sid, f.id, 'remove-item');
    assert.ok(r.local.sent.includes('item replace entity Cheater armor.head with minecraft:air'));

    // the player moved it: something else lies there now -> nothing is removed
    r.world.get('Cheater').items.set('Inventory[{Slot:4b}]', { id: 'minecraft:diamond' });
    const n0 = r.local.sent.filter((c) => c.startsWith('item replace')).length;
    f = itemFlag({}); f.resolved = null;
    await assert.rejects(r.ac.act(sid, f.id, 'remove-item'), (e) => e.status === 409 && /nicht mehr beim Spieler/.test(e.message));
    assert.equal(r.local.sent.filter((c) => c.startsWith('item replace')).length, n0);
    assert.ok(!f.resolved);

    // the player moved the flagged item to another slot (the flag comes from a file that is minutes old): it is found and removed there
    r.world.get('Cheater').items.set('Inventory[{Slot:4b}]', { id: 'minecraft:diamond' });
    r.world.get('Cheater').items.set('Inventory[{Slot:11b}]', { id: 'minecraft:bedrock' });
    const mv = await r.ac.act(sid, f.id, 'remove-item');
    assert.ok(mv.ok);
    assert.ok(r.local.sent.includes('item replace entity Cheater container.11 with minecraft:air'));
    assert.equal(r.world.get('Cheater').items.has('Inventory[{Slot:11b}]'), false);
    assert.equal(r.world.get('Cheater').items.get('Inventory[{Slot:4b}]').id, 'minecraft:diamond', 'the legal item stays');
    assert.match(f.resolved.note, /verschoben/);

    // the server did not empty the slot -> reported as failure, not as success
    f.resolved = null; r.world.get('Cheater').items.set('Inventory[{Slot:4b}]', { id: 'minecraft:bedrock' }); r.world.get('Cheater').stuck = true;
    await assert.rejects(r.ac.act(sid, f.id, 'remove-item'), (e) => e.status === 502);
    assert.ok(!f.resolved); r.world.get('Cheater').stuck = false;

    // flag types that have no item, unknown names and unknown actions are refused
    const sp = r.ac.flag(sid, 'speed', { player: 'Cheater', key: 'speed', message: 'schnell', evidence: {} });
    await assert.rejects(r.ac.act(sid, sp.id, 'remove-item'), (e) => e.status === 400);
    await assert.rejects(r.ac.act(sid, sp.id, 'op-everyone'), (e) => e.status === 400);
    await assert.rejects(r.ac.act(sid, 'nope', 'kick'), (e) => e.status === 404);
    const anon = itemFlag({ nameKnown: false, slot: 5 }); anon.key = 'x2';
    await assert.rejects(r.ac.act(sid, anon.id, 'kick'), (e) => e.status === 409);

    // kick / ban / tell: one console line each, control characters cannot add commands
    await r.ac.act(sid, sp.id, 'kick', 'Fliegen ist hier aus\nop Cheater');
    assert.ok(r.local.sent.includes('kick Cheater Fliegen ist hier aus op Cheater'));
    assert.ok(r.local.sent.every((c) => !/[\r\n]/.test(c)));
    await r.ac.act(sid, sp.id, 'tell', 'Bitte lassen');
    assert.ok(r.local.sent.includes('tell Cheater Bitte lassen'));
    await assert.rejects(r.ac.act(sid, sp.id, 'tell', '   '), (e) => e.status === 400);
    await r.ac.act(sid, sp.id, 'ban', 'Cheaten');
    assert.ok(r.local.sent.includes('ban Cheater Cheaten'));
    assert.equal(sp.resolved.action, 'ban');

    // jump back
    const tp = r.ac.flag(sid, 'teleport', { player: 'Cheater', key: 'tp', message: 'Sprung', evidence: { dim: 'minecraft:the_nether', blocks: 500, seconds: 1, from: [10, 64, -20], to: [510, 64, -20] } });
    await r.ac.act(sid, tp.id, 'tp-back');
    assert.ok(r.local.sent.includes('execute in minecraft:the_nether run tp Cheater 10 64 -20'));
    const bad = r.ac.flag(sid, 'teleport', { player: 'Cheater', key: 'tp2', message: 'x', evidence: { dim: 'x; op me', from: [1, 2, 3] } });
    await assert.rejects(r.ac.act(sid, bad.id, 'tp-back'), (e) => e.status === 400);

    // addresses
    const fl = r.ac.flag(sid, 'flood', { key: '203.0.113.9', message: 'Flut', evidence: { ip: '203.0.113.9', count: 9, windowS: 30 } });
    await r.ac.act(sid, fl.id, 'ban-ip');
    assert.ok(r.local.sent.some((c) => c.startsWith('ban-ip 203.0.113.9 ')));
    fl.evidence.ip = '1.2.3.4 ; op x';
    await assert.rejects(r.ac.act(sid, fl.id, 'ban-ip'), (e) => e.status === 400);

    // mods
    fs.writeFileSync(path.join(r.dir, software.STATE_FILE), JSON.stringify({ software: 'paper', version: '1.21', jar: 'server.jar' }));
    fs.mkdirSync(path.join(r.dir, 'plugins')); fs.writeFileSync(path.join(r.dir, 'plugins', 'bad.jar'), 'bad');
    const mf = r.ac.flag(sid, 'mod-unknown', { key: 'mod-unknown:bad.jar', message: 'bad', evidence: { file: 'bad.jar' } });
    const mres = await r.ac.act(sid, mf.id, 'mod-disable');
    assert.ok(mres.restartNeeded);
    assert.ok(fs.existsSync(path.join(r.dir, 'plugins', 'bad.jar.disabled')) && !fs.existsSync(path.join(r.dir, 'plugins', 'bad.jar')));
    const mf2 = r.ac.flag(sid, 'mod-unknown', { key: 'mod-unknown:../x.jar', message: 'bad', evidence: { file: '../../etc/passwd' } });
    await assert.rejects(r.ac.act(sid, mf2.id, 'mod-disable'));
  } finally { r.done(); }
});

test('self-test: places test items, finds them live and in the file, removes them, checks the slots, cleans up, touches nothing else', async () => {
  const r = rig();
  try {
    r.add('Me', { items: new Map([['Inventory[{Slot:0b}]', { id: 'minecraft:diamond_sword' }], ['equipment.chest', { id: 'minecraft:iron_chestplate' }]]) });
    r.online('Me');
    const st = r.ac.startSelfTest('s1', 'Me');
    assert.ok(st.running);
    await assert.rejects(async () => r.ac.startSelfTest('s1', 'Me'), (e) => e.status === 409);
    await waitFor(() => !st.running, 15000, 'self-test');
    const bad = st.steps.filter((s) => s.status === 'fail');
    assert.deepEqual(bad, [], JSON.stringify(bad));
    for (const n of ['Antwortzeit', 'Live-Prüfung', 'Speichern und Spielerdatei', 'Entfernen: Inventar', 'Entfernen: Shulkerbox', 'Entfernen: Helm', 'Entfernen: Zweithand', 'Entfernen: Endertruhe', 'verschoben']) {
      const s = st.steps.find((x) => x.name.includes(n)); assert.ok(s, n); assert.equal(s.status, 'ok', `${n}: ${s.detail}`);
    }
    assert.equal(st.summary.fail, 0); assert.ok(st.summary.totalMs >= 0);
    // only the test items are gone; the player's own things are still there; no test flags are left
    assert.deepEqual([...r.world.get('Me').items.keys()].sort(), ['Inventory[{Slot:0b}]', 'equipment.chest']);
    assert.equal(r.ac.store('s1').flags.length, 0);
    assert.equal(r.ac.view('s1').flags.length, 0);

    // occupied helmet and a full inventory: nothing is overwritten, the missing kinds are skipped, not failed
    const full = new Map([['equipment.head', { id: 'minecraft:iron_helmet' }]]);
    for (let i = 0; i < 36; i++) full.set(`Inventory[{Slot:${i}b}]`, { id: 'minecraft:cobblestone' });
    r.add('Full', { items: full }); r.online('Me', 'Full');
    const st2 = r.ac.startSelfTest('s1', 'Full');
    await waitFor(() => !st2.running, 15000, 'self-test 2');
    assert.ok(st2.steps.some((s) => s.status === 'skip' && /Helm/.test(s.name)), JSON.stringify(st2.steps.map((s) => [s.name, s.status])));
    assert.equal(r.world.get('Full').items.get('equipment.head').id, 'minecraft:iron_helmet');
    assert.equal([...r.world.get('Full').items.values()].filter((v) => v.id === 'minecraft:cobblestone').length, 36);
    assert.equal(st2.summary.fail, 0, JSON.stringify(st2.steps.filter((s) => s.status === 'fail')));

    // a player who is not online, and a server that does not answer
    const st3 = r.ac.startSelfTest('s1', 'Nobody'); await waitFor(() => !st3.running, 5000);
    assert.equal(st3.steps[0].status, 'fail'); assert.match(st3.steps[0].detail, /nicht online/);
  } finally { r.done(); }
});

test('self-test: a player the server knows but Blockhaus has not seen joining is still tested (the server is asked); a typed name needs no list', async () => {
  const r = rig();
  try {
    r.add('Me', { items: new Map() });
    r.online(); // Blockhaus' own player list is empty (the join line was not recognised)
    const st = r.ac.startSelfTest('s1', 'Me');
    await waitFor(() => !st.running, 15000, 'self-test');
    assert.equal(st.steps[0].status, 'warn'); assert.match(st.steps[0].detail, /Server bestätigt/);
    assert.equal(st.summary.fail, 0, JSON.stringify(st.steps.filter((x) => x.status === 'fail')));
    assert.ok(st.steps.some((x) => /Entfernen: Inventar/.test(x.name) && x.status === 'ok'));
    // the view offers the known names for the type-ahead list
    fs.writeFileSync(path.join(r.dir, 'usercache.json'), JSON.stringify([{ name: 'Anna', uuid: '00000000-0000-0000-0000-000000000009' }]));
    assert.deepEqual(r.ac.view('s1').known, ['Anna']);
  } finally { r.done(); }
});

test('self-test: a server that never answers is reported with the last console lines, and nothing is left behind', async () => {
  const r = rig();
  try {
    r.add('Me', { items: new Map() });
    r.online('Me');
    r.local.stdin = async function (id, cmd) { this.sent.push(cmd); setImmediate(() => this.line('Some unexpected format: ' + cmd)); };
    const st = r.ac.startSelfTest('s1', 'Me');
    await waitFor(() => !st.running, 30000, 'self-test');
    assert.equal(st.steps.find((s) => /Antwortzeit/.test(s.name)).status, 'fail');
    assert.match(st.steps.find((s) => /Antwortzeit/.test(s.name)).detail, /Some unexpected format/);
    assert.equal(r.local.sent.filter((c) => c.startsWith('item replace')).length, 0, 'nothing is placed when the server does not answer');
  } finally { r.done(); }
});

test('actions: an offline player gets the item removed after joining; a failed attempt is recorded, not hidden', async () => {
  const r = rig();
  try {
    const sid = 's1';
    r.online(); // nobody on
    const f = r.ac.flag(sid, 'illegal-item', { player: 'Later', key: 'k', message: 'm', evidence: { item: 'minecraft:bedrock', topId: 'minecraft:bedrock', slot: 7, container: 'inventory', nameKnown: true } });
    const res = await r.ac.act(sid, f.id, 'remove-item');
    assert.ok(res.pending); assert.equal(f.pending, 'remove-item'); assert.ok(!f.resolved);
    assert.equal(r.local.sent.filter((c) => c.startsWith('item ')).length, 0);
    // joins: still nothing right away (data is loaded a moment later)
    r.add('Later', { items: new Map([['Inventory[{Slot:7b}]', { id: 'minecraft:bedrock' }]]) });
    r.online('Later'); r.local.line('Later joined the game'.replace(/^/, 'System chat: '));
    await r.ac._tick(); assert.equal(r.local.sent.filter((c) => c.startsWith('item ')).length, 0);
    r.tick(5000); await r.ac._tick();
    await waitForSent(r, 'item replace entity Later container.7 with minecraft:air');
    await sleep(100);
    assert.equal(f.pending, null); assert.equal(f.resolved.action, 'remove-item'); assert.ok(!f.resolved.failed);

    // second pending: the item is gone by the time the player joins -> recorded as failed
    const g = r.ac.flag(sid, 'illegal-item', { player: 'Gone', key: 'k2', message: 'm', evidence: { item: 'minecraft:bedrock', topId: 'minecraft:bedrock', slot: 1, container: 'inventory', nameKnown: true } });
    r.online(); await r.ac.act(sid, g.id, 'remove-item');
    r.add('Gone', { items: new Map() }); r.online('Gone'); r.local.line('System chat: Gone joined the game');
    r.tick(5000); await r.ac._tick();
    await waitFor(() => g.resolved, 3000, 'failed note');
    assert.equal(g.resolved.failed, true); assert.equal(g.pending, null); assert.ok(!g.ack);
  } finally { r.done(); }
});
async function waitForSent(r, cmd) { await waitFor(() => r.local.sent.includes(cmd), 3000, cmd); }

// ---- Local + HTTP with the fake Java ---------------------------------------------------------------------------
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(30); }
}

test('items live: a spawner given just now is found by the next live check, without saving or leaving', async () => {
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.dir, 'ops.json'), JSON.stringify([{ uuid: 'x', name: 'Boss', level: 4 }]));
    const spawner = () => new Map([['Inventory[{Slot:7b}]', { id: 'minecraft:spawner' }], ['EnderItems[{Slot:1b}]', { id: 'minecraft:diamond' }]]);
    r.add('Cheater', { items: spawner() }); r.add('Creative', { items: spawner(), mode: 1 }); r.add('Boss', { items: spawner() }); r.add('Clean', { items: new Map([['Inventory[{Slot:0b}]', { id: 'minecraft:diamond_sword' }]]) });
    r.online('Cheater', 'Creative', 'Boss', 'Clean');
    // nothing was ever saved: the file scan sees nothing, only the live check can find it
    r.ac.scanItems('s1'); assert.equal(r.flags('illegal-item').length, 0);
    await r.ac._itemPoll('s1');
    const fl = r.flags('illegal-item');
    assert.deepEqual(fl.map((f) => f.player), ['Cheater'], 'creative, operators and clean players are not flagged');
    assert.match(fl[0].message, /Spawner/i); assert.equal(fl[0].evidence.slot, 7); assert.equal(fl[0].evidence.container, 'inventory');
    // routine polling never jumps ahead of admin actions
    assert.ok(r.local.sent.every((c) => /^data get entity (Cheater|Creative|Clean) /.test(c)), r.local.sent.join('|'));
    // the later file scan merges into the same flag instead of making a second one
    await r.ac.saveNow('s1'); r.ac.scanItems('s1');
    assert.equal(r.flags('illegal-item').length, 1);
    // the flag can be acted on right away
    const res = await r.ac.act('s1', fl[0].id, 'remove-item'); assert.ok(res.ok);
    assert.equal(r.world.get('Cheater').items.has('Inventory[{Slot:7b}]'), false);
    // the next check finds nothing new
    r.tick(11000); const n = r.flags().length; await r.ac._itemPoll('s1'); assert.equal(r.flags().length, n);
  } finally { r.done(); }
});

test('items live: runs from the tick on its own interval, can be switched off, the interval is clamped', async () => {
  const r = rig();
  try {
    r.add('Cheater', { items: new Map([['Inventory[{Slot:7b}]', { id: 'minecraft:spawner' }]]) }); r.online('Cheater');
    r.ac.setConfig('s1', { checks: { itemsLive: false } });
    r.tick(60000); await r.ac._tick(); await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.flags('illegal-item').length, 0); const itemQ = () => r.local.sent.filter((c) => / (Inventory|EnderItems|equipment)$/.test(c)).length;
    assert.equal(itemQ(), 0, 'switched off: no item queries');
    r.ac.setConfig('s1', { checks: { itemsLive: true } });
    r.tick(60000); await r.ac._tick();
    for (let i = 0; i < 40 && !r.flags('illegal-item').length; i++) await new Promise((res) => setTimeout(res, 25));
    assert.equal(r.flags('illegal-item').length, 1, 'found by the tick itself');
    const sent = itemQ(); r.tick(2000); await r.ac._tick(); await new Promise((res) => setTimeout(res, 50));
    assert.equal(itemQ(), sent, 'not again before the interval is over');
    assert.equal(normalizeConfig({ thresholds: { itemLiveSec: 1 } }).thresholds.itemLiveSec, 3);
    assert.equal(normalizeConfig({ thresholds: { itemLiveSec: 99999 } }).thresholds.itemLiveSec, 300);
    assert.equal(DEFAULTS.checks.itemsLive, true);
  } finally { r.done(); }
});

test('end to end: poll through the real Local, answers hidden from the console, flags over HTTP, ack/clear/config/scan', async () => {
  const tmp = tmpdir(); const dataDir = path.join(tmp, 'data'); const serversDir = path.join(tmp, 'servers'); fs.mkdirSync(serversDir, { recursive: true });
  const bin = path.join(tmp, 'java');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-mc.js')}" "$@"\n`, { mode: 0o755 });
  let T = 1e9;
  const app = createApp({
    dataDir, serversDir, mode: 'local', mcPort: await freePort(), settleMs: 5, anticheatOpts: { now: () => T, tickMs: 3600000 },
    localOpts: { pollMs: 60, stopTimeoutMs: 4000, ensureJava: async () => ({ bin, major: 21 }) },
    softwareInstall: async ({ dir, server, kind, version }) => { fs.writeFileSync(path.join(dir, server.executable), 'jar'); fs.writeFileSync(path.join(dir, '.blockhaus-software.json'), JSON.stringify({ software: kind, version, jar: server.executable, java: 21 })); return { software: kind, version }; },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, p, body) => { const res = await fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: res.status, json }; };
  try {
    let r = await call('POST', '/api/local/servers', { name: 'AC', kind: 'vanilla', version: '26.3' });
    const id = r.json.server.id;
    await waitFor(async () => (await call('GET', `/api/local/jobs/${r.json.job.id}`)).json.status === 'done');
    const A = `/api/servers/${id}/anticheat`;
    // before it runs
    let v = (await call('GET', A)).json;
    assert.equal(v.available, true); assert.equal(v.running, false); assert.equal(v.config.enabled, true); assert.deepEqual(v.flags, []);
    assert.deepEqual((await call('GET', '/api/anticheat/summary')).json.servers, [{ id, name: 'AC', enabled: true, open: 0, high: 0 }]);
    await call('POST', `/api/servers/${id}/eula`, {});
    await call('POST', `/api/servers/${id}/action/start`, {});
    await waitFor(async () => (await call('GET', `/api/servers/${id}/status`)).json.state === 'online');
    const cmd = (c) => call('POST', `/api/servers/${id}/command`, { command: c });
    await cmd('join Bob');
    await waitFor(async () => (await call('GET', `/api/servers/${id}/status`)).json.online === 1);
    const poll = async (x) => { await cmd(`posset Bob ${x} 64 0`); await sleep(120); T += 4000; await app.anticheat._poll(id); };
    await poll(0); await poll(60); await poll(120);
    v = (await call('GET', A)).json;
    assert.equal(v.running, true);
    assert.deepEqual(v.flags.map((f) => f.type), ['speed']);
    assert.equal(v.players[0].name, 'Bob'); assert.ok(v.players[0].score >= 3); assert.equal(v.players[0].online, true);
    assert.ok(v.status.queries >= 9);
    // the console view has the join line and our own command, but none of the query answers
    const lines = (await call('GET', `/api/servers/${id}/console`)).json;
    const text = JSON.stringify(lines);
    assert.match(text, /Bob joined the game/); assert.doesNotMatch(text, /has the following entity data/); assert.doesNotMatch(text, /Found no elements/);
    // ... but a hand-typed query is shown, since nothing was waiting for it
    await cmd('data get entity Bob Pos');
    await waitFor(async () => /has the following entity data/.test(JSON.stringify((await call('GET', `/api/servers/${id}/console`)).json)));

    // config, ack, clear
    r = await call('PUT', `${A}/config`, { thresholds: { speedBps: 20, pollSec: 1 }, checks: { fly: false }, exempt: ['Bob', 'bad name'] });
    assert.equal(r.json.config.thresholds.speedBps, 20); assert.equal(r.json.config.thresholds.pollSec, 2); assert.equal(r.json.config.checks.fly, false); assert.deepEqual(r.json.config.exempt, ['Bob']);
    assert.equal(r.json.players.find((p) => p.name === 'Bob').exempt, true);
    assert.equal((await call('PUT', `${A}/config`, { exempt: [] })).status, 200);
    const fid = v.flags[0].id;
    assert.equal((await call('POST', `${A}/ack`, { id: fid })).json.acknowledged, 1);
    assert.deepEqual((await call('GET', '/api/anticheat/summary')).json.servers[0].open, 0);
    assert.equal((await call('GET', A)).json.flags[0].ack, true);
    assert.equal((await call('POST', `${A}/clear`, { acked: true })).json.removed, 1);
    assert.deepEqual((await call('GET', A)).json.flags, []);
    // scan + allow-list endpoints
    assert.deepEqual((await call('POST', `${A}/scan`, {})).json, { ok: true, items: 0, xray: 0, allow: 0 });
    assert.equal((await call('POST', `${A}/allow/snapshot`, { kind: 'x' })).status, 400);
    assert.equal((await call('POST', `${A}/allow/snapshot`, { kind: 'mods' })).status, 200);
    assert.equal((await call('GET', `${A}/allow`)).json.mods.kind, null);
    assert.equal((await call('GET', `${A}/nope`)).status, 404);
    // survives a restart of the panel's memory: flags and config are files
    assert.ok(fs.existsSync(path.join(dataDir, 'anticheat', id, 'config.json')));
  } finally { await app.local.shutdown(2000).catch(() => {}); app.close(); app.closeAllConnections?.(); }
});
