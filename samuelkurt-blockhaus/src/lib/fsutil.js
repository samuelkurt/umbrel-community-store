'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Atomically write a file inside a Minecraft server folder and keep the owner/mode of the
 * file it replaces (or, for a new file, of the folder). This panel runs as root so it can
 * write there, but the files must stay usable by the account Crafty runs the server as.
 */
function writeFileKeepOwner(file, data) {
  const dir = path.dirname(file);
  let ref;
  let mode = 0o644;
  try { ref = fs.statSync(file); mode = ref.mode & 0o777; } catch { ref = fs.statSync(dir); }
  const tmp = path.join(dir, '.' + path.basename(file) + '.blockhaus-tmp');
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* ignore */ }
  try { fs.chownSync(tmp, ref.uid, ref.gid); } catch { /* not root: nothing to preserve */ }
  fs.renameSync(tmp, file);
}

module.exports = { writeFileKeepOwner };
