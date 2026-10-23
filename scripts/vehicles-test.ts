/**
 * Headless vehicle handling test: every garage car is driven through the same manoeuvres in real
 * Rapier physics to prove they handle measurably differently, upgrades work, and the starter car
 * is exactly the original tuning. Usage: npm run test:vehicles
 */
declare const process: { exit(code: number): never };
import { Vector3 } from 'three';
import { CAR, ENGINE, FIXED_DT } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { VehiclePhysics } from '../src/game/VehiclePhysics';
import { VEHICLES, noUpgrades, rideHeightOf, tuningFor, vehicleById, vehicleStats, type UpgradeLevels } from '../src/game/vehicles/VehicleCatalog';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures++;
}

const physics = await PhysicsWorld.create();
physics.addGround(4000);
const car = new VehiclePhysics(physics, new Vector3(0, 0, 0), 0);
const input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const set = (t = 0, b = 0, s = 0): void => { input.throttle = t; input.brake = b; input.steer = s; input.handbrake = false; };
function run(seconds: number, each?: () => boolean | void): number {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.prePhysicsStep(FIXED_DT, input);
    physics.step();
    if (each && each() === true) return (i + 1) * FIXED_DT;
  }
  return seconds;
}
const upY = (): number => { const r = car.body.rotation(); return 1 - 2 * (r.x * r.x + r.z * r.z); };

interface Result { t100: number; v30: number; brake: number; lat: number; slide: number; minUp: number; roll: number; ride: number }
/** Body roll (rad) from the chassis right axis tilting out of the horizontal. */
const rollOf = (): number => { const r = car.body.rotation(); return Math.asin(Math.max(-1, Math.min(1, 2 * (r.y * r.z + r.w * r.x)))); };
function measure(id: string, up: UpgradeLevels = noUpgrades()): Result {
  const t = tuningFor(vehicleById(id), up);
  car.applyTuning(t.car, t.engine);
  // 0-100 and speed after 30 s; the settled ride height first.
  car.reset(new Vector3(-3500, 0, 0), 0);
  set();
  run(1.5);
  const ride = car.body.translation().y;
  set(1);
  let t100 = -1;
  let time = 0;
  run(30, () => { time += FIXED_DT; if (t100 < 0 && car.forwardSpeed * 3.6 >= 100) t100 = time; });
  const v30 = car.forwardSpeed * 3.6;
  // Braking from 100 km/h
  car.reset(new Vector3(-3500, 0, 60), 0);
  set();
  run(1);
  set(1);
  run(20, () => car.forwardSpeed * 3.6 >= 100);
  set(0, 1);
  const x0 = car.body.translation().x;
  run(10, () => car.forwardSpeed < 0.3);
  const brake = car.body.translation().x - x0;
  // Skidpad: hold ~50 km/h with a fixed steering angle, measure steady lateral acceleration (v * yaw rate).
  car.reset(new Vector3(0, 0, 400), 0);
  set();
  run(1);
  let lat = 0;
  let minUp = 1;
  let roll = 0;
  set(1, 0, 0);
  run(15, () => car.forwardSpeed * 3.6 >= 50);
  for (let k = 0; k < 6 * 60; k++) {
    const v = car.forwardSpeed * 3.6;
    set(v < 50 ? 0.6 : 0.05, v > 56 ? 0.3 : 0, 1);
    run(FIXED_DT);
    if (k > 3 * 60) {
      lat = Math.max(lat, Math.abs(car.forwardSpeed * car.yawRate));
      roll = Math.max(roll, Math.abs(rollOf()));
    }
    minUp = Math.min(minUp, upY());
  }
  // Power-on step steer at 70 km/h: how much the tail slides.
  car.reset(new Vector3(0, 0, -400), 0);
  set();
  run(1);
  set(1);
  run(20, () => car.forwardSpeed * 3.6 >= 70);
  let slide = 0;
  set(1, 0, 1);
  run(2.5, () => { slide = Math.max(slide, Math.abs(car.rearSlip)); minUp = Math.min(minUp, upY()); });
  return { t100, v30, brake, lat, slide, minUp, roll, ride };
}

/** Flat out on an 8 km straight until the speed stops rising: the real top speed (km/h). */
function topSpeed(id: string): number {
  const t = tuningFor(vehicleById(id));
  car.applyTuning(t.car, t.engine);
  car.reset(new Vector3(-3950, 0, -1200), 0);
  set();
  run(1);
  set(1);
  const hist: number[] = [];
  let vmax = 0;
  for (let k = 0; k < 160 * 60 && car.body.translation().x < 3950; k++) {
    run(FIXED_DT);
    const v = car.forwardSpeed * 3.6;
    vmax = Math.max(vmax, v);
    if (k % 60 === 0) {
      hist.push(v);
      if (hist.length > 8 && v - hist[hist.length - 9] < 0.8) break;
    }
  }
  return vmax;
}

// The starter car is the original tuning, bit for bit (ride height is derived from wheel radius,
// rest length and spring rate: 0.563 m against the hand-set 0.56 m, which only sets the spawn height).
const kt = tuningFor(vehicleById('kestrel'));
check(
  'starter car (Kestrel GT) uses exactly the original chassis and engine parameters',
  JSON.stringify({ ...kt.car, rideHeight: 0 }) === JSON.stringify({ ...CAR, rideHeight: 0 }) && Math.abs(kt.car.rideHeight - CAR.rideHeight) < 0.005 && JSON.stringify(kt.engine) === JSON.stringify(ENGINE),
  `deep-equal; ride height ${kt.car.rideHeight.toFixed(4)} vs ${CAR.rideHeight}`,
);

const CARS = VEHICLES.filter((v) => v.style !== 'motorcycle');
const R: Record<string, Result> = {};
const VMAX: Record<string, number> = {};
for (const v of CARS) {
  R[v.id] = measure(v.id);
  const r = R[v.id];
  const st = vehicleStats(v);
  VMAX[v.id] = topSpeed(v.id);
  console.log(
    `  ${v.name.padEnd(13)} ${st.drivetrain.padEnd(9)} 0-100 ${r.t100.toFixed(2)} s | 30 s ${r.v30.toFixed(0)} | vmax ${VMAX[v.id].toFixed(0)} km/h | 100-0 ${r.brake.toFixed(1)} m | skidpad ${(r.lat / 9.81).toFixed(2)} g | roll ${((r.roll * 180) / Math.PI).toFixed(2)}° | slide ${r.slide.toFixed(2)} m/s | ride ${r.ride.toFixed(3)} m | stats ${st.powerKw} kW ${st.massKg} kg ~${st.topSpeedKmh} km/h`,
  );
}
const { kestrel: K, pip: P, brute: B, vortex: V } = R;
check('acceleration differs: Vortex quickest, Pip slowest, Brute beats the Kestrel', V.t100 < B.t100 && B.t100 < K.t100 && K.t100 < P.t100, `0-100: V ${V.t100.toFixed(2)} B ${B.t100.toFixed(2)} K ${K.t100.toFixed(2)} P ${P.t100.toFixed(2)} s`);
check('0-100 spread is large (slowest at least 1.6x the quickest)', P.t100 / V.t100 >= 1.6, `${(P.t100 / V.t100).toFixed(2)}x`);
check('speed: Vortex fastest, Pip slowest after 30 s flat out', V.v30 > K.v30 && V.v30 > B.v30 && P.v30 < K.v30 && P.v30 < B.v30, `V ${V.v30.toFixed(0)} B ${B.v30.toFixed(0)} K ${K.v30.toFixed(0)} P ${P.v30.toFixed(0)} km/h`);
check('braking: Vortex stops shortest, heavy Brute longest', V.brake < K.brake && V.brake < P.brake && B.brake > K.brake && B.brake > P.brake, `V ${V.brake.toFixed(1)} K ${K.brake.toFixed(1)} P ${P.brake.toFixed(1)} B ${B.brake.toFixed(1)} m`);
check('cornering grip: Vortex highest, Brute lowest', V.lat > K.lat && V.lat > P.lat && B.lat < K.lat && B.lat < P.lat, `V ${(V.lat / 9.81).toFixed(2)} K ${(K.lat / 9.81).toFixed(2)} P ${(P.lat / 9.81).toFixed(2)} B ${(B.lat / 9.81).toFixed(2)} g`);
check('balance: the Brute slides its tail far more under power than the planted Pip', B.slide > P.slide * 1.5 && B.slide > K.slide, `slide B ${B.slide.toFixed(2)} K ${K.slide.toFixed(2)} P ${P.slide.toFixed(2)} V ${V.slide.toFixed(2)} m/s`);
check('every car stays upright through the handling tests', Object.values(R).every((r) => r.minUp > 0.6), Object.entries(R).map(([k, r]) => `${k} ${r.minUp.toFixed(2)}`).join(', '));
// Displayed stats rank the same way as the measurements.
const st = Object.fromEntries(CARS.map((v) => [v.id, vehicleStats(v)]));
const order = (f: (id: string) => number): string => Object.keys(R).sort((a, b) => f(b) - f(a)).join('>');
{
  const off = CARS.map((v) => [v.id, (st[v.id].topSpeedKmh - VMAX[v.id]) / VMAX[v.id]] as const);
  check('garage top-speed figure within 6% of the measured top speed for every car', off.every(([, e]) => Math.abs(e) <= 0.06), off.map(([id, e]) => `${id} ${(e * 100).toFixed(1)}%`).join(', '));
  const bad: string[] = [];
  for (const a of CARS) for (const b of CARS) {
    if (st[a.id].topSpeedKmh > st[b.id].topSpeedKmh * 1.04 && !(VMAX[a.id] > VMAX[b.id])) bad.push(`${a.id}>${b.id}`);
  }
  check('garage top-speed figures rank like the measured top speeds (where they differ by >4%)', bad.length === 0, bad.join(' ') || order((id) => VMAX[id]));
}
check('garage acceleration figures rank like the measured 0-100 times', order((id) => st[id].accel) === order((id) => -R[id].t100), `${order((id) => st[id].accel)} vs ${order((id) => -R[id].t100)}`);

// ---- Eight genuinely different cars
{
  const ids = CARS.map((v) => v.id);
  const same: string[] = [];
  const diff = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = R[ids[i]];
      const b = R[ids[j]];
      const d = Math.max(diff(a.t100, b.t100), diff(VMAX[ids[i]], VMAX[ids[j]]), diff(a.brake, b.brake), diff(a.lat, b.lat), diff(a.roll, b.roll), diff(a.ride, b.ride));
      if (d < 0.08) same.push(`${ids[i]}~${ids[j]} ${(d * 100).toFixed(1)}%`);
    }
  check(`${ids.length} cars, every pair measurably different (>=8% in at least one measured figure)`, ids.length >= 8 && same.length === 0, same.join(', ') || `${ids.length} cars`);
  const kinds = new Set(VEHICLES.map((v) => v.kind));
  check('vehicle classes: sports coupe, supercar, muscle, sedan, SUV, off-road, hot hatch, race car', ['Sports coupe', 'Supercar', 'Muscle car', 'Sedan', 'SUV', 'Off-roader', 'Hot hatch', 'Race car'].every((k) => kinds.has(k)), [...kinds].join(', '));
  const styles = new Set(VEHICLES.map((v) => v.style));
  check('every car has its own body style and the two bikes share the motorcycle style', styles.size === CARS.length + 1 && VEHICLES.filter((v) => v.style === 'motorcycle').length === 2, [...styles].join(', '));
  const drives = new Set(VEHICLES.map((v) => vehicleStats(v).drivetrain.split(' ')[0]));
  check('front-, rear- and all-wheel-drive cars exist', drives.has('FWD') && drives.has('RWD') && drives.has('AWD'), [...drives].join(', '));
}
// Drivetrain: the engine force reaches the right wheels.
{
  const split = (id: string): [number, number] => {
    const t = tuningFor(vehicleById(id));
    car.applyTuning(t.car, t.engine);
    car.reset(new Vector3(0, 0, 900), 0);
    set();
    run(1);
    set(0.6);
    run(1.2);
    const c = car.controller;
    return [Math.abs(c.wheelEngineForce(0) ?? 0) + Math.abs(c.wheelEngineForce(1) ?? 0), Math.abs(c.wheelEngineForce(2) ?? 0) + Math.abs(c.wheelEngineForce(3) ?? 0)];
  };
  const out: string[] = [];
  let ok = true;
  for (const v of VEHICLES) {
    const [f, r] = split(v.id);
    const want = tuningFor(v).car.driveFront;
    const got = f / Math.max(1e-6, f + r);
    out.push(`${v.id} ${(got * 100).toFixed(0)}% front`);
    if (Math.abs(got - want) > 0.02 || f + r < 100) ok = false;
  }
  check('engine force is split front/rear exactly as each drivetrain says', ok, out.join(', '));
  const fwd = ['pip', 'meridian'];
  const rwd = ['kestrel', 'brute', 'apex'];
  check(
    'front-drive cars do not power-oversteer: their tail slides less than every rear-drive car',
    fwd.every((a) => rwd.every((b) => R[a].slide < R[b].slide * 0.6)),
    `FWD ${fwd.map((a) => R[a].slide.toFixed(2)).join('/')} vs RWD ${rwd.map((b) => R[b].slide.toFixed(2)).join('/')} m/s`,
  );
}
// Class character, measured.
{
  const A = R.apex;
  const others = CARS.filter((v) => v.id !== 'apex').map((v) => R[v.id]);
  check('race car: quickest 0-100, most cornering grip and shortest braking of all', others.every((o) => A.t100 < o.t100 && A.lat > o.lat && A.brake < o.brake), `0-100 ${A.t100.toFixed(2)} s, ${(A.lat / 9.81).toFixed(2)} g, ${A.brake.toFixed(1)} m`);
  const rides = CARS.map((v) => [v.id, R[v.id].ride] as const).sort((a, b) => b[1] - a[1]);
  check('off-roader rides highest, then the SUV; the race car lowest (settled chassis height)', rides[0][0] === 'ridgeback' && rides[1][0] === 'atlas' && rides[rides.length - 1][0] === 'apex', rides.map(([id, y]) => `${id} ${y.toFixed(3)}`).join(', '));
  const rideErr = CARS.map((v) => [v.id, R[v.id].ride - rideHeightOf(tuningFor(v).car)] as const);
  check('settled ride height matches the derived rideHeight for every car (within 2 cm)', rideErr.every(([, e]) => Math.abs(e) < 0.02), rideErr.map(([id, e]) => `${id} ${(e * 100).toFixed(1)} cm`).join(', '));
  const rolls = CARS.map((v) => [v.id, R[v.id].roll] as const).sort((a, b) => b[1] - a[1]);
  check('soft SUV / off-roader lean the most in corners, the stiff race car the least', ['ridgeback', 'atlas'].includes(rolls[0][0]) && ['ridgeback', 'atlas'].includes(rolls[1][0]) && rolls[rolls.length - 1][0] === 'apex', rolls.map(([id, r]) => `${id} ${((r * 180) / Math.PI).toFixed(2)}°`).join(', '));
  check('off-roader has the lowest top speed', CARS.every((v) => v.id === 'ridgeback' || VMAX[v.id] > VMAX.ridgeback), `ridgeback ${VMAX.ridgeback.toFixed(0)} km/h`);
  check('sedan is the slowest to 100 km/h (comfort car)', CARS.every((v) => v.id === 'meridian' || R[v.id].t100 < R.meridian.t100), `meridian ${R.meridian.t100.toFixed(2)} s`);
}

// Motorcycle: independent stability/acceleration guardrails (not included in car-vs-car rankings).
{
  const bike = measure('striker-900');
  const dualsport = measure('dune-650');
  const bt = tuningFor(vehicleById('striker-900'));
  const dt = tuningFor(vehicleById('dune-650'));
  check('Striker 900 is a rideable motorcycle class with a narrow wheel track and light chassis', vehicleById('striker-900').style === 'motorcycle' && bt.car.trackHalf < 0.2 && bt.car.mass < 300, `track ${bt.car.trackHalf.toFixed(2)} m, mass ${bt.car.mass} kg`);
  check('motorcycle remains upright and reaches urban traffic speed under normal controls', bike.minUp > 0.6 && bike.t100 > 0 && bike.t100 < 10, `upright ${bike.minUp.toFixed(2)}, 0–100 ${bike.t100.toFixed(2)} s`);
  check('motorcycle-specific handling values survive garage tuning', car.wheels.every((w) => Math.abs(w.mount.z) < 0.2) && Math.abs(car.wheels[0].mount.x - dt.car.wheelBaseFront) < 1e-5, `front mount ${car.wheels[0].mount.x.toFixed(2)} m, lateral ${car.wheels[0].mount.z.toFixed(2)} m`);
  check('Dune dual-sport and Striker sport bike have distinct mass, suspension and ride feel', dt.car.mass < bt.car.mass && dt.car.suspensionRestLength > bt.car.suspensionRestLength && Math.abs(dualsport.t100 - bike.t100) > 0.2, `Dune ${dualsport.t100.toFixed(2)} s / ${dt.car.suspensionRestLength.toFixed(2)} m vs Striker ${bike.t100.toFixed(2)} s / ${bt.car.suspensionRestLength.toFixed(2)} m`);
}

// Upgrades each improve their own figure.
const e3 = measure('kestrel', { engine: 3, tyres: 0, brakes: 0, suspension: 0 });
const t3 = measure('kestrel', { engine: 0, tyres: 3, brakes: 0, suspension: 0 });
const b3 = measure('kestrel', { engine: 0, tyres: 0, brakes: 3, suspension: 0 });
check('engine upgrade (level 3) improves acceleration', e3.t100 < K.t100 - 0.15, `${K.t100.toFixed(2)} → ${e3.t100.toFixed(2)} s`);
check('tyre upgrade (level 3) improves cornering grip', t3.lat > K.lat * 1.03, `${(K.lat / 9.81).toFixed(3)} → ${(t3.lat / 9.81).toFixed(3)} g`);
check('brake upgrade (level 3) shortens braking', b3.brake < K.brake - 1.5, `${K.brake.toFixed(1)} → ${b3.brake.toFixed(1)} m`);
const s3 = measure('kestrel', { engine: 0, tyres: 0, brakes: 0, suspension: 3 });
check('suspension upgrade (level 3) cuts body roll by 10%+ and lowers the car', s3.roll < K.roll * 0.9 && s3.ride < K.ride - 0.01, `roll ${((K.roll * 180) / Math.PI).toFixed(2)}° → ${((s3.roll * 180) / Math.PI).toFixed(2)}°, ride ${K.ride.toFixed(3)} → ${s3.ride.toFixed(3)} m`);
const sStats0 = vehicleStats(vehicleById('kestrel'));
const sStats3 = vehicleStats(vehicleById('kestrel'), { engine: 0, tyres: 0, brakes: 0, suspension: 3 });
check('garage shows the suspension upgrade (stiffer, lower)', sStats3.stiffness > sStats0.stiffness * 1.4 && sStats3.clearanceCm < sStats0.clearanceCm, `stiffness ${sStats0.stiffness.toFixed(1)} → ${sStats3.stiffness.toFixed(1)}, clearance ${sStats0.clearanceCm} → ${sStats3.clearanceCm} cm`);

console.log(failures === 0 ? '\nALL VEHICLE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
