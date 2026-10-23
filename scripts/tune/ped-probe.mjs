// Close-up look at the pedestrian crowd + draw-call / error report (dev tool, QA build only).
import { chromium } from 'playwright';
const URL = process.argv[2] || 'http://localhost:4174/';
const OUT = process.argv[3] || '/tmp/shots/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => window.__cityRacer.qaFreeze(true));
await H(() => window.__cityRacer.startLevel(-1));
await H(() => window.__cityRacer.qaAdvance(3));
const c0 = await H(() => window.__cityRacer.cityInfo());
const me = (await H(() => window.__cityRacer.snapshot())).character;
const list = c0.peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - me.x, q.z - me.z) })).sort((a, b) => a.d - b.d);
console.log('peds', c0.peds.stats.active, 'nearest', list.slice(0, 3).map((p) => `${p.d.toFixed(1)}m mode ${p.mode} speed ${p.speed?.toFixed?.(2)}`).join(' | '));
for (const [k, n0] of list.slice(0, 3).entries()) {
  // Stand 1.2 m to the kerb side of the pedestrian, a few metres along the road, and look at them.
  const spot = await H((q) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < 984; i++) { const t = window.__cityRacer.trackPoint(i, 0); const d = (t.x - q.x) ** 2 + (t.z - q.z) ** 2; if (d < bd) { bd = d; best = i; } }
    return best;
  }, n0);
  await H(([i, off]) => window.__cityRacer.debugTeleportCharacter(i, off), [spot + 2, n0.lat > 0 ? n0.lat - 1.5 : n0.lat + 1.5]);
  await H(() => window.__cityRacer.qaAdvance(0.05));
  const n = (await H(() => window.__cityRacer.cityInfo())).peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - n0.x, q.z - n0.z) })).sort((a, b) => a.d - b.d)[0];
  const meNow = (await H(() => window.__cityRacer.snapshot())).character;
  await H(([a, b]) => window.__cityRacer.setCameraYaw(Math.atan2(a.x - b.x, a.z - b.z)), [n, meNow]);
  await H(() => window.__cityRacer.qaAdvance(0.05));
  await H(() => window.__cityRacer.snapCamera());
  await page.screenshot({ path: `${OUT}peds-${k}.png`, timeout: 150000 }).catch((e) => console.log('shot fail', e.message.split('\n')[0]));
}
const stats = await H(() => window.__cityRacer.sceneStats());
console.log('ped groups', JSON.stringify(stats.filter((s) => /pedestrians/.test(s.group))));
console.log('render', JSON.stringify(await H(() => window.__cityRacer.renderInfo())), 'visible', (await H(() => window.__cityRacer.cityInfo())).peds.visible);
console.log('errors', errs.length ? errs.join('\n') : 'none');
await browser.close();
