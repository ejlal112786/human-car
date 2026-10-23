/**
 * Build-parity check: proves the release build and the QA build (the one the full browser
 * gameplay suite runs against) contain the SAME game code, apart from the test hook.
 *
 *   npm run test:parity
 *
 * Builds both modes unminified into a temp folder, then:
 *   - vendor chunks (three, rapier) and CSS must be byte-identical;
 *   - the game chunk must be identical once the two allowed regions are removed:
 *       1. the body of Game.createTestHook()      (returns null in release)
 *       2. the `if (__QA_HOOK__) { ... }` block in main.ts
 * So every gameplay check passed on the QA build applies to the release build.
 */
import { build } from 'vite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'city-racer-parity-'));
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); if (!ok) failures++; };

async function buildMode(mode) {
  const outDir = join(root, mode);
  await build({ mode, logLevel: 'error', build: { outDir, emptyOutDir: true, minify: false } });
  const assets = join(outDir, 'assets');
  const pick = (prefix, ext) => readFileSync(join(assets, readdirSync(assets).find((f) => f.startsWith(prefix) && f.endsWith(ext))), 'utf8');
  return { game: pick('index-', '.js'), css: pick('index-', '.css'), three: pick('three-', '.js'), rapier: pick('rapier-', '.js') };
}

/** Remove the block that starts at the first line matching `startRe`, up to the line that closes it at the same indent. */
function stripBlock(lines, startRe, label) {
  const i = lines.findIndex((l) => startRe.test(l));
  if (i < 0) throw new Error(`region not found: ${label}`);
  const indent = lines[i].match(/^\s*/)[0];
  if (/;\s*$/.test(lines[i])) return { lines: [...lines.slice(0, i), ...lines.slice(i + 1)], removed: 1 }; // `if (false) ;`
  let j = i + 1;
  while (j < lines.length && lines[j] !== `${indent}}`) j++;
  if (j >= lines.length) throw new Error(`unterminated region: ${label}`);
  return { lines: [...lines.slice(0, i), ...lines.slice(j + 1)], removed: j - i + 1 };
}
function normalise(src) {
  let lines = src.split('\n');
  const a = stripBlock(lines, /^\s*createTestHook\(\)\s*\{\s*$/, 'createTestHook'); lines = a.lines;
  const b = stripBlock(lines, /^\s*if \((true|false)\)\s*(\{|;)\s*$/, 'main.ts hook block'); lines = b.lines;
  return { lines, removed: a.removed + b.removed };
}

try {
  const rel = await buildMode('production');
  const qa = await buildMode('qa');
  check('three.js chunk identical', rel.three === qa.three, `${(rel.three.length / 1024).toFixed(0)} kB`);
  check('rapier chunk identical', rel.rapier === qa.rapier, `${(rel.rapier.length / 1024).toFixed(0)} kB`);
  check('CSS identical', rel.css === qa.css, `${(rel.css.length / 1024).toFixed(1)} kB`);
  // Comment lines are ignored here (the minified release build strips comments; check-dist.mjs
  // verifies the shipped files).
  const code = rel.game.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  check('release game chunk has no hook code', !/__cityRacer|qaAdvance|debugTeleport|debugFlip/.test(code), 'searched non-comment code for hook names');
  const r = normalise(rel.game);
  const q = normalise(qa.game);
  let firstDiff = -1;
  for (let k = 0; k < Math.max(r.lines.length, q.lines.length); k++) if (r.lines[k] !== q.lines[k]) { firstDiff = k; break; }
  check('game code identical outside the two test-hook regions', firstDiff < 0,
    firstDiff < 0 ? `${r.lines.length} lines compared; hook regions: release ${r.removed} lines, QA ${q.removed} lines`
      : `first difference at normalised line ${firstDiff + 1}: release "${r.lines[firstDiff]?.trim()}" vs QA "${q.lines[firstDiff]?.trim()}"`);
} catch (e) {
  check('parity builds', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nBUILD PARITY PASSED' : `\n${failures} PARITY CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
