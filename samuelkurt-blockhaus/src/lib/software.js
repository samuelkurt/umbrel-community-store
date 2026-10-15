'use strict';
// Server software: version lists, verified downloads, and swapping the jar Crafty runs.
//
// Crafty starts "java ... -jar <executable> nogui". For Vanilla, Paper, Purpur and Fabric we simply
// replace that jar. Forge, NeoForge and Quilt need an installer run and a different start command, so we
// put a tiny launcher jar (assets/blockhaus-launcher.jar) in its place; it runs the installer on the first
// start and then launches the real server. No change to Crafty's configuration is needed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getJson, getText, downloadFile } = require('./download');
const { writeFileKeepOwner, chownLike } = require('./fsutil');

const URLS = {
  mojang: process.env.BLOCKHAUS_MOJANG_MANIFEST || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  paper: 'https://fill.papermc.io/v3/projects/paper',
  purpur: 'https://api.purpurmc.org/v2/purpur',
  fabricMeta: 'https://meta.fabricmc.net/v2/versions',
  quiltMeta: 'https://meta.quiltmc.org/v3/versions',
  neoforgeMeta: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  neoforgeBase: 'https://maven.neoforged.net/releases/net/neoforged/neoforge',
  forgePromos: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  forgeBase: 'https://maven.minecraftforge.net/net/minecraftforge/forge',
};

const KINDS = [
  { id: 'vanilla', label: 'Vanilla', info: 'Das originale Minecraft. Keine Mods oder Plugins.', mods: null },
  { id: 'snapshot', label: 'Snapshot', info: 'Vorabversionen von Mojang zum Ausprobieren. Welten können dabei beschädigt werden.', mods: null },
  { id: 'paper', label: 'Paper', info: 'Schnell, mit Plugins. Zugleich Ersatz für Spigot.', mods: 'plugins' },
  { id: 'purpur', label: 'Purpur', info: 'Paper mit vielen zusätzlichen Einstellungen. Plugins.', mods: 'plugins' },
  { id: 'fabric', label: 'Fabric', info: 'Leichter Mod-Loader. Mods für Fabric.', mods: 'mods' },
  { id: 'quilt', label: 'Quilt', info: 'Mod-Loader auf Fabric-Basis, lädt auch die meisten Fabric-Mods.', mods: 'mods', installer: true },
  { id: 'neoforge', label: 'NeoForge', info: 'Mod-Loader (Nachfolger von Forge ab 1.20.2). Mods für NeoForge.', mods: 'mods', installer: true },
  { id: 'forge', label: 'Forge', info: 'Der klassische Mod-Loader. Mods für Forge.', mods: 'mods', installer: true },
  { id: 'spigot', label: 'Spigot', info: 'Nicht verfügbar: Spigot muss mit BuildTools selbst kompiliert werden (Git, Java, mehrere Minuten). Paper ist dazu kompatibel.', unsupported: true },
];

function kindInfo(id) { return KINDS.find((k) => k.id === id) || null; }

function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return typeof y === 'string' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; }
    else if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const isStableMc = (v) => !/(snapshot|pre|rc|alpha|beta|[0-9]w[0-9])/i.test(v);

async function mojangManifest() { return getJson(URLS.mojang); }

/** Mojang's version JSON for an MC version (also gives the required Java major version and the server jar). */
async function mojangVersion(mc) {
  const m = await mojangManifest();
  const v = m.versions.find((x) => x.id === mc);
  if (!v) return null;
  return getJson(v.url);
}

async function javaFor(mc) {
  try {
    const j = await mojangVersion(mc);
    return j && j.javaVersion ? j.javaVersion.majorVersion : null;
  } catch { return null; }
}

// ---- version lists --------------------------------------------------------------------------------

/** newest first: [{ id, stable, build?, note? }] */
async function listVersions(kind) {
  switch (kind) {
    case 'vanilla': {
      const m = await mojangManifest();
      return m.versions.filter((v) => v.type === 'release').map((v) => ({ id: v.id, stable: true }));
    }
    case 'snapshot': {
      const m = await mojangManifest();
      return m.versions.filter((v) => v.type === 'snapshot').slice(0, 60).map((v) => ({ id: v.id, stable: false }));
    }
    case 'paper': {
      const j = await getJson(URLS.paper);
      const all = Object.values(j.versions || {}).flat();
      return all.map((id) => ({ id, stable: isStableMc(id) }));
    }
    case 'purpur': {
      const j = await getJson(URLS.purpur);
      return (j.versions || []).slice().reverse().map((id) => ({ id, stable: isStableMc(id) }));
    }
    case 'fabric': {
      const g = await getJson(URLS.fabricMeta + '/game');
      return g.map((v) => ({ id: v.version, stable: !!v.stable }));
    }
    case 'quilt': {
      const g = await getJson(URLS.quiltMeta + '/game');
      return g.map((v) => ({ id: v.version, stable: !!v.stable }));
    }
    case 'neoforge': return neoforgeVersions();
    case 'forge': {
      const j = await getJson(URLS.forgePromos);
      const promos = j.promos || {};
      const out = [];
      for (const key of Object.keys(promos)) {
        const m = /^(.+)-latest$/.exec(key);
        if (!m) continue;
        out.push({ id: m[1], build: promos[key], recommended: promos[m[1] + '-recommended'] || null, stable: true });
      }
      return out.sort((a, b) => cmpVersion(b.id, a.id));
    }
    default: throw Object.assign(new Error('Diese Software wird nicht unterstützt.'), { status: 400 });
  }
}

/** NeoForge numbers its builds after the MC version: 21.4.161 = MC 1.21.4; 26.1.2.121 = MC 26.1.2. */
function neoforgeToMc(v) {
  const base = v.replace(/[-+].*$/, '');
  const parts = base.split('.').map(Number);
  if (parts.some(Number.isNaN)) return null;
  let mc;
  if (parts[0] >= 26) {
    if (parts.length < 4) return null;
    mc = parts.slice(0, parts.length - 1).join('.');
    mc = mc.replace(/(\.0)+$/, '');
  } else {
    if (parts.length < 3) return null;
    mc = '1.' + parts[0] + (parts[1] ? '.' + parts[1] : '');
  }
  return mc;
}

async function neoforgeVersions() {
  const xml = await getText(URLS.neoforgeMeta);
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const byMc = new Map();
  for (const v of all) {
    const mc = neoforgeToMc(v);
    if (!mc) continue;
    const stable = !/[-+]/.test(v);
    const cur = byMc.get(mc);
    // prefer stable over beta; among equals the highest build
    if (!cur || (stable && !cur.stable) || (stable === cur.stable && cmpVersion(v, cur.build) > 0)) byMc.set(mc, { id: mc, build: v, stable });
  }
  return [...byMc.values()].sort((a, b) => cmpVersion(b.id, a.id));
}

// ---- resolving a concrete download ----------------------------------------------------------------

async function mavenSha1(url) {
  try { return (await getText(url + '.sha1')).trim().split(/\s+/)[0]; } catch { return null; }
}

/**
 * @returns {{ type:'jar'|'installer', url:string, mc:string, build?:string, checksum:object, file:string,
 *             installerArgs?:string, launch?:string[], java:number|null }}
 */
async function resolve(kind, version) {
  const info = kindInfo(kind);
  if (!info || info.unsupported) throw Object.assign(new Error(info ? info.info : 'Unbekannte Software.'), { status: 400 });
  if (!/^[0-9A-Za-z._+-]{1,40}$/.test(String(version))) throw Object.assign(new Error('Ungültige Versionsnummer.'), { status: 400 });
  const java = await javaFor(version);
  switch (kind) {
    case 'vanilla':
    case 'snapshot': {
      const j = await mojangVersion(version);
      if (!j || !j.downloads || !j.downloads.server) throw Object.assign(new Error(`Für ${version} gibt es kein Server-Paket bei Mojang.`), { status: 404 });
      return { type: 'jar', url: j.downloads.server.url, mc: version, checksum: { sha1: j.downloads.server.sha1 }, file: 'server.jar', java: j.javaVersion ? j.javaVersion.majorVersion : null };
    }
    case 'paper': {
      const b = await getJson(`${URLS.paper}/versions/${encodeURIComponent(version)}/builds/latest`);
      const d = b.downloads && b.downloads['server:default'];
      if (!d) throw Object.assign(new Error(`Für Paper ${version} gibt es keinen Download.`), { status: 404 });
      return { type: 'jar', url: d.url, mc: version, build: String(b.id), checksum: { sha256: d.checksums && d.checksums.sha256 }, file: d.name, java };
    }
    case 'purpur': {
      const v = await getJson(`${URLS.purpur}/${encodeURIComponent(version)}`);
      const build = v.builds && v.builds.latest;
      if (!build) throw Object.assign(new Error(`Für Purpur ${version} gibt es keinen Build.`), { status: 404 });
      const bj = await getJson(`${URLS.purpur}/${encodeURIComponent(version)}/${build}`);
      return { type: 'jar', url: `${URLS.purpur}/${encodeURIComponent(version)}/${build}/download`, mc: version, build: String(build), checksum: { md5: bj.md5 }, file: `purpur-${version}-${build}.jar`, java };
    }
    case 'fabric': {
      const loaders = await getJson(URLS.fabricMeta + '/loader');
      const installers = await getJson(URLS.fabricMeta + '/installer');
      const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
      const inst = (installers.find((l) => l.stable) || installers[0]).version;
      return { type: 'jar', url: `${URLS.fabricMeta}/loader/${encodeURIComponent(version)}/${loader}/${inst}/server/jar`, mc: version, build: `loader ${loader}`, checksum: {}, file: `fabric-server-${version}-${loader}.jar`, java };
    }
    case 'quilt': {
      const installers = await getJson(URLS.quiltMeta + '/installer');
      const inst = installers[0];
      return { type: 'installer', url: inst.url, mc: version, build: `installer ${inst.version}`, checksum: { sha1: await mavenSha1(inst.url) }, file: 'installer.jar',
        installerArgs: `install server ${version} --install-dir=. --download-server`, launch: ['jar:quilt-server-launch.jar'], java };
    }
    case 'neoforge': {
      const list = await neoforgeVersions();
      const e = list.find((x) => x.id === version);
      if (!e) throw Object.assign(new Error(`Für NeoForge gibt es keine Version für Minecraft ${version}.`), { status: 404 });
      const url = `${URLS.neoforgeBase}/${e.build}/neoforge-${e.build}-installer.jar`;
      return { type: 'installer', url, mc: version, build: e.build, checksum: { sha1: await mavenSha1(url) }, file: 'installer.jar',
        installerArgs: '--installServer', launch: [`args:libraries/net/neoforged/neoforge/${e.build}/unix_args.txt`], java };
    }
    case 'forge': {
      const j = await getJson(URLS.forgePromos);
      const fv = (j.promos || {})[`${version}-recommended`] || (j.promos || {})[`${version}-latest`];
      if (!fv) throw Object.assign(new Error(`Für Forge gibt es keine Version für Minecraft ${version}.`), { status: 404 });
      const full = `${version}-${fv}`;
      const url = `${URLS.forgeBase}/${full}/forge-${full}-installer.jar`;
      return { type: 'installer', url, mc: version, build: fv, checksum: { sha1: await mavenSha1(url) }, file: 'installer.jar',
        installerArgs: '--installServer',
        launch: [`args:libraries/net/minecraftforge/forge/${full}/unix_args.txt`, `jar:forge-${full}.jar`, `jar:forge-${full}-universal.jar`, `jar:forge-${full}-server.jar`], java };
    }
    default: throw Object.assign(new Error('Diese Software wird nicht unterstützt.'), { status: 400 });
  }
}

// ---- what is installed now ------------------------------------------------------------------------

const STATE_FILE = '.blockhaus-software.json';

function readInstalled(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); } catch { return null; }
}

/** The jar name Crafty starts: from "-jar x.jar" in the command, else the executable's file name. */
function jarNameOf(server) {
  const m = /-jar\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(server.execution_command || '');
  const raw = m ? (m[2] || m[3] || m[4]) : (server.executable || '');
  const name = path.basename(String(raw).replace(/\\/g, '/'));
  return /^[\w.\- ]+$/.test(name) && name ? name : null;
}

const LAUNCHER_JAR = path.join(__dirname, '..', 'assets', 'blockhaus-launcher.jar');

/**
 * Replace the server software. Caller has checked that the server is stopped.
 * @param {object} o { dir, server, kind, version, job }
 */
async function install({ dir, server, kind, version, job }) {
  const jarName = jarNameOf(server);
  if (!jarName) throw new Error('Der Name der Start-Datei (jar) konnte aus der Crafty-Konfiguration nicht gelesen werden.');
  const say = (m) => { if (job) job.message = m; };
  say('Suche Download …');
  const r = await resolve(kind, version);
  const chown = chownLike(dir);
  const work = path.join(dir, '.blockhaus-dl');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  chown(work);
  try {
    const dl = path.join(work, r.file.replace(/[^\w.-]/g, '_'));
    say('Lade herunter …');
    await downloadFile(r.url, dl, {
      ...r.checksum, maxBytes: 1024 ** 3,
      onProgress: (n, total) => { if (job) { job.progress = total ? n / total : null; job.message = `Lade herunter … ${(n / 1048576).toFixed(0)} MB`; } },
    });
    const target = path.join(dir, jarName);
    const prev = target + '.blockhaus-prev';
    say('Tausche Datei …');
    if (fs.existsSync(target)) { await fsp.rm(prev, { force: true }); await fsp.rename(target, prev); }
    const launchProps = path.join(dir, 'blockhaus-launch.properties');
    if (r.type === 'jar') {
      await fsp.rename(dl, target);
      chown(target);
      await fsp.rm(launchProps, { force: true });
    } else {
      await fsp.mkdir(path.join(dir, 'blockhaus'), { recursive: true });
      chown(path.join(dir, 'blockhaus'));
      const instPath = path.join(dir, 'blockhaus', 'installer.jar');
      await fsp.rename(dl, instPath);
      chown(instPath);
      await fsp.copyFile(LAUNCHER_JAR, target);
      chown(target);
      const marker = `blockhaus/installed-${kind}-${r.mc}-${(r.build || '').replace(/[^\w.-]/g, '_')}`;
      const lines = [
        'installer.jar=blockhaus/installer.jar',
        `installer.args=${r.installerArgs}`,
        `installer.marker=${marker}`,
        ...r.launch.map((l, i) => `launch.${i + 1}=${l}`),
      ];
      writeFileKeepOwner(launchProps, lines.join('\n') + '\n');
    }
    const state = { software: kind, version: r.mc, build: r.build || null, installedAt: new Date().toISOString(), jar: jarName, launcher: r.type === 'installer', java: r.java };
    writeFileKeepOwner(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
    say('Fertig.');
    return { ...state, firstStartInstalls: r.type === 'installer' };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

module.exports = { KINDS, kindInfo, listVersions, resolve, install, readInstalled, jarNameOf, cmpVersion, neoforgeToMc, javaFor, STATE_FILE, LAUNCHER_JAR, isStableMc };
