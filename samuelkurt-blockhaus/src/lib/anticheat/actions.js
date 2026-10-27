'use strict';
// Manual actions an admin can trigger from a flag. Nothing here runs by itself: every function is called because someone
// pressed a button. All of them talk to the server through its console, so they work exactly like typing the command.
const path = require('node:path');
const mods = require('../mods');
const software = require('../software');
const { NAME_RE } = require('./logscan');

const ITEM_TYPES = new Set(['illegal-item', 'over-enchant', 'over-stack', 'unbreakable', 'custom-attr']);
const err = (status, message) => Object.assign(new Error(message), { status });
const ARMOR = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head' };

/** NBT slot of a stack -> [`item replace` slot name, NBT path used to read the same slot]. */
function slotSpec(container, slot) {
  const n = Number(slot);
  if (!Number.isInteger(n)) throw err(409, 'Zu diesem Fund ist der Platz des Items nicht bekannt.');
  if (container === 'ender') { if (n < 0 || n > 26) throw err(409, 'Ungültiger Platz in der Endertruhe.'); return { cmd: `enderchest.${n}`, path: `EnderItems[{Slot:${n}b}]` }; }
  if (n >= 0 && n <= 35) return { cmd: `container.${n}`, path: `Inventory[{Slot:${n}b}]` };
  if (ARMOR[n]) return { cmd: `armor.${ARMOR[n]}`, path: `equipment.${ARMOR[n]}` };
  if (n === -106) return { cmd: 'weapon.offhand', path: 'equipment.offhand' };
  throw err(409, 'Dieser Platz kann nicht automatisch geleert werden.');
}

const cleanText = (t, fallback) => String(t || fallback || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || String(fallback || '');
const idOf = (v) => String(v || '').replace(/^"|"$/g, '').replace(/^minecraft:/, '');

// an admin waits for these answers: ahead of the routine polling, and patient with a busy server
const Q = { priority: true, timeout: 8000 };

/** Empties one slot after checking that the expected item still lies there. Throws err(409, …, moved) if it does not. */
async function removeSlot(ac, sid, name, container, slot, want) {
  let spec;
  try { spec = slotSpec(container, slot); } catch (e) { e.moved = true; throw e; }
  const idq = await ac.query(sid, name, spec.path + '.id', Q);
  if (!idq) throw err(504, 'Der Server hat nicht rechtzeitig geantwortet (nach 8 s). Ist er überlastet? Versuche es noch einmal.');
  if (idq.offline) throw err(409, `${name} ist nicht online.`);
  const gone = idq.none ? null : idOf(idq.value);
  if (gone !== want) throw Object.assign(err(409, gone ? `Dort liegt jetzt ${gone} statt ${want}.` : 'Dort liegt nichts mehr.'), { moved: true });
  const full = await ac.query(sid, name, spec.path, Q);
  const backup = full && full.value ? String(full.value).slice(0, 6000) : null;
  await ac.replaceSlot(sid, name, spec.cmd, 'minecraft:air');
  const after = await ac.query(sid, name, spec.path + '.id', Q);
  if (!after) throw err(504, 'Der Server hat nach dem Entfernen nicht rechtzeitig geantwortet; ob der Platz leer ist, ist unbekannt. Prüfe das Inventar.');
  if (!after.none) throw err(502, 'Der Server hat das Item nicht entfernt (Platz ist nicht leer geworden). Prüfe die Konsole.');
  return { note: `${want} aus ${container === 'ender' ? 'Endertruhe' : 'Inventar'} Platz ${slot} entfernt`, backup };
}

/**
 * Removes the stack a flag is about, after checking that the same item is still in that slot. Keeps a copy of it in the flag.
 * The flag was made from a file that may be minutes old, so the player may have moved the item since: then the whole
 * inventory, ender chest and equipment are asked for the same item (same kind of finding) and those stacks are removed.
 */
async function removeItem(ac, sid, flag) {
  const ev = flag.evidence || {};
  const name = flag.player;
  if (!NAME_RE.test(name || '') || ev.nameKnown === false) throw err(409, 'Der Spielername ist nicht sicher bekannt (nur die ID). Nutze die Spielerliste.');
  const want = idOf(ev.topId);
  try { return await removeSlot(ac, sid, name, ev.container, ev.slot, want); } catch (e) { if (!e.moved) throw e; }
  const live = await ac.liveFindings(sid, name);
  if (!live) throw err(504, 'Der Server hat nicht rechtzeitig geantwortet (nach 8 s). Ist er überlastet? Versuche es noch einmal.');
  const seen = new Set();
  const cands = live.findings.filter((f) => f.type === flag.type && idOf(f.evidence.item) === idOf(ev.item) && idOf(f.evidence.topId) === want && (f.evidence.enchant || null) === (ev.enchant || null))
    .filter((f) => { const k = `${f.evidence.container}:${f.evidence.slot}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!cands.length) throw err(409, `${ev.item || want} ist nicht mehr beim Spieler (weder Inventar noch Endertruhe noch Ausrüstung). Es gibt nichts zu entfernen.`);
  const notes = []; const backups = [];
  for (const c of cands) {
    const r = await removeSlot(ac, sid, name, c.evidence.container, c.evidence.slot, idOf(c.evidence.topId));
    notes.push(r.note); if (r.backup) backups.push(r.backup);
  }
  return { note: `${notes.join('; ')} (der Spieler hatte es verschoben)`, backup: backups.join('\n') || null, relocated: true };
}

/** @returns {Promise<{message:string, note:string, backup?:string, restartNeeded?:boolean}>} */
async function act(ac, sid, flag, action, text) {
  const name = flag.player;
  const ev = flag.evidence || {};
  const online = () => ac.onlineNames(sid).some((n) => n.toLowerCase() === String(name).toLowerCase());
  const needPlayer = () => { if (!NAME_RE.test(name || '') || ev.nameKnown === false) throw err(409, 'Der Spielername ist nicht sicher bekannt. Nutze die Spielerliste.'); };
  const needRunning = () => { if (!ac.isOnline(sid)) throw err(409, 'Der Server läuft nicht.'); };
  switch (action) {
    case 'remove-item': {
      if (!ITEM_TYPES.has(flag.type)) throw err(400, 'Diese Meldung betrifft kein Item.');
      needPlayer(); needRunning();
      if (!online()) return { pending: true, message: `${name} ist nicht online. Das Item wird entfernt, sobald ${name} beitritt.`, note: 'Entfernen vorgemerkt' };
      const r = await removeItem(ac, sid, flag);
      return { message: `Entfernt: ${r.note}. Eine Kopie steht in den Details.`, ...r };
    }
    case 'kick': {
      needPlayer(); needRunning();
      if (!online()) throw err(409, `${name} ist nicht online.`);
      const reason = cleanText(text, 'Vom Server-Admin entfernt');
      await ac.local.stdin(sid, `kick ${name} ${reason}`);
      return { message: `${name} wurde gekickt.`, note: `gekickt: ${reason}` };
    }
    case 'ban': {
      needPlayer(); needRunning();
      const reason = cleanText(text, 'Vom Server-Admin gesperrt');
      await ac.local.stdin(sid, `ban ${name} ${reason}`);
      return { message: `${name} wurde gesperrt.`, note: `gebannt: ${reason}` };
    }
    case 'tell': {
      needPlayer(); needRunning();
      if (!online()) throw err(409, `${name} ist nicht online.`);
      const msg = cleanText(text, '');
      if (!msg) throw err(400, 'Bitte eine Nachricht eingeben.');
      await ac.local.stdin(sid, `tell ${name} ${msg}`);
      return { message: 'Nachricht gesendet.', note: `Nachricht: ${msg}` };
    }
    case 'tp-back': {
      if (flag.type !== 'teleport' || !Array.isArray(ev.from) || !/^[a-z0-9_.:-]+$/i.test(ev.dim || '')) throw err(400, 'Zu dieser Meldung gibt es keine frühere Position.');
      needPlayer(); needRunning();
      if (!online()) throw err(409, `${name} ist nicht online.`);
      const [x, y, z] = ev.from.map((n) => Number(n));
      if (![x, y, z].every(Number.isFinite)) throw err(400, 'Ungültige Position.');
      await ac.local.stdin(sid, `execute in ${ev.dim} run tp ${name} ${x} ${y} ${z}`);
      return { message: `${name} wurde zurückgesetzt.`, note: `zurückgesetzt auf ${x} ${y} ${z}` };
    }
    case 'ban-ip': {
      const ip = String(ev.ip || '');
      if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw err(400, 'Zu dieser Meldung gibt es keine Adresse.');
      needRunning();
      await ac.local.stdin(sid, `ban-ip ${ip} ${cleanText(text, 'Anticheat: Verbindungsflut')}`);
      return { message: `Adresse ${ip} wurde gesperrt.`, note: `IP gesperrt: ${ip}` };
    }
    case 'mod-disable': {
      if (!['mod-unknown', 'mod-changed'].includes(flag.type) || !ev.file) throw err(400, 'Diese Meldung betrifft keine Mod-Datei.');
      const dir = ac.dirOf(sid);
      const lay = mods.layout(dir, software.readInstalled(dir));
      if (!lay.folder) throw err(409, lay.reason || 'Dieser Server hat keinen Mod-Ordner.');
      if (ev.file.endsWith('.disabled')) throw err(409, 'Die Datei ist schon abgeschaltet.');
      mods.toggle(dir, lay, ev.file);
      return { message: `${ev.file} ist abgeschaltet (.disabled). Der Server muss neu starten.`, note: `abgeschaltet: ${ev.file}`, restartNeeded: ac.isOnline(sid) };
    }
    default: throw err(400, 'Unbekannte Aktion.');
  }
}

module.exports = { act, removeItem, removeSlot, slotSpec, ITEM_TYPES };
