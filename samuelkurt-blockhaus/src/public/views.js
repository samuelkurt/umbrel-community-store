(() => {
'use strict';
const { h, put, api, toast, store, S, P, header, every, errorBox, getToken, main } = window.BH;

// ---------- shared helpers ------------------------------------------------------------------
const fmtSize = (n) => {
  if (n === null || n === undefined) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};
const fmtDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function uploadRaw(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', '/api' + url);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.setRequestHeader('X-Blockhaus', '1');
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new Error((d && d.error) || `Fehler (HTTP ${x.status})`));
    };
    x.onerror = () => reject(new Error('Der Upload ist fehlgeschlagen (Verbindung unterbrochen). Sehr große Dateien kann der Umbrel-Proxy ablehnen. Dann die Datei per SMB/SSH in den Server-Ordner legen.'));
    x.send(file);
  });
}

function progressBar(value) {
  const bar = h('div', { class: 'bar' + (value === null ? ' indet' : '') }, h('i', { style: value === null ? '' : `width:${Math.round(value * 100)}%` }));
  return bar;
}

/** Shows one job in `holder` until it ends. Resolves with the final job object. */
async function watchJob(holder, job, token) {
  const box = h('div', { class: 'card job' });
  holder.append(box);
  for (;;) {
    let j = job;
    try { j = await api('GET', P('/jobs/' + job.id)); } catch (e) { j = { ...job, status: 'error', error: e.message }; }
    if (token !== getToken()) { box.remove(); return j; }
    put(box,
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('b', {}, j.title || 'Aufgabe'),
        h('span', { class: 'chip' + (j.status === 'done' ? ' on' : '') }, j.status === 'running' ? 'läuft' : j.status === 'done' ? 'fertig' : 'Fehler')),
      j.status === 'running' ? progressBar(j.progress) : null,
      j.message && j.status === 'running' ? h('div', { class: 'muted small' }, j.message) : null,
      j.status === 'error' ? h('div', { class: 'notice err', style: 'margin:8px 0 0' }, j.error) : null);
    if (j.status !== 'running') {
      if (j.status === 'done') setTimeout(() => box.remove(), 8000);
      return j;
    }
    await sleep(700);
  }
}

/** If a job is already running for this server (started earlier or in another tab), show it. */
async function resumeJobs(holder, token, onDone) {
  let jobs = [];
  try { jobs = (await api('GET', P('/jobs'))).jobs; } catch { return; }
  for (const j of jobs.filter((x) => x.status === 'running')) {
    watchJob(holder, j, token).then((fin) => { if (token === getToken() && onDone) onDone(fin); });
  }
}

const needStopNotice = (running) => (running ? h('div', { class: 'notice warn' }, h('span', {}, 'Der Server läuft. Für diese Aktion muss er gestoppt sein.'),
  h('a', { href: '#/server' }, h('button', { class: 'small' }, 'Zur Server-Seite'))) : null);

function niceItem(id) {
  return id.replace(/^[a-z0-9_.-]+:/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function colorOf(s) { let x = 0; for (const c of s) x = (x * 33 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} 38% 34%)`; }

// ---------- Dateien --------------------------------------------------------------------------
function hashParams() {
  const m = /\?(.*)$/.exec(location.hash);
  return new URLSearchParams(m ? m[1] : '');
}

async function viewFiles(token) {
  const hp = hashParams();
  if (hp.get('edit')) return editFile(token, hp.get('edit'));
  const cur = hp.get('p') || '';
  const data = await api('GET', P('/files?' + q({ path: cur })));
  if (token !== getToken()) return;
  const parts = cur ? cur.split('/') : [];
  const go = (p) => { location.hash = '#/files' + (p ? '?p=' + encodeURIComponent(p) : ''); };
  const crumbs = h('div', { class: 'crumbs' }, h('a', { href: '#/files' }, 'Server-Ordner'),
    parts.map((seg, i) => [' / ', h('a', { href: '#/files?p=' + encodeURIComponent(parts.slice(0, i + 1).join('/')) }, seg)]));
  const jobsBox = h('div', {});
  const upBox = h('div', {});
  const rel = (name) => (cur ? cur + '/' + name : name);

  async function doUpload(fileList) {
    for (const f of fileList) {
      const row = h('div', { class: 'card job' }, h('b', {}, f.name), h('div', { class: 'muted small' }, 'Lade hoch …'));
      const bar = progressBar(0); row.append(bar);
      upBox.append(row);
      const set = (v) => { bar.firstChild.style.width = Math.round(v * 100) + '%'; };
      try {
        let overwrite = '';
        const exists = data.entries.some((e) => e.name === f.name);
        if (exists) { if (!confirm(`„${f.name}“ gibt es schon. Überschreiben?`)) { row.remove(); continue; } overwrite = '1'; }
        await uploadRaw(P('/files/upload?' + q({ path: cur, name: f.name, overwrite })), f, set);
        row.remove(); toast(`${f.name} hochgeladen.`);
      } catch (e) { row.remove(); toast(e.message, true); }
    }
    window.BH.route();
  }

  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none', onchange: () => doUpload([...fileInput.files]) });
  const table = h('table', { class: 'files' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num' }, 'Größe'), h('th', {}, 'Geändert'), h('th', {}, ''))),
    h('tbody', {},
      cur ? h('tr', {}, h('td', { colspan: 4 }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go(parts.slice(0, -1).join('/')); } }, '↩ Eine Ebene höher'))) : null,
      data.entries.map((e) => h('tr', {},
        h('td', {}, e.type === 'dir'
          ? h('a', { href: '#/files?p=' + encodeURIComponent(rel(e.name)) }, '📁 ' + e.name)
          : e.text ? h('a', { href: '#/files?edit=' + encodeURIComponent(rel(e.name)) }, '📄 ' + e.name)
            : h('span', {}, (e.type === 'link' ? '🔗 ' : '▪ ') + e.name)),
        h('td', { class: 'num muted' }, fmtSize(e.size)),
        h('td', { class: 'muted' }, e.mtime ? fmtDate(e.mtime) : ''),
        h('td', { class: 'acts' },
          e.type === 'file' ? h('a', { href: '/api' + P('/files/download?' + q({ path: rel(e.name) })), download: e.name }, h('button', { class: 'small' }, 'Laden')) : null,
          e.type !== 'link' ? h('button', { class: 'small', onclick: async () => {
            const to = prompt('Neuer Name:', e.name);
            if (!to || to === e.name) return;
            try { await api('POST', P('/files/rename'), { from: rel(e.name), to: rel(to) }); window.BH.route(); } catch (err) { toast(err.message, true); }
          } }, 'Umbenennen') : null,
          h('button', { class: 'small danger', onclick: async () => {
            if (!confirm(`„${e.name}“ ${e.type === 'dir' ? 'samt Inhalt ' : ''}wirklich löschen? Das lässt sich nicht rückgängig machen.`)) return;
            try { await api('POST', P('/files/delete'), { path: rel(e.name) }); window.BH.route(); } catch (err) { toast(err.message, true); }
          } }, 'Löschen'))))));

  const card = h('div', { class: 'card dropzone' },
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' }, crumbs,
      h('span', { class: 'row' },
        h('button', { onclick: async () => {
          const n = prompt('Name des neuen Ordners:');
          if (!n) return;
          try { await api('POST', P('/files/mkdir'), { path: rel(n) }); window.BH.route(); } catch (e) { toast(e.message, true); }
        } }, 'Neuer Ordner'),
        h('button', { class: 'primary', onclick: () => fileInput.click() }, 'Hochladen'), fileInput)),
    data.entries.length || cur ? table : h('div', { class: 'empty' }, 'Dieser Ordner ist leer.'),
    h('div', { class: 'muted small', style: 'margin-top:8px' }, 'Dateien lassen sich auch hierher ziehen.'));
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('over'); if (e.dataTransfer.files.length) doUpload([...e.dataTransfer.files]); });
  put(main, header('Dateien', 'Der Ordner deines Minecraft-Servers. Änderungen an Konfigurationsdateien gelten nach einem Neustart.'), jobsBox, upBox, card);
}

async function editFile(token, rel) {
  const r = await api('GET', P('/files/read?' + q({ path: rel })));
  if (token !== getToken()) return;
  const ta = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': rel });
  ta.value = r.text;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const back = '#/files' + (dir ? '?p=' + encodeURIComponent(dir) : '');
  put(main, header('Datei bearbeiten', rel),
    h('div', { class: 'card' }, ta,
      h('div', { class: 'row', style: 'margin-top:10px;justify-content:flex-end' },
        h('a', { href: back }, h('button', {}, 'Zurück')),
        h('button', { class: 'primary', onclick: async () => {
          try { await api('PUT', P('/files/write'), { path: rel, text: ta.value }); toast('Gespeichert.'); } catch (e) { toast(e.message, true); }
        } }, 'Speichern'))));
}

// ---------- Welten ---------------------------------------------------------------------------
async function viewWorlds(token) {
  const d = await api('GET', P('/worlds'));
  if (token !== getToken()) return;
  const jobsBox = h('div', {});
  const reload = () => window.BH.route();

  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  const worldCard = (w) => h('div', { class: 'card world' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', {}, h('b', { style: 'font-size:17px' }, w.name), ' ', w.active ? h('span', { class: 'chip on' }, 'aktiv') : null, w.hardcore ? h('span', { class: 'chip' }, 'Hardcore') : null),
      h('span', { class: 'row' },
        !w.active ? h('button', { disabled: d.running, onclick: mut(async () => { await api('POST', P('/worlds/activate'), { name: w.name }); toast('Aktiviert. Gilt ab dem nächsten Start.'); reload(); }) }, 'Aktivieren') : null,
        h('a', { href: '/api' + P('/worlds/download?' + q({ name: w.name })), download: w.name + '.zip' }, h('button', {}, 'Herunterladen')),
        !w.active ? h('button', { class: 'danger', disabled: d.running, onclick: mut(async () => {
          if (!confirm(`Die Welt „${w.name}“ endgültig löschen (${fmtSize(w.size)})? Mach vorher ein Backup, wenn du sie behalten willst.`)) return;
          await api('POST', P('/worlds/delete'), { name: w.name }); reload();
        }) }, 'Löschen') : null)),
    h('div', { class: 'facts' },
      h('div', {}, h('span', { class: 'k' }, 'Seed'), w.seed !== null ? h('code', {}, w.seed) : h('span', { class: 'muted' }, 'unbekannt'),
        w.seed !== null ? h('button', { class: 'small ghost', onclick: () => navigator.clipboard && navigator.clipboard.writeText(w.seed).then(() => toast('Seed kopiert.')) }, 'Kopieren') : null),
      h('div', {}, h('span', { class: 'k' }, 'Version'), w.version || '–'),
      h('div', {}, h('span', { class: 'k' }, 'Spielmodus'), w.gameType || '–'),
      h('div', {}, h('span', { class: 'k' }, 'Größe'), fmtSize(w.size) + (w.companions.length ? ' (inkl. Nether/Ende)' : '')),
      h('div', {}, h('span', { class: 'k' }, 'Zuletzt gespielt'), w.lastPlayed ? fmtDate(w.lastPlayed) : '–')),
    w.error ? h('div', { class: 'notice err' }, 'level.dat nicht lesbar: ' + w.error) : null);

  // new world
  const nName = h('input', { type: 'text', placeholder: 'z. B. welt2', 'aria-label': 'Name der neuen Welt' });
  const nSeed = h('input', { type: 'text', placeholder: 'leer = Zufall', 'aria-label': 'Seed' });
  const nType = h('select', { 'aria-label': 'Welttyp' }, [['minecraft:normal', 'Normal'], ['minecraft:flat', 'Superflach'], ['minecraft:large_biomes', 'Große Biome'], ['minecraft:amplified', 'Amplified']].map(([v, l]) => h('option', { value: v }, l)));
  const nStruct = h('input', { type: 'checkbox', checked: true });
  const newCard = h('div', { class: 'card' }, h('h2', {}, 'Neue Welt erzeugen'),
    h('p', { class: 'muted', style: 'margin-top:-4px' }, 'Die Welt entsteht beim nächsten Start des Servers und wird sofort die aktive Welt. Die bisherige bleibt im Ordner liegen.'),
    h('div', { class: 'grid2' },
      h('label', { class: 'f' }, h('span', {}, 'Name'), nName),
      h('label', { class: 'f' }, h('span', {}, 'Seed'), nSeed),
      h('label', { class: 'f' }, h('span', {}, 'Welttyp'), nType),
      h('label', { class: 'f' }, h('span', {}, 'Strukturen'), h('label', { class: 'row', style: 'gap:8px' }, nStruct, 'Dörfer, Festungen usw. erzeugen'))),
    h('button', { class: 'primary', disabled: d.running, onclick: mut(async () => {
      const r = await api('POST', P('/worlds/new'), { name: nName.value.trim(), seed: nSeed.value.trim(), levelType: nType.value, structures: nStruct.checked });
      toast(r.note); reload();
    }) }, 'Welt anlegen'));

  // upload
  const uName = h('input', { type: 'text', placeholder: 'Ordnername, z. B. meine-welt', 'aria-label': 'Ordnername' });
  const uAct = h('input', { type: 'checkbox', checked: true });
  const uFile = h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'ZIP-Datei' });
  const uBar = h('div', {});
  const upCard = h('div', { class: 'card' }, h('h2', {}, 'Welt hochladen'),
    h('p', { class: 'muted', style: 'margin-top:-4px' }, 'Eine Welt als ZIP (der Ordner mit der level.dat darf auch in einem Unterordner liegen). Wird neu angelegt, nichts wird überschrieben.'),
    h('div', { class: 'grid2' },
      h('label', { class: 'f' }, h('span', {}, 'ZIP-Datei'), uFile),
      h('label', { class: 'f' }, h('span', {}, 'Ordnername im Server'), uName)),
    h('label', { class: 'row', style: 'gap:8px;margin-bottom:10px' }, uAct, 'Danach als aktive Welt einstellen'),
    h('button', { class: 'primary', disabled: d.running, onclick: mut(async () => {
      const f = uFile.files[0];
      if (!f) { toast('Bitte eine ZIP-Datei wählen.', true); return; }
      const name = (uName.value.trim() || f.name.replace(/\.zip$/i, '')).replace(/[^A-Za-z0-9_.-]/g, '_');
      const row = h('div', { class: 'card job' }, h('b', {}, `Lade ${f.name} hoch …`)); const bar = progressBar(0); row.append(bar); uBar.append(row);
      let r;
      try { r = await uploadRaw(P('/worlds/upload?' + q({ name, activate: uAct.checked ? '1' : '' })), f, (v) => { bar.firstChild.style.width = Math.round(v * 100) + '%'; }); }
      finally { row.remove(); }
      const fin = await watchJob(jobsBox, r.job, token);
      if (fin.status === 'done') { toast(`Welt „${fin.result.name}“ importiert (Seed ${fin.result.seed || 'unbekannt'}).`); reload(); }
    }) }, 'Hochladen und importieren'), uBar);

  const liveSeed = d.running ? h('button', { onclick: mut(async () => { const r = await api('POST', P('/worlds/seed-live')); toast('Seed der laufenden Welt: ' + (r.seed || 'unbekannt')); }) }, 'Seed vom laufenden Server abfragen') : null;

  put(main, header('Welten', 'Welten ansehen, wechseln, sichern, hochladen und neu erzeugen.', liveSeed),
    needStopNotice(d.running), jobsBox,
    d.worlds.length ? d.worlds.map(worldCard) : h('div', { class: 'card empty' }, 'Noch keine Welt vorhanden. Sie entsteht beim ersten Start des Servers, oder lege unten eine neue an.'),
    newCard, upCard);
  resumeJobs(jobsBox, token, () => reload());
}

// ---------- Backups --------------------------------------------------------------------------
async function viewBackups(token) {
  const d = await api('GET', P('/backups'));
  if (token !== getToken()) return;
  const jobsBox = h('div', {});
  const reload = () => window.BH.route();
  const note = h('input', { type: 'text', placeholder: 'Notiz (optional)', 'aria-label': 'Notiz' });
  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  async function start(kind) {
    const r = await api('POST', P('/backups'), { kind, note: note.value });
    const fin = await watchJob(jobsBox, r.job, token);
    if (fin.status === 'done') { toast('Backup fertig.'); reload(); }
  }
  const row = (b) => h('li', {},
    h('div', { class: 'nm' }, h('b', {}, fmtDate(b.created)), ' ', h('span', { class: 'chip' }, b.kind === 'full' ? 'Alles' : b.kind === 'worlds' ? 'Welten' : b.kind),
      b.version ? h('span', { class: 'chip' }, b.version) : null,
      h('small', {}, [fmtSize(b.size), b.worlds.length ? 'Welten: ' + b.worlds.join(', ') : null, b.note].filter(Boolean).join(' · '))),
    h('a', { href: '/api' + P('/backups/download?' + q({ id: b.id })), download: b.id + '.zip' }, h('button', { class: 'small' }, 'Laden')),
    h('button', { class: 'small', disabled: d.running, title: d.running ? 'Server zuerst stoppen' : '', onclick: mut(async () => {
      if (!confirm(`Dieses Backup wiederherstellen?\n\nDie aktuellen Welten werden vorher automatisch gesichert und dann durch den Stand vom ${fmtDate(b.created)} ersetzt.`)) return;
      const r = await api('POST', P('/backups/restore'), { id: b.id });
      const fin = await watchJob(jobsBox, r.job, token);
      if (fin.status === 'done') { toast('Wiederhergestellt.'); reload(); }
    }) }, 'Wiederherstellen'),
    h('button', { class: 'small danger', onclick: mut(async () => {
      if (!confirm('Dieses Backup löschen?')) return;
      await api('POST', P('/backups/delete'), { id: b.id }); reload();
    }) }, 'Löschen'));

  put(main, header('Backups', 'Sicherungen liegen in den Daten dieser App (nicht im Server-Ordner). Läuft der Server, speichert er die Welt vorher und pausiert das Speichern kurz.'),
    d.running ? h('div', { class: 'notice' }, 'Der Server läuft. Backups sind trotzdem möglich. Wiederherstellen geht nur bei gestopptem Server.') : null,
    jobsBox,
    h('div', { class: 'card' }, h('h2', {}, 'Neues Backup'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, note),
        h('button', { class: 'primary', onclick: mut(() => start('worlds')) }, 'Welten sichern'),
        h('button', { onclick: mut(() => start('full')) }, 'Alles sichern')),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, '„Alles“ enthält den ganzen Server-Ordner außer Logs. Das kann groß werden.'),
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'small ghost', onclick: mut(async () => { await api('POST', P('/backups/crafty'), {}); toast('Crafty wurde angewiesen, ein eigenes Backup zu erstellen (siehe Crafty).'); }) }, 'Zusätzlich Crafty-Backup auslösen'))),
    h('div', { class: 'card' }, h('h2', {}, `Vorhandene Backups (${d.items.length})`),
      d.items.length ? h('ul', { class: 'plist' }, d.items.map(row)) : h('div', { class: 'empty' }, 'Noch keine Backups.')));
  resumeJobs(jobsBox, token, () => reload());
}

// ---------- Software -------------------------------------------------------------------------
async function viewSoftware(token) {
  const d = await api('GET', P('/software'));
  if (token !== getToken()) return;
  const jobsBox = h('div', {});
  const reload = () => window.BH.route();
  const want = hashParams().get('kind');
  let kind = d.kinds.some((k) => k.id === want && !k.unsupported) ? want : d.installed.software && d.kinds.some((k) => k.id === d.installed.software && !k.unsupported) ? d.installed.software : 'vanilla';
  let stopFirst = true; let startAfter = true;
  let versions = []; let showUnstable = false; let sel = null; let resolved = null; let backup = true;
  const detail = h('div', {});
  const kindsBox = h('div', { class: 'kinds' });
  const cmp = (a, b) => {
    const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return -1; if (pb[i] === undefined) return 1;
      if (pa[i] !== pb[i]) return typeof pa[i] === 'number' && typeof pb[i] === 'number' ? pa[i] - pb[i] : String(pa[i]) < String(pb[i]) ? -1 : 1;
    }
    return 0;
  };
  const MODDED = new Set(['fabric', 'quilt', 'forge', 'neoforge']);

  function paintKinds() {
    put(kindsBox, d.kinds.map((k) => h('button', { class: 'kind' + (k.id === kind ? ' on' : '') + (k.unsupported ? ' off' : ''), onclick: () => { kind = k.id; sel = null; resolved = null; paintKinds(); loadVersions(); } },
      h('b', {}, k.label), d.installed.software === k.id ? h('span', { class: 'chip on' }, 'installiert') : null, h('small', {}, k.info))));
  }

  async function loadVersions() {
    const k = d.kinds.find((x) => x.id === kind);
    if (k.unsupported) { put(detail, h('div', { class: 'notice warn' }, k.info)); return; }
    put(detail, h('p', { class: 'muted' }, 'Lade Versionen …'));
    try { versions = (await api('GET', P('/software/versions?' + q({ kind })))).versions; }
    catch (e) { put(detail, h('div', { class: 'notice err' }, e.message)); return; }
    paintDetail();
  }

  async function pick(id) {
    sel = id; resolved = null; paintDetail();
    try { resolved = await api('GET', P('/software/resolve?' + q({ kind, version: id }))); } catch (e) { resolved = { error: e.message }; }
    paintDetail();
  }

  function paintDetail() {
    const k = d.kinds.find((x) => x.id === kind);
    const shown = versions.filter((v) => showUnstable || v.stable || kind === 'snapshot');
    const select = h('select', { 'aria-label': 'Version wählen', onchange: (e) => pick(e.target.value) },
      h('option', { value: '' }, '– Version wählen –'),
      shown.map((v) => h('option', { value: v.id, selected: v.id === sel }, v.id + (v.build && kind !== 'fabric' ? `  (${v.build})` : '') + (!v.stable && kind !== 'snapshot' ? ' · Vorabversion' : ''))));
    const cur = d.installed.version;
    const downgrade = sel && cur && /^\d/.test(cur) && !/[a-z]/i.test(sel) && !/[a-z]/i.test(cur) && cmp(sel, cur) < 0;
    const warnings = [];
    if (resolved && !resolved.error) {
      if (resolved.java) warnings.push(`Benötigt Java ${resolved.java} oder neuer. Welche Java-Version dein Server in Crafty nutzt, siehst du dort in der Server-Konfiguration. Zu altes Java lässt den Server nicht starten.`);
      if (resolved.type === 'installer') warnings.push('Beim ersten Start läuft einmalig der Installer des Mod-Loaders. Das braucht Internet und kann einige Minuten dauern. Der Server meldet sich erst danach.');
      if (resolved.checksum.length === 0) warnings.push('Für diesen Download gibt es keine Prüfsumme des Anbieters. Er kommt nur über HTTPS.');
    }
    if (downgrade) warnings.push(`Das ist eine ältere Version als die aktuelle (${cur}). Eine Welt, die in einer neueren Version gespielt wurde, kann dadurch beschädigt werden.`);
    if (cur && kind && d.installed.software && d.installed.software !== kind && (MODDED.has(d.installed.software) || MODDED.has(kind))) warnings.push('Beim Wechsel zwischen Mod-Loadern oder zu/von Vanilla bleiben Mods, Plugins und deren Daten im Server-Ordner. Welten mit Mod-Inhalten laufen ohne die Mods nicht richtig.');
    const btn = h('button', { class: 'primary big', disabled: !sel || !resolved || !!resolved.error, onclick: async () => {
      if (!confirm(`${k.label} ${sel} installieren?\n\n${d.running ? 'Der Server wird dafür gestoppt, verbundene Spieler fliegen raus.\n' : ''}Die bisherige Start-Datei bleibt als „${d.jar}.blockhaus-prev“ erhalten.${backup ? '\nVorher wird ein Backup der Welten angelegt.' : '\nOHNE Backup der Welten.'}`)) return;
      try {
        const r = await api('POST', P('/software/install'), { kind, version: sel, backup, stopFirst: d.running && stopFirst, startAfter: d.running && stopFirst && startAfter });
        const fin = await watchJob(jobsBox, r.job, token);
        if (fin.status === 'done') { toast(`${k.label} ${sel} ist installiert. Starte den Server.`); reload(); }
      } catch (e) { toast(e.message, true); }
    } }, `${k.label} ${sel || ''} installieren`);
    put(detail, h('div', { class: 'card' }, h('h2', {}, k.label), h('p', { class: 'muted', style: 'margin-top:-4px' }, k.info),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, select),
        h('label', { class: 'row', style: 'gap:6px' }, h('input', { type: 'checkbox', style: 'width:auto', checked: showUnstable, onchange: (e) => { showUnstable = e.target.checked; paintDetail(); } }), kind === 'snapshot' ? '' : 'Vorabversionen anzeigen')),
      resolved && resolved.error ? h('div', { class: 'notice err', style: 'margin-top:10px' }, resolved.error) : null,
      warnings.map((w) => h('div', { class: 'notice warn', style: 'margin-top:10px' }, w)),
      h('label', { class: 'row', style: 'gap:8px;margin:12px 0' }, h('input', { type: 'checkbox', style: 'width:auto', checked: backup, onchange: (e) => { backup = e.target.checked; paintDetail(); } }), 'Vorher ein Backup der Welten anlegen (empfohlen)'),
      d.running ? h('div', { class: 'notice warn' }, h('div', {}, h('b', {}, 'Der Server läuft.'), ' Die Start-Datei kann nur bei gestopptem Server getauscht werden.',
        h('label', { class: 'row', style: 'gap:8px;margin-top:8px' }, h('input', { type: 'checkbox', style: 'width:auto', checked: stopFirst, onchange: (e) => { stopFirst = e.target.checked; paintDetail(); } }), 'Server dafür stoppen (Spieler werden getrennt)'),
        stopFirst ? h('label', { class: 'row', style: 'gap:8px;margin-top:4px' }, h('input', { type: 'checkbox', style: 'width:auto', checked: startAfter, onchange: (e) => { startAfter = e.target.checked; paintDetail(); } }), 'Danach wieder starten') : null)) : null,
      btn, d.running && !stopFirst ? h('p', { class: 'muted small' }, 'Ohne Stoppen lehnt der Server den Wechsel ab. Stoppe ihn selbst auf der Server-Seite.') : null));
  }

  const cur = d.installed;
  put(main, header('Software', 'Minecraft-Version und Server-Software wechseln.'),
    jobsBox,
    h('div', { class: 'card kv' }, h('div', { class: 'k' }, 'Installiert'),
      h('div', { class: 'v' }, (d.kinds.find((k) => k.id === cur.software) || { label: cur.software || 'Unbekannt' }).label + (cur.version ? ' ' + cur.version : '')),
      h('div', { class: 's' }, [cur.build ? 'Build ' + cur.build : null, cur.guessed ? 'geschätzt aus Name der Start-Datei und Crafty' : null, `Start-Datei: ${d.jar}`].filter(Boolean).join(' · '))),
    kindsBox, detail);
  paintKinds();
  loadVersions();
  resumeJobs(jobsBox, token, () => reload());
}

// ---------- Mods & Plugins -------------------------------------------------------------------
async function viewMods(token) {
  const d = await api('GET', P('/mods'));
  if (token !== getToken()) return;
  const jobsBox = h('div', {});
  const reload = () => window.BH.route();
  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  if (!d.folder) {
    put(main, header('Mods & Plugins'), h('div', { class: 'notice warn' }, h('span', {}, d.reason)),
      h('div', { class: 'card' }, h('h2', {}, 'Zuerst die passende Server-Software wählen'),
        h('p', { class: 'muted' }, 'Mods brauchen einen Mod-Loader, Plugins einen Plugin-Server. Mit Vanilla geht beides nicht. Der Wechsel dauert ein paar Minuten, deine Welt bleibt erhalten.'),
        h('div', { class: 'row' },
          h('a', { href: '#/software?kind=fabric' }, h('button', { class: 'primary' }, 'Fabric (Mods)')),
          h('a', { href: '#/software?kind=neoforge' }, h('button', {}, 'NeoForge (Mods)')),
          h('a', { href: '#/software?kind=forge' }, h('button', {}, 'Forge (Mods)')),
          h('a', { href: '#/software?kind=paper' }, h('button', {}, 'Paper (Plugins)')))));
    return;
  }
  const word = d.kind === 'plugin' ? 'Plugin' : 'Mod';
  let tab = store('blockhaus.modtab') || 'installed';
  const body = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.jar', multiple: true, style: 'display:none', onchange: mut(async () => {
    for (const f of [...fileInput.files]) {
      await uploadRaw(P('/mods/upload?' + q({ name: f.name })), f);
      toast(f.name + ' hochgeladen.');
    }
    reload();
  }) });

  const installed = () => put(body,
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
        h('span', { class: 'muted' }, `Ordner: ${d.folder}/ · ${d.items.length} Datei${d.items.length === 1 ? '' : 'en'}`),
        h('button', { onclick: () => fileInput.click() }, '.jar hochladen'), fileInput),
      d.items.length ? h('ul', { class: 'plist' }, d.items.map((m) => h('li', { class: m.enabled ? '' : 'disabled' },
        h('div', { class: 'nm' }, h('b', {}, m.name || m.file), m.version ? ' ' + m.version : '', m.modrinth ? h('span', { class: 'chip' }, 'Modrinth') : null,
          h('small', {}, [m.description, m.file, fmtSize(m.size)].filter(Boolean).join(' · '))),
        h('label', { class: 'switch', title: m.enabled ? 'Aktiv' : 'Deaktiviert' }, h('input', { type: 'checkbox', checked: m.enabled, 'aria-label': (m.name || m.file) + ' aktiv', onchange: mut(async () => { await api('POST', P('/mods/toggle'), { file: m.file }); reload(); }) }), h('i')),
        h('button', { class: 'small danger', onclick: mut(async () => { if (!confirm(`${m.name || m.file} löschen?`)) return; await api('POST', P('/mods/delete'), { file: m.file }); reload(); }) }, 'Löschen')))) : h('div', { class: 'empty' }, `Noch keine ${word}s installiert.`)));

  const installBtn = (project) => h('button', { class: 'small primary', onclick: mut(async () => {
    const j = await api('POST', P('/mods/install'), { project });
    const fin = await watchJob(jobsBox, j.job, token);
    if (fin.status === 'done') { toast(fin.result.files.length ? `Installiert: ${fin.result.files.join(', ')}` : 'Schon installiert.'); reload(); }
  }) }, 'Installieren');

  const perf = async () => {
    put(body, h('p', { class: 'muted' }, 'Suche passende Mods auf Modrinth …'));
    let r;
    try { r = await api('GET', P('/mods/recommended')); } catch (e) { put(body, h('div', { class: 'notice err' }, e.message)); return; }
    if (token !== getToken() || tab !== 'perf') return;
    const where = `${d.software ? d.software[0].toUpperCase() + d.software.slice(1) : 'deine Software'}${d.mcVersion ? ' ' + d.mcVersion : ''}`;
    const side = (x) => (x.client === 'unsupported' ? h('span', { class: 'chip on', title: 'Nur auf dem Server nötig. Deine Freunde müssen nichts installieren.' }, 'nur Server')
      : x.client === 'required' ? h('span', { class: 'chip warn', title: 'Alle Spieler brauchen diesen Mod ebenfalls.' }, 'auch bei Spielern nötig')
        : h('span', { class: 'chip', title: 'Bei den Spielern optional.' }, 'bei Spielern optional'));
    put(body,
      h('div', { class: 'card' }, h('h2', {}, 'Für bessere Leistung'),
        h('p', { class: 'muted small', style: 'margin-top:-4px' }, `Gezeigt wird nur, wofür es auf Modrinth wirklich eine Fassung für ${where} gibt. Sie werden mit ihren Abhängigkeiten installiert, der Server muss danach neu starten.`),
        r.items.length ? h('ul', { class: 'plist' }, r.items.map((x) => h('li', {},
          x.icon ? h('img', { src: x.icon, alt: '', width: 40, height: 40, loading: 'lazy', referrerpolicy: 'no-referrer', style: 'border-radius:8px' }) : h('div', { class: 'avatar' }, x.title.slice(0, 1)),
          h('div', { class: 'nm' }, h('b', {}, x.title), ' ', side(x), x.versionType !== 'release' ? h('span', { class: 'chip warn', title: 'Noch keine fertige Version, nur Beta oder Alpha.' }, x.versionType) : null, h('small', {}, x.note + ' · ' + x.version)),
          x.installed ? h('span', { class: 'chip on' }, 'installiert') : installBtn(x.project))))
          : h('div', { class: 'empty' }, `Für ${where} gibt es keine dieser Mods.`)),
      r.alt && r.alt.titles.length ? h('div', { class: 'notice' }, h('span', {}, `Für ${r.alt.loader === 'neoforge' ? 'NeoForge' : r.alt.loader}${d.mcVersion ? ' ' + d.mcVersion : ''} gibt es mehr davon: ${r.alt.titles.join(', ')}. Ein Wechsel unter „Software“ behält die Welt, aber deine Mods müssen dann NeoForge-Fassungen sein.`),
        h('a', { href: '#/software?kind=' + r.alt.loader }, h('button', { class: 'small' }, 'Zu Software'))) : null,
      r.missing.length ? h('p', { class: 'muted small' }, `Nicht für ${where} verfügbar: ${r.missing.join(', ')}.`) : null);
  };

  const search = () => {
    const input = h('input', { type: 'text', placeholder: `${word}s auf Modrinth suchen …`, 'aria-label': 'Suche', onkeydown: (e) => { if (e.key === 'Enter') run(); } });
    const results = h('div', {});
    async function run() {
      put(results, h('p', { class: 'muted' }, 'Suche …'));
      try {
        const r = await api('GET', P('/mods/search?' + q({ q: input.value })));
        put(results, r.hits.length ? h('ul', { class: 'plist' }, r.hits.map((x) => h('li', {},
          x.icon ? h('img', { src: x.icon, alt: '', width: 40, height: 40, loading: 'lazy', referrerpolicy: 'no-referrer', style: 'border-radius:8px' }) : h('div', { class: 'avatar' }, x.title.slice(0, 1)),
          h('div', { class: 'nm' }, h('b', {}, x.title), ' ', h('span', { class: 'muted' }, 'von ' + x.author), h('small', {}, x.description)),
          installBtn(x.project)))) : h('div', { class: 'empty' }, 'Nichts gefunden.'));
      } catch (e) { put(results, h('div', { class: 'notice err' }, e.message)); }
    }
    put(body, h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'primary', onclick: run }, 'Suchen')),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, `Gezeigt werden nur ${word}s für ${d.software || 'deine Software'}${d.mcVersion ? ' und Minecraft ' + d.mcVersion : ''}. Benötigte Abhängigkeiten werden automatisch mitinstalliert, Downloads per Prüfsumme geprüft.`)), results);
    run();
  };

  const TABS = [['installed', `Installiert (${d.items.length})`], ['perf', 'Schneller'], ['search', 'Modrinth']];
  if (!TABS.some(([id]) => id === tab)) tab = 'installed';
  const tabs = h('div', { class: 'tabs' }, TABS.map(([id, label]) =>
    h('button', { class: id === tab ? 'on' : '', onclick: () => { tab = id; store('blockhaus.modtab', id); paint(); } }, label)));
  const paint = () => { tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', TABS[i][0] === tab)); ({ installed, perf, search })[tab](); };
  put(main, header('Mods & Plugins', `${d.software ? d.software[0].toUpperCase() + d.software.slice(1) : ''} ${d.mcVersion || ''}`.trim()),
    d.running ? h('div', { class: 'notice' }, `Änderungen an ${word}s gelten erst nach einem Neustart des Servers.`) : null, jobsBox, tabs, body);
  paint();
  resumeJobs(jobsBox, token, () => reload());
}

// ---------- Inventare ------------------------------------------------------------------------
const SLOT_LABEL = { 103: 'Helm', 102: 'Brustplatte', 101: 'Hose', 100: 'Schuhe', '-106': 'Zweithand' };

function itemTile(it, label) {
  if (!it) return h('div', { class: 'slot empty', title: label || '' });
  const lines = [it.name ? `${it.name} (${niceItem(it.id)})` : niceItem(it.id)];
  if (it.count > 1) lines.push('Anzahl: ' + it.count);
  for (const e of [...it.enchants, ...it.storedEnchants]) lines.push(`${niceItem(e.id)} ${e.level}`);
  if (it.damage) lines.push('Abnutzung: ' + it.damage);
  if (it.container) lines.push(`Enthält ${it.container} Stapel`);
  lines.push(...it.lore);
  const abbr = niceItem(it.id).split(' ').map((w) => w[0]).join('').slice(0, 3);
  return h('div', { class: 'slot' + (it.enchants.length || it.storedEnchants.length ? ' ench' : ''), title: lines.join('\n'), style: `background:${colorOf(it.id)}` },
    h('span', { class: 'abbr' }, abbr), it.count > 1 ? h('span', { class: 'cnt' }, it.count) : null);
}

function invGrid(items) {
  const bySlot = new Map(items.map((i) => [i.slot, i]));
  const rows = [];
  for (let r = 0; r < 3; r++) rows.push(h('div', { class: 'srow' }, Array.from({ length: 9 }, (_, c) => itemTile(bySlot.get(9 + r * 9 + c)))));
  const hot = h('div', { class: 'srow hot' }, Array.from({ length: 9 }, (_, c) => itemTile(bySlot.get(c))));
  const armor = h('div', { class: 'armor' }, [103, 102, 101, 100, -106].map((s) => h('div', { class: 'aslot' }, itemTile(bySlot.get(s), SLOT_LABEL[s]), h('small', {}, SLOT_LABEL[s]))));
  const other = items.filter((i) => i.slot === null || !(i.slot >= 0 && i.slot <= 35) && !SLOT_LABEL[i.slot]);
  return h('div', { class: 'inv' }, armor, h('div', {}, ...rows, h('div', { style: 'height:8px' }), hot),
    other.length ? h('div', { class: 'muted small' }, 'Weitere Slots: ' + other.map((i) => niceItem(i.id)).join(', ')) : null);
}

async function viewInventory(token) {
  const d = await api('GET', P('/inventory/players'));
  if (token !== getToken()) return;
  const detail = h('div', {});
  let cur = null;
  const names = new Set(d.online);
  const list = h('ul', { class: 'plist' });

  async function show(uuid, name, live) {
    cur = uuid || name;
    paintList();
    put(detail, h('p', { class: 'muted' }, 'Lade …'));
    try {
      const inv = live ? await api('POST', P('/inventory/live'), { name }) : await api('GET', P('/inventory/' + uuid));
      const s = inv.stats || {};
      put(detail, h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('h2', { style: 'margin:0' }, inv.name || name || uuid),
          h('span', { class: 'row' },
            h('span', { class: 'chip' + (live ? ' on' : '') }, live ? 'live vom Server' : 'gespeichert ' + fmtDate(inv.savedAt)),
            name && d.running ? h('button', { onclick: () => show(uuid, name, true).catch((e) => toast(e.message, true)) }, 'Live vom Server holen') : null,
            live && uuid ? h('button', { onclick: () => show(uuid, name, false) }, 'Gespeicherten Stand zeigen') : null)),
        !live ? h('p', { class: 'muted small' }, 'Der Server schreibt Spielerdaten beim Speichern und Verlassen. Für den aktuellen Stand eines Online-Spielers „Live vom Server holen“.') : null,
        Object.keys(s).length ? h('div', { class: 'facts' }, [
          ['Gesundheit', s.health], ['Hunger', s.food], ['Level', s.xpLevel], ['Spielmodus', s.gameMode], ['Dimension', s.dimension], ['Position', s.pos && s.pos.join(', ')],
        ].filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => h('div', {}, h('span', { class: 'k' }, k), String(v)))) : null,
        h('h2', { style: 'margin-top:14px' }, 'Inventar'), invGrid(inv.items),
        h('h2', { style: 'margin-top:14px' }, `Endertruhe (${inv.ender.length} Stapel)`),
        inv.ender.length ? h('div', { class: 'srow wrap' }, inv.ender.sort((a, b) => a.slot - b.slot).map((i) => itemTile(i))) : h('div', { class: 'empty' }, 'Leer.')));
    } catch (e) { put(detail, h('div', { class: 'notice err' }, e.message)); }
  }

  function paintList() {
    put(list, d.players.map((p) => h('li', { class: p.uuid === cur ? 'sel' : '', onclick: () => show(p.uuid, p.name, false), tabindex: 0, role: 'button',
      onkeydown: (e) => { if (e.key === 'Enter') show(p.uuid, p.name, false); } },
    window.BH.avatar(p.name || '?'), h('div', { class: 'nm' }, p.name || 'Unbekannt', h('small', {}, p.uuid)), p.name && names.has(p.name) ? h('span', { class: 'chip on' }, 'online') : null)));
  }
  paintList();
  put(main, header('Inventare', `Gespeicherte Spielerdaten der Welt „${d.world}“.`),
    d.players.length ? h('div', { class: 'invlayout' }, h('div', { class: 'card' }, list), detail)
      : h('div', { class: 'card empty' }, 'In dieser Welt gibt es noch keine Spielerdaten. Sie entstehen, sobald jemand beigetreten ist und der Server gespeichert hat.'));
  if (d.players.length) show(d.players[0].uuid, d.players[0].name, false);
}

// ---------- Texturpakete ---------------------------------------------------------------------
async function viewPacks(token) {
  const d = await api('GET', P('/packs'));
  if (token !== getToken()) return;
  const jobsBox = h('div', {});
  const resultBox = h('div', {});
  const upBox = h('div', {});
  const reload = () => window.BH.route();
  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  const copy = (t) => navigator.clipboard && navigator.clipboard.writeText(t).then(() => toast('Kopiert.'));
  const enabledCount = d.packs.filter((p) => p.enabled).length;

  async function doUpload(fileList) {
    let ok = 0;
    for (const f of fileList) {
      if (!/\.zip$/i.test(f.name)) { toast(`„${f.name}“ ist keine ZIP-Datei.`, true); continue; }
      const row = h('div', { class: 'card job' }, h('b', {}, `Lade ${f.name} hoch …`));
      const bar = progressBar(0); row.append(bar); upBox.append(row);
      try {
        const r = await uploadRaw(P('/packs/upload?' + q({ name: f.name })), f, (v) => { bar.firstChild.style.width = Math.round(v * 100) + '%'; });
        ok++;
        if (r.pack.repaired) toast(`„${r.pack.name}“ war falsch verpackt und wurde repariert.`);
      } catch (e) { toast(`${f.name}: ${e.message}`, true); }
      row.remove();
    }
    if (ok) reload();
  }

  const fileInput = h('input', { type: 'file', multiple: true, accept: '.zip,application/zip', style: 'display:none', onchange: () => doUpload([...fileInput.files]) });
  const dropCard = h('div', { class: 'card dropzone' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', {}, h('h2', { style: 'margin:0' }, 'Texturpaket hochladen'),
        h('p', { class: 'muted small', style: 'margin:4px 0 0' }, `ZIP-Dateien hierher ziehen oder auswählen, auch mehrere. Höchstens ${d.maxMb} MB nach dem Zusammenführen.`)),
      h('button', { class: 'primary', onclick: () => fileInput.click() }, 'ZIP auswählen')), fileInput, upBox);
  dropCard.addEventListener('dragover', (e) => { e.preventDefault(); dropCard.classList.add('over'); });
  dropCard.addEventListener('dragleave', () => dropCard.classList.remove('over'));
  dropCard.addEventListener('drop', (e) => { e.preventDefault(); dropCard.classList.remove('over'); if (e.dataTransfer.files.length) doUpload([...e.dataTransfer.files]); });

  const row = (p, i) => {
    const mini = (label, fn, extra = {}) => h('button', { class: 'small', ...extra, onclick: mut(fn) }, label);
    const chips = [];
    if (p.repaired) chips.push(h('span', { class: 'chip warn', title: p.warnings.join('\n') }, 'Verpackung repariert'));
    if (p.problems.length) chips.push(h('span', { class: 'chip warn', title: 'Minecraft würde dieses Paket ignorieren:\n' + p.problems.join('\n') + '\n\nBlockhaus korrigiert das beim Veröffentlichen.' }, 'wird repariert'));
    else if (p.compat === 'too-old') chips.push(h('span', { class: 'chip', title: `Für eine ältere Minecraft-Version gebaut (Server: ${d.expected ? d.expected.mc : '?'}). Minecraft lädt es nach dem Code der 26.3-Version trotzdem, einzelne Texturen können fehlen.` }, 'für ältere Version'));
    return h('li', { class: p.enabled ? '' : 'disabled' },
      window.BH.avatar(p.name),
      h('div', { class: 'nm' }, h('b', {}, p.name), ' ', chips,
        h('small', {}, p.description || '(ohne Beschreibung)'),
        h('small', {}, `${fmtSize(p.size)} · Format ${p.formats} · ${p.enabled ? 'aktiv' : 'aus'}`),
        p.warnings.filter((w) => !/neu verpackt/.test(w)).map((w) => h('small', { class: 'warn-line' }, '⚠ ' + w))),
      h('div', { class: 'acts' },
        mini('▲', async () => { await api('POST', P('/packs/move'), { id: p.id, dir: 'up' }); reload(); }, { disabled: i === 0, 'aria-label': 'Nach oben', title: 'Höhere Priorität' }),
        mini('▼', async () => { await api('POST', P('/packs/move'), { id: p.id, dir: 'down' }); reload(); }, { disabled: i === d.packs.length - 1, 'aria-label': 'Nach unten', title: 'Niedrigere Priorität' }),
        h('label', { class: 'switch', title: p.enabled ? 'Ausschalten' : 'Einschalten' }, h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': 'Aktiv: ' + p.name, onchange: mut(async () => { await api('POST', P('/packs/toggle'), { id: p.id }); reload(); }) }), h('i')),
        h('a', { href: '/api' + P('/packs/download?' + q({ id: p.id })), download: p.name + '.zip' }, h('button', { class: 'small' }, 'Laden')),
        mini('Umbenennen', async () => { const n = prompt('Neuer Name:', p.name); if (!n || n === p.name) return; await api('POST', P('/packs/rename'), { id: p.id, name: n }); reload(); }),
        mini('Löschen', async () => { if (!confirm(`„${p.name}“ löschen?`)) return; await api('POST', P('/packs/delete'), { id: p.id }); reload(); }, { class: 'small danger' })));
  };

  const apply = mut(async () => {
    resultBox.replaceChildren();
    const r = await api('POST', P('/packs/apply'), {});
    const fin = await watchJob(jobsBox, r.job, token);
    if (fin.status !== 'done') return;
    const x = fin.result;
    if (x.cleared) toast('Kein Paket mehr eingetragen.'); else toast(`Veröffentlicht (${x.packs} Paket${x.packs === 1 ? '' : 'e'}, ${fmtSize(x.size)}).`);
    reload();
  });
  const check = mut(async () => {
    resultBox.replaceChildren(h('p', { class: 'muted' }, 'Teste den Download über die öffentliche Adresse …'));
    const r = await api('POST', P('/packs/check'), {});
    const fin = await watchJob(jobsBox, r.job, token);
    const x = fin.result || {};
    put(resultBox, x.ok
      ? h('div', { class: 'notice ok' }, h('span', {}, `Der Download klappt über ${x.url}: ${fmtSize(x.bytes)} in ${(x.ms / 1000).toFixed(1)} s (${x.mbps.toFixed(1)} MBit/s), Prüfsumme stimmt.`))
      : h('div', { class: 'notice err' }, h('span', {}, x.error ? `Von dieser Adresse lässt sich nichts laden: ${x.error}` : 'Die Datei kommt an, aber die Prüfsumme weicht ab. Ein Proxy oder Tunnel verändert die Daten.'),
        h('span', { class: 'small' }, 'Prüfe die Schritte unter „So kommt das Paket zu deinen Freunden“.')));
  });

  const ap = d.applied;
  const addr = d.base.url;
  const port = d.frontPort || 25700;
  const setup = h('details', { class: 'card', open: !ap }, h('summary', {}, h('b', {}, 'So kommt das Paket zu deinen Freunden')),
    h('p', { class: 'muted' }, `Minecraft lädt ein Texturpaket von einer Internet-Adresse, der Server schickt nur die Adresse. Blockhaus liefert die Datei selbst aus, auf Port ${port}. Dieser Port muss über playit erreichbar sein. Dafür gibt es zwei Wege:`),
    h('p', { style: 'margin-bottom:4px' }, h('b', {}, 'Weg A (empfohlen): ein zweiter playit-Tunnel nur für die Pakete')),
    h('ol', {},
      h('li', {}, `Im playit.gg-Dashboard einen weiteren Tunnel anlegen: Typ „Custom TCP“, lokale Adresse 127.0.0.1 (der playit-Agent läuft in Umbrel im Host-Netz), lokaler Port ${port}.`),
      h('li', {}, 'playit zeigt dafür eine Adresse wie abc.at.ply.gg:12345. Trage sie unter ', h('a', { href: '#/settings' }, 'Einstellungen → Texturpakete'), ' als Download-Adresse ein, mit http:// davor.'),
      h('li', {}, 'Unten Pakete hochladen, ordnen und „Veröffentlichen und eintragen“ drücken.'),
      h('li', {}, 'Mit „Von außen testen“ prüft Blockhaus, ob der Download über diese Adresse klappt.')),
    h('p', { class: 'muted small' }, 'Minecraft selbst läuft dabei unverändert über den bisherigen Tunnel. Ein kostenloses playit-Konto hat laut playit.gg 4 Ports: Minecraft, Pakete und der Voice Chat belegen zusammen 3.'),
    h('p', { style: 'margin-bottom:4px' }, h('b', {}, 'Weg B: den Minecraft-Tunnel umlegen')),
    h('p', { class: 'muted small' }, `Im Dashboard den lokalen Port des Minecraft-Tunnels von 25565 auf ${port} ändern und unter Einstellungen die öffentliche Adresse eintragen. Blockhaus nimmt dann alles an, liefert Pakete aus und reicht Minecraft-Verbindungen an ${d.upstream || 'host.docker.internal:25565'} weiter. Fällt Blockhaus aus, kann über playit niemand mehr joinen. Nicht geprüft ist, ob playit Web-Anfragen durch einen Minecraft-Tunnel lässt; „Von außen testen“ zeigt es dir.`));

  // The address that is in server.properties right now but was not put there by "Veröffentlichen".
  const manualUrl = d.current.url && (!ap || !ap.inSync) ? d.current : null;
  const probeBox = h('div', {});
  const probe = mut(async () => {
    put(probeBox, h('p', { class: 'muted' }, 'Lade das Paket von der Adresse und prüfe es …'));
    const r = await api('POST', P('/packs/probe'), {});
    const fin = await watchJob(jobsBox, r.job, token);
    const x = fin.result || {};
    if (x.error) { put(probeBox, h('div', { class: 'notice err' }, h('span', {}, `Von dieser Adresse lässt sich nichts laden: ${x.error}`))); return; }
    put(probeBox,
      x.findings.map((f) => h('div', { class: 'notice ' + (f.level === 'err' ? 'err' : f.level === 'warn' ? 'warn' : 'ok') }, h('span', {}, f.text))),
      h('p', { class: 'muted small' }, [x.size ? fmtSize(x.size) : null, x.sha1 ? 'SHA-1 ' + x.sha1 : null, x.contentType || null, x.description ? 'Beschreibung: ' + x.description : null].filter(Boolean).join(' · ')));
  });
  const importCurrent = mut(async () => {
    const r = await api('POST', P('/packs/import-current'), {});
    const fin = await watchJob(jobsBox, r.job, token);
    if (fin.status !== 'done') return;
    toast(`„${fin.result.pack.name}“ ist jetzt in deiner Liste${fin.result.pack.repaired ? ' (Verpackung repariert)' : ''}. Mit „Veröffentlichen“ liefert Blockhaus es aus.`);
    reload();
  });
  const manual = manualUrl ? h('div', { class: 'card' }, h('h2', {}, 'Von Hand eingetragene Adresse'),
    h('div', { class: 'addr' }, h('code', {}, manualUrl.url), h('button', { class: 'small', onclick: () => copy(manualUrl.url) }, 'Kopieren')),
    h('p', { class: 'muted small' }, `Prüfsumme: ${manualUrl.sha1 ? manualUrl.sha1.slice(0, 12) + '…' : 'keine'} · Pack-ID: ${manualUrl.id || 'nicht gesetzt'}`),
    h('p', { class: 'muted' }, 'Diese Adresse bekommen deine Spieler gerade. Blockhaus liefert dieses Paket nicht aus. „Prüfen“ lädt die Datei von dort und sagt dir, ob Minecraft sie annimmt und warum nicht.'),
    h('div', { class: 'row' }, h('button', { onclick: probe }, 'Adresse prüfen'), h('button', { onclick: importCurrent }, 'In meine Pakete übernehmen')),
    probeBox) : null;

  const status = h('div', { class: 'card' }, h('h2', {}, 'Aktuell eingetragen'),
    !addr ? h('div', { class: 'notice warn' }, h('span', {}, 'Es ist noch keine öffentliche Adresse eingetragen.'), h('a', { href: '#/settings' }, h('button', { class: 'small' }, 'Zu den Einstellungen'))) : null,
    ap ? h('div', {},
      ap.url ? h('div', { class: 'addr' }, h('code', {}, ap.url), h('button', { class: 'small', onclick: () => copy(ap.url) }, 'Kopieren')) : null,
      h('p', { class: 'muted small' }, `${ap.packs.length} Paket${ap.packs.length === 1 ? '' : 'e'} · ${fmtSize(ap.size)} · SHA-1 ${ap.sha1.slice(0, 12)}… · ${fmtDate(ap.at)}${ap.patched ? ' · Format-Angabe repariert' : ''}${ap.overwritten ? ` · ${ap.overwritten} Datei(en) kamen in mehreren Paketen vor, es gilt das obere` : ''}`),
      ap.inSync ? h('p', { class: 'chip on' }, 'steht in der server.properties')
        : h('div', { class: 'notice warn' }, 'In der server.properties steht etwas anderes (z. B. von Hand eingetragen oder die Adresse hat sich geändert). „Veröffentlichen“ trägt es neu ein.'),
      h('div', { class: 'row' }, h('button', { onclick: check, disabled: !addr }, 'Von außen testen'),
        d.running && ap.inSync ? h('span', { class: 'muted small' }, 'Der Server liest die Einstellung erst nach einem Neustart.') : null))
      : h('p', { class: 'muted' }, 'Noch nichts veröffentlicht.'),
    null);

  put(main, header('Texturpakete', 'Pakete hochladen, ordnen und den Spielern direkt von deinem Server anbieten.'),
    jobsBox, resultBox, manual, setup, status, dropCard,
    h('div', { class: 'card' }, h('h2', {}, `Pakete (${d.packs.length})`),
      d.packs.length ? [h('p', { class: 'muted small', style: 'margin-top:-4px' }, 'Reihenfolge wie in Minecraft: Das oberste Paket gewinnt, wenn mehrere dieselbe Textur enthalten. Sprachdateien, Sounds und Atlanten werden zusammengeführt.'),
        h('ul', { class: 'plist' }, d.packs.map(row)),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', onclick: apply, disabled: !addr }, enabledCount ? 'Veröffentlichen und eintragen' : 'Paket entfernen'),
          h('span', { class: 'muted small' }, enabledCount ? `${enabledCount} aktive${enabledCount === 1 ? 's' : ''} Paket${enabledCount === 1 ? '' : 'e'} werden zu einer Datei zusammengefasst.` : 'Alle sind aus: Das Paket wird aus der server.properties entfernt.')),
        d.expected && d.expected.style !== 'minor' ? h('p', { class: 'muted small' }, 'Hinweis: Die automatische Reparatur von Pack-Angaben ist für Minecraft 26.x geprüft. Bei älteren Versionen werden die Pakete unverändert verwendet.') : null]
        : h('div', { class: 'empty' }, 'Noch keine Pakete. Lade oben eine ZIP-Datei hoch.')));
  resumeJobs(jobsBox, token, () => reload());
}

// ---------- Voice Chat -----------------------------------------------------------------------
async function viewVoice(token) {
  const d = await api('GET', P('/voicechat'));
  if (token !== getToken()) return;
  const mut = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  const portIn = h('input', { type: 'number', min: -1, max: 65535, step: 1, value: d.port === null ? '' : d.port, placeholder: '24454', 'aria-label': 'Voice-Chat-Port (UDP)', disabled: !d.config });
  const hostIn = h('input', { type: 'text', value: d.voiceHost || '', placeholder: 'z. B. abc.joinmc.link:12345', 'aria-label': 'voice_host', disabled: !d.config, autocomplete: 'off' });
  const save = mut(async () => {
    const r = await api('POST', P('/voicechat'), { port: portIn.value === '' ? undefined : Number(portIn.value), voice_host: hostIn.value });
    toast(r.restartNeeded ? 'Gespeichert. Gilt nach einem Neustart des Servers.' : 'Gespeichert.');
    window.BH.route();
  });
  const logPort = d.log && d.log.startedPort;
  const live = d.running && logPort !== null && d.port !== null && String(logPort) !== String(d.port);
  const jarText = d.jars.length ? d.jars.map((j) => `${j.folder}/${j.file}${j.enabled ? '' : ' (deaktiviert)'}`).join(', ') : null;
  put(main, header('Voice Chat', 'Simple Voice Chat erreichbar machen, wenn deine Freunde über playit joinen.'),
    d.running ? h('div', { class: 'notice' }, 'Änderungen am Voice Chat gelten erst nach einem Neustart des Servers.') : null,
    h('div', { class: 'card' }, h('h2', {}, 'Stand auf deinem Server'),
      h('div', { class: 'facts' }, [
        ['Mod/Plugin', jarText || 'nicht gefunden (mods/ oder plugins/)'],
        ['Konfiguration', d.config || 'noch nicht vorhanden'],
        ['Port (UDP)', d.port === null ? '–' : (d.port === '-1' ? '-1 (wie Minecraft)' : d.port)],
        ['voice_host', d.config ? (d.voiceHost || 'leer') : '–'],
        ['Laut Server-Log', logPort ? `lauscht auf UDP ${logPort}` : 'noch kein Start des Voice Chats zu sehen'],
      ].map(([k, v]) => h('div', {}, h('span', { class: 'k' }, k), String(v)))),
      !d.jars.length ? h('div', { class: 'notice warn' }, h('span', {}, 'Es liegt kein Voice-Chat-Mod und kein Plugin im Server. Installiere „Simple Voice Chat“ unter Mods & Plugins.'), h('a', { href: '#/mods' }, h('button', { class: 'small' }, 'Zu Mods & Plugins'))) : null,
      d.jars.length && !d.config ? h('div', { class: 'notice warn' }, 'Die Konfigurationsdatei legt der Mod beim ersten Start an. Starte den Server einmal und öffne diese Seite danach wieder.') : null,
      live ? h('div', { class: 'notice warn' }, `Der laufende Server nutzt noch den Port ${logPort}, in der Datei steht ${d.port}. Nach einem Neustart gilt die Datei.`) : null),
    h('div', { class: 'card' }, h('h2', {}, 'Warum „kann nicht verbinden“ kommt'),
      h('p', { class: 'muted' }, 'Der Voice Chat läuft nicht über die normale Minecraft-Verbindung, sondern über eine eigene UDP-Verbindung zu einem eigenen Port. Dein Minecraft-Tunnel in playit leitet nur TCP weiter. Damit der Ton ankommt, braucht es drei Dinge:'),
      h('ol', {},
        h('li', {}, h('b', {}, 'Ein Port, den Crafty nach außen freigibt. '), `Der Voice Chat öffnet seinen Port im Crafty-Container (bei dir laut Log ${logPort || '24454'}/UDP). Das Crafty-Paket im Denny-Store (GitHub, Stand Oktober 2026) gibt nur TCP 25500–25600 und UDP 19132 frei, UDP ${logPort || 24454} also nicht. Nimm darum Port ${d.suggestedPort}: Er ist für Bedrock reserviert und frei, solange du keinen Bedrock-Server betreibst. Wie deine Installation wirklich aussieht, habe ich nicht gesehen.`),
        h('li', {}, h('b', {}, 'Ein UDP-Tunnel in playit. '), `Neuen Tunnel anlegen, Protokoll „MC: Simple Voice Chat“ (UDP), lokale Adresse 127.0.0.1, lokaler Port derselbe wie oben (${d.suggestedPort}). playit zeigt dir dann eine öffentliche Adresse mit Port.`),
        h('li', {}, h('b', {}, 'Diese Adresse bei voice_host. '), 'Ohne voice_host sagt der Server den Spielern „nimm die Minecraft-Adresse“, und dort gibt es keinen UDP-Port. Trage die playit-Adresse unten ein, speichere und starte den Server neu.')),
      h('p', { class: 'muted small' }, 'Jeder Spieler braucht den Voice-Chat-Mod ebenfalls, in einer zum Server passenden Version. Im Spiel zeigt ein Symbol oben links, ob die Verbindung steht.')),
    h('div', { class: 'card' }, h('h2', {}, 'Einstellen'),
      h('label', { class: 'f' }, h('span', {}, 'Port (UDP)'), h('div', { class: 'row' }, h('div', { class: 'grow' }, portIn), h('button', { class: 'small', disabled: !d.config, onclick: () => { portIn.value = d.suggestedPort; } }, `${d.suggestedPort} einsetzen`)),
        h('small', {}, `Standard des Mods ist 24454. -1 würde den Minecraft-Port (${d.mcPort}) auch für UDP nutzen; den gibt Crafty nur für TCP frei.`)),
      h('label', { class: 'f' }, h('span', {}, 'voice_host (Adresse des playit-UDP-Tunnels)'), hostIn,
        h('small', {}, 'Form: adresse:port, ohne http://. Leer lassen, wenn der Voice Chat nur im Heimnetz laufen soll.')),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save, disabled: !d.config }, 'Speichern')),
      d.config ? h('p', { class: 'muted small' }, `Geändert wird nur ${d.config}; die vorige Fassung bleibt als .blockhaus.bak daneben liegen.`) : null));
}

window.BHViews = { files: viewFiles, worlds: viewWorlds, backups: viewBackups, software: viewSoftware, mods: viewMods, inventory: viewInventory, packs: viewPacks, voice: viewVoice };
})();
