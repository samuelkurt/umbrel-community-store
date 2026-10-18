const { execFileSync } = require('child_process');
const packs = require('../../lib/packs');
const vals = { pack_format: [undefined, 0, 14, 15, 34, 46, 50, 63, 64, 65, 69, 97, 46.5, '46'],
  supported_formats: [undefined, [34,63], [34,66], [64,65], [64,64], [65,65], [34, 46], [34, 64], [34, 65], [10, 46], [46, 46], 46, { min_inclusive: 34, max_inclusive: 64 }, [65, 97], [1,2,3]],
  min_format: [undefined, 34, 46, 64, 65, 97, [97, 1], [65, 0], 98, 'x'],
  max_format: [undefined, 34, 46, 63, 64, 65, 97, [97, 1], [98, 0], 99] };
const cases = []; let seed = 8; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 1800; i++) {
  const p = {};
  for (const k of Object.keys(vals)) { const v = vals[k][Math.floor(rnd() * vals[k].length)]; if (v !== undefined) p[k] = v; }
  cases.push(p);
}
const args = cases.map((p) => JSON.stringify({ description: 'x', ...p }));
const J = process.env.JAVA25 || 'java';
const CP = process.env.MC_CLASSPATH;
const out = execFileSync(J, ['-cp', CP, 'T', '97', '1', ...args], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n');
let bad = 0, n = 0; const seen = new Set();
for (let i = 0; i < out.length; i++) {
  const m = /STDOUT\]: (\{.*\})$/.exec(out[i]); if (!m) continue;
  const res = out[i + 1] || ''; const javaOk = /-> OK/.test(res); const pack = JSON.parse(m[1]); delete pack.description;
  const js = packs.metaProblems(pack, true); const jsOk = js.length === 0; n++;
  if (javaOk !== jsOk) { bad++; const key = JSON.stringify(pack); if (!seen.has(key) && seen.size < 15) { seen.add(key); console.log('MISMATCH', key, '\n  java:', res.trim(), '\n  js:  ', js.join(' | ') || 'OK'); } }
}
console.log(`${n} cases, ${bad} mismatches`);
