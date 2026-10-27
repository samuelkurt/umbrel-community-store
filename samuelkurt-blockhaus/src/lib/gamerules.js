'use strict';
// Game rules of Minecraft 26.x live in <world>/data/minecraft/game_rules.dat (older versions kept them in level.dat under other
// names). The file has every rule with its type (byte = on/off, int = number), so the page needs no query per rule and works
// with the server stopped. The server writes the file when it saves; for a running server the caller saves first.
const fs = require('node:fs');
const path = require('node:path');
const nbt = require('./nbt');
const { writeFileKeepOwner } = require('./fsutil');

const FILE = path.join('data', 'minecraft', 'game_rules.dat');
const NAME_RE = /^[a-z0-9_]{2,64}$/;
const NETHER = 'allow_entering_nether_using_portals';

// [category, label, hint]. Rules that are not listed here still show up, under "Weitere", with their raw name.
const KNOWN = {
  keep_inventory: ['Spieler', 'Inventar nach dem Tod behalten'],
  immediate_respawn: ['Spieler', 'Sofort wiederbeleben', 'Ohne Todesbildschirm.'],
  natural_health_regeneration: ['Spieler', 'Leben regeneriert sich von selbst'],
  players_sleeping_percentage: ['Spieler', 'Schlafende für die Nacht (%)', '100 = alle, 0 = reicht schon einer. Zahl, nicht Ja/Nein.'],
  respawn_radius: ['Spieler', 'Wiederbelebungs-Radius (Blöcke)'],
  locator_bar: ['Spieler', 'Ortungsleiste (Mitspieler)'],
  show_death_messages: ['Spieler', 'Todesmeldungen im Chat'],
  show_advancement_messages: ['Spieler', 'Fortschrittsmeldungen im Chat'],
  forgive_dead_players: ['Spieler', 'Wütende Mobs vergeben toten Spielern'],
  universal_anger: ['Spieler', 'Wütende Mobs greifen alle Spieler an'],
  limited_crafting: ['Spieler', 'Nur freigeschaltete Rezepte herstellbar'],
  spectators_generate_chunks: ['Spieler', 'Zuschauer erzeugen neue Chunks'],
  pvp: ['Kampf & Schaden', 'Spieler gegen Spieler (PvP)'],
  fall_damage: ['Kampf & Schaden', 'Fallschaden'],
  fire_damage: ['Kampf & Schaden', 'Feuerschaden'],
  drowning_damage: ['Kampf & Schaden', 'Ertrinkungsschaden'],
  freeze_damage: ['Kampf & Schaden', 'Erfrierungsschaden'],
  ender_pearls_vanish_on_death: ['Kampf & Schaden', 'Enderperlen verschwinden beim Tod'],
  spawn_mobs: ['Mobs', 'Mobs spawnen (allgemein)'],
  spawn_monsters: ['Mobs', 'Monster spawnen'],
  spawn_phantoms: ['Mobs', 'Phantome spawnen'],
  spawn_patrols: ['Mobs', 'Plünderer-Patrouillen spawnen'],
  spawn_wandering_traders: ['Mobs', 'Fahrende Händler spawnen'],
  spawn_wardens: ['Mobs', 'Wächter (Warden) spawnen'],
  raids: ['Mobs', 'Überfälle (Raids)'],
  mob_griefing: ['Mobs', 'Mobs zerstören Blöcke', 'Creeper, Endermen, Ghasts und andere.'],
  mob_drops: ['Mobs', 'Mobs droppen Items'],
  max_entity_cramming: ['Mobs', 'Max. Entities pro Block (Erdrücken)'],
  tnt_explodes: ['Welt', 'TNT explodiert'],
  tnt_explosion_drop_decay: ['Welt', 'TNT-Explosionen: Drops gehen teils verloren'],
  block_explosion_drop_decay: ['Welt', 'Block-Explosionen: Drops gehen teils verloren'],
  mob_explosion_drop_decay: ['Welt', 'Mob-Explosionen: Drops gehen teils verloren'],
  block_drops: ['Welt', 'Blöcke droppen Items'],
  entity_drops: ['Welt', 'Entities droppen Items'],
  advance_time: ['Welt', 'Tageszeit läuft weiter'],
  advance_weather: ['Welt', 'Wetter wechselt'],
  random_tick_speed: ['Welt', 'Zufalls-Tick-Rate', 'Wie schnell Pflanzen wachsen. Standard 3.'],
  fire_spread_radius_around_player: ['Welt', 'Feuer breitet sich aus im Umkreis (Blöcke)', 'Nur nahe bei Spielern, 0 = nie, -1 = überall.'],
  lava_source_conversion: ['Welt', 'Lava bildet neue Quellen'],
  water_source_conversion: ['Welt', 'Wasser bildet neue Quellen'],
  spread_vines: ['Welt', 'Ranken breiten sich aus'],
  max_snow_accumulation_height: ['Welt', 'Max. Schneehöhe (Schichten)'],
  projectiles_can_break_blocks: ['Welt', 'Geschosse zerstören Blöcke'],
  spawner_blocks_work: ['Welt', 'Spawner funktionieren'],
  global_sound_events: ['Welt', 'Weit hörbare Geräusche (Wither, Drache)'],
  reduced_debug_info: ['Welt', 'Reduzierter Debug-Bildschirm (F3)'],
  allow_entering_nether_using_portals: ['Portale', 'Nether-Portale erlaubt'],
  players_nether_portal_default_delay: ['Portale', 'Portal-Wartezeit Überleben (Ticks)', '80 Ticks = 4 Sekunden.'],
  players_nether_portal_creative_delay: ['Portale', 'Portal-Wartezeit Kreativ (Ticks)'],
  command_blocks_work: ['Befehle & Technik', 'Befehlsblöcke funktionieren', 'Ob Befehlsblöcke überhaupt erlaubt sind, steht unter Optionen.'],
  command_block_output: ['Befehle & Technik', 'Befehlsblöcke melden im Chat'],
  send_command_feedback: ['Befehle & Technik', 'Befehle melden ihr Ergebnis'],
  log_admin_commands: ['Befehle & Technik', 'Admin-Befehle ins Log schreiben'],
  max_command_sequence_length: ['Befehle & Technik', 'Max. Länge einer Befehlsfolge'],
  max_command_forks: ['Befehle & Technik', 'Max. Befehls-Verzweigungen'],
  max_block_modifications: ['Befehle & Technik', 'Max. Blockänderungen pro Befehl'],
  player_movement_check: ['Befehle & Technik', 'Bewegungsprüfung („moved too quickly“)', 'Gehört zum Server selbst, nicht zum Anticheat. Aus: kein Zurücksetzen mehr, auch bei Cheats.'],
  elytra_movement_check: ['Befehle & Technik', 'Elytra-Bewegungsprüfung'],
};
const CATEGORIES = ['Spieler', 'Kampf & Schaden', 'Mobs', 'Welt', 'Portale', 'Befehle & Technik', 'Weitere'];

const fileOf = (worldDir) => path.join(worldDir, FILE);

/** Major version from "26.3", "1.21.4" (-> 1), "26w10a" (-> 26). Games from 26 on use <world>/data/minecraft/game_rules.dat. */
function eraOf(version) {
  const m = /^(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) >= 26 : false;
}

function read(worldDir) {
  let tree;
  try { tree = nbt.parse(fs.readFileSync(fileOf(worldDir)), { typed: true }); } catch (e) { if (e && e.code === 'ENOENT') return { exists: false, rules: [] }; throw e; }
  const data = tree.value.data && tree.value.data.t === 'compound' ? tree.value.data.v : null;
  if (!data) return { exists: true, rules: [] };
  const rules = [];
  for (const [key, tag] of Object.entries(data)) {
    const name = key.replace(/^minecraft:/, '');
    if (!NAME_RE.test(name)) continue; // rules of mods keep their own namespace (a colon is left in the name) and are left alone
    const kind = tag.t === 'byte' ? 'bool' : (tag.t === 'int' ? 'int' : null);
    if (!kind) continue;
    const k = KNOWN[name];
    rules.push({ name, type: kind, value: kind === 'bool' ? tag.v !== 0 : tag.v, label: k ? k[1] : name, hint: k && k[2] || '', category: k ? k[0] : 'Weitere', known: !!k });
  }
  rules.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.label.localeCompare(b.label, 'de'));
  return { exists: true, rules };
}

/** Checks a value for a rule of a given type. Returns the value as the server wants it in the command, or throws a 400-style error. */
function normalize(type, value) {
  if (type === 'bool') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw Object.assign(new Error('Ja oder Nein erwartet.'), { status: 400 });
  }
  const n = typeof value === 'number' ? value : (/^-?\d{1,10}$/.test(String(value)) ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw Object.assign(new Error('Eine ganze Zahl erwartet.'), { status: 400 });
  return n;
}

/** Writes one rule into the file (for a server that is not running). Everything else in the file stays as it is. */
function writeRule(worldDir, name, value) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error('Ungültiger Name.'), { status: 400 });
  const file = fileOf(worldDir);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { if (e && e.code === 'ENOENT') throw Object.assign(new Error('Für diese Welt gibt es noch keine Spielregel-Datei. Starte den Server einmal.'), { status: 409 }); throw e; }
  const tree = nbt.parse(buf, { typed: true });
  const data = tree.value.data && tree.value.data.t === 'compound' ? tree.value.data.v : null;
  const tag = data && data['minecraft:' + name];
  if (!tag) throw Object.assign(new Error('Diese Spielregel gibt es in der Welt nicht.'), { status: 404 });
  if (tag.t === 'byte') tag.v = normalize('bool', value) ? 1 : 0;
  else if (tag.t === 'int') tag.v = normalize('int', value);
  else throw Object.assign(new Error('Diese Spielregel hat einen Typ, den Blockhaus nicht ändert.'), { status: 400 });
  const out = nbt.encode(tree.name, tree.value, { gzip: true });
  // make sure what is written reads back identically before the server's file is replaced
  const back = nbt.parse(out, { typed: true });
  if (JSON.stringify(back.value) !== JSON.stringify(tree.value)) throw new Error('Die Spielregel-Datei ließ sich nicht sicher schreiben.');
  writeFileKeepOwner(file + '.blockhaus.bak', buf);
  writeFileKeepOwner(file, out);
}

module.exports = { read, writeRule, normalize, eraOf, KNOWN, CATEGORIES, NETHER, NAME_RE, FILE };
