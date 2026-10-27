'use strict';
// Items a player should not be able to hold in survival (they only come from creative mode or commands), enchantments above
// the vanilla maximum, stacks above the vanilla stack size, and components that only commands can put on an item.
// The tables describe vanilla (1.21 to 26.x); a mod or a data pack can change them, so every finding is only a flag.
const inventory = require('../inventory');

const ILLEGAL = new Set([
  'bedrock', 'barrier', 'light', 'structure_void', 'structure_block', 'jigsaw', 'command_block', 'chain_command_block',
  'repeating_command_block', 'command_block_minecart', 'debug_stick', 'knowledge_book', 'spawner', 'trial_spawner', 'vault',
  'reinforced_deepslate', 'end_portal_frame', 'end_portal', 'nether_portal', 'budding_amethyst', 'petrified_oak_slab',
  'infested_stone', 'infested_cobblestone', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks',
  'infested_chiseled_stone_bricks', 'infested_deepslate', 'test_block', 'test_instance_block', 'farmland', 'dirt_path',
  'frogspawn', 'chorus_plant', 'bundle_debug', 'player_head_debug',
]);
const ILLEGAL_RE = /(_spawn_egg$|^spawn_egg$)/;

const MAX_LEVEL = {
  protection: 4, fire_protection: 4, feather_falling: 4, blast_protection: 4, projectile_protection: 4, respiration: 3, aqua_affinity: 1,
  thorns: 3, depth_strider: 3, frost_walker: 2, soul_speed: 3, swift_sneak: 3, sharpness: 5, smite: 5, bane_of_arthropods: 5,
  knockback: 2, fire_aspect: 2, looting: 3, sweeping_edge: 3, efficiency: 5, silk_touch: 1, unbreaking: 3, fortune: 3, power: 5,
  punch: 2, flame: 1, infinity: 1, luck_of_the_sea: 3, lure: 3, loyalty: 3, impaling: 5, riptide: 3, channeling: 1, multishot: 1,
  quick_charge: 3, piercing: 4, mending: 1, binding_curse: 1, vanishing_curse: 1, density: 5, breach: 4, wind_burst: 3, lunge: 3,
};

const STACK_1 = /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|_spear|_horse_armor|_boat|_raft|_chest_boat|_bed|_minecart|^minecart|_harness)$/;
const STACK_1_NAMES = new Set(['shield', 'bow', 'crossbow', 'trident', 'mace', 'elytra', 'totem_of_undying', 'fishing_rod', 'carrot_on_a_stick',
  'warped_fungus_on_a_stick', 'flint_and_steel', 'shears', 'brush', 'potion', 'splash_potion', 'lingering_potion', 'enchanted_book', 'saddle',
  'cake', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'suspicious_stew', 'writable_book', 'water_bucket', 'lava_bucket', 'milk_bucket',
  'powder_snow_bucket', 'cod_bucket', 'salmon_bucket', 'pufferfish_bucket', 'tropical_fish_bucket', 'axolotl_bucket', 'tadpole_bucket',
  'goat_horn', 'wolf_armor', 'turtle_helmet', 'compass', 'recovery_compass', 'clock', 'spyglass', 'map', 'filled_map', 'bundle', 'knowledge_book']);
const STACK_16 = /(_sign|_hanging_sign|_banner)$/;
const STACK_16_NAMES = new Set(['ender_pearl', 'snowball', 'egg', 'bucket', 'honey_bottle', 'armor_stand', 'written_book']);

function bare(id) { return String(id || '').replace(/^minecraft:/, ''); }

function maxStack(id) {
  const n = bare(id);
  if (STACK_1_NAMES.has(n) || STACK_1.test(n) || /^music_disc_/.test(n)) return 1;
  if (STACK_16_NAMES.has(n) || STACK_16.test(n)) return 16;
  return 64;
}

/** Components that only exist after a command (not through normal play). */
function oddComponents(raw) {
  const c = (raw && raw.components) || {};
  const out = [];
  if (Object.prototype.hasOwnProperty.call(c, 'minecraft:unbreakable')) out.push({ kind: 'unbreakable', text: 'unzerbrechlich' });
  const am = c['minecraft:attribute_modifiers'];
  const mods = Array.isArray(am) ? am : (am && Array.isArray(am.modifiers) ? am.modifiers : []);
  // armor, tools and weapons carry their normal attributes as defaults, not as components: any entry here was added by hand
  if (mods.length) out.push({ kind: 'attribute', text: `eigene Attribute (${mods.map((m) => bare(m.type || m.id || '?')).slice(0, 3).join(', ')})` });
  const tag = (raw && raw.tag) || {};
  if (tag.Unbreakable) out.push({ kind: 'unbreakable', text: 'unzerbrechlich' });
  if (Array.isArray(tag.AttributeModifiers) && tag.AttributeModifiers.length) out.push({ kind: 'attribute', text: 'eigene Attribute' });
  return out;
}

/**
 * @param {Array<object>} rawItems  items as stored in NBT / printed by `data get` (id, count|Count, Slot, components|tag)
 * @param {string} where            "Inventar" | "Endertruhe"
 * @returns {Array<{key:string,type:string,message:string,evidence:object}>}
 */
/** Items inside shulker boxes / bundles (component format and the old BlockEntityTag format). */
function nested(raw) {
  const c = (raw && raw.components) || {};
  const out = [];
  if (Array.isArray(c['minecraft:container'])) for (const e of c['minecraft:container']) if (e && e.item) out.push(e.item);
  if (Array.isArray(c['minecraft:bundle_contents'])) out.push(...c['minecraft:bundle_contents']);
  const old = raw && raw.tag && raw.tag.BlockEntityTag && raw.tag.BlockEntityTag.Items;
  if (Array.isArray(old)) out.push(...old);
  return out.filter((x) => x && x.id);
}

function scan(rawItems, where = 'Inventar', depth = 0) {
  const out = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || !raw.id) continue;
    if (depth < 3) {
      const inner = nested(raw);
      if (inner.length) out.push(...scan(inner, `${where} › ${bare(raw.id)}`, depth + 1));
    }
    const it = inventory.normalizeItem(raw);
    const id = bare(it.id);
    const label = it.name ? `${id} („${it.name}“)` : id;
    const ev = { item: id, slot: it.slot, count: it.count, where };
    if (ILLEGAL.has(id) || ILLEGAL_RE.test(id)) {
      out.push({ key: `illegal:${id}`, type: 'illegal-item', message: `${where}: ${label} gibt es im Überlebensmodus nicht`, evidence: ev });
    }
    for (const e of [...it.enchants, ...it.storedEnchants]) {
      const max = MAX_LEVEL[bare(e.id)];
      if (max !== undefined && e.level > max) {
        out.push({ key: `ench:${id}:${bare(e.id)}`, type: 'over-enchant', message: `${where}: ${label} mit ${bare(e.id)} ${e.level} (Maximum ${max})`, evidence: { ...ev, enchant: bare(e.id), level: e.level, max } });
      }
    }
    const max = maxStack(id);
    if (Number.isFinite(it.count) && it.count > max) {
      out.push({ key: `stack:${id}`, type: 'over-stack', message: `${where}: ${it.count}× ${label} in einem Stapel (Maximum ${max})`, evidence: { ...ev, max } });
    }
    for (const o of oddComponents(raw)) {
      out.push({ key: `${o.kind}:${id}`, type: o.kind === 'unbreakable' ? 'unbreakable' : 'custom-attr', message: `${where}: ${label} ist ${o.text}`, evidence: ev });
    }
  }
  return out;
}

module.exports = { scan, maxStack, ILLEGAL, MAX_LEVEL };
