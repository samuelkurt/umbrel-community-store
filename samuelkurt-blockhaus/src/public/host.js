(() => {
'use strict';
// Pages that only exist when Blockhaus runs on its own (dedicated) server: login, computer performance, terminal.
const { h, put, api, toast, store, S, every, getToken, main } = window.BH;

const fmtBytes = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i];
};
const fmtRate = (n) => (n === null || n === undefined ? '–' : fmtBytes(n) + '/s');
const fmtWatt = (w) => (w === null || w === undefined || !Number.isFinite(w) ? '–' : `${w >= 100 ? w.toFixed(0) : w.toFixed(1)} W`);
const fmtPct = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : n.toFixed(d) + ' %');
const fmtUp = (s) => {
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d} T ${hh} Std` : hh ? `${hh} Std ${m} Min` : `${m} Min`;
};
const svgNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const COLORS = { blue: 'var(--info)', green: 'var(--accent)', orange: 'var(--warn)', red: 'var(--danger)' };

/** 1/2/5 x 10^n at or above v */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)); const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// ---------- login -----------------------------------------------------------------------------------------------
async function login(token) {
  const s = S.sess || {};
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passwort', placeholder: 'Passwort', autofocus: true });
  const msg = h('p', { class: 'login-msg', role: 'alert' });
  const btn = h('button', { class: 'primary big', type: 'submit', disabled: !s.configured }, 'Anmelden');
  const go = async (e) => {
    e.preventDefault();
    if (!pw.value) { msg.textContent = 'Bitte das Passwort eingeben.'; return; }
    btn.disabled = true; msg.textContent = '';
    try { await api('POST', '/login', { password: pw.value }); pw.value = ''; location.hash = '#/server'; window.BH.route(); }
    catch (err) { msg.textContent = err.message; btn.disabled = false; pw.select(); }
  };
  put(main, h('form', { class: 'card login', onsubmit: go },
    h('img', { src: 'icon.svg', alt: '', width: 52, height: 52 }),
    h('h1', {}, 'Blockhaus'),
    s.configured
      ? h('p', { class: 'muted' }, 'Bitte melde dich an.')
      : h('div', { class: 'notice warn' }, h('div', {}, h('b', {}, 'Noch kein Passwort gesetzt. '), 'Auf dem Server ausführen: ', h('code', {}, 'sudo blockhaus-passwd'))),
    pw, msg, btn));
  if (token === getToken()) pw.focus();
}

// ---------- line chart ------------------------------------------------------------------------------------------
/**
 * @param {object} o  { title, unit:'pct'|'bytes'|'rate'|'deg', yMax?:number, series:[{key,label,color,fmt}] }
 * update(rows, windowS): rows are history entries; each series reads row[key] (or key as function)
 */
function chart(o) {
  const W = 640; const Hh = 150; const L = 64; const R = 8; const T = 8; const B = 20;
  const box = svg('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': o.title, preserveAspectRatio: 'none', class: 'chart-svg' });
  const legend = h('div', { class: 'legend' });
  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chartwrap' }, box, tip);
  const el = h('div', { class: 'card chart' }, h('div', { class: 'head' }, h('h2', {}, o.title), legend), wrap);
  let rows = []; let wS = 300; let yMax = 1;
  const valueOf = (s, r) => (typeof s.key === 'function' ? s.key(r) : r[s.key]);
  const fmtY = (v) => (o.unit === 'pct' ? `${Math.round(v)} %` : o.unit === 'deg' ? `${Math.round(v)} °C` : o.unit === 'watt' ? `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} W` : o.unit === 'rate' ? fmtRate(v) : fmtBytes(v));
  const x = (i) => (rows.length < 2 ? L : L + (i / (rows.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - Math.max(0, Math.min(1, v / yMax))) * (Hh - T - B);

  function update(newRows, windowS) {
    rows = newRows; wS = windowS;
    let mx = 0;
    for (const s of o.series) for (const r of rows) { const v = valueOf(s, r); if (v !== null && v !== undefined && v > mx) mx = v; }
    let ticks;
    if (o.yMax || (o.unit === 'pct' && mx >= 30)) {
      yMax = o.yMax || 100; ticks = [0, 1, 2, 3, 4].map((k) => (yMax / 4) * k);
    } else {
      // round axis steps (1/2/5 x 10^n) in the unit that will be printed (1024-based for bytes), so labels read 0 / 20 / 40 / 60 MB/s
      const base = o.unit === 'bytes' || o.unit === 'rate' ? 1024 ** Math.max(0, Math.min(4, Math.floor(Math.log(Math.max(mx, 1)) / Math.log(1024)))) : 1;
      const floor = o.unit === 'pct' ? 10 : o.unit === 'deg' ? 10 : o.unit === 'watt' ? 2 : 1;
      const top = Math.max(floor, (mx * 1.1) / base);
      const step = niceMax(top / 3);
      const n = Math.max(2, Math.ceil(top / step));
      yMax = step * n * base; ticks = Array.from({ length: n + 1 }, (_, k) => step * k * base);
    }
    const kids = [];
    for (const v of ticks) {
      const yy = y(v);
      kids.push(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }));
      const t = svg('text', { x: L - 6, y: yy + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = fmtY(v); kids.push(t);
    }
    const t0 = svg('text', { x: L, y: Hh - 4, class: 'axis' }); t0.textContent = wS >= 3600 ? 'vor 1 Std' : `vor ${Math.round(wS / 60)} Min`; kids.push(t0);
    const t1 = svg('text', { x: W - R, y: Hh - 4, class: 'axis', 'text-anchor': 'end' }); t1.textContent = 'jetzt'; kids.push(t1);
    o.series.forEach((s, si) => {
      let d = ''; let started = false; let first = null; let last = null;
      rows.forEach((r, i) => {
        const v = valueOf(s, r);
        if (v === null || v === undefined) { started = false; return; }
        d += `${started ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; started = true;
        if (first === null) first = i; last = i;
      });
      if (!d) return;
      if (si === 0 && first !== null && o.area !== false) {
        const area = svg('path', { d: `${d}L${x(last).toFixed(1)} ${y(0)} L${x(first).toFixed(1)} ${y(0)} Z`, class: 'area', style: `fill:${s.color}` });
        kids.push(area);
      }
      kids.push(svg('path', { d, class: 'line', style: `stroke:${s.color}` }));
    });
    const cur = svg('line', { class: 'cursor', y1: T, y2: Hh - B, x1: -10, x2: -10 }); kids.push(cur);
    box.replaceChildren(...kids);
    box._cursor = cur;
    const last = rows[rows.length - 1];
    legend.replaceChildren(...o.series.map((s) => h('span', { class: 'lg' }, h('i', { style: `background:${s.color}` }), `${s.label} `, h('b', {}, last && valueOf(s, last) !== null && valueOf(s, last) !== undefined ? s.fmt(valueOf(s, last)) : '–'))));
  }

  wrap.addEventListener('pointermove', (e) => {
    if (rows.length < 2) return;
    const rect = box.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(rows.length - 1, Math.round(((px - L) / (W - L - R)) * (rows.length - 1))));
    const r = rows[i];
    if (box._cursor) { box._cursor.setAttribute('x1', x(i)); box._cursor.setAttribute('x2', x(i)); }
    tip.hidden = false;
    tip.replaceChildren(h('div', { class: 'tt' }, new Date(r.ts).toLocaleTimeString('de-DE')),
      ...o.series.map((s) => h('div', {}, h('i', { style: `background:${s.color}` }), `${s.label}: `, h('b', {}, valueOf(s, r) === null || valueOf(s, r) === undefined ? '–' : s.fmt(valueOf(s, r))))));
    const left = (x(i) / W) * rect.width;
    tip.style.left = `${left > rect.width * 0.6 ? left - tip.offsetWidth - 10 : left + 10}px`;
  });
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; if (box._cursor) { box._cursor.setAttribute('x1', -10); box._cursor.setAttribute('x2', -10); } });
  return { el, update };
}

// ---------- performance page ---------------------------------------------------------------------------------------
async function perf(token) {
  let win = [300, 900, 3600].includes(Number(store('blockhaus.perfWin'))) ? Number(store('blockhaus.perfWin')) : 300;
  let sortBy = 'cpu';
  let last = null;

  const sub = h('p', { class: 'sub' }, 'Lädt …');
  const winBtns = [[300, '5 Min'], [900, '15 Min'], [3600, '1 Std']].map(([v, l]) => h('button', { class: win === v ? 'on' : '', onclick: () => { win = v; store('blockhaus.perfWin', String(v)); winBtns.forEach((b, i) => b.classList.toggle('on', [300, 900, 3600][i] === v)); load(); } }, l));
  const kpi = {};
  const kpiCard = (key, label) => { const v = h('div', { class: 'v' }, '–'); const s = h('div', { class: 's' }, ' '); kpi[key] = { v, s }; return h('div', { class: 'card kv' }, h('div', { class: 'k' }, label), v, s); };
  const kpis = h('div', { class: 'grid' }, kpiCard('cpu', 'Prozessor'), kpiCard('mem', 'Arbeitsspeicher'), kpiCard('load', 'Last (1 / 5 / 15 Min)'), kpiCard('temp', 'Temperatur'), kpiCard('watt', 'Leistungsaufnahme'), kpiCard('net', 'Netzwerk'), kpiCard('disk', 'Festplatte (Durchsatz)'));
  const charts = {
    cpu: chart({ title: 'Prozessor-Auslastung', unit: 'pct', series: [{ key: 'cpu', label: 'Gesamt', color: COLORS.blue, fmt: (v) => fmtPct(v, 0) }, { key: 'mcShare', label: 'davon Minecraft', color: COLORS.green, fmt: (v) => fmtPct(v, 0) }] }),
    mem: chart({ title: 'Arbeitsspeicher', unit: 'bytes', series: [{ key: 'memUsed', label: 'Belegt', color: COLORS.blue, fmt: fmtBytes }, { key: 'mcRss', label: 'Minecraft', color: COLORS.green, fmt: fmtBytes }] }),
    net: chart({ title: 'Netzwerk', unit: 'rate', series: [{ key: 'netRx', label: 'Empfang', color: COLORS.blue, fmt: fmtRate }, { key: 'netTx', label: 'Senden', color: COLORS.orange, fmt: fmtRate }] }),
    disk: chart({ title: 'Festplatte', unit: 'rate', series: [{ key: 'diskRd', label: 'Lesen', color: COLORS.blue, fmt: fmtRate }, { key: 'diskWr', label: 'Schreiben', color: COLORS.orange, fmt: fmtRate }] }),
    watt: chart({ title: 'Leistungsaufnahme', unit: 'watt', series: [{ key: 'watts', label: 'Gemessen', color: COLORS.orange, fmt: fmtWatt }] }),
    temp: chart({ title: 'Temperatur', unit: 'deg', yMax: 100, series: [{ key: 'temp', label: 'Prozessor', color: COLORS.red, fmt: (v) => `${v.toFixed(0)} °C` }] }),
  };
  const chartGrid = h('div', { class: 'chartgrid' }, charts.cpu.el, charts.mem.el, charts.net.el, charts.disk.el, charts.temp.el, charts.watt.el);
  const cores = h('div', { class: 'cores' });
  const mcBox = h('div', {});
  const fsBox = h('div', {});
  const procBox = h('div', {});
  const sortBtns = [['cpu', 'nach Prozessor'], ['rss', 'nach Speicher']].map(([k, l]) => h('button', { class: 'small' + (k === sortBy ? ' on' : ''), onclick: () => { sortBy = k; sortBtns.forEach((b, i) => b.classList.toggle('on', ['cpu', 'rss'][i] === k)); if (last) paintProcs(last); } }, l));

  put(main,
    h('div', { class: 'head' }, h('h1', {}, 'Leistung'), h('div', { class: 'tabs', style: 'margin:0' }, winBtns)),
    sub, kpis, h('div', { class: 'card' }, h('h2', {}, 'Minecraft'), mcBox), chartGrid,
    h('div', { class: 'card' }, h('h2', {}, 'Prozessorkerne'), cores),
    h('div', { class: 'card' }, h('h2', {}, 'Speicherplatz'), fsBox),
    h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', {}, 'Größte Prozesse'), h('div', { class: 'row' }, sortBtns)), procBox));

  const bar = (pct, cls = '') => h('div', { class: 'bar thin ' + cls }, h('i', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
  const level = (pct, warn, bad) => (pct >= bad ? 'bad' : pct >= warn ? 'warn' : '');

  function paintProcs(d) {
    const list = [...d.now.procs].sort((a, b) => b[sortBy] - a[sortBy]).slice(0, 12);
    put(procBox, h('div', { class: 'tablewrap' }, h('table', { class: 'files procs' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Prozess'), h('th', {}, 'Benutzer'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Speicher'), h('th', {}, 'Befehl'))),
      h('tbody', {}, list.map((p) => h('tr', {}, h('td', {}, p.name, h('small', { class: 'muted' }, ` ${p.pid}`)), h('td', {}, p.user), h('td', { class: 'num' }, p.cpu.toFixed(1) + ' %'), h('td', { class: 'num' }, fmtBytes(p.rss)), h('td', { class: 'cmd', title: p.cmd }, p.cmd)))))));
  }

  function paint(d) {
    last = d;
    const { info, now: n } = d; const threads = info.cpuThreads;
    sub.textContent = `${info.hostname} · ${info.os} · ${info.cpuModel} (${threads} Threads${info.cpuMhz ? `, ${info.cpuMhz} MHz` : ''}) · läuft seit ${fmtUp(info.uptimeS)}`;
    kpi.cpu.v.textContent = fmtPct(n.cpu, 0); kpi.cpu.v.className = 'v ' + level(n.cpu, 70, 90);
    kpi.cpu.s.textContent = `Warten auf Platte ${fmtPct(n.iowait, 1)}${n.steal > 1 ? ` · abgezwackt (VM) ${fmtPct(n.steal, 1)}` : ''}`;
    const memPct = n.mem.total ? (n.mem.used / n.mem.total) * 100 : 0;
    kpi.mem.v.textContent = `${fmtBytes(n.mem.used)} von ${fmtBytes(n.mem.total)}`; kpi.mem.v.className = 'v ' + level(memPct, 80, 92);
    kpi.mem.s.textContent = `${fmtPct(memPct, 0)} · Zwischenspeicher ${fmtBytes(n.mem.cached)}${n.mem.swapTotal ? ` · Auslagerung ${fmtBytes(n.mem.swapUsed)}/${fmtBytes(n.mem.swapTotal)}` : ''}`;
    kpi.load.v.textContent = n.load.map((x) => x.toFixed(2)).join(' / ');
    kpi.load.v.className = 'v ' + level((n.load[0] / threads) * 100, 80, 120);
    kpi.load.s.textContent = `${threads} Threads: ab ${threads} ist der Rechner voll ausgelastet`;
    kpi.temp.v.textContent = n.temp === null ? '–' : `${n.temp.toFixed(0)} °C`; kpi.temp.v.className = 'v ' + (n.temp === null ? '' : level(n.temp, 75, 90));
    kpi.temp.s.textContent = n.temp === null ? 'kein Sensor gefunden (virtuelle Maschine?)' : n.temps.slice(0, 3).map((t) => `${t.label} ${t.c.toFixed(0)}°`).join(' · ');
    const pw = n.power || { status: 'none', w: null, parts: [] };
    kpi.watt.v.textContent = fmtWatt(pw.w);
    const lead = /^(Plattform|Akku)/.test(pw.label) ? `${pw.label} · ` : '';
    kpi.watt.s.textContent = pw.status === 'none' ? 'kein Sensor gefunden (virtuelle Maschine, ARM oder das Board liefert keine Werte)'
      : pw.status === 'denied' ? 'Energiezähler sind für diesen Benutzer gesperrt, Freischalten: sudo ./install.sh --power'
        : pw.w === null ? 'wird gemessen …'
          : `${lead}${pw.parts.slice(0, 3).map((x) => `${x.label} ${fmtWatt(x.w)}`).join(' · ')} · ohne Netzteil`;
    kpi.watt.s.title = pw.status === 'ok' ? 'Gemessen von den Energiezählern der Hardware (CPU/RAM, ggf. Grafikkarte oder Akku). Ohne Verluste des Netzteils, Lüfter, Platten und Mainboard: eine Steckdosen-Messung zeigt mehr.' : '';
    kpi.net.v.textContent = `↓ ${fmtRate(n.netRx)}`; kpi.net.s.textContent = `↑ ${fmtRate(n.netTx)}${n.nics.length ? ` · ${n.nics.map((x) => x.name).join(', ')}` : ''}`;
    kpi.disk.v.textContent = `${fmtRate(n.diskRd)} lesen`; kpi.disk.s.textContent = `${fmtRate(n.diskWr)} schreiben · ${fmtPct(n.diskBusy, 0)} beschäftigt`;

    const rows = d.history.map((r) => ({ ...r, mcShare: r.mc === null ? null : Math.min(100, r.mc / threads) }));
    charts.cpu.update(rows, win); charts.mem.update(rows, win); charts.net.update(rows, win); charts.disk.update(rows, win);
    const hasTemp = rows.some((r) => r.temp !== null && r.temp !== undefined);
    charts.temp.el.hidden = !hasTemp; if (hasTemp) charts.temp.update(rows, win);
    const hasWatt = rows.some((r) => r.watts !== null && r.watts !== undefined);
    charts.watt.el.hidden = !hasWatt; if (hasWatt) charts.watt.update(rows, win);

    put(cores, n.cores.map((c, i) => h('div', { class: 'core' }, h('span', {}, `Kern ${i}`), bar(c, level(c, 70, 90)), h('b', {}, `${c.toFixed(0)} %`))));

    put(mcBox, n.mc.length
      ? n.mc.map((m) => h('div', { class: 'mcrow' }, h('b', {}, m.name),
        h('span', {}, `Prozessor ${(m.cpu).toFixed(0)} % eines Kerns (${fmtPct(Math.min(100, m.cpu / threads), 0)} der Maschine)`),
        h('span', {}, `Speicher ${fmtBytes(m.rss)}`), h('span', {}, `${m.threads} Threads`)))
      : h('p', { class: 'empty' }, 'Es läuft gerade kein Minecraft-Server.'));

    put(fsBox, info.disks.map((x) => { const pct = x.total ? (x.used / x.total) * 100 : 0; return h('div', { class: 'fsrow' },
      h('div', { class: 'row' }, h('b', {}, x.mount), x.hasServers ? h('span', { class: 'chip on' }, 'Server-Ordner') : null, h('span', { class: 'muted small' }, `${x.device} ${x.fstype}`), h('span', { class: 'grow' }), h('span', {}, `${fmtBytes(x.used)} von ${fmtBytes(x.total)} (${pct.toFixed(0)} %)`)),
      bar(pct, level(pct, 80, 92))); }));
    paintProcs(d);
  }

  async function load() {
    const d = await api('GET', `/host/stats?window=${win}`);
    if (token !== getToken()) return;
    paint(d);
  }
  await load();
  every(() => { load().catch(() => {}); }, 2000);
}

// ---------- terminal page ---------------------------------------------------------------------------------------------
const tabs = new Map();      // session id -> { id, title, term, fit, ws, box, ended, retry, dead }
let termToken = 0;

function wsUrl(id) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/host/terminals/${id}/ws`; }

function openTab(info, area, onChange) {
  const box = h('div', { class: 'xt-box', hidden: true });
  area.append(box);
  const term = new window.Terminal({
    cursorBlink: true, fontSize: Number(store('blockhaus.termFont')) || 14, scrollback: 5000, allowProposedApi: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    theme: { background: '#0b0e11', foreground: '#d6dde4', cursor: '#3fb866', selectionBackground: 'rgba(90,162,255,.35)' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  const tab = { id: info.id, title: info.title, term, fit, ws: null, box, ended: false, retry: 0, dead: false };
  tabs.set(info.id, tab);
  const send = (o) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify(o)); };
  term.onData((d) => send({ t: 'in', d }));
  term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
  tab.send = send;

  function connect() {
    if (tab.dead || tab.ended) return;
    const ws = new WebSocket(wsUrl(info.id));
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;
    ws.onopen = () => { tab.retry = 0; term.reset(); try { fit.fit(); } catch { /* hidden */ } send({ t: 'resize', cols: term.cols, rows: term.rows }); onChange(); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'exit') { tab.ended = true; term.write(`\r\n\x1b[2m[Sitzung beendet, Code ${m.code}${m.message ? ': ' + m.message : ''}]\x1b[0m\r\n`); onChange(); }
      } else term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (tab.dead || tab.ended) return;
      if (tab.retry++ < 6) { term.write('\r\n\x1b[2m[Verbindung weg, neuer Versuch …]\x1b[0m\r\n'); setTimeout(connect, 1000 * tab.retry); }
      else { term.write('\r\n\x1b[31m[Verbindung verloren. Seite neu laden oder neu anmelden.]\x1b[0m\r\n'); }
    };
  }
  connect();
  return tab;
}

function disposeAll() {
  for (const t of tabs.values()) { t.dead = true; try { t.ws && t.ws.close(); } catch { /* */ } try { t.term.dispose(); } catch { /* */ } t.box.remove(); }
  tabs.clear();
}

async function terminal(token) {
  termToken = token;
  disposeAll();
  if (!window.Terminal || !window.FitAddon) { put(main, h('div', { class: 'notice err' }, 'Das Terminal-Programm (xterm.js) konnte nicht geladen werden.')); return; }
  const first = await api('GET', '/host/terminals');
  if (token !== getToken()) return;
  let active = store('blockhaus.termActive');
  const bar = h('div', { class: 'xt-tabs' });
  const area = h('div', { class: 'xt-area' });
  const keys = h('div', { class: 'xt-keys' }, [['Esc', '\x1b'], ['Tab', '\t'], ['Strg+C', '\x03'], ['Strg+D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']].map(([l, seq]) => h('button', { class: 'small ghost', onclick: () => { const t = tabs.get(active); if (t) { t.send({ t: 'in', d: seq }); t.term.focus(); } } }, l)));
  const info = h('p', { class: 'sub' }, `Eine echte Shell auf dem Rechner, Benutzer „${first.user}“ in ${first.cwd}. Sie bleibt offen, auch wenn du die Seite schließt (30 Minuten).`);

  function paintBar() {
    put(bar, [...tabs.values()].map((t) => h('span', { class: 'xt-tab' + (t.id === active ? ' on' : '') + (t.ended ? ' ended' : '') },
      h('button', { class: 'ghost', onclick: () => select(t.id) }, t.title + (t.ended ? ' (beendet)' : '')),
      h('button', { class: 'ghost x', title: 'Terminal schließen', 'aria-label': `${t.title} schließen`, onclick: () => closeTab(t.id) }, '×'))),
    h('button', { class: 'small', onclick: () => newTab() }, '+ Neues Terminal'));
  }
  function select(id) {
    active = id; store('blockhaus.termActive', id);
    for (const t of tabs.values()) t.box.hidden = t.id !== id;
    const t = tabs.get(id);
    if (t) { requestAnimationFrame(() => { try { t.fit.fit(); } catch { /* */ } t.term.focus(); }); }
    paintBar();
  }
  async function newTab() {
    try {
      const probe = [...tabs.values()][0];
      const v = await api('POST', '/host/terminals', { cols: probe ? probe.term.cols : 100, rows: probe ? probe.term.rows : 30 });
      openTab(v, area, paintBar); select(v.id);
    } catch (e) { toast(e.message, true); }
  }
  async function closeTab(id) {
    const t = tabs.get(id); if (!t) return;
    if (!t.ended && !confirm('Dieses Terminal schließen? Programme darin werden beendet.')) return;
    t.dead = true; try { t.ws && t.ws.close(); } catch { /* */ }
    try { await api('DELETE', `/host/terminals/${id}`); } catch { /* already gone */ }
    t.term.dispose(); t.box.remove(); tabs.delete(id);
    const next = [...tabs.keys()][0];
    if (next) select(next); else { active = null; paintBar(); await newTab(); }
  }

  put(main, h('div', { class: 'head' }, h('h1', {}, 'Terminal')), info,
    h('div', { class: 'notice warn' }, h('div', {}, h('b', {}, 'Vorsicht: '), 'Hier hat jeder, der angemeldet ist, die Rechte des Benutzers „', first.user, '“ auf diesem Rechner.')),
    bar, area, keys);
  for (const s of first.terminals) openTab(s, area, paintBar);
  if (!tabs.size) await newTab();
  else select(tabs.has(active) ? active : [...tabs.keys()][0]);

  const ro = new ResizeObserver(() => { const t = tabs.get(active); if (t && !t.box.hidden) { try { t.fit.fit(); } catch { /* */ } } });
  ro.observe(area);
  every(() => { if (token !== getToken()) { ro.disconnect(); disposeAll(); } }, 500);
}

// leaving the terminal page ends the browser side only; the shells keep running on the server
window.addEventListener('hashchange', () => { if (tabs.size && !/^#\/term/.test(location.hash)) disposeAll(); });

window.BHHost = { login, perf, terminal };
})();
