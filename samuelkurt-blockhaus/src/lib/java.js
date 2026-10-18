'use strict';
// Java for the standalone mode: the container has no JDK, so the right Temurin JRE is downloaded the first time a
// server needs it (checksum from the Adoptium API) and kept in <data>/java/<major>.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getJson, downloadFile } = require('./download');

const API = () => process.env.BLOCKHAUS_ADOPTIUM || 'https://api.adoptium.net/v3';
const LTS = [8, 11, 17, 21, 25];

const arch = () => (process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x64' : process.arch);

/** Adoptium only builds LTS versions (and a few more). Use the smallest LTS that is >= what the server wants. */
function pickMajor(want) {
  const w = Number(want) || 21;
  return LTS.find((v) => v >= w) || LTS[LTS.length - 1];
}

/**
 * Which Java a server needs. Order: explicit choice, what the software installer recorded, `java_version` in the
 * server jar's version.json (passed in), a table by Minecraft version, else 21.
 */
function wanted({ override, installed, jarJava, mc }) {
  if (override) return Number(override);
  if (installed && installed.java) return Number(installed.java);
  if (jarJava) return Number(jarJava);
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mc || ''));
  if (m) {
    const major = Number(m[1]); const minor = Number(m[2]); const patch = Number(m[3] || 0);
    if (major >= 26) return 25;
    if (major === 1) {
      if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
      if (minor >= 17) return 17;
      return 8;
    }
  }
  return 21;
}

const inflight = new Map();

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} hat nicht rechtzeitig geantwortet.`)); }, timeout);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} endete mit Code ${code}: ${out.trim().slice(-300)}`)); });
  });
}

/** Returns the path of bin/java for `major`, downloading it when needed. `job` (optional) gets progress messages. */
function ensure(dataDir, want, { job, say } = {}) {
  const major = pickMajor(want);
  const envBin = process.env[`BLOCKHAUS_JAVA_${major}`];
  if (envBin && fs.existsSync(envBin)) return Promise.resolve({ bin: envBin, major, downloaded: false });
  const home = path.join(dataDir, 'java', String(major));
  const bin = path.join(home, 'bin', 'java');
  if (fs.existsSync(bin)) return Promise.resolve({ bin, major, downloaded: false });
  if (inflight.has(major)) return inflight.get(major);
  const note = (m) => { if (say) say(m); if (job) job.message = m; };
  const p = (async () => {
    note(`Java ${major} wird gesucht …`);
    const qs = new URLSearchParams({ architecture: arch(), image_type: 'jre', os: 'linux', vendor: 'eclipse' });
    const list = await getJson(`${API()}/assets/latest/${major}/hotspot?${qs}`);
    const pkg = Array.isArray(list) && list[0] && list[0].binary && list[0].binary.package;
    if (!pkg || !pkg.link || !pkg.checksum) throw new Error(`Für Java ${major} gibt es keinen Download für diese Prozessor-Architektur (${arch()}).`);
    const tmpRoot = path.join(dataDir, 'java', `.dl-${major}-${process.pid}`);
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    await fsp.mkdir(tmpRoot, { recursive: true });
    try {
      const archive = path.join(tmpRoot, 'jre.tar.gz');
      await downloadFile(pkg.link, archive, {
        sha256: pkg.checksum, maxBytes: 400 * 1024 * 1024,
        onProgress: (n, total) => { if (job) { job.progress = total ? n / total : null; } note(`Java ${major} wird geladen … ${(n / 1048576).toFixed(0)} MB`); },
      });
      note(`Java ${major} wird entpackt …`);
      const out = path.join(tmpRoot, 'out');
      await fsp.mkdir(out);
      await run('tar', ['-xzf', archive, '-C', out, '--strip-components=1']);
      const outBin = path.join(out, 'bin', 'java');
      if (!fs.existsSync(outBin)) throw new Error('Im Java-Archiv fehlt bin/java.');
      await run(outBin, ['-version'], { timeout: 30000 }).catch((e) => { throw new Error(`Das geladene Java läuft hier nicht: ${e.message}`); });
      await fsp.rm(home, { recursive: true, force: true });
      await fsp.rename(out, home);
    } finally { await fsp.rm(tmpRoot, { recursive: true, force: true }); }
    if (job) job.progress = null;
    note(`Java ${major} ist bereit.`);
    return { bin, major, downloaded: true };
  })();
  inflight.set(major, p);
  p.finally(() => inflight.delete(major)).catch(() => {});
  return p;
}

/** Which Java versions are downloaded already. */
function installed(dataDir) {
  try { return fs.readdirSync(path.join(dataDir, 'java')).filter((n) => /^\d+$/.test(n) && fs.existsSync(path.join(dataDir, 'java', n, 'bin', 'java'))).map(Number).sort((a, b) => a - b); } catch { return []; }
}

module.exports = { ensure, wanted, pickMajor, installed, LTS };
