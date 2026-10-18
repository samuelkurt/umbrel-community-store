'use strict';
const fs = require('node:fs');
const path = require('node:path');

class PathError extends Error {}

/**
 * Resolve a user-supplied relative path inside `root`.
 * Rejects absolute paths, `..`, NUL bytes and symlinks that lead out of `root`.
 * The target does not have to exist (its closest existing parent is checked).
 */
function resolveInside(root, rel) {
  const r = String(rel === undefined || rel === null ? '' : rel);
  if (r.includes('\0')) throw new PathError('Ungültiger Pfad.');
  if (path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) throw new PathError('Ungültiger Pfad.');
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, r.replace(/\\/g, '/'));
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) throw new PathError('Der Pfad liegt außerhalb des Server-Ordners.');
  // follow symlinks on the part that exists
  let probe = target;
  while (probe !== rootReal) {
    try {
      const real = fs.realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new PathError('Der Pfad führt über einen Symlink aus dem Server-Ordner.');
      break;
    } catch (e) {
      if (e instanceof PathError) throw e;
      if (e.code !== 'ENOENT') throw e;
      probe = path.dirname(probe);
    }
  }
  return target;
}

/** A single file/folder name, no separators. */
function validName(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 200) throw new PathError('Ungültiger Name.');
  return n;
}

module.exports = { resolveInside, validName, PathError };
