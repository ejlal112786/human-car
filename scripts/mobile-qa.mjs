/**
 * Touch / mobile layout QA in headless Chromium with an emulated touch screen.
 * Multitouch is injected with CDP Input.dispatchTouchEvent (real touch events → pointer events).
 *
 *   node scripts/mobile-qa.mjs [URL]
 *
 * NOTE: this emulates touch input and screen sizes; it is not a substitute for testing on
 * real phones (performance, Safari quirks, notch insets and haptics are not covered).
 */
import { mkdirSync, readFileSync } from 'node:fs';
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const consoleErrors = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consoleErrors.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const snap = () => page.evaluate(() => window.__cityRacer.snapshot());
const adv = (s) => page.evaluate((x) => window.__cityRacer.qaAdvance(x), s);
/** Input is sampled once per fixed step: advance one step, then read the control state. */
const ctl = async () => {
  await adv(1 / 60);
  return snap();
};
// The real-time loop is frozen while capturing: under software GL a continuously rendering
// page starves the compositor and Playwright screenshots time out.
// After freezing, one frame is drawn synchronously (setCameraYaw with the current yaw re-renders) so a
// capture right after a viewport resize shows the scene rather than the cleared canvas.
const shot = async (name) => {
  await page.evaluate(() => {
    const h = window.__cityRacer;
    h.qaFreeze(true);
    h.setCameraYaw(h.snapshot().camYaw);
  });
  let ok = true;
  try {
    await page.screenshot({ path: `${SHOTS}${name}.png`, timeout: 90000 });
  } catch (e) {
    ok = false;
    console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`);
  }
  await page.evaluate(() => window.__cityRacer.qaFreeze(false));
  return ok;
};
/** Fraction of clearly green pixels in a box (fractions of the image) of a saved screenshot, decoded in the page. */
const greenFraction = (name, [x0, y0, x1, y1]) =>
  page.evaluate(
    async ([b64, box]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const x = Math.round(box[0] * c.width);
      const y = Math.round(box[1] * c.height);
      const d = ctx.getImageData(x, y, Math.round(box[2] * c.width) - x, Math.round(box[3] * c.height) - y).data;
      let g = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 25 && d[i + 1] > d[i + 2] + 25) g++;
      return g / (d.length / 4);
    },
    [readFileSync(`${SHOTS}${name}.png`).toString('base64'), [x0, y0, x1, y1]],
  );
// Active touch points (id → {x, y}); every dispatch sends the full set, like a real device.
const touches = new Map();
const points = () => [...touches.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }));
async function tStart(id, x, y) {
  touches.set(id, { x, y });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() });
}
async function tMove(id, x, y) {
  touches.set(id, { x, y });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points() });
}
// Chromium's CDP lifts exactly the points listed in a touchEnd (verified: the other fingers stay down).
async function tEnd(id) {
  const p = touches.get(id);
  if (!p) return;
  touches.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }] });
}
async function tCancel() {
  touches.clear();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
}
async function center(sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) {
    const d = await page.evaluate(() => {
      const x = window.__cityRacer.snapshot();
      return { state: x.state, prompt: x.prompt, speed: x.forwardSpeed, touch: x.touch, control: x.control };
    });
    throw new Error(`not visible: ${sel} ${JSON.stringify(d)}`);
  }
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function tap(sel, id = 50) {
  const c = await center(sel);
  await tStart(id, c.x, c.y);
  await page.waitForTimeout(60);
  await tEnd(id);
  await page.waitForTimeout(200);
}
const visibleScreen = () => page.evaluate(() => document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null);

/** Visible interactive / HUD boxes that must not overlap each other or leave the viewport. */
const layoutReport = () =>
  page.evaluate(() => {
    const sels = ['.tc-btn:not(.hidden)', '.cluster', '.minimap-wrap:not(.hidden)', '.mission:not(.hidden)', '.hud-top-left', '.tc-stick', '.detect:not(.hidden)'];
    const boxes = [];
    for (const sel of sels)
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || cs.display === 'none' || cs.visibility === 'hidden') return;
        let p = el;
        while (p) {
          if (getComputedStyle(p).display === 'none') return;
          p = p.parentElement;
        }
        boxes.push({ name: (el.dataset.tc || el.className).toString().split(' ')[0] + (el.dataset.tc ? '' : ''), r: { l: r.left, t: r.top, r: r.right, b: r.bottom } });
      });
    const W = innerWidth;
    const H = innerHeight;
    const outside = boxes.filter((b) => b.r.l < -1 || b.r.t < -1 || b.r.r > W + 1 || b.r.b > H + 1).map((b) => b.name);
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const c = boxes[j].r;
        const ix = Math.min(a.r, c.r) - Math.max(a.l, c.l);
        const iy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
        if (ix > 2 && iy > 2) overlaps.push(`${boxes[i].name}×${boxes[j].name}`);
      }
    const small = boxes.filter((b) => b.name.startsWith('tc') || /^(left|right|gas|brake|handbrake|run|jump|interact)$/.test(b.name)).filter((b) => b.r.r - b.r.l < 44 || b.r.b - b.r.t < 44).map((b) => b.name);
    return { count: boxes.length, outside, overlaps, small, scroll: [document.documentElement.scrollWidth > W + 1, document.documentElement.scrollHeight > H + 1, scrollX, scrollY] };
  });

async function layoutChecks(label) {
  const r = await layoutReport();
  check(`${label}: no control outside the screen`, r.outside.length === 0, r.outside.join(', ') || `${r.count} boxes`);
  check(`${label}: controls and HUD do not overlap`, r.overlaps.length === 0, r.overlaps.join(', ') || 'none');
  check(`${label}: touch targets ≥ 44 px`, r.small.length === 0, r.small.join(', ') || 'ok');
  check(`${label}: page cannot scroll`, !r.scroll[0] && !r.scroll[1] && r.scroll[2] === 0 && r.scroll[3] === 0, JSON.stringify(r.scroll));
}

// ------------------------------------------------------------------ boot (portrait phone)
await page.goto(URL);
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
{
  const r = await page.evaluate(() => [...document.querySelectorAll('.screen-title button')].map((b) => b.getBoundingClientRect()).map((x) => [x.left, x.right, x.height]));
  check('portrait title: all menu buttons fit the screen and are tall enough', r.every(([l, rr, h]) => l >= 0 && rr <= 390 && h >= 40), JSON.stringify(r.map((x) => x.map(Math.round))));
  await shot('qa-m01-title-portrait');
}
await tap('.screen-title [data-action="play"]');
check('tap Play opens the briefing', (await visibleScreen()) === 'briefing');
await shot('qa-m02-briefing-portrait');
await tap('.screen-briefing [data-action="start"]');
await adv(0.5);
let s = await snap();
check('touch controls visible on foot with the joystick layout', s.state === 'onFoot' && s.touch.visible && s.touch.layout === 'foot', `${s.state} ${s.touch.layout} ${s.touch.visible}`);
check('keyboard hint hidden on touch devices', await page.evaluate(() => document.querySelector('.controls-hint').classList.contains('hidden')));
await shot('qa-m03-onfoot-portrait');
await layoutChecks('portrait on foot');

// ------------------------------------------------------------------ joystick + multitouch
{
  const zone = await page.locator('.tc-stick-zone').boundingBox();
  const sx = zone.x + zone.width * 0.4;
  const sy = zone.y + zone.height * 0.7;
  await tStart(1, sx, sy);
  await tMove(1, sx, sy - 80);
  s = await snap();
  check('joystick drag up → forward input', s.touch.joyY > 0.8 && Math.abs(s.touch.joyX) < 0.1, `joy ${f2(s.touch.joyX)}, ${f2(s.touch.joyY)}`);
  await tMove(1, sx + 80, sy - 80);
  s = await snap();
  const mag = Math.hypot(s.touch.joyX, s.touch.joyY);
  check('diagonal joystick magnitude capped at 1', mag <= 1.0001 && mag > 0.9, f2(mag));
  await tMove(1, sx, sy - 80);
  // Second finger: run toggle while the stick is held
  const run = await center('.tc-run');
  await tStart(2, run.x, run.y);
  await tEnd(2);
  s = await snap();
  check('run button works while the joystick is held (multitouch)', s.touch.run && s.touch.joyY > 0.8);
  const c0 = s.character;
  await adv(1.0);
  s = await snap();
  check('character runs from touch input', s.character.speed > 4.5, f2(s.character.speed));
  // Third finger on the right half orbits the camera without disturbing the stick
  const yaw0 = s.camYaw;
  await tStart(3, 300, 300);
  await tMove(3, 360, 300);
  await tMove(3, 380, 300);
  await adv(0.05);
  await page.waitForTimeout(300);
  s = await snap();
  check('camera look drag with another finger while moving', Math.abs(s.camYaw - yaw0) > 0.05 && s.touch.joyY > 0.8, `yaw Δ ${f2(s.camYaw - yaw0)}`);
  await tEnd(3);
  await tEnd(1);
  s = await snap();
  check('lifting the finger returns the joystick to neutral', s.touch.joyX === 0 && s.touch.joyY === 0);
  await adv(0.6);
  s = await snap();
  check('character stops after release', s.character.speed < 0.2, f2(s.character.speed));
  await tStart(4, sx, sy);
  await tMove(4, sx + 50, sy);
  const joyBefore = (await snap()).touch;
  await tCancel();
  // Touch input reaches the page asynchronously (rAF-aligned at a few FPS under software GL), so wait
  // for the release instead of sampling immediately; a cancel that never releases still fails.
  await page
    .waitForFunction(() => { const t = window.__cityRacer.snapshot().touch; return t.joyX === 0 && t.joyY === 0; }, null, { timeout: 5000 })
    .catch(() => {});
  s = await snap();
  check('touchcancel releases the joystick', s.touch.joyX === 0 && s.touch.joyY === 0, `before ${f2(joyBefore.joyX)},${f2(joyBefore.joyY)} → after ${f2(s.touch.joyX)},${f2(s.touch.joyY)}`);
  void c0;
}

// ------------------------------------------------------------------ interact button → drive layout
{
  await page.evaluate(() => window.__cityRacer.debugTeleportCharacter(22, 2.95));
  await adv(0.2);
  await page.waitForTimeout(300);
  const label = await page.locator('.tc-interact').innerText();
  check('touch interact button appears next to the car', (await page.locator('.tc-interact').isVisible()) && /Enter/i.test(label), label);
  await tap('.tc-interact');
  await adv(1.4);
  s = await snap();
  check('tapping Enter gets in → driving layout', s.state === 'driving' && s.touch.layout === 'drive', `${s.state} ${s.touch.layout}`);
  await shot('qa-m04-driving-portrait');
  await layoutChecks('portrait driving');
  const gas = await center('.tc-gas');
  const right = await center('[data-tc="right"]');
  await tStart(1, gas.x, gas.y);
  await tStart(2, right.x, right.y);
  s = await ctl();
  check('gas + steer held simultaneously', s.control.throttle === 1 && s.control.steer === 1, `throttle ${s.control.throttle}, steer ${s.control.steer}`);
  await adv(1.5);
  s = await snap();
  check('car accelerates from touch pedals', s.speedKmh > 10, `${f2(s.speedKmh)} km/h`);
  await tEnd(2);
  s = await ctl();
  check('releasing the steer finger releases only steering', s.control.steer === 0 && s.control.throttle === 1);
  await tEnd(1);
  s = await ctl();
  check('releasing the gas finger releases throttle', s.control.throttle === 0);
  const brake = await center('.tc-brake');
  const hb = await center('.tc-hb');
  await tStart(5, brake.x, brake.y);
  await tStart(6, hb.x, hb.y);
  s = await ctl();
  check('brake + handbrake held together', s.control.brake === 1 && s.control.handbrake);
  await tCancel();
  s = await ctl();
  check('touchcancel releases every pedal', s.control.brake === 0 && !s.control.handbrake && s.control.throttle === 0);
  // Exit via the touch button once stopped
  await tStart(7, brake.x, brake.y);
  for (let k = 0; k < 12 && Math.abs((await snap()).forwardSpeed) > 0.5; k++) await adv(0.25);
  await tEnd(7);
  await adv(0.4);
  await page.waitForTimeout(200);
  const lab2 = await page.locator('.tc-interact').innerText();
  check('Exit button shown when slow', /Exit/i.test(lab2), lab2);
  // Hold the handbrake while exiting (it keeps the car still): the layout switch must not leave it stuck
  const hb2 = await center('.tc-hb');
  await tStart(8, hb2.x, hb2.y);
  await tap('.tc-interact', 9);
  await adv(0.8);
  s = await snap();
  check('exit via touch returns to the joystick layout', s.state === 'onFoot' && s.touch.layout === 'foot');
  check('input held across the layout switch is released', s.touch.holds.handbrake === 0 && !s.control.handbrake, JSON.stringify(s.touch.holds));
  await tCancel();
  // Pause button
  await tap('.hud [data-action="pause"]');
  s = await snap();
  check('HUD pause button pauses', s.state === 'paused' && !s.touch.visible);
  await tap('.screen-pause [data-action="resume"]');
  s = await snap();
  check('Resume restores the touch layout', s.state === 'onFoot' && s.touch.visible && s.touch.layout === 'foot');
}

// ------------------------------------------------------------------ landscape phone
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(500);
await adv(0.1);
await shot('qa-m05-onfoot-landscape');
await layoutChecks('landscape on foot');
check('in a mission the weapon buttons are hidden (crouch stays)', await page.evaluate(() => {
  const vis = (sel) => { const el = document.querySelector(sel); return !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none'; };
  return !vis('.tc-gun') && !vis('.tc-fire') && vis('.tc-crouch');
}));
// The car was driven away in the portrait tests: park it back at its start, then walk up to it.
await page.evaluate(() => window.__cityRacer.debugTeleport(22, 5.25));
await adv(0.5);
await page.evaluate(() => window.__cityRacer.debugTeleportCharacter(22, 2.95));
await adv(0.2);
await tap('.tc-interact');
await adv(1.4);
await page.waitForTimeout(300);
{
  const ok = await shot('qa-m06-driving-landscape');
  // The asphalt between the left controls and the car must render as road, not the grass ground plane
  // (regression: depth fighting between the road and a single giant ground quad at small viewports).
  const g = ok ? await greenFraction('qa-m06-driving-landscape', [0.25, 0.55, 0.42, 0.95]) : 1;
  check('landscape driving view: road renders as asphalt (no ground showing through)', ok && g < 0.02, ok ? `${(g * 100).toFixed(1)}% green` : 'screenshot failed');
}
await layoutChecks('landscape driving');
await tap('.hud [data-action="pause"]');
await shot('qa-m07-pause-landscape');
{
  const r = await page.evaluate(() => {
    const p = document.querySelector('.screen-pause .panel').getBoundingClientRect();
    return [p.top, p.bottom, innerHeight];
  });
  check('pause panel fits the landscape screen', r[0] >= 0 && r[1] <= r[2] + 1, JSON.stringify(r.map(Math.round)));
}
await tap('.screen-pause [data-action="resume"]');

// ------------------------------------------------------------------ tablet
await page.setViewportSize({ width: 1024, height: 768 });
await page.waitForTimeout(500);
await adv(0.1);
await shot('qa-m08-driving-tablet');
await layoutChecks('tablet driving');
await page.setViewportSize({ width: 768, height: 1024 });
await page.waitForTimeout(500);
await adv(0.1);
await layoutChecks('tablet portrait driving');

// ------------------------------------------------------------------ free roam with the pistol out (crime update)
await page.evaluate(() => window.__cityRacer.startLevel(-1));
await adv(2);
{
  // Stand next to the own car so the interact button is showing too.
  const own = await page.evaluate(() => window.__cityRacer.crimeInfo().own);
  for (const [dx, dz] of [[2.1, 0], [-2.1, 0], [0, 2.1], [0, -2.1]]) {
    await page.evaluate(([x, z]) => window.__cityRacer.qaPlaceCharacter(x, z, 0), [own.x + dx, own.z + dz]);
    await adv(0.2);
    if (await page.evaluate(() => window.__cityRacer.crimeInfo().hud.prompt)) break;
  }
  for (const [w, h, label] of [[390, 844, 'portrait'], [844, 390, 'landscape']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await adv(0.1);
    if ((await page.evaluate(() => window.__cityRacer.crimeInfo().weapon.state)) === 'holstered') {
      await tap('.tc-gun');
      await adv(0.8);
    }
    const c = await page.evaluate(() => window.__cityRacer.crimeInfo());
    check(`${label} free roam: the Gun button draws the pistol (Aim / Fire / Reload appear)`, c.weapon.drawn && (await page.evaluate(() => !!document.querySelector('.touch-controls.armed'))));
    await shot(`qa-m09-armed-${label}`);
    await layoutChecks(`${label} armed (interact showing: ${c.hud.prompt})`);
  }
  await tap('.tc-aim');
  await adv(0.3);
  const a = await page.evaluate(() => window.__cityRacer.crimeInfo());
  check('Aim toggles aiming', a.weapon.aiming);
  const shots0 = a.shots;
  const f = await center('.tc-fire');
  await tStart(51, f.x, f.y);
  await adv(0.6);
  await tEnd(51);
  await adv(0.2);
  const b = await page.evaluate(() => window.__cityRacer.crimeInfo());
  check('holding Fire shoots (semi-automatic)', b.shots - shots0 >= 2, `${b.shots - shots0} shots`);
  await tap('.tc-aim');
  await tap('.tc-gun');
  await adv(0.8);
  check('Gun again holsters (Aim / Fire hidden)', (await page.evaluate(() => window.__cityRacer.crimeInfo().weapon.state)) === 'holstered' && !(await page.evaluate(() => !!document.querySelector('.touch-controls.armed'))));
}

// ------------------------------------------------------------------ arrest + jail on touch (crime update)
{
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__cityRacer.startLevel(-1));
  await adv(2);
  const pi = await page.evaluate(() => window.__cityRacer.policeInfo());
  await page.evaluate(([i]) => window.__cityRacer.policePlace(0, i + 3, 1, 5.25), [pi.playerIdx]);
  await adv(0.3);
  await page.evaluate(() => window.__cityRacer.policeOffence('hitPolice'));
  let ph = 'idle';
  for (let k = 0; k < 160 && ph !== 'transfer'; k++) {
    await adv(0.25);
    ph = (await page.evaluate(() => window.__cityRacer.arrestInfo())).phase;
  }
  check('touch: busted on foot → arrest runs to the transfer card', ph === 'transfer', ph);
  await adv(0.6);
  check('touch controls hidden under the arrest card', await page.evaluate(() => document.querySelector('.touch-controls').classList.contains('hidden')));
  await shot('qa-m10-arrest-card');
  await tap('.arrest-card button');
  await adv(0.6);
  const j = await page.evaluate(() => window.__cityRacer.jailInfo());
  check('tapping Continue on the card → jail', !!j && j.jailed && j.zone === 'cell', j && j.zone);
  for (const [w, h, label] of [[844, 390, 'landscape'], [390, 844, 'portrait']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__cityRacer.qaJailGuardsAway());
    await page.evaluate(([o]) => window.__cityRacer.qaPlaceCharacter(o.x - 43.0, o.z - 16, -Math.PI / 2), [j.origin]);
    await adv(0.4);
    const ui = await page.evaluate(() => ({
      interact: document.querySelector('.tc-interact')?.textContent?.trim() ?? '',
      interactShown: !!document.querySelector('.tc-interact') && getComputedStyle(document.querySelector('.tc-interact')).display !== 'none' && !document.querySelector('.tc-interact').classList.contains('hidden'),
      noWeapon: document.querySelector('.touch-controls').classList.contains('no-weapon'),
      crouch: getComputedStyle(document.querySelector('.tc-crouch')).display !== 'none',
      detect: !!document.querySelector('.detect:not(.hidden)'),
      map: document.querySelector('.minimap-wrap').classList.contains('hidden'),
    }));
    check(`${label} jail: context button reads Vent, Crouch shown, weapon buttons hidden, detection meter on, map off`, ui.interactShown && /vent/i.test(ui.interact) && ui.crouch && ui.noWeapon && ui.detect && ui.map, JSON.stringify(ui));
    await shot(`qa-m11-jail-${label}`);
    await layoutChecks(`${label} jail`);
  }
  await tap('.tc-crouch');
  await adv(0.2);
  check('Crouch button crouches in jail', await page.evaluate(() => window.__cityRacer.crimeInfo().crouched));
  await tap('.tc-crouch');
  await adv(0.2);
  await tap('.tc-interact');
  await adv(4);
  check('tapping Vent + holding still unscrews the vent', (await page.evaluate(() => window.__cityRacer.jailInfo())).doors.vent);
  // Leave the save clean for the next run (sentence + impound off).
  await page.evaluate(() => {
    const g = window.__cityRacer;
    g.setProgress({ ...JSON.parse(JSON.stringify(g.garageInfo().progress)), jail: null, impound: {} });
    g.startLevel(-1);
  });
  await adv(1);
  check('sentence cleared → free roam on the street again', !(await page.evaluate(() => window.__cityRacer.jailInfo()?.jailed)));
}

// ------------------------------------------------------------------ gestures
{
  await page.evaluate(() => window.scrollTo(0, 500));
  const sc = await page.evaluate(() => [scrollX, scrollY]);
  check('page does not scroll programmatically or by gesture', sc[0] === 0 && sc[1] === 0, JSON.stringify(sc));
  const ta = await page.evaluate(() => [getComputedStyle(document.body).touchAction, getComputedStyle(document.querySelector('.game-canvas')).touchAction]);
  check('touch-action: none on body and canvas (no pinch / pan gestures)', ta.every((t) => t === 'none'), ta.join(', '));
  const vp = await page.evaluate(() => document.querySelector('meta[name=viewport]').content);
  check('viewport: no user scaling, viewport-fit=cover (safe areas)', /user-scalable=no/.test(vp) && /viewport-fit=cover/.test(vp), vp);
}

const relevant = consoleErrors.filter((e) => !/GPU stall due to ReadPixels|Automatic fallback to software WebGL/i.test(e));
check('no console errors or warnings', relevant.length === 0, relevant.slice(0, 6).join(' | ') || 'none');
await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'MOBILE QA PASSED' : 'MOBILE QA FAILED');
process.exit(failures === 0 ? 0 : 1);
