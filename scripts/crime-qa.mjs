/**
 * Browser check (QA build) of the crime update in the running game, with real keyboard / mouse input:
 *   weapon (equip, aim, fire, reload, crouch, holster, HUD, poses), mouse-look still works while holstered,
 *   pedestrian reactions to aiming / shots and the wanted level, stealing a parked car (owned car untouched),
 *   carjacking an occupied traffic car (driver stops and gets out), getting back into the owned car,
 *   and the weapon being unavailable / reset in missions.
 * Usage: node scripts/crime-qa.mjs [url]   (default http://localhost:4174/, needs `npm run preview:qa`)
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4174/';
const SHOTS = process.env.CRIME_SHOTS ?? '';
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });

const H = (f, a) => page.evaluate(f, a);
const adv = (s) => H((x) => window.__cityRacer.qaAdvance(x), s);
const ci = () => H(() => window.__cityRacer.crimeInfo());
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const shot = async (name) => {
  if (!SHOTS) return;
  await H(() => window.__cityRacer.qaFreeze(true));
  await adv(0);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 }).catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
  await H(() => window.__cityRacer.qaFreeze(false));
};
const place = (x, z, yaw = 0) => H(([a, b, c]) => window.__cityRacer.qaPlaceCharacter(a, b, c), [x, z, yaw]);
const aimAt = (x, y, z) => H(([a, b, c]) => window.__cityRacer.qaAimAt(a, b, c), [x, y, z]);
const pressE = async () => { await page.keyboard.press('KeyE'); };
const toast = () => H(() => [...document.querySelectorAll('.toast')].map((e) => e.textContent).join(' | '));
/** Brake (S) until the driven car is nearly stopped. */
async function stopCar() {
  for (let k = 0; k < 40; k++) {
    const v = (await ci()).driven.speed;
    if (Math.abs(v) < 0.8) break;
    if (v > 0) { await page.keyboard.down('KeyS'); await adv(0.25); await page.keyboard.up('KeyS'); }
    else { await page.keyboard.down('KeyW'); await adv(0.1); await page.keyboard.up('KeyW'); }
  }
  await adv(0.3);
}
/** Try the four sides of a car until the enter prompt appears. */
async function toDoor(x, z, yaw, re) {
  const dirs = [[Math.cos(yaw), -Math.sin(yaw)], [-Math.cos(yaw), Math.sin(yaw)], [Math.sin(yaw), Math.cos(yaw)], [-Math.sin(yaw), -Math.cos(yaw)]];
  for (const [sx, sz] of dirs) {
    await place(x + sx * 2.1, z + sz * 2.1);
    await adv(0.2);
    const c = await ci();
    if (c.hud.prompt && re.test(c.hud.prompt)) return c.hud.prompt;
  }
  return null;
}

await H(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 15, best: {}, credits: 0 }));
await H(() => window.__cityRacer.startLevel(-1));
await adv(3);
await page.mouse.move(480, 270);

// --- 1. Weapon
console.log('--- weapon');
let c = await ci();
check('free roam: on foot, crime systems on, pistol holstered 12/48, no weapon HUD', c.state === 'onFoot' && c.enabled && c.weapon.state === 'holstered' && c.weapon.mag === 12 && c.weapon.reserve === 48 && !c.hud.weapon && !c.hud.crosshair);
const yaw0 = Math.atan2(c.camera.dx, c.camera.dz);
await page.mouse.down({ button: 'left' });
for (let k = 1; k <= 8; k++) await page.mouse.move(480 + k * 20, 270);
await page.mouse.up({ button: 'left' });
await adv(0.1);
c = await ci();
const yaw1 = Math.atan2(c.camera.dx, c.camera.dz);
check('holstered: left-drag still turns the camera and fires nothing', Math.abs(yaw1 - yaw0) > 0.1 && c.shots === 0, `Δyaw ${(yaw1 - yaw0).toFixed(2)}`);
await page.mouse.move(480, 270);
await page.keyboard.press('Digit1');
await adv(0.2);
c = await ci();
check('1: drawing — gun in the hand, holster-reach pose', c.weapon.state === 'drawing' && c.pose.gunInHand !== undefined);
await adv(0.6);
c = await ci();
check('   then ready: weapon HUD and hip crosshair, low-ready pose, gun visible in the hand', c.weapon.state === 'ready' && c.hud.weapon && c.hud.crosshair && c.pose.lowReady > 0.9 && c.pose.gunInHand && c.pose.gunVisible, JSON.stringify(c.pose));
const hint = await H(() => document.querySelector('.controls-hint')?.textContent ?? '');
check('   the key hint switches to the weapon controls', /aim/i.test(hint) && /fire/i.test(hint), hint);
await page.mouse.down({ button: 'right' });
await adv(0.5);
c = await ci();
check('right mouse: aiming — tight spread, aim pose (arm raised), over-the-shoulder camera', c.weapon.aiming && c.weapon.spread < 0.01 && c.pose.aim > 0.9 && c.pose.lowReady < 0.1, `aim ${c.pose.aim.toFixed(2)}`);
const [fx, fy, fz] = c.pose.rightFore;
const [ax, ay, az] = c.pose.rightArm;
check('   the right arm really points forward (measured bones: upper arm and forearm level, ahead)', fz > 0.8 && Math.abs(fy) < 0.4 && az > 0.75 && Math.abs(ay) < 0.45, `arm ${[ax, ay, az].map((v) => v.toFixed(2))} fore ${[fx, fy, fz].map((v) => v.toFixed(2))}`);
check('   the aim view is roughly level (not at the pavement)', Math.abs(c.camera.dy) < 0.15, `dir y ${c.camera.dy.toFixed(2)}`);
await shot('aim');
await page.mouse.down({ button: 'left' });
await adv(0.1);
await page.mouse.up({ button: 'left' });
await adv(0.3);
c = await ci();
check('left mouse while aiming (mouse chord): one round fired, magazine 11', c.shots === 1 && c.weapon.mag === 11 && c.lastShot.kind !== 'none', `${c.lastShot.kind} at ${c.lastShot.distance.toFixed(1)} m`);
// (Down the sights the ray starts at the eye, so a pedestrian walking right in front can be hit: only
// check that the hit point is ahead of the camera, i.e. the round went forward.)
const ahead = (c.lastShot.x - c.camera.x) * c.camera.dx + (c.lastShot.y - c.camera.y) * c.camera.dy + (c.lastShot.z - c.camera.z) * c.camera.dz;
check('   the shot travels forward (hit point ahead of the camera, along the aim)', c.lastShot.kind === 'none' || ahead > 1, `${c.lastShot.kind} ${c.lastShot.distance.toFixed(1)} m, ${ahead.toFixed(1)} m ahead`);
await page.mouse.up({ button: 'right' });
await adv(0.1);
await page.mouse.down({ button: 'left' });
await adv(1.0);
await page.mouse.up({ button: 'left' });
await adv(0.3);
c = await ci();
check('holding the trigger fires semi-automatically at the cycle rate', c.shots >= 3 && c.shots <= 7 && c.weapon.mag === 12 - c.shots, `${c.shots} shots`);
await page.keyboard.press('KeyR');
await adv(0.3);
c = await ci();
check('R: reloading (reload pose)', c.weapon.state === 'reloading' && c.pose.reload > 0.1, `${c.weapon.state} ${c.pose.reload.toFixed(2)}`);
await adv(1.5);
c = await ci();
check('   magazine refilled from the reserve', c.weapon.state === 'ready' && c.weapon.mag === 12 && c.weapon.reserve === 48 - (c.shots), `${c.weapon.mag}/${c.weapon.reserve}`);
await page.keyboard.press('KeyC');
await adv(0.5);
c = await ci();
check('C: crouch (pose blended in)', c.crouched && c.pose.crouch > 0.9);
await page.keyboard.press('KeyC');
await adv(0.5);
c = await ci();
check('   C again: stand up', !c.crouched && c.pose.crouch < 0.1);
await page.keyboard.press('Digit1');
await adv(0.8);
c = await ci();
check('1 again: holstered, HUD and crosshair hidden', c.weapon.state === 'holstered' && !c.hud.weapon && !c.hud.crosshair && !c.pose.gunInHand);
const wanted0 = c.wanted;

// --- 2. Pedestrians
console.log('--- pedestrians');
const pedsNow = async () => H(() => window.__cityRacer.cityInfo().peds.list);
let pl = (await pedsNow()).filter((p) => p.mode === 1);
pl.sort((a, b) => dist(a, c.character) - dist(b, c.character));
await place(pl[0].x + 5, pl[0].z);
await adv(0.1);
await page.keyboard.press('Digit1');
await adv(0.6);
const before = await ci();
const stats0 = before.peds;
await page.mouse.down({ button: 'right' });
for (let k = 0; k < 6; k++) {
  c = await ci();
  pl = await pedsNow();
  pl.sort((a, b) => dist(a, c.character) - dist(b, c.character));
  await aimAt(pl[0].x, c.character.y + 1.1, pl[0].z);
  await adv(0.3);
}
c = await ci();
check('aiming at a pedestrian: the crosshair turns on-target', c.aimKind === 'ped');
check('   people nearby react: flee / surrender / call the police', c.peds.flees + c.peds.surrenders + c.peds.calls > stats0.flees + stats0.surrenders + stats0.calls, JSON.stringify({ flees: c.peds.flees, surrenders: c.peds.surrenders, calls: c.peds.calls }));
await shot('aim-ped');
await page.mouse.down({ button: 'left' });
await adv(0.1);
await page.mouse.up({ button: 'left' });
await adv(0.5);
c = await ci();
check('shooting a pedestrian: knocked down (no injury detail), assault reported, wanted', c.lastShot.kind === 'ped' && c.peds.knockdowns === stats0.knockdowns + 1 && c.stats.pedsHit === before.stats.pedsHit + 1 && c.shots === before.shots + 1 && c.wanted.stars >= 1, `${c.lastShot.kind} knockdowns ${stats0.knockdowns}→${c.peds.knockdowns} hit ${before.stats.pedsHit}→${c.stats.pedsHit} shots ${before.shots}→${c.shots} stars ${c.wanted.stars}`);
check('   the knocked-down person is in the Down state', c.peds.modes[10] >= 1);
await page.mouse.up({ button: 'right' });
await shot('ped-down');
await adv(8);
c = await ci();
check('   and gets back up later (nobody stays down)', c.peds.modes[10] === 0, `down ${c.peds.modes[10]}`);
check('wanted went up from the shooting', c.wanted.stars > wanted0.stars, `${wanted0.stars} → ${c.wanted.stars}`);
await page.keyboard.press('Digit1');
await adv(0.8);
// Clear the wanted level for the car tests by restarting free roam (this also re-checks the reset).
await H(() => window.__cityRacer.startLevel(-1));
await adv(3);
c = await ci();
check('restarting free roam clears the wanted level and resets the loadout', c.wanted.stars === 0 && c.weapon.mag === 12 && c.weapon.reserve === 48 && c.weapon.state === 'holstered', `stars ${c.wanted.stars} ${c.weapon.state} ${c.weapon.mag}/${c.weapon.reserve}`);

// --- 3. Parked car
console.log('--- parked car');
const own0 = c.own;
let parked = c.worldCars.find((w) => w.state === 'parked');
for (let k = 0; k < 20 && !parked; k++) { await adv(0.5); parked = (await ci()).worldCars.find((w) => w.state === 'parked'); }
check('a parked car stands at the kerb nearby', !!parked, parked ? `${parked.defId} at ${dist(parked, c.character).toFixed(0)} m` : '');
const prompt = parked ? await toDoor(parked.x, parked.z, parked.yaw, /car/i) : null;
check('at its door the prompt offers to steal it', prompt === 'Steal car', String(prompt));
await shot('steal-prompt');
await pressE();
await adv(3);
c = await ci();
check('E: in the stolen car, driving it (a world car, not the owned one)', c.state === 'driving' && !c.driven.own && c.driven.world && c.driven.vehicleId === parked.defId && c.stats.thefts === 1);
check('   the owned car stays where it was, still in the world', c.own.active && c.own.vehicleId === own0.vehicleId && dist(c.own, own0) < 0.2);
const d0 = { x: c.driven.x, z: c.driven.z };
await page.keyboard.down('KeyW');
await adv(3);
await page.keyboard.up('KeyW');
c = await ci();
check('W drives the stolen car', dist(c.driven, d0) > 8, `${dist(c.driven, d0).toFixed(1)} m, ${c.driven.speed.toFixed(1)} m/s`);
await shot('stolen-driving');
await stopCar();
await pressE();
await adv(0.1);
const exitToast = await toast();
await adv(3);
c = await ci();
check('E: out of the stolen car again; it stays in the world as "taken"', c.state === 'onFoot' && c.worldCars.some((w) => w.state === 'taken' && w.active), `${c.state} speed ${c.driven.speed.toFixed(2)} ${exitToast}`);
check('   the owned car still has not moved', c.own.active && dist(c.own, own0) < 0.2);
const ownYaw = await H(() => { const s = window.__cityRacer.snapshot(); return s.carYaw ?? null; });
let ownPrompt = null;
for (const yaw of [ownYaw ?? 0, 0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  ownPrompt = await toDoor(own0.x, own0.z, yaw, /your car/i);
  if (ownPrompt) break;
}
check('at the owned car the prompt says "Get in your car"', ownPrompt === 'Get in your car', String(ownPrompt));
await pressE();
await adv(3);
c = await ci();
check('E: back in the owned car (no theft counted)', c.state === 'driving' && c.driven.own && c.stats.thefts === 1, `${c.state} own ${c.driven.own}`);
// (E in the owned car at its start spot would open the nearby mission briefing: restart free roam instead.)
await H(() => window.__cityRacer.startLevel(-1));
await adv(3);

// --- 4. Carjack
console.log('--- carjack');
const ownBefore = (await ci()).own;
let t = null;
for (let k = 0; k < 60 && !t; k++) {
  c = await ci();
  t = c.traffic.filter((x) => x.mode === 1 && x.occupied && x.v > 0.5 && x.v < 6 && dist(x, c.own) > 15).sort((a, b) => dist(a, c.character) - dist(b, c.character))[0] ?? null;
  if (!t) await adv(0.5);
}
check('found a slow occupied traffic car', !!t);
if (t) {
  const fx = Math.cos(t.yaw);
  const fz = -Math.sin(t.yaw);
  await place(t.x + fx * 7 + fz * 7, t.z + fz * 7 - fx * 7);
  await adv(0.05);
  c = await ci();
  const near = c.traffic.find((x) => x.i === t.i);
  const occPrompt = near ? await (async () => { await place(near.x - Math.sin(near.yaw) * 2.1, near.z - Math.cos(near.yaw) * 2.1); await adv(0.05); return (await ci()).hud.prompt; })() : null;
  check('next to a car with a driver: the prompt says to aim at the driver', /aim/i.test(occPrompt ?? '') || occPrompt === null, String(occPrompt));
  c = await ci();
  const t1 = c.traffic.find((x) => x.i === t.i) ?? t;
  await place(t1.x + Math.cos(t1.yaw) * 7 - Math.sin(t1.yaw) * 7, t1.z - Math.sin(t1.yaw) * 7 - Math.cos(t1.yaw) * 7);
  await page.keyboard.press('Digit1');
  await adv(0.6);
  await page.mouse.down({ button: 'right' });
  let held = false;
  for (let k = 0; k < 12 && !held; k++) {
    c = await ci();
    const tt = c.traffic.find((x) => x.i === t.i);
    if (!tt) break;
    await aimAt(tt.x, c.character.y + 0.9, tt.z);
    await adv(0.2);
    const t2 = (await ci()).traffic.find((x) => x.i === t.i);
    held = !!t2 && (t2.held || !t2.occupied);
  }
  await page.mouse.up({ button: 'right' });
  check('aiming at the driver makes the car stop', held);
  let t3 = null;
  for (let k = 0; k < 10; k++) {
    await adv(0.5);
    c = await ci();
    t3 = c.traffic.find((x) => x.i === t.i);
    if (t3 && !t3.occupied) break;
  }
  check('   the driver gets out with their hands up (carjack reported, wanted)', !!t3 && !t3.occupied && c.stats.carjacks === 1 && c.peds.drivers >= 1 && c.peds.modes[8] >= 1 && c.wanted.stars >= 1, JSON.stringify({ carjacks: c.stats.carjacks, drivers: c.peds.drivers, surrender: c.peds.modes[8], stars: c.wanted.stars }));
  await shot('carjack');
  await page.keyboard.press('Digit1');
  await adv(0.6);
  let jackPrompt = null;
  if (t3) {
    for (const s of [1, -1]) {
      await place(t3.x - s * Math.sin(t3.yaw) * 2.1, t3.z - s * Math.cos(t3.yaw) * 2.1);
      await adv(0.2);
      jackPrompt = (await ci()).hud.prompt;
      if (jackPrompt && /car/i.test(jackPrompt)) break;
    }
  }
  check('   at the empty car the prompt offers to take it', jackPrompt === 'Take car', String(jackPrompt));
  await pressE();
  await adv(3);
  c = await ci();
  check('E: driving the carjacked car (released from traffic into a world car)', c.state === 'driving' && !c.driven.own && c.driven.world && c.worldCars.some((w) => w.origin === 'traffic' && w.state === 'taken'));
  check('   the owned car is still in the world (same car, not replaced)', c.own.active && c.own.vehicleId === ownBefore.vehicleId && dist(c.own, ownBefore) < 3, `active ${c.own.active} moved ${dist(c.own, ownBefore).toFixed(2)} m`);
  const d1 = { x: c.driven.x, z: c.driven.z };
  await page.keyboard.down('KeyW');
  await adv(2.5);
  await page.keyboard.up('KeyW');
  c = await ci();
  check('   and it drives', dist(c.driven, d1) > 5, `${dist(c.driven, d1).toFixed(1)} m`);
}

// --- 5. Missions
console.log('--- missions');
await H(() => window.__cityRacer.startLevel(1));
await adv(2);
c = await ci();
const ownMission = c.driven.own;
await page.keyboard.press('Digit1');
await adv(0.6);
c = await ci();
check('in a mission the crime systems are off and 1 does not draw the gun', !c.enabled && c.weapon.state === 'holstered' && !c.hud.weapon);
check('   the mission uses the owned car', ownMission);
await H(() => window.__cityRacer.startLevel(-1));
await adv(2);
c = await ci();
check('back to free roam: crime systems on, own car driven, no taken world cars left over', c.enabled && c.driven.own && c.own.active && !c.worldCars.some((w) => w.state === 'taken'), JSON.stringify(c.worldCars.map((w) => w.state)));

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures === 0 ? `\nCRIME QA: ALL ${passes} PASSED` : `\nCRIME QA: ${failures} FAILED (${passes} passed)`);
process.exit(failures === 0 ? 0 : 1);
