(() => {
'use strict';
// Page "Anticheat": warnings, players with points, settings, allow-lists. Nothing happens by itself: the buttons on a warning (remove item, kick, ban …) only act when an admin clicks and confirms.
const { h, put, api, toast, S, P, header, every, getToken, main } = window.BH;

const TYPES = {
  'illegal-item': 'Unmögliches Item', 'over-enchant': 'Zu hohe Verzauberung', 'over-stack': 'Zu großer Stapel', unbreakable: 'Unzerbrechlich', 'custom-attr': 'Eigene Attribute',
  'vanilla-move': 'Server-Warnung: Bewegung', 'floating-kick': 'Schwebe-Kick', 'spam-kick': 'Spam-Kick', 'chat-spam': 'Chat-Spam', 'command-spam': 'Befehls-Spam',
  speed: 'Zu schnell', teleport: 'Großer Sprung', fly: 'Fliegen / Schweben', xray: 'X-Ray-Hinweis', flood: 'Verbindungsflut', 'many-names': 'Viele Namen pro Adresse',
  'mod-unknown': 'Mod/Plugin nicht erlaubt', 'mod-changed': 'Mod/Plugin geändert', 'pack-unknown': 'Texturpaket nicht erlaubt',
};
const ITEM_TYPES = ['illegal-item', 'over-enchant', 'over-stack', 'unbreakable', 'custom-attr'];
const SLOT_NAMES = { 100: 'Füße', 101: 'Beine', 102: 'Brust', 103: 'Kopf', '-106': 'Zweithand' };
const slotText = (ev) => (ev.container === 'ender' ? `Endertruhe, Platz ${ev.slot}` : SLOT_NAMES[ev.slot] ? `Rüstung/Hand (${SLOT_NAMES[ev.slot]})` : `Inventar, Platz ${ev.slot}`);
/** Which buttons a warning gets. [action, label, kind] */
function actionsFor(f) {
  const ev = f.evidence || {};
  const out = [];
  const named = f.player && ev.nameKnown !== false;
  const did = (a) => (f.actions || []).some((x) => x.action === a && !x.failed);
  if (ITEM_TYPES.includes(f.type) && !did('remove-item') && !f.pending && named && ev.slot !== undefined && ev.slot !== null) out.push(['remove-item', ev.nested ? 'Behälter entfernen' : 'Item entfernen', 'primary']);
  if (f.type === 'teleport' && named && Array.isArray(ev.from)) out.push(['tp-back', 'Zurücksetzen', '']);
  if (['mod-unknown', 'mod-changed'].includes(f.type) && !did('mod-disable') && ev.file && !String(ev.file).endsWith('.disabled')) out.push(['mod-disable', 'Mod abschalten', '']);
  if (named) out.push(['tell', 'Verwarnen', ''], ['kick', 'Kicken', ''], ['ban', 'Bannen', 'danger']);
  if (ev.ip) out.push(['ban-ip', 'Adresse sperren', 'danger']);
  return out;
}
const LEVEL = { ok: ['in Ordnung', ''], warn: ['auffällig', 'warn'], high: ['hoch', 'err'] };
const SEV = { info: 'Info', warn: 'Warnung', high: 'Schwer' };

const CHECKS = [
  ['items', 'Items prüfen', 'Unmögliche Items (Bedrock, Befehlsblöcke, Spawner, Spawn-Eier …), zu hohe Verzauberungen, zu große Stapel, unzerbrechliche Gegenstände. Liest die gespeicherten Spielerdaten (neue Daten gibt es beim Speichern, alle paar Minuten, und beim Verlassen).'],
  ['itemsLive', 'Items live prüfen (schnell)', 'Fragt das Inventar, die Endertruhe und die Ausrüstung jedes Online-Spielers alle paar Sekunden beim Server ab, damit ein unmögliches Item sofort auffällt statt erst beim Speichern. Schreibt pro Spieler und Runde drei Zeilen ins Server-Log (latest.log); in der Konsolen-Ansicht von Blockhaus fehlen sie. Ohne diese Option bleibt nur die Dateiprüfung.'],
  ['vanillaWarnings', 'Warnungen des Servers zählen', '„moved too quickly“ und „moved wrongly“ aus dem Server-Log, wenn sie sich häufen, dazu Kicks wegen Schwebens. Nicht gezählt: Stürze, Würfe nach oben (Enderdrache, Explosion), Portalreisen, /tp, Elytra, Fahrzeuge, Kreativ.'],
  ['flood', 'Verbindungsflut und Namen pro Adresse', 'Viele Verbindungsversuche von einer Adresse in kurzer Zeit, viele verschiedene Namen von einer öffentlichen Adresse. Es wird nur gemeldet, nichts gesperrt.'],
  ['spam', 'Chat- und Befehls-Spam', 'Zu viele oder immer gleiche Nachrichten. Befehle sieht nur ein Server, der sie loggt (Vanilla tut das nicht).'],
  ['xray', 'X-Ray-Statistik', 'Vergleicht abgebaute seltene Erze mit allem Abgebauten aus den Statistik-Dateien. Nur ein Hinweis.'],
  ['speed', 'Geschwindigkeit und große Sprünge', 'Fragt Online-Spieler alle paar Sekunden nach der Position (`data get entity`). Das schreibt Zeilen ins Server-Log.'],
  ['fly', 'Fliegen und Schweben', 'Wie oben: gleichbleibende Höhe ohne Boden oder Aufstieg ohne Bodenkontakt. Fahrzeuge, Elytra, Kreativmodus, Wasser und Leitern werden ausgenommen.'],
  ['mods', 'Mods und Plugins gegen die Erlaubt-Liste', 'Nur aktiv, wenn die Liste unten eingeschaltet ist.'],
  ['packs', 'Texturpaket gegen die Erlaubt-Liste', 'Nur aktiv, wenn die Liste unten eingeschaltet ist.'],
];
const NUMS = [
  ['pollSec', 'Abfrage-Abstand (s)', 'Wie oft Online-Spieler nach Position abgefragt werden.'],
  ['itemLiveSec', 'Live-Item-Prüfung alle (s)', 'Wie oft das Inventar jedes Online-Spielers abgefragt wird. Kleiner = schneller, aber mehr Zeilen im Server-Log.'],
  ['speedBps', 'Höchstgeschwindigkeit (Blöcke/s)', 'Zu Fuß rennen sind etwa 5,6; Sprinten mit Sprung bis 8. Mit Speed-Trank wird die Grenze automatisch höher.'],
  ['speedStrikes', 'Wie oft hintereinander zu schnell', 'So viele Abfragen in Folge müssen über der Grenze liegen.'],
  ['teleportBlocks', 'Sprung ab (Blöcke)', 'Distanz zwischen zwei Abfragen, ab der ein „Sprung“ gemeldet wird. Ein Tod mit Respawn kann so aussehen.'],
  ['flyOffGroundSamples', 'Schweben nach (Abfragen)', 'So viele Abfragen in Folge in gleicher Höhe.'],
  ['vanillaWarnCount', 'Server-Warnungen pro Minute', 'Ab so vielen unerklärten „moved too quickly“ in 60 s (mindestens 3). Die Prüfung wartet auf die nächste Positionsmessung, deshalb kommt die Meldung einige Sekunden später.'],
  ['floodJoins', 'Verbindungen für „Flut“', 'Versuche von einer Adresse innerhalb des Zeitfensters.'],
  ['floodWindowS', 'Zeitfenster Flut (s)', ''],
  ['namesPerIp', 'Namen pro Adresse', 'Verschiedene Spielernamen von einer öffentlichen Adresse in 24 Stunden.'],
  ['chatPer10s', 'Nachrichten pro 10 s', ''], ['cmdPer10s', 'Befehle pro 10 s', ''], ['repeatMsgs', 'Gleiche Nachricht (×) in 30 s', ''],
  ['xrayMinOre', 'X-Ray: mindestens seltene Erze', ''], ['xrayRatio', 'X-Ray: Anteil seltener Erze', '0,04 = 4 % aller abgebauten Blöcke.'],
  ['warnPoints', 'Punkte für „auffällig“', 'Punkte nehmen mit der Zeit ab.'], ['highPoints', 'Punkte für „hoch“', ''], ['halfLifeMin', 'Punkte halbieren sich nach (min)', ''],
];

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} Tagen`;
}
const when = (ts) => new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });

async function page(token) {
  const A = P('/anticheat');
  let d = await api('GET', A);
  if (token !== getToken()) return;
  if (!d.available) { put(main, header('Anticheat'), h('div', { class: 'notice warn' }, d.reason)); return; }

  let cfg = JSON.parse(JSON.stringify(d.config));
  let dirty = false;
  let filter = { type: '', player: '', open: true };
  async function doAct(f, action) {
    const ev = f.evidence || {};
    let text = '';
    if (action === 'remove-item') {
      const what = ev.nested ? `den ganzen Behälter ${ev.topId} (darin liegt ${ev.item})` : String(ev.item || ev.topId);
      if (!confirm(`${f.player}: ${what} aus „${slotText(ev)}“ entfernen?\n\nDas Item verschwindet endgültig aus dem Spiel. Eine Kopie (NBT) bleibt in den Details der Meldung. Ist der Spieler offline, wird es beim nächsten Beitritt entfernt.`)) return;
    } else if (action === 'kick') { text = prompt(`${f.player} kicken. Grund (sieht der Spieler):`, 'Vom Server-Admin entfernt'); if (text === null) return; }
    else if (action === 'ban') { text = prompt(`${f.player} BANNEN (bis du ihn in der Spielerliste entsperrst). Grund:`, 'Verstoß gegen die Serverregeln'); if (text === null) return; }
    else if (action === 'tell') { text = prompt(`Nachricht an ${f.player}:`, 'Bitte lass solche Dinge. Der Server protokolliert das.'); if (!text) return; }
    else if (action === 'tp-back') { if (!confirm(`${f.player} zurück nach ${ev.from.join(' ')} (${ev.dim}) setzen?`)) return; }
    else if (action === 'ban-ip') { if (!confirm(`Adresse ${ev.ip} sperren?\n\nAchtung: Hinter derselben Adresse können mehrere Personen sitzen (Heimnetz).`)) return; text = 'Anticheat: Verbindungsflut'; }
    else if (action === 'mod-disable') { if (!confirm(`${ev.file} abschalten? Die Datei bekommt die Endung .disabled; der Server muss neu starten.`)) return; }
    const r = await api('POST', A + '/act', { id: f.id, action, text });
    toast(r.message + (r.restartNeeded ? ' Neustart nötig.' : ''));
    await reload();
  }
  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---- self-test: runs on the real server with a player you pick
  const ST_ICON = { ok: '✓', warn: '⚠', fail: '✗', skip: '–', run: '…' };
  const stBox = h('div', {});
  const pick = h('input', { type: 'text', list: 'ac-st-players', placeholder: 'Spielername', 'aria-label': 'Spieler für den Selbsttest', autocomplete: 'off', spellcheck: 'false', maxlength: '16', style: 'width:auto;min-width:180px' });
  const pickList = h('datalist', { id: 'ac-st-players' });
  let stState = null; let stBusy = false; let runningShown = d.running;
  const lastPlayer = () => { try { return localStorage.getItem('bh-ac-selftest-player') || ''; } catch { return ''; } };
  function fillPick() {
    const on = d.players.filter((p) => p.online).map((p) => p.name);
    const names = [...on, ...(d.known || []).filter((n) => !on.includes(n))];
    const have = [...pickList.options].map((o) => o.value).join('|');
    if (!pick.value) pick.value = on[0] || lastPlayer();
    if (have === names.join('|')) return false;
    pickList.replaceChildren(...names.map((n) => h('option', { value: n }, on.includes(n) ? 'online' : 'bekannt')));
    return true;
  }
  async function stPoll() {
    for (;;) {
      if (token !== getToken()) return;
      const r = await api('GET', A + '/selftest');
      stState = r.state; paintSelfTest();
      if (!stState || !stState.running) { stBusy = false; paintSelfTest(); return; }
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  async function stStart() {
    const who = pick.value.trim();
    if (!/^[A-Za-z0-9_.]{1,16}$/.test(who)) { toast('Bitte deinen Spielernamen eintragen (Buchstaben, Zahlen, _ und .).', true); return; }
    if (!confirm(`Selbsttest mit „${who}“ starten?\n\nIn leere Plätze von ${who} werden kurz Testitems gelegt (Bedrock, eine Shulkerbox mit Bedrock, ein Barrier-Block als Helm, ein Befehlsblock in der Zweithand, ein Strukturblock in der Endertruhe). Blockhaus findet sie, entfernt sie wieder und räumt auf. Belegte Plätze werden nie angefasst. Dauer: etwa 10 bis 30 Sekunden.`)) return;
    try { localStorage.setItem('bh-ac-selftest-player', who); } catch { /* optional */ }
    stBusy = true;
    const r = await api('POST', A + '/selftest', { player: who });
    stState = r.state; paintSelfTest();
    stPoll().catch((e) => { stBusy = false; toast(e.message, true); });
  }
  function paintSelfTest() {
    const st = stState; const running = !!(st && st.running);
    const sum = st && st.summary;
    put(stBox, h('div', { class: 'card', id: 'ac-selftest' },
      h('h2', { style: 'margin-top:0' }, 'Selbsttest'),
      h('p', { class: 'small muted' }, 'Trage deinen Spielernamen ein oder wähle ihn aus der Liste; du musst auf dem Server sein. Prüft auf dem echten Server mit einem Spieler deiner Wahl, ob Erkennen und Entfernen wirklich funktionieren, und misst, wie lange der Server für Antworten braucht. Starte ihn am besten im Überlebensmodus; für Operatoren und im Kreativmodus meldet der Anticheat im Normalbetrieb keine Items (der Test sagt dir das).'),
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' },
        h('span', {}, 'Spieler:'), pick, pickList,
        h('button', { class: 'primary', disabled: running || stBusy || !d.running, onclick: mut(stStart) }, running ? 'Läuft …' : 'Selbsttest starten'),
        !d.running ? h('span', { class: 'small muted' }, 'Der Server läuft nicht.') : null),
      st ? h('div', { style: 'margin-top:12px' },
        h('p', { class: 'small' }, `Spieler ${st.player}, gestartet ${when(st.startedAt)}`, running ? ' …' : ''),
        h('ul', { class: 'plist' }, st.steps.map((x) => h('li', {},
          h('span', { class: 'chip ' + (x.status === 'ok' ? 'on' : x.status === 'fail' ? 'err' : x.status === 'warn' ? 'warn' : '') , style: 'min-width:2em;text-align:center' }, ST_ICON[x.status] || '?'),
          h('div', { class: 'nm' }, h('b', {}, x.name), x.status === 'run' ? '' : ` (${x.ms} ms)`, x.detail ? h('small', {}, x.detail) : null)))),
        sum ? h('div', { class: 'notice ' + (sum.fail ? 'err' : sum.warn ? 'warn' : 'ok') },
          h('span', {}, h('b', {}, sum.fail ? `${sum.fail} Schritt(e) fehlgeschlagen` : sum.warn ? 'Bestanden, mit Hinweisen' : 'Alles bestanden'), ` – ${sum.ok} in Ordnung, ${sum.warn} Hinweise, ${sum.fail} Fehler, ${sum.skip} übersprungen. Gesamtdauer ${(sum.totalMs / 1000).toFixed(1)} s.`)) : null) : null));
  }

  const bannerBox = h('div', {});
  const playersBox = h('div', {});
  const flagsBox = h('div', {});
  const saveBox = h('div', {});
  const allowBox = h('div', {});

  async function reload() {
    d = await api('GET', A);
    if (token !== getToken()) return;
    paintBanner(); paintPlayers(); paintFlags();
    if (!stBusy && (fillPick() || runningShown !== d.running)) { runningShown = d.running; paintSelfTest(); }
    window.BH.refreshAnticheatBadge && window.BH.refreshAnticheatBadge();
  }

  /** What the live item check costs: it asks 3 times per player and round, and the server writes each answer into latest.log. */
  function liveItemNotice() {
    const c = d.config;
    if (!c.enabled || !c.checks.items) return null;
    if (!c.checks.itemsLive) return h('div', { class: 'notice warn' }, 'Items live prüfen ist aus: neue Items fallen erst auf, wenn Minecraft die Spielerdatei schreibt (alle paar Minuten oder beim Verlassen des Spielers).');
    const sec = c.thresholds.itemLiveSec; const st = d.status || {};
    if (!d.running) return null;
    const players = (d.players || []).filter((p) => p.online).length;
    const perHour = Math.round(players * 3 * 3600 / sec);
    return h('div', { class: 'notice' }, h('span', {},
      `Items live prüfen: alle ${sec} s, jetzt ${players} online`,
      st.itemLiveMs ? `, letzte Runde ${st.itemLiveMs} ms` : '',
      `. Das schreibt etwa ${perHour.toLocaleString('de-DE')} Zeilen pro Stunde in die Server-Datei latest.log (nicht in die Konsole hier). Ein neues Item fällt nach höchstens ${sec} s auf. Mehr Abstand = weniger Log, später gemeldet.`));
  }

  function paintBanner() {
    const c = d.counts;
    put(bannerBox,
      !d.config.enabled ? h('div', { class: 'notice warn' }, 'Der Anticheat ist ausgeschaltet. Es wird nichts aufgezeichnet.') : null,
      d.config.enabled && !d.running ? h('div', { class: 'notice' }, 'Der Server läuft nicht. Geprüft werden nur gespeicherte Daten (Spielerdaten, Statistiken, Mods).') : null,
      liveItemNotice(),
      c.open ? h('div', { class: 'notice ' + (c.high ? 'err' : 'warn') },
        h('span', {}, h('b', {}, `${c.open} offene ${c.open === 1 ? 'Meldung' : 'Meldungen'}`), c.high ? ` – davon ${c.high} schwer.` : '.', ' Der Anticheat hat niemanden gekickt oder gewarnt; entscheide selbst.'),
        h('span', { class: 'row' }, h('button', { onclick: mut(async () => { await api('POST', A + '/ack', { all: true }); await reload(); }) }, 'Alle als gesehen markieren')))
        : (d.config.enabled ? h('div', { class: 'notice ok' }, 'Keine offenen Meldungen.') : null));
  }

  function paintPlayers() {
    const rows = d.players.map((p) => {
      const [lab, cls] = LEVEL[p.level] || LEVEL.ok;
      return h('tr', {},
        h('td', {}, h('b', {}, p.name), ' ', p.online ? h('span', { class: 'chip on' }, 'online') : null, ' ', p.exempt ? h('span', { class: 'chip', title: p.op ? 'Operator' : 'Ausgenommen' }, p.op ? 'Operator' : 'ausgenommen') : null),
        h('td', {}, h('span', { class: 'chip ' + cls }, lab)),
        h('td', { class: 'num' }, String(p.score)),
        h('td', { class: 'num' }, `${p.open} / ${p.total}`),
        h('td', { class: 'muted' }, p.last ? ago(p.last) : ''),
        h('td', { class: 'acts' },
          p.total ? h('button', { class: 'small', onclick: () => { filter.player = p.name; filter.open = false; paintFlags(); document.getElementById('ac-flags').scrollIntoView({ behavior: 'smooth' }); } }, 'Meldungen') : null,
          p.open ? h('button', { class: 'small', onclick: mut(async () => { await api('POST', A + '/ack', { player: p.name }); await reload(); }) }, 'Gesehen') : null));
    });
    put(playersBox, h('div', { class: 'card' },
      h('h2', {}, 'Spieler'),
      rows.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'files' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Einstufung'), h('th', { class: 'num' }, 'Punkte'), h('th', { class: 'num' }, 'Offen / gesamt'), h('th', {}, 'Zuletzt'), h('th', {}))), h('tbody', {}, rows)))
        : h('div', { class: 'empty' }, 'Noch keine Meldungen zu Spielern.'),
      h('p', { class: 'muted small' }, 'Punkte: jede offene Meldung zählt, höchstens dreimal, und halbiert sich mit der Zeit. Sie sind nur eine Orientierung.')));
  }

  function paintFlags() {
    const list = d.flags.filter((f) => (!filter.type || f.type === filter.type) && (!filter.player || (f.player || '') === filter.player) && (!filter.open || !f.ack));
    const types = [...new Set(d.flags.map((f) => f.type))];
    put(flagsBox, h('div', { class: 'card', id: 'ac-flags' },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('h2', { style: 'margin:0' }, 'Meldungen'),
        h('span', { class: 'row' },
          h('select', { style: 'width:auto', 'aria-label': 'Art filtern', onchange: (e) => { filter.type = e.target.value; paintFlags(); } },
            h('option', { value: '' }, 'Alle Arten'), types.map((t) => h('option', { value: t, selected: t === filter.type }, TYPES[t] || t))),
          filter.player ? h('button', { class: 'small', onclick: () => { filter.player = ''; paintFlags(); } }, `Spieler: ${filter.player} ✕`) : null,
          h('label', { class: 'row', style: 'gap:6px' }, h('input', { type: 'checkbox', checked: filter.open, onchange: (e) => { filter.open = e.target.checked; paintFlags(); } }), 'nur offene'))),
      list.length ? h('ul', { class: 'plist', style: 'margin-top:10px' }, list.map((f) => h('li', { class: f.ack ? 'disabled' : '' },
        h('span', { class: 'chip ' + (f.severity === 'high' ? 'warn' : f.severity === 'warn' ? 'warn' : ''), title: 'Schweregrad' }, SEV[f.severity] || f.severity),
        h('div', { class: 'nm' }, h('b', {}, TYPES[f.type] || f.type), f.count > 1 ? ` ×${f.count}` : '', ' – ', f.message,
          h('small', {}, `${when(f.last)} (${ago(f.last)})${f.player ? '' : ' · betrifft den Server'}`),
          (f.actions || []).map((a) => h('small', { class: a.failed ? 'err' : '' }, `${a.failed ? '✗' : '✓'} ${a.note} (${when(a.ts)})`)),
          f.pending ? h('small', {}, '⏳ Vorgemerkt: wird beim nächsten Beitritt des Spielers ausgeführt.') : null,
          actionsFor(f).length ? h('span', { class: 'row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, actionsFor(f).map(([a, label, kind]) =>
            h('button', { class: 'small ' + kind, onclick: mut(() => doAct(f, a)) }, label))) : null,
          h('details', {}, h('summary', { class: 'muted small' }, 'Details'), h('pre', { class: 'code' }, JSON.stringify({ erstmals: when(f.ts), ...f.evidence, ...((f.actions || []).length ? { aktionen: f.actions } : {}) }, null, 1)))),
        f.ack ? h('span', { class: 'chip' }, 'gesehen') : h('button', { class: 'small', onclick: mut(async () => { await api('POST', A + '/ack', { id: f.id }); await reload(); }) }, 'Gesehen'))))
        : h('div', { class: 'empty' }, d.flags.length ? 'Keine Meldungen mit diesem Filter.' : 'Keine Meldungen.'),
      d.flags.length ? h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'small', onclick: mut(async () => { const r = await api('POST', A + '/clear', { acked: true }); toast(`${r.removed} gelöscht.`); await reload(); }) }, 'Gesehene löschen'),
        h('button', { class: 'small danger', onclick: mut(async () => { if (!confirm('Alle Meldungen löschen?')) return; await api('POST', A + '/clear', { all: true }); await reload(); }) }, 'Alle löschen')) : null));
  }

  // ---- settings ----
  // repaint only on the change clean -> dirty: a re-render between mouse-down and mouse-up (a field loses focus when the button is pressed) would swallow the click
  function markDirty() { if (dirty) return; dirty = true; paintSave(); }
  function paintSave() {
    put(saveBox, dirty ? h('div', { class: 'savebar' }, h('span', { class: 'muted' }, 'Ungespeicherte Änderungen'),
      h('span', { class: 'row' },
        h('button', { onclick: () => { cfg = JSON.parse(JSON.stringify(d.config)); dirty = false; paintSettings(); paintSave(); paintAllow(); } }, 'Verwerfen'),
        h('button', { class: 'primary', onclick: mut(save) }, 'Speichern'))) : null);
  }
  async function save() {
    d = await api('PUT', A + '/config', cfg);
    cfg = JSON.parse(JSON.stringify(d.config)); dirty = false;
    toast('Gespeichert.'); paintSave(); paintSettings(); paintBanner(); paintPlayers(); paintFlags(); paintAllow();
  }
  const settingsBox = h('div', {});
  function sw(get, set, label) {
    return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: get(), 'aria-label': label, onchange: (e) => { set(e.target.checked); markDirty(); } }), h('i'));
  }
  function paintSettings() {
    put(settingsBox, h('div', { class: 'card' },
      h('h2', {}, 'Einstellungen'),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Anticheat eingeschaltet'), h('small', {}, 'Er beobachtet und meldet; von selbst kickt, bannt oder warnt er niemanden. Maßnahmen löst nur du per Knopf an einer Meldung aus.')), sw(() => cfg.enabled, (v) => { cfg.enabled = v; }, 'Anticheat eingeschaltet')),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Operatoren ausnehmen'), h('small', {}, 'Operatoren (ops.json) werden weder abgefragt noch gemeldet.')), sw(() => cfg.exemptOps, (v) => { cfg.exemptOps = v; }, 'Operatoren ausnehmen')),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Spieler im Kreativmodus bei Items überspringen'), h('small', {}, 'Im Kreativmodus gibt es alle Items legal.')), sw(() => cfg.skipCreative, (v) => { cfg.skipCreative = v; }, 'Kreativ überspringen')),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Private Adressen bei „Namen pro Adresse“ ignorieren'), h('small', {}, 'Heimnetz und Tunnel zeigen oft für alle dieselbe Adresse.')), sw(() => cfg.ignorePrivateIps, (v) => { cfg.ignorePrivateIps = v; }, 'Private Adressen ignorieren')),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Weitere ausgenommene Spieler'), h('small', {}, 'Namen, durch Komma oder Leerzeichen getrennt.')),
        h('input', { type: 'text', class: 'ctl', value: cfg.exempt.join(', '), 'aria-label': 'Ausgenommene Spieler', oninput: (e) => { cfg.exempt = e.target.value.split(/[\s,]+/).filter(Boolean); markDirty(); } })),
      h('h2', { style: 'margin-top:16px' }, 'Prüfungen'),
      CHECKS.map(([k, t, s]) => h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, t), h('small', {}, s)), sw(() => cfg.checks[k], (v) => { cfg.checks[k] = v; }, t))),
      h('details', { style: 'margin-top:12px' }, h('summary', {}, 'Schwellwerte'),
        NUMS.map(([k, t, s]) => h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, t), s ? h('small', {}, s) : null),
          h('input', { type: 'number', class: 'ctl', step: 'any', value: cfg.thresholds[k], 'aria-label': t, onchange: (e) => { cfg.thresholds[k] = Number(e.target.value); markDirty(); } }))))));
  }

  // ---- allow-lists ----
  let allowData = null;
  async function loadAllow() { try { allowData = await api('GET', A + '/allow'); } catch (e) { allowData = { error: e.message }; } paintAllow(); }
  function paintAllow() {
    if (!allowData) { put(allowBox, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Lade …'))); return; }
    if (allowData.error) { put(allowBox, h('div', { class: 'card' }, h('div', { class: 'notice err' }, allowData.error))); return; }
    const m = allowData.mods; const p = allowData.packs;
    const status = (it) => {
      const e = cfg.allow.mods.entries.find((x) => x.file === it.file);
      if (e && e.sha256 === it.sha256) return ['erlaubt', 'on'];
      if (e) return ['geändert', 'warn'];
      return cfg.allow.mods.entries.some((x) => x.sha256 === it.sha256) ? ['erlaubt (umbenannt)', 'on'] : ['nicht erlaubt', 'warn'];
    };
    const packOk = p.current.sha1 && cfg.allow.packs.entries.some((e) => e.sha1 === p.current.sha1);
    put(allowBox, h('div', { class: 'card' },
      h('h2', {}, 'Erlaubt-Listen'),
      h('p', { class: 'muted small' }, 'Alles Unbekannte wird nur als Meldung aufgeführt. Von selbst wird nichts entfernt oder abgeschaltet (an der Meldung gibt es dafür einen Knopf). Zum Erlauben: „Aktuellen Stand übernehmen“ (merkt sich Dateiname und SHA-256).'),
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, m.kind === 'plugin' ? 'Plugins prüfen' : 'Mods prüfen'), h('small', {}, m.folder ? `Ordner „${m.folder}“, ${m.current.length} aktive Dateien.` : (m.reason || 'Dieser Server kann keine Mods oder Plugins laden.'))),
        sw(() => cfg.allow.mods.enabled, (v) => { cfg.allow.mods.enabled = v; }, 'Mods prüfen')),
      m.current.length ? h('ul', { class: 'plist' }, m.current.map((it) => { const [lab, cls] = status(it); return h('li', {}, h('div', { class: 'nm' }, it.file, h('small', {}, it.sha256.slice(0, 16) + '…')), h('span', { class: 'chip ' + (cls === 'on' ? 'on' : 'warn') }, lab)); })) : null,
      m.folder ? h('div', { class: 'row', style: 'margin:8px 0 14px' }, h('button', { class: 'small', onclick: mut(async () => { const r = await api('POST', A + '/allow/snapshot', { kind: 'mods' }); d.config.allow = r.allow; cfg.allow.mods.entries = r.allow.mods.entries; toast('Aktueller Stand ist jetzt erlaubt.'); paintAllow(); }) }, 'Aktuellen Stand übernehmen')) : null,
      h('div', { class: 'opt' }, h('div', { class: 'txt' }, h('b', {}, 'Texturpaket des Servers prüfen'), h('small', {}, p.current.url ? `Server verteilt ${p.current.url}${p.current.sha1 ? '' : ' (ohne Prüfsumme)'}.` : 'Der Server verteilt kein Texturpaket (resource-pack in server.properties ist leer).')),
        sw(() => cfg.allow.packs.enabled, (v) => { cfg.allow.packs.enabled = v; }, 'Texturpaket prüfen')),
      p.current.sha1 ? h('p', {}, h('span', { class: 'chip ' + (packOk ? 'on' : 'warn') }, packOk ? 'erlaubt' : 'nicht erlaubt'), ' ', h('code', {}, p.current.sha1.slice(0, 16) + '…')) : null,
      p.current.url ? h('div', { class: 'row', style: 'margin:8px 0' }, h('button', { class: 'small', onclick: mut(async () => { const r = await api('POST', A + '/allow/snapshot', { kind: 'packs' }); d.config.allow = r.allow; cfg.allow.packs.entries = r.allow.packs.entries; toast('Texturpaket ist jetzt erlaubt.'); paintAllow(); }) }, 'Aktuelles Paket übernehmen')) : null,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'small', onclick: mut(async () => { const r = await api('POST', A + '/scan', {}); toast(`Geprüft: ${r.items} Item-, ${r.xray} X-Ray-, ${r.allow} Listen-Funde.`); await reload(); }) }, 'Jetzt alles prüfen'))));
  }

  const limits = h('div', { class: 'card' },
    h('h2', {}, 'Was der Anticheat nicht sieht'),
    h('p', { class: 'small' }, 'Er arbeitet nur auf dem Server und sieht nicht, was der Client sendet. Deshalb erkennt er keine Reichweite, Killaura, Autoclicker, Scaffold, Nuker oder No-Fall, und er kann einen sauberen Cheater nicht von einem guten Spieler unterscheiden, wenn sich beide an die Server-Regeln halten.'),
    h('p', { class: 'small' }, h('b', {}, 'Clients: '), 'Welchen Client ein Spieler benutzt, kennt ein Vanilla-Server nicht (die Marke wird nicht ins Log geschrieben, und im Online-Modus ist sie verschlüsselt). Dafür gibt es hier bewusst keine Liste. Dasselbe gilt für Texturpakete, die ein Spieler selbst installiert hat: sichtbar ist nur das Paket, das der Server verteilt.'),
    h('p', { class: 'small' }, h('b', {}, 'Server-Log: '), 'Die Positionsabfragen schreiben pro Spieler und Runde drei Zeilen (eine mehr, wenn der Spieler gerade nicht am Boden steht, und bei Verdacht mehr) in die Server-Datei latest.log. Sie fehlen in der Konsolen-Ansicht von Blockhaus, nicht aber in der Datei. Wer das nicht möchte, schaltet „Geschwindigkeit“ und „Fliegen“ aus; alle anderen Prüfungen fragen nichts ab.'));

  put(main, header('Anticheat', 'Beobachtet und meldet. Es kickt, bannt oder warnt niemanden automatisch; Maßnahmen löst nur du per Knopf aus.'),
    bannerBox, stBox, playersBox, flagsBox, settingsBox, allowBox, limits, saveBox);
  fillPick(); paintBanner(); paintPlayers(); paintFlags(); paintSettings(); paintSave(); paintAllow(); paintSelfTest();
  loadAllow();
  api('GET', A + '/selftest').then((r) => { stState = r.state; paintSelfTest(); if (stState && stState.running) { stBusy = true; stPoll().catch(() => {}); } }).catch(() => {});
  every(() => { if (!document.hidden) reload().catch(() => {}); }, 6000);
}

window.BHAnticheat = { page };
})();
