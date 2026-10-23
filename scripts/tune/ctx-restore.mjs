// Dev probe: render a frozen view, lose + restore the WebGL context, re-render the same view, diff pixels.
//   node scripts/tune/ctx-restore.mjs [URL] [outDir]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const URL = process.argv[2] || 'http://localhost:4174/';
const OUT = process.argv[3] || '/tmp/shots/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => { const h = window.__cityRacer; h.qaFreeze(true); h.startLevel(-1); h.qaAdvance(2); });
// Let the crowd animate briefly in real time so some people are mid-blend, then freeze and aim.
await H(() => window.__cityRacer.qaFreeze(false));
await page.waitForTimeout(600);
const yaw = await H(() => {
  const h = window.__cityRacer; h.qaFreeze(true);
  const me = h.snapshot().character;
  const n = h.cityInfo().peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - me.x, q.z - me.z) })).sort((a, b) => a.d - b.d)[0];
  return Math.atan2(n.x - me.x, n.z - me.z);
});
// Render synchronously and read the drawing buffer in the same task.
const grab = () => H((a) => {
  const h = window.__cityRacer;
  h.setCameraYaw(a);
  const c = document.querySelector('canvas.game-canvas');
  const exact = h.cityInfo().peds.draw.flatMap((m) => m.poses).filter((q) => q[0] >= h.cityInfo().peds.exactRow0).length;
  h.setCameraYaw(a);
  return { url: c.toDataURL('image/png'), exact };
}, yaw);
const A = await grab();
await H(() => {
  window.__lose = document.querySelector('canvas.game-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
  window.__lose.loseContext();
});
await page.waitForFunction(() => !document.querySelector('.notice-screen').classList.contains('hidden'), null, { timeout: 60000 });
if (process.argv.includes('--trace-deletes')) {
  await H(() => {
    const P = WebGL2RenderingContext.prototype;
    for (const k of ['deleteTexture', 'deleteFramebuffer', 'deleteRenderbuffer', 'deleteBuffer', 'deleteProgram', 'deleteShader', 'deleteVertexArray']) {
      const f = P[k];
      P[k] = function (o) { if (o) (window.__dels ??= []).push(k + ' ' + (new Error().stack ?? '').split('\n').slice(2, 7).join(' | ')); return f.call(this, o); };
    }
  });
}
await H(() => window.__lose.restoreContext());
await page.waitForFunction(() => document.querySelector('.notice-screen').classList.contains('hidden'), null, { timeout: 120000 });
// Worst case: a crowd update runs before the first frame after the restore (as on the live title screen).
if (process.argv.includes('--update-first')) await H(() => window.__cityRacer.qaFreeze(true)); // renderFrame: crowd update, then render
const B = await grab();
const C = await grab(); // a second frame after restore (anything that only fixes itself later)
const diff = await H(async ([a, b, c]) => {
  const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); const cv = document.createElement('canvas'); cv.width = i.width; cv.height = i.height; const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
  const [da, db, dc] = await Promise.all([load(a), load(b), load(c)]);
  const cmp = (p, q) => { let bad = 0, sum = 0; for (let i = 0; i < p.length; i += 4) { const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])); sum += d; if (d > 24) bad++; } return { badPct: (bad / (p.length / 4)) * 100, mean: sum / (p.length / 4) }; };
  return { first: cmp(da, db), second: cmp(da, dc) };
}, [A.url, B.url, C.url]);
for (const [n, u] of [['before', A.url], ['after', B.url], ['after2', C.url]]) writeFileSync(`${OUT}ctx-${n}.png`, Buffer.from(u.split(',')[1], 'base64'));
if (process.argv.includes('--trace-deletes')) console.log((await H(() => window.__dels ?? [])).slice(0, 8).join('\n'));
console.log(JSON.stringify({ exactBefore: A.exact, exactAfter: B.exact, diff, errors: errs.slice(0, 5) }));
await browser.close();
