/**
 * Garage setup: every adjustment has a measured effect on the car (headless, fixed step).
 *   npx tsx scripts/setup-test.ts            → checks
 *   npx tsx scripts/setup-test.ts --print    → also prints the measurements
 */
declare const process: { exit(code: number): never; argv: string[] };
import { Euler, Quaternion, Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { VehiclePhysics } from '../src/game/VehiclePhysics';
import { SETUP_INFO, neutralSetup, sanitizeSetup, tuningFor, vehicleById, type CarSetup } from '../src/game/vehicles/VehicleCatalog';
import { sanitizeProgress } from '../src/game/missions/Progress';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const PRINT = process.argv.includes('--print');

const physics = await PhysicsWorld.create();
physics.addGround(1600);
let slot = 0;
const DEF = vehicleById('kestrel');

function makeCar(setup: Partial<CarSetup>): VehiclePhysics {
  const z = -1500 + slot++ * 60;
  const car = new VehiclePhysics(physics, new Vector3(-1400, 0, z), 0);
  const t = tuningFor(DEF, undefined, { ...neutralSetup(), ...setup });
  car.applyTuning(t.car, t.engine);
  car.reset(new Vector3(-1400, t.car.rideHeight, z), 0);
  for (let i = 0; i < 90; i++) step(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  return car;
}
function step(car: VehiclePhysics, inp: DriverInput): void {
  car.prePhysicsStep(FIXED_DT, inp);
  physics.step();
}
const q = new Quaternion();
const eu = new Euler();
function angles(car: VehiclePhysics): { roll: number; pitch: number } {
  const r = car.body.rotation();
  q.set(r.x, r.y, r.z, r.w);
  eu.setFromQuaternion(q, 'YXZ');
  return { roll: (eu.x * 180) / Math.PI, pitch: (eu.z * 180) / Math.PI };
}
function hold(car: VehiclePhysics, v: number, steer: number): DriverInput {
  const err = v - car.forwardSpeed;
  return { throttle: Math.max(0, Math.min(1, err * 0.6 + 0.25)), brake: err < -1.5 ? Math.min(1, -err * 0.2) : 0, steer, handbrake: false };
}
function accelTo(car: VehiclePhysics, v: number, maxT = 30): number {
  let t = 0;
  while (car.forwardSpeed < v && t < maxT) {
    step(car, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    t += FIXED_DT;
  }
  return t;
}

/** Steady cornering at 60 km/h with a fixed steer: lateral g and roll. */
function corner(setup: Partial<CarSetup>, steer: number): { g: number; roll: number } {
  const car = makeCar(setup);
  accelTo(car, 60 / 3.6);
  for (let i = 0; i < 60; i++) step(car, hold(car, 60 / 3.6, 0));
  const rest = angles(car).roll;
  for (let i = 0; i < 60 * 4; i++) step(car, hold(car, 60 / 3.6, steer));
  let g = 0;
  let roll = 0;
  for (let i = 0; i < 60; i++) {
    step(car, hold(car, 60 / 3.6, steer));
    g += Math.abs(car.yawRate * car.forwardSpeed) / 9.81 / 60;
    roll += Math.abs(angles(car).roll - rest) / 60;
  }
  return { g, roll };
}
/** Max lateral g at 60 km/h: slow steering ramp, best 0.5 s average. */
function maxLat(setup: Partial<CarSetup>): number {
  const car = makeCar(setup);
  const v = 60 / 3.6;
  accelTo(car, v);
  for (let i = 0; i < 60; i++) step(car, hold(car, v, 0));
  let best = 0;
  const win: number[] = [];
  for (let k = 0; k < 60 * 12; k++) {
    step(car, hold(car, v, Math.min(1, k / 600)));
    win.push(Math.abs(car.yawRate * car.forwardSpeed) / 9.81);
    if (win.length > 30) win.shift();
    if (Math.atan2(Math.abs(car.rearSlip), Math.abs(car.forwardSpeed)) > 0.25 || car.forwardSpeed < v * 0.8) break;
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (win.length === 30) best = Math.max(best, avg);
  }
  return best;
}
/** Coast from 40 km/h for 5 s: speed lost (rolling resistance + drag). */
function coast(setup: Partial<CarSetup>): number {
  const car = makeCar(setup);
  accelTo(car, 40 / 3.6);
  const v0 = car.forwardSpeed;
  for (let i = 0; i < 300; i++) step(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  return (v0 - car.forwardSpeed) * 3.6;
}
/** Brake from 100 km/h: distance and peak dive. */
function brake(setup: Partial<CarSetup>): { d: number; dive: number } {
  const car = makeCar(setup);
  const rest = angles(car).pitch;
  accelTo(car, 100 / 3.6);
  for (let i = 0; i < 30; i++) step(car, hold(car, 100 / 3.6, 0));
  let d = 0;
  let dive = 0;
  while (car.forwardSpeed > 0.3) {
    const a = car.body.translation();
    step(car, { throttle: 0, brake: 1, steer: 0, handbrake: false });
    const b = car.body.translation();
    d += Math.hypot(b.x - a.x, b.z - a.z);
    dive = Math.max(dive, rest - angles(car).pitch);
  }
  return { d, dive };
}
/** Trail-braking into a 0.6 g bend at 100 km/h: extra yaw rate from the brakes (rotation). */
function trail(setup: Partial<CarSetup>): number {
  const car = makeCar(setup);
  accelTo(car, 100 / 3.6);
  for (let i = 0; i < 60; i++) step(car, hold(car, 100 / 3.6, 0));
  for (let i = 0; i < 150; i++) step(car, hold(car, 100 / 3.6, 0.35));
  const y0 = Math.abs(car.yawRate);
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    step(car, { throttle: 0, brake: 0.7, steer: 0.35, handbrake: false });
    peak = Math.max(peak, Math.abs(car.yawRate) - y0);
  }
  return peak;
}

const log = (k: string, v: unknown): void => {
  if (PRINT) console.log(`  ${k}: ${JSON.stringify(v)}`);
};
const f2 = (n: number): string => n.toFixed(2);
const f3 = (n: number): string => n.toFixed(3);

// Sanity of the model itself.
check('factory setup changes nothing', JSON.stringify(tuningFor(DEF)) === JSON.stringify(tuningFor(DEF, undefined, neutralSetup())));
check('setup values are clamped and garbage is dropped', JSON.stringify(sanitizeSetup({ tyrePressure: 9, gearing: -7.6, springs: 'x', brakeBias: Number.NaN })) === JSON.stringify({ tyrePressure: 2, springs: 0, brakeBias: 0 }));
const old = sanitizeProgress({ campaign: 2, unlocked: 3, owned: ['kestrel'], car: 'kestrel', cars: { kestrel: { paint: 'red', upgrades: {} } } });
check('an old save without a setup loads with the factory setup', JSON.stringify(old.cars.kestrel?.setup) === JSON.stringify(neutralSetup()));
check('every setting describes its value', SETUP_INFO.tyrePressure.value(-2, DEF) === '1.90 bar' && SETUP_INFO.tyrePressure.value(2, DEF) === '2.50 bar' && /% front/.test(SETUP_INFO.brakeBias.value(0, DEF)));

// Tyre pressure.
{
  const gLo = maxLat({ tyrePressure: -2 });
  const g0 = maxLat({});
  const gHi = maxLat({ tyrePressure: 2 });
  const cLo = coast({ tyrePressure: -2 });
  const cHi = coast({ tyrePressure: 2 });
  log('tyre pressure max lat g (low / 0 / high)', [f3(gLo), f3(g0), f3(gHi)]);
  log('tyre pressure coast loss km/h', [f2(cLo), f2(cHi)]);
  check('low tyre pressure: more grip than high', gLo > g0 && g0 > gHi, `${f3(gLo)} / ${f3(g0)} / ${f3(gHi)} g`);
  check('low tyre pressure: more rolling drag (coasting loses more speed)', cLo > cHi, `40 km/h coast 5 s: −${f2(cLo)} vs −${f2(cHi)} km/h`);
}

// Springs.
{
  const soft = corner({ springs: -2 }, 0.25);
  const mid = corner({}, 0.25);
  const stiff = corner({ springs: 2 }, 0.25);
  const bs = brake({ springs: -2 });
  const bh = brake({ springs: 2 });
  log('springs roll deg (soft / 0 / stiff) at g', [soft, mid, stiff]);
  log('springs dive', [bs, bh]);
  check('stiff springs: less body roll than soft', soft.roll / soft.g > (mid.roll / mid.g) * 1.1 && stiff.roll / stiff.g < (mid.roll / mid.g) * 0.92, `${f2(soft.roll / soft.g)} / ${f2(mid.roll / mid.g)} / ${f2(stiff.roll / stiff.g)} °/g`);
  check('stiff springs: less brake dive than soft', bh.dive < bs.dive * 0.9, `${f2(bs.dive)}° → ${f2(bh.dive)}°`);
}

// Brake bias.
{
  const rear = trail({ brakeBias: -2 });
  const mid = trail({});
  const front = trail({ brakeBias: 2 });
  const dr = brake({ brakeBias: -2 });
  const dm = brake({});
  const df = brake({ brakeBias: 2 });
  log('brake bias trail-brake yaw (rear / 0 / front)', [f3(rear), f3(mid), f3(front)]);
  log('brake bias distance', [f2(dr.d), f2(dm.d), f2(df.d)]);
  // Braking is limited by each tyre's grip (Stage 3): extra rear bias saturates the light rear tyres, so it
  // rotates the car a little more but costs stopping distance; front bias barely changes the stop.
  check('rear brake bias: the car rotates more under trail braking than front bias', rear > front * 1.1, `${f3(rear)} / ${f3(mid)} / ${f3(front)} rad/s extra yaw`);
  check('rear brake bias: rear tyres saturate, so straight stops get longer', dr.d > dm.d * 1.05 && Math.abs(df.d - dm.d) < dm.d * 0.05, `100–0: ${f2(dr.d)} / ${f2(dm.d)} / ${f2(df.d)} m`);
  check('brake bias keeps straight-line stops in a sane range', Math.max(dr.d, dm.d, df.d) < dm.d * 1.15, `100–0: ${f2(dr.d)} / ${f2(dm.d)} / ${f2(df.d)} m`);
}

console.log(failures === 0 ? '\nALL SETUP CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
