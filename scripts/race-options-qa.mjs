/**
 * Browser check (QA build): race options in Settings (rival skill, catch-up rivals) persist across a reload,
 * and traffic missions use their fixed traffic density whatever the graphics quality.
 * Usage: node scripts/race-options-qa.mjs [url]   (default http://localhost:4174/, needs `npm run preview:qa`)
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4174/';
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const consoleErrors = [];
let browser, context, page;
async function open(storageState) {
  if (browser) {
    const old = browser;
    await Promise.race([old.close(), new Promise((r) => setTimeout(r, 15000))]);
    try { old.process?.()?.kill('SIGKILL'); } catch { /* gone */ }
  }
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 960, height: 540 }, ...(storageState ? { storageState } : {}) });
  page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
}
const H = (f, a) => page.evaluate(f, a);
const adv = (s) => H((x) => window.__cityRacer.qaAdvance(x), s);
const traffic = () => H(() => window.__cityRacer.cityInfo().traffic.active);
const stored = () => H(() => JSON.parse(localStorage.getItem('city-racer.settings.v1') ?? '{}'));
const segActive = (key) => H((k) => document.querySelector(`.screen[data-screen="settings"] button[data-seg="${k}"][aria-checked="true"]`)?.dataset.value ?? null, key);
const clickSeg = (key, value) => page.click(`.screen[data-screen="settings"] button[data-seg="${key}"][data-value="${value}"]`);
const openSettings = () => page.click('.screen[data-screen="title"] button[data-action="settings"]');

// --- 1. Settings: the Racing controls work and persist.
await open();
await openSettings();
const labels = await H(() => [...document.querySelectorAll('.screen[data-screen="settings"] h4')].map((h) => h.textContent));
check('Settings has a Racing section', labels.includes('Racing'), labels.join(', '));
check('   defaults: Rival skill Normal, Catch-up rivals Off', (await segActive('aiDifficulty')) === 'normal' && (await segActive('rubberBand')) === 'false');
await clickSeg('aiDifficulty', 'hard');
await clickSeg('rubberBand', 'true');
await clickSeg('quality', 'low');
const s1 = await stored();
check('   choosing Hard / On updates the controls and the saved settings', (await segActive('aiDifficulty')) === 'hard' && (await segActive('rubberBand')) === 'true' && s1.aiDifficulty === 'hard' && s1.rubberBand === true, JSON.stringify({ aiDifficulty: s1.aiDifficulty, rubberBand: s1.rubberBand, quality: s1.quality }));

await open(await context.storageState());
await openSettings();
check('   after a reload the choices are still selected', (await segActive('aiDifficulty')) === 'hard' && (await segActive('rubberBand')) === 'true' && (await segActive('quality')) === 'low');
await clickSeg('aiDifficulty', 'normal');
await clickSeg('rubberBand', 'false');
const s2 = await stored();
check('   and can be set back (Normal / Off)', s2.aiDifficulty === 'normal' && s2.rubberBand === false);
await page.click('.screen[data-screen="settings"] button[data-action="back"]');

// --- 2. Traffic density: free roam follows the (Low) quality preset, a traffic mission does not.
await H(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 8, best: {}, credits: 0 }));
await H(() => window.__cityRacer.startLevel(-1));
await adv(4);
const free = await traffic();
check('free roam on Low graphics keeps the Low traffic density (≤ 9 cars)', free > 0 && free <= 9, `${free} cars`);
const rush = await H(() => window.__cityRacer.startLevel(6));
await adv(4);
const mission = await traffic();
check('Rush Hour on Low graphics uses its fixed mission density (18 cars, not 9)', mission > 9 && mission <= 18, `${mission} cars${rush === false ? ' (startLevel refused)' : ''}`);
await H(() => window.__cityRacer.startLevel(-1));
await adv(4);
const back = await traffic();
check('   back in free roam the quality density applies again', back > 0 && back <= 9, `${back} cars`);

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures === 0 ? `\nRACE OPTIONS QA: ALL ${passes} PASSED` : `\nRACE OPTIONS QA: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
