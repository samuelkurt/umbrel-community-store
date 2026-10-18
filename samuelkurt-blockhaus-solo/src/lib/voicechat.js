'use strict';
// Simple Voice Chat (mod or plugin): finds its server config and sets the two values that decide whether
// players behind a tunnel can reach it: `port` (UDP) and `voice_host` (the address the clients are told to use).
const fs = require('node:fs');
const path = require('node:path');
const props = require('./props');
const serverfiles = require('./serverfiles');
const { writeFileKeepOwner } = require('./fsutil');

const CONFIGS = ['config/voicechat/voicechat-server.properties', 'plugins/voicechat/voicechat-server.properties'];
const JAR_RE = /voice[-_ ]?chat/i;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function findConfig(dir) {
  for (const rel of CONFIGS) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) return { rel, file };
  }
  return null;
}

function findJars(dir) {
  const out = [];
  for (const folder of ['mods', 'plugins']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, folder)); } catch { continue; }
    for (const n of names) if (JAR_RE.test(n) && /\.jar(\.disabled)?$/i.test(n)) out.push({ folder, file: n, enabled: !/\.disabled$/i.test(n) });
  }
  return out;
}

/** What the server log says about the last start (the mod logs the UDP port it opened). */
function fromLog(dir) {
  let text = '';
  try { text = serverfiles.readLog(dir, 'latest.log', 512 * 1024); } catch { return { startedPort: null, line: null }; }
  let startedPort = null; let line = null;
  for (const l of text.split('\n')) {
    const m = /\[voicechat\].*Voice chat server started at port (\d+)/i.exec(l);
    if (m) { startedPort = Number(m[1]); line = l.trim().slice(0, 200); }
  }
  return { startedPort, line };
}

function read(dir) {
  const cfg = findConfig(dir);
  let values = {};
  if (cfg) values = props.parse(fs.readFileSync(cfg.file, 'utf8')).values;
  return {
    jars: findJars(dir),
    config: cfg ? cfg.rel : null,
    port: values.port !== undefined ? values.port : null,
    bindAddress: values.bind_address !== undefined ? values.bind_address : null,
    voiceHost: values.voice_host !== undefined ? values.voice_host : null,
    log: fromLog(dir),
  };
}

/** Replace/append `key=value` without escaping (':' in "host:port" is valid in a .properties value). Other lines stay as they are. */
function setPlain(parsed, changes) {
  const lines = parsed.lines.slice();
  let trailingBlank = false;
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailingBlank = true; }
  for (const [key, value] of Object.entries(changes)) {
    const line = `${key}=${value}`;
    if (key in parsed.index) lines[parsed.index[key]] = line; else lines.push(line);
  }
  return lines.join(parsed.eol) + (trailingBlank || lines.length ? parsed.eol : '');
}

function validate({ port, voice_host: host }) {
  const out = {};
  if (port !== undefined && port !== null && port !== '') {
    const n = Number(port);
    if (!Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 65535))) throw bad('Der Port muss eine Zahl von 1 bis 65535 sein (oder -1 für den Minecraft-Port).');
    out.port = String(n);
  }
  if (host !== undefined && host !== null) {
    const t = String(host).trim();
    if (t) {
      const m = /^(.*?)(?::(\d{1,5}))?$/.exec(t);
      if (!m || !HOST_RE.test(m[1]) || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
        throw bad('„voice_host“ ist eine Adresse wie abc.example.com oder abc.example.com:12345, ohne http:// und ohne Schrägstriche.');
      }
    }
    out.voice_host = t;
  }
  return out;
}

function write(dir, body) {
  const cfg = findConfig(dir);
  if (!cfg) throw bad('Die Konfigurationsdatei des Voice-Chats gibt es noch nicht. Der Mod legt sie beim ersten Start des Servers an. Starte den Server einmal und öffne die Seite danach wieder.', 404);
  const changes = validate(body || {});
  if (!Object.keys(changes).length) return { changed: 0 };
  const old = fs.readFileSync(cfg.file);
  const parsed = props.parse(old.toString('utf8'));
  const out = setPlain(parsed, changes);
  writeFileKeepOwner(cfg.file + '.blockhaus.bak', old);
  writeFileKeepOwner(cfg.file, out);
  return { changed: Object.keys(changes).length, config: cfg.rel };
}

module.exports = { read, write, validate, setPlain, findConfig, findJars, fromLog, CONFIGS };
