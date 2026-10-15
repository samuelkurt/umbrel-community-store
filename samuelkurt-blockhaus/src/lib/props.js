'use strict';
// server.properties reader/writer. Unchanged lines (comments, order, odd spacing) stay byte-identical;
// only lines of changed keys are rewritten, new keys are appended.

function unescapeValue(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'f') out += '\f';
    else out += n;
  }
  return out;
}

function escapeValue(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === ':' || ch === '=' || ch === '#' || ch === '!') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code > 126 || code < 32) {
      // \uXXXX works for servers that read the file as ISO-8859-1 as well as UTF-8.
      if (code > 0xffff) {
        const c = code - 0x10000;
        out += '\\u' + (0xd800 + (c >> 10)).toString(16).padStart(4, '0') +
               '\\u' + (0xdc00 + (c & 0x3ff)).toString(16).padStart(4, '0');
      } else out += '\\u' + code.toString(16).padStart(4, '0');
    } else out += ch;
  }
  // a leading space would be dropped on reading
  return out.replace(/^ /, '\\ ');
}

/** Split a line into key and raw value (first unescaped = or :). */
function splitLine(line) {
  const m = /^\s*((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(line);
  if (!m) return null;
  return { key: unescapeValue(m[1]), raw: m[2] };
}

function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const values = {};
  const index = {};
  lines.forEach((line, i) => {
    if (/^\s*$/.test(line) || /^\s*[#!]/.test(line)) return;
    const kv = splitLine(line);
    if (!kv) return;
    values[kv.key] = unescapeValue(kv.raw);
    index[kv.key] = i;
  });
  return { lines, eol, values, index };
}

/** Apply `changes` ({key: string}) to a parsed file and return the new text. */
function apply(parsed, changes) {
  const lines = parsed.lines.slice();
  // drop a trailing empty element so appended keys follow the last real line
  let trailingBlank = false;
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailingBlank = true; }
  for (const [key, value] of Object.entries(changes)) {
    if (/[\r\n]/.test(key) || key.trim() === '') throw new Error('Ungültiger Schlüssel: ' + JSON.stringify(key));
    const line = escapeValue(key).replace(/^\\ /, '\\ ') + '=' + escapeValue(value);
    if (key in parsed.index) lines[parsed.index[key]] = line;
    else lines.push(line);
  }
  return lines.join(parsed.eol) + (trailingBlank || lines.length ? parsed.eol : '');
}

module.exports = { parse, apply, escapeValue, unescapeValue };
