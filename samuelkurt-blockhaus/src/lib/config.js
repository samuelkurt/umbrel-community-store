'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  craftyUrl: 'https://crafty_container:8443',
  insecureTls: true,
  apiToken: '',
  username: '',
  password: '',
  publicAddress: '',
  localAddress: '',
};

class Config {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    this.dataDir = dataDir;
    this.value = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.value = { ...DEFAULTS, ...raw };
    } catch { /* first start or unreadable: keep defaults */ }
  }

  get() { return this.value; }

  /** Whether enough is set to try talking to Crafty. */
  isConfigured() {
    const c = this.value;
    return !!(c.craftyUrl && (c.apiToken || (c.username && c.password)));
  }

  /** Public view without secrets. */
  publicView() {
    const c = this.value;
    return {
      craftyUrl: c.craftyUrl,
      insecureTls: c.insecureTls !== false,
      username: c.username,
      hasToken: !!c.apiToken,
      hasPassword: !!c.password,
      publicAddress: c.publicAddress,
      localAddress: c.localAddress,
      configured: this.isConfigured(),
    };
  }

  /** Merge an update. Empty secret strings keep the stored secret; `clearToken`/`clearPassword` remove it. */
  update(patch) {
    const next = { ...this.value };
    for (const k of ['craftyUrl', 'username', 'publicAddress', 'localAddress']) {
      if (typeof patch[k] === 'string') next[k] = patch[k].trim();
    }
    if (typeof patch.insecureTls === 'boolean') next.insecureTls = patch.insecureTls;
    if (typeof patch.apiToken === 'string' && patch.apiToken.trim()) next.apiToken = patch.apiToken.trim();
    if (typeof patch.password === 'string' && patch.password) next.password = patch.password;
    if (patch.clearToken) next.apiToken = '';
    if (patch.clearPassword) next.password = '';
    if (next.craftyUrl && !/^https?:\/\//i.test(next.craftyUrl)) next.craftyUrl = 'https://' + next.craftyUrl;
    this.value = next;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Config, DEFAULTS };
