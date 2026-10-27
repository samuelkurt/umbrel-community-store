'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { Config } = require('./lib/config');
const { Crafty, CraftyError } = require('./lib/crafty');
const props = require('./lib/props');
const players = require('./lib/players');
const files = require('./lib/serverfiles');
const state = require('./lib/state');
const { writeFileKeepOwner } = require('./lib/fsutil');
const { request } = require('./lib/http');
const { Jobs } = require('./lib/jobs');
const { Backups } = require('./lib/backups');
const routes = require('./lib/routes');
const { hashUrl } = require('./lib/download');
const software = require('./lib/software');
const packs = require('./lib/packs');
const { createPackFront } = require('./lib/packserver');
const { Local, LocalError } = require('./lib/local');
const { Anticheat } = require('./lib/anticheat');
const javaLib = require('./lib/java');
const { Auth, sameOrigin } = require('./lib/auth');
const { HostStats } = require('./lib/hoststats');
const { Terminals } = require('./lib/terminal');
const ws = require('./lib/websocket');

const VERSION = '0.8.2';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) return reject(new HttpError(415, 'Nur application/json erlaubt.'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Anfrage zu groß.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createApp({ dataDir, serversDir, publicDir = path.join(__dirname, 'public'), lookup = players.mojangLookup, settleMs = 800, softwareInstall = software.install,
  mode = process.env.BLOCKHAUS_MODE === 'local' ? 'local' : 'crafty', mcPort = Number(process.env.MC_PORT) || 25665, localOpts = {},
  // Dedicated-server mode (BLOCKHAUS_HOST=1): own login + "Leistung" (computer performance) + "Terminal" (shell). Off on Umbrel, where
  // Umbrel's login sits in front of the app and a shell inside the container would be of no use.
  hostTools = process.env.BLOCKHAUS_HOST === '1', terminalOpts = {}, hostOpts = {}, anticheatOpts = {}, authClock } = {}) {
  const config = new Config(dataDir);
  const authOn = hostTools || process.env.BLOCKHAUS_AUTH === '1';
  const auth = authOn ? new Auth(dataDir, authClock ? { now: authClock } : {}) : null;
  const terminals = hostTools ? new Terminals(terminalOpts) : null;
  // "local": Blockhaus runs Minecraft itself (Local has the same methods as the Crafty client). "crafty": talk to Crafty.
  const local = mode === 'local' ? new Local({ dataDir, serversDir, port: mcPort, ...localOpts }) : null;
  const crafty = local || new Crafty(() => config.get());
  const anticheat = local ? new Anticheat({ dataDir, local, ...anticheatOpts }).start() : null;
  const hostStats = hostTools ? new HostStats({ minecraft: () => (local ? local.runtimePids() : []), paths: [serversDir, dataDir], ...hostOpts }) : null;
  const isSecure = (req) => !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  // ---- helpers --------------------------------------------------------------------------
  const jobs = new Jobs();
  const backups = new Backups(dataDir);
  const listServers = () => crafty.servers();
  async function getServer(id) {
    const list = await listServers();
    const s = list.find((x) => String(x.server_id) === String(id));
    if (!s) throw new HttpError(404, local ? 'Diesen Server gibt es nicht.' : 'Diesen Server gibt es in Crafty nicht.');
    return s;
  }
  function dirFor(server) {
    const dir = files.resolveDir(serversDir, server);
    if (!dir) {
      throw new HttpError(500, `Der Ordner von „${server.server_name}“ ist hier nicht eingehängt ` +
        `(Crafty-Pfad ${server.path}, gesucht unter ${serversDir}). Prüfe die Volumes in der docker-compose.yml.`);
    }
    return dir;
  }
  function readProps(dir) {
    const file = path.join(dir, 'server.properties');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { file, parsed: props.parse(''), exists: false };
      throw e;
    }
    return { file, parsed: props.parse(text), exists: true };
  }
  function logTail(dir) {
    try { return files.readLog(dir, 'latest.log', 64 * 1024); } catch { return ''; }
  }
  function validKey(list, raw) {
    try { return players.normalizeKey(list, raw); }
    catch (e) { throw new HttpError(400, e.message); }
  }
  const isTrue = (v, def) => (v === undefined ? def : String(v).toLowerCase() === 'true');

  async function statusOf(server) {
    const stats = await crafty.stats(server.server_id);
    let dir = null;
    try { dir = dirFor(server); } catch { /* status works without file access */ }
    // Local tracks the process itself, so its state does not depend on a log file that may still be the previous run's.
    const st = stats.blockhausState || state.deriveState(stats, dir ? logTail(dir) : '');
    const cfg = config.get();
    const names = state.parsePlayers(stats.players);
    const inst = dir ? software.readInstalled(dir) : null;
    const kindLabel = inst && software.kindInfo(inst.software) ? software.kindInfo(inst.software).label : null;
    return {
      id: server.server_id,
      name: server.server_name,
      state: st,
      running: !!stats.running,
      players: names,
      online: Number(stats.online) || names.length,
      max: Number(stats.max) || 0,
      version: (stats.running && stats.version) || (inst && inst.version) || stats.version || '',
      software: kindLabel || state.guessSoftware(server.executable, server.execution_command),
      softwareBuild: inst && inst.build ? inst.build : null,
      jar: server.executable || '',
      memoryMb: server.memory_mb || state.parseMaxMemoryMb(server.execution_command),
      port: stats.server_port || server.server_port || 25565,
      cpu: Number(stats.cpu) || 0,
      memUsed: stats.mem || '',
      memPercent: Number(stats.mem_percent) || 0,
      worldName: stats.world_name || '',
      worldSize: stats.world_size || '',
      motd: stats.desc || '',
      filesAvailable: !!dir,
      publicAddress: cfg.publicAddress,
      localAddress: cfg.localAddress,
      ...(local ? { notice: stats.notice || '', eulaOk: !!stats.eula_ok, autostart: !!server.autostart, javaMajor: server.java_major || null, startedAt: stats.startedAt || 0 } : {}),
    };
  }

  function configView() {
    const v = { ...config.publicView(), appVersion: VERSION, mode, packPort: Number(process.env.PACK_PORT) || 25700 };
    v.host = hostTools;
    if (local) Object.assign(v, { configured: true, mcPort: local.port, packUpstream: `127.0.0.1:${local.port}`, voicePort: 24454 });
    return v;
  }

  // ---- standalone mode: server list, creating and taking over servers ---------------------------------
  async function localApi(req, res, m, p) {
    if (m === 'GET' && p === '/local/info') {
      return send(res, 200, { port: local.port, serversDir: process.env.SERVERS_HOST_PATH || '', javaInstalled: javaLib.installed(dataDir), javaChoices: [8, 11, 17, 21, 25], candidates: await local.candidates() });
    }
    if (m === 'GET' && p === '/local/candidates') return send(res, 200, { candidates: await local.candidates() });
    if (m === 'GET' && p === '/local/software') return send(res, 200, { kinds: software.KINDS });
    if (m === 'GET' && p === '/local/software/versions') {
      const kind = new URL(req.url, 'http://x').searchParams.get('kind');
      const info = software.kindInfo(kind);
      if (!info || info.unsupported) throw new HttpError(400, info ? info.info : 'Unbekannte Software.');
      try { return send(res, 200, { versions: await software.listVersions(kind) }); }
      catch (e) { throw new HttpError(502, 'Die Versionsliste konnte nicht geladen werden: ' + e.message); }
    }
    let r;
    if (m === 'GET' && (r = /^\/local\/jobs\/([0-9a-f]+)$/.exec(p))) {
      const j = jobs.get(r[1]);
      if (!j) throw new HttpError(404, 'Diese Aufgabe gibt es nicht (mehr).');
      return send(res, 200, routes.jobView(j));
    }
    if (m === 'POST' && p === '/local/servers') {
      const b = await readJson(req);
      const info = software.kindInfo(b.kind);
      if (!info || info.unsupported) throw new HttpError(400, info ? info.info : 'Bitte wähle eine Software.');
      if (!b.version || typeof b.version !== 'string') throw new HttpError(400, 'Bitte wähle eine Version.');
      const created = local.create({ name: b.name, memoryMb: b.memoryMb === undefined ? 2048 : b.memoryMb });
      let job;
      try {
        job = jobs.start('software', created.server_id, async (j) => {
          j.title = `${info.label} ${b.version} installieren`;
          try {
            const res2 = await softwareInstall({ dir: dirFor(created), server: created, kind: b.kind, version: b.version, job: j });
            local.keep(created.server_id);
            return { ...res2, serverId: created.server_id };
          } catch (e) { await local.discard(created.server_id); throw e; }
        });
      } catch (e) { await local.discard(created.server_id); throw e; }
      job.title = `${info.label} ${b.version} installieren`;
      return send(res, 202, { server: { id: created.server_id, name: created.server_name }, job: routes.jobView(job) });
    }
    if (m === 'POST' && p === '/local/adopt') {
      const b = await readJson(req);
      const s = local.adopt({ dir: b.dir, jar: b.jar, name: b.name, memoryMb: b.memoryMb === undefined ? 2048 : b.memoryMb });
      return send(res, 200, { ok: true, server: { id: s.server_id, name: s.server_name } });
    }
    if (m === 'PUT' && (r = /^\/servers\/([^/]+)\/local$/.exec(p))) {
      const patch = await readJson(req);
      const s = local.update(decodeURIComponent(r[1]), patch);
      return send(res, 200, { ok: true, restartNeeded: !!(await local.stats(s.server_id)).running });
    }
    if (m === 'POST' && (r = /^\/servers\/([^/]+)\/eula$/.exec(p))) {
      await readJson(req);
      local.acceptEula(decodeURIComponent(r[1]));
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE' && (r = /^\/servers\/([^/]+)$/.exec(p))) {
      const out = local.remove(decodeURIComponent(r[1]));
      return send(res, 200, { ok: true, dir: out.dir });
    }
    return false;
  }

  // ---- API ------------------------------------------------------------------------------
  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname.replace(/^\/api/, '');
    let r;

    // ---- login (only when Blockhaus runs without Umbrel's login in front of it) ----------------------------
    if (m === 'GET' && p === '/session') {
      return send(res, 200, { auth: authOn, host: hostTools, configured: auth ? auth.isConfigured() : true, authenticated: auth ? !!auth.sessionOf(req) : true });
    }
    if (authOn) {
      if (!sameOrigin(req)) throw new HttpError(403, 'Anfrage von einer fremden Seite abgelehnt.');
      if (m === 'POST' && p === '/login') {
        const b = await readJson(req, 4096);
        const out = auth.login(b.password, req.socket.remoteAddress || '?');
        if (!out.ok) return send(res, out.status, { error: out.error, ...(out.retryAfterS ? { retryAfterS: out.retryAfterS } : {}) }, out.retryAfterS ? { 'Retry-After': String(out.retryAfterS) } : {});
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.setCookie(out.token, out.maxAgeS, isSecure(req)) });
      }
      if (m === 'POST' && p === '/logout') {
        auth.logout(req);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isSecure(req)) });
      }
      if (!auth.sessionOf(req)) return send(res, 401, { error: 'Bitte anmelden.', code: 'LOGIN' });
    }

    // ---- computer: performance and terminal ----------------------------------------------------------------
    if (p.startsWith('/host/')) {
      if (!hostTools) throw new HttpError(404, 'Diese Funktion ist auf diesem Gerät nicht aktiv.');
      if (m === 'GET' && p === '/host/stats') {
        const w = Math.max(30, Math.min(3600, Number(url.searchParams.get('window')) || 300));
        return send(res, 200, hostStats.snapshot(w));
      }
      if (m === 'GET' && p === '/host/terminals') return send(res, 200, { terminals: terminals.list(), shell: terminals.shell, user: os.userInfo().username, cwd: terminals.cwd });
      if (m === 'POST' && p === '/host/terminals') {
        const b = await readJson(req);
        try { return send(res, 201, terminals.create(b).view()); }
        catch (e) { throw new HttpError(e.status || 500, e.message); }
      }
      if (m === 'DELETE' && (r = /^\/host\/terminals\/([0-9a-f]+)$/.exec(p))) {
        if (!terminals.close(r[1])) throw new HttpError(404, 'Dieses Terminal gibt es nicht (mehr).');
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Unbekannter Endpunkt.');
    }

    if (m === 'GET' && p === '/config') return send(res, 200, configView());
    if (m === 'PUT' && p === '/config') {
      const body = await readJson(req);
      config.update(body);
      crafty.jwt = null;
      return send(res, 200, configView());
    }
    if (local && m === 'GET' && p === '/anticheat/summary') return send(res, 200, { servers: anticheat.summary() });
    if (local && await localApi(req, res, m, p)) return;
    if (m === 'POST' && p === '/config/test') {
      if (local) { await readJson(req); return send(res, 200, { ok: true, servers: (await local.servers()).map((s) => ({ id: s.server_id, name: s.server_name, filesFound: true })) }); }
      const body = await readJson(req);
      // test with the submitted values merged over the stored ones, without saving
      const merged = { ...config.get() };
      for (const k of ['craftyUrl', 'username']) if (typeof body[k] === 'string' && body[k].trim()) merged[k] = body[k].trim();
      if (typeof body.apiToken === 'string' && body.apiToken.trim()) merged.apiToken = body.apiToken.trim();
      if (typeof body.password === 'string' && body.password) merged.password = body.password;
      if (body.clearToken) merged.apiToken = '';
      if (!/^https?:\/\//i.test(merged.craftyUrl || '')) merged.craftyUrl = 'https://' + merged.craftyUrl;
      const probe = new Crafty(() => merged);
      try {
        const list = await probe.servers();
        const withFiles = list.map((s) => ({ id: s.server_id, name: s.server_name, filesFound: !!files.resolveDir(serversDir, s) }));
        return send(res, 200, { ok: true, servers: withFiles });
      } catch (e) {
        if (!(e instanceof CraftyError)) throw e;
        return send(res, 200, { ok: false, code: e.code, error: e.message });
      }
    }

    if (m === 'POST' && p === '/tools/sha1') {
      const b = await readJson(req);
      if (!/^https?:\/\//i.test(String(b.url || ''))) throw new HttpError(400, 'Bitte eine http(s)-Adresse angeben.');
      try { return send(res, 200, await hashUrl(String(b.url))); }
      catch (e) { throw new HttpError(502, e.message); }
    }

    if (m === 'GET' && p === '/servers') {
      const list = await listServers();
      return send(res, 200, list.map((s) => ({ id: s.server_id, name: s.server_name, port: s.server_port })));
    }

    let mm = /^\/servers\/([^/]+)\/(.+)$/.exec(p);
    if (!mm) throw new HttpError(404, 'Unbekannter Endpunkt.');
    const [, id, rest] = mm;
    const server = await getServer(decodeURIComponent(id));

    if (m === 'GET' && rest === 'status') return send(res, 200, await statusOf(server));

    if (m === 'POST' && (r = /^action\/(start|stop|restart|kill)$/.exec(rest))) {
      await readJson(req);
      await crafty.action(server.server_id, r[1] + '_server');
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && rest === 'console') {
      let lines;
      try { lines = await crafty.logs(server.server_id); }
      catch (e) {
        let dir = null; try { dir = dirFor(server); } catch { /* none */ }
        if (!dir) throw e;
        lines = logTail(dir).split('\n');
      }
      return send(res, 200, { lines: lines.slice(-500) });
    }
    if (m === 'POST' && rest === 'command') {
      const { command } = await readJson(req);
      const cmd = String(command || '').replace(/[\r\n]+/g, ' ').replace(/^\/+/, '').trim();
      if (!cmd) throw new HttpError(400, 'Kein Befehl angegeben.');
      await crafty.stdin(server.server_id, cmd);
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && rest === 'properties') {
      const { parsed, exists } = readProps(dirFor(server));
      const stats = await crafty.stats(server.server_id);
      return send(res, 200, { exists, values: parsed.values, running: !!stats.running });
    }
    if (m === 'PUT' && rest === 'properties') {
      const { changes } = await readJson(req);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'changes fehlt.');
      const clean = {};
      for (const [k, v] of Object.entries(changes)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) throw new HttpError(400, 'Ungültiger Schlüssel: ' + k);
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new HttpError(400, 'Ungültiger Wert für ' + k);
        clean[k] = String(v);
      }
      if (!Object.keys(clean).length) return send(res, 200, { ok: true, changed: 0 });
      const dir = dirFor(server);
      const { file, parsed, exists } = readProps(dir);
      const out = props.apply(parsed, clean);
      if (exists) writeFileKeepOwner(file + '.blockhaus.bak', fs.readFileSync(file));
      writeFileKeepOwner(file, out);
      const stats = await crafty.stats(server.server_id);
      return send(res, 200, { ok: true, changed: Object.keys(clean).length, restartNeeded: !!stats.running });
    }

    if (m === 'GET' && rest === 'players') {
      const dir = dirFor(server);
      const { parsed } = readProps(dir);
      const out = {};
      for (const name of Object.keys(players.LISTS)) {
        try { out[name] = players.readList(dir, name); } catch (e) { out[name] = []; out.error = e.message; }
      }
      const stats = await crafty.stats(server.server_id);
      return send(res, 200, {
        lists: out,
        running: !!stats.running,
        online: state.parsePlayers(stats.players),
        onlineMode: isTrue(parsed.values['online-mode'], true),
        whitelistEnabled: isTrue(parsed.values['white-list'], false),
      });
    }
    if (m === 'POST' && (r = /^players\/(whitelist|ops|banned-players|banned-ips)$/.exec(rest))) {
      return playerEdit(req, res, server, r[1], 'add');
    }
    if (m === 'DELETE' && (r = /^players\/(whitelist|ops|banned-players|banned-ips)\/(.+)$/.exec(rest))) {
      return playerEdit(req, res, server, r[1], 'remove', decodeURIComponent(r[2]));
    }
    if (m === 'POST' && rest === 'kick') {
      const { name } = await readJson(req);
      const key = validKey('whitelist', name);
      await crafty.stdin(server.server_id, `kick ${key}`);
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && rest === 'logs') return send(res, 200, { files: files.listLogs(dirFor(server)) });
    if (m === 'GET' && (r = /^logs\/([^/]+)$/.exec(rest))) {
      const name = decodeURIComponent(r[1]);
      try { return send(res, 200, { name, text: files.readLog(dirFor(server), name) }); }
      catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(404, 'Log-Datei nicht lesbar: ' + e.message);
      }
    }

    const handled = await routes.handle({ req, res, url, method: m, rest, server, dir: () => dirFor(server), crafty, jobs, backups, dataDir, send, readJson, HttpError, readProps, cfg: () => config.get(), installFn: softwareInstall, pollMs: Math.max(5, Math.min(settleMs, 1500)), packPort: Number(process.env.PACK_PORT) || 25700, mcPort: local ? local.port : null, mode, voiceSuggested: local ? 24454 : 19132, anticheat });
    if (handled) return;
    throw new HttpError(404, 'Unbekannter Endpunkt.');
  }

  async function playerEdit(req, res, server, list, action, keyFromPath) {
    const rawKey = keyFromPath !== undefined ? keyFromPath : (await readJson(req)).name;
    const key = validKey(list, rawKey);
    const dir = dirFor(server);
    const stats = await crafty.stats(server.server_id);
    if (stats.running) {
      await crafty.stdin(server.server_id, players.commandFor(list, action, key));
      await sleep(settleMs); // let the server write its JSON file
      return send(res, 200, { ok: true, via: 'console', entries: players.readList(dir, list) });
    }
    const { parsed } = readProps(dir);
    try {
      const entries = await players.editOffline(dir, list, action, key, {
        onlineMode: isTrue(parsed.values['online-mode'], true), lookup,
      });
      return send(res, 200, { ok: true, via: 'file', entries });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e.message);
    }
  }

  // ---- static files ---------------------------------------------------------------------
  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, 'Verboten');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Nicht gefunden');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode nicht erlaubt.');
      return serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof CraftyError) return send(res, 502, { error: e.message, code: e.code });
      if (e instanceof LocalError) return send(res, e.status, { error: e.message, code: e.code });
      if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500) return send(res, e.status, { error: e.message });
      console.error('Unerwarteter Fehler:', e);
      return send(res, 500, { error: 'Interner Fehler: ' + (e && e.message ? e.message : e) });
    }
  });
  // Terminal: WebSocket on /api/host/terminals/<id>/ws (same login and same-origin rules as the API)
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const deny = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    try {
      const m = /^\/api\/host\/terminals\/([0-9a-f]+)\/ws$/.exec(new URL(req.url, 'http://x').pathname);
      if (!m || !terminals) return deny(404, 'Not Found');
      if (!sameOrigin(req) || !req.headers.origin) return deny(403, 'Forbidden');    // browsers always send Origin on WebSockets
      if (!auth.sessionOf(req)) return deny(401, 'Unauthorized');
      const session = terminals.get(m[1]);
      if (!session) return deny(404, 'Not Found');
      const sock = ws.accept(req, socket);
      if (sock) session.attach(sock);
    } catch { deny(400, 'Bad Request'); }
  });
  server.config = config;
  server.local = local;
  server.anticheat = anticheat;
  server.on('close', () => { if (anticheat) anticheat.stop(); });
  server.mode = mode;
  server.auth = auth;
  server.terminals = terminals;
  server.hostStats = hostStats;
  return server;
}

async function passwordCli(argv) {
  const dataDir = process.env.DATA_DIR || '/data';
  const auth = new Auth(dataDir);
  let pw;
  if (argv.includes('--set-password-stdin')) {
    pw = await new Promise((resolve) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => resolve(b.replace(/\r?\n$/, ''))); });
  } else {
    const { promptHidden, MIN_PASSWORD } = require('./lib/auth');
    pw = await promptHidden(`Neues Passwort für Blockhaus (mindestens ${MIN_PASSWORD} Zeichen): `);
    const again = await promptHidden('Noch einmal: ');
    if (pw !== again) throw new Error('Die Eingaben stimmen nicht überein.');
  }
  auth.setPassword(pw);
  console.log(`Passwort gespeichert (${auth.file}). Alle angemeldeten Browser müssen sich neu anmelden.`);
}

if (require.main === module && process.argv.some((a) => a === '--set-password' || a === '--set-password-stdin')) {
  passwordCli(process.argv).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({
    dataDir: process.env.DATA_DIR || '/data',
    serversDir: process.env.SERVERS_DIR || '/servers',
  });
  app.listen(port, process.env.BIND || '0.0.0.0', () => console.log(`Blockhaus läuft auf Port ${port} (${app.mode === 'local' ? 'eigenständig' : 'mit Crafty'}${app.auth ? ', mit Login' : ''}${app.terminals ? ', mit Leistung und Terminal' : ''})`));
  if (app.hostStats) app.hostStats.start();
  if (app.auth && !app.auth.isConfigured()) console.warn('ACHTUNG: Es ist noch kein Passwort gesetzt, niemand kann sich anmelden. Setzen mit: node server.js --set-password');
  if (app.terminals && !app.local) { for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.terminals.closeAll(); setTimeout(() => process.exit(0), 300); }); }
  if (app.local) {
    app.local.autostart((m) => console.log(m)).catch((e) => console.error('Autostart:', e.message));
    // docker stop sends SIGTERM: let Minecraft save and exit instead of being killed with the container
    let closing = false;
    const bye = async (sig) => {
      if (closing) return; closing = true;
      console.log(`${sig}: Minecraft wird sauber beendet …`);
      if (app.terminals) app.terminals.closeAll();
      try { await app.local.shutdown(); } catch (e) { console.error(e.message); }
      if (app.anticheat) app.anticheat.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => bye('SIGTERM'));
    process.on('SIGINT', () => bye('SIGINT'));
  }
  // Public side: texture-pack download (+ forwarding of Minecraft traffic). See lib/packserver.js.
  const packPort = Number(process.env.PACK_PORT) || 25700;
  const front = createPackFront({
    publicDir: packs.publicDir(process.env.DATA_DIR || '/data'),
    upstream: () => (app.local ? `127.0.0.1:${app.local.port}` : app.config.get().packUpstream),
    log: (m) => console.warn(m),
  });
  front.on('error', (e) => console.error(`Pack-Server auf Port ${packPort} konnte nicht starten: ${e.message}`));
  front.listen(packPort, '0.0.0.0', () => console.log(`Pack-Server läuft auf Port ${packPort}`));
}

module.exports = { createApp };
