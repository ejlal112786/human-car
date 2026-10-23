/**
 * End-to-end gameplay QA in headless Chromium (software WebGL).
 *
 *   npm run dev            (or: npm run build:qa && npm run preview:qa → URL=http://localhost:4174/)
 *   node scripts/browser-qa.mjs [URL]
 *
 * Uses real keyboard / mouse events; simulation time is advanced with the dev/QA-only
 * `qaAdvance` hook because software rendering runs at ~2 FPS. Exits non-zero on failure.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL = process.argv[2] || process.env.URL || 'http://localhost:5173/';
const SHOTS = new globalThis.URL('../qa-shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};
const f2 = (n) => (typeof n === 'number' ? n.toFixed(2) : String(n));

const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const consoleErrors = [];
let browser, context, page;
async function openBrowser(storageState) {
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  context = await browser.newContext({ viewport: { width: 960, height: 540 }, ...(storageState ? { storageState } : {}) });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
}
await openBrowser();

const snap = () => page.evaluate(() => window.__cityRacer.snapshot());
const adv = (s) => page.evaluate((x) => window.__cityRacer.qaAdvance(x), s);
// The real-time loop is frozen while capturing: under software GL a continuously rendering
// page starves the compositor and Playwright screenshots time out.
const shot = async (name) => {
  await page.evaluate(() => window.__cityRacer.qaFreeze(true));
  try {
    await page.screenshot({ path: `${SHOTS}${name}.png`, timeout: 90000 });
  } catch (e) {
    console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`);
  }
  await page.evaluate(() => window.__cityRacer.qaFreeze(false));
};
// The game loop is frozen while Playwright checks that the target is visible and stable:
// under software GL a continuously rendering page can starve its animation-frame checks.
const click = async (sel) => {
  await page.evaluate(() => window.__cityRacer.qaFreeze(true));
  try {
    await page.locator(sel).first().click({ timeout: 90000 });
    await page.evaluate(() => window.__cityRacer.qaFreeze(false));
  } catch (e) {
    await page.evaluate(() => window.__cityRacer.qaFreeze(false));
    const d = await page.evaluate(() => {
      const x = window.__cityRacer.snapshot();
      return { state: x.state, resume: x.resumeState, screen: document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null, mission: { stage: x.mission?.stage, elapsed: x.mission?.elapsed } };
    });
    console.log(`click ${sel} failed; game state ${JSON.stringify(d)}`);
    throw e;
  }
  await page.waitForTimeout(150);
};
/**
 * Start a brand-new browser between long sections. Under software GL (SwiftShader) one Chromium
 * instance gets progressively slower over a ~30 minute run until frames, screenshots, clicks and even
 * page reloads time out. The resource audit shows the game itself does not leak (GPU objects and JS
 * heap flat across mission cycles), so the suite carries localStorage (progress + settings) over to a
 * fresh browser instead. Console errors from every browser instance are still collected.
 */
async function freshPage() {
  const state = await context.storageState();
  const old = browser;
  await Promise.race([old.close(), new Promise((r) => setTimeout(r, 15000))]);
  try { old.process?.()?.kill('SIGKILL'); } catch { /* already gone */ }
  await openBrowser(state);
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
}
const visibleScreen = () => page.evaluate(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null);
const tp = (i, off) => page.evaluate(([a, b]) => window.__cityRacer.trackPoint(a, b), [i, off]);
const teleChar = (i, off, yaw) => page.evaluate(([a, b, c]) => window.__cityRacer.debugTeleportCharacter(a, b, c ?? undefined), [i, off, yaw ?? null]);
const teleCar = (i, off, yaw = 0) => page.evaluate(([a, b, c]) => window.__cityRacer.debugTeleport(a, b, c), [i, off, yaw]);
const setCamYaw = (y) => page.evaluate((v) => window.__cityRacer.setCameraYaw(v), y);
const inBuilding = (x, z, m = 0.25) => page.evaluate(([a, b, c]) => window.__cityRacer.buildingAt(a, b, c), [x, z, m]);
/** Hold keys for `seconds` of sim time; returns a snapshot taken BEFORE the keys are released
 *  (the real-time rAF loop keeps simulating between calls, so a later snapshot would already decelerate). */
async function hold(keys, seconds) {
  for (const k of keys) await page.keyboard.down(k);
  await adv(seconds);
  const s = await snap();
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  return s;
}
/** Teleport the car 2 samples (≈4 m) before gate sample `g` and drive through it (≈7 m in 1.5 s). */
async function throughGate(g, off = 1.75) {
  await teleCar(g - 2, off);
  return hold(['KeyW'], 1.5);
}
async function stopCar(maxS = 8) {
  await page.keyboard.down('KeyS');
  for (let t = 0; t < maxS; t += 0.25) {
    const s = await snap();
    if (Math.abs(s.forwardSpeed) < 0.6) break;
    await adv(0.25);
  }
  await page.keyboard.up('KeyS');
  await adv(0.5);
}
/** Teleport the character next to the car's driver door (car-local z = -1.45 → road offset). */
async function charToDoor(carI, carOff) {
  await teleChar(carI, carOff - 2.3);
  await adv(0.1);
}
async function enterCar() {
  await page.keyboard.press('KeyE');
  await adv(1.3);
  return snap();
}

// ------------------------------------------------------------------ 1. Boot & menus
await page.goto(URL);
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
await page.evaluate(() => {
  localStorage.clear();
});
await page.reload({ timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
let s = await snap();
check('boots to the title menu', s.state === 'menu' && (await visibleScreen()) === 'title', `${s.state}/${await visibleScreen()}`);
const titleText = await page.locator('.screen-title').innerText();
check('title has Play, Missions, Free Roam, Garage, Settings, Credits', ['PLAY', 'MISSIONS', 'FREE ROAM', 'GARAGE', 'SETTINGS', 'CREDITS'].every((w) => titleText.toUpperCase().includes(w)), titleText.replace(/\n+/g, ' | '));
const bodyText = await page.evaluate(() => document.body.innerText);
check('no phase / prototype / debug wording visible', !/phase\s*1|prototype|debug|placeholder/i.test(bodyText));
check('no Continue button for a new player', !/CONTINUE/i.test(titleText));
await shot('qa-01-title');

await click('.screen-title [data-action="levels"]');
check('Missions opens the level list', (await visibleScreen()) === 'levels');
const cards = await page.locator('.level-card').count();
const locked = await page.locator('.level-card.locked').count();
check('15 missions listed, 14 locked for a new player', cards === 15 && locked === 14, `${cards} cards, ${locked} locked`);
check('locked mission cards are disabled', await page.locator('.level-card.locked').first().isDisabled());
await click('.screen-levels [data-action="back"]');
check('Back returns to the title', (await visibleScreen()) === 'title');
await click('.screen-title [data-action="garage"]');
const sw = await page.locator('.swatch').count();
const swLocked = await page.locator('.swatch.locked').count();
check('Garage shows paints; star-locked paints disabled', (await visibleScreen()) === 'garage' && sw === 10 && swLocked === 8, `${sw} paints, ${swLocked} locked`);
await click('.swatch[data-paint="blue"]');
s = await snap();
check('Garage paint selection is saved', s.progress.paint === 'blue', s.progress.paint);
await click('.swatch[data-paint="red"]');
await click('.screen-garage [data-action="back"]');
await click('.screen-title [data-action="credits"]');
const credits = await page.locator('.screen-credits').innerText();
check('Credits list Quaternius (CC0), three.js (MIT), Rapier (Apache-2.0)', /Quaternius/.test(credits) && /CC0/.test(credits) && /MIT/.test(credits) && /Apache/.test(credits));
await click('.screen-credits [data-action="back"]');
await click('.screen-title [data-action="settings"]');
check('Settings screen opens', (await visibleScreen()) === 'settings');
await click('.screen-settings [data-action="back"]');
check('Settings Done returns to the title', (await visibleScreen()) === 'title');

// ------------------------------------------------------------------ 2. Mission 1: on foot start
await click('.screen-title [data-action="play"]');
s = await snap();
check('Play opens the Mission 1 briefing', s.state === 'briefing' && (await visibleScreen()) === 'briefing');
await click('.screen-briefing [data-action="start"]');
await adv(0.5);
s = await snap();
check('mission starts on foot', s.state === 'onFoot' && s.mission.levelId === 'find-your-ride' && s.cameraMode === 'character', `${s.state} ${s.mission.levelId} cam=${s.cameraMode}`);
check('character grounded on the pavement (y≈0.15)', s.character.grounded && Math.abs(s.character.y - 0.15) < 0.05, f2(s.character.y));
const carDist = Math.hypot(s.position.x - s.character.x, s.position.z - s.character.z);
check('parked car visible nearby (5–30 m)', carDist > 5 && carDist < 30, `${f2(carDist)} m`);
check('engine off while parked', !s.engineOn);
check('no enter prompt when far from the car', s.prompt === null);
check('HUD on foot: driving cluster hidden', await page.evaluate(() => getComputedStyle(document.querySelector('.cluster')).display === 'none'));
await shot('qa-02-onfoot');

// Movement (camera-relative)
{
  const t = await tp(14, 9.1);
  await teleChar(14, 9.1);
  const camYaw = Math.atan2(t.tx, t.tz);
  await setCamYaw(camYaw);
  await adv(0.2);
  const a = await snap();
  const b = await hold(['KeyW'], 1.0);
  const dx = b.character.x - a.character.x;
  const dz = b.character.z - a.character.z;
  const d = Math.hypot(dx, dz);
  const dot = (dx * a.camFwd.x + dz * a.camFwd.z) / (d || 1);
  check('W walks forward relative to the camera', d > 1.4 && d < 2.1 && dot > 0.95, `${f2(d)} m, dir·cam=${f2(dot)}`);
  await adv(0.5);
  const c0 = await snap();
  const c1 = await hold(['ShiftLeft', 'KeyW'], 1.0);
  check('Shift runs (≈5.4 m/s)', c1.character.speed > 4.8 && c1.character.speed < 5.6, f2(c1.character.speed));
  check('run covers more ground than walk', Math.hypot(c1.character.x - c0.character.x, c1.character.z - c0.character.z) > 3.5);
  await adv(0.6);
  await teleChar(30, 9.1);
  await setCamYaw(camYaw);
  const dg = await hold(['KeyW', 'KeyD'], 0.8);
  check('diagonal input does not exceed walk speed', dg.character.speed <= 1.95, f2(dg.character.speed));
  await adv(0.5);
  // Rotate the camera 90° and walk again: direction must follow the camera.
  await setCamYaw(camYaw + Math.PI / 2);
  await adv(0.1);
  const r0 = await snap();
  const r1 = await hold(['KeyW'], 0.8);
  const rdx = r1.character.x - r0.character.x;
  const rdz = r1.character.z - r0.character.z;
  const rdot = (rdx * r0.camFwd.x + rdz * r0.camFwd.z) / (Math.hypot(rdx, rdz) || 1);
  check('after rotating the camera, W follows the new view direction', rdot > 0.95, f2(rdot));
  // Mouse drag rotates the camera.
  const before = (await snap()).camYaw;
  await page.mouse.move(480, 300);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 4 });
  await page.mouse.up();
  await adv(0.05);
  await page.waitForTimeout(400);
  const after = (await snap()).camYaw;
  check('mouse drag orbits the camera', Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before))) > 0.2, `${f2(before)} → ${f2(after)}`);
}

// Jump
{
  await adv(0.5);
  const j0 = await snap();
  await page.keyboard.press('Space');
  await adv(0.25);
  const j1 = await snap();
  await adv(1.2);
  const j2 = await snap();
  check('Space jumps and lands again', j1.character.y > j0.character.y + 0.4 && j2.character.grounded && Math.abs(j2.character.y - j0.character.y) < 0.05, `${f2(j0.character.y)} → ${f2(j1.character.y)} → ${f2(j2.character.y)}`);
}

// Curb: walk from the road up onto the pavement
{
  const t = await tp(60, 5.5);
  await teleChar(60, 5.5);
  await setCamYaw(Math.atan2(t.rx, t.rz));
  await adv(0.3);
  const c0 = await snap();
  await hold(['KeyW'], 1.6);
  await adv(0.3);
  const c1 = await snap();
  const off = (c1.character.x - t.x) * t.rx + (c1.character.z - t.z) * t.rz + 5.5;
  check('character steps up the curb onto the pavement', c0.character.y < 0.05 && Math.abs(c1.character.y - 0.15) < 0.04 && off > 7.6 && c1.character.grounded, `y ${f2(c0.character.y)} → ${f2(c1.character.y)}, offset ${f2(off)}`);
}

// Buildings block the character
{
  let blocked = 0;
  let inside = 0;
  const tried = [];
  for (const i of [40, 120, 200, 280, 360, 440, 520, 600, 680, 760, 840, 920]) {
    for (const side of [1, -1]) {
      const t = await tp(i, side * 11.2);
      await teleChar(i, side * 11.2);
      await setCamYaw(Math.atan2(side * t.rx, side * t.rz));
      await adv(0.1);
      const a = await snap();
      await page.keyboard.down('ShiftLeft');
      await page.keyboard.down('KeyW');
      let bad = false;
      for (let k = 0; k < 6; k++) {
        await adv(0.5);
        const p = await snap();
        if (await inBuilding(p.character.x, p.character.z, 0.25)) bad = true;
      }
      await page.keyboard.up('KeyW');
      await page.keyboard.up('ShiftLeft');
      const b = await snap();
      const d = Math.hypot(b.character.x - a.character.x, b.character.z - a.character.z);
      if (bad) inside++;
      if (d < 3 * 5.4 * 0.7) blocked++;
      tried.push(f2(d));
    }
  }
  check('character never ends up inside a building', inside === 0, `${inside} of 24 runs`);
  check('buildings / world edge stop the character', blocked >= 6, `${blocked} of 24 runs blocked; distances ${tried.join(' ')}`);
}

// ------------------------------------------------------------------ 3. Enter / exit
await adv(0.3);
await teleChar(22, 0); // ~3.8 m from the driver door
await adv(0.1);
s = await snap();
check('no prompt outside door range', s.prompt === null, String(s.prompt));
await page.keyboard.press('KeyE');
await adv(0.2);
s = await snap();
check('E far from the car does nothing', s.state === 'onFoot');
await charToDoor(22, 5.25);
s = await snap();
check('prompt appears next to the door', s.prompt === 'Get in', String(s.prompt));
check('prompt is shown in the HUD', await page.evaluate(() => !document.querySelector('.prompt').classList.contains('hidden') && /Get in/.test(document.querySelector('.prompt').textContent)));
const carBefore = s.position;
await page.keyboard.press('KeyE');
await adv(0.15);
s = await snap();
check('E starts the enter transition', s.state === 'entering' && !s.character.enabled, s.state);
await shot('qa-03-entering');
await adv(1.2);
s = await snap();
check('transition ends in the driving state', s.state === 'driving' && s.inCar, s.state);
check('character hidden and its controller disabled while driving', !s.character.visible && !s.character.enabled);
check('camera switched to the chase view', s.cameraMode === 'vehicle');
check('engine started', s.engineOn);
check('mission advanced to the parking objective', s.mission.stage === 'park', s.mission.stage);
check('car did not move while getting in', Math.hypot(s.position.x - carBefore.x, s.position.z - carBefore.z) < 0.3);
check('HUD switched to driving (cluster visible)', await page.evaluate(() => getComputedStyle(document.querySelector('.cluster')).display !== 'none'));

// Controls switched: W now drives
{
  const c0 = (await snap()).character;
  await hold(['KeyW'], 2.0);
  s = await snap();
  check('W drives the car once inside', s.speedKmh > 15, `${f2(s.speedKmh)} km/h`);
  check('character does not move while driving', Math.hypot(s.character.x - c0.x, s.character.z - c0.z) < 0.01);
  await shot('qa-04-driving');
  await page.keyboard.press('KeyE');
  await adv(0.1);
  s = await snap();
  check('cannot get out at speed', s.state === 'driving');
  const toast = await page.locator('.toast').innerText();
  check('"slow down" message shown', /slow down/i.test(toast), toast);
  await stopCar();
  s = await snap();
  check('"Get out" prompt once slow', s.prompt === 'Get out', String(s.prompt));
  const carStop = s.position;
  await page.keyboard.press('KeyE');
  await adv(0.15);
  s = await snap();
  check('E at low speed starts the exit transition', s.state === 'exiting', s.state);
  await adv(0.6);
  s = await snap();
  check('exit ends on foot with the character visible and enabled', s.state === 'onFoot' && s.character.visible && s.character.enabled);
  check('engine off after getting out', !s.engineOn);
  const ed = Math.hypot(s.character.x - s.position.x, s.character.z - s.position.z);
  check('exit spot is next to the car (driver side preferred)', ed > 1.2 && ed < 3.5 && s.exitCandidate === 0, `${f2(ed)} m, candidate ${s.exitCandidate}`);
  check('exit spot is on the ground, not in a building', s.character.y > -0.05 && s.character.y < 0.4 && !(await inBuilding(s.character.x, s.character.z, 0)), f2(s.character.y));
  await adv(1.0);
  const s2 = await snap();
  check('parked car stays where it was left', Math.hypot(s2.position.x - carStop.x, s2.position.z - carStop.z) < 0.5);
  check('camera back to the on-foot view', s2.cameraMode === 'character');
  // Re-enter
  s = await enterCar();
  check('player can get back in', s.state === 'driving', s.state);
  check('vehicle state preserved on re-entry', Math.hypot(s.position.x - carStop.x, s.position.z - carStop.z) < 0.5);
}

// ------------------------------------------------------------------ 4. Pause in driving / Mission 1 completion
{
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  s = await snap();
  const steps0 = s.physicsSteps;
  check('Esc pauses while driving', s.state === 'paused' && s.resumeState === 'driving' && (await visibleScreen()) === 'pause');
  await page.waitForTimeout(1500);
  check('simulation frozen while paused', (await snap()).physicsSteps === steps0);
  await click('.screen-pause [data-action="resume"]');
  s = await snap();
  check('Resume returns to driving', s.state === 'driving');
  await teleCar(250, 5.25);
  await adv(0.3);
  s = await snap();
  check('car inside the parking bay registers', s.mission.zoneHold > 0, `hold ${f2(s.mission.zoneHold)}`);
  await adv(2.0);
  s = await snap();
  check('Mission 1 completes → results screen', s.state === 'complete' && (await visibleScreen()) === 'complete', `${s.state} ${await visibleScreen()}`);
  check('Mission 2 unlocked and best time saved', s.progress.unlocked === 2 && !!s.progress.best['find-your-ride'], JSON.stringify(s.progress));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('city-racer.progress.v2') || '{}'));
  check('progress written to localStorage', stored.unlocked === 2);
  const res = await page.locator('.screen-complete').innerText();
  check('results show time, stars and the unlock reward', /Time/i.test(res) && /Unlocked/i.test(res), res.replace(/\n+/g, ' | '));
  const credits = (await snap()).progress.credits;
  check('first clear pays credits, shown on the results screen and saved', credits >= 500 && res.includes(`+${credits.toLocaleString('en-US')} cr`) && stored.credits === credits, `${credits} cr`);
  await shot('qa-05-complete');
}

// ------------------------------------------------------------------ 5. City Driving (Mission 3): checkpoints + time limit
{
  await click('.screen-complete [data-action="next"]');
  const briefTitle = await page.locator('.screen-briefing').innerText();
  check('Next mission opens the Mission 2 (Driving School) briefing', (await visibleScreen()) === 'briefing' && (await snap()).state === 'briefing' && /Driving School/i.test(briefTitle), briefTitle.split('\n')[0]);
  // Open City Driving (campaign index 2) directly with a 15-mission save that has it unlocked.
  await page.evaluate(() => window.__cityRacer.setProgress({ campaign: 2, unlocked: 3, best: JSON.parse(localStorage.getItem('city-racer.progress.v2')).best, paint: 'red' }));
  await page.evaluate(() => window.__cityRacer.startLevel(2));
  await adv(0.3);
  s = await snap();
  check('City Driving starts on foot', s.state === 'onFoot' && s.mission.levelId === 'city-driving', `${s.state} ${s.mission.levelId}`);
  await charToDoor(332, 5.25);
  s = await enterCar();
  check('City Driving: in the car, clock started', s.state === 'driving' && s.mission.elapsed > 0);
  // Direction-aware gates: driving through gate 1 backwards does not count.
  await teleCar(372, 1.75, Math.PI);
  await hold(['KeyW'], 1.5);
  s = await snap();
  check('gate passed in the wrong direction is ignored', s.mission.nextGate === 0, `nextGate ${s.mission.nextGate}`);
  const gates = [370, 410, 450, 490, 530, 570, 610, 650, 692];
  let passed = 0;
  for (let k = 0; k < gates.length; k++) {
    const g = await throughGate(gates[k]);
    if (g.mission.nextGate === k + 1) passed++;
    if (k === 2) await shot('qa-06-checkpoints');
    if (g.state !== 'driving') break;
  }
  check('all 9 checkpoints register in order', passed === 9, `${passed}/9`);
  await adv(1.6);
  s = await snap();
  check('City Driving complete after the last checkpoint (Mission 4 unlocked)', s.state === 'complete' && s.progress.unlocked === 4, `${s.state} unlocked=${s.progress.unlocked}`);
  // Replay and let the clock run out.
  await click('.screen-complete [data-action="restart"]');
  s = await snap();
  check('Replay restarts on foot with the clock reset', s.state === 'onFoot' && s.mission.elapsed === 0 && s.mission.nextGate === 0);
  await charToDoor(332, 5.25);
  await enterCar();
  await adv(61);
  await adv(1.5);
  s = await snap();
  check('time limit exceeded → mission failed screen', s.state === 'failed' && (await visibleScreen()) === 'failed', `${s.state} ${await visibleScreen()}`);
  check('failure screen gives the reason', /time/i.test(await page.locator('.screen-failed').innerText()));
  await shot('qa-07-failed');
  await click('.screen-failed [data-action="restart"]');
  s = await snap();
  check('Retry restarts the mission', s.state === 'onFoot' && s.mission.stage === 'toCar');
}

// ------------------------------------------------------------------ 6. Pause in every mode
{
  await freshPage();
  await page.evaluate(() => window.__cityRacer.startLevel(2));
  await adv(0.3);
  check('City Driving replayable after a reload (unlock persisted)', (await snap()).mission.levelId === 'city-driving');
  await page.keyboard.press('Escape');
  s = await snap();
  check('pause on foot', s.state === 'paused' && s.resumeState === 'onFoot');
  await page.keyboard.press('Escape');
  s = await snap();
  check('Esc resumes on foot', s.state === 'onFoot');
  await charToDoor(332, 5.25);
  await page.keyboard.press('KeyE');
  await adv(0.1);
  await page.keyboard.press('Escape');
  s = await snap();
  check('pause during the enter transition', s.state === 'paused' && s.resumeState === 'entering');
  await page.keyboard.press('Escape');
  await adv(1.3);
  s = await snap();
  check('enter transition completes after resume', s.state === 'driving');
  await page.keyboard.press('KeyE');
  await adv(0.1);
  await page.keyboard.press('Escape');
  s = await snap();
  check('pause during the exit transition', s.state === 'paused' && s.resumeState === 'exiting');
  await page.keyboard.press('Escape');
  await adv(0.8);
  s = await snap();
  check('exit transition completes after resume', s.state === 'onFoot' && s.character.visible);
  // Held keys are released by pause.
  await page.keyboard.down('KeyW');
  await adv(0.1);
  await page.keyboard.press('Escape');
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await adv(0.3);
  s = await snap();
  check('no stuck input after pause', s.control.moveY === 0 && s.character.speed < 0.5, `moveY ${s.control.moveY}, speed ${f2(s.character.speed)}`);
  // Restart from the pause menu
  await page.keyboard.press('Escape');
  await click('.screen-pause [data-action="restart"]');
  s = await snap();
  check('Restart from the pause menu', s.state === 'onFoot' && s.mission.stage === 'toCar');
  // Quit to menu
  await page.keyboard.press('Escape');
  await click('.screen-pause [data-action="quit"]');
  s = await snap();
  check('Quit returns to the title menu', s.state === 'menu' && (await visibleScreen()) === 'title' && !s.hudVisible);
  const t2 = await page.locator('.screen-title').innerText();
  check('Continue offered once progress exists', /CONTINUE/i.test(t2));
}

// ------------------------------------------------------------------ 7. Obstacle Course (Mission 5): obstacles, penalties, reset, obstacle-aware exit
{
  await freshPage();
  await page.evaluate(() => window.__cityRacer.setProgress({ campaign: 2, unlocked: 9, best: JSON.parse(localStorage.getItem('city-racer.progress.v2')).best, paint: 'red' }));
  await page.evaluate(() => window.__cityRacer.startLevel(4));
  await adv(0.3);
  s = await snap();
  const o = s.mission.obstacles;
  check('Obstacle Course places cones, barrels, barriers, roadblocks and speed bumps', o.cone > 20 && o.barrel === 4 && o.barrier > 40 && o.roadblock === 2 && o.bump === 2, JSON.stringify(o));
  await charToDoor(701, 3.5);
  s = await enterCar();
  check('Obstacle Course: driving', s.state === 'driving');
  await shot('qa-08-obstacles');
  // Start 4 samples (~8 m) before the first slalom cone (716, offset 3.5) so the car cannot drift past it
  // on the curving road.
  await teleCar(712, 3.5);
  await adv(0.3);
  await hold(['KeyW'], 2.0);
  s = await snap();
  check('hitting cones adds time penalties', s.mission.penalty > 0 && s.mission.obstaclesDisplaced > 0, `penalty ${s.mission.penalty}s, displaced ${s.mission.obstaclesDisplaced}`);
  await stopCar();
  // Exit inside the barrier passage: both sides blocked → must exit behind / in front.
  await teleCar(771, 3.7);
  await adv(0.6);
  await page.keyboard.press('KeyE');
  await adv(0.8);
  s = await snap();
  check('exit between barriers picks a clear spot behind / ahead of the car', s.state === 'onFoot' && (s.exitCandidate === 2 || s.exitCandidate === 3 || s.exitCandidate >= 8), `state ${s.state}, candidate ${s.exitCandidate}`);
  const t = await tp(771, 3.7);
  const lat = (s.character.x - t.x) * t.rx + (s.character.z - t.z) * t.rz + 3.7;
  check('…and the character stands inside the passage, not in a barrier', Math.abs(lat - 3.7) < 1.0, `lateral ${f2(lat)}`);
  await page.keyboard.press('Escape');
  await click('.screen-pause [data-action="restart"]');
  await adv(0.3);
  s = await snap();
  check('restart restores every obstacle and clears penalties', s.mission.obstaclesDisplaced === 0 && s.mission.penalty === 0 && s.mission.strikes === 0, `displaced ${s.mission.obstaclesDisplaced}, penalty ${s.mission.penalty}s, strikes ${s.mission.strikes}`);
}

// ------------------------------------------------------------------ 8. Time Trial (Mission 6) layout
{
  await page.keyboard.press('Escape');
  await click('.screen-pause [data-action="quit"]');
  await page.evaluate(() => window.__cityRacer.startLevel(5));
  await adv(0.3);
  s = await snap();
  check('Time Trial: 14 ordered checkpoints and a detour', s.mission.gates === 14 && s.mission.obstacles.roadblock === 4 && s.mission.obstacles.barrier > 20, JSON.stringify(s.mission.obstacles));
  check('Obstacle Course obstacles were removed (pool reused)', s.mission.obstacles.bump === 0 && s.mission.obstacles.barrel === 0);
}

// ------------------------------------------------------------------ 9. Street Race (Mission 9)
{
  await freshPage();
  await page.evaluate(() => window.__cityRacer.startLevel(8));
  await adv(0.3);
  s = await snap();
  check('Street Race: three AI opponents on the grid', s.mission.racers.length === 3, String(s.mission.racers.length));
  await charToDoor(4, 1.75);
  s = await enterCar();
  check('race countdown after getting in', s.state === 'driving' && s.mission.stage === 'countdown', s.mission.stage);
  await hold(['KeyW'], 1.2);
  s = await snap();
  check('controls locked during the countdown', Math.abs(s.speedKmh) < 3, `${f2(s.speedKmh)} km/h`);
  await adv(2.2);
  s = await snap();
  check('race starts after the countdown', s.mission.stage === 'drive', s.mission.stage);
  await page.keyboard.press('KeyE');
  await adv(0.1);
  check('cannot leave the car during the race', (await snap()).state === 'driving');
  await adv(12);
  s = await snap();
  const prog = s.mission.racers.map((r) => r.progress);
  check('AI opponents drive the course', prog.every((p) => p > 60), prog.join(', '));
  await shot('qa-09-race');
  // Stay on the grid: once a rival completes the lap a win is impossible, so the race fails at once
  // (a "win required" race does not wait for the remaining rivals).
  const parkedAt = (await snap()).position;
  await adv(100);
  s = await snap();
  const shoved = Math.hypot(s.position.x - parkedAt.x, s.position.z - parkedAt.z);
  check('rivals finishing the lap pass the parked player car without ramming it', shoved < 1, `moved ${f2(shoved)} m`);
  const fin = s.mission.racers.filter((r) => r.finished).length;
  check('the leading AI opponent completes the full lap (finish from real progress)', fin >= 1 && s.mission.racers.filter((r) => r.finished).every((r) => r.progress > 980), `${fin}/3 finished, progress ${s.mission.racers.map((r) => Math.round(r.progress)).join(', ')}`);
  const failText = s.state === 'failed' ? await page.locator('.screen-failed').innerText() : '';
  check('a rival winning a win-only race fails it at once, with the reason', s.state === 'failed' && /rival took the win/i.test(failText), `${s.state} ${failText.replace(/\n+/g, ' | ').slice(0, 120)}`);
  const raceGates = [90, 170, 250, 330, 410, 490, 570, 650, 730, 810, 890, 14];
  await click('.screen-failed [data-action="restart"]');
  await charToDoor(4, 1.75);
  await enterCar();
  await adv(3.2);
  for (const g of raceGates) {
    if ((await throughGate(g)).mission.stage === 'done') break;
  }
  await adv(1.6);
  s = await snap();
  const resText = await page.locator('.screen-complete').innerText().catch(() => '');
  check('winning the race completes the Street Race with standings', s.state === 'complete' && /You/.test(resText) && !!s.progress.best['street-race'], `${s.state}`);
  await shot('qa-10-race-results');
}

// ------------------------------------------------------------------ 10. Settings take effect and persist
{
  await click('.screen-complete [data-action="quit"]');
  await freshPage();
  await click('.screen-title [data-action="settings"]');
  const setRange = (key, v) =>
    page.evaluate(
      ([k, val]) => {
        const el = document.querySelector(`input[data-setting="${k}"]`);
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      [key, v],
    );
  await setRange('volume', 0.3);
  await page.waitForTimeout(400);
  s = await snap();
  check('master volume changes the audio output gain', s.volume === 0.3 && Math.abs(s.audioGain - 0.21) < 0.03, `volume ${s.volume}, gain ${f2(s.audioGain)} (${s.audioState})`);
  await click('.screen-settings [data-seg="muted"][data-value="true"]');
  await page.waitForTimeout(400);
  s = await snap();
  check('Sound Off silences the output', s.muted && s.audioGain < 0.02, f2(s.audioGain));
  await click('.screen-settings [data-seg="muted"][data-value="false"]');
  await setRange('hudScale', 1.2);
  const hs = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hud-scale').trim());
  check('HUD size setting applies', hs === '1.2', hs);
  await setRange('cameraSensitivity', 1.5);
  await setRange('mouseSensitivity', 0.6);
  await setRange('touchSensitivity', 1.4);
  await click('.screen-settings [data-seg="quality"][data-value="low"]');
  s = await snap();
  check('Low quality disables particles', s.quality === 'low' && !s.particles);
  await click('.screen-settings [data-seg="showHints"][data-value="false"]');
  await click('.screen-settings [data-seg="showFps"][data-value="true"]');
  await click('.screen-settings [data-action="back"]');
  await page.reload({ timeout: 180000 });
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  s = await snap();
  check(
    'settings persist across reload',
    s.settings.volume === 0.3 && s.settings.hudScale === 1.2 && s.settings.cameraSensitivity === 1.5 && s.settings.mouseSensitivity === 0.6 && s.settings.quality === 'low' && !s.settings.showHints && s.settings.showFps,
    JSON.stringify(s.settings),
  );
  check('progress persists across reload', s.progress.unlocked === 10 && !!s.progress.best['city-driving'] && !!s.progress.best['street-race']);
  // Mouse sensitivity affects look speed
  await page.evaluate(() => window.__cityRacer.startLevel(-1));
  await adv(0.2);
  const y0 = (await snap()).camYaw;
  await page.mouse.move(480, 300);
  await page.mouse.down();
  await page.mouse.move(580, 300, { steps: 2 });
  await page.mouse.up();
  await adv(0.05);
  await page.waitForTimeout(300);
  const y1 = (await snap()).camYaw;
  const turned = Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0)));
  check('camera × mouse sensitivity scales the look speed (100 px → 0.47 rad at 1.5×0.6)', Math.abs(turned - 100 * 0.0052 * 0.9) < 0.08, f2(turned));
  check('hint line hidden when control hints are off', await page.evaluate(() => document.querySelector('.controls-hint').classList.contains('hidden')));
  check('FPS counter shown when enabled', await page.evaluate(() => !document.querySelector('.fps').classList.contains('hidden')));
  s = await snap();
  check('Free Roam: on foot with no mission panel', s.state === 'onFoot' && s.mission.levelId === 'free-roam' && (await page.evaluate(() => document.querySelector('.mission').classList.contains('hidden'))));
  // restore defaults for the next run
  await page.evaluate(() => localStorage.removeItem('city-racer.settings.v1'));
}

const relevant = consoleErrors.filter((e) => !/GPU stall due to ReadPixels|Automatic fallback to software WebGL|WebGL.*performance/i.test(e));
check('no console errors or warnings during the run', relevant.length === 0, relevant.slice(0, 6).join(' | ') || 'none');
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'BROWSER QA PASSED' : 'BROWSER QA FAILED');
process.exit(failures === 0 ? 0 : 1);
