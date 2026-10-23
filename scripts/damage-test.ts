/**
 * Headless damage test with real physics: wall crashes at several speeds, rear and side hits,
 * harmless bumps and landings, power loss, repair. Usage: npm run test:damage
 */
declare const process: { exit(code: number): never };
import { Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { VehiclePhysics } from '../src/game/VehiclePhysics';
import { DAMAGE_THRESHOLD, HitAccumulator, applyHit, createDamage, damageEffects, damageLevel, isDamaged, repairCost, repairDamage, type DamageState } from '../src/game/damage/DamageModel';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const physics = await PhysicsWorld.create();
physics.addGround(700);
const car = new VehiclePhysics(physics, new Vector3(0, 0, 0), 0);
const input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let dmg: DamageState = createDamage();
const acc = new HitAccumulator();
let maxDv = 0;
function step(): void {
  car.prePhysicsStep(FIXED_DT, input);
  physics.step();
  // Same consumption as the game: read the strongest hit since the last step, merge, apply.
  if (car.hitDv > 0) {
    maxDv = Math.max(maxDv, car.hitDv);
    acc.add(car.hitDv, car.hitFwd, car.hitRight);
    car.hitDv = 0;
  }
  const h = acc.tick(FIXED_DT);
  if (h) applyHit(dmg, h.dv, h.hitFwd, h.hitRight);
}
const run = (s: number, until?: () => boolean): void => {
  for (let i = 0; i < Math.round(s / FIXED_DT); i++) {
    step();
    if (until?.()) return;
  }
};
const fmt = (d: DamageState): string => `F ${d.zones.front.toFixed(2)} R ${d.zones.rear.toFixed(2)} L ${d.zones.left.toFixed(2)} Rt ${d.zones.right.toFixed(2)} lamps ${Object.entries(d.lamps).filter(([, v]) => v).map(([k]) => k).join('+') || '-'}`;

let lane = -600;
/**
 * Hold `kmh` (simple cruise control; reverse = drive backwards via the brake pedal at standstill)
 * until the car hits something, then let it settle.
 */
function cruiseInto(kmh: number, reverse = false): void {
  let hit = false;
  for (let i = 0; i < Math.round(20 / FIXED_DT) && !hit; i++) {
    const v = (reverse ? -car.forwardSpeed : car.forwardSpeed) * 3.6;
    const u = Math.max(0, Math.min(1, (kmh - v) * 0.4 + 0.15));
    if (reverse) input.brake = v < 0.5 || u > 0.15 ? u : 0;
    else input.throttle = u;
    step();
    hit = maxDv > 0;
  }
  Object.assign(input, { throttle: 0, brake: 0 });
  run(3);
}
/** Drive into a wall at `kmh` (forwards, or backwards with reverse = true). */
function wallCrash(kmh: number, reverse = false): { d: DamageState; dv: number } {
  lane += 40;
  const z = lane;
  physics.addStaticBox(reverse ? -40 : 40, 1.2, z, 0.5, 1.2, 8);
  car.reset(new Vector3(reverse ? 60 : -60, 0, z), 0);
  dmg = createDamage();
  acc.clear();
  maxDv = 0;
  Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  run(1);
  cruiseInto(kmh, reverse);
  return { d: dmg, dv: maxDv };
}

const slow = wallCrash(8);
check('8 km/h into a wall: no damage (below the threshold)', !isDamaged(slow.d), `dv ${slow.dv.toFixed(1)} m/s — ${fmt(slow.d)}`);
const mid = wallCrash(28);
check('28 km/h into a wall: front dented, nothing else', mid.d.zones.front > 0.1 && mid.d.zones.front < 0.6 && mid.d.zones.rear === 0, `dv ${mid.dv.toFixed(1)} — ${fmt(mid.d)}`);
const hard = wallCrash(55);
check('55 km/h into a wall: heavy front damage and broken headlights', hard.d.zones.front > mid.d.zones.front + 0.2 && hard.d.lamps.headL && hard.d.lamps.headR && !hard.d.lamps.tailL, `dv ${hard.dv.toFixed(1)} — ${fmt(hard.d)}`);
const wreck = wallCrash(90);
const fx = damageEffects(wreck.d);
check('90 km/h into a wall: nose crushed, engine smokes and loses power', wreck.d.zones.front >= 0.95 && fx.smoke > 0.5 && fx.powerScale < 0.8, `dv ${wreck.dv.toFixed(1)} — ${fmt(wreck.d)}, power ×${fx.powerScale.toFixed(2)}, smoke ${fx.smoke.toFixed(2)}`);
check('damage grows with impact speed', damageLevel(slow.d) < damageLevel(mid.d) && damageLevel(mid.d) < damageLevel(hard.d) && damageLevel(hard.d) < damageLevel(wreck.d), [slow, mid, hard, wreck].map((x) => damageLevel(x.d).toFixed(2)).join(' < '));
const rear = wallCrash(22, true);
check('reversing into a wall damages the rear, not the front', rear.d.zones.rear > 0.05 && rear.d.zones.front === 0 && !rear.d.lamps.headL, `dv ${rear.dv.toFixed(1)} — ${fmt(rear.d)}`);

// Side impact: a heavy block slams into the right side of a parked car.
lane += 40;
car.reset(new Vector3(0, 0, lane), 0);
dmg = createDamage();
acc.clear();
maxDv = 0;
Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
run(1);
{
  const R = physics.R;
  const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.8, lane + 6).setLinvel(0, 0, -11));
  physics.world.createCollider(R.ColliderDesc.cuboid(1.2, 0.6, 1.0).setDensity(900).setFriction(0.3), body);
}
run(3);
check('side impact damages the struck side only', dmg.zones.right > 0.1 && dmg.zones.left === 0 && dmg.zones.right > dmg.zones.front, `dv ${maxDv.toFixed(1)} — ${fmt(dmg)}`);

// Many small bumps: no accumulated damage.
{
  lane += 40;
  const z = lane;
  physics.addStaticBox(40, 1.2, z, 0.5, 1.2, 8);
  dmg = createDamage();
  maxDv = 0;
  for (let k = 0; k < 20; k++) {
    car.reset(new Vector3(30, 0, z), 0);
    acc.clear();
    Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    run(0.5);
    const before = maxDv;
    maxDv = 0;
    cruiseInto(7);
    maxDv = Math.max(before, maxDv);
  }
  check('20 gentle nudges (≤ 7 km/h) cause no damage at all', !isDamaged(dmg), `max dv ${maxDv.toFixed(1)} m/s (threshold ${DAMAGE_THRESHOLD})`);
}

// Landing from a drop is not a crash.
lane += 40;
car.reset(new Vector3(0, 1.5, lane), 0);
dmg = createDamage();
acc.clear();
Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
run(3);
check('dropping 1.5 m onto the wheels causes no damage', !isDamaged(dmg), fmt(dmg));

// Power loss is real: 0-60 with a wrecked engine vs healthy.
function zeroTo60(scale: number): number {
  lane += 40;
  car.reset(new Vector3(-300, 0, lane), 0);
  car.drivetrain.powerScale = scale;
  Object.assign(input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  run(1);
  input.throttle = 1;
  let t = 0;
  run(15, () => {
    t += FIXED_DT;
    return car.forwardSpeed * 3.6 >= 60;
  });
  input.throttle = 0;
  return t;
}
const tHealthy = zeroTo60(1);
const tWreck = zeroTo60(fx.powerScale);
car.drivetrain.powerScale = 1;
check('a wrecked engine is measurably slower (0-60 km/h)', tWreck > tHealthy * 1.08, `${tHealthy.toFixed(2)} s → ${tWreck.toFixed(2)} s`);

// Repair and pricing
const c1 = repairCost(mid.d);
const c2 = repairCost(wreck.d);
check('repair price scales with the damage', c1 > 0 && c2 > c1 && repairCost(createDamage()) === 0, `${c1} cr / ${c2} cr`);
repairDamage(wreck.d);
check('repair restores the car completely', !isDamaged(wreck.d) && damageEffects(wreck.d).powerScale === 1);

// Mechanical damage: alignment pull, steering lock, drag (top speed)
{
  const fx0 = damageEffects(createDamage());
  check('pristine car: no alignment pull, full steering lock, normal drag', fx0.steerPull === 0 && fx0.steerLockScale === 1 && fx0.dragScale === 1);
  const left = createDamage();
  for (let k = 0; k < 4; k++) applyHit(left, 12, 0, -1);
  const right = createDamage();
  for (let k = 0; k < 4; k++) applyHit(right, 12, 0, 1);
  const nose = createDamage();
  for (let k = 0; k < 4; k++) applyHit(nose, 14, 1, 0);
  check('a hit on the left bends the alignment to the left, a hit on the right to the right', damageEffects(left).steerPull > 0.004 && damageEffects(right).steerPull < -0.004, `${damageEffects(left).steerPull.toFixed(4)} / ${damageEffects(right).steerPull.toFixed(4)} rad (${fmt(left)})`);
  check('a crushed nose limits the steering lock and adds drag', damageEffects(nose).steerLockScale < 0.85 && damageEffects(nose).dragScale > 1.15, `lock × ${damageEffects(nose).steerLockScale.toFixed(2)}, drag × ${damageEffects(nose).dragScale.toFixed(2)} (${fmt(nose)})`);

  let z = 400;
  const fresh = (d: DamageState): VehiclePhysics => {
    const fx = damageEffects(d);
    const c = new VehiclePhysics(physics, new Vector3(-650, 0, (z += 40)), 0);
    c.drivetrain.powerScale = fx.powerScale;
    c.damageSteerOffset = fx.steerPull;
    c.damageLockScale = fx.steerLockScale;
    c.damageDragScale = fx.dragScale;
    return c;
  };
  const drive = (c: VehiclePhysics, secs: number, inp: (c: VehiclePhysics) => DriverInput): void => {
    for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
      c.prePhysicsStep(FIXED_DT, inp(c));
      physics.step();
    }
  };
  const cruise = (kmh: number, steer = 0) => (c: VehiclePhysics): DriverInput => ({ throttle: Math.max(0, Math.min(1, (kmh - c.forwardSpeed * 3.6) * 0.4 + 0.15)), brake: 0, steer, handbrake: false });
  // Hands off at 100 km/h: heading change (left-positive) over 6 s.
  const heading = (c: VehiclePhysics): number => {
    const v = c.body.linvel();
    return Math.atan2(-v.z, v.x);
  };
  const handsOff = (d: DamageState): number => {
    const c = fresh(d);
    drive(c, 6, cruise(100));
    const h0 = heading(c);
    drive(c, 3, cruise(100));
    return ((heading(c) - h0) * 180) / Math.PI;
  };
  const hStraight = handsOff(createDamage());
  const hLeft = handsOff(left);
  const hRight = handsOff(right);
  check('hands off at 100 km/h: a straight car stays straight, a bent one pulls to the damaged side', Math.abs(hStraight) < 1 && hLeft > 3 && hRight < -3, `heading change in 3 s: ${hStraight.toFixed(1)}° / left-damaged ${hLeft.toFixed(1)}° / right-damaged ${hRight.toFixed(1)}°`);
  // Full lock at 30 km/h: yaw rate.
  const lockYaw = (d: DamageState): number => {
    const c = fresh(d);
    drive(c, 3, cruise(30));
    drive(c, 2.5, cruise(30, 1));
    return Math.abs(c.body.angvel().y);
  };
  const y0 = lockYaw(createDamage());
  const y1 = lockYaw(nose);
  check('crushed nose: full lock turns the car less sharply', y1 < y0 * 0.88, `yaw rate at full lock, 30 km/h: ${y0.toFixed(2)} → ${y1.toFixed(2)} rad/s`);
  // Flat out for 14 s from rest.
  const flatOut = (d: DamageState): number => {
    const c = fresh(d);
    drive(c, 14, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: false }));
    return c.forwardSpeed * 3.6;
  };
  const v0 = flatOut(createDamage());
  const v1 = flatOut(nose);
  check('crushed nose: lower speed flat out (power + drag)', v1 < v0 * 0.92, `after 14 s: ${v0.toFixed(0)} → ${v1.toFixed(0)} km/h`);
}

// Pure-model edge cases
const e = createDamage();
check('garbage input (NaN / negative) is ignored', applyHit(e, Number.NaN, 1, 0) === null && applyHit(e, -5, 1, 0) === null && !isDamaged(e));
for (let k = 0; k < 50; k++) applyHit(e, 40, 1, 0.3);
check('zones never exceed 100 %', Object.values(e.zones).every((v) => v <= 1), fmt(e));

console.log(failures === 0 ? '\nALL DAMAGE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
