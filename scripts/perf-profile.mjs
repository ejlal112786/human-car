/**
 * CPU profile of free roam (headless Chromium, software WebGL) — finds JS hot spots.
 * Software rendering inflates GPU-side cost, so treat absolute numbers as relative only.
 *
 *   node scripts/perf-profile.mjs [URL] [seconds]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:4174/';
const SECS = Number(process.argv[3] || 8);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
await page.click('.screen-title [data-action="free"]');
await page.waitForTimeout(4000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
const f0 = await page.evaluate(() => window.__cityRacer.snapshot().frame ?? 0).catch(() => 0);
await page.waitForTimeout(SECS * 1000);
const { profile } = await cdp.send('Profiler.stop');
const info = await page.evaluate(() => window.__cityRacer.renderInfo());
const snap = await page.evaluate(() => window.__cityRacer.snapshot());

// Self time per function.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = profile.timeDeltas;
for (let k = 0; k < profile.samples.length; k++) {
  const n = byId.get(profile.samples[k]);
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'}  ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dts[k] ?? 0) / 1000);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`profile ${SECS}s, total sampled ${total.toFixed(0)} ms, fps ${snap.fps?.toFixed?.(1) ?? '?'}, frames ${f0}`);
console.log(`render: ${JSON.stringify(info)}`);
for (const [k, v] of rows) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${v.toFixed(0).padStart(6)} ms  ${k}`);
await browser.close();
