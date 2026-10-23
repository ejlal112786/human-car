/**
 * Headless crime-update test (real Rapier in Node, no rendering):
 *   1. sidearm state machine (draw / fire / dry / reload / holster timings and ammo),
 *   2. wanted reports (a phoned-in report starts a search, busted ignores it),
 *   3. traffic carjack: a slow threatened car brakes to a stop, the driver gets out ('abandon'), the car
 *      becomes an unoccupied static wreck that never drives off again; a fast one flees; release() frees it.
 * Usage: npm run test:crime
 */
declare const process: { exit(code: number): never };
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { buildCityGraph } from '../src/game/traffic/cityGraph';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { TrafficSystem } from '../src/game/traffic/TrafficSystem';
import { CROSSINGS } from '../src/game/world/Crossings';
import { DynamicProps } from '../src/game/world/Props';
import { Track } from '../src/game/world/Track';
import { CYCLE_TIME, DRAW_TIME, HOLSTER_TIME, MAG_SIZE, RELOAD_TIME, SPREAD_ADS, SPREAD_AIM, START_RESERVE, Weapon } from '../src/game/crime/Weapon';
import { PISTOL_POINTS, SLIDE_TRAVEL, createPistol, slideOffset } from '../src/game/crime/PistolMesh';
import { PISTOL_FRAME, PISTOL_SLIDE } from '../src/game/crime/pistolModel';
import { sanitizeSettings } from '../src/game/Settings';
import { WantedSystem } from '../src/game/police/Wanted';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const tick = (w: Weapon, s: number): void => {
  for (let i = 0; i < Math.round(s / FIXED_DT); i++) w.update(FIXED_DT);
};

console.log('--- weapon state machine');
{
  const w = new Weapon();
  check('starts holstered with a full magazine', w.state === 'holstered' && w.mag === MAG_SIZE && w.reserve === START_RESERVE && !w.inHand);
  check('cannot fire or aim while holstered', !w.trigger() && (w.setAim(true), !w.isAiming));
  w.toggle();
  check('toggle → drawing (gun in hand, not yet ready)', w.state === 'drawing' && w.inHand && !w.drawn && !w.trigger());
  tick(w, DRAW_TIME + 0.02);
  check(`ready after ${DRAW_TIME} s, aim tightens the spread`, w.state === 'ready' && w.isAiming && w.spread < 0.01);
  w.events.length = 0;
  check('fires one round', w.trigger() && w.mag === MAG_SIZE - 1 && w.events.includes('shot'));
  check('recoil widens the spread right after a shot', w.recoil > 0 && w.spread > 0.006);
  check('semi-automatic: no second round inside the cycle time', !w.trigger() && w.mag === MAG_SIZE - 1);
  tick(w, CYCLE_TIME + 0.02);
  check('recoil settles within the cycle time', w.recoil === 0);
  let fired = 1;
  for (let k = 0; k < 40 && w.mag > 0; k++) {
    if (w.trigger()) fired++;
    tick(w, CYCLE_TIME + 0.02);
  }
  check('empties the magazine in exactly 12 rounds', fired === MAG_SIZE && w.mag === 0, `${fired} fired`);
  w.events.length = 0;
  tick(w, CYCLE_TIME + 0.02);
  check('empty trigger: dry click and automatic reload', !w.trigger() && w.events.includes('dry') && w.state === 'reloading');
  tick(w, RELOAD_TIME / 2);
  check('cannot fire mid-reload', !w.trigger() && w.mag === 0);
  tick(w, RELOAD_TIME / 2 + 0.05);
  check('reload moves 12 rounds from the reserve', w.state === 'ready' && w.mag === MAG_SIZE && w.reserve === START_RESERVE - MAG_SIZE, `${w.mag}/${w.reserve}`);
  check('reload refused with a full magazine', !w.reload());
  w.toggle();
  check('toggle → holstering (aiming stops counting)', w.state === 'holstering' && !w.isAiming);
  tick(w, HOLSTER_TIME + 0.02);
  check('holstered again', w.state === 'holstered' && !w.inHand);
  w.toggle();
  tick(w, DRAW_TIME + 0.02);
  w.forceHolster();
  check('forceHolster (entering a car / arrest) is immediate', w.state === 'holstered' && !w.aiming);
  w.reserve = 0;
  w.mag = 0;
  w.toggle();
  tick(w, DRAW_TIME + 0.02);
  check('no reserve: dry trigger does not start a reload', !w.trigger() && w.state === 'ready');
  check('refill caps the reserve', w.refill(500) === 96 && w.reserve === 96);
  w.resetLoadout();
  check('resetLoadout: holstered, full magazine, starting reserve', w.state === 'holstered' && w.mag === MAG_SIZE && w.reserve === START_RESERVE);
}

console.log('--- wanted reports');
{
  const w = new WantedSystem();
  check('report while clear: 1 star and a search for the player', w.report() && w.stars === 1 && w.state === 'search');
  const h = w.heat;
  check('report during a search restarts the search (no extra heat)', w.report() && w.state === 'search' && w.heat === h && w.unseen === 0);
  const w2 = new WantedSystem();
  w2.offence('carjack', 999);
  check('carjacking is always reported (even with no unit near)', w2.stars >= 1, `stars ${w2.stars}`);
  const w3 = new WantedSystem();
  check('car theft unseen by police does not count', !w3.offence('carTheft', 999) && w3.stars === 0);
}

console.log('--- traffic carjack');
{
  const physics = await PhysicsWorld.create();
  physics.addGround(800);
  const track = new Track(2);
  const props = new DynamicProps(physics, track);
  const graph = buildCityGraph(track, props.positions);
  const signals = new TrafficSignals(CROSSINGS.length);
  const traffic = new TrafficSystem(physics, graph, signals, null, [13, 5]);
  traffic.setDensity(18);
  const fx = track.px[4] + track.rx(4) * 9.1;
  const fz = track.pz[4] + track.rz(4) * 9.1;
  traffic.setEnabled(true, fx, fz, []);
  const step = (s: number, onStep?: () => void): void => {
    for (let i = 0; i < Math.round(s / FIXED_DT); i++) {
      signals.update(FIXED_DT);
      traffic.fixedUpdate(FIXED_DT, fx, fz, []);
      physics.step();
      onStep?.();
    }
  };
  step(5);
  // Pick a car that is moving slowly (≤ 9 m/s) and one that is fast.
  let slow = -1;
  let fast = -1;
  for (let k = 0; k < 600 && (slow < 0 || fast < 0); k++) {
    step(0.1);
    traffic.cars.forEach((c, i) => {
      if (c.mode !== 1 || !c.occupied) return;
      if (slow < 0 && c.v > 1 && c.v < 7) slow = i;
      if (fast < 0 && c.v > 10 && i !== slow) fast = i;
    });
  }
  check('found a slow and a fast traffic car', slow >= 0 && fast >= 0, `slow ${slow} fast ${fast}`);
  if (slow >= 0 && fast >= 0) {
    check('threatening a fast car makes it flee (keeps driving, occupied)', traffic.threaten(fast) === 'flee' && traffic.cars[fast].occupied);
    check('threatening a slow car makes it stop', traffic.threaten(slow) === 'stop' && traffic.cars[slow].held);
    check('a held car cannot be threatened twice', traffic.threaten(slow) === 'none');
    traffic.events.length = 0;
    let abandonAt = -1;
    let t = 0;
    step(8, () => {
      t += FIXED_DT;
      if (abandonAt < 0 && traffic.events.some((e) => e.type === 'abandon')) abandonAt = t;
    });
    const c = traffic.cars[slow];
    const ev = traffic.events.find((e) => e.type === 'abandon') as { type: 'abandon'; x: number; z: number } | undefined;
    check('the stopped car emits one abandon event (driver gets out at the door)', abandonAt > 0 && traffic.events.filter((e) => e.type === 'abandon').length === 1 && !!ev && Math.hypot(ev.x - c.x, ev.z - c.z) < 3, `after ${abandonAt.toFixed(2)} s`);
    check('abandoned car: unoccupied wreck, no longer held', c.mode === 2 && !c.occupied && !c.held && c.v === 0, `mode ${c.mode} occ ${c.occupied}`);
    const x0 = c.x;
    const z0 = c.z;
    step(10);
    check('the abandoned car never drives off on its own', c.mode === 2 && !c.occupied && Math.hypot(c.x - x0, c.z - z0) < 1, `moved ${Math.hypot(c.x - x0, c.z - z0).toFixed(2)} m`);
    check('threatening the empty car does nothing', traffic.threaten(slow) === 'none');
    check('carByCollider finds the car from its collider', traffic.carByCollider(c.collider.handle) === slow);
    const rel = traffic.release(slow);
    check('release() returns its pose and paint and takes it out of the simulation', !!rel && Math.abs(rel.x - x0) < 1e-6 && c.mode === 0 && traffic.carByCollider(c.collider.handle) === -1);
    check('release() of an inactive car returns null', traffic.release(slow) === null);
  }
  traffic.setEnabled(false);
}

console.log('--- pistol model and aim down sights');
{
  const w = new Weapon();
  w.toggle();
  tick(w, DRAW_TIME + 0.05);
  w.setAim(true);
  const shoulder = w.spread;
  w.sights = 1;
  const sights = w.spread;
  check('down the sights the spread is tighter than over the shoulder', Math.abs(shoulder - SPREAD_AIM) < 1e-9 && Math.abs(sights - SPREAD_ADS) < 1e-9 && sights < shoulder, `${shoulder} → ${sights}`);
  w.sights = 0.5;
  check('   and blends in between while the view moves to the eye', w.spread < shoulder && w.spread > sights);
  w.sights = 1;
  w.trigger();
  check('a shot resets the fixed-step shot clock', w.sinceShot === 0);
  tick(w, 0.05);
  check('   which advances with the fixed step', Math.abs(w.sinceShot - 0.05) < 1e-6, w.sinceShot.toFixed(4));
  w.forceHolster();
  check('holstering clears the sights blend', w.sights === 0 && !w.isAiming);
  check('slide: in battery before a shot, back within 25 ms, home by 90 ms', slideOffset(0, false) === 0 && Math.abs(slideOffset(0.025, false) - SLIDE_TRAVEL) < 1e-9 && slideOffset(0.06, false) > 0 && slideOffset(0.091, false) === 0);
  check('   locked back on an empty magazine', slideOffset(5, true) === SLIDE_TRAVEL);
  const tris = (p: Record<string, readonly number[] | undefined>): number => Object.values(p).reduce((n, a) => n + (a ? a.length / 9 : 0), 0);
  let maxZ = -Infinity;
  let minZ = Infinity;
  let minY = Infinity;
  for (const part of [PISTOL_FRAME, PISTOL_SLIDE]) for (const a of Object.values(part)) if (a) for (let i = 0; i < a.length; i += 3) { maxZ = Math.max(maxZ, a[i + 2]); minZ = Math.min(minZ, a[i + 2]); minY = Math.min(minY, a[i + 1]); }
  check('bundled pistol model: frame + separate slide, ~1300 triangles, real-world size (17–21 cm long, grip ~10 cm)', tris(PISTOL_FRAME) > 300 && tris(PISTOL_SLIDE) > 300 && maxZ - minZ > 0.17 && maxZ - minZ < 0.21 && minY < -0.08, `${tris(PISTOL_FRAME)} + ${tris(PISTOL_SLIDE)} tris, ${(maxZ - minZ).toFixed(3)} m`);
  check('   sights sit above the bore, front sight ahead of the rear, muzzle at the front', PISTOL_POINTS.sightY > PISTOL_POINTS.muzzleY && PISTOL_POINTS.frontSightZ > PISTOL_POINTS.rearSightZ + 0.1 && Math.abs(PISTOL_POINTS.muzzleZ - maxZ) < 0.005);
  const p = createPistol(false);
  check('   built meshes: frame + slide group with the sight dots', p.root.children.length >= 3 && p.slide.children.length >= 5);
  check('aim view setting: defaults to the sights, keeps "shoulder", rejects junk', sanitizeSettings({}).aimView === 'sights' && sanitizeSettings({ aimView: 'shoulder' }).aimView === 'shoulder' && sanitizeSettings({ aimView: 'x' as never }).aimView === 'sights');
}

if (failures > 0) {
  console.log(`\nCRIME TEST: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nCRIME TEST: ALL PASSED');
