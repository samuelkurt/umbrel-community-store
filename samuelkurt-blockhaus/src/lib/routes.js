'use strict';
// API routes for files, worlds, backups, software, mods, inventories. Called from server.js with a context.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const files = require('./files');
const worlds = require('./worlds');
const software = require('./software');
const mods = require('./mods');
const inventory = require('./inventory');
const packs = require('./packs');
const serverfiles = require('./serverfiles');
const props = require('./props');
const state = require('./state');
const { writeFileKeepOwner } = require('./fsutil');

const LEVEL_TYPES = ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'];

function jobView(j) {
  return { id: j.id, type: j.type, title: j.title, status: j.status, message: j.message, progress: j.progress, error: j.error, result: j.result, started: j.started, ended: j.ended };
}

/**
 * @param {object} c context: { req, res, url, method, rest, server, dir(), crafty, jobs, backups, dataDir,
 *                              send, readJson, HttpError, readProps(dir) }
 * @returns {Promise<boolean>} true if the request was handled
 */
async function handle(c) {
  const { req, res, url, method: m, rest, server, crafty, jobs, backups, send, readJson, HttpError } = c;
  const q = (k) => url.searchParams.get(k);
  let r;

  // ---- helpers ----
  const stats = () => crafty.stats(server.server_id);
  const isRunning = async () => !!(await stats()).running;
  async function requireStopped() {
    if (await isRunning()) throw new HttpError(409, 'Der Server läuft. Stoppe ihn zuerst auf der Server-Seite.');
  }
  const sendCommand = (cmd) => crafty.stdin(server.server_id, cmd);
  function activeWorld(dir) {
    const { parsed } = c.readProps(dir);
    return parsed.values['level-name'] || 'world';
  }
  function setProps(dir, changes) {
    const { file, parsed, exists } = c.readProps(dir);
    const out = props.apply(parsed, changes);
    if (exists) writeFileKeepOwner(file + '.blockhaus.bak', fs.readFileSync(file));
    writeFileKeepOwner(file, out);
  }
  async function installedInfo(dir) {
    const st = software.readInstalled(dir);
    if (st) return st;
    const s = await stats();
    return { software: state.guessSoftware(server.executable, server.execution_command).toLowerCase().replace('unbekannt', ''), version: s.version || null, build: null, guessed: true };
  }
  function requireUploadHeaders() {
    if (req.headers['x-blockhaus'] !== '1' || !/^application\/octet-stream\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new HttpError(415, 'Upload nur mit Content-Type application/octet-stream und Header X-Blockhaus erlaubt.');
    }
  }
  const wrapFs = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e && e.status && !(e instanceof HttpError)) throw new HttpError(e.status, e.message);
      throw e;
    }
  };

  // ---- jobs ----
  if (m === 'GET' && rest === 'jobs') return send(res, 200, { jobs: jobs.active(server.server_id).map(jobView) }), true;
  if (m === 'GET' && (r = /^jobs\/([0-9a-f]{12})$/.exec(rest))) {
    const j = jobs.get(r[1]);
    if (!j || j.serverId !== String(server.server_id)) throw new HttpError(404, 'Aufgabe nicht gefunden.');
    return send(res, 200, jobView(j)), true;
  }

  // ---- files ----
  if (rest === 'files' || rest.startsWith('files/')) {
    const dir = c.dir();
    if (m === 'GET' && rest === 'files') return send(res, 200, await wrapFs(async () => files.list(dir, q('path') || ''))), true;
    if (m === 'GET' && rest === 'files/read') return send(res, 200, await wrapFs(async () => files.readText(dir, q('path')))), true;
    if (m === 'PUT' && rest === 'files/write') {
      const b = await readJson(req, 2 * 1024 * 1024);
      await wrapFs(async () => files.writeText(dir, b.path, b.text));
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && rest === 'files/mkdir') { const b = await readJson(req); await wrapFs(async () => files.mkdir(dir, b.path)); return send(res, 200, { ok: true }), true; }
    if (m === 'POST' && rest === 'files/delete') { const b = await readJson(req); await wrapFs(() => files.remove(dir, b.path)); return send(res, 200, { ok: true }), true; }
    if (m === 'POST' && rest === 'files/rename') { const b = await readJson(req); await wrapFs(async () => files.rename(dir, b.from, b.to)); return send(res, 200, { ok: true }), true; }
    if (m === 'GET' && rest === 'files/download') {
      const info = await wrapFs(async () => files.downloadInfo(dir, q('path')));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      });
      await new Promise((resolve) => fs.createReadStream(info.abs).on('error', () => { res.destroy(); resolve(); }).on('end', resolve).pipe(res));
      return true;
    }
    if (m === 'PUT' && rest === 'files/upload') {
      requireUploadHeaders();
      const r2 = await wrapFs(() => files.upload(dir, q('path') || '', q('name'), req, { overwrite: q('overwrite') === '1' }));
      return send(res, 200, { ok: true, ...r2 }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  // ---- worlds ----
  if (rest === 'worlds' || rest.startsWith('worlds/')) {
    const dir = c.dir();
    if (m === 'GET' && rest === 'worlds') {
      const active = activeWorld(dir);
      const { parsed } = c.readProps(dir);
      return send(res, 200, {
        worlds: await wrapFs(() => worlds.listWorlds(dir, active)), active, running: await isRunning(),
        seed: parsed.values['level-seed'] || '', levelType: parsed.values['level-type'] || 'minecraft:normal',
      }), true;
    }
    if (m === 'POST' && rest === 'worlds/new') {
      await requireStopped();
      const b = await readJson(req);
      const name = await wrapFs(async () => worlds.checkName(b.name));
      if (fs.existsSync(path.join(dir, name))) throw new HttpError(409, `Einen Ordner „${name}“ gibt es schon. Wähle einen anderen Namen oder aktiviere die vorhandene Welt.`);
      const seed = String(b.seed === undefined || b.seed === null ? '' : b.seed);
      if (/[\r\n]/.test(seed) || seed.length > 100) throw new HttpError(400, 'Ungültiger Seed.');
      const type = b.levelType || 'minecraft:normal';
      if (!LEVEL_TYPES.includes(type)) throw new HttpError(400, 'Unbekannter Welttyp.');
      setProps(dir, { 'level-name': name, 'level-seed': seed, 'level-type': type, 'generate-structures': b.structures === false ? 'false' : 'true' });
      return send(res, 200, { ok: true, note: `Die Welt „${name}“ wird beim nächsten Start des Servers erzeugt.` }), true;
    }
    if (m === 'POST' && rest === 'worlds/activate') {
      await requireStopped();
      const b = await readJson(req);
      const name = await wrapFs(async () => worlds.checkName(b.name));
      if (!fs.existsSync(path.join(dir, name, 'level.dat'))) throw new HttpError(404, 'Diese Welt gibt es nicht.');
      setProps(dir, { 'level-name': name });
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && rest === 'worlds/delete') {
      await requireStopped();
      const b = await readJson(req);
      if (b.name === activeWorld(dir)) throw new HttpError(409, 'Das ist die aktive Welt. Aktiviere zuerst eine andere oder lege eine neue an.');
      await wrapFs(() => worlds.deleteWorld(dir, b.name));
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'GET' && rest === 'worlds/download') {
      const name = q('name');
      await wrapFs(async () => worlds.checkName(name));
      if (!fs.existsSync(path.join(dir, name, 'level.dat'))) throw new HttpError(404, 'Diese Welt gibt es nicht.');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.zip')}` });
      try { await worlds.streamWorldZip(dir, name, res); } catch (e) { console.error('World zip failed:', e.message); res.destroy(); }
      return true;
    }
    if (m === 'PUT' && rest === 'worlds/upload') {
      requireUploadHeaders();
      await requireStopped();
      const name = await wrapFs(async () => worlds.checkName(q('name')));
      if (fs.existsSync(path.join(dir, name))) throw new HttpError(409, `Einen Ordner „${name}“ gibt es schon. Wähle einen anderen Namen.`);
      const tmpDir = path.join(c.dataDir, 'tmp');
      await fsp.mkdir(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, 'upload-' + crypto.randomBytes(6).toString('hex') + '.zip');
      try { await wrapFs(() => files.upload(tmpDir, '', path.basename(tmp), req, { overwrite: true })); }
      catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
      const activate = q('activate') === '1';
      const job = jobs.start('world-import', server.server_id, async (j) => {
        j.title = `Welt „${name}“ importieren`;
        try {
          const rr = await worlds.importWorldZip(dir, tmp, name, { onFile: (n) => { j.message = 'Entpacke ' + n; } });
          if (activate) setProps(dir, { 'level-name': name });
          return { name, files: rr.files, seed: rr.level.seed, version: rr.level.version, activated: activate };
        } finally { await fsp.rm(tmp, { force: true }); }
      });
      job.title = `Welt „${name}“ importieren`;
      return send(res, 202, { job: jobView(job) }), true;
    }
    if (m === 'POST' && rest === 'worlds/seed-live') {
      if (!(await isRunning())) throw new HttpError(409, 'Der Server läuft nicht.');
      const text = await serverfiles.ask({ dir, send: sendCommand, command: 'seed', until: /Seed: \[?-?\d+\]?/ });
      const mm = /Seed: \[?(-?\d+)\]?/.exec(text);
      return send(res, 200, { seed: mm ? mm[1] : null }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  // ---- backups ----
  if (rest === 'backups' || rest.startsWith('backups/')) {
    const dir = c.dir();
    const id = String(server.server_id);
    if (m === 'GET' && rest === 'backups') return send(res, 200, { items: backups.list(id), running: await isRunning() }), true;
    if (m === 'POST' && rest === 'backups') {
      const b = await readJson(req);
      const running = await isRunning();
      const s = await stats();
      const job = jobs.start('backup', id, (j) => backups.create({ serverId: id, serverDir: dir, kind: b.kind === 'full' ? 'full' : 'worlds', note: String(b.note || '').slice(0, 200), running, sendCommand, job: j, version: s.version || '' }));
      job.title = 'Backup erstellen';
      return send(res, 202, { job: jobView(job) }), true;
    }
    if (m === 'POST' && rest === 'backups/restore') {
      await requireStopped();
      const b = await readJson(req);
      const s = await stats();
      await wrapFs(async () => backups.file(id, b.id));
      const job = jobs.start('restore', id, (j) => backups.restore({ serverId: id, serverDir: dir, id: b.id, job: j, version: s.version || '' }));
      job.title = 'Backup wiederherstellen';
      return send(res, 202, { job: jobView(job) }), true;
    }
    if (m === 'POST' && rest === 'backups/delete') {
      const b = await readJson(req);
      await wrapFs(() => backups.remove(id, b.id));
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'GET' && rest === 'backups/download') {
      const f = await wrapFs(async () => backups.file(id, q('id')));
      const size = fs.statSync(f).size;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}` });
      await new Promise((resolve) => fs.createReadStream(f).on('error', () => { res.destroy(); resolve(); }).on('end', resolve).pipe(res));
      return true;
    }
    if (m === 'POST' && rest === 'backups/crafty') {
      await readJson(req);
      await crafty.action(server.server_id, 'backup_server');
      return send(res, 200, { ok: true }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  // ---- software ----
  if (rest === 'software' || rest.startsWith('software/')) {
    const dir = c.dir();
    if (m === 'GET' && rest === 'software') {
      return send(res, 200, { kinds: software.KINDS, installed: await installedInfo(dir), running: await isRunning(), jar: software.jarNameOf(server) }), true;
    }
    if (m === 'GET' && rest === 'software/resolve') {
      try {
        const x = await software.resolve(q('kind'), q('version'));
        return send(res, 200, { type: x.type, mc: x.mc, build: x.build || null, java: x.java, checksum: Object.keys(x.checksum).filter((k) => x.checksum[k]) }), true;
      } catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw new HttpError(502, 'Auflösen fehlgeschlagen: ' + e.message); }
    }
    if (m === 'GET' && rest === 'software/versions') {
      const kind = q('kind');
      const info = software.kindInfo(kind);
      if (!info || info.unsupported) throw new HttpError(400, info ? info.info : 'Unbekannte Software.');
      try { return send(res, 200, { versions: await software.listVersions(kind) }), true; }
      catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw new HttpError(502, 'Die Versionsliste konnte nicht geladen werden: ' + e.message); }
    }
    if (m === 'POST' && rest === 'software/install') {
      const b = await readJson(req);
      const info = software.kindInfo(b.kind);
      if (!info || info.unsupported) throw new HttpError(400, info ? info.info : 'Unbekannte Software.');
      const stopFirst = b.stopFirst === true;
      const startAfter = b.startAfter === true;
      if (!stopFirst) await requireStopped();
      const id = String(server.server_id);
      const s = await stats();
      const install = c.installFn || software.install;
      const poll = c.pollMs || 1500;
      const job = jobs.start('software', id, async (j) => {
        j.title = `${info.label} ${b.version} installieren`;
        if (await isRunning()) {
          // Only reachable with stopFirst: a running server cannot have its jar replaced.
          j.message = 'Stoppe den Server …';
          await crafty.action(id, 'stop_server');
          const t0 = Date.now();
          while (await isRunning()) {
            if (Date.now() - t0 > 180000) throw new Error('Der Server hat sich nach 3 Minuten nicht beendet. Stoppe ihn in Crafty von Hand und versuche es dann noch einmal.');
            await new Promise((r2) => setTimeout(r2, poll));
          }
        }
        try {
          if (b.backup !== false) {
            const ws = await worlds.listWorlds(dir, null);
            if (ws.length) {
              j.message = 'Backup der Welten vor dem Wechsel …';
              await backups.create({ serverId: id, serverDir: dir, kind: 'worlds', note: `Automatisch vor Wechsel auf ${info.label} ${b.version}`, running: false, job: j, version: s.version || '' });
            }
          }
          const res2 = await install({ dir, server, kind: b.kind, version: String(b.version), job: j });
          if (startAfter) { j.message = 'Starte den Server …'; await crafty.action(id, 'start_server'); }
          return { ...res2, started: startAfter };
        } catch (e) {
          if (s.running) e.message += ' Der Server wurde dafür gestoppt und läuft jetzt nicht. Starte ihn auf der Server-Seite.';
          throw e;
        }
      });
      job.title = `${info.label} ${b.version} installieren`;
      return send(res, 202, { job: jobView(job) }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  // ---- mods / plugins ----
  if (rest === 'mods' || rest.startsWith('mods/')) {
    const dir = c.dir();
    const inst = await installedInfo(dir);
    const lay = mods.layout(dir, inst);
    const mcVersion = inst.version || (await stats()).version || null;
    if (m === 'GET' && rest === 'mods') return send(res, 200, { ...(await mods.list(dir, inst)), mcVersion, running: await isRunning() }), true;
    if (m === 'POST' && rest === 'mods/toggle') { const b = await readJson(req); const to = await wrapFs(async () => mods.toggle(dir, lay, b.file)); return send(res, 200, { ok: true, file: to }), true; }
    if (m === 'POST' && rest === 'mods/delete') { const b = await readJson(req); await wrapFs(() => mods.remove(dir, lay, b.file)); return send(res, 200, { ok: true }), true; }
    if (m === 'PUT' && rest === 'mods/upload') {
      requireUploadHeaders();
      if (!lay.folder) throw new HttpError(400, lay.reason);
      const name = String(q('name') || '');
      if (!mods.FILE_RE.test(name) || !/\.jar$/i.test(name)) throw new HttpError(400, 'Nur .jar-Dateien mit einfachem Namen sind erlaubt.');
      const fdir = path.join(dir, lay.folder);
      if (!fs.existsSync(fdir)) { fs.mkdirSync(fdir); require('./fsutil').chownLike(dir)(fdir); }
      const r2 = await wrapFs(() => files.upload(fdir, '', name, req, { overwrite: q('overwrite') === '1', maxBytes: 512 * 1024 * 1024 }));
      return send(res, 200, { ok: true, ...r2 }), true;
    }
    if (m === 'GET' && rest === 'mods/search') {
      try { return send(res, 200, await mods.search(lay, mcVersion, { query: q('q') || '', offset: q('offset') || 0 })), true; }
      catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw new HttpError(502, 'Modrinth ist nicht erreichbar: ' + e.message); }
    }
    if (m === 'POST' && rest === 'mods/install') {
      const b = await readJson(req);
      if (!/^[A-Za-z0-9]{8}$|^[\w-]{2,64}$/.test(String(b.project || ''))) throw new HttpError(400, 'Ungültiges Projekt.');
      const job = jobs.start('mod-install', server.server_id, async (j) => {
        j.title = 'Von Modrinth installieren';
        const written = await mods.installFromModrinth({ dir, lay, mcVersion, project: b.project, job: j });
        return { files: written };
      });
      job.title = 'Von Modrinth installieren';
      return send(res, 202, { job: jobView(job) }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  // ---- inventories ----
  if (rest === 'inventory/players' && m === 'GET') {
    const dir = c.dir();
    const world = activeWorld(dir);
    const s = await stats();
    return send(res, 200, { world, players: inventory.listPlayers(dir, world), online: state.parsePlayers(s.players), running: !!s.running }), true;
  }
  if (rest === 'inventory/live' && m === 'POST') {
    const dir = c.dir();
    if (!(await isRunning())) throw new HttpError(409, 'Der Server läuft nicht. Gespeicherte Daten gibt es in der Spielerliste.');
    const b = await readJson(req);
    try { return send(res, 200, await inventory.liveInventory({ dir, name: String(b.name || ''), sendCommand })), true; }
    catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw e; }
  }
  if (m === 'GET' && (r = /^inventory\/([0-9a-fA-F-]{36})$/.exec(rest))) {
    const dir = c.dir();
    try { return send(res, 200, inventory.readInventory(dir, activeWorld(dir), r[1])), true; }
    catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw e; }
  }

  // ---- texture packs ----
  if (rest === 'packs' || rest.startsWith('packs/')) {
    const dir = c.dir();
    const sid = String(server.server_id);
    const cfg = c.cfg ? c.cfg() : {};
    const baseUrl = () => {
      let b = String(cfg.packBaseUrl || '').trim();
      let source = b ? 'packBaseUrl' : null;
      if (!b && cfg.publicAddress) { b = String(cfg.publicAddress).trim(); source = 'publicAddress'; }
      if (!b) return { url: '', source: null };
      if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
      return { url: b.replace(/\/+$/, ''), source };
    };
    const expectedFormat = async () => {
      const f = await packs.serverPackFormat(path.join(dir, software.jarNameOf(server)));
      return f ? { ...f, text: packs.describeFormats({ pack_format: f.format[1] ? f.format : f.format[0] }) } : null;
    };
    if (m === 'GET' && rest === 'packs') {
      const expected = await expectedFormat();
      const l = packs.list(c.dataDir, sid, expected);
      const base = baseUrl();
      const { parsed } = c.readProps(dir);
      const cur = { url: parsed.values['resource-pack'] || '', sha1: parsed.values['resource-pack-sha1'] || '', id: parsed.values['resource-pack-id'] || '' };
      let applied = null;
      if (l.applied) {
        const url = base.url ? `${base.url}/p/${l.applied.file}` : null;
        applied = { ...l.applied, url, inSync: !!url && cur.url === url && cur.sha1 === l.applied.sha1 };
      }
      return send(res, 200, {
        packs: l.packs, applied, expected: expected && { format: expected.format, text: expected.text, mc: expected.mc, style: expected.style },
        base, current: cur, running: await isRunning(), frontPort: c.packPort || null, upstream: cfg.packUpstream || '', maxMb: Math.round(packs.MAX_PACK / 1048576),
      }), true;
    }
    if (m === 'PUT' && rest === 'packs/upload') {
      requireUploadHeaders();
      const entry = await wrapFs(() => packs.addPack(c.dataDir, sid, req, String(q('name') || '')));
      return send(res, 200, { ok: true, pack: entry }), true;
    }
    if (m === 'POST' && rest === 'packs/move') { const b = await readJson(req); await wrapFs(async () => packs.move(c.dataDir, sid, String(b.id), b.dir === 'up' ? 'up' : 'down')); return send(res, 200, { ok: true }), true; }
    if (m === 'POST' && rest === 'packs/toggle') { const b = await readJson(req); const enabled = await wrapFs(async () => packs.toggle(c.dataDir, sid, String(b.id))); return send(res, 200, { ok: true, enabled }), true; }
    if (m === 'POST' && rest === 'packs/rename') { const b = await readJson(req); await wrapFs(async () => packs.rename(c.dataDir, sid, String(b.id), b.name)); return send(res, 200, { ok: true }), true; }
    if (m === 'POST' && rest === 'packs/delete') { const b = await readJson(req); await wrapFs(async () => packs.remove(c.dataDir, sid, String(b.id))); return send(res, 200, { ok: true }), true; }
    if (m === 'GET' && rest === 'packs/download') {
      const x = await wrapFs(async () => packs.libFile(c.dataDir, sid, String(q('id') || '')));
      const st = fs.statSync(x.file);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(x.name + '.zip')}` });
      await new Promise((resolve) => fs.createReadStream(x.file).on('error', () => { res.destroy(); resolve(); }).on('end', resolve).pipe(res));
      return true;
    }
    if (m === 'POST' && rest === 'packs/apply') {
      const b = await readJson(req);
      const base = baseUrl();
      if (!base.url) throw new HttpError(400, 'Trage zuerst unter Einstellungen die öffentliche Adresse ein (die Adresse, über die deine Freunde joinen, z. B. von playit.gg). Daraus entsteht die Download-Adresse des Pakets.');
      const expected = await expectedFormat();
      if (b.patch && !expected) throw new HttpError(400, 'Die Format-Anpassung braucht eine bekannte Server-Version. Die Version dieses Servers konnte nicht aus der Server-Datei gelesen werden.');
      const running = await isRunning();
      const job = jobs.start('packs', sid, async (j) => {
        j.title = 'Texturpaket veröffentlichen';
        const ap = await packs.build(c.dataDir, sid, { patch: !!b.patch, expected, job: j });
        if (!ap) {
          setProps(dir, { 'resource-pack': '', 'resource-pack-sha1': '', 'resource-pack-id': '' });
          return { cleared: true, restartNeeded: running };
        }
        const url = `${base.url}/p/${ap.file}`;
        setProps(dir, { 'resource-pack': url, 'resource-pack-sha1': ap.sha1, 'resource-pack-id': ap.id });
        return { url, sha1: ap.sha1, size: ap.size, packs: ap.packs.length, merged: ap.merged, overwritten: ap.overwritten, patched: ap.patched, restartNeeded: running };
      });
      job.title = 'Texturpaket veröffentlichen';
      return send(res, 202, { job: jobView(job) }), true;
    }
    if (m === 'POST' && rest === 'packs/check') {
      const base = baseUrl();
      const ap = packs.readIndex(c.dataDir, sid).applied;
      if (!ap) throw new HttpError(409, 'Es ist noch kein Paket veröffentlicht.');
      if (!base.url) throw new HttpError(400, 'Keine öffentliche Adresse eingetragen.');
      const url = `${base.url}/p/${ap.file}`;
      const job = jobs.start('packs-check', sid, async (j) => {
        j.title = 'Download von außen testen';
        j.message = `Lade ${url} …`;
        try { return { url, ...(await packs.checkUrl(url, ap.sha1)) }; } catch (e) { return { url, ok: false, error: e.message }; }
      });
      job.title = 'Download von außen testen';
      return send(res, 202, { job: jobView(job) }), true;
    }
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  return false;
}

module.exports = { handle, jobView };
