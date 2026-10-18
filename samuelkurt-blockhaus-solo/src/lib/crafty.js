'use strict';
// Client for the Crafty Controller 4 API v2 (verified against the published OpenAPI spec,
// not against a live Crafty instance).
const { request } = require('./http');

class CraftyError extends Error {
  constructor(message, { status = 0, code = 'CRAFTY_ERROR' } = {}) {
    super(message);
    this.name = 'CraftyError';
    this.status = status;
    this.code = code;
  }
}

class Crafty {
  /** @param {() => object} getConfig returns the current panel config */
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.jwt = null;
    this.jwtKey = null;
  }

  _cfg() {
    const cfg = this.getConfig();
    if (!cfg.craftyUrl) throw new CraftyError('Crafty-URL ist nicht eingestellt.', { code: 'NOT_CONFIGURED' });
    return cfg;
  }

  async _send(cfg, method, path, { json, text, query, token } = {}) {
    const base = cfg.craftyUrl.replace(/\/+$/, '');
    let url = base + path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += '?' + qs;
    }
    const headers = { Accept: 'application/json' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (text !== undefined) { headers['Content-Type'] = 'text/plain'; body = text; }
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await request(url, { method, headers, body, insecure: cfg.insecureTls !== false });
    } catch (e) {
      const code = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ||
        e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' ? 'UNREACHABLE' : 'NETWORK';
      throw new CraftyError(`Crafty ist unter ${base} nicht erreichbar (${e.code || e.message}).`, { code });
    }
    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch { /* not JSON */ }
    return { status: res.status, data, raw: res.body };
  }

  async _login(cfg) {
    if (!cfg.username || !cfg.password) {
      throw new CraftyError('Crafty-Zugangsdaten fehlen (API-Token oder Benutzer und Passwort).', { code: 'NO_CREDENTIALS' });
    }
    const r = await this._send(cfg, 'POST', '/api/v2/auth/login', { json: { username: cfg.username, password: cfg.password } });
    const token = r.data && r.data.data && r.data.data.token;
    if (r.status !== 200 || !token) {
      throw new CraftyError('Anmeldung bei Crafty fehlgeschlagen. Benutzername oder Passwort stimmen nicht.', { status: r.status, code: 'LOGIN_FAILED' });
    }
    this.jwt = token;
    this.jwtKey = cfg.craftyUrl + '|' + cfg.username + '|' + cfg.password;
    return token;
  }

  async _token(cfg, force) {
    if (cfg.apiToken) return cfg.apiToken;
    const key = cfg.craftyUrl + '|' + cfg.username + '|' + cfg.password;
    if (!force && this.jwt && this.jwtKey === key) return this.jwt;
    return this._login(cfg);
  }

  /** Authenticated call. Returns the parsed JSON body. */
  async call(method, path, opts = {}) {
    const cfg = this._cfg();
    let token = await this._token(cfg, false);
    let r = await this._send(cfg, method, path, { ...opts, token });
    if ((r.status === 401 || r.status === 403) && !cfg.apiToken) {
      token = await this._token(cfg, true);
      r = await this._send(cfg, method, path, { ...opts, token });
    }
    if (r.status === 401 || r.status === 403) {
      const why = cfg.apiToken
        ? 'Der API-Token wurde abgelehnt oder hat für diese Aktion keine Berechtigung.'
        : 'Crafty hat den Zugriff verweigert (fehlende Berechtigung).';
      throw new CraftyError(why, { status: r.status, code: 'FORBIDDEN' });
    }
    if (r.data === null && r.status < 300) {
      throw new CraftyError('Crafty hat keine gültige API-Antwort geliefert. Stimmt die URL (Port 8443, https)?', { status: r.status, code: 'BAD_RESPONSE' });
    }
    if (r.status >= 400 || (r.data && r.data.status === 'error')) {
      const detail = r.data && (r.data.error_data || r.data.error);
      throw new CraftyError('Crafty meldet einen Fehler' + (detail ? ': ' + detail : '') + ` (HTTP ${r.status}).`, { status: r.status, code: 'API_ERROR' });
    }
    return r.data;
  }

  async servers() {
    const r = await this.call('GET', '/api/v2/servers');
    return Array.isArray(r.data) ? r.data : [];
  }

  /** Returns the stats object. The spec puts fields beside `data`, live Crafty may nest them; accept both. */
  async stats(id) {
    const r = await this.call('GET', `/api/v2/servers/${encodeURIComponent(id)}/stats`);
    const inner = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
    return { ...inner, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'data' && k !== 'status')) };
  }

  async action(id, action) {
    const allowed = ['start_server', 'stop_server', 'restart_server', 'kill_server', 'backup_server'];
    if (!allowed.includes(action)) throw new CraftyError('Unbekannte Aktion: ' + action, { code: 'BAD_ACTION' });
    return this.call('POST', `/api/v2/servers/${encodeURIComponent(id)}/action/${action}`);
  }

  /** Sends one console command (no leading slash). */
  async stdin(id, command) {
    return this.call('POST', `/api/v2/servers/${encodeURIComponent(id)}/stdin`, { text: command });
  }

  async logs(id, { file = false } = {}) {
    const r = await this.call('GET', `/api/v2/servers/${encodeURIComponent(id)}/logs`, { query: { file: String(file) } });
    return Array.isArray(r.data) ? r.data.map(String) : [];
  }
}

module.exports = { Crafty, CraftyError };
