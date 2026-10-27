'use strict';
// Self-test: runs the real thing on the real server with a player the admin picks, and measures how long it takes.
// It puts a few harmless but "impossible" test items into EMPTY slots of that player (bedrock, a shulker box with bedrock,
// a barrier block as helmet, a command block in the off hand, a structure block in the ender chest), lets the Anticheat find
// them (live query and player file), removes them with the same code the "Item entfernen" button uses, checks that the slots
// are empty again and cleans up whatever is left. Nothing that was already in a slot is touched.
const { NAME_RE } = require('./logscan');
const actions = require('./actions');

const Q = { priority: true, timeout: 8000 };
const SLOW_QUERY_MS = 1500;
const SLOW_ACTION_MS = 4000;
const lc = (s) => String(s || '').toLowerCase();
const bare = (v) => String(v || '').replace(/^"|"$/g, '').replace(/^minecraft:/, '');

/** The kinds of test item. `slot` is chosen at run time from what is free. */
const KINDS = [
  { id: 'inv', label: 'Inventar', item: 'bedrock', cmdItem: 'minecraft:bedrock', container: 'inventory', top: 'bedrock', type: 'illegal-item', needs: 'inv' },
  { id: 'box', label: 'Shulkerbox mit Bedrock darin', item: 'bedrock', cmdItem: 'minecraft:shulker_box[container=[{slot:0,item:{id:"minecraft:bedrock",count:1}}]]', container: 'inventory', top: 'shulker_box', nested: true, type: 'illegal-item', needs: 'inv' },
  { id: 'head', label: 'Helm-Platz', item: 'barrier', cmdItem: 'minecraft:barrier', container: 'inventory', top: 'barrier', type: 'illegal-item', needs: 'head', slot: 103 },
  { id: 'off', label: 'Zweithand', item: 'command_block', cmdItem: 'minecraft:command_block', container: 'inventory', top: 'command_block', type: 'illegal-item', needs: 'off', slot: -106 },
  { id: 'ender', label: 'Endertruhe', item: 'structure_block', cmdItem: 'minecraft:structure_block', container: 'ender', top: 'structure_block', type: 'illegal-item', needs: 'ender' },
];

const cmdOf = (k) => (k.container === 'ender' ? `enderchest.${k.slot}` : k.slot === 103 ? 'armor.head' : k.slot === -106 ? 'weapon.offhand' : `container.${k.slot}`);
const pathOf = (k) => actions.slotSpec(k.container, k.slot).path;

class SelfTest {
  constructor(ac, sid, player, state) { this.ac = ac; this.sid = sid; this.P = player; this.state = state; this.placed = []; this.tap = []; this.flags = []; }

  async step(name, fn) {
    const s = { name, status: 'run', ms: 0, detail: '' };
    this.state.steps.push(s);
    const t0 = Date.now();
    try { const r = (await fn(s)) || {}; s.status = r.status || 'ok'; s.detail = r.detail || ''; } catch (e) { s.status = 'fail'; s.detail = e && e.message ? e.message : String(e); }
    s.ms = Date.now() - t0;
    return s;
  }

  raw() { return this.tap.slice(-4).map((l) => '„' + l.slice(0, 200) + '“').join(' | '); }
  q(path) { return this.ac.query(this.sid, this.P, path, Q); }
  async put(k) {
    await this.ac.replaceSlot(this.sid, this.P, cmdOf(k), k.cmdItem);
    const r = await this.q(pathOf(k) + '.id');
    if (!r) throw new Error('keine Antwort des Servers');
    if (r.none) throw new Error('der Server hat das Test-Item nicht gesetzt (Befehl `item replace` nicht verstanden? ' + (k.id === 'box' ? 'Shulkerbox-Syntax gilt erst ab Minecraft 1.20.5. ' : '') + 'Letzte Zeilen: ' + this.raw() + ')');
    if (bare(r.value) !== k.top) throw new Error(`im Platz liegt ${bare(r.value)} statt ${k.top}`);
    this.placed.push(k);
  }
  async slotEmpty(k) { const r = await this.q(pathOf(k) + '.id'); if (!r) return null; return !!r.none; }

  async run() {
    const { ac, sid, P, state } = this;
    const hook = (id, t) => { if (id === sid) { this.tap.push(t); if (this.tap.length > 60) this.tap.shift(); } return false; };
    ac.local.lineHooks.add(hook);
    const skipRest = (why) => { state.steps.push({ name: 'Abbruch', status: 'fail', ms: 0, detail: why }); };
    try {
      const on = await this.step('Server läuft, Spieler ist online', async () => {
        if (!NAME_RE.test(P)) throw new Error('Ungültiger Spielername.');
        if (!ac.isOnline(sid)) throw new Error('Der Server läuft nicht.');
        if (ac.onlineNames(sid).some((n) => lc(n) === lc(P))) return { detail: `${P} ist online.` };
        // Blockhaus may have missed the join (it reads the console): the server itself is the better witness
        const r = await this.q('Pos');
        if (r && !r.offline) return { status: 'warn', detail: `${P} ist online (der Server bestätigt es), steht aber nicht in Blockhaus' Spielerliste. Meist wurde der Beitritt nicht in der Konsole erkannt.` };
        if (r && r.offline) throw new Error(`${P} ist nicht online. Tritt dem Server bei und starte den Test erneut.`);
        throw new Error(`Keine Antwort des Servers auf die Frage, ob ${P} online ist. Letzte Konsolenzeilen: ${this.raw() || '(keine)'}`);
      });
      if (on.status === 'fail') return skipRest('Ohne laufenden Server und Spieler kann nichts getestet werden.');

      // ---- speed of the server's answers (this is what every check and every button depends on)
      const lat = await this.step('Antwortzeit des Servers (5 Abfragen)', async () => {
        const ms = [];
        for (let i = 0; i < 5; i++) {
          const t0 = Date.now(); const r = await this.q('Pos'); ms.push(Date.now() - t0);
          if (!r) throw new Error(`Keine erkannte Antwort innerhalb von 8 s. Das heißt meist: das Log-Format des Servers wird nicht erkannt oder der Server ist überlastet. Letzte Konsolenzeilen: ${this.raw() || '(keine)'}`);
          if (r.offline) throw new Error(`${P} ist nicht (mehr) online.`);
        }
        ms.sort((a, b) => a - b);
        const d = `kleinste ${ms[0]} ms, mittlere ${ms[2]} ms, größte ${ms[4]} ms`;
        if (ms[4] > SLOW_QUERY_MS) return { status: 'warn', detail: `${d}. Langsam: Der Server beantwortet Abfragen erst nach dem nächsten Tick-Durchlauf; Aktionen dauern dadurch länger.` };
        return { detail: d };
      });
      if (lat.status === 'fail') return skipRest('Ohne Antworten des Servers geht es nicht weiter.');

      // ---- what is free?
      let live = null;
      const prep = await this.step('Freie Plätze suchen', async () => {
        live = await ac.liveFindings(sid, P);
        if (!live) throw new Error(`Inventar konnte nicht gelesen werden (keine Antwort, Antwort nicht lesbar). Letzte Zeilen: ${this.raw()}`);
        const used = new Set((Array.isArray(live.data.Inventory) ? live.data.Inventory : []).map((it) => Number(it.Slot)));
        const eq = live.data.equipment || {};
        const ender = new Set((Array.isArray(live.data.EnderItems) ? live.data.EnderItems : []).map((it) => Number(it.Slot)));
        const freeInv = [...Array(27).keys()].map((i) => i + 9).concat([...Array(9).keys()]).filter((i) => !used.has(i));
        const freeEnder = [...Array(27).keys()].filter((i) => !ender.has(i));
        this.free = { inv: freeInv, ender: freeEnder, head: !(eq.head && eq.head.id), off: !(eq.offhand && eq.offhand.id) };
        const existing = live.findings.length;
        return { detail: `${freeInv.length} freie Inventarplätze, ${freeEnder.length} in der Endertruhe, Helm ${this.free.head ? 'frei' : 'belegt'}, Zweithand ${this.free.off ? 'frei' : 'belegt'}.${existing ? ` Hinweis: ${existing} unmögliche(s) Item(s) trägt der Spieler schon (werden nicht angefasst).` : ''}` };
      });
      if (prep.status === 'fail') return skipRest('Das Inventar muss lesbar sein.');

      // ---- place test items
      const kinds = [];
      const take = (arr) => arr.shift();
      const freeInv = [...this.free.inv]; const freeEnder = [...this.free.ender];
      for (const k0 of KINDS) {
        const k = { ...k0 };
        if (k.needs === 'inv') { if (!freeInv.length) { state.steps.push({ name: `Testitem setzen: ${k.label}`, status: 'skip', ms: 0, detail: 'Kein freier Inventarplatz.' }); continue; } k.slot = take(freeInv); }
        else if (k.needs === 'ender') { if (!freeEnder.length) { state.steps.push({ name: `Testitem setzen: ${k.label}`, status: 'skip', ms: 0, detail: 'Kein freier Platz in der Endertruhe.' }); continue; } k.slot = take(freeEnder); }
        else if (k.needs === 'head' && !this.free.head) { state.steps.push({ name: `Testitem setzen: ${k.label}`, status: 'skip', ms: 0, detail: 'Der Spieler trägt einen Helm; nichts wird überschrieben.' }); continue; }
        else if (k.needs === 'off' && !this.free.off) { state.steps.push({ name: `Testitem setzen: ${k.label}`, status: 'skip', ms: 0, detail: 'Die Zweithand ist belegt; nichts wird überschrieben.' }); continue; }
        const s = await this.step(`Testitem setzen: ${k.label}`, async () => { await this.put(k); return { detail: `${k.top} in ${cmdOf(k)}` }; });
        if (s.status === 'ok') kinds.push(k);
      }
      if (!kinds.length) return skipRest('Es konnte kein Testitem gesetzt werden.');

      // ---- detection 1: asked live
      const found = (list, k) => list.find((f) => f.type === k.type && f.evidence.container === k.container && Number(f.evidence.slot) === k.slot && bare(f.evidence.topId) === k.top);
      let liveFlags = [];
      await this.step('Live-Prüfung: der Server wird nach dem Inventar gefragt', async () => {
        const l = await ac.liveFindings(sid, P);
        if (!l) throw new Error('Keine (lesbare) Antwort. Letzte Zeilen: ' + this.raw());
        liveFlags = kinds.map((k) => found(l.findings, k));
        const miss = kinds.filter((k) => !found(l.findings, k));
        if (miss.length) throw new Error(`Nicht erkannt: ${miss.map((k) => k.label).join(', ')}.`);
        return { detail: `Alle ${kinds.length} Testitems erkannt.` };
      });

      // ---- detection 2: saved player file (what the regular check reads)
      let fileFlags = [];
      await this.step('Speichern und Spielerdatei prüfen (wie die regelmäßige Prüfung)', async (s) => {
        const sv = await ac.saveNow(sid);
        if (!sv.ok) { s.status = 'warn'; }
        const ff = ac.fileFindings(sid, P);
        if (!ff) throw new Error('Keine Spielerdatei gefunden (der Name fehlt in usercache.json oder die Datei ist nicht lesbar).');
        const miss = kinds.filter((k) => !found(ff.findings, k));
        if (miss.length) throw new Error(`In der Datei nicht erkannt: ${miss.map((k) => k.label).join(', ')}${sv.ok ? '' : ' (der Server hat „Saved the game“ nicht bestätigt, die Datei ist vielleicht noch alt)'}.`);
        fileFlags = kinds.map((k) => found(ff.findings, k));
        const why = [];
        if (ac.exempt(sid, P)) why.push('Dieser Spieler ist ausgenommen (Operator oder Liste): im Normalbetrieb entstehen für ihn KEINE Item-Meldungen');
        if (ff.mode === 1 && ac.store(sid).config.skipCreative) why.push('Der Spieler ist im Kreativmodus: dann werden Items nicht gemeldet');
        return { status: sv.ok && !why.length ? 'ok' : 'warn', detail: `Speichern ${sv.ms} ms. Alle ${kinds.length} Testitems in der Datei erkannt.${why.length ? ' ' + why.join('. ') + '.' : ''}` };
      });

      // ---- the removal itself, with the same code as the button
      for (let i = 0; i < kinds.length; i++) {
        const k = kinds[i];
        await this.step(`Entfernen: ${k.label}`, async () => {
          const src = fileFlags[i] || liveFlags[i];
          const ev = src ? src.evidence : null;
          if (!ev) throw new Error('Das Testitem wurde nirgends erkannt, deshalb gibt es keine Meldung, die man entfernen könnte.');
          const f = this.makeFlag(k, ev);
          const t0 = Date.now();
          await ac.act(sid, f.id, 'remove-item');
          const ms = Date.now() - t0;
          const e = await this.slotEmpty(k);
          if (e === null) throw new Error('Kontrollabfrage ohne Antwort.');
          if (!e) throw new Error('Der Platz ist nach dem Entfernen NICHT leer.');
          this.placed = this.placed.filter((p) => p !== k);
          return { status: ms > SLOW_ACTION_MS ? 'warn' : 'ok', detail: `Entfernt und geprüft in ${ms} ms${ms > SLOW_ACTION_MS ? ' (langsam)' : ''}.` };
        });
      }

      // ---- the player moved it before the admin clicked
      const inv = kinds.find((k) => k.id === 'inv');
      if (inv && ac.local) {
        await this.step('Spieler hat das Item verschoben, bevor du geklickt hast', async () => {
          const ev0 = { ...(fileFlags[kinds.indexOf(inv)] || liveFlags[kinds.indexOf(inv)] || {}).evidence };
          if (!ev0.item) throw new Error('Übersprungen (kein Fund aus der Datei).');
          const other = { ...inv, slot: this.free.inv.find((s) => s !== inv.slot && !this.placed.some((p) => p.container === 'inventory' && p.slot === s)) };
          if (other.slot === undefined) return { status: 'skip', detail: 'Kein zweiter freier Platz.' };
          await this.put(inv);                          // bedrock is in the original slot again …
          const f = this.makeFlag(inv, ev0, 'moved');   // … and the flag points at it …
          await ac.replaceSlot(sid, P, cmdOf(inv), 'minecraft:air'); // … then the player moves it
          await this.put(other);
          this.placed = this.placed.filter((p) => p !== inv);
          const t0 = Date.now();
          await ac.act(sid, f.id, 'remove-item');
          const ms = Date.now() - t0;
          const e = await this.slotEmpty(other);
          if (!e) throw new Error('Das verschobene Item wurde nicht entfernt.');
          this.placed = this.placed.filter((p) => p !== other);
          return { status: ms > SLOW_ACTION_MS ? 'warn' : 'ok', detail: `Platz ${inv.slot} → ${other.slot}: gefunden und entfernt in ${ms} ms.` };
        });
      }
    } catch (e) {
      state.steps.push({ name: 'Unerwarteter Fehler', status: 'fail', ms: 0, detail: e && e.message ? e.message : String(e) });
    } finally {
      await this.cleanup().catch(() => {});
      ac.local.lineHooks.delete(hook);
      const st = state.steps;
      state.summary = { ok: st.filter((s) => s.status === 'ok').length, warn: st.filter((s) => s.status === 'warn').length, fail: st.filter((s) => s.status === 'fail').length, skip: st.filter((s) => s.status === 'skip').length, totalMs: Date.now() - state.startedAt };
      state.running = false; state.finishedAt = Date.now();
    }
  }

  makeFlag(k, evidence, tag = 'remove') {
    const store = this.ac.store(this.sid);
    const { flag } = store.add({ player: this.P, type: k.type, key: `selftest:${tag}:${k.id}`, severity: 'info', points: 0, message: `Selbsttest (${k.label})`, evidence }, { gapMs: 0 });
    flag.selftest = true; flag.ack = true;
    return flag;
  }

  /** Whatever of the test items is still there is removed (only if it really is the test item); the test findings are deleted. */
  async cleanup() {
    const left = [];
    for (const k of this.placed) {
      try {
        const r = await this.q(pathOf(k) + '.id');
        if (r && !r.none && !r.offline && bare(r.value) === k.top) { await this.ac.replaceSlot(this.sid, this.P, cmdOf(k), 'minecraft:air'); left.push(k.label); }
      } catch { /* the server may be gone */ }
    }
    this.placed = [];
    if (left.length) this.state.steps.push({ name: 'Aufräumen', status: 'warn', ms: 0, detail: `Übrig gebliebene Testitems entfernt: ${left.join(', ')}.` });
    this.ac.store(this.sid).drop((f) => f.selftest);
  }
}

module.exports = { SelfTest, KINDS };
