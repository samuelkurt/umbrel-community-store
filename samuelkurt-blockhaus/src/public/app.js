(() => {
'use strict';

// ---------- tiny helpers ----------------------------------------------------------------
const main = document.getElementById('main');
const nav = document.getElementById('nav');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** replaceChildren that ignores null/false and flattens arrays (the native one would print "null"). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch { throw new Error('Das Blockhaus-Backend ist nicht erreichbar.'); }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fehler (HTTP ${res.status})`);
    err.code = data && data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isErr) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 8000 : 3500);
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { return null; }
  return null;
}

const ICONS = {
  server: '<path d="M4 6h16v5H4zM4 13h16v5H4z"/><path d="M8 8.5h.01M8 15.5h.01"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.8.7 3 2.4 3 4.7"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M7.5 9.5 10 12l-2.5 2.5M12 15h4.5"/>',
  log: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[name]; // constant strings only
  return s;
}

// ---------- app state ------------------------------------------------------------------
const S = { cfg: null, servers: [], sid: store('blockhaus.sid') };
let timers = [];
let routeToken = 0;

function every(fn, ms) { timers.push(setInterval(fn, ms)); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

const ROUTES = [
  { id: 'server', label: 'Server', icon: 'server', view: viewServer },
  { id: 'options', label: 'Optionen', icon: 'sliders', view: viewOptions },
  { id: 'players', label: 'Spieler', icon: 'users', view: viewPlayers },
  { id: 'console', label: 'Konsole', icon: 'terminal', view: viewConsole },
  { id: 'log', label: 'Log', icon: 'log', view: viewLog },
  { id: 'sep' },
  { id: 'settings', label: 'Einstellungen', icon: 'gear', view: viewSettings },
];

function renderNav(active) {
  nav.replaceChildren(...ROUTES.map((r) => (r.id === 'sep'
    ? h('div', { class: 'sep' })
    : h('a', { href: '#/' + r.id, class: r.id === active ? 'on' : '' }, icon(r.icon), r.label))));
}

async function route() {
  const token = ++routeToken;
  clearTimers();
  let id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'server';
  if (!ROUTES.some((r) => r.id === id && r.view)) id = 'server';
  renderNav(id);
  const def = ROUTES.find((r) => r.id === id);
  try {
    S.cfg = await api('GET', '/config');
    if (!S.cfg.configured && id !== 'settings') { location.hash = '#/settings'; return; }
    if (id !== 'settings') await loadServers();
    if (token !== routeToken) return;
    await def.view(token);
  } catch (e) {
    if (token !== routeToken) return;
    main.replaceChildren(errorBox(e));
  }
}

function errorBox(e) {
  return h('div', {},
    h('div', { class: 'notice err' }, h('span', {}, e.message || String(e)),
      h('span', { class: 'row' },
        h('a', { href: '#/settings' }, h('button', {}, 'Einstellungen')),
        h('button', { onclick: route }, 'Erneut versuchen'))));
}

async function loadServers() {
  S.servers = await api('GET', '/servers');
  if (!S.servers.length) throw new Error('In Crafty gibt es noch keinen Server.');
  if (!S.servers.some((s) => String(s.id) === String(S.sid))) S.sid = S.servers[0].id;
  store('blockhaus.sid', String(S.sid));
}

function header(title, sub, ...actions) {
  const picker = S.servers.length > 1
    ? h('select', { style: 'width:auto', 'aria-label': 'Server wählen', onchange: (e) => { S.sid = e.target.value; store('blockhaus.sid', S.sid); route(); } },
      S.servers.map((s) => h('option', { value: s.id, selected: String(s.id) === String(S.sid) }, s.name)))
    : null;
  return h('div', {},
    h('div', { class: 'head' }, h('h1', {}, title), h('div', { class: 'row' }, picker, actions)),
    sub ? h('p', { class: 'sub' }, sub) : null);
}

const P = (path) => `/servers/${encodeURIComponent(S.sid)}${path}`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\u001b/g, '');

// ---------- Server page ----------------------------------------------------------------
const STATE_LABEL = {
  offline: 'Offline', starting: 'Startet …', online: 'Online', stopping: 'Stoppt …', crashed: 'Abgestürzt', updating: 'Wird aktualisiert …',
};

async function viewServer(token) {
  const holder = h('div', {});
  main.replaceChildren(header('Server'), holder);
  let busy = false;

  async function act(action, st) {
    if ((action === 'stop' || action === 'restart') && st.online > 0 &&
        !confirm(`Es ${st.online === 1 ? 'ist 1 Spieler' : 'sind ' + st.online + ' Spieler'} online. Trotzdem ${action === 'stop' ? 'stoppen' : 'neu starten'}?`)) return;
    if (action === 'kill' && !confirm('Den Serverprozess hart beenden? Nicht gespeicherte Welt-Daten können verloren gehen.')) return;
    busy = true; paint(st);
    try { await api('POST', P('/action/' + action)); toast('Befehl an Crafty gesendet.'); }
    catch (e) { toast(e.message, true); }
    busy = false;
    setTimeout(refresh, 1200);
  }

  function addrCard(st) {
    const local = st.localAddress || `${location.hostname}:${st.port}`;
    const rows = [];
    if (st.publicAddress) {
      rows.push(h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Adresse für Freunde'),
        h('div', { class: 'addr' }, h('code', {}, st.publicAddress), copyBtn(st.publicAddress))));
    } else {
      rows.push(h('div', { class: 'notice warn' }, h('span', {}, 'Noch keine öffentliche Adresse eingetragen (z. B. die von playit.gg).'),
        h('a', { href: '#/settings' }, h('button', { class: 'small' }, 'Eintragen'))));
    }
    rows.push(h('div', { class: 'kv', style: 'margin-top:10px' }, h('div', { class: 'k' }, 'Im Heimnetz'),
      h('div', { class: 'addr' }, h('code', {}, local), copyBtn(local))));
    return h('div', { class: 'card' }, h('h2', {}, 'Verbinden'), rows);
  }

  function copyBtn(text) {
    return h('button', { class: 'small', onclick: async (e) => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Kopiert ✓'; setTimeout(() => { e.target.textContent = 'Kopieren'; }, 1500); }
      catch { toast('Kopieren nicht möglich. Markiere die Adresse und kopiere sie von Hand.', true); }
    } }, 'Kopieren');
  }

  function kv(k, v, s) {
    return h('div', { class: 'card kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null);
  }

  function paint(st) {
    const label = STATE_LABEL[st.state] || st.state;
    const btns = [];
    if (st.state === 'offline' || st.state === 'crashed') {
      btns.push(h('button', { class: 'big', disabled: busy, onclick: () => act('start', st) }, '▶ Starten'));
    } else if (st.state === 'online') {
      btns.push(h('button', { class: 'big', disabled: busy, onclick: () => act('stop', st) }, '■ Stoppen'));
      btns.push(h('button', { disabled: busy, onclick: () => act('restart', st) }, '↻ Neustarten'));
    } else {
      btns.push(h('button', { class: 'big', disabled: busy, onclick: () => act('stop', st) }, '■ Stoppen'));
      btns.push(h('button', { disabled: busy, onclick: () => act('kill', st) }, 'Erzwingen'));
    }
    const names = st.players;
    put(holder, 
      h('div', { class: 'banner ' + st.state },
        h('div', { class: 'info' },
          h('div', { class: 'name' }, st.name),
          h('div', { class: 'st' }, label),
          h('div', { class: 'pl' }, st.state === 'online' ? `${st.online} / ${st.max || '?'} Spieler online` : (st.version ? `Version ${st.version}` : ''))),
        h('div', { class: 'btns' }, btns)),
      addrCard(st),
      h('div', { class: 'grid' },
        kv('Software', st.software, st.jar || null),
        kv('Version', st.version || '–', st.motd || null),
        kv('Arbeitsspeicher', st.memoryMb ? (st.memoryMb >= 1024 && st.memoryMb % 1024 === 0 ? `${st.memoryMb / 1024} GB` : `${st.memoryMb} MB`) : '–', st.state === 'online' || st.state === 'starting' ? `belegt: ${st.memUsed || '–'}` : 'Obergrenze (-Xmx)'),
        kv('Welt', st.worldName || '–', st.worldSize || null)),
      names.length ? h('div', { class: 'card' }, h('h2', {}, 'Gerade online'),
        h('div', { class: 'row' }, names.map((n) => h('span', { class: 'chip on' }, n)))) : null,
      !st.filesAvailable ? h('div', { class: 'notice warn' }, 'Der Server-Ordner ist im Blockhaus nicht eingehängt. Optionen, Spieler und Log-Dateien funktionieren deshalb noch nicht.') : null);
  }

  async function refresh() {
    try {
      const st = await api('GET', P('/status'));
      if (token !== routeToken) return;
      paint(st);
    } catch (e) {
      if (token !== routeToken) return;
      put(holder, errorBox(e));
    }
  }
  await refresh();
  every(refresh, 3000);
}

// ---------- Options --------------------------------------------------------------------
const SCHEMA = [
  { group: 'Allgemein', items: [
    { key: 'motd', label: 'Server-Beschreibung (MOTD)', type: 'text', def: 'A Minecraft Server', hint: 'Steht in der Serverliste unter dem Namen.' },
    { key: 'max-players', label: 'Maximale Spielerzahl', type: 'number', min: 1, max: 1000, def: '20' },
    { key: 'gamemode', label: 'Spielmodus', type: 'select', def: 'survival', options: [['survival', 'Überleben'], ['creative', 'Kreativ'], ['adventure', 'Abenteuer'], ['spectator', 'Zuschauer']] },
    { key: 'force-gamemode', label: 'Spielmodus erzwingen', type: 'bool', def: 'false', hint: 'Setzt Spieler bei jedem Beitritt auf den Spielmodus oben.' },
    { key: 'difficulty', label: 'Schwierigkeit', type: 'select', def: 'easy', options: [['peaceful', 'Friedlich'], ['easy', 'Leicht'], ['normal', 'Normal'], ['hard', 'Schwer']] },
    { key: 'hardcore', label: 'Hardcore', type: 'bool', def: 'false' },
    { key: 'pvp', label: 'PvP', type: 'bool', def: 'true' },
    { key: 'allow-flight', label: 'Fliegen erlauben', type: 'bool', def: 'false', hint: 'Nötig für Mods, die Flug erlauben. Sonst werden Spieler wegen „Fliegens“ gekickt.' },
    { key: 'enable-command-block', label: 'Befehlsblöcke', type: 'bool', def: 'false' },
  ] },
  { group: 'Zugang', items: [
    { key: 'white-list', label: 'Whitelist', type: 'bool', def: 'false', hint: 'Nur eingetragene Spieler dürfen beitreten. Pflege unter „Spieler“.' },
    { key: 'enforce-whitelist', label: 'Whitelist sofort durchsetzen', type: 'bool', def: 'false', hint: 'Wirft Spieler, die nicht (mehr) eingetragen sind, auch während des Spiels raus.' },
    { key: 'online-mode', label: 'Gecrackt (Offline-Modus)', type: 'bool', invert: true, def: 'true',
      warn: 'Nur einschalten, wenn nötig. Ohne Konto-Prüfung kann sich jeder unter jedem Namen anmelden. Zusammen mit der Whitelist schützt das kaum.' },
    { key: 'spawn-protection', label: 'Spawn-Schutz (Blöcke)', type: 'number', min: 0, max: 1000, def: '16' },
  ] },
  { group: 'Welt', items: [
    { key: 'level-seed', label: 'Seed', type: 'text', def: '', hint: 'Gilt nur für eine NEUE Welt. Eine schon erzeugte Welt behält ihren Seed.',
      warn: 'Der Seed wird nur beim Erzeugen genutzt. Zum Wechsel muss der Welt-Ordner (level-name) neu angelegt werden.' },
    { key: 'level-name', label: 'Welt-Ordner (level-name)', type: 'text', def: 'world', warn: 'Ein anderer Name erzeugt beim Start eine neue, leere Welt. Die alte bleibt im Ordner liegen.' },
    { key: 'level-type', label: 'Welttyp', type: 'select', def: 'minecraft:normal', options: [['minecraft:normal', 'Normal'], ['minecraft:flat', 'Superflach'], ['minecraft:large_biomes', 'Große Biome'], ['minecraft:amplified', 'Amplified']] },
    { key: 'generate-structures', label: 'Strukturen erzeugen', type: 'bool', def: 'true' },
    { key: 'allow-nether', label: 'Nether', type: 'bool', def: 'true' },
    { key: 'spawn-monsters', label: 'Monster spawnen', type: 'bool', def: 'true' },
    { key: 'spawn-animals', label: 'Tiere spawnen', type: 'bool', def: 'true' },
    { key: 'spawn-npcs', label: 'Dorfbewohner spawnen', type: 'bool', def: 'true' },
    { key: 'view-distance', label: 'Sichtweite (Chunks)', type: 'number', min: 2, max: 32, def: '10', hint: 'Höher kostet mehr Leistung.' },
    { key: 'simulation-distance', label: 'Simulationsweite (Chunks)', type: 'number', min: 3, max: 32, def: '10' },
  ] },
  { group: 'Texturpaket', note: 'Das Paket muss unter einer öffentlich erreichbaren URL liegen. Spieler laden es beim Beitritt herunter.', items: [
    { key: 'resource-pack', label: 'Download-URL', type: 'text', def: '' },
    { key: 'resource-pack-sha1', label: 'SHA-1-Prüfsumme (optional)', type: 'text', def: '', hint: '40 Zeichen, hilft dem Client beim Zwischenspeichern.' },
    { key: 'require-resource-pack', label: 'Paket verpflichtend', type: 'bool', def: 'false' },
    { key: 'resource-pack-prompt', label: 'Hinweistext (optional)', type: 'text', def: '' },
  ] },
];
const SCHEMA_KEYS = new Set(SCHEMA.flatMap((g) => g.items.map((i) => i.key)));

async function viewOptions(token) {
  const data = await api('GET', P('/properties'));
  if (token !== routeToken) return;
  let values = data.values;
  let restartNeeded = false;
  const edits = {};
  const holder = h('div', {});
  main.replaceChildren(header('Optionen', 'Änderungen greifen erst nach einem Neustart des Servers.'), holder);

  const eff = (it) => (values[it.key] !== undefined ? values[it.key] : it.def);
  const uiVal = (it) => (it.invert ? String(eff(it) !== 'true') : eff(it));

  function control(it, onChange) {
    const cur = uiVal(it);
    if (it.type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: cur === 'true', 'aria-label': it.label,
        onchange: () => onChange(String(cb.checked)) });
      return h('label', { class: 'switch' }, cb, h('i'));
    }
    if (it.type === 'select') {
      const opts = it.options.slice();
      if (!opts.some(([v]) => v === cur)) opts.push([cur, cur]);
      const sel = h('select', { 'aria-label': it.label, onchange: () => onChange(sel.value) },
        opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
      return sel;
    }
    const inp = h('input', { type: it.type === 'number' ? 'number' : 'text', value: cur, 'aria-label': it.label,
      min: it.min, max: it.max, oninput: () => onChange(inp.value) });
    return inp;
  }

  function dirtyCount() { return Object.keys(edits).length; }

  function paintSave() {
    const n = dirtyCount();
    put(saveBar, 
      h('span', { class: n ? '' : 'muted' }, n ? `${n} ungespeicherte Änderung${n === 1 ? '' : 'en'}` : 'Keine Änderungen'),
      h('span', { class: 'row' },
        h('button', { disabled: !n, onclick: () => { for (const k of Object.keys(edits)) delete edits[k]; build(); } }, 'Verwerfen'),
        h('button', { class: 'primary', disabled: !n, onclick: save }, 'Speichern')));
  }
  const saveBar = h('div', { class: 'savebar' });

  async function save() {
    // validate numbers
    for (const g of SCHEMA) for (const it of g.items) {
      if (it.type === 'number' && it.key in edits) {
        const v = edits[it.key];
        if (v === '' || Number.isNaN(Number(v)) || Number(v) < it.min || Number(v) > it.max) {
          toast(`„${it.label}“: bitte eine Zahl von ${it.min} bis ${it.max} eingeben.`, true); return;
        }
      }
    }
    try {
      const r = await api('PUT', P('/properties'), { changes: edits });
      for (const [k, v] of Object.entries(edits)) values[k] = v;
      for (const k of Object.keys(edits)) delete edits[k];
      restartNeeded = restartNeeded || !!r.restartNeeded;
      toast('Gespeichert.');
      build();
    } catch (e) { toast(e.message, true); }
  }

  function setEdit(it, uiValue) {
    const real = it.invert ? String(uiValue !== 'true') : uiValue;
    const orig = values[it.key] !== undefined ? values[it.key] : it.def;
    if (real === orig) delete edits[it.key]; else edits[it.key] = real;
    paintSave();
  }

  function optRow(it) {
    const row = h('div', { class: 'opt' });
    const warn = h('div', { class: 'warn' });
    const update = () => {
      row.classList.toggle('dirty', it.key in edits);
      warn.textContent = it.warn && (it.key in edits) ? it.warn : '';
    };
    const ctl = control(it, (v) => { setEdit(it, v); update(); });
    row.append(h('div', { class: 'txt' }, h('b', {}, it.label), it.hint ? h('small', {}, it.hint) : null, warn),
      h('div', { class: 'ctl' }, ctl));
    update();
    return row;
  }

  function build() {
    const cards = SCHEMA.map((g) => h('div', { class: 'card' }, h('h2', {}, g.group),
      g.note ? h('p', { class: 'muted', style: 'margin-top:-4px' }, g.note) : null, g.items.map(optRow)));
    const others = Object.keys(values).filter((k) => !SCHEMA_KEYS.has(k)).sort();
    const raw = h('details', { class: 'card' }, h('summary', {}, `Alle weiteren Einstellungen (${others.length})`),
      h('p', { class: 'muted' }, 'Rohwerte aus der server.properties. Nur ändern, wenn du weißt, was sie tun.'),
      h('table', { class: 'raw' }, others.map((k) => {
        const inp = h('input', { type: 'text', value: values[k], 'aria-label': k, oninput: () => {
          if (inp.value === values[k]) delete edits[k]; else edits[k] = inp.value;
          paintSave();
        } });
        return h('tr', {}, h('td', {}, k), h('td', {}, inp));
      })));
    put(holder, 
      !data.exists ? h('div', { class: 'notice warn' }, 'Es gibt noch keine server.properties. Sie entsteht beim ersten Start des Servers. Änderungen hier legen sie neu an.') : null,
      restartNeeded ? h('div', { class: 'notice warn' }, h('span', {}, 'Änderungen gespeichert. Der laufende Server nutzt sie erst nach einem Neustart.'),
        h('button', { class: 'primary', onclick: async () => {
          try { await api('POST', P('/action/restart')); toast('Neustart angefordert.'); restartNeeded = false; build(); } catch (e) { toast(e.message, true); }
        } }, 'Jetzt neu starten')) : null,
      cards, raw, saveBar);
    paintSave();
  }
  build();
}

// ---------- Players --------------------------------------------------------------------
const PLAYER_TABS = [
  { id: 'whitelist', label: 'Whitelist', ph: 'Spielername', add: 'Hinzufügen', empty: 'Die Whitelist ist leer.' },
  { id: 'ops', label: 'Operatoren', ph: 'Spielername', add: 'Zu Operator machen', empty: 'Keine Operatoren.' },
  { id: 'banned-players', label: 'Gebannte Spieler', ph: 'Spielername', add: 'Bannen', empty: 'Niemand ist gebannt.' },
  { id: 'banned-ips', label: 'Gebannte IP-Adressen', ph: 'IP-Adresse', add: 'IP bannen', empty: 'Keine IP gebannt.' },
];

function avatar(name) {
  let hsh = 0;
  for (const c of name) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return h('div', { class: 'avatar', style: `background:hsl(${hsh % 360} 45% 38%)`, 'aria-hidden': 'true' }, name.replace(/^\./, '').slice(0, 1) || '?');
}

async function viewPlayers(token) {
  let tab = store('blockhaus.ptab') || 'whitelist';
  if (!PLAYER_TABS.some((t) => t.id === tab)) tab = 'whitelist';
  let d = await api('GET', P('/players'));
  if (token !== routeToken) return;
  const holder = h('div', {});
  main.replaceChildren(header('Spieler'), holder);

  async function add(list, input) {
    const name = input.value.trim();
    if (!name) return;
    try {
      const r = await api('POST', P('/players/' + list), { name });
      const key = list === 'banned-ips' ? 'ip' : 'name';
      if (!r.entries.some((e) => String(e[key]).toLowerCase() === name.toLowerCase())) {
        toast('Der Server hat die Liste nicht geändert. Schau in der Konsole nach der Meldung (z. B. „That player does not exist“).', true);
      } else toast(r.via === 'console' ? 'Per Server-Konsole eingetragen.' : 'Eingetragen.');
      d.lists[list] = r.entries;
      input.value = '';
      paint();
    } catch (e) { toast(e.message, true); }
  }
  async function remove(list, key) {
    try {
      const r = await api('DELETE', P('/players/' + list + '/' + encodeURIComponent(key)));
      d.lists[list] = r.entries;
      paint();
    } catch (e) { toast(e.message, true); }
  }
  async function quick(kind, name) {
    try {
      if (kind === 'kick') {
        if (!confirm(`${name} vom Server werfen?`)) return;
        await api('POST', P('/kick'), { name });
      } else {
        if (kind === 'banned-players' && !confirm(`${name} bannen?`)) return;
        await api('POST', P('/players/' + kind), { name });
      }
      toast('Erledigt.');
      d = await api('GET', P('/players'));
      paint();
    } catch (e) { toast(e.message, true); }
  }

  function paint() {
    const t = PLAYER_TABS.find((x) => x.id === tab);
    const keyField = tab === 'banned-ips' ? 'ip' : 'name';
    const entries = d.lists[tab] || [];
    const input = h('input', { type: 'text', placeholder: t.ph, 'aria-label': t.ph, onkeydown: (e) => { if (e.key === 'Enter') add(tab, input); } });
    put(holder, 
      d.running ? null : h('div', { class: 'notice' }, 'Der Server ist aus. Änderungen werden direkt in die Listen-Dateien geschrieben.'),
      !d.onlineMode ? h('div', { class: 'notice warn' }, 'Gecrackt-Modus: Spieler-IDs werden aus dem Namen berechnet. Nur der exakte Name zählt, Groß-/Kleinschreibung eingeschlossen.') : null,
      d.running && d.online.length ? h('div', { class: 'card' }, h('h2', {}, `Gerade online (${d.online.length})`),
        h('ul', { class: 'plist' }, d.online.map((n) => h('li', {}, avatar(n), h('div', { class: 'nm' }, n),
          h('button', { class: 'small', onclick: () => quick('kick', n) }, 'Kicken'),
          h('button', { class: 'small', onclick: () => quick('ops', n) }, 'Operator'),
          h('button', { class: 'small danger', onclick: () => quick('banned-players', n) }, 'Bannen'))))) : null,
      h('div', { class: 'tabs' }, PLAYER_TABS.map((x) => h('button', { class: x.id === tab ? 'on' : '', onclick: () => { tab = x.id; store('blockhaus.ptab', tab); paint(); } },
        `${x.label} (${(d.lists[x.id] || []).length})`))),
      tab === 'whitelist' && !d.whitelistEnabled ? h('div', { class: 'notice warn' }, h('span', {}, 'Die Whitelist ist ausgeschaltet, die Liste hat also keine Wirkung.'),
        h('a', { href: '#/options' }, h('button', { class: 'small' }, 'Zu den Optionen'))) : null,
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { class: 'grow' }, input), h('button', { class: 'primary', onclick: () => add(tab, input) }, t.add)),
        entries.length ? h('ul', { class: 'plist' }, entries.map((e) => {
          const key = String(e[keyField]);
          const sub = [e.uuid, e.reason && tab.startsWith('banned') ? e.reason : null, tab === 'ops' && e.level ? `Level ${e.level}` : null].filter(Boolean).join(' · ');
          return h('li', {}, tab === 'banned-ips' ? null : avatar(key),
            h('div', { class: 'nm' }, key, sub ? h('small', {}, sub) : null),
            d.online.includes(key) ? h('span', { class: 'chip on' }, 'online') : null,
            h('button', { class: 'small', 'aria-label': key + ' entfernen', onclick: () => remove(tab, key) }, tab.startsWith('banned') ? 'Entbannen' : 'Entfernen'));
        })) : h('div', { class: 'empty' }, t.empty)));
  }
  paint();
  every(async () => {
    try { const nd = await api('GET', P('/players')); if (token === routeToken && !document.activeElement?.matches('input')) { d = nd; paint(); } } catch { /* ignore */ }
  }, 8000);
}

// ---------- Console --------------------------------------------------------------------
function lineClass(l) {
  if (/\b(ERROR|FATAL|Exception)\b/.test(l)) return 'l-err';
  if (/\bWARN\b/.test(l)) return 'l-warn';
  if (/<[^>]+>\s/.test(l) && /\[Server thread\/INFO\]/.test(l)) return 'l-chat';
  if (/\bDEBUG\b|\bTRACE\b/.test(l)) return 'l-dim';
  return '';
}
function paintLines(box, lines, filter) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const f = (filter || '').toLowerCase();
  const frag = document.createDocumentFragment();
  for (const raw of lines) {
    const l = stripAnsi(raw);
    if (f && !l.toLowerCase().includes(f)) continue;
    frag.append(h('div', { class: lineClass(l) }, l));
  }
  box.replaceChildren(frag);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function viewConsole(token) {
  const box = h('div', { class: 'term', tabindex: '0', 'aria-label': 'Konsolenausgabe' });
  const history = []; let hi = -1;
  const input = h('input', { type: 'text', placeholder: 'Befehl eingeben, z. B. say Hallo (ohne /)', 'aria-label': 'Konsolenbefehl', autocomplete: 'off',
    onkeydown: (e) => {
      if (e.key === 'Enter') send();
      else if (e.key === 'ArrowUp' && history.length) { hi = Math.max(0, (hi < 0 ? history.length : hi) - 1); input.value = history[hi]; e.preventDefault(); }
      else if (e.key === 'ArrowDown' && hi >= 0) { hi++; input.value = hi >= history.length ? '' : history[hi]; if (hi >= history.length) hi = -1; e.preventDefault(); }
    } });
  main.replaceChildren(header('Konsole', 'Live-Ausgabe des Servers. Befehle laufen direkt im Server.'), box,
    h('div', { class: 'cmdbar' }, input, h('button', { onclick: send }, 'Senden')));
  async function send() {
    const cmd = input.value.trim();
    if (!cmd) return;
    history.push(cmd); hi = -1; input.value = '';
    try { await api('POST', P('/command'), { command: cmd }); setTimeout(refresh, 500); }
    catch (e) { toast(e.message, true); }
  }
  async function refresh() {
    try {
      const r = await api('GET', P('/console'));
      if (token === routeToken) paintLines(box, r.lines);
    } catch (e) { if (token === routeToken) box.replaceChildren(h('div', { class: 'l-err' }, e.message)); }
  }
  await refresh();
  box.scrollTop = box.scrollHeight;
  every(refresh, 2000);
}

// ---------- Log ------------------------------------------------------------------------
async function viewLog(token) {
  const list = await api('GET', P('/logs'));
  if (token !== routeToken) return;
  const box = h('div', { class: 'term solo', tabindex: '0', 'aria-label': 'Logdatei' });
  let current = list.files[0] ? list.files[0].name : null;
  let filter = '';
  let onlyProblems = false;
  let lines = [];

  const sel = h('select', { style: 'width:auto', 'aria-label': 'Logdatei wählen', onchange: () => { current = sel.value; load(true); } },
    list.files.map((f) => h('option', { value: f.name }, `${f.name} (${(f.size / 1024).toFixed(0)} KB)`)));
  const fin = h('input', { type: 'text', placeholder: 'Filtern …', 'aria-label': 'Log filtern', style: 'width:200px', oninput: () => { filter = fin.value; show(); } });
  const prob = h('label', { class: 'row', style: 'gap:6px' }, h('input', { type: 'checkbox', style: 'width:auto', onchange: (e) => { onlyProblems = e.target.checked; show(); } }), 'Nur Warnungen/Fehler');
  main.replaceChildren(header('Log', 'Die Protokolldateien des Servers (logs-Ordner).'),
    h('div', { class: 'row', style: 'margin-bottom:10px' }, sel, fin, prob, h('button', { onclick: () => load(true) }, 'Aktualisieren')), box);

  function show() {
    let ls = lines;
    if (onlyProblems) ls = ls.filter((l) => /\b(WARN|ERROR|FATAL)\b|Exception/.test(l));
    paintLines(box, ls, filter);
  }
  async function load(scroll) {
    if (!current) { box.replaceChildren(h('div', { class: 'l-dim' }, 'Keine Logdateien gefunden.')); return; }
    try {
      const r = await api('GET', P('/logs/' + encodeURIComponent(current)));
      if (token !== routeToken) return;
      lines = r.text.split('\n');
      show();
      if (scroll) box.scrollTop = box.scrollHeight;
    } catch (e) { box.replaceChildren(h('div', { class: 'l-err' }, e.message)); }
  }
  await load(true);
  every(() => { if (current === 'latest.log') load(false); }, 5000);
}

// ---------- Settings -------------------------------------------------------------------
async function viewSettings() {
  const c = S.cfg;
  const f = {
    craftyUrl: h('input', { type: 'text', value: c.craftyUrl, 'aria-label': 'Crafty-URL' }),
    apiToken: h('input', { type: 'password', placeholder: c.hasToken ? '•••••• gespeichert (leer lassen zum Behalten)' : 'API-Token einfügen', autocomplete: 'off', 'aria-label': 'API-Token' }),
    username: h('input', { type: 'text', value: c.username, autocomplete: 'off', 'aria-label': 'Crafty-Benutzername' }),
    password: h('input', { type: 'password', placeholder: c.hasPassword ? '•••••• gespeichert' : '', autocomplete: 'new-password', 'aria-label': 'Crafty-Passwort' }),
    publicAddress: h('input', { type: 'text', value: c.publicAddress, placeholder: 'z. B. abc-123.gl.at.ply.gg:12345', 'aria-label': 'Öffentliche Adresse' }),
    localAddress: h('input', { type: 'text', value: c.localAddress, placeholder: 'leer = automatisch', 'aria-label': 'Adresse im Heimnetz' }),
  };
  const result = h('div', {});
  const field = (label, el, hint) => h('label', { class: 'f' }, h('span', {}, label), el, hint ? h('small', {}, hint) : null);
  const body = () => {
    const b = {};
    for (const [k, el] of Object.entries(f)) b[k] = el.value;
    return b;
  };
  async function test() {
    result.replaceChildren(h('p', { class: 'muted' }, 'Teste …'));
    try {
      const r = await api('POST', '/config/test', body());
      if (r.ok) {
        result.replaceChildren(h('div', { class: 'notice ok' }, h('div', {},
          h('b', {}, 'Verbindung steht.'),
          h('ul', {}, r.servers.map((s) => h('li', {}, `${s.name}: ${s.filesFound ? 'Ordner gefunden ✓' : 'Ordner nicht eingehängt ✗'}`))))));
      } else {
        result.replaceChildren(h('div', { class: 'notice err' }, r.error + (r.code === 'UNREACHABLE' ? ' Alternativ probieren: https://host.docker.internal:8443 oder https://<Umbrel-IP>:8443' : '')));
      }
    } catch (e) { result.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
  }
  async function save() {
    try {
      S.cfg = await api('PUT', '/config', body());
      toast('Gespeichert.');
      if (S.cfg.configured) location.hash = '#/server'; else route();
    } catch (e) { toast(e.message, true); }
  }
  put(main, 
    h('div', { class: 'head' }, h('h1', {}, 'Einstellungen')),
    !c.configured ? h('div', { class: 'notice warn' }, 'Willkommen im Blockhaus. Verbinde zuerst Crafty Controller: Token erzeugen unter Crafty → Dein Benutzer → API-Schlüssel, oder Benutzer und Passwort eintragen.') : null,
    h('div', { class: 'card' }, h('h2', {}, 'Crafty Controller'),
      field('Crafty-URL', f.craftyUrl, 'Standard im Umbrel-Netz: https://crafty_container:8443'),
      field('API-Token (empfohlen)', f.apiToken, 'Der Token braucht Zugriff auf deinen Server und die Rechte „Befehle“, „Start/Stopp“ und „Logs“.'),
      h('details', {}, h('summary', {}, 'Statt Token: Benutzer und Passwort'),
        field('Benutzername', f.username), field('Passwort', f.password)),
      c.hasToken ? h('p', {}, h('button', { class: 'small', onclick: async () => { await api('PUT', '/config', { clearToken: true }); toast('Token gelöscht.'); route(); } }, 'Gespeicherten Token löschen')) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Adressen'),
      field('Öffentliche Adresse für Freunde', f.publicAddress, 'Wird auf der Server-Seite zum Kopieren angezeigt (z. B. von playit.gg).'),
      field('Adresse im Heimnetz', f.localAddress)),
    h('div', { class: 'row' }, h('button', { onclick: test }, 'Verbindung testen'), h('button', { class: 'primary', onclick: save }, 'Speichern')),
    h('div', { style: 'margin-top:14px' }, result));
}

window.addEventListener('hashchange', route);
route();
})();
