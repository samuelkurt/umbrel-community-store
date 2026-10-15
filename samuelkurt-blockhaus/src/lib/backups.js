'use strict';
// Blockhaus' own backups: ZIP files in <dataDir>/backups/<serverId>/ with a small .json next to each.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zipLib = require('./zip');
const worlds = require('./worlds');
const serverfiles = require('./serverfiles');
const { chownLike } = require('./fsutil');

const ID_RE = /^[0-9A-Za-z_-]{1,80}$/;
const FULL_SKIP = /^(logs|crash-reports|cache)(\/|$)|\.part$|\.upload$|\.blockhaus-tmp$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

class Backups {
  constructor(dataDir) { this.root = path.join(dataDir, 'backups'); }

  dirFor(serverId) {
    const safe = String(serverId).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 80);
    if (!safe) throw new Error('Ungültige Server-ID.');
    return path.join(this.root, safe);
  }

  list(serverId) {
    const d = this.dirFor(serverId);
    let names = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.zip')) continue;
      const id = n.slice(0, -4);
      if (!ID_RE.test(id)) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8')); } catch { /* no sidecar */ }
      const st = fs.statSync(path.join(d, n));
      out.push({ id, created: meta.created || st.mtime.toISOString(), kind: meta.kind || 'unknown', note: meta.note || '', worlds: meta.worlds || [], version: meta.version || '', size: st.size });
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  file(serverId, id) {
    if (!ID_RE.test(String(id))) { const e = new Error('Ungültige Backup-ID.'); e.status = 400; throw e; }
    const f = path.join(this.dirFor(serverId), id + '.zip');
    if (!fs.existsSync(f)) { const e = new Error('Dieses Backup gibt es nicht.'); e.status = 404; throw e; }
    return f;
  }

  async remove(serverId, id) {
    const f = this.file(serverId, id);
    await fsp.rm(f, { force: true });
    await fsp.rm(f.replace(/\.zip$/, '.json'), { force: true });
  }

  /**
   * Create a backup.
   * @param {object} o
   * @param {string} o.serverId, o.serverDir
   * @param {'worlds'|'full'} o.kind
   * @param {boolean} o.running            server process is up -> flush and pause saving first
   * @param {(cmd:string)=>Promise<void>} o.sendCommand  console command (only used when running)
   * @param {object} o.job                 job object (message is updated)
   * @param {string} o.version             free text stored in the sidecar
   */
  async create({ serverId, serverDir, kind = 'worlds', note = '', running = false, sendCommand, job, version = '' }) {
    if (kind !== 'worlds' && kind !== 'full') throw Object.assign(new Error('Unbekannte Backup-Art.'), { status: 400 });
    const dir = this.dirFor(serverId);
    await fsp.mkdir(dir, { recursive: true });
    const id = `${stamp()}-${kind}`;
    const zipFile = path.join(dir, id + '.zip');
    const part = zipFile + '.part';

    const names = [];
    if (kind === 'worlds') {
      const ws = await worlds.listWorlds(serverDir, null);
      for (const w of ws) { names.push(w.name); for (const c of w.companions) names.push(c); }
      if (!names.length) throw new Error('Es gibt noch keine Welt zum Sichern (kein Ordner mit level.dat).');
    }

    let savingOff = false;
    try {
      if (running && sendCommand) {
        if (job) job.message = 'Server speichert die Welt …';
        const from = serverfiles.logSize(serverDir);
        await sendCommand('save-off'); savingOff = true;
        await sendCommand('save-all flush');
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) {
          await sleep(500);
          ok = /Saved the game|Saved the world/.test(serverfiles.readLogFrom(serverDir, from));
        }
        if (!ok && job) job.message = 'Keine Speicher-Bestätigung im Log gesehen, sichere trotzdem …';
      }
      if (job) job.message = 'Packe Dateien …';
      const out = fs.createWriteStream(part);
      const z = new zipLib.ZipWriter(out);
      z.onFile = (n) => { if (job) job.message = 'Packe ' + n; };
      try {
        if (kind === 'worlds') {
          for (const n of names) { await z.addDir(n + '/'); await z.addTree(path.join(serverDir, n), n + '/', { filter: (rel) => rel !== 'session.lock' }); }
        } else {
          await z.addTree(serverDir, '', { filter: (rel) => !FULL_SKIP.test(rel) && rel !== 'session.lock' && !rel.endsWith('/session.lock') });
        }
        await z.finish();
      } catch (e) { out.destroy(); throw e; }
      await fsp.rename(part, zipFile);
      const meta = { id, created: new Date().toISOString(), kind, note, worlds: names, version };
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta, null, 2));
      return { id, size: fs.statSync(zipFile).size };
    } catch (e) {
      await fsp.rm(part, { force: true });
      throw e;
    } finally {
      if (savingOff && sendCommand) { try { await sendCommand('save-on'); } catch { /* server may be gone */ } }
    }
  }

  /** Restore a backup into the server folder. Server must be stopped (caller checks). Makes a safety backup first. */
  async restore({ serverId, serverDir, id, job, version = '' }) {
    const zipFile = this.file(serverId, id);
    const entries = await zipLib.readEntries(zipFile);
    const tops = new Set();
    for (const e of entries) {
      const n = zipLib.safeName(e.name);
      if (n && n.endsWith('/level.dat') && n.split('/').length === 2) tops.add(n.split('/')[0]);
    }
    const existing = await worlds.listWorlds(serverDir, null);
    if (existing.length) {
      if (job) job.message = 'Sicherheits-Backup der aktuellen Welten …';
      await this.create({ serverId, serverDir, kind: 'worlds', note: 'Automatisch vor Wiederherstellung von ' + id, running: false, job, version });
    }
    for (const w of tops) {
      const wd = path.join(serverDir, w);
      if (!worlds.WORLD_NAME_RE.test(w)) continue;
      if (job) job.message = 'Entferne alte Welt ' + w;
      await fsp.rm(wd, { recursive: true, force: true });
      for (const c of worlds.companionsOf(serverDir, w)) await fsp.rm(path.join(serverDir, c), { recursive: true, force: true });
    }
    const chown = chownLike(serverDir);
    const r = await zipLib.extractZip(zipFile, serverDir, { onFile: (n) => { if (job) job.message = 'Stelle wieder her: ' + n; }, chown });
    return { files: r.files, worlds: [...tops] };
  }
}

module.exports = { Backups };
