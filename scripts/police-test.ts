/**
 * Headless police test: wanted-level state machine (pure), then real-physics pursuit on the city
 * road loop (catch a 60 km/h target, bust a stopped one, lose a 200 km/h one), then the PoliceSystem
 * unit management. Usage: npm run test:police
 */
declare const process: { exit(code: number): never };
import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { Vehicle } from '../src/game/Vehicle';
import { Track } from '../src/game/world/Track';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { CROSSINGS } from '../src/game/world/Crossings';
import { PoliceUnit, type PursuitTarget, type RoadObstacle } from '../src/game/police/PoliceUnit';
import { BLOCK_UNIT, PoliceSystem, type PlayerState } from '../src/game/police/PoliceSystem';
import { BUSTED_HOLD, BUST_TIME, ESCALATE_EVERY, SEARCH_TIME, WantedSystem } from '../src/game/police/Wanted';
import { Officers } from '../src/game/police/Officers';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const run = (w: WantedSystem, s: number, nearestUnit: number, playerSpeed = 20, onFoot = false): void => {
  for (let i = 0; i < Math.round(s / FIXED_DT); i++) w.update(FIXED_DT, { nearestUnit, playerSpeed, onFoot });
};

console.log('--- wanted state machine');
{
  const w = new WantedSystem();
  check('unwitnessed red light does not count', !w.offence('redLight', 200) && w.stars === 0 && w.state === 'clear');
  check('witnessed red light: 1 star, pursuit', w.offence('redLight', 50) && w.stars === 1 && w.state === 'pursuit');
  w.offence('hitPedestrian', 500);
  check('pedestrian hit is always reported: 4 heat = 2 stars', w.stars === 2, `heat ${w.heat}`);
  run(w, ESCALATE_EVERY + 0.1, 40);
  check(`long pursuit escalates (+1 heat per ${ESCALATE_EVERY} s)`, w.heat === 5, `heat ${w.heat}`);
  for (let i = 0; i < 6; i++) w.offence('hitPolice', 10);
  check('stars cap at 3', w.stars === 3, `heat ${w.heat}`);
  run(w, 0.1, 200);
  check('out of sight → search', w.state === 'search');
  run(w, SEARCH_TIME - 1, 200);
  check('still searching just before the search time', w.state === 'search' && w.stars === 3);
  run(w, 0.1, 100);
  check('spotted again → pursuit resumes', w.state === 'pursuit');
  run(w, 0.1, 200);
  run(w, SEARCH_TIME + 0.2, 200);
  const esc = w.events.find((e) => e.type === 'escaped');
  check(`unseen for ${SEARCH_TIME} s → escaped, wanted level cleared`, w.state === 'clear' && w.stars === 0 && w.heat === 0 && esc?.stars === 3);
  w.events.length = 0;

  // Busted in a car: slow and close for 4 s.
  w.offence('redLight', 30);
  run(w, 3.5, 5, 1);
  check('held 3.5 s: not busted yet', w.state === 'pursuit');
  run(w, 0.6, 5, 1);
  const b = w.events.find((e) => e.type === 'busted');
  check('held 4 s next to a unit → busted', w.state === 'busted' && b?.stars === 1);
  check('fine = 250 per star, capped by credits', WantedSystem.fine(2, 10000) === 500 && WantedSystem.fine(3, 300) === 300 && WantedSystem.fine(1, 0) === 0);
  run(w, BUSTED_HOLD + 0.1, 5, 0);
  check('after the busted hold everything resets', w.state === 'clear' && w.stars === 0);
  // Moving away resets the hold.
  w.offence('redLight', 30);
  run(w, 3, 5, 1);
  run(w, 1, 5, 15);
  run(w, 2.5, 5, 1);
  check('driving off breaks the hold (no bust from interrupted holds)', w.state === 'pursuit');
  // On foot: 3 s within 7 m whatever the speed.
  w.reset();
  w.offence('hitPedestrian', 300);
  run(w, 3.1, 6, 5, true);
  check('on foot: 3 s within 7 m of a unit → busted even while running', w.state === 'busted');
}

console.log('\n--- pursuit driving (real physics on the road loop)');
const physics = await PhysicsWorld.create();
physics.addGround(800);
const track = new Track(2);
const scene = new Scene();
const n = track.count;
const wrap = (i: number): number => ((i % n) + n) % n;

/** A scripted target point moving along a lane at a fixed speed (ignores corners — it is not a car). */
class ScriptedTarget {
  s: number;
  constructor(
    i: number,
    private readonly lane: number,
    public speed: number,
  ) {
    this.s = i * track.spacing;
  }
  get idx(): number {
    return wrap(Math.round(this.s / track.spacing));
  }
  step(dt: number): void {
    this.s += this.speed * dt;
  }
  fill(t: PursuitTarget): void {
    const k = this.idx;
    t.x = track.px[k] + track.rx(k) * this.lane;
    t.z = track.pz[k] + track.rz(k) * this.lane;
    t.vx = track.tx[k] * this.speed;
    t.vz = track.tz[k] * this.speed;
    t.idx = k;
    t.onFoot = false;
  }
}

const car = new Vehicle(physics, scene, new Vector3(0, 0, 0), 0, 0x161c2c);
const unit = new PoliceUnit(car, track);
const tgt: PursuitTarget = { x: 0, z: 0, vx: 0, vz: 0, idx: 0, onFoot: false };

function chase(startGap: number, speed: number, seconds: number, obstacles: RoadObstacle[] = [], wanted?: WantedSystem): { minAt: number; min: number; last: number; firstClose: number; respawns: number; maxSpeed: number; minObstacle: number } {
  const start = 300;
  unit.place(start, 1, 1.75);
  const target = new ScriptedTarget(start + Math.round(startGap / track.spacing), 1.75, speed);
  let min = Infinity;
  let firstClose = -1;
  let respawns = 0;
  let maxSpeed = 0;
  let minObstacle = Infinity;
  let last = 0;
  let minAt = 0;
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    target.step(FIXED_DT);
    target.fill(tgt);
    unit.fixedUpdate(FIXED_DT, tgt, wanted?.state === 'busted', obstacles);
    physics.step();
    car.afterStep();
    const p = car.physicsPosition;
    const d = Math.hypot(p.x - tgt.x, p.z - tgt.z);
    last = d;
    if (d < min) {
      min = d;
      minAt = i * FIXED_DT;
    }
    maxSpeed = Math.max(maxSpeed, car.physics.forwardSpeed);
    for (const o of obstacles) minObstacle = Math.min(minObstacle, Math.hypot(p.x - o.x, p.z - o.z));
    if (firstClose < 0 && d < 15) firstClose = i * FIXED_DT;
    if (wanted) wanted.update(FIXED_DT, { nearestUnit: d, playerSpeed: speed, onFoot: false });
    if (unit.needsRespawn) {
      respawns++;
      unit.place(target.idx - 85, 1, 1.75);
    }
  }
  return { min, last, firstClose, respawns, maxSpeed, minObstacle, minAt };
}

{
  const r = chase(120, 60 / 3.6, 45);
  check('closes on a 60 km/h target from 120 m behind', r.firstClose >= 0 && r.firstClose < 25, `within 15 m after ${r.firstClose.toFixed(1)} s, min ${r.min.toFixed(1)} m at ${r.minAt.toFixed(1)} s, top ${(r.maxSpeed * 3.6).toFixed(0)} km/h`);
  check('then stays on its tail without running into it', r.last < 25 && r.min > 3, `gap at the end ${r.last.toFixed(1)} m, ${r.respawns} respawns`);
  check('follows the road without needing a respawn', r.respawns === 0);
}
{
  const w = new WantedSystem();
  w.offence('redLight', 50);
  const r = chase(140, 0, 50, [], w);
  const b = w.events.find((e) => e.type === 'busted');
  check('a stopped target is reached and busted', !!b, `min gap ${r.min.toFixed(1)} m, state ${w.state}`);
  check('the unit stops short of the stopped car (no ramming)', r.min > 3.2, `min centre distance ${r.min.toFixed(1)} m`);
}
{
  const w = new WantedSystem();
  w.offence('redLight', 50);
  const r = chase(40, 200 / 3.6, 60, [], w);
  const esc = w.events.find((e) => e.type === 'escaped');
  check('a 200 km/h target gets away (escape)', !!esc && w.state === 'clear', `final gap ${r.last.toFixed(0)} m, top ${(r.maxSpeed * 3.6).toFixed(0)} km/h`);
}
{
  // A stopped car in the inner lane 120 m ahead: the unit changes lane round it.
  const k = wrap(300 + 60);
  const obstacles: RoadObstacle[] = [{ x: track.px[k] + track.rx(k) * 1.75, z: track.pz[k] + track.rz(k) * 1.75, speed: 0 }];
  const r = chase(200, 50 / 3.6, 25, obstacles);
  check('changes lane round a stopped car in its lane', r.minObstacle > 2.2, `closest pass ${r.minObstacle.toFixed(1)} m`);
}
{
  // Wrong way: placed facing away from a target behind it → turns round.
  unit.place(500, -1, 1.75);
  const target = new ScriptedTarget(560, 1.75, 30 / 3.6);
  let firstClose = -1;
  let respawned = false;
  for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
    target.step(FIXED_DT);
    target.fill(tgt);
    unit.fixedUpdate(FIXED_DT, tgt, false, []);
    physics.step();
    car.afterStep();
    const p = car.physicsPosition;
    if (unit.needsRespawn) respawned = true;
    if (firstClose < 0 && Math.hypot(p.x - tgt.x, p.z - tgt.z) < 15) firstClose = i * FIXED_DT;
  }
  check('facing the wrong way: turns round (or asks for a respawn) and catches up', firstClose >= 0 || respawned, `close after ${firstClose.toFixed(1)} s, respawn requested ${respawned}`);
}

console.log('\n--- police system (unit management)');
{
  const cars = [car, new Vehicle(physics, scene, new Vector3(0, -40, 0), 0), new Vehicle(physics, scene, new Vector3(0, -46, 0), 0)];
  cars.forEach((c) => c.setActive(false));
  const ps = new PoliceSystem(track, cars);
  const signals = new TrafficSignals(CROSSINGS.length);
  const k0 = 100;
  const player: PlayerState = { inCar: true, x: track.px[k0] + track.rx(k0) * 1.75, z: track.pz[k0] + track.rz(k0) * 1.75, vx: track.tx[k0] * 10, vz: track.tz[k0] * 10, speed: 10, idx: k0 };
  ps.setEnabled(true, player);
  const activeCount = (): number => [0, 1, 2].filter((k) => ps.isActive(k)).length;
  const d0 = ps.nearestUnit(player.x, player.z);
  check('free roam: one patrol car, out of sight', activeCount() === 1 && d0 > 200, `${activeCount()} active, ${d0.toFixed(0)} m away`);
  check('patrol car has the light bar', cars[0].object.getObjectByName('police-lightbar')?.visible === true);
  const step = (s: number): void => {
    for (let i = 0; i < Math.round(s / FIXED_DT); i++) {
      ps.fixedUpdate(FIXED_DT, player, signals, []);
      physics.step();
      for (const c of cars) if (c.isActive) c.afterStep();
    }
  };
  check('an offence nobody saw is ignored', !ps.offence('redLight', player) && ps.wanted.stars === 0);
  // Bring the patrol car close (as if it drove up) and commit offences in front of it.
  ps.units[0].place(k0 + 20, 1, 5.25);
  check('a witnessed offence counts', ps.offence('hitTraffic', player) && ps.wanted.stars === 1);
  ps.offence('hitPolice', player);
  ps.offence('hitPolice', player);
  step(0.2);
  check('2 stars → 2 units', ps.wanted.stars === 2 && activeCount() === 2, `${ps.wanted.stars}★, ${activeCount()} active`);
  // Red-light detection: signal 0 red, drive the player across its stop line.
  const w2 = ps.wanted.heat;
  signals.setPhase(0, 3);
  const red = signals.car(0) === 'red';
  if (red) {
    const c = CROSSINGS[0];
    for (let i = c - 8; i <= c; i++) {
      player.idx = i;
      player.x = track.px[i] + track.rx(i) * 1.75;
      player.z = track.pz[i] + track.rz(i) * 1.75;
      player.vx = track.tx[i] * 12;
      player.vz = track.tz[i] * 12;
      player.speed = 12;
      ps.units[0].place(i + 15, 1, 5.25);
      ps.fixedUpdate(FIXED_DT, player, signals, []);
    }
  }
  check('running a red light in front of a unit is detected', red && ps.wanted.heat === w2 + 1, red ? `heat ${w2} → ${ps.wanted.heat}` : 'could not force the signal red');
  // Escape far away while a unit has to turn round: recovering the stuck unit must not teleport it
  // towards the player (it used to respawn 170 m behind the player and re-spot them at once).
  {
    const far = (k0 + 490) % track.count;
    Object.assign(player, { x: track.px[far] + track.rx(far) * 5.25, z: track.pz[far] + track.rz(far) * 5.25, vx: 0, vz: 0, speed: 0, idx: far });
    ps.units[0].place(k0 + 9, 1, 5.25);
    ps.units[1].place(k0 + 2, 1, 1.75);
    const rec0 = ps.recoveries;
    let prev = ps.nearestUnit(player.x, player.z);
    let maxJump = 0;
    let minDist = prev;
    let escaped = false;
    for (let i = 0; i < Math.round(30 / FIXED_DT) && !escaped; i++) {
      // Headless has no buildings to get stuck on: report the units stuck every 3 s instead.
      if (i % Math.round(3 / FIXED_DT) === 0) for (const u of ps.units) u.needsRespawn = true;
      ps.fixedUpdate(FIXED_DT, player, signals, []);
      physics.step();
      for (const c of cars) if (c.isActive) c.afterStep();
      const d = ps.nearestUnit(player.x, player.z);
      if (Number.isFinite(d) && Number.isFinite(prev)) maxJump = Math.max(maxJump, prev - d);
      minDist = Math.min(minDist, d);
      prev = d;
      escaped = ps.wanted.state === 'clear';
    }
    check('far away and out of sight: the search runs out → escaped', escaped, `state ${ps.wanted.state}, closest unit ${minDist.toFixed(0)} m`);
    check('stuck chasers recover in place (lane re-centre only): no unit gains ground on the player', maxJump < 10, `largest one-step approach ${maxJump.toFixed(2)} m, ${ps.recoveries - rec0} in-place recoveries`);
  }
  ps.setEnabled(false, null);
  check('leaving free roam parks every unit and clears the wanted level', activeCount() === 0 && ps.wanted.stars === 0 && !cars.some((c) => c.isActive));
}

console.log('\n--- line of sight, search, roadblock, officers on foot');
{
  // Pure state machine: the sight override and the held arrest.
  const w = new WantedSystem();
  w.offence('redLight', 50);
  for (let i = 0; i < 30; i++) w.update(FIXED_DT, { nearestUnit: 60, playerSpeed: 20, seen: false });
  check('within range but out of view (seen = false) → search', w.state === 'search');
  for (let i = 0; i < 30; i++) w.update(FIXED_DT, { nearestUnit: 60, playerSpeed: 20, seen: true });
  check('back in view → pursuit', w.state === 'pursuit');
  const w2 = new WantedSystem();
  w2.autoRelease = false;
  w2.offence('redLight', 30);
  run(w2, BUST_TIME + 0.1, 4, 0);
  run(w2, BUSTED_HOLD + 5, 4, 0);
  check('autoRelease off: the busted state holds until released (no auto reset mid-arrest)', w2.state === 'busted');
  check('offences are ignored while held', !w2.offence('hitPolice', 1) && w2.state === 'busted');
  w2.release();
  check('release() clears the record', w2.state === 'clear' && w2.stars === 0);
}
{
  const cars = [0, 1, 2, 3].map((k) => new Vehicle(physics, scene, new Vector3(0, -60 - k * 6, 0), 0));
  cars.forEach((c) => c.setActive(false));
  const ps = new PoliceSystem(track, cars);
  const officers = new Officers(physics, null, null);
  ps.officers = officers;
  const signals = new TrafficSignals(CROSSINGS.length);
  const at = (i: number, lane: number) => ({ x: track.px[wrap(i)] + track.rx(wrap(i)) * lane, z: track.pz[wrap(i)] + track.rz(wrap(i)) * lane });
  const k0 = 200;
  const player: PlayerState = { inCar: true, ...at(k0, 1.75), vx: track.tx[k0] * 20, vz: track.tz[k0] * 20, speed: 20, idx: k0 };
  ps.setEnabled(true, player);
  const step = (s: number, each?: () => void): void => {
    for (let i = 0; i < Math.round(s / FIXED_DT); i++) {
      each?.();
      ps.fixedUpdate(FIXED_DT, player, signals, []);
      physics.step();
      for (const c of cars) if (c.isActive) c.afterStep();
    }
  };
  check('a 4th pooled car is the roadblock unit (not used for chasing)', ps.units.length === 4 && !ps.isActive(BLOCK_UNIT));

  // Sight: a wall between the unit and the player turns the pursuit into a search although the unit is in range.
  ps.units[0].place(k0 + 12, 1, 5.25);
  ps.offence('hitPolice', player);
  let wall = true;
  ps.sight = () => !wall;
  step(0.5);
  check('a unit 50 m away behind a building does not see the player → search', ps.wanted.state === 'search' && !ps.seen, `state ${ps.wanted.state}, seen ${ps.seen}`);
  wall = false;
  step(0.5);
  check('clear view → pursuit again', ps.wanted.state === 'pursuit' && ps.seen);

  // Last known position: the player slips out of view and moves on; the unit goes where they were last seen.
  const lkFrom = { x: player.x, z: player.z };
  ps.units[0].place(k0 - 40, 1, 1.75);
  wall = true;
  const far = wrap(k0 + 160);
  Object.assign(player, at(far, 1.75), { vx: 0, vz: 0, speed: 0, idx: far });
  let minLk = Infinity;
  let lkMoved = 0;
  step(9, () => {
    const q = cars[0].physicsPosition;
    minLk = Math.min(minLk, Math.hypot(q.x - lkFrom.x, q.z - lkFrom.z));
    lkMoved = Math.max(lkMoved, Math.hypot(ps.lastKnown.x - lkFrom.x, ps.lastKnown.z - lkFrom.z));
  });
  const q0 = cars[0].physicsPosition;
  check('searching: the last known position stays where the player was last seen', lkMoved < 0.01, `moved ${lkMoved.toFixed(2)} m`);
  check('searching: the unit drives to the last known position, not to the hidden player', minLk < 25 && Math.hypot(q0.x - player.x, q0.z - player.z) > 100, `closest to last seen ${minLk.toFixed(0)} m, to the player ${Math.hypot(q0.x - player.x, q0.z - player.z).toFixed(0)} m`);
  step(2);
  check('unseen for the search time → escaped', ps.wanted.state === 'clear');

  // Roadblock: 2 stars in a car chase → the 4th unit is set up ahead, out of sight, across the road.
  wall = false;
  ps.sight = null;
  Object.assign(player, at(k0, 1.75), { vx: track.tx[k0] * 20, vz: track.tz[k0] * 20, speed: 20, idx: k0 });
  ps.units[0].place(k0 - 8, 1, 5.25);
  for (let i = 0; i < 3; i++) ps.offence('hitPolice', player);
  let placedAt = -1;
  step(25, () => {
    if (placedAt < 0 && ps.roadblockUp) placedAt = 1;
  });
  const bq = cars[BLOCK_UNIT].physicsPosition;
  const bd = Math.hypot(bq.x - player.x, bq.z - player.z);
  const br = cars[BLOCK_UNIT].physics.body.rotation();
  const bfx = 1 - 2 * (br.y * br.y + br.z * br.z);
  const bfz = 2 * (br.x * br.z - br.w * br.y);
  const bi = track.trackIndex(bq.x, bq.z, k0);
  const across = Math.abs(bfx * track.tx[bi] + bfz * track.tz[bi]) / (Math.hypot(bfx, bfz) || 1);
  const ahead = (bq.x - player.x) * track.tx[k0] + (bq.z - player.z) * track.tz[k0];
  check('2★ car chase: a roadblock is set up', ps.roadblockUp && ps.roadblocks === 1, `${ps.wanted.stars}★, ${ps.roadblocks} roadblocks`);
  check('the roadblock is out of sight when it appears (beyond sight range, no LOS function headless)', bd > PoliceSystem.SIGHT, `${bd.toFixed(0)} m away`);
  check('the roadblock is ahead of the player, parked across the lanes', ahead > 0 && across < 0.2, `ahead ${ahead.toFixed(0)} m, |cos| to the road ${across.toFixed(2)}`);
  check('an officer stands guard at the roadblock', officers.countFor(BLOCK_UNIT) === 1 && officers.list.some((o) => o.unit === BLOCK_UNIT && o.mode === 'guard'));
  const bqStart = { x: bq.x, z: bq.z };
  step(3);
  check('the roadblock car stays put (held)', Math.hypot(cars[BLOCK_UNIT].physicsPosition.x - bqStart.x, cars[BLOCK_UNIT].physicsPosition.z - bqStart.z) < 0.5);
  check('only one roadblock at a time', ps.roadblocks === 1);
  // The player gets past it: cleared once well behind them.
  const past = wrap(bi + Math.round(200 / track.spacing));
  Object.assign(player, at(past, 1.75), { idx: past });
  step(22);
  check('passed and far behind → the roadblock is cleared and its officer back in the car', !ps.roadblockUp && officers.countFor(BLOCK_UNIT) === 0, `up ${ps.roadblockUp}, officers ${officers.countFor(BLOCK_UNIT)}`);

  // Officers on foot: a unit stopped near a player on foot lets officers out; they close in and make the arrest.
  ps.setEnabled(false, null);
  const k1 = 400;
  Object.assign(player, at(k1, 9.5), { inCar: false, vx: 0, vz: 0, speed: 0, idx: k1 });
  ps.setEnabled(true, player);
  ps.wanted.autoRelease = false;
  ps.units[0].place(k1 - 6, 1, 5.25);
  ps.offence('hitPolice', player);
  let deployedAt = -1;
  let minOff = Infinity;
  let t = 0;
  step(14, () => {
    t += FIXED_DT;
    if (deployedAt < 0 && officers.outCount > 0) deployedAt = t;
    minOff = Math.min(minOff, officers.nearest(player.x, player.z));
  });
  check('a unit stopped near a player on foot lets an officer out', deployedAt > 0, `after ${deployedAt.toFixed(1)} s`);
  check('the officer runs up and stops at arm\'s length (no walking through the player)', minOff < 2.4 && minOff > 0.9, `closest ${minOff.toFixed(2)} m`);
  check('held by an officer on foot → busted', ps.wanted.state === 'busted');
  const unitPos = { x: cars[0].physicsPosition.x, z: cars[0].physicsPosition.z };
  check('the unit waits while its officers are out', Math.hypot(unitPos.x - cars[0].physicsPosition.x, unitPos.z - cars[0].physicsPosition.z) < 0.5);
  step(2);
  check('busted holds (arrest sequence decides), officers stay with the player', ps.wanted.state === 'busted' && officers.outCount > 0);
  ps.wanted.release();
  step(14);
  check('pursuit over → officers walk back and get in', officers.outCount === 0, `${officers.outCount} still out`);

  // Shot officer: knocked down (stylised), offence reported, gets up.
  ps.units[0].place(k1 - 6, 1, 5.25);
  ps.offence('hitPolice', player);
  ps.wanted.autoRelease = true;
  step(4);
  const o = officers.list.find((x) => x.mode === 'chase');
  if (o) {
    const heat = ps.wanted.heat;
    officers.hit(o.id);
    step(0.1);
    check('a shot officer goes down and the police count it (shootPolice)', o.mode === 'down' && ps.wanted.heat === heat + 4, `mode ${o.mode}, heat ${heat} → ${ps.wanted.heat}`);
    check('a downed officer has no collider in the world', !o.ctrl.isEnabled);
    step(5.5);
    check('…and gets up again', o.mode !== 'down' && o.mode !== 'off' ? o.ctrl.isEnabled : true, `mode ${o.mode}`);
  } else check('an officer was out to shoot at', false);
  ps.setEnabled(false, null);
  check('police off → every officer removed', officers.outCount === 0 && officers.list.every((x) => !x.ctrl.isEnabled));
  officers.dispose();
}

console.log(failures === 0 ? '\nALL POLICE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
