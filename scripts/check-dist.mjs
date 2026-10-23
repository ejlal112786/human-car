/**
 * Static release check for a Vite build output folder. No dependencies (plain Node).
 *
 *   node scripts/check-dist.mjs dist          # release build: QA hook must be ABSENT
 *   node scripts/check-dist.mjs dist-qa --qa  # QA build: QA hook must be PRESENT (positive control)
 *
 * Runs automatically at the end of `npm run build`. Exits non-zero on any failure.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, extname } from 'node:path';

const args = process.argv.slice(2);
const qaMode = args.includes('--qa');
const dir = resolve(args.find((a) => !a.startsWith('--')) || 'dist');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(dir)) {
  console.error(`FAIL  build folder not found: ${dir}`);
  process.exit(1);
}

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dir);
const rel = (p) => relative(dir, p).split('\\').join('/');
const textExt = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.webmanifest']);
const texts = new Map(files.filter((f) => textExt.has(extname(f))).map((f) => [f, readFileSync(f, 'utf8')]));

// 1. Entry point and referenced assets
const indexPath = join(dir, 'index.html');
check('index.html exists at the folder root', existsSync(indexPath));
const html = texts.get(indexPath) ?? '';
const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'));
check('index.html references built assets (not /src/main.ts)', refs.some((r) => r.endsWith('.js')) && !html.includes('/src/main.ts'), refs.join(', '));
const absolute = refs.filter((r) => r.startsWith('/') || /^[a-z]+:/i.test(r));
check('all index.html asset URLs are relative (sub-path safe)', absolute.length === 0, absolute.join(', ') || `${refs.length} relative refs`);
const missing = refs.filter((r) => !existsSync(join(dir, r.split(/[?#]/)[0])));

// JS chunk imports: static `from"./x.js"`, dynamic `import("./x.js")`, and `new URL("./x", import.meta.url)`
for (const [f, src] of texts) {
  if (extname(f) !== '.js') continue;
  const specs = [
    ...src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g),
    ...src.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g),
  ].map((m) => m[1]);
  for (const s of specs) if (!existsSync(join(dirname(f), s))) missing.push(`${rel(f)} -> ${s}`);
}
check('every referenced file exists in the build', missing.length === 0, missing.join(', ') || 'all present');

const absAssetRefs = [];
for (const [f, src] of texts) if (/["'`(]\/assets\//.test(src)) absAssetRefs.push(rel(f));
check('no root-absolute "/assets/" URLs', absAssetRefs.length === 0, absAssetRefs.join(', ') || 'none');

// 2. Nothing environment- or machine-specific leaked into the bundle
const leaks = [];
const leakPatterns = [/localhost/, /127\.0\.0\.1/, /\/home\/[a-z]/, /[A-Z]:\\\\Users/, /file:\/\//, /\.ts["']/];
for (const [f, src] of texts) for (const re of leakPatterns) if (re.test(src)) leaks.push(`${rel(f)}: ${re}`);
check('no localhost / local filesystem paths / .ts sources referenced', leaks.length === 0, leaks.join(', ') || 'none');
const junk = files.map(rel).filter((p) => p.endsWith('.map') || /(^|\/)\.env/.test(p) || p.endsWith('.ts'));
check('no source maps, .env files or TypeScript sources shipped', junk.length === 0, junk.join(', ') || 'none');

// 3. Automated-test hook
const hookMarkers = ['__cityRacer', 'qaAdvance', 'debugTeleport', 'debugTeleportCharacter', 'debugFlip', 'renderInfo', 'qaFreeze', 'setCameraYaw', 'buildingAt'];
const found = new Set();
for (const src of texts.values()) for (const m of hookMarkers) if (src.includes(m)) found.add(m);
// URL switches like "?qa", "?qa=1", "&qa", "#..." or searchParams.has('qa'). In a URL, 'qa' is followed by a quote,
// '=', '&' or '#'. The minifier is free to name a function 'qa', so 'a&&qa(b)' or 'c?qa(x):y' must not match.
const QA_SWITCH = /\.has\(\s*["'`]qa["'`]\s*\)|\?qa(?=["'`=&#])|(?<!&)&qa(?=["'`=&#])/;
const urlSwitch = [...texts.values()].some((src) => QA_SWITCH.test(src));
if (qaMode) {
  check('QA build: test hook present (positive control for this check)', found.size === hookMarkers.length, [...found].join(', '));
} else {
  check('release build: test hook / teleport / time-advance code absent', found.size === 0, found.size ? `found ${[...found].join(', ')}` : 'none of ' + hookMarkers.join(', '));
  check('release build: no ?qa URL switch', !urlSwitch, urlSwitch ? 'found' : 'none');
}

// 4. Player-facing text: no development-phase / prototype / test wording in the UI
const devText = [];
const devPatterns = [/Phase\s*1/i, /\bprototype\b/i, /\bplaceholder\b/i, /\bQA build\b/i, /\bdebug mode\b/i, /lorem ipsum/i];
for (const [f, src] of texts) {
  if (!['.html', '.js', '.css'].includes(extname(f))) continue;
  // three.js / rapier vendor chunks contain the word "prototype" (JavaScript): only check app code and HTML.
  if (/three|rapier/i.test(rel(f))) continue;
  for (const re of devPatterns) {
    const m = src.match(re);
    if (m && !(re.source.includes('prototype') && /\.prototype\b|prototype\./.test(src.slice(Math.max(0, m.index - 1), m.index + 11)))) devText.push(`${rel(f)}: ${m[0]}`);
  }
}
check('no development / prototype / placeholder text in the player UI', devText.length === 0, devText.join(', ') || 'none');
const assets = files.map(rel);
check('character model bundled locally (no runtime third-party URLs)', assets.some((a) => a.endsWith('.glb')), assets.filter((a) => a.endsWith('.glb')).join(', ') || 'missing');
const external = [];
for (const [f, src] of texts) {
  const m = src.match(/https?:\/\/(?!www\.w3\.org|github\.com\/mrdoob|threejs\.org|rapier\.rs|dimforge)[a-z0-9.-]+\.[a-z]{2,}\/[^"'\s)]*\.(?:glb|gltf|png|jpg|mp3|ogg|wasm|js|css|woff2?)/i);
  if (m) external.push(`${rel(f)}: ${m[0]}`);
}
check('no runtime asset downloads from third-party URLs', external.length === 0, external.join(', ') || 'none');

// 5. Summary
const total = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`\n${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB in ${rel(dir) || dir}`);
for (const f of files) console.log(`  ${rel(f).padEnd(34)} ${(statSync(f).size / 1024).toFixed(1).padStart(9)} kB`);
console.log(failures === 0 ? `\nDIST CHECK PASSED (${qaMode ? 'QA' : 'release'} build)` : `\n${failures} DIST CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
