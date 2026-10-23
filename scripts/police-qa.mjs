/**
 * Browser check (QA build) of the visible police in the running game: marked cars (light bar, door
 * panels, number), officers getting out of a stopped unit and closing in on a player on foot, the capture
 * by an officer, line of sight (search when out of view, last known position), roadblocks set up out of
 * sight ahead of a car chase, and shooting an officer (stylised knock-down, wanted level).
 * Usage: node scripts/police-qa.mjs [url]   (default http://localhost:4174/, needs `npm run preview:qa`)
 * POLICE_SHOTS=dir saves screenshots.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4174/';
const SHOTS = process.env.POLICE_SHOTS ?? '';
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
const pi = () => H(() => window.__cityRacer.policeInfo());
const ci = () => H(() => window.__cityRacer.crimeInfo());
const shot = async (name) => {
  if (!SHOTS) return;
  await H(() => window.__cityRacer.qaFreeze(true));
  await adv(0);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 }).catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
  await H(() => window.__cityRacer.qaFreeze(false));
};
const place = (x, z, yaw = 0) => H(([a, b, c]) => window.__cityRacer.qaPlaceCharacter(a, b, c), [x, z, yaw]);
const aimAt = (x, y, z) => H(([a, b, c]) => window.__cityRacer.qaAimAt(a, b, c), [x, y, z]);
const toast = () => H(() => [...document.querySelectorAll('.toast')].map((e) => e.textContent).join(' | '));

let p = null;
let c = null;
/** Free roam from a clean record: a bust in an earlier section starts a real arrest and saves a jail
 *  sentence + impound (covered by arrest-qa); clear them so each police section starts on the street. */
const freeRoam = () =>
  H(() => {
    const g = window.__cityRacer;
    g.setProgress({ ...JSON.parse(JSON.stringify(g.garageInfo().progress)), jail: null, impound: {} });
    g.startLevel(-1);
  });
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) ?? '').slice(7);
const want = (name) => !ONLY || ONLY.split(',').includes(name);
await H(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 15, best: {}, credits: 5000 }));
await freeRoam();
await adv(3);
await page.mouse.move(480, 270);

// --- 1. Marked police car
if (want('officers')) {
console.log('--- marked police cars');
p = await pi();
check('free roam: police on, one patrol unit with the light bar', p.enabled && p.units.filter((u) => u.active).length === 1 && p.units[0].lightbar);
// Bring the patrol car next to the player (on foot at the start) so it can be seen.
c = await ci();
await H(([i]) => window.__cityRacer.policePlace(0, i + 3, 1, 5.25), [p.playerIdx]);
await adv(0.3);
p = await pi();
check('door panels and number fitted to the patrol car body (3 decals), visible', p.units[0].livery.visible && p.units[0].livery.panels === 3, JSON.stringify(p.units[0].livery));
check('the 4th (roadblock) car is parked out of the world', !p.units[3].active && !p.units[3].carActive);
await aimAt(p.units[0].x, 1, p.units[0].z);
await adv(0.1);
await shot('p1-marked-car');

// --- 2. Officers on foot
console.log('--- officers on foot');
const off0 = await H(() => window.__cityRacer.policeOffence('hitPolice'));
await adv(0.2);
p = await pi();
check('witnessed offence → 1★ pursuit, light bars flashing state', off0 && p.stars === 1 && p.state === 'pursuit', `${p.stars}★ ${p.state}`);
let deployed = null;
let minD = Infinity;
for (let k = 0; k < 40; k++) {
  await adv(0.25);
  p = await pi();
  c = await ci();
  for (const o of p.officers) if (o.mode !== 'off') minD = Math.min(minD, Math.hypot(o.x - c.character.x, o.z - c.character.z));
  if (!deployed && p.officers.some((o) => o.mode === 'chase')) {
    deployed = { t: k * 0.25, o: p.officers.find((o) => o.mode === 'chase') };
    await aimAt(deployed.o.x, 1.2, deployed.o.z);
    await adv(0.05);
    await shot('p2-officer-out');
  }
  if (p.state === 'busted') break;
}
check('a stopped unit near the player on foot lets an officer out (visible model, real collider)', !!deployed && deployed.o.visible && deployed.o.collider, deployed ? `after ${deployed.t.toFixed(2)} s` : 'none');
check('the officer closes in and stops at arm\'s length', minD < 2.6 && minD > 0.8, `closest ${minD.toFixed(2)} m`);
check('held by an officer → busted', p.state === 'busted', p.state);
{
  // Busted in free roam: the arresting officers are scripted by the arrest sequence (sidearm aimed).
  const o = p.officers.find((x) => x.mode === 'chase' || x.mode === 'script');
  if (o) {
    await aimAt(o.x, 1.3, o.z);
    await adv(0.05);
    await shot('p3-officer-aiming');
    check('the officer has the sidearm aimed at the player', o.aim > 0.8, `aim ${o.aim.toFixed(2)}`);
  } else check('an officer is with the player', false);
}
console.log(`toasts: ${await toast()}`);

}
// --- 3. Line of sight and search
if (want('sight')) {
console.log('--- line of sight, search');
await freeRoam();
await adv(3);
p = await pi();
check('restart: clean record, officers back in their cars', p.stars === 0 && p.officers.every((o) => o.mode === 'off'));
{
  // Find a road point ~70–140 m from the player that a building hides, and one with a clear view.
  c = await ci();
  const me = { x: c.character.x, z: c.character.z };
  let blocked = null;
  let clear = null;
  for (let d = -260; d <= 260 && (!blocked || !clear); d += 4) {
    const tp = await H(([i]) => window.__cityRacer.trackPoint(i, 5.25), [p.playerIdx + d]);
    const r = Math.hypot(tp.x - me.x, tp.z - me.z);
    if (r < 60 || r > 140) continue;
    const vis = await H(([a, b, x, z]) => window.__cityRacer.policeSight(a, b, x, z), [tp.x, tp.z, me.x, me.z]);
    if (!vis && !blocked) blocked = { d, r };
    if (vis && !clear) clear = { d, r };
  }
  check('the city has spots where buildings block the police view (ray cast against fixed geometry)', !!blocked && !!clear, `blocked ${JSON.stringify(blocked)} clear ${JSON.stringify(clear)}`);
  if (blocked && clear) {
    await H(([i]) => window.__cityRacer.policePlace(0, i, 1, 5.25), [p.playerIdx + clear.d]);
    await adv(0.2);
    await H(() => window.__cityRacer.policeOffence('hitPolice'));
    await adv(0.5);
    p = await pi();
    check('unit with a clear view → it sees the player, pursuit', p.seen && p.state === 'pursuit', `seen ${p.seen} ${p.state}`);
    const lk0 = p.lastKnown;
    await H(([i]) => window.__cityRacer.policePlace(0, i, 1, 5.25), [p.playerIdx + blocked.d]);
    await adv(0.6);
    p = await pi();
    check(`unit ${blocked.r.toFixed(0)} m away behind buildings (inside sight range) → not seen, search`, !p.seen && p.state === 'search', `seen ${p.seen} ${p.state}`);
    // Move away while unseen: the last known position stays put and the unit heads there.
    await place(me.x + 0.5, me.z + 0.5);
    await adv(0.2);
    p = await pi();
    check('searching: last known position is where the player was last seen', Math.hypot(p.lastKnown.x - lk0.x, p.lastKnown.z - lk0.z) < 3, `${Math.hypot(p.lastKnown.x - lk0.x, p.lastKnown.z - lk0.z).toFixed(1)} m`);
    let escaped = false;
    for (let k = 0; k < 30 && !escaped; k++) {
      await adv(0.5);
      p = await pi();
      escaped = p.state === 'clear';
      if (p.state === 'pursuit') break;
    }
    // Either the unit drove round and spotted the player (pursuit) or the search ran out (escape) — both are legitimate;
    // what must not happen is an instant re-spot through the building.
    check('search resolves legitimately (escape after the search time, or re-spotted after driving round)', escaped || p.state === 'pursuit', p.state);
  }
}

}
// --- 4. Roadblock
if (want('roadblock')) {
console.log('--- roadblock');
await freeRoam();
await adv(3);
{
  const own0 = (await ci()).own;
  const ownYaw = await H(() => window.__cityRacer.snapshot().carYaw ?? 0);
  let ok = false;
  for (const yaw of [ownYaw, 0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
    const dirs = [[Math.cos(yaw), -Math.sin(yaw)], [-Math.cos(yaw), Math.sin(yaw)], [Math.sin(yaw), Math.cos(yaw)], [-Math.sin(yaw), -Math.cos(yaw)]];
    for (const [sx, sz] of dirs) {
      await place(own0.x + sx * 2.1, own0.z + sz * 2.1);
      await adv(0.2);
      if (/your car/i.test((await ci()).hud.prompt ?? '')) { ok = true; break; }
    }
    if (ok) break;
  }
  await page.keyboard.press('KeyE');
  await adv(3);
  c = await ci();
  check('in the own car', c.state === 'driving' && c.driven.own, c.state);
}
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const keys = { w: false, a: false, d: false, s: false };
const setKey = async (k, on) => {
  if (keys[k] === on) return;
  keys[k] = on;
  const code = { w: 'KeyW', a: 'KeyA', d: 'KeyD', s: 'KeyS' }[k];
  if (on) await page.keyboard.down(code);
  else await page.keyboard.up(code);
};
/** Drive along the road (lane offset `lane`, +1 direction) for up to `secs`, stopping early when `until()` is true. */
async function drive(secs, laneFn, until, vmax = 19) {
  for (let k = 0; k < secs / 0.1; k++) {
    c = await ci();
    p = await pi();
    if (until && (await until())) return true;
    const lane = laneFn();
    const tp = await H(([i, o]) => window.__cityRacer.trackPoint(i, o), [p.playerIdx + 7, lane]);
    const fa = Math.atan2(-Math.sin(c.driven.yaw), Math.cos(c.driven.yaw));
    const ta = Math.atan2(tp.z - c.driven.z, tp.x - c.driven.x);
    const diff = wrapA(ta - fa);
    await setKey('d', diff > 0.04);
    await setKey('a', diff < -0.04);
    await setKey('w', c.driven.speed < vmax);
    await setKey('s', c.driven.speed > vmax + 4);
    await adv(0.1);
  }
  return false;
}
{
  p = await pi();
  await H(() => window.__cityRacer.debugTeleport(window.__cityRacer.policeInfo().playerIdx, 1.75));
  await adv(0.2);
  await drive(3, () => 1.75);
  p = await pi();
  await H(([i]) => window.__cityRacer.policePlace(0, i, 1, 1.75), [p.playerIdx - 8]);
  await adv(0.1);
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  await adv(0.1);
  p = await pi();
  check('2★ car chase', p.stars >= 2 && p.state === 'pursuit', `${p.stars}★ ${p.state}`);
  let placed = null;
  const got = await drive(30, () => 1.75, async () => {
    if (p.roadblockUp && !placed) placed = { dist: p.lastBlock.dist, by: p.lastBlock.hiddenBy, block: { ...p.units[3] } };
    return !!placed;
  });
  check('a roadblock is set up ahead during the chase', got && !!placed, placed ? `${placed.dist.toFixed(0)} m, hidden by ${placed.by}` : `state ${p.state} ${p.stars}★`);
  if (placed) {
    const b = placed.block;
    check('it appeared out of sight (beyond sight range or behind buildings)', placed.by === 'range' ? placed.dist > 150 : placed.by === 'buildings', `${placed.dist.toFixed(0)} m, ${placed.by}`);
    p = await pi();
    check('roadblock car: marked, light bar on, an officer standing guard', p.units[3].lightbar && p.units[3].livery.panels === 3 && p.officers.some((o) => o.unit === 3 && o.mode === 'guard'));
    // Drive up to it in the lane, then swerve through the gap on the other side of the road.
    let shotTaken = false;
    let minB = Infinity;
    let passed = false;
    await drive(40, () => {
      const dB = Math.hypot(c.driven.x - b.x, c.driven.z - b.z);
      return dB < 75 ? -2.6 : 1.75;
    }, async () => {
      const q = p.units[3];
      const dB = Math.hypot(c.driven.x - q.x, c.driven.z - q.z);
      minB = Math.min(minB, dB);
      if (!shotTaken && dB < 28) {
        shotTaken = true;
        await shot('p4-roadblock');
      }
      if (minB < 30 && dB > 40) passed = true;
      return passed;
    }, 15);
    check('the roadblock leaves a gap: the player gets past it by swerving into the other lanes', passed && minB > 1.5, `closest ${minB.toFixed(1)} m`);
    const cleared = await drive(35, () => 1.75, async () => !p.roadblockUp);
    check('well past it → the roadblock is cleared (not in front of the player)', cleared, `up ${p.roadblockUp}`);
  }
  for (const k of Object.keys(keys)) await setKey(k, false);
}

}
// --- 5. Shooting an officer
if (want('shoot')) {
console.log('--- shooting an officer');
await freeRoam();
await adv(3);
{
  p = await pi();
  await H(([i]) => window.__cityRacer.policePlace(0, i + 3, 1, 5.25), [p.playerIdx]);
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  let o = null;
  for (let k = 0; k < 20 && !o; k++) {
    await adv(0.2);
    p = await pi();
    o = p.officers.map((x, i) => ({ ...x, i })).find((x) => x.mode === 'chase' && x.aim < 0.2) ?? null;
  }
  if (o) {
    // Stand 4 m from the officer on the far side from his car, so the car body is never in the line of
    // fire (when it is, the shot correctly hits the car; that made this check depend on which door he used).
    const car = p.units[0];
    const dx = o.x - car.x;
    const dz = o.z - car.z;
    const l = Math.hypot(dx, dz) || 1;
    await place(o.x + (dx / l) * 4, o.z + (dz / l) * 4, Math.atan2(-dx, -dz));
    await adv(0.05);
  }
  if (o) {
    await page.keyboard.press('Digit1');
    await adv(0.8);
    p = await pi();
    o = { ...p.officers[o.i], i: o.i };
    await aimAt(o.x, o.y + 1.1, o.z);
    await page.mouse.down({ button: 'right' });
    for (let k = 0; k < 3; k++) {
      p = await pi();
      o = { ...p.officers[o.i], i: o.i };
      await aimAt(o.x, o.y + 1.1, o.z);
      await adv(0.15);
    }
    const heat0 = p.heat;
    c = await ci();
    await page.mouse.down({ button: 'left' });
    await adv(0.1);
    await page.mouse.up({ button: 'left' });
    await adv(0.3);
    await page.mouse.up({ button: 'right' });
    c = await ci();
    p = await pi();
    check('a shot at an officer hits him (shot kind officer)', c.lastShot.kind === 'officer', c.lastShot.kind);
    check('the officer goes down (stylised, collider removed) and the shot on police is counted', p.officers[o.i].mode === 'down' && !p.officers[o.i].collider && p.heat >= heat0 + 4, `mode ${p.officers[o.i].mode}, heat ${heat0} → ${p.heat}`);
    await shot('p5-officer-down');
    await adv(5.5);
    p = await pi();
    check('…and gets back up', p.officers[o.i].mode !== 'down', p.officers[o.i].mode);
  } else check('an officer came out to shoot at', false);
}
}

console.log(`\nconsole errors: ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 5)) console.log(`  ${e}`);
check('no console errors', consoleErrors.length === 0);
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
