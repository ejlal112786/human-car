// Dev probe: heap snapshot after free roam start, aggregated self size by constructor / type.
//   node scripts/tune/heap-diff.mjs URL out.json
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const [URL, OUT] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
await page.evaluate(() => { const h = window.__cityRacer; h.qaFreeze(true); h.startLevel(-1); h.qaAdvance(3); });
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
const chunks = [];
cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
const snap = JSON.parse(chunks.join(''));
const m = snap.snapshot.meta;
const F = m.node_fields.length;
const iType = m.node_fields.indexOf('type'), iName = m.node_fields.indexOf('name'), iSize = m.node_fields.indexOf('self_size');
const types = m.node_types[0];
const agg = {};
let total = 0;
for (let i = 0; i < snap.nodes.length; i += F) {
  const t = types[snap.nodes[i + iType]];
  const name = snap.strings[snap.nodes[i + iName]];
  const key = t === 'object' || t === 'native' ? `${t}:${name}` : t === 'array' ? `array:${name}` : t;
  const sz = snap.nodes[i + iSize];
  agg[key] = (agg[key] ?? 0) + sz;
  total += sz;
}
writeFileSync(OUT, JSON.stringify({ total, agg }));
console.log('total MB', (total / 1048576).toFixed(2), 'usedJSHeap MB', ((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)) / 1048576).toFixed(2));
await browser.close();
