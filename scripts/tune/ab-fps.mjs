// Dev probe: real-time frame rate in free roam facing the crowd, plus a reload time.
//   node scripts/tune/ab-fps.mjs URL [seconds]
import { chromium } from 'playwright';
const URL = process.argv[2];
const SECS = Number(process.argv[3] || 15);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const t0 = Date.now();
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const load = (Date.now() - t0) / 1000;
await page.evaluate(() => { const h = window.__cityRacer; h.qaFreeze(true); h.startLevel(-1); h.qaAdvance(2); });
await page.evaluate(() => {
  const h = window.__cityRacer; const me = h.snapshot().character;
  const n = h.cityInfo().peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - me.x, q.z - me.z) })).sort((a, b) => a.d - b.d)[0];
  h.setCameraYaw(Math.atan2(n.x - me.x, n.z - me.z));
  h.qaFreeze(false);
});
await page.waitForTimeout(3000);
const fps = await page.evaluate((secs) => new Promise((res) => {
  let n = 0; const s = performance.now(); let worst = 0; let last = s;
  const f = (t) => { n++; worst = Math.max(worst, t - last); last = t; if (t - s < secs * 1000) requestAnimationFrame(f); else res({ fps: n / ((t - s) / 1000), worst }); };
  requestAnimationFrame(f);
}), SECS);
const vis = await page.evaluate(() => window.__cityRacer.cityInfo().peds.visible);
const t1 = Date.now();
await page.reload({ timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer, null, { timeout: 180000 });
console.log(JSON.stringify({ url: URL, load: +load.toFixed(1), fps: +fps.fps.toFixed(2), worstFrameMs: Math.round(fps.worst), pedsVisible: vis, reload: +((Date.now() - t1) / 1000).toFixed(1) }));
await browser.close();
