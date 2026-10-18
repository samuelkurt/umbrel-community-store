'use strict';
// Mods (Fabric/Quilt/Forge/NeoForge) and plugins (Paper/Purpur): list, enable/disable, delete, upload, Modrinth install.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zipLib = require('./zip');
const { getJson, downloadFile } = require('./download');
const { writeFileKeepOwner, chownLike } = require('./fsutil');
const software = require('./software');

const MODRINTH = process.env.BLOCKHAUS_MODRINTH || 'https://api.modrinth.com/v2';
const MANIFEST = '.blockhaus-mods.json';
const FILE_RE = /^[\w][\w.+() \-]{0,150}\.jar(\.disabled)?$/;

const LOADERS = {
  fabric: ['fabric'], quilt: ['quilt', 'fabric'], forge: ['forge'], neoforge: ['neoforge'],
  paper: ['paper', 'spigot', 'bukkit'], purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
};

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

/** Which folder holds the add-ons for this server, and who loads them? */
function layout(dir, installed) {
  const sw = installed && installed.software;
  const info = sw ? software.kindInfo(sw) : null;
  let folder = info ? info.mods : null;
  let software_ = sw || null;
  if (!folder) {
    if (sw === 'vanilla' || sw === 'snapshot') return { folder: null, software: sw, loaders: [], reason: 'Vanilla kennt keine Mods oder Plugins. Wechsle unter „Software“ auf Fabric, Forge, NeoForge, Quilt, Paper oder Purpur.' };
    for (const f of ['mods', 'plugins']) if (fs.existsSync(path.join(dir, f))) { folder = f; break; }
    if (!folder) return { folder: null, software: software_, loaders: [], reason: 'Die installierte Software ist unbekannt. Installiere unter „Software“ eine Variante mit Mods oder Plugins.' };
  }
  return { folder, software: software_, loaders: LOADERS[sw] || [], kind: folder === 'plugins' ? 'plugin' : 'mod' };
}

function readManifest(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return { files: {} }; } }
function writeManifest(dir, m) { writeFileKeepOwner(path.join(dir, MANIFEST), JSON.stringify(m, null, 2) + '\n'); }

function unq(s) { return s.trim().replace(/^['"]|['"]$/g, ''); }

/** Pull name/version/id out of a jar. Best effort: never throws. */
async function jarMeta(file) {
  const meta = { loader: null, id: null, name: null, version: null, description: null };
  let entries;
  try { entries = await zipLib.readEntries(file); } catch { return meta; }
  const find = (n) => entries.find((e) => e.name === n);
  const read = async (n) => { try { return (await zipLib.readEntryBuffer(file, find(n))).toString('utf8'); } catch { return null; } };
  let t;
  if (find('fabric.mod.json') && (t = await read('fabric.mod.json'))) {
    try { const j = JSON.parse(t); Object.assign(meta, { loader: 'fabric', id: j.id, name: j.name || j.id, version: j.version, description: j.description || null }); return meta; } catch { /* fall through */ }
  }
  if (find('quilt.mod.json') && (t = await read('quilt.mod.json'))) {
    try { const j = JSON.parse(t).quilt_loader || {}; Object.assign(meta, { loader: 'quilt', id: j.id, name: (j.metadata && j.metadata.name) || j.id, version: j.version, description: (j.metadata && j.metadata.description) || null }); return meta; } catch { /* fall through */ }
  }
  for (const [n, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    if (find(n) && (t = await read(n))) {
      const pick = (k) => { const m = new RegExp(`^\\s*${k}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'm').exec(t); return m ? (m[2] !== undefined ? m[2] : m[3]) : null; };
      const version = pick('version');
      Object.assign(meta, { loader, id: pick('modId'), name: pick('displayName') || pick('modId'), version: version && version.includes('${') ? null : version, description: null });
      return meta;
    }
  }
  for (const n of ['paper-plugin.yml', 'plugin.yml']) {
    if (find(n) && (t = await read(n))) {
      const pick = (k) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(t); return m ? unq(m[1]) : null; };
      Object.assign(meta, { loader: 'bukkit', id: pick('name'), name: pick('name'), version: pick('version'), description: pick('description') });
      return meta;
    }
  }
  return meta;
}

async function list(dir, installed) {
  const lay = layout(dir, installed);
  if (!lay.folder) return { ...lay, items: [] };
  const fdir = path.join(dir, lay.folder);
  const manifest = readManifest(dir);
  let names = [];
  try { names = fs.readdirSync(fdir); } catch { /* folder not created yet */ }
  const items = [];
  for (const n of names.sort((a, b) => a.localeCompare(b))) {
    if (!FILE_RE.test(n)) continue;
    const file = path.join(fdir, n);
    const st = fs.statSync(file);
    if (!st.isFile()) continue;
    const meta = await jarMeta(file);
    const m = manifest.files[`${lay.folder}/${n.replace(/\.disabled$/, '')}`];
    items.push({ file: n, enabled: !n.endsWith('.disabled'), size: st.size, ...meta, modrinth: m ? { project: m.project, title: m.title } : null });
  }
  return { ...lay, items };
}

function checkFile(lay, name) {
  if (!lay.folder) throw bad(lay.reason || 'Keine Mods/Plugins möglich.');
  if (!FILE_RE.test(String(name))) throw bad('Ungültiger Dateiname.');
}

function toggle(dir, lay, name) {
  checkFile(lay, name);
  const f = path.join(dir, lay.folder, name);
  if (!fs.existsSync(f)) throw bad('Datei nicht gefunden.', 404);
  const to = name.endsWith('.disabled') ? name.slice(0, -'.disabled'.length) : name + '.disabled';
  const target = path.join(dir, lay.folder, to);
  if (fs.existsSync(target)) throw bad('Es gibt schon eine Datei mit dem Zielnamen.', 409);
  fs.renameSync(f, target);
  return to;
}

async function remove(dir, lay, name) {
  checkFile(lay, name);
  const f = path.join(dir, lay.folder, name);
  if (!fs.existsSync(f)) throw bad('Datei nicht gefunden.', 404);
  await fsp.rm(f);
  const m = readManifest(dir);
  const key = `${lay.folder}/${name.replace(/\.disabled$/, '')}`;
  if (m.files[key]) { delete m.files[key]; writeManifest(dir, m); }
}

// ---- Modrinth -------------------------------------------------------------------------------------

async function search(lay, mcVersion, { query = '', offset = 0 } = {}) {
  if (!lay.folder) throw bad(lay.reason || 'Keine Mods/Plugins möglich.');
  const facets = [[`project_type:${lay.kind}`], lay.loaders.map((l) => `categories:${l}`)];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  const qs = new URLSearchParams({ query, facets: JSON.stringify(facets), limit: '20', offset: String(Math.max(0, Number(offset) || 0)), index: query ? 'relevance' : 'downloads' });
  const j = await getJson(`${MODRINTH}/search?${qs}`);
  return {
    total: j.total_hits,
    hits: (j.hits || []).map((h) => ({ project: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, icon: h.icon_url || null })),
  };
}

function modrinthHostOk(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'cdn.modrinth.com' || u.hostname.endsWith('.modrinth.com')); } catch { return false; }
}

async function pickVersion(project, lay, mcVersion) {
  const qs = new URLSearchParams({ loaders: JSON.stringify(lay.loaders) });
  if (mcVersion) qs.set('game_versions', JSON.stringify([mcVersion]));
  const versions = await getJson(`${MODRINTH}/project/${encodeURIComponent(project)}/version?${qs}`);
  if (!Array.isArray(versions) || !versions.length) return null;
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

/**
 * Install a Modrinth project plus its required dependencies.
 * Returns the list of files that were written.
 */
async function installFromModrinth({ dir, lay, mcVersion, project, job, depth = 0, seen = new Set() }) {
  if (!lay.folder) throw bad(lay.reason || 'Keine Mods/Plugins möglich.');
  if (depth > 4) throw bad('Zu viele verschachtelte Abhängigkeiten.');
  if (seen.has(project)) return [];
  seen.add(project);
  const manifest = readManifest(dir);
  const already = Object.values(manifest.files).find((f) => f.project === project);
  if (already && fs.existsSync(path.join(dir, already.path))) return [];
  const v = await pickVersion(project, lay, mcVersion);
  if (!v) throw bad(`Für ${project} gibt es keine Version für ${lay.software || 'diese Software'}${mcVersion ? ' und Minecraft ' + mcVersion : ''}.`, 404);
  const file = v.files.find((f) => f.primary) || v.files[0];
  if (!file || !/\.jar$/i.test(file.filename)) throw bad('Dieses Projekt liefert keine .jar-Datei.');
  if (!modrinthHostOk(file.url)) throw bad('Unerwartete Download-Adresse: ' + file.url);
  const name = file.filename.replace(/[^\w.+() \-]/g, '_');
  const fdir = path.join(dir, lay.folder);
  await fsp.mkdir(fdir, { recursive: true });
  chownLike(dir)(fdir);
  const target = path.join(fdir, name);
  const written = [];
  // dependencies first
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id) {
      if (job) job.message = `Abhängigkeit ${d.project_id} …`;
      written.push(...await installFromModrinth({ dir, lay, mcVersion, project: d.project_id, job, depth: depth + 1, seen }));
    }
  }
  if (fs.existsSync(target) || fs.existsSync(target + '.disabled')) throw bad(`„${name}“ gibt es schon.`, 409);
  if (job) job.message = `Lade ${name} …`;
  await downloadFile(file.url, target, { sha512: file.hashes && file.hashes.sha512, sha1: file.hashes && !file.hashes.sha512 ? file.hashes.sha1 : undefined, maxBytes: 512 * 1024 * 1024 });
  chownLike(dir)(target);
  const m = readManifest(dir);
  m.files[`${lay.folder}/${name}`] = { project, version: v.version_number, title: v.name, path: `${lay.folder}/${name}` };
  writeManifest(dir, m);
  written.push(name);
  return written;
}

// ---- curated performance list -----------------------------------------------------------------------
// Only mods that exist on Modrinth with a build for the server's loader AND Minecraft version are shown, so the list
// is empty for what does not exist (e.g. Lithium has no Forge build). Texts follow the Modrinth descriptions.
const RECOMMENDED = [
  { slugs: ['lithium'], note: 'Optimiert die Spiel-Logik (Mobs, Chunks, Physik), ohne das Spielgefühl zu ändern.' },
  { slugs: ['ferrite-core'], note: 'Spart Arbeitsspeicher.' },
  { slugs: ['servercore'], note: 'Optimiert den Server an vielen Stellen.' },
  { slugs: ['modernfix'], note: 'Weniger Speicherverbrauch, schnellerer Start, viele Fehlerbehebungen.' },
  { slugs: ['c2me-fabric'], note: 'Verbessert die Chunk-Leistung (Fabric).' },
  { slugs: ['vmp-fabric'], note: 'Hilft bei vielen Spielern gleichzeitig (Fabric).' },
  { slugs: ['krypton'], note: 'Optimiert den Netzwerk-Teil von Minecraft.' },
  { slugs: ['noisium'], note: 'Schnellere Welt-Generierung.' },
  { slugs: ['ksyxis'], note: 'Schnelleres Laden der Welt: lädt unnötige Chunks nicht.' },
  { slugs: ['clumps', 'ly-clumps'], note: 'Fasst Erfahrungskugeln zusammen, das spart Lag.' },
  { slugs: ['ai-improvements'], note: 'Schnellere Mob-KI, einzelne KI-Verhalten lassen sich abschalten.' },
  { slugs: ['adaptive-performance-tweaks'], note: 'Passt Server-Einstellungen automatisch an, damit die TPS stabil bleiben.' },
  { slugs: ['memoryleakfix'], note: 'Behebt Speicherlecks.' },
  { slugs: ['chunky'], note: 'Berechnet die Welt vorab, dann gibt es weniger Ruckler beim Erkunden. Läuft nur, wenn du es startest.' },
  { slugs: ['spark'], note: 'Messwerkzeug: zeigt, was den Server bremst. Macht nicht selbst schneller.' },
];
const ALT_LOADER = { forge: 'neoforge' };

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function recommended(dir, lay, mcVersion) {
  if (!lay.folder) throw bad(lay.reason || 'Keine Mods/Plugins möglich.');
  const ids = [...new Set(RECOMMENDED.flatMap((g) => g.slugs))];
  const projects = await getJson(`${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const manifest = readManifest(dir);
  const known = new Set(Object.values(manifest.files).map((f) => f.project));
  let jars = [];
  // jar names start with the mod's name ("ferritecore-9.0.0-neoforge.jar"); compare without separators or leading [1.20.1] tags
  const loose = (t) => t.toLowerCase().replace(/^(\[[^\]]*\]|\([^)]*\))+/, '').replace(/[^a-z0-9]/g, '');
  try { jars = fs.readdirSync(path.join(dir, lay.folder)).map(loose); } catch { /* no folder yet */ }
  const altLoader = ALT_LOADER[lay.software];
  const lookup = async (g) => {
    for (const slug of g.slugs) {
      const p = bySlug.get(slug);
      if (!p) continue;
      let v = null;
      try { v = await pickVersion(slug, lay, mcVersion); } catch { /* Modrinth hiccup: treat as not available */ }
      if (v) {
        const base = slug.replace(/^ly-/, '').replace(/-(fabric|forge|neoforge)$/, '');
        return { ok: true, item: {
          slug, project: p.id, title: p.title, note: g.note, version: v.version_number, versionType: v.version_type,
          server: p.server_side, client: p.client_side, icon: p.icon_url || null,
          installed: known.has(p.id) || known.has(slug) || jars.some((n) => n.startsWith(loose(base))),
        } };
      }
    }
    // not available for this loader: is it for the alternative loader?
    let alt = false;
    if (altLoader) {
      for (const slug of g.slugs) {
        if (!bySlug.get(slug)) continue;
        try { if (await pickVersion(slug, { loaders: [altLoader] }, mcVersion)) { alt = true; break; } } catch { /* ignore */ }
      }
    }
    const p0 = g.slugs.map((s) => bySlug.get(s)).find(Boolean);
    // Fabric-only mods are not "missing" on Forge, they just do not apply there
    const fabricOnly = g.slugs.every((s) => /-fabric$/.test(s)) && !lay.loaders.includes('fabric');
    return { ok: false, title: p0 ? p0.title : g.slugs[0], alt, skip: fabricOnly };
  };
  const res = await pool(RECOMMENDED, 5, lookup);
  return {
    items: res.filter((x) => x.ok).map((x) => x.item),
    // for plugin servers the list of unavailable mods would only be noise
    missing: lay.kind === 'plugin' ? [] : res.filter((x) => !x.ok && x.title && !x.skip).map((x) => x.title),
    alt: altLoader ? { loader: altLoader, titles: res.filter((x) => !x.ok && x.alt).map((x) => x.title) } : null,
  };
}

module.exports = { layout, list, toggle, remove, search, recommended, installFromModrinth, jarMeta, FILE_RE, LOADERS, MANIFEST };
