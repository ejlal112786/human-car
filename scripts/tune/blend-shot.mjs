// Dev probe: screenshot pedestrians caught mid-transition on the exact pose-blend path.
//   node scripts/tune/blend-shot.mjs [URL] [outDir] [count]
import { chromium } from 'playwright';
const URL = process.argv[2] || 'http://localhost:4174/';
const OUT = process.argv[3] || '/tmp/shots/';
const COUNT = Number(process.argv[4] || 3);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => { const h = window.__cityRacer; h.qaFreeze(true); h.startLevel(-1); h.qaAdvance(2); });
let got = 0;
const t0 = Date.now();
while (got < COUNT && Date.now() - t0 < 240000) {
  await H(() => window.__cityRacer.qaFreeze(false));
  let hit = null;
  const t1 = Date.now();
  while (!hit && Date.now() - t1 < 60000) {
    hit = await H(() => {
      const h = window.__cityRacer;
      const me = h.snapshot().character;
      const ps = h.cityInfo().peds.draw.flatMap((m) => m.poses);
      const q = ps.find((p) => p[2] < 0 && Math.hypot(p[4] - me.x, p[5] - me.z) < 30);
      if (!q) return null;
      h.qaFreeze(true);
      return { x: q[4], z: q[5], d: Math.hypot(q[4] - me.x, q[5] - me.z), meX: me.x, meZ: me.z };
    });
    if (!hit) await page.waitForTimeout(120);
  }
  if (!hit) break;
  // Walk the player to ~4 m from the person (QA teleport), face them, re-render.
  await H((p) => {
    const h = window.__cityRacer;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 984; i++) { const t = h.trackPoint(i, 0); const d = (t.x - p.x) ** 2 + (t.z - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
    const side = (o) => { const t = h.trackPoint(best, o); return (t.x - p.x) ** 2 + (t.z - p.z) ** 2; };
    const off = side(9.5) < side(-9.5) ? 9.5 : -9.5;
    h.debugTeleportCharacter((best + 4) % 984, off);
  }, hit);
  const me = await H(() => window.__cityRacer.snapshot().character);
  await H((a) => { const h = window.__cityRacer; h.setCameraYaw(a); h.snapCamera?.(); h.setCameraYaw(a); }, Math.atan2(hit.x - me.x, hit.z - me.z));
  const still = await H(() => window.__cityRacer.cityInfo().peds.draw.flatMap((m) => m.poses).filter((p) => p[2] < 0).length);
  await page.screenshot({ path: `${OUT}blend-${got}.png`, timeout: 120000 }).catch((e) => console.log('shot failed', e.message.split('\n')[0]));
  console.log(`shot ${got}: person at ${hit.d.toFixed(1)} m, exact poses on screen after re-render: ${still}`);
  got++;
}
console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
await browser.close();
