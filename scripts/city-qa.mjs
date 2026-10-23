/**
 * Living-city QA (Phase 3) in headless Chromium (software WebGL): traffic, signals, pedestrians,
 * garage, navigation, damage, police and career. Uses the dev/QA-only test hook for time control
 * and placement, real keyboard / mouse input for player actions.
 *
 *   npm run build:qa && npm run preview:qa      (URL = http://localhost:4174/)
 *   node scripts/city-qa.mjs [URL] [--only=section,section]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || process.env.URL || 'http://localhost:4174/';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const SHOTS = new globalThis.URL('../qa-shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};
const want = (section) => ONLY.length === 0 || ONLY.includes(section);

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
async function freshPage() {
  const state = context ? await context.storageState() : undefined;
  if (browser) {
    const old = browser;
    await Promise.race([old.close(), new Promise((r) => setTimeout(r, 15000))]);
    try { old.process?.()?.kill('SIGKILL'); } catch { /* gone */ }
  }
  await openBrowser(state);
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
}
const H = (f, a) => page.evaluate(f, a);
const snap = () => H(() => window.__cityRacer.snapshot());
const adv = (s) => H((x) => window.__cityRacer.qaAdvance(x), s);
const city = () => H(() => window.__cityRacer.cityInfo());
const freeze = (on) => H((v) => window.__cityRacer.qaFreeze(v), on);
const teleChar = (i, off, yaw) => H(([a, b, c]) => window.__cityRacer.debugTeleportCharacter(a, b, c ?? undefined), [i, off, yaw ?? null]);
const teleCar = (i, off, yaw = 0) => H(([a, b, c]) => window.__cityRacer.debugTeleport(a, b, c), [i, off, yaw]);
const setCamYaw = (y) => H((v) => window.__cityRacer.setCameraYaw(v), y);
const visibleScreen = () => H(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null);
const shot = async (name) => {
  await freeze(true);
  const st = (await snap()).state;
  if (st === 'driving' || st === 'onFoot') await H(() => window.__cityRacer.snapCamera());
  try {
    await page.screenshot({ path: `${SHOTS}${name}.png`, timeout: 150000 });
  } catch (e) {
    console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`);
  }
};
async function stopCarQuick() {
  await page.keyboard.down('Space');
  await adv(2.0);
  await page.keyboard.up('Space');
}
async function enterCar() {
  await page.keyboard.press('KeyE');
  await adv(1.3);
}
/** Footprint overlap between two traffic cars (separating axes, generous 4.4 x 1.8 boxes). */
function overlapping(cars) {
  let n = 0;
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const A = cars[a];
      const B = cars[b];
      if (A.mode !== 1 || B.mode !== 1) continue;
      if (Math.hypot(A.x - B.x, A.z - B.z) < 3.2) n++;
    }
  }
  return n;
}

await freshPage();
await H(() => window.__cityRacer.setProgress({ unlocked: 5, best: {}, paint: 'red' }));

// ====================================================================== title backdrop
if (want('title')) {
  const c0 = await city();
  await page.waitForTimeout(6000);
  const c1 = await city();
  const moved = c1.cars.filter((x, k) => c0.cars[k] && Math.hypot(x.x - c0.cars[k].x, x.z - c0.cars[k].z) > 1).length;
  const s0 = await snap();
  check('title screen: the city behind the menu is alive (traffic moves, people walk)', (await visibleScreen()) === 'title' && c1.trafficOn && moved >= 5 && c1.peds.stats.active > 0, `${moved} cars moved, ${c1.peds.stats.active} pedestrians, screen ${await visibleScreen()}, state ${s0.state}`);
}

// ====================================================================== traffic
if (want('traffic')) {
  await freeze(true);
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.2);
  let c = await city();
  check('free roam: traffic is on and populated', c.trafficOn && c.traffic.active >= 9, `${c.traffic.active} cars`);
  const p0 = c.cars.map((x) => [x.x, x.z]);
  await adv(20);
  c = await city();
  const moved = c.cars.filter((x, k) => p0[k] && Math.hypot(x.x - p0[k][0], x.z - p0[k][1]) > 20).length;
  check('traffic drives (most cars moved > 20 m in 20 s)', moved >= Math.floor(c.cars.length / 2), `${moved}/${c.cars.length}`);
  check('traffic: no two cars on top of each other', overlapping(c.cars) === 0, `${overlapping(c.cars)}`);
  check('traffic: signals cycle and nobody runs a red light', c.traffic.violations === 0 && c.signals.some((s) => s.car !== 'green'), `${c.traffic.violations} violations; ${c.signals.map((s) => s.car[0]).join('')}`);
  // A crossing in walk phase: lights are red for cars.
  await H(() => window.__cityRacer.setSignalPhase(0, 3));
  c = await city();
  check('signal 0 forced to walk: pedestrians walk, cars red', c.signals[0].ped === 'walk' && c.signals[0].car === 'red', JSON.stringify(c.signals[0]));
  // Player car parked in a lane: traffic queues behind it (never drives into it).
  await teleChar(28, 9.1, 0);
  await adv(0.1);
  await H(() => window.__cityRacer.debugTeleport(30, 1.75, 0));
  await adv(25);
  c = await city();
  const s = await snap();
  const tooClose = c.cars.filter((x) => x.mode === 1 && Math.hypot(x.x - s.position.x, x.z - s.position.z) < 3.0).length;
  check('traffic never drives into the parked player car', tooClose === 0, `${tooClose} cars within 3 m`);
  // Screenshot of a crossing with traffic (camera yaw along the road).
  await H(() => window.__cityRacer.setSignalPhase(1, 0));
  await teleChar(220, -9.6, 0);
  await adv(40);
  const t = await H(() => window.__cityRacer.trackPoint(220, 0));
  await setCamYaw(Math.atan2(t.tx * 0.8 + t.rx * 0.6, t.tz * 0.8 + t.rz * 0.6));
  await adv(0.3);
  await shot('city-01-crossing');
  await freeze(true);
  c = await city();
  check('traffic re-flows around the player after moving across town', c.cars.filter((x) => x.mode === 1 && Math.hypot(x.x - t.x, x.z - t.z) < 150).length >= 4, `${c.cars.filter((x) => x.mode === 1 && Math.hypot(x.x - t.x, x.z - t.z) < 150).length} cars within 150 m`);
  // In a mission there is no traffic.
  await H(() => window.__cityRacer.startLevel(1));
  await adv(0.3);
  c = await city();
  check('missions run without ambient traffic', !c.trafficOn && c.traffic.active === 0, `${c.traffic.active} cars`);
}

// ================================================================== pedestrians
if (want('peds')) {
  await freshPage();
  await freeze(true);
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(2);
  // Screenshot first (software GL slows down over a long session): look at the nearest pedestrians.
  {
    const me = (await snap()).character;
    const c0 = await city();
    const n = c0.peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - me.x, q.z - me.z) })).sort((a, b) => a.d - b.d)[0];
    await setCamYaw(Math.atan2(n.x - me.x, n.z - me.z));
    await adv(0.1);
    const c1 = await city();
    check('pedestrians are drawn near the player', c1.peds.visible >= 3, `${c1.peds.visible} visible, nearest ${n.d.toFixed(1)} m`);
    await shot('city-02-pedestrians');
    await freeze(true);
    // Rendering: the whole crowd is GPU-instanced (baked skinning texture + outfit atlas).
    const d = c1.peds.draw;
    const drawn = d.reduce((n, m) => n + (m.visible ? m.count : 0), 0);
    check('crowd is GPU-instanced: all visible pedestrians in ≤ 2 instanced draws', d.length <= 2 && d.every((m) => m.instanced) && drawn === c1.peds.visible && drawn >= 3, d.map((m) => `${m.name} ×${m.count}${m.shadow ? ' (shadow)' : ''}`).join(', '));
    const variants = new Set(d.flatMap((m) => m.poses.map((q) => q[3])));
    check('crowd shows several outfits from the atlas', variants.size >= 3, `${variants.size} outfits`);
    // Animation: let the real-time loop run a few frames and compare the baked pose each person shows.
    // Meanwhile watch for exact blends: nearby people between clips (here: ramping up from idle as the
    // level starts) get a pose solved on the CPU in one of the 24 rows from exactRow0 on, instead of a
    // linear mix of two baked rows (which folds limbs).
    const before = d.flatMap((m) => m.poses.map((q) => `${q[0]}/${q[1]}/${q[2].toFixed(2)}`));
    const row0 = c1.peds.exactRow0;
    const me2 = (await snap()).character;
    let exact = 0;
    let bad = 0;
    let far = 0;
    const scan = (ps) => {
      for (const q of ps) {
        if (q[0] < row0 && q[1] < row0) continue;
        exact++;
        if (q[0] !== q[1] || q[2] !== 0 || q[0] >= row0 + 24 || q[0] !== Math.floor(q[0])) bad++;
        if (Math.hypot(q[4] - me2.x, q[5] - me2.z) > 75) far++;
      }
    };
    await freeze(false);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      scan((await city()).peds.draw.flatMap((m) => m.poses));
      await page.waitForTimeout(200);
    }
    await freeze(true);
    const after = (await city()).peds.draw.flatMap((m) => m.poses.map((q) => `${q[0]}/${q[1]}/${q[2].toFixed(2)}`));
    const changed = before.filter((v, k) => after[k] !== undefined && after[k] !== v).length;
    check('pedestrian poses animate over time', changed >= Math.min(before.length, after.length) / 3, `${changed}/${Math.min(before.length, after.length)} changed in 5 s real time`);
    if (exact === 0) {
      await freeze(false);
      while (Date.now() - t0 < 25000 && exact === 0) {
        scan((await city()).peds.draw.flatMap((m) => m.poses));
        await page.waitForTimeout(200);
      }
      await freeze(true);
    }
    check('nearby pedestrians between clips use the exact pose blend', exact > 0 && bad === 0 && far === 0, `${exact} exact poses seen in ${((Date.now() - t0) / 1000).toFixed(1)} s (rows from ${row0}), ${bad} invalid, ${far} beyond range`);
  }
  let c = await city();
  check('free roam: pedestrians populate the sidewalks', c.peds.stats.active >= 14, `${c.peds.stats.active} pedestrians`);
  const inside = async () => H(() => {
    const h = window.__cityRacer;
    return h.cityInfo().peds.list.filter((p) => h.buildingAt(p.x, p.z, 0)).length;
  });
  let worstInside = 0;
  let onRoad = 0;
  for (let k = 0; k < 12; k++) {
    await adv(10);
    worstInside = Math.max(worstInside, await inside());
    c = await city();
    onRoad += c.peds.list.filter((p) => Math.abs(p.lat) < 7.35 && p.mode !== 5).length;
  }
  c = await city();
  check('pedestrians never stand inside a building (2 min, sampled every 10 s)', worstInside === 0, `${worstInside}`);
  check('pedestrians are only on the road when using a crossing', onRoad === 0 && c.peds.stats.offCrossingRoad === 0, `${onRoad} sampled, ${c.peds.stats.offCrossingRoad} counted`);
  check('pedestrians walk and keep walking', c.peds.list.filter((p) => p.speed > 0.6).length >= c.peds.list.length / 3, `${c.peds.list.filter((p) => p.speed > 0.6).length}/${c.peds.list.length} moving`);
  check('signals: crossings only on WALK, road clear before cars get green', c.peds.stats.badStarts === 0 && c.peds.stats.onRoadAtGreen === 0, `${c.peds.stats.crossStarted} crossings started, ${c.peds.stats.badStarts} bad, ${c.peds.stats.onRoadAtGreen} at green`);
  check('pedestrians keep clear of furniture and each other', c.peds.stats.minClear > 0 && c.peds.stats.minSep > 0.4, `clear ${c.peds.stats.minClear.toFixed(2)} m, sep ${c.peds.stats.minSep.toFixed(2)} m at ${c.peds.sepInfo}`);
  // Mission: no pedestrians.
  await H(() => window.__cityRacer.startLevel(0));
  await adv(0.3);
  c = await city();
  check('missions run without pedestrians', c.peds.stats.active === 0 && c.peds.visible === 0, `${c.peds.stats.active}`);
}

// ====================================================================== WebGL context loss / restore
// Phones drop the GPU context when the app is backgrounded. After the restore the game must draw the
// very same frame as before (crowd poses, environment map, atlases, instancing all rebuilt) and must not
// touch objects of the dead context (WebGL errors). Some nearby people are caught mid-blend, and the
// first frame after the restore runs a crowd update before rendering — the worst case for row uploads.
if (want('context')) {
  const pixelDiff = (a, b) => H(async ([u1, u2]) => {
    const load = async (u) => {
      const i = new Image();
      i.src = u;
      await i.decode();
      const cv = document.createElement('canvas');
      cv.width = i.width;
      cv.height = i.height;
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.drawImage(i, 0, 0);
      return x.getImageData(0, 0, i.width, i.height).data;
    };
    const [p, q] = await Promise.all([load(u1), load(u2)]);
    let bad = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 24) bad++;
    return bad;
  }, [a, b]);
  const loseRestore = async () => {
    await H(() => {
      window.__qaLose = document.querySelector('canvas.game-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
      window.__qaLose.loseContext();
    });
    await page.waitForFunction(() => !document.querySelector('.notice-screen').classList.contains('hidden'), null, { timeout: 60000 });
    await H(() => window.__qaLose.restoreContext());
    await page.waitForFunction(() => document.querySelector('.notice-screen').classList.contains('hidden'), null, { timeout: 120000 });
  };
  const glSince = (n) => consoleErrors.slice(n).filter((e) => /WebGL/i.test(e));

  // Title screen: the live city backdrop (traffic + crowd) keeps updating every frame.
  await freshPage();
  const titleGrab = () => H(() => {
    const h = window.__cityRacer;
    h.qaFreeze(true); // renderFrame: menu city + crowd update, then render
    const info = h.cityInfo().peds;
    return { url: document.querySelector('canvas.game-canvas').toDataURL('image/png'), visible: info.visible, screen: document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null };
  });
  const t0 = await titleGrab();
  const e0 = consoleErrors.length;
  await loseRestore();
  const t1 = await titleGrab();
  const tDiff = await pixelDiff(t0.url, t1.url);
  check('context restore on the title: backdrop frame identical (city, traffic, crowd)', tDiff === 0 && t0.visible > 0 && t0.screen === 'title' && t1.screen === 'title', `${tDiff} pixels differ; ${t0.visible} people visible; screen ${t0.screen} -> ${t1.screen}`);
  // Live: lose and restore while the backdrop is animating in real time, then let it run on.
  await freeze(false);
  await page.waitForTimeout(500);
  await loseRestore();
  const frames = await H(() => new Promise((res) => { let n = 0; const f = () => (++n >= 4 ? res(n) : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  const live = await H(() => ({
    screen: document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null,
    play: !!document.querySelector('.screen-title button.primary:not([disabled])'), // Play, or Continue once there is progress
    toast: [...document.querySelectorAll('.toast.show')].some((e) => e.offsetParent !== null),
    visible: window.__cityRacer.cityInfo().peds.visible,
  }));
  const tErr = glSince(e0);
  check('context restore on the live title: no WebGL errors, title usable, no in-game toast', tErr.length === 0 && live.screen === 'title' && live.play && !live.toast && live.visible > 0 && frames >= 4, `${tErr.length} WebGL errors; screen ${live.screen}; primary button ${live.play}; toast ${live.toast}; ${live.visible} people visible after ${frames} frames`);
  const label = await H(() => document.querySelector('.screen-title button.primary').dataset.action);
  await page.click('.screen-title button.primary', { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen !== 'title' || window.__cityRacer.snapshot().state !== 'menu', null, { timeout: 120000 });
  const next = await H(() => ({ screen: document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null, state: window.__cityRacer.snapshot().state }));
  check('title menu works after a restore', next.screen !== 'title' || next.state !== 'menu', `${label} -> screen ${next.screen}, state ${next.state}`);

  // In game, frozen view of the nearest pedestrians (some mid-blend).
  await freshPage();
  await freeze(true);
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(2);
  await freeze(false);
  await page.waitForTimeout(600);
  await freeze(true);
  const yaw = await H(() => {
    const h = window.__cityRacer;
    const me = h.snapshot().character;
    const n = h.cityInfo().peds.list.map((q) => ({ ...q, d: Math.hypot(q.x - me.x, q.z - me.z) })).sort((a, b) => a.d - b.d)[0];
    return Math.atan2(n.x - me.x, n.z - me.z);
  });
  const grab = () => H((a) => {
    const h = window.__cityRacer;
    h.setCameraYaw(a);
    const info = h.cityInfo().peds;
    const exact = info.draw.flatMap((m) => m.poses).filter((q) => q[0] >= info.exactRow0).length;
    h.setCameraYaw(a);
    return { url: document.querySelector('canvas.game-canvas').toDataURL('image/png'), exact };
  }, yaw);
  const before = await grab();
  const errs0 = consoleErrors.length;
  await loseRestore();
  await freeze(true); // renderFrame: crowd update first, then the first render in the new context
  const after = await grab();
  const diff = await pixelDiff(before.url, after.url);
  const glErrs = consoleErrors.slice(errs0).filter((e) => /WebGL/i.test(e));
  check('context restore: the same frame is drawn again (crowd, environment, atlases)', diff === 0 && before.exact > 0 && after.exact > 0, `${diff} pixels differ; ${before.exact} / ${after.exact} people mid-blend before / after`);
  check('context restore: no WebGL calls on objects of the lost context', glErrs.length === 0, glErrs.slice(0, 2).join(' | ') || 'none');
  const st = await snap();
  check('context restore: game paused and resumable', st.state === 'paused', st.state);
}

// ====================================================================== garage
if (want('garage')) {
  await freshPage();
  const gi = () => H(() => window.__cityRacer.garageInfo());
  const text = (sel) => H((q) => document.querySelector(q)?.textContent?.trim() ?? '', sel);
  const tap = async (sel) => {
    await page.click(sel, { timeout: 20000 });
    await page.waitForTimeout(150);
  };
  await H(() => window.__cityRacer.setProgress({ unlocked: 5, best: {}, paint: 'red' }));
  await tap('.screen-title [data-action="garage"]');
  const cards = await page.locator('.car-card').count();
  check('garage: eight cars listed, starter car marked as driving', (await visibleScreen()) === 'garage' && cards === 8 && (await text('.car-card.driving .cc-name')) === 'Kestrel GT', `${cards} cards, driving "${await text('.car-card.driving .cc-name')}"`);
  const figs = await text('.car-figures');
  check(
    'garage: real stats (power, weight, top speed, drivetrain, weight split, clearance), 4 upgrades incl. suspension, parts and paint',
    (await page.locator('.stat-bar').count()) === 6 && (await page.locator('.upgrade-row').count()) === 4 && (await text('.upgrade-row:nth-child(4) .up-text b')) === 'Suspension' &&
      (await page.locator('.part-row').count()) === 3 && (await page.locator('.swatch').count()) === 10 && /kW/.test(figs) && /RWD/.test(figs) && /51\/49/.test(figs) && /236/.test(figs),
    figs.replace(/\s+/g, ' '),
  );
  check('garage: the factory parts are marked fitted', (await text('.part.selected[data-slot="spoiler"] .pt-name')) === 'Sport wing' && (await text('.part.selected[data-slot="wheels"] .pt-name')) === 'Five-spoke');
  await shot('garage-desktop');
  await freeze(false);
  await tap('.car-card[data-car="pip"]');
  let g = await gi();
  const pipBtn = await text('.car-detail .btn-row .btn');
  check('garage: browsing a car previews it on the stage without changing the selected car', g.style === 'hatch' && g.progress.car === 'kestrel' && (await text('.car-title')) === 'Pip GTi', `style ${g.style}, selected ${g.progress.car}`);
  check('garage: unaffordable car shows how many credits are missing (buy disabled)', /3,000 cr short/.test(pipBtn) && (await page.locator('[data-action="gbuy"]').count()) === 0, pipBtn);
  await tap('.car-card[data-car="brute"]');
  g = await gi();
  check('garage: star-locked car explains the requirement', g.style === 'muscle' && /Needs 6 ★/.test(await text('.car-detail .btn-row .btn')) && (await text('.car-card[data-car="brute"] .cc-status')) === '6 ★ needed', await text('.car-detail .btn-row .btn'));
  await tap('.car-card[data-car="atlas"]');
  g = await gi();
  check('garage: the SUV preview stands on its own bigger wheels and taller suspension', g.style === 'suv' && Math.abs(g.wheelRadius - 0.38) < 1e-6 && g.rideHeight > 0.6 && g.driveFront === 0.45, `wheel ${g.wheelRadius}, ride ${g.rideHeight.toFixed(3)}, front drive ${g.driveFront}`);
  check('garage: locked car shows price and unlock requirement', /Price 6,000 cr · unlocks at 4 ★ \(you have 0\)/.test(await text('.unlock-line')), await text('.unlock-line'));
  await shot('garage-suv-preview');
  await freeze(false);
  for (const id of ['meridian', 'ridgeback', 'apex']) {
    await tap(`.car-card[data-car="${id}"]`);
    await shot(`garage-${id}-preview`);
    await freeze(false);
  }
  await tap('.car-card[data-car="vortex"]');
  await shot('garage-vortex-preview');
  await freeze(false);
  await tap('.screen-garage [data-action="back"]');
  g = await gi();
  check('leaving the garage puts the driven car back on the stage (body, wheels, ride height)', g.style === 'coupe' && g.vehicleId === 'kestrel' && Math.abs(g.wheelRadius - 0.34) < 1e-6 && Math.abs(g.rideHeight - 0.5634) < 0.001, `${g.style} wheel ${g.wheelRadius} ride ${g.rideHeight}`);
  check('look input is off again outside the garage', !g.orbit.lookEnabled && !g.orbit.interactive);

  // Orbit preview: drag the car / scroll to zoom; drags on the panel do not move the camera.
  await tap('.screen-title [data-action="garage"]');
  g = await gi();
  check('garage enables the orbit camera', g.orbit.interactive && g.orbit.lookEnabled);
  const yaw0 = g.orbit.yaw;
  await page.mouse.move(860, 260);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(860 - k * 20, 260 + k * 6);
  await page.mouse.up();
  await page.waitForTimeout(200);
  g = await gi();
  const dYaw = Math.abs(Math.atan2(Math.sin(g.orbit.yaw - yaw0), Math.cos(g.orbit.yaw - yaw0)));
  check('dragging beside the panel orbits the car (yaw and pitch)', dYaw > 0.7 && g.orbit.pitch > 0.2, `yaw moved ${dYaw.toFixed(2)} rad, pitch ${g.orbit.pitch.toFixed(2)}`);
  await page.mouse.move(860, 260);
  for (let k = 0; k < 4; k++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(200);
  const z1 = (await gi()).orbit.zoom;
  check('mouse wheel zooms the preview in', z1 < 0.8, `zoom ${z1.toFixed(2)}`);
  const yaw1 = (await gi()).orbit.yaw;
  const panel = await page.locator('.garage-panel').boundingBox();
  await page.mouse.move(panel.x + 40, panel.y + 30);
  await page.mouse.down();
  await page.mouse.move(panel.x + 200, panel.y + 30, { steps: 6 });
  await page.mouse.up();
  const yaw2 = (await gi()).orbit.yaw;
  check('dragging on the garage panel does not move the camera', Math.abs(Math.atan2(Math.sin(yaw2 - yaw1), Math.cos(yaw2 - yaw1))) < 0.2, `${yaw1.toFixed(2)} → ${yaw2.toFixed(2)}`);
  // Frame time is capped at 0.1 s and software GL renders a few frames per second, so wait on the condition.
  const resumed = await page
    .waitForFunction((y) => { const v = window.__cityRacer.garageInfo().orbit.yaw; return Math.abs(Math.atan2(Math.sin(v - y), Math.cos(v - y))) > 0.005; }, yaw2, { timeout: 120000, polling: 500 })
    .then(() => true, () => false);
  const yaw3 = (await gi()).orbit.yaw;
  check('after a few idle seconds the preview resumes its slow turn', resumed, `${yaw2.toFixed(3)} → ${yaw3.toFixed(3)}`);
  await shot('garage-orbit-zoomed');
  await freeze(false);
  await tap('.screen-garage [data-action="back"]');

  // Buy / upgrade / paint / select through the UI
  await H((p) => window.__cityRacer.setProgress({ ...p, credits: 40000 }), g.progress);
  await tap('.screen-title [data-action="garage"]');
  await tap('.car-card[data-car="pip"]');
  await tap('[data-action="gbuy"][data-car="pip"]');
  g = await gi();
  const stored = await H(() => [localStorage.getItem('city-racer.progress.v2'), localStorage.getItem('city-racer.progress.v2.backup')]);
  check('buying a car: credits charged, car owned, selected and driving with its own handling', g.vehicleId === 'pip' && g.style === 'hatch' && g.mass === 1080 && g.redline === 6800 && g.progress.credits === 37000 && g.progress.owned.includes('pip'), `vehicle ${g.vehicleId}, mass ${g.mass}, credits ${g.progress.credits}`);
  check('purchase saved to both the main save and its backup', stored.every((x) => x && JSON.parse(x).owned.includes('pip') && JSON.parse(x).car === 'pip'));
  const drive0 = g.maxDriveForce;
  await tap('[data-action="gupgrade"][data-upgrade="engine"]');
  g = await gi();
  check('engine upgrade: charged, level shown, and the car really gets stronger', g.maxDriveForce > drive0 * 1.05 && g.progress.cars.pip.upgrades.engine === 1 && g.progress.credits === 37000 - 1050 && (await page.locator('.upgrade-row').first().locator('.pips i.on').count()) === 1, `drive force ${Math.round(drive0)} → ${Math.round(g.maxDriveForce)}, credits ${g.progress.credits}`);
  await tap('.swatch[data-paint="blue"]');
  g = await gi();
  check('paint applies to this car only', g.progress.cars.pip.paint === 'blue' && g.progress.cars.kestrel.paint === 'red' && g.progress.paint === 'blue');
  await tap('.car-card[data-car="kestrel"]');
  await tap('[data-action="gselect"][data-car="kestrel"]');
  g = await gi();
  const kestrelOk = g.vehicleId === 'kestrel' && g.style === 'coupe' && g.mass === 1350 && g.progress.paint === 'red';
  await tap('.car-card[data-car="pip"]');
  await tap('[data-action="gselect"][data-car="pip"]');
  g = await gi();
  check('switching between owned cars swaps handling, body and paint', kestrelOk && g.vehicleId === 'pip' && g.mass === 1080 && g.progress.paint === 'blue');
  // Parts: buy + fit through the UI; the model really changes; refitting factory parts is free.
  const cr0 = g.progress.credits;
  await tap('.part[data-slot="wheels"][data-part="mesh"]');
  g = await gi();
  check('buying wheels: charged once, owned, fitted on the car', g.look.wheels === 'mesh' && g.progress.cars.pip.look.wheels === 'mesh' && g.progress.cars.pip.parts.includes('wheels:mesh') && g.progress.credits === cr0 - 650, `look ${JSON.stringify(g.look)}, credits ${cr0} → ${g.progress.credits}`);
  await tap('.part[data-slot="spoiler"][data-part="gt"]');
  await tap('.part[data-slot="kit"][data-part="street"]');
  g = await gi();
  check('spoiler and body kit fitted (model rebuilt with them)', g.look.spoiler === 'gt' && g.look.kit === 'street' && (await text('.part.selected[data-slot="kit"] .pt-name')) === 'Street kit', JSON.stringify(g.look));
  await shot('garage-pip-parts');
  await freeze(false);
  const cr1 = g.progress.credits;
  await tap('.part[data-slot="spoiler"][data-part="roof"]');
  await tap('.part[data-slot="spoiler"][data-part="gt"]');
  g = await gi();
  check('refitting a factory or already-bought part is free', g.progress.credits === cr1 && g.look.spoiler === 'gt' && (await text('.part[data-slot="spoiler"][data-part="roof"] .pt-status')) === 'Factory');
  check('parts are labelled as looks only', /no effect on handling/i.test(await text('.garage-panel')));
  const susp0 = g.suspensionStiffness;
  await tap('[data-action="gupgrade"][data-upgrade="suspension"]');
  g = await gi();
  check('suspension upgrade: charged and the driven car gets stiffer springs', g.suspensionStiffness > susp0 * 1.1 && g.progress.cars.pip.upgrades.suspension === 1, `${susp0} → ${g.suspensionStiffness}`);
  await tap('.screen-garage [data-action="back"]');

  // Persistence and damaged saves
  const waitReady = () => page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await page.reload({ timeout: 180000 });
  await waitReady();
  g = await gi();
  const credAfter = g.progress.credits;
  check(
    'after a reload the bought car, its upgrades, parts and paint are still there',
    g.vehicleId === 'pip' && g.style === 'hatch' && g.maxDriveForce > drive0 * 1.05 && g.progress.cars.pip.paint === 'blue' && g.look.wheels === 'mesh' && g.look.spoiler === 'gt' && g.look.kit === 'street' && g.progress.cars.pip.upgrades.suspension === 1,
    `vehicle ${g.vehicleId}, credits ${g.progress.credits}, look ${JSON.stringify(g.look)}`,
  );
  await H(() => localStorage.setItem('city-racer.progress.v2', '{"version":2,"credits":9'));
  await page.reload({ timeout: 180000 });
  await waitReady();
  g = await gi();
  check('corrupted save: progress recovered from the backup copy', g.vehicleId === 'pip' && g.progress.credits === credAfter && g.look.kit === 'street');
  await H(() => {
    localStorage.setItem('city-racer.progress.v2', 'garbage');
    localStorage.setItem('city-racer.progress.v2.backup', '{"car":42,"owned":"x","credits":"lots"}');
    localStorage.removeItem('city-racer.progress.v1');
  });
  await page.reload({ timeout: 180000 });
  await waitReady();
  g = await gi();
  check('unreadable saves: the game still starts with a clean starter profile', g.vehicleId === 'kestrel' && g.progress.credits === 0 && g.progress.owned.join() === 'kestrel' && (await visibleScreen()) === 'title');

  // In-game handling: same start, same input, three cars
  const speeds = {};
  for (const id of ['pip', 'kestrel', 'vortex']) {
    await H((c) => window.__cityRacer.setProgress({ version: 2, unlocked: 5, owned: ['kestrel', 'pip', 'brute', 'vortex'], car: c }), id);
    await H(() => window.__cityRacer.startLevel(2)); // City Driving (car at i332)
    await adv(0.3);
    await teleChar(332, 5.25 - 2.3);
    await adv(0.1);
    await enterCar();
    await page.keyboard.down('KeyW');
    await adv(3.0);
    const s = await snap();
    await page.keyboard.up('KeyW');
    speeds[id] = s.state === 'driving' && (await gi()).vehicleId === id ? s.speedKmh : -1;
    await page.keyboard.press('Escape');
    await tap('.screen-pause [data-action="quit"]');
  }
  check('in a mission the cars accelerate differently (Vortex > Kestrel > Pip after 3 s full throttle)', speeds.vortex > speeds.kestrel + 5 && speeds.kestrel > speeds.pip + 5 && speeds.pip > 20, `Pip ${speeds.pip?.toFixed(0)}, Kestrel ${speeds.kestrel?.toFixed(0)}, Vortex ${speeds.vortex?.toFixed(0)} km/h`);

}

// ====================================================================== garage on a phone (portrait)
if (want('garage') || want('garage-phone')) {
  await page.close().catch(() => undefined); // free the desktop page (2 CPUs, software WebGL)
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => consoleErrors.push(`pageerror (mobile): ${e.message}`));
  await mp.goto(URL, { timeout: 180000 });
  await mp.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await mp.evaluate(() => window.__cityRacer.setProgress({ version: 2, unlocked: 5, credits: 12000, owned: ['kestrel', 'pip'], car: 'pip' }));
  await mp.tap('.screen-title [data-action="garage"]');
  await mp.waitForTimeout(300);
  const fit = await mp.evaluate(() => {
    const panel = document.querySelector('.garage-panel').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.garage-panel button')].map((b) => b.getBoundingClientRect());
    return { panelW: panel.width, left: panel.left, right: panel.right, minH: Math.min(...btns.filter((r) => r.height > 0).map((r) => r.height)), docW: document.documentElement.scrollWidth };
  });
  check('phone portrait: garage fits the screen width, buttons large enough to tap', fit.left >= 0 && fit.right <= 390 && fit.docW <= 390 && fit.minH >= 36, JSON.stringify(fit));
  await mp.tap('[data-action="gupgrade"][data-upgrade="tyres"]');
  const mg = await mp.evaluate(() => window.__cityRacer.garageInfo());
  check('phone portrait: upgrade button works by touch', mg.progress.cars.pip.upgrades.tyres === 1, `tyres ${mg.progress.cars.pip.upgrades.tyres}`);
  // Touch orbit + two-finger pinch on the car (above the panel), via real CDP touch events.
  const cdp = await mctx.newCDPSession(mp);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const o0 = (await mp.evaluate(() => window.__cityRacer.garageInfo())).orbit;
  await touch('touchStart', [[300, 150]]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [[300 - k * 25, 150]]);
  await touch('touchEnd', []);
  await mp.waitForTimeout(150);
  const o1 = (await mp.evaluate(() => window.__cityRacer.garageInfo())).orbit;
  const dy1 = Math.abs(Math.atan2(Math.sin(o1.yaw - o0.yaw), Math.cos(o1.yaw - o0.yaw)));
  check('phone: one-finger drag on the car orbits it', dy1 > 0.6, `yaw moved ${dy1.toFixed(2)} rad`);
  await touch('touchStart', [[195, 160]]);
  await touch('touchStart', [[195, 160], [215, 180]]);
  for (let k = 1; k <= 8; k++) await touch('touchMove', [[195 - k * 12, 160 - k * 6], [215 + k * 12, 180 + k * 6]]);
  await touch('touchEnd', [[195 - 96, 160 - 48]]);
  await touch('touchEnd', []);
  await mp.waitForTimeout(150);
  const o2 = (await mp.evaluate(() => window.__cityRacer.garageInfo())).orbit;
  check('phone: two-finger pinch (spread) zooms in', o2.zoom < o1.zoom * 0.8, `zoom ${o1.zoom.toFixed(2)} → ${o2.zoom.toFixed(2)}`);
  await mp.evaluate(() => window.__cityRacer.qaFreeze(true));
  try {
    await mp.screenshot({ path: `${SHOTS}garage-phone.png`, timeout: 150000 });
  } catch (e) {
    console.log(`(screenshot garage-phone skipped: ${e.message.split('\n')[0]})`);
  }
  await mctx.close();
}

// ====================================================================== navigation
if (want('nav')) {
  await freshPage();
  const nav = () => H(() => window.__cityRacer.navInfo());
  const gi = () => H(() => window.__cityRacer.garageInfo());
  const tap = async (sel) => {
    await page.click(sel, { timeout: 20000 });
    await page.waitForTimeout(150);
  };
  await H(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 2, best: {}, credits: 0 }));
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  let n = await nav();
  const inside = await H((ps) => ps.filter((p) => window.__cityRacer.buildingAt(p.x, p.z, 0.5)).map((p) => p.id), n.pois);
  check('free roam: mission starts, career events and the garage are marked in the city', n.markersVisible && n.pois.length === 23 && n.pois.filter((p) => p.kind === 'mission').length === 15 && n.pois.filter((p) => p.kind === 'event').length === 7, `${n.pois.length} places`);
  check('no marker is inside a building', inside.length === 0, inside.join(',') || 'none');
  check('no prompt at the free-roam spawn point', n.poiPrompt === null, String(n.prompt));
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(300);
  let s = await snap();
  const pins = await page.locator('.map-pin').count();
  const items = await page.locator('.map-dest').count();
  const lockedTxt = await page.locator('.map-dest[data-poi="mission-2"] small').innerText();
  const canvasSize = await H(() => { const c = document.querySelector('canvas.city-map'); return [c.width, c.height]; });
  check('N opens the city map and pauses the game', (await visibleScreen()) === 'map' && s.state === 'paused' && canvasSize[0] > 300 && canvasSize[1] > 200, `${await visibleScreen()} ${s.state} canvas ${canvasSize}`);
  check('map lists every destination with a tappable pin; locked missions say why', pins === 23 && items === 23 && /Locked/.test(lockedTxt), `${pins} pins, ${items} entries, "${lockedTxt}"`);
  await shot('nav-map-desktop');
  await tap('.map-dest[data-poi="garage"]');
  n = await nav();
  s = await snap();
  const pill = await H(() => { const e = document.querySelector('.nav-pill'); return { hidden: e.classList.contains('hidden'), text: e.textContent }; });
  check('choosing a destination closes the map, resumes play and plots a route', s.state === 'onFoot' && (await visibleScreen()) === null && n.dest === 'garage' && n.routeCount > 20, `state ${s.state}, dest ${n.dest}, ${n.routeCount} route points`);
  check('route starts at the player and ends at the garage', Math.hypot(n.route[0] - s.character.x, n.route[1] - s.character.z) < 1 && Math.hypot(n.route.at(-2) - n.pois.find((p) => p.id === 'garage').x, n.route.at(-1) - n.pois.find((p) => p.id === 'garage').z) < 1);
  check('HUD shows the destination and road distance', !pill.hidden && /Garage/.test(pill.text) && /\d+(\.\d)? ?k?m/.test(pill.text), pill.text);
  await shot('nav-route-hud');
  await freeze(false);
  await tap('.minimap-wrap');
  check('tapping the minimap opens the map', (await visibleScreen()) === 'map');
  await tap('[data-action="mapclear"]');
  n = await nav();
  check('Clear route removes the route and the HUD hint', n.dest === null && n.routeCount === 0 && (await H(() => document.querySelector('.nav-pill').classList.contains('hidden'))));
  await tap('.hud-btn[data-action="map"]');
  await tap('.map-pin[data-poi="garage"]');
  check('HUD map button + map pin also set the destination', (await nav()).dest === 'garage');

  // Drive there: arrival, then the city garage
  await teleChar(10, 5.25 - 2.3);
  await adv(0.1);
  await enterCar();
  await teleCar(540, 5.25);
  await adv(0.6);
  n = await nav();
  check('arriving clears the route', n.dest === null && n.routeCount === 0, `dest ${n.dest}`);
  check('stopped at the garage: prompt to open it', n.poiPrompt === 'garage' && /garage/i.test(n.prompt ?? ''), String(n.prompt));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  s = await snap();
  check('E opens the garage right there (game paused)', (await visibleScreen()) === 'garage' && s.state === 'paused');
  await tap('.car-card[data-car="pip"]');
  let g = await gi();
  check('city garage previews cars on the street (selection unchanged) with the orbit camera', g.style === 'hatch' && g.progress.car === 'kestrel' && g.orbit.interactive);
  await shot('nav-city-garage');
  await freeze(false);
  await tap('.screen-garage [data-action="back"]');
  s = await snap();
  g = await gi();
  check('Done returns to driving with the selected car (handling and stance restored)', s.state === 'driving' && (await visibleScreen()) === null && g.style === 'coupe' && g.vehicleId === 'kestrel' && Math.abs(g.wheelRadius - 0.34) < 1e-6 && !g.orbit.interactive, `${s.state} ${g.style} ${g.vehicleId}`);

  // Turn-around hint
  await H(() => window.__cityRacer.setCameraYaw(0));
  await page.keyboard.press('KeyN');
  await tap('.map-dest[data-poi="mission-0"]');
  await teleCar(300, -1.75, Math.PI);
  await adv(0.2);
  const plan0 = await nav();
  await page.keyboard.down('KeyW');
  await adv(1.5);
  await page.keyboard.up('KeyW');
  const turnA = await H(() => document.querySelector('.nav-pill').classList.contains('turn'));
  await teleCar(300, 1.75, 0);
  await page.keyboard.down('KeyW');
  await adv(1.5);
  await page.keyboard.up('KeyW');
  const turnB = await H(() => document.querySelector('.nav-pill').classList.contains('turn'));
  check('driving away from the route shows "Turn around"; driving along it does not', plan0.dest === 'mission-0' && (turnA !== turnB), `one way ${turnA}, other way ${turnB}`);
  await stopCarQuick();

  // Start a mission from its marker; locked missions refuse
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  const m2 = (await nav()).pois.find((p) => p.id === 'mission-1');
  await teleChar(m2.i, m2.off);
  await adv(0.3);
  n = await nav();
  check('standing at an unlocked mission start offers to start it', n.poiPrompt === 'mission-1' && /Start Mission 2/.test(n.prompt ?? ''), String(n.prompt));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(400);
  s = await snap();
  check('E opens that mission\'s briefing', (await visibleScreen()) === 'briefing' && s.state === 'briefing' && /Driving School/i.test(await page.locator('.screen-briefing').innerText()));
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  const m3 = (await nav()).pois.find((p) => p.id === 'mission-2');
  await teleChar(m3.i, m3.off);
  await adv(0.3);
  n = await nav();
  await page.keyboard.press('KeyE');
  await adv(0.3);
  s = await snap();
  check('a locked mission start says so and does nothing', n.poiPrompt === null && /locked/i.test(n.prompt ?? '') && s.state === 'onFoot', String(n.prompt));

  // Missions: map shows the objective only
  await H(() => window.__cityRacer.startLevel(0));
  await adv(0.3);
  n = await nav();
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(300);
  check('during a mission: no city markers, the map shows the objective without destinations', !n.markersVisible && (await visibleScreen()) === 'map' && (await page.locator('.map-dest').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc closes the map and resumes', (await snap()).state === 'onFoot' && (await visibleScreen()) === null);
}

// ====================================================================== navigation on a phone
if (want('nav') || want('nav-phone')) {
  await page.close().catch(() => undefined);
  const mctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => consoleErrors.push(`pageerror (mobile): ${e.message}`));
  await mp.goto(URL, { timeout: 180000 });
  await mp.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await mp.evaluate(() => window.__cityRacer.startLevel(-1));
  await mp.evaluate(() => window.__cityRacer.qaAdvance(0.3));
  const btn = await mp.locator('.hud-btn[data-action="map"]').boundingBox();
  check('phone landscape: map button visible on the touch HUD', !!btn && btn.width >= 40 && btn.height >= 40, JSON.stringify(btn));
  await mp.tap('.hud-btn[data-action="map"]');
  await mp.waitForTimeout(300);
  const fit = await mp.evaluate(() => {
    const r = document.querySelector('.map-panel').getBoundingClientRect();
    const c = document.querySelector('canvas.city-map').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, right: r.right, canvasH: c.height, docW: document.documentElement.scrollWidth };
  });
  check('phone landscape: map fits the screen with a usable map area', fit.top >= 0 && fit.bottom <= 391 && fit.docW <= 844 && fit.canvasH >= 180, JSON.stringify(fit));
  await mp.tap('.map-dest[data-poi="garage"]');
  await mp.waitForTimeout(300);
  const nv = await mp.evaluate(() => window.__cityRacer.navInfo());
  check('phone landscape: tapping a destination sets the route', nv.dest === 'garage' && nv.routeCount > 20);
  await mp.tap('.minimap-wrap');
  await mp.waitForTimeout(300);
  await mp.evaluate(() => window.__cityRacer.qaFreeze(true));
  try {
    await mp.screenshot({ path: `${SHOTS}nav-map-phone.png`, timeout: 150000 });
  } catch (e) {
    console.log(`(screenshot nav-map-phone skipped: ${e.message.split('\n')[0]})`);
  }
  await mctx.close();
}

// ====================================================================== damage
if (want('damage')) {
  await freshPage();
  const dmg = () => H(() => window.__cityRacer.damageInfo());
  const tp = (i, off) => H(([a, b]) => window.__cityRacer.trackPoint(a, b), [i, off]);
  await H(() => window.__cityRacer.setProgress({ version: 2, unlocked: 5, credits: 5000 }));
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  await teleChar(10, 5.25 - 2.3);
  await adv(0.1);
  await enterCar();
  check('damage: the car starts undamaged', (await dmg()).level === 0 && (await snap()).state === 'driving');

  // Small knock (Δv 2.8 m/s ≈ 10 km/h) does nothing.
  await H(() => window.__cityRacer.debugHit(2.8, 1, 0));
  await adv(0.3);
  check('a small knock (below ~11 km/h of impact) leaves no damage', (await dmg()).level === 0);

  // Real crash: aim the car square at a building face and drive into it.
  let target = null;
  for (let k = 120; k < 940 && !target; k += 7) {
    if ([70, 228, 352, 470, 606].some((c) => Math.abs(c - k) < 14)) continue;
    // Building fronts stand 14.5–18 m from the road centre: need a clear path to 12 m and a wall by 18 m
    // (also either side of the line, so the car meets a face, not a corner).
    const at = async (kk, off) => { const q = await tp(kk, off); return H(([a, b]) => window.__cityRacer.buildingAt(a, b, 0), [q.x, q.z]); };
    if (!(await at(k, 9)) && !(await at(k, 12)) && (await at(k, 18)) && (await at(k, 20)) && (await at(k - 2, 18.5)) && (await at(k + 2, 18.5))) target = k;
  }
  let realCrash = null;
  if (target !== null) {
    const t = await tp(target, 0);
    const yawRoad = Math.atan2(-t.tz, t.tx);
    const yawRight = Math.atan2(-t.rz, t.rx);
    await teleCar(target, 3.5, yawRight - yawRoad);
    await adv(0.5);
    await page.keyboard.down('KeyW');
    await adv(3.0);
    await page.keyboard.up('KeyW');
    await adv(0.5);
    realCrash = await dmg();
  }
  check('driving into a building dents the front of the car', !!realCrash && realCrash.zones.front > 0.05 && realCrash.zones.front >= Math.max(realCrash.zones.rear, realCrash.zones.left, realCrash.zones.right), realCrash ? `sample ${target}: front ${realCrash.zones.front.toFixed(2)}, level ${(realCrash.level * 100).toFixed(0)}%` : 'no building found');

  // Heavy rear-right hit (QA hook feeds the same path as a physics collision).
  await teleCar(300, 1.75);
  await adv(0.3);
  await H(() => window.__cityRacer.debugHit(18, -0.7, 0.7));
  await adv(0.3);
  let d = await dmg();
  const ind = await H(() => { const e = document.querySelector('.ind-dmg'); return { hidden: e.classList.contains('hidden'), text: e.textContent }; });
  check('a hard rear-right hit damages the rear and right side and breaks the right tail lamp', d.zones.rear > 0.3 && d.zones.right > 0.3 && d.lamps.tailR && !d.lamps.tailL && d.zones.left < 0.1, JSON.stringify(d.zones) + ' ' + JSON.stringify(d.lamps));
  check('HUD shows the damage level', !ind.hidden && /DAMAGE \d+%/.test(ind.text), ind.text);
  await H(() => window.__cityRacer.debugHit(26, 1, 0));
  await adv(0.3);
  d = await dmg();
  check('a crushed nose costs engine power', d.zones.front >= 0.9 && d.powerScale < 0.8 && d.lamps.headL && d.lamps.headR, `power ×${d.powerScale.toFixed(2)}`);
  await adv(1.5); // let smoke build up
  await shot('damage-rear-right');
  await freeze(false);

  // Repair at the city garage.
  await teleCar(540, 5.25);
  await adv(0.6);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  const priceTxt = await page.locator('.repair-row').innerText().catch(() => '');
  d = await dmg();
  const before = (await H(() => window.__cityRacer.garageInfo())).progress.credits;
  check('garage offers a repair priced by the damage', (await visibleScreen()) === 'garage' && d.repairPrice > 0 && priceTxt.includes(d.repairPrice.toLocaleString('en-US')), priceTxt.replace(/\n/g, ' '));
  await shot('damage-garage');
  await freeze(false);
  await page.click('[data-action="grepair"]');
  await page.waitForTimeout(200);
  const after = (await H(() => window.__cityRacer.garageInfo())).progress.credits;
  const d2 = await dmg();
  check('repair charges credits and restores the car (body, lamps, power)', d2.level === 0 && d2.powerScale === 1 && !Object.values(d2.lamps).some(Boolean) && after === before - d.repairPrice && (await page.locator('.repair-row').count()) === 0, `${before} → ${after} cr`);
  await page.click('.screen-garage [data-action="back"]');
  await page.waitForTimeout(200);

  // Missions start with a fresh car.
  await H(() => window.__cityRacer.debugHit(15, 1, 0));
  await adv(0.3);
  const dirty = (await dmg()).level;
  await H(() => window.__cityRacer.startLevel(0));
  await adv(0.3);
  check('starting a mission gives a fresh, undamaged car', dirty > 0 && (await dmg()).level === 0, `before ${(dirty * 100).toFixed(0)}%`);
}

// ====================================================================== police
if (want('police')) {
  await freshPage();
  const pol = () => H(() => window.__cityRacer.policeInfo());
  const tp = (i, off) => H(([a, b]) => window.__cityRacer.trackPoint(a, b), [i, off]);
  const wantedHud = () => H(() => { const e = document.querySelector('.wanted'); return { hidden: e.classList.contains('hidden'), stars: e.querySelector('.wanted-stars').textContent, state: e.querySelector('.wanted-state').textContent }; });
  const popText = () => H(() => document.querySelector('.pop')?.textContent ?? '');
  await H(() => window.__cityRacer.setProgress({ version: 2, unlocked: 5, credits: 2000 }));
  await freeze(true);
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  let pi = await pol();
  check('free roam: one patrol car out on the road, out of sight, light bar fitted', pi.enabled && pi.units.filter((u) => u.active).length === 1 && pi.units[0].lightbar && pi.nearest > 150 && pi.stars === 0, `${pi.units.filter((u) => u.active).length} active, nearest ${pi.nearest.toFixed(0)} m`);
  check('wanted meter hidden while clear', (await wantedHud()).hidden);
  await adv(4);
  const pi2 = await pol();
  const moved = Math.hypot(pi2.units[0].x - pi.units[0].x, pi2.units[0].z - pi.units[0].z);
  check('the patrol car drives its lane', moved > 25 && moved < 80, `${moved.toFixed(0)} m in 4 s`);
  await teleChar(10, 5.25 - 2.3);
  await adv(0.1);
  await enterCar();
  check('an offence nobody sees is not reported', !(await H(() => window.__cityRacer.policeOffence('redLight'))) && (await pol()).stars === 0);

  // Real red-light run in front of the patrol car: pick a crossing whose +direction lane is free.
  const CROSS = [70, 228, 352, 470, 606];
  let run = null;
  for (let k = 0; k < CROSS.length && !run; k++) {
    const c = CROSS[k];
    await H((kk) => window.__cityRacer.setSignalPhase(kk, 0), k); // green: let the queue drain
    await adv(3);
    const cars = (await city()).cars.filter((x) => x.mode !== 0);
    for (const lane of [1.75, 5.25]) {
      let free = true;
      for (let s = c - 16; s <= c + 6 && free; s += 2) {
        const q = await tp(s, lane);
        if (cars.some((x) => Math.hypot(x.x - q.x, x.z - q.z) < 6)) free = false;
      }
      if (free) { run = { k, c, lane }; break; }
    }
  }
  if (run) {
    await teleCar(run.c - 14, run.lane);
    await H(([k, c]) => { window.__cityRacer.policePlace(0, c + 18, -1, 5.25); window.__cityRacer.setSignalPhase(k, 3); }, [run.k, run.c]);
    await adv(0.2);
    await page.keyboard.down('KeyW');
    let seen = '';
    for (let i = 0; i < 14 && (await pol()).stars === 0; i++) {
      await adv(0.25);
      seen = seen || (await popText());
    }
    await page.keyboard.up('KeyW');
    seen = seen || (await popText());
  }
  pi = await pol();
  const wh = await wantedHud();
  check('running a red light in front of a police car: 1 star, pursuit', !!run && pi.stars === 1 && pi.state === 'pursuit', run ? `crossing ${run.c} lane ${run.lane}: ${pi.stars}★ ${pi.state}, heat ${pi.heat}` : 'no free crossing');
  check('wanted meter shows the stars and the state', !wh.hidden && wh.stars === '★☆☆' && wh.state === 'Pursuit', JSON.stringify(wh));
  await stopCarQuick();

  // Ramming the police (reported through the same path as the physics check) escalates.
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  await adv(0.3);
  pi = await pol();
  check('2 stars bring a second unit', pi.stars === 2 && pi.units.filter((u) => u.active).length === 2 && pi.units[1].lightbar, `${pi.stars}★, ${pi.units.filter((u) => u.active).length} units`);

  // Stay stopped: the units close in and make the arrest.
  const credits0 = (await H(() => window.__cityRacer.garageInfo())).progress.credits;
  let bustedPop = '';
  for (let i = 0; i < 60; i++) {
    await adv(0.5);
    pi = await pol();
    if (pi.state === 'busted') { bustedPop = await popText(); break; }
  }
  const credits1 = (await H(() => window.__cityRacer.garageInfo())).progress.credits;
  check('stopping next to the police gets you busted', pi.state === 'busted', `state ${pi.state}, nearest ${pi.nearest.toFixed(1)} m`);
  check('busted: fined 250 cr per star, saved', credits1 === credits0 - 500 && /Busted! Fined 500 cr/.test(bustedPop), `${credits0} → ${credits1} cr, "${bustedPop}"`);
  check('wanted meter shows Busted', (await wantedHud()).state === 'Busted');
  await adv(3.5);
  pi = await pol();
  check('after the arrest the record is clean again', pi.state === 'clear' && pi.stars === 0 && (await wantedHud()).hidden);

  // Escape: get wanted, then get far away (teleport stands in for a long drive; the real-physics
  // escape is covered by the headless police test) and stay out of sight.
  await adv(0.5);
  await H(([i]) => window.__cityRacer.policePlace(0, i, 1, 5.25), [(await pol()).playerIdx + 9]);
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  pi = await pol();
  await adv(0.25);
  await shot('police-pursuit');
  await freeze(true);
  const startedPursuit = pi.state === 'pursuit' && pi.stars === 1;
  await teleCar(((await pol()).playerIdx + 490) % 984, 5.25);
  await adv(1);
  const searching = (await pol()).state === 'search';
  const searchHud = (await wantedHud()).state;
  let escPop = '';
  for (let i = 0; i < 14; i++) {
    await adv(1);
    escPop = escPop || ((await popText()).includes('lost') ? await popText() : '');
    if ((await pol()).state === 'clear') break;
  }
  pi = await pol();
  check('out of sight → search; 10 s unseen → escaped', startedPursuit && searching && searchHud === 'Searching' && pi.state === 'clear' && pi.stars === 0, `pursuit ${startedPursuit}, search ${searching} (${searchHud}), final ${pi.state}, "${escPop}"`);
  await adv(3);
  check('reinforcements leave once the chase is over (patrol car stays)', (await pol()).units.filter((u) => u.active).length === 1);

  // Missions: no police; the race borrows the same cars without the light bar.
  // Street Race is campaign index 8: unlock it on the current save first.
  await H(() => {
    const p = JSON.parse(localStorage.getItem('city-racer.progress.v2') || '{}');
    window.__cityRacer.setProgress({ ...p, campaign: 2, unlocked: Math.max(p.unlocked || 1, 9) });
    window.__cityRacer.startLevel(8);
  });
  await adv(0.3);
  pi = await pol();
  check('missions have no police; race rivals use the pooled cars without light bars', !pi.enabled && pi.units.every((u) => !u.active && u.carActive && !u.lightbar) && (await wantedHud()).hidden, JSON.stringify(pi.units.map((u) => [u.active, u.carActive, u.lightbar])));
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.3);
  pi = await pol();
  check('back in free roam the patrol returns', pi.enabled && pi.units.filter((u) => u.active).length === 1 && pi.units[0].lightbar);
  await freeze(false);
}

// ====================================================================== audio
if (want('audio')) {
  await freshPage();
  const au = () => H(() => window.__cityRacer.audioInfo());
  // A real click starts Web Audio (browser gesture rule), then free roam.
  await page.click('.screen-title [data-action="free"]', { timeout: 20000 });
  await freeze(true);
  await adv(1.0);
  let a = await au();
  check('audio running in free roam; city bed audible with traffic around', a.state === 'running' && a.diag.bed > 0.05, `${a.state}, bed ${a.diag.bed.toFixed(3)}`);
  // Nearest moving traffic car: stand on the pavement next to it.
  const c = (await city()).cars.filter((x) => x.mode === 1);
  const p0 = await snap();
  let near = c[0];
  for (const x of c) if (Math.hypot(x.x - p0.character.x, x.z - p0.character.z) < Math.hypot(near.x - p0.character.x, near.z - p0.character.z)) near = x;
  const far = a.diag.pass;
  const idx = await H(([x, z]) => {
    const h = window.__cityRacer;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < 984; i++) { const p = h.trackPoint(i, 0); const d = Math.hypot(p.x - x, p.z - z); if (d < bd) [bd, bi] = [d, i]; }
    return bi;
  }, [near.x, near.z]);
  await teleChar(idx, 9.1);
  await adv(0.05);
  a = await au();
  check('a passing car is heard up close (louder than far away)', a.diag.pass > 0.03 && a.diag.pass > far, `near ${a.diag.pass.toFixed(3)} vs before ${far.toFixed(3)}`);
  // Crossing signal ticks during WALK (real time: ticks follow the audio clock).
  await H(() => window.__cityRacer.setSignalPhase(0, 3));
  await teleChar(70, 9.6);
  await adv(0.05);
  // Software GL renders slowly in real time, so render frames explicitly with real-time gaps
  // (ticks follow the audio clock, ~3 per second, at most one per rendered frame).
  const frames = async () => {
    for (let k = 0; k < 6; k++) {
      await adv(0.05);
      await page.waitForTimeout(450);
    }
  };
  const b0 = (await au()).diag.beeps;
  await frames();
  const b1 = (await au()).diag.beeps;
  await H(() => window.__cityRacer.setSignalPhase(0, 0));
  await adv(0.05);
  const b2 = (await au()).diag.beeps;
  await frames();
  const b3 = (await au()).diag.beeps;
  check('pedestrian crossing ticks during WALK and stops on green', b1 - b0 >= 4 && b3 === b2, `${b1 - b0} ticks in walk, ${b3 - b2} after green`);
  // Gear changes: accelerate hard, the shift cue fires on each change.
  await teleChar(120, 5.25 - 2.3);
  await H(() => window.__cityRacer.debugTeleport(120, 5.25, 0));
  await adv(0.1);
  await teleChar(120, 5.25 - 2.3);
  await adv(0.1);
  await enterCar();
  const s0 = (await au()).diag.upshifts;
  await page.keyboard.down('KeyW');
  for (let k = 0; k < 8; k++) await adv(0.5);
  const st = await snap();
  await page.keyboard.up('KeyW');
  a = await au();
  check('gear changes are audible (shift cue on the upshift, engine on)', st.state === 'driving' && a.engineOn && st.gear === '2' && a.diag.upshifts - s0 === 1, `${a.diag.upshifts - s0} upshift cue(s), gear ${st.gear}, ${Math.round(st.speedKmh)} km/h`);
  await stopCarQuick();
  await freeze(false);

  // Hidden page (background tab, locked phone): audio must go quiet in every state, not only in gameplay —
  // the title, briefing and result screens keep the city ambience running while visible.
  await H(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__qaSetHidden = (h) => {
      hidden = h;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  const setHidden = async (h) => {
    await H((v) => window.__qaSetHidden(v), h);
    await page.waitForTimeout(900); // fade + suspend after 200 ms
  };
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__cityRacer.snapshot().state === 'paused', null, { timeout: 90000 });
  await page.click('.screen:not(.hidden) [data-action="quit"]', { timeout: 90000 });
  await page.waitForFunction(() => window.__cityRacer.snapshot().state === 'menu', null, { timeout: 120000 });
  await page.waitForTimeout(600);
  const tv = await au();
  await setHidden(true);
  const th = await au();
  await setHidden(false);
  const tv2 = await au();
  check('hidden page on the title: audio suspended, resumes when visible', tv.state === 'running' && th.state === 'suspended' && th.hidden && tv2.state === 'running' && !tv2.hidden, `${tv.state} -> hidden ${th.state} -> visible ${tv2.state}`);
  await page.click('.screen-title button.primary', { timeout: 90000 });
  await page.waitForFunction(() => window.__cityRacer.snapshot().state === 'briefing', null, { timeout: 120000 });
  const bv = await au();
  await setHidden(true);
  const bh = await au();
  await setHidden(false);
  const bv2 = await au();
  check('hidden page on the briefing: audio suspended, resumes when visible', bv.state === 'running' && bh.state === 'suspended' && bv2.state === 'running', `${bv.state} -> hidden ${bh.state} -> visible ${bv2.state}`);
  await H(() => window.__cityRacer.startLevel(-1));
  await page.waitForTimeout(600);
  const gv = await au();
  await setHidden(true);
  const gh = await au();
  const gs = (await snap()).state;
  await setHidden(false);
  const gv2 = await au();
  const gs2 = (await snap()).state;
  check('hidden page in gameplay: pauses and goes silent, stays paused when visible again', gv.state === 'running' && gh.state === 'suspended' && gs === 'paused' && gs2 === 'paused' && gv2.state === 'suspended', `${gv.state} -> hidden ${gh.state}/${gs} -> visible ${gv2.state}/${gs2}`);
}

// ====================================================================== career
if (want('career')) {
  await freshPage();
  const ci = () => H(() => window.__cityRacer.careerInfo());
  const tap = async (sel) => {
    await page.click(sel, { timeout: 20000 });
    await page.waitForTimeout(150);
  };
  const hold = async (keys, secs) => {
    for (const k of keys) await page.keyboard.down(k);
    await adv(secs);
    for (const k of keys) await page.keyboard.up(k);
    return snap();
  };
  const toTitle = async () => {
    if ((await visibleScreen()) === 'title') return;
    const st = (await snap()).state;
    if (st === 'complete' || st === 'failed') await tap(`.screen-${st} [data-action="career"]`);
    else {
      await page.keyboard.press('Escape');
      await tap('.screen-pause [data-action="quit"]');
    }
    if ((await visibleScreen()) !== 'title') await tap('.screen:not(.hidden) [data-action="back"]');
  };
  await freeze(true);
  await H(() => window.__cityRacer.setProgress({ version: 2, unlocked: 5, best: {}, credits: 1000, career: {} }));
  await tap('.screen-title [data-action="career"]');
  const cards = page.locator('.screen-career .career-card');
  const enabled = await page.locator('.screen-career .career-card:not([disabled])').count();
  const lockTxt = await page.locator('.screen-career [data-event="rookie-cup"] .lc-sum').innerText();
  const careerTxt = await page.locator('.screen-career').innerText();
  check('Career screen: 7 events in 3 tiers, only the first open, locked ones say why', (await visibleScreen()) === 'career' && (await cards.count()) === 7 && enabled === 1 && (await page.locator('.screen-career .tier-head').count()) === 3 && /Clear Harbor Sprint first/.test(lockTxt), `${await cards.count()} cards, ${enabled} open, "${lockTxt}"`);
  check('Career screen shows credits, rewards and star total; no debug text', /1,000 cr/.test(careerTxt) && /Reward 600 cr/.test(careerTxt) && /0 \/ 21 career ★/.test(careerTxt) && !/undefined|NaN|\bnull\b|debug|\bqa\b/i.test(careerTxt));
  await shot('career-01-screen');
  await tap('.screen-career [data-event="harbor-sprint"]');
  let s = await snap();
  const brief = await page.locator('.screen-briefing').innerText();
  check('event briefing: career tier, reward, limit, star times; the city previews the event layout', (await visibleScreen()) === 'briefing' && /Career · Rookie/i.test(brief) && /600 cr/.test(brief) && /0:46\.0/.test(brief) && s.state === 'briefing' && (await ci()).id === 'harbor-sprint', `${s.state}, id ${(await ci()).id}`);
  await tap('.screen-briefing [data-action="career"]');
  check('briefing Back returns to the Career screen', (await visibleScreen()) === 'career' && (await snap()).state === 'menu');
  // Keyboard: Escape steps back through the front-end screens (briefing → Career → title).
  await tap('.screen-career [data-event="harbor-sprint"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const escBrief = await visibleScreen();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Escape = Back: briefing → Career → title (state back to menu)', escBrief === 'career' && (await visibleScreen()) === 'title' && (await snap()).state === 'menu', `${escBrief} → ${await visibleScreen()}`);
  await tap('.screen-title [data-action="career"]');
  await tap('.screen-career [data-event="harbor-sprint"]');
  await tap('.screen-briefing [data-action="cstart"]');
  s = await snap();
  let info = await ci();
  check('Start event: on foot at the event, career run active, police off', s.state === 'onFoot' && info.id === 'harbor-sprint' && info.levelId === 'harbor-sprint' && !(await H(() => window.__cityRacer.policeInfo())).enabled, `${s.state} ${info.id}`);
  const start = info.gates.length ? s.mission.gates : 0;
  await teleChar(120, 5.25 - 2.3);
  await adv(0.1);
  await enterCar();
  await adv(0.5);
  let passed = 0;
  for (let k = 0; k < info.gates.length; k++) {
    const g = info.gates[k];
    await teleCar(g.i - 2, 1.75);
    const r = await hold(['KeyW'], 1.5);
    if (r.mission.nextGate === k + 1) passed++;
    if (r.mission.stage === 'done') break;
  }
  await adv(1.6);
  s = await snap();
  const resTxt = await page.locator('.screen-complete').innerText().catch(() => '');
  const cr = s.progress.career['harbor-sprint'];
  check('driving through every checkpoint completes the event', passed === info.gates.length && s.state === 'complete' && !!cr, `${passed}/${info.gates.length} gates (${start}), ${s.state}`);
  check('result: stars, credits paid and saved, next event unlocked', /Event 1 complete/i.test(resTxt) && /Credits earned/.test(resTxt) && /Unlocked: Rookie Cup/.test(resTxt) && s.progress.credits > 1000 && (await page.locator('.screen-complete [data-action="next"]').count()) === 1, `stars ${cr?.stars}, credits ${s.progress.credits}`);
  await shot('career-02-result');
  const creditsAfter = s.progress.credits;
  // Next event → its briefing (rivals with their cars), then back to the career list.
  await tap('.screen-complete [data-action="next"]');
  const brief2 = await page.locator('.screen-briefing').innerText();
  check('Next event opens the Rookie Cup briefing with rivals and their cars', (await visibleScreen()) === 'briefing' && /Rookie Cup/i.test(brief2) && /Dash \(Kestrel GT\)/.test(brief2) && (await ci()).id === 'rookie-cup', brief2.split('\n').find((l) => /Dash/.test(l)) ?? '');
  // Persistence: reload the page.
  await freshPage();
  s = await snap();
  check('career progress and credits survive a reload', s.progress.career['harbor-sprint']?.stars === cr.stars && s.progress.credits === creditsAfter, `credits ${s.progress.credits}`);

  // Race: top-2 rule. Sit still: once both rivals have finished, a top-2 place is impossible → fails at once with a clear reason.
  await freeze(true);
  await tap('.screen-title [data-action="career"]');
  await tap('.screen-career [data-event="rookie-cup"]');
  await tap('.screen-briefing [data-action="cstart"]');
  info = await ci();
  check('rivals drive their catalogue cars', info.pool.filter((u) => u.car === 'kestrel').length >= 2);
  await teleChar(452, 1.75 - 2.3);
  await adv(0.1);
  await enterCar();
  await adv(95);
  for (const g of info.gates) {
    await teleCar(g.i - 2, 1.75);
    if ((await hold(['KeyW'], 1.5)).mission.stage === 'done') break;
  }
  await adv(1.6);
  s = await snap();
  const failTxt = await page.locator('.screen-failed').innerText().catch(() => '');
  check('both rivals finishing first fails the Rookie Cup at once: "top 2 needed"', s.state === 'failed' && /2 rivals finished ahead — top 2 needed/.test(failTxt) && !s.progress.career['rookie-cup'], `${s.state} "${failTxt.split('\n').find((l) => /needed|counts/.test(l)) ?? ''}"`);
  // Pro Duel (Brute rival) via a seeded save, then free roam restores stock police cars.
  await toTitle();
  await H((p) => window.__cityRacer.setProgress({ ...p, career: { 'harbor-sprint': { time: 30, stars: 3 }, 'rookie-cup': { time: 80, stars: 1 }, 'foundry-attack': { time: 50, stars: 2 }, 'pro-duel': { time: 85, stars: 1 } } }), (await snap()).progress);
  await tap('.screen-title [data-action="career"]');
  const pro = await page.locator('.screen-career [data-event="pro-duel"]').isEnabled();
  const loop = await page.locator('.screen-career [data-event="grand-loop"] .lc-sum').innerText();
  await tap('.screen-career [data-event="pro-duel"]');
  await tap('.screen-briefing [data-action="cstart"]');
  info = await ci();
  check('Pro Duel open (replay); its rival races a Brute; Grand Loop asks for 8 stars', pro && info.id === 'pro-duel' && info.pool[0].car === 'brute' && info.pool[0].style !== 'coupe' && /Needs 8 career stars \(you have 7\)/.test(loop), `${JSON.stringify(info.pool[0])} "${loop}"`);
  // Leave the event through the real pause menu: Esc → Quit.
  await page.keyboard.press('Escape');
  await tap('.screen-pause [data-action="quit"]');
  const quitScreen = await visibleScreen();
  const quitInfo = await ci();
  check('pause → Quit from a career event: back on the title, career run cleared', quitScreen === 'title' && quitInfo.id === null && (await snap()).state === 'menu', `${quitScreen}, id ${quitInfo.id}`);
  await tap('.screen-title [data-action="free"]');
  await freeze(true);
  await adv(0.3);
  info = await ci();
  check('free roam: the pooled cars are stock patrol cars again', info.id === null && info.pool.every((u) => u.car === 'kestrel'), JSON.stringify(info.pool));

  // City markers: walk up to an event, see the prompt, press E → briefing. Locked marker explains.
  const n = await H(() => window.__cityRacer.navInfo());
  const ev = n.pois.find((p) => p.id === 'career-harbor-sprint');
  const lockedEv = n.pois.find((p) => p.id === 'career-elite-race');
  await teleChar(lockedEv.i, lockedEv.off);
  await adv(0.4);
  const lockPrompt = (await H(() => window.__cityRacer.navInfo())).prompt ?? '';
  await teleChar(ev.i, ev.off);
  await adv(0.4);
  const evPrompt = (await H(() => window.__cityRacer.navInfo())).prompt ?? '';
  await page.keyboard.press('KeyE');
  await adv(0.3);
  check('career markers in the city: locked one explains, open one starts the briefing with E', /Locked — /.test(lockPrompt) && /Enter Harbor Sprint/.test(evPrompt) && (await visibleScreen()) === 'briefing' && (await ci()).id === 'harbor-sprint', `"${lockPrompt}" / "${evPrompt}" → ${await visibleScreen()}`);
  await tap('.screen-briefing [data-action="career"]');
  // Phone: the career list fits the width and scrolls.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const fit = await H(() => {
    const p = document.querySelector('.screen-career .panel');
    const r = p.getBoundingClientRect();
    return { w: r.width, sw: p.scrollWidth, cw: p.clientWidth, sh: p.scrollHeight, ch: p.clientHeight, vw: innerWidth };
  });
  check('phone: Career list fits the screen width and scrolls vertically', fit.w <= fit.vw && fit.sw <= fit.cw + 1 && fit.sh >= fit.ch, JSON.stringify(fit));
  await page.setViewportSize({ width: 960, height: 540 });
  await freeze(false);

  // Touch: at a career marker the context button reads "Start"; tapping it opens the briefing.
  const mctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => consoleErrors.push(`pageerror (mobile): ${e.message}`));
  await page.close().catch(() => undefined);
  await mp.goto(URL, { timeout: 180000 });
  await mp.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await mp.evaluate(() => window.__cityRacer.qaFreeze(true));
  await mp.evaluate(() => window.__cityRacer.startLevel(-1));
  const mev = (await mp.evaluate(() => window.__cityRacer.navInfo())).pois.find((p) => p.id === 'career-harbor-sprint');
  await mp.evaluate(([i, off]) => window.__cityRacer.debugTeleportCharacter(i, off), [mev.i, mev.off]);
  await mp.evaluate(() => window.__cityRacer.qaAdvance(0.4));
  const label = await mp.evaluate(() => {
    const b = document.querySelector('.tc-interact');
    return b && !b.classList.contains('hidden') ? b.textContent.trim() : null;
  });
  await mp.tap('.tc-interact');
  await mp.waitForTimeout(300);
  const mScreen = await mp.evaluate(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null);
  await mp.tap('.screen-briefing [data-action="cstart"]');
  await mp.waitForTimeout(300);
  const ms = await mp.evaluate(() => window.__cityRacer.snapshot());
  const mci = await mp.evaluate(() => window.__cityRacer.careerInfo());
  check('phone: touch "Start" at a career marker opens the briefing; tapping Start event begins it', label === 'Start' && mScreen === 'briefing' && ms.state === 'onFoot' && mci.id === 'harbor-sprint' && ms.touch.visible, `label ${label}, screen ${mScreen}, state ${ms.state}, career ${mci.id}`);
  await mctx.close();
  page = await context.newPage();
}

// ====================================================================== two tabs, one save
// The game open twice (two tabs share one localStorage): a purchase in one tab must survive a later change in
// the other, which loaded before it (no stale whole-object overwrite), and the other tab's menus update.
if (want('tabs')) {
  await freshPage();
  await H(() => {
    localStorage.setItem('city-racer.progress.v2', JSON.stringify({ version: 2, credits: 10000, earned: 10000 }));
  });
  await page.reload({ timeout: 180000 });
  await page.waitForFunction(() => !!window.__cityRacer && !!document.querySelector('.screen-title button.primary:not([disabled])') && !!document.querySelector('.screen-title [data-action="garage"]:not([disabled])'), null, { timeout: 180000 });
  const tabB = await context.newPage();
  tabB.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consoleErrors.push(`${m.type()} (tab B): ${m.text()}`));
  tabB.on('pageerror', (e) => consoleErrors.push(`pageerror (tab B): ${e.message}`));
  await tabB.goto(URL, { timeout: 180000 });
  await tabB.waitForFunction(() => !!window.__cityRacer && !!document.querySelector('.screen-title button.primary:not([disabled])') && !!document.querySelector('.screen-title [data-action="garage"]:not([disabled])'), null, { timeout: 180000 });
  const memOf = (pg) => pg.evaluate(() => { const g = window.__cityRacer.garageInfo().progress; return { credits: g.credits, owned: g.owned.join(), car: g.car, engine: g.cars.kestrel.upgrades.engine }; });
  // Read both tabs before the first click. Without an evaluate on both pages first, Playwright's first click on
  // the second page never resolved its locator in this environment (the button was present and the page visible);
  // root cause not identified — harness quirk, failed 5/5 runs without this read, passed 4/4 with it.
  const a0 = await memOf(page);
  const b0 = await memOf(tabB);
  check('two tabs: both start from the same save', a0.credits === 10000 && JSON.stringify(a0) === JSON.stringify(b0), `A ${JSON.stringify(a0)} B ${JSON.stringify(b0)}`);
  // Tab B opens its garage first (stale view), then tab A buys the Pip.
  // Like a player switching tabs: the tab being used is brought to the front first.
  await tabB.bringToFront();
  await tabB.click('.screen-title [data-action="garage"]', { timeout: 90000 });
  await tabB.click('.screen:not(.hidden) [data-action="gview"][data-car="pip"]', { timeout: 90000 });
  const staleBuy = await tabB.$('.screen:not(.hidden) [data-action="gbuy"][data-car="pip"]');
  await page.bringToFront();
  await page.click('.screen-title [data-action="garage"]', { timeout: 90000 });
  await page.click('.screen:not(.hidden) [data-action="gview"][data-car="pip"]', { timeout: 90000 });
  await page.click('.screen:not(.hidden) [data-action="gbuy"][data-car="pip"]', { timeout: 90000 });
  await tabB.waitForFunction(() => window.__cityRacer.garageInfo().progress.owned.includes('pip'), null, { timeout: 30000 }).catch(() => null);
  const b1 = await memOf(tabB);
  const bUi = await tabB.evaluate(() => ({
    buy: !!document.querySelector('.screen:not(.hidden) [data-action="gbuy"][data-car="pip"]'),
    owned: /currently driving|drive this car/i.test(document.querySelector('.screen:not(.hidden)')?.textContent ?? ''),
  }));
  check('two tabs: the other tab adopts a purchase at once (credits, car, garage view)', !!staleBuy && b1.credits === 7000 && b1.owned === 'kestrel,pip' && b1.car === 'pip' && !bUi.buy && bUi.owned, `tab B ${JSON.stringify(b1)}; buy button ${bUi.buy}; owned view ${bUi.owned}`);
  // Tab B now spends credits: the change is applied to the latest save, and tab A follows.
  await tabB.bringToFront();
  await tabB.click('.screen:not(.hidden) [data-action="gview"][data-car="kestrel"]', { timeout: 90000 });
  await tabB.click('.screen:not(.hidden) [data-action="gupgrade"][data-car="kestrel"][data-upgrade="engine"]', { timeout: 90000 });
  await page.waitForFunction(() => window.__cityRacer.garageInfo().progress.cars.kestrel.upgrades.engine === 1, null, { timeout: 30000 }).catch(() => null);
  const stored = await H(() => { const g = JSON.parse(localStorage.getItem('city-racer.progress.v2')); return { credits: g.credits, owned: g.owned.join(), car: g.car, engine: g.cars.kestrel.upgrades.engine }; });
  const a2 = await memOf(page);
  check('two tabs: a later change in the other tab keeps the purchase (no lost update, no refund)', stored.owned === 'kestrel,pip' && stored.engine === 1 && stored.credits === 10000 - 3000 - 1500 && JSON.stringify(a2) === JSON.stringify(stored), `stored ${JSON.stringify(stored)}; tab A ${JSON.stringify(a2)}`);
  const dbl = await tabB.evaluate(() => window.__cityRacer.garageInfo().progress.credits);
  check('two tabs: both tabs agree on the save', dbl === stored.credits, `tab B ${dbl} vs stored ${stored.credits}`);

  // Settings: tab A lowers the volume, then tab B (opened before that) switches the sound off.
  const toSettings = async (pg) => {
    await pg.bringToFront();
    await pg.keyboard.press('Escape');
    await pg.waitForFunction(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen === 'title', null, { timeout: 90000 });
    await pg.click('.screen-title [data-action="settings"]', { timeout: 90000 });
    await pg.waitForFunction(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen === 'settings', null, { timeout: 90000 });
  };
  const setOf = (pg) => pg.evaluate(() => { const s = window.__cityRacer.snapshot().settings; return { volume: s.volume, muted: s.muted }; });
  await toSettings(page);
  await toSettings(tabB);
  await page.bringToFront();
  await page.locator('.screen:not(.hidden) input[data-setting="volume"]').fill('0.3');
  await tabB.waitForFunction(() => Math.abs(window.__cityRacer.snapshot().settings.volume - 0.3) < 1e-6, null, { timeout: 30000 }).catch(() => null);
  const bVol = await setOf(tabB);
  const bOut = await tabB.evaluate(() => document.querySelector('.screen:not(.hidden) output[data-out="volume"]')?.textContent ?? null);
  await tabB.bringToFront();
  await tabB.click('.screen:not(.hidden) [data-seg="muted"][data-value="true"]', { timeout: 90000 });
  await page.waitForFunction(() => window.__cityRacer.snapshot().settings.muted === true, null, { timeout: 30000 }).catch(() => null);
  const sStored = await H(() => { const s = JSON.parse(localStorage.getItem('city-racer.settings.v1')); return { volume: s.volume, muted: s.muted }; });
  const sA = await setOf(page);
  check('two tabs: settings changed in one tab follow in the other (volume shown there too)', Math.abs(bVol.volume - 0.3) < 1e-6 && bOut === '30%', `tab B volume ${bVol.volume}, slider label ${bOut}`);
  check('two tabs: a later setting in the other tab keeps the first change', Math.abs(sStored.volume - 0.3) < 1e-6 && sStored.muted === true && JSON.stringify(sA) === JSON.stringify(sStored), `stored ${JSON.stringify(sStored)}; tab A ${JSON.stringify(sA)}`);
  await tabB.close();
}

check('no console errors or warnings', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | ') || 'none');
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
console.log(`\n${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'CITY QA PASSED' : 'CITY QA FAILED');
process.exit(failures === 0 ? 0 : 1);
