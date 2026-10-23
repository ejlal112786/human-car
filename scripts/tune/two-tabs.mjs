// Two tabs of the game sharing one localStorage: a purchase in tab A, then an upgrade in tab B
// (which loaded before A's purchase). Reports whether A's purchase survives B's save.
// usage: node scripts/tune/two-tabs.mjs [URL]
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:4174/';
const KEY = 'city-racer.progress.v2';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
const ready = (p) => p.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const A = await ctx.newPage();
A.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('A console:', m.text()));
await A.goto(URL, { timeout: 180000 });
await ready(A);
await A.evaluate(([k]) => {
  localStorage.clear();
  localStorage.setItem(k, JSON.stringify({ version: 2, credits: 10000, earned: 10000 }));
}, [KEY]);
await A.reload({ timeout: 180000 });
await ready(A);
const B = await ctx.newPage();
B.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('B console:', m.text()));
await B.goto(URL, { timeout: 180000 });
await ready(B);
const mem = (p) => p.evaluate(() => { const g = window.__cityRacer.garageInfo().progress; return { credits: g.credits, owned: g.owned, car: g.car, eng: g.cars.kestrel?.upgrades }; });
const stored = () => A.evaluate((k) => { const g = JSON.parse(localStorage.getItem(k)); return { credits: g.credits, owned: g.owned, car: g.car, eng: g.cars.kestrel?.upgrades }; }, KEY);
console.log('start     A', JSON.stringify(await mem(A)), ' B', JSON.stringify(await mem(B)));

// Tab A buys the Pip.
await A.click('.screen-title [data-action="garage"]', { timeout: 90000 });
await A.click('.screen:not(.hidden) [data-action="gview"][data-car="pip"]', { timeout: 90000 });
await A.click('.screen:not(.hidden) [data-action="gbuy"][data-car="pip"]', { timeout: 90000 });
await B.waitForTimeout(1500);
console.log('A bought  A', JSON.stringify(await mem(A)), ' B', JSON.stringify(await mem(B)), ' stored', JSON.stringify(await stored()));
const bTitle = await B.evaluate(() => document.querySelector('.screen-title')?.textContent.replace(/\s+/g, ' ').match(/[\d,]+\s*cr|CR\s*[\d,]+|[\d,]+ credits/i)?.[0] ?? null);
console.log('B title credits text:', bTitle);

// Tab B (stale?) buys an engine upgrade for the Kestrel.
await B.click('.screen-title [data-action="garage"]', { timeout: 90000 });
await B.click('.screen:not(.hidden) [data-action="gview"][data-car="kestrel"]', { timeout: 90000 });
await B.click('.screen:not(.hidden) [data-action="gupgrade"][data-car="kestrel"][data-upgrade="engine"]', { timeout: 90000 });
await A.waitForTimeout(1500);
const s = await stored();
console.log('B upgrade A', JSON.stringify(await mem(A)), ' B', JSON.stringify(await mem(B)), ' stored', JSON.stringify(s));
console.log(s.owned.includes('pip') ? 'RESULT: purchase in tab A survived' : 'RESULT: LOST UPDATE — tab B overwrote the Pip purchase made in tab A');
await b.close();
