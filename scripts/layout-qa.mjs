/**
 * Layout QA (headless Chromium, software WebGL, QA build): every menu screen at desktop, small-laptop
 * and phone sizes. A screen passes when all of its action buttons (the panel's button rows) are fully
 * inside the viewport and on top — i.e. pressable without scrolling or hunting.
 * Usage: node scripts/layout-qa.mjs [URL]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:4174/';
const VIEWPORTS = [
  [1280, 720],
  [1024, 768],
  [960, 540],
  [844, 390],
  [740, 360],
  [390, 844],
];
let passes = 0;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => window.__cityRacer.qaFreeze(true));

const screen = () => H(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null);
const state = () => H(() => window.__cityRacer.snapshot().state);
/** Click a button of the visible screen by data-action via a DOM click (navigation only). */
const act = async (action, nth = 0) => {
  const ok = await H(([a, n]) => {
    const bs = [...document.querySelectorAll(`.screen:not(.hidden) [data-action="${a}"]`)];
    const b = bs[n];
    if (!b) return false;
    b.click();
    return true;
  }, [action, nth]);
  if (!ok) throw new Error(`no "${action}" button on ${await screen()}`);
  await H(() => window.__cityRacer.qaAdvance(0.1));
  await page.waitForTimeout(150);
};
const toTitle = async () => {
  for (let k = 0; k < 6 && (await screen()) !== 'title'; k++) {
    const st = await state();
    if (st === 'driving' || st === 'onFoot') await page.keyboard.press('Escape');
    else if ((await screen()) === 'pause') await act('quit');
    else await page.keyboard.press('Escape');
    await H(() => window.__cityRacer.qaAdvance(0.1));
    await page.waitForTimeout(150);
  }
};

/**
 * The visible screen's closing action row (Start / Back / Done) must be fully on screen and on top
 * without scrolling; any other action button must be reachable by scrolling it into view (and must
 * then not be hidden under the pinned row).
 */
const audit = () =>
  H(() => {
    const scr = document.querySelector('.screen:not(.hidden)');
    if (!scr) return { screen: null, total: 0, bad: [] };
    const bad = [];
    const usable = (b) => {
      const r = b.getBoundingClientRect();
      const inside = r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
      const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      const onTop = !!top && (top === b || b.contains(top));
      return { ok: inside && onTop, why: `@${Math.round(r.top)}–${Math.round(r.bottom)}${inside ? ' covered' : ' off screen'}` };
    };
    const label = (b) => `${b.dataset.action ?? '?'} "${(b.textContent ?? '').trim().slice(0, 18)}"`;
    const rows = [...scr.querySelectorAll('.btn-row, .btn-col')].filter((r) => r.offsetParent !== null);
    const closing = rows.filter((r) => r.parentElement?.classList.contains('panel') && r === r.parentElement.lastElementChild);
    const main = scr.querySelector('.menu-main');
    if (main) closing.push(main);
    const closingBtns = closing.flatMap((r) => [...r.querySelectorAll('button')]);
    for (const b of closingBtns) {
      const u = usable(b);
      if (!u.ok) bad.push(`${label(b)} not visible without scrolling ${u.why}`);
    }
    const others = rows.filter((r) => !closing.includes(r)).flatMap((r) => [...r.querySelectorAll('button')]);
    const scrollers = [...scr.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 1);
    const saved = scrollers.map((e) => e.scrollTop);
    for (const b of others) {
      b.scrollIntoView({ block: 'center' });
      const u = usable(b);
      if (!u.ok) bad.push(`${label(b)} not reachable by scrolling ${u.why}`);
    }
    scrollers.forEach((e, k) => (e.scrollTop = saved[k]));
    return { screen: scr.dataset.screen, total: closingBtns.length + others.length, bad };
  });

const SCREENS = [
  ['title', async () => {}],
  ['levels', async () => act('levels')],
  ['briefing (mission)', async () => { await act('levels'); await act('level', 0); }],
  ['career', async () => act('career')],
  ['briefing (career)', async () => { await act('career'); await act('cbrief', 0); }],
  ['garage', async () => act('garage')],
  ['settings', async () => act('settings')],
  ['credits', async () => act('credits')],
  ['pause', async () => { await act('free'); await H(() => window.__cityRacer.qaAdvance(0.5)); await page.keyboard.press('Escape'); await H(() => window.__cityRacer.qaAdvance(0.1)); }],
  ['map', async () => { await act('free'); await H(() => window.__cityRacer.qaAdvance(0.5)); await page.keyboard.press('KeyN'); await H(() => window.__cityRacer.qaAdvance(0.1)); }],
];

for (const [w, h] of VIEWPORTS) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const bad = [];
  let total = 0;
  for (const [name, open] of SCREENS) {
    await toTitle();
    try {
      await open();
      await page.waitForTimeout(250);
      const a = await audit();
      total += a.total;
      if (a.total === 0) bad.push(`${name}: no action buttons found (screen ${a.screen})`);
      for (const b of a.bad) bad.push(`${name}: ${b}`);
    } catch (e) {
      bad.push(`${name}: ${e.message}`);
    }
  }
  await toTitle();
  check(`${w}×${h}: every screen's closing actions visible without scrolling, every other action reachable`, bad.length === 0, bad.length ? bad.join('; ') : `${SCREENS.length} screens, ${total} buttons`);
}
check('no console errors or warnings', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
console.log(`\n${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'LAYOUT QA PASSED' : 'LAYOUT QA FAILED');
await browser.close();
process.exit(failures === 0 ? 0 : 1);
