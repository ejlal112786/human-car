// Stage 4 browser QA: in-car camera, camera motion, game controller (simulated Gamepad API), turbo / supercharger audio.
// Run against the QA build: npm run build:qa && npx vite preview --mode qa --outDir dist-qa --port 4174, then
//   node scripts/cockpit-qa.mjs [url]       (SHOTS=dir to save screenshots)
// The controller is a scripted stand-in for navigator.getGamepads() — no physical controller is involved.
import { chromium } from 'playwright';

const URL = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:4174/';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const want = (k) => ONLY.length === 0 || ONLY.includes(k);
const SHOTS = process.env.SHOTS ?? '';
let passes = 0;
let failures = 0;
function check(name, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}
const f3 = (x) => Number(x).toFixed(3);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// Scripted controller: standard mapping, 17 buttons, 4 axes, dual-rumble + trigger-rumble actuator that logs every effect.
await context.addInitScript(() => {
  const pad = {
    id: 'Simulated Xbox Wireless Controller (STANDARD GAMEPAD)',
    index: 0,
    connected: false,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: {
      effects: ['dual-rumble', 'trigger-rumble'],
      log: [],
      playEffect(type, p) {
        this.log.push({ type, ...p });
        return Promise.resolve('complete');
      },
      reset() {
        this.log.push({ type: 'reset' });
        return Promise.resolve('complete');
      },
    },
  };
  window.__simPad = pad;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [pad.connected ? pad : null, null, null, null] });
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const H = (f, a) => page.evaluate(f, a);
const adv = (s) => H((v) => window.__cityRacer.qaAdvance(v), s);
const freeze = (on) => H((v) => window.__cityRacer.qaFreeze(v), on);
const snap = () => H(() => window.__cityRacer.snapshot());
const ck = () => H(() => window.__cityRacer.cockpitInfo());
const padInfo = () => H(() => window.__cityRacer.padInfo());
const au = () => H(() => window.__cityRacer.audioInfo());
const ready = () => page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const shot = async (name) => {
  if (!SHOTS) return;
  await H(() => window.__cityRacer.qaFreeze(true));
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 });
  } catch (e) {
    console.log(`(screenshot ${name} skipped: ${String(e).split('\n')[0]})`);
  }
};
// Controller helpers (standard mapping indices).
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const btn = (i, v) => H(([k, x]) => {
  const b = window.__simPad.buttons[k];
  b.value = x;
  b.pressed = x > 0.5;
  b.touched = x > 0;
}, [i, v]);
const axes = (a) => H((v) => { window.__simPad.axes = v; }, a);
const padLog = () => H(() => window.__simPad.vibrationActuator.log.slice());
/** Wait for `n` animation frames (the game polls the controller once per frame; software GL is slow). */
const frames = (n = 3) => H((k) => new Promise((res) => {
  let i = 0;
  const f = () => (++i >= k ? res() : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n);
/** Press and release a controller button, each held for a few real frames so the game sees both edges. */
async function tap(i) {
  await btn(i, 1);
  await frames(3);
  await btn(i, 0);
  await frames(3);
}
/** Deterministic: step physics and render a frame every 3 steps (20 fps), sampling the cockpit every 0.1 s. */
async function stepSample(keys, secs) {
  for (const k of keys) await page.keyboard.down(k);
  const out = [];
  for (let t = 0; t < secs - 1e-6; t += 0.1) {
    await H(() => window.__cityRacer.qaAdvanceFrames(0.1, 3));
    out.push(await ck());
  }
  for (const k of keys) await page.keyboard.up(k);
  return out;
}
async function enterCarFreeRoam() {
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(0.5);
  await H(() => window.__cityRacer.debugTeleport(40, 1.75, 0));
  await H(() => window.__cityRacer.debugTeleportCharacter(40, 1.75 - 2.3));
  await adv(0.2);
  await page.keyboard.press('KeyE');
  await adv(1.5);
  return (await snap()).state;
}
async function setView(v) {
  for (let k = 0; k < 2 && (await ck()).view !== v; k++) {
    await page.keyboard.press('KeyV');
    await adv(0.05);
  }
}
/** Pause → Settings → click a segmented option → back to the game. */
async function settingViaMenu(key, value) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.screen-pause [data-action="settings"]', { state: 'visible', timeout: 60000 });
  await page.click('.screen-pause [data-action="settings"]');
  await page.click(`.screen-settings [data-seg="${key}"][data-value="${value}"]`, { timeout: 60000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.screen-pause', { state: 'visible', timeout: 60000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__cityRacer.snapshot().state === 'driving', null, { timeout: 60000 });
}
const progressAll = (car) => H((c) => window.__cityRacer.setProgress({ version: 2, unlocked: 5, owned: ['kestrel', 'pip', 'brute', 'vortex', 'atlas', 'ridgeback', 'meridian', 'apex'], car: c }), car);

// =========================================================================================== boot, settings screen
await page.goto(URL, { timeout: 180000 });
await ready();
await H(() => localStorage.clear());
await page.reload({ timeout: 180000 });
await ready();

let st;
let c;
if (want('ui')) {
await page.click('.screen-title [data-action="settings"]');
await page.waitForSelector('.screen-settings', { state: 'visible', timeout: 60000 });
const segs = await H(() => ['carView', 'cameraMotion', 'vibration'].map((k) => [...document.querySelectorAll(`.screen-settings [data-seg="${k}"]`)].map((b) => b.getAttribute('data-value'))));
check('Settings has Car camera, Camera motion and Vibration options', segs[0].join() === 'chase,cockpit' && segs[1].join() === 'full,reduced,off' && segs[2].join() === 'true,false', JSON.stringify(segs));
const status0 = await page.textContent('.screen-settings .controller-status');
check('with no controller the status line says so', /No controller detected/.test(status0 ?? ''), status0 ?? '');
const defActive = await H(() => ['carView', 'cameraMotion', 'vibration'].map((k) => document.querySelector(`.screen-settings [data-seg="${k}"].active`)?.getAttribute('data-value')));
check('defaults: chase camera, full motion, vibration on', defActive.join() === 'chase,full,true', defActive.join());
await page.keyboard.press('Escape');
await page.waitForSelector('.screen-title', { state: 'visible', timeout: 60000 });
const help = await H(() => document.body.innerHTML);
check('controls help lists V (camera) and a Controller section', /Chase camera \/ in-car view/.test(help) && /RT \/ LT/.test(help), '');

// =========================================================================================== in-car view: toggle, placement, HUD
st = await enterCarFreeRoam();
check('free roam: player is driving the Kestrel', st === 'driving', st);
await freeze(true);
c = await ck();
check('chase view by default: no interior, body not clipped, camera behind the car', c.view === 'chase' && !c.active && !c.interior && !c.clipping && c.cam.x < -3, `cam x ${f3(c.cam.x)}`);
await page.keyboard.press('KeyV');
await adv(0.05);
await H(() => window.__cityRacer.snapCamera());
c = await ck();
const toast = await H(() => document.body.innerText.includes('IN-CAR VIEW') || document.body.innerText.toLowerCase().includes('in-car view'));
check('V switches to the in-car view (interior shown, body top clipped, driver model hidden)', c.view === 'cockpit' && c.active && c.interior && c.clipping && !c.charVisible, JSON.stringify({ a: c.active, i: c.interior, cl: c.clipping, ch: c.charVisible }));
check('camera sits at the driver eye point, left seat, inside the clipped cabin', Math.hypot(c.cam.x - c.eye.x, c.cam.y - c.eye.y, c.cam.z - c.eye.z) < 0.02 && c.eye.z < -0.2 && c.clipsCabin, `cam ${f3(c.cam.x)},${f3(c.cam.y)},${f3(c.cam.z)} eye ${f3(c.eye.x)},${f3(c.eye.y)},${f3(c.eye.z)}`);
check('a toast names the new view', toast);
check('cabin audio filter follows the view', c.cabinAudio === true);
await shot('cockpit-kestrel');
await page.click('.hud [data-action="camera"]');
await adv(0.05);
await H(() => window.__cityRacer.snapCamera());
c = await ck();
check('HUD camera button switches back to the chase view and restores the body', c.view === 'chase' && !c.active && !c.interior && !c.clipping && c.charVisible === false && c.cam.x < -3 && !c.cabinAudio, `cam x ${f3(c.cam.x)}`);
await page.click('.hud [data-action="camera"]');
await adv(0.05);
c = await ck();
const savedView = await H(() => JSON.parse(localStorage.getItem('city-racer.settings.v1') ?? '{}').carView);
check('the choice is saved', c.view === 'cockpit' && savedView === 'cockpit', String(savedView));
// Out of the car the in-car view is not used; back in, it returns.
await page.keyboard.press('KeyE');
await adv(1.5);
c = await ck();
check('on foot: interior hidden, body whole, character visible', (await snap()).state === 'onFoot' && !c.active && !c.interior && !c.clipping && c.charVisible, (await snap()).state);
await page.keyboard.press('KeyE');
await adv(1.5);
c = await ck();
check('back in the car the in-car view returns', (await snap()).state === 'driving' && c.active && c.interior && c.clipping && !c.charVisible);
await freeze(false);
await page.reload({ timeout: 180000 });
await ready();
st = await enterCarFreeRoam();
c = await ck();
check('after a reload the in-car view is still selected and used', st === 'driving' && c.view === 'cockpit' && c.active && c.interior, `${st} ${c.view}`);
} else {
  await enterCarFreeRoam();
}

// =========================================================================================== cameras do not touch physics
const dmg = () => H(() => window.__cityRacer.damageInfo().level);
async function physicsRun(view) {
  await freeze(true);
  await setView(view);
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.5);
  const d0 = await dmg();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await adv(0.4);
  await page.keyboard.up('KeyA');
  await adv(2.0);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');
  await adv(0.8);
  await page.keyboard.up('KeyS');
  const s = await snap();
  return { x: s.position.x, z: s.position.z, v: s.forwardSpeed, h: s.heading, dmg: (await dmg()) - d0 };
}
if (want('physics')) {
  const pChase = await physicsRun('chase');
  const pChase2 = await physicsRun('chase');
  const pCock = await physicsRun('cockpit');
  const ctrl = Math.hypot(pChase.x - pChase2.x, pChase.z - pChase2.z);
  const dPos = Math.hypot(pChase.x - pCock.x, pChase.z - pCock.z);
  check('control: the same run twice in the chase view is repeatable (no contact, no new damage)', ctrl < 1e-3 && pChase.dmg === 0 && pChase2.dmg === 0, `Δpos ${ctrl.toExponential(2)} m, damage +${pChase.dmg}/+${pChase2.dmg}`);
  check('same inputs give the same drive in the in-car view (the camera is visual only)', dPos < 1e-3 && Math.abs(pChase.v - pCock.v) < 1e-3 && Math.abs(pChase.h - pCock.h) < 1e-4, `Δpos ${dPos.toExponential(2)} m, Δv ${(pChase.v - pCock.v).toExponential(2)} m/s, end ${(pCock.v * 3.6).toFixed(1)} km/h`);
}

// =========================================================================================== head motion (deterministic frames)
async function brakeTest() {
  await freeze(true);
  await setView('cockpit');
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.3);
  await page.keyboard.down('KeyW');
  await adv(2.6);
  await page.keyboard.up('KeyW');
  await stepSample([], 0.3); // settle the head at constant-ish speed
  return stepSample(['KeyS'], 1.2);
}
if (want('head')) {
  await freeze(true);
  await setView('cockpit');
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.5);
  let samples = await stepSample(['KeyW'], 1.0);
  const accFwd = Math.max(...samples.map((x) => x.accel.x));
  const headBack = Math.min(...samples.map((x) => x.offset.x));
  check('accelerating: chassis acceleration forward, head pressed back', accFwd > 2 && headBack < -0.008, `ax ${f3(accFwd)} m/s², head ${(headBack * 100).toFixed(1)} cm`);
  samples = await brakeTest();
  const accBrake = Math.min(...samples.map((x) => x.accel.x));
  const maxFwd = Math.max(...samples.map((x) => x.offset.x));
  const maxVib = Math.max(...samples.map((x) => x.level.vibration + x.level.road));
  check('braking: deceleration, head pitches forward', accBrake < -5 && maxFwd > 0.02, `ax ${f3(accBrake)} m/s², head +${(maxFwd * 100).toFixed(1)} cm`);
  check('engine / road vibration is applied while moving', maxVib > 0.0003, `level ${maxVib.toExponential(2)}`);
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.3);
  await page.keyboard.down('KeyW');
  await adv(2.0);
  samples = await stepSample(['KeyA'], 0.8);
  await page.keyboard.up('KeyW');
  const minAz = Math.min(...samples.map((x) => x.accel.z));
  const maxSide = Math.max(...samples.map((x) => x.offset.z));
  check('cornering left: lateral acceleration to the left, head swings right', minAz < -3 && maxSide > 0.01, `az ${f3(minAz)} m/s², head +${(maxSide * 100).toFixed(1)} cm`);
  await shot('cockpit-corner');
  await freeze(false);
  await settingViaMenu('cameraMotion', 'off');
  samples = await brakeTest();
  const offMax = Math.max(...samples.map((x) => Math.hypot(x.offset.x, x.offset.y, x.offset.z) + x.level.vibration + x.level.road));
  const offAcc = Math.min(...samples.map((x) => x.accel.x));
  check('Camera motion Off: no head lag, shake or vibration (the car itself still brakes as hard)', offMax === 0 && Math.abs(offAcc - accBrake) < 0.5, `max ${offMax}, ax ${f3(offAcc)}`);
  await freeze(false);
  await settingViaMenu('cameraMotion', 'reduced');
  samples = await brakeTest();
  const redFwd = Math.max(...samples.map((x) => x.offset.x));
  check('Camera motion Reduced: about half of Full', redFwd > maxFwd * 0.3 && redFwd < maxFwd * 0.6, `${(redFwd * 100).toFixed(1)} cm vs ${(maxFwd * 100).toFixed(1)} cm`);
  await freeze(false);
  await settingViaMenu('cameraMotion', 'full');
  await freeze(false);
}

// =========================================================================================== controller: menus
const connectPad = () => H(() => {
  window.__simPad.connected = true;
  window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__simPad }));
});
if (want('padmenu')) {
  await page.reload({ timeout: 180000 });
  await ready();
  await connectPad();
  await page.click('.screen-title [data-action="settings"]');
  await page.waitForSelector('.screen-settings', { state: 'visible', timeout: 60000 });
  const status1 = await page.textContent('.screen-settings .controller-status');
  check('Settings shows the connected controller', /Connected: Simulated Xbox/.test(status1 ?? ''), status1 ?? '');
  await tap(PAD.DOWN);
  const f1 = await H(() => ({ nav: document.body.classList.contains('pad-nav'), seg: document.activeElement?.getAttribute('data-seg'), val: document.activeElement?.getAttribute('data-value'), tag: document.activeElement?.tagName }));
  await tap(PAD.DOWN);
  const f2 = await H(() => ({ seg: document.activeElement?.getAttribute('data-seg'), val: document.activeElement?.getAttribute('data-value') }));
  const ring = await H(() => getComputedStyle(document.activeElement).outlineStyle);
  check('D-pad moves a visible focus ring between settings controls', f1.nav && f1.tag === 'BUTTON' && (f1.seg !== f2.seg || f1.val !== f2.val) && ring === 'solid', `${f1.seg}=${f1.val} → ${f2.seg}=${f2.val}, outline ${ring}`);
  await tap(PAD.RIGHT);
  const target = await H(() => ({ seg: document.activeElement?.getAttribute('data-seg'), val: document.activeElement?.getAttribute('data-value'), on: document.activeElement?.classList.contains('active') }));
  await tap(PAD.A);
  const after = await H((t) => document.querySelector(`.screen-settings [data-seg="${t.seg}"][data-value="${t.val}"]`)?.classList.contains('active'), target);
  check('A selects the focused option', !!target.seg && target.on === false && after === true, `${target.seg}=${target.val}`);
  await tap(PAD.B);
  check('B goes back (like Escape)', await page.locator('.screen-title').isVisible());
  const pi = await padInfo();
  check('controller registered as the device in use', pi.active && pi.diag.nav >= 3 && pi.diag.presses >= 2, JSON.stringify(pi.diag));
  await page.mouse.click(5, 5);
  check('mouse use hides the controller focus ring again', !(await H(() => document.body.classList.contains('pad-nav'))));
  await H(() => localStorage.removeItem('city-racer.settings.v1'));
}

// =========================================================================================== controller: driving, hints, rumble
if (want('pad')) {
  await page.reload({ timeout: 180000 });
  await ready();
  await connectPad();
  let st = await enterCarFreeRoam();
  await freeze(true);
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.3);
  await freeze(false);
  await btn(PAD.RT, 1);
  await frames(3);
  await freeze(true);
  await adv(2.5);
  let s = await snap();
  let pi = await padInfo();
  const hint = await page.textContent('.controls-hint');
  check('RT accelerates the car', st === 'driving' && s.forwardSpeed > 8, `${st}, ${s.speedKmh.toFixed(0)} km/h`);
  check('HUD switches to controller hints while the controller is in use', pi.hudPad && /RT gas/.test(hint ?? ''), hint ?? '');
  await axes([-1, 0, 0, 0]);
  await freeze(false);
  await frames(3);
  await freeze(true);
  await adv(0.3);
  s = await snap();
  check('left stick steers', s.steer < -0.3, `steer ${f3(s.steer)}`);
  await axes([0, 0, 0, 0]);
  await freeze(false);
  const v0 = (await ck()).view;
  await tap(PAD.RB);
  const v1 = (await ck()).view;
  check('RB switches the camera view', v0 !== v1, `${v0} → ${v1}`);
  await tap(PAD.RB);
  // Rumble while sliding: RT + full lock + handbrake, deterministic frames (rumble updates every 0.1 s of frame time).
  async function slide() {
    await freeze(true);
    await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
    await adv(0.3);
    await freeze(false);
    await btn(PAD.RT, 1);
    await frames(3);
    await freeze(true);
    await adv(2.2);
    await H(() => { window.__simPad.vibrationActuator.log.length = 0; });
    await freeze(false);
    await axes([1, 0, 0, 0]);
    await btn(PAD.A, 1);
    await frames(3);
    await freeze(true);
    await H(() => window.__cityRacer.qaAdvanceFrames(1.5, 3));
    await freeze(false);
    await axes([0, 0, 0, 0]);
    await btn(PAD.A, 0);
    await btn(PAD.RT, 0);
    await frames(3);
    return padLog();
  }
  let log = await slide();
  const dual = log.filter((e) => e.type === 'dual-rumble');
  const trig = log.filter((e) => e.type === 'trigger-rumble');
  check('sliding sends dual-rumble effects (weak motor = tyre slip)', dual.length >= 5 && Math.max(...dual.map((e) => e.weakMagnitude)) > 0.05, `${dual.length} effects, weak max ${f3(Math.max(0, ...dual.map((e) => e.weakMagnitude)))}, strong max ${f3(Math.max(0, ...dual.map((e) => e.strongMagnitude)))}, trigger-rumble ${trig.length}`);
  // Vibration off through the pause menu (Start opens it)
  await btn(PAD.START, 1);
  await frames(3);
  await btn(PAD.START, 0);
  await page.waitForSelector('.screen-pause', { state: 'visible', timeout: 60000 });
  await page.click('.screen-pause [data-action="settings"]');
  await page.click('.screen-settings [data-seg="vibration"][data-value="false"]');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__cityRacer.snapshot().state === 'driving', null, { timeout: 60000 });
  log = await slide();
  check('Vibration Off: no rumble effects at all', log.filter((e) => e.type !== 'reset').length === 0, `${log.length} entries (${[...new Set(log.map((e) => e.type))].join(',')})`);
  // Unplug with RT held: inputs must not stay stuck.
  await freeze(true);
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await adv(0.3);
  await freeze(false);
  await btn(PAD.RT, 1);
  await frames(3);
  await freeze(true);
  await adv(1.5);
  await H(() => {
    window.__simPad.connected = false;
    window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: window.__simPad }));
  });
  const sA = await snap();
  await adv(1.5);
  const sB = await snap();
  pi = await padInfo();
  check('unplugging the controller with RT held releases the throttle (car coasts down)', !pi.active && sA.forwardSpeed > 5 && sB.forwardSpeed < sA.forwardSpeed - 0.3, `${sA.speedKmh.toFixed(0)} → ${sB.speedKmh.toFixed(0)} km/h, active ${pi.active}`);
  await freeze(false);
  await frames(3);
  pi = await padInfo();
  check('hints return to the keyboard set after unplugging', !pi.hudPad && /W\/S accelerate/.test((await page.textContent('.controls-hint')) ?? ''));
  await btn(PAD.RT, 0);
}

// =========================================================================================== turbo / supercharger audio (real time)
if (want('audio')) {
async function audioRun(car) {
  await page.reload({ timeout: 180000 });
  await ready();
  await progressAll(car);
  await page.click('.screen-title [data-action="free"]', { timeout: 20000 }); // a real click starts Web Audio
  await adv(0.5);
  await H(() => window.__cityRacer.debugTeleport(60, 1.75, 0));
  await H(() => window.__cityRacer.debugTeleportCharacter(60, 1.75 - 2.3));
  await adv(0.2);
  await page.keyboard.press('KeyE');
  await adv(1.5);
  await freeze(true);
  const out = { state: (await au()).state, boost: 0, turbo: 0, whine: 0, blow: 0, upBlow: 0 };
  // Deterministic: frames every 3 steps carry the frame time into the audio engine (spool follows game time).
  await page.keyboard.down('KeyW');
  for (let k = 0; k < 16; k++) {
    await H(() => window.__cityRacer.qaAdvanceFrames(0.25, 3));
    const a = await au();
    out.boost = Math.max(out.boost, a.diag.boost);
    out.turbo = Math.max(out.turbo, a.diag.turbo);
    out.whine = Math.max(out.whine, a.diag.whine);
  }
  out.upBlow = (await au()).diag.blowoffs; // upshift blow-offs while accelerating
  await page.keyboard.up('KeyW');
  await H(() => window.__cityRacer.qaAdvanceFrames(0.8, 3));
  const a = await au();
  out.blow = a.diag.blowoffs;
  out.after = a.diag.boost;
  await freeze(false);
  return out;
}
const pip = await audioRun('pip');
check('Pip (turbo): boost builds under load and the whistle plays', pip.state === 'running' && pip.boost > 0.4 && pip.turbo > 0.002, `boost ${f3(pip.boost)}, whistle ${pip.turbo.toExponential(2)}`);
check('Pip: lifting off vents the turbo (blow-off) and boost collapses', pip.blow > pip.upBlow && pip.after < 0.1, `${pip.upBlow} on upshifts, ${pip.blow - pip.upBlow} on lift-off, boost after ${f3(pip.after)}`);
const kes = await audioRun('kestrel');
check('Kestrel (naturally aspirated): no boost, no whistle, no blow-off, no whine', kes.boost === 0 && kes.turbo === 0 && kes.blow === 0 && kes.whine === 0, JSON.stringify(kes));
const brute = await audioRun('brute');
check('Brute (supercharged): whine rises with revs, no turbo', brute.whine > 0.004 && brute.boost === 0 && brute.blow === 0, `whine ${f3(brute.whine)}`);
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
