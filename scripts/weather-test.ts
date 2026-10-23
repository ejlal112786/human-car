/**
 * Weather, road surfaces, puddles / aquaplaning and tyre heat / wear (headless, fixed step).
 *   npx tsx scripts/weather-test.ts
 */
declare const process: { exit(code: number): never; argv: string[] };
import { Vector3 } from 'three';
import { FIXED_DT, ROAD, SIDEWALK_OUTER } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { TyreModel } from '../src/game/TyreModel';
import { VehiclePhysics } from '../src/game/VehiclePhysics';
import { GripField, SURFACE_GRIP, type SurfaceKind, type SurfaceProvider, type SurfaceSample } from '../src/game/world/Surface';
import { Track } from '../src/game/world/Track';
import { FIRST_CHANGE_S, Weather } from '../src/game/world/Weather';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const f2 = (n: number): string => n.toFixed(2);

// ---------- Weather simulation
{
  const w = new Weather(1);
  w.setMode('dynamic', true);
  let changedAt = -1;
  const kinds = new Set<string>();
  for (let t = 0; t < 3600; t += 1) {
    w.update(1);
    kinds.add(w.kind);
    if (changedAt < 0 && w.kind !== 'clear') changedAt = t;
  }
  check(`dynamic weather starts clear and holds for ${FIRST_CHANGE_S} s, then changes`, changedAt >= FIRST_CHANGE_S - 1, `first change at ${changedAt} s`);
  check('dynamic weather visits several kinds within an hour', kinds.size >= 3, [...kinds].join(', '));
  const a = new Weather(42);
  const b = new Weather(42);
  a.setMode('dynamic', true);
  b.setMode('dynamic', true);
  let same = true;
  for (let t = 0; t < 2000; t++) {
    a.update(1);
    b.update(1);
    if (a.kind !== b.kind) same = false;
  }
  check('dynamic weather is reproducible (seeded)', same);

  const r = new Weather();
  r.setMode('clear', true);
  r.setMode('rain');
  let wetAt = -1;
  for (let t = 0; t < 200; t++) {
    r.update(1);
    if (wetAt < 0 && r.wetness > 0.95) wetAt = t;
  }
  check('rain soaks the road gradually (not instantly)', wetAt > 30 && wetAt < 150, `wet after ${wetAt} s`);
  check('steady rain fills the puddles', r.puddles > 0.95, f2(r.puddles));
  r.setMode('clear');
  let dryAt = -1;
  for (let t = 0; t < 600; t++) {
    r.update(1);
    if (dryAt < 0 && r.wetness < 0.05) dryAt = t;
  }
  check('after the rain the road dries over a few minutes', dryAt > 120 && dryAt < 400, `dry after ${dryAt} s; puddles ${f2(r.puddles)}`);
  const f = new Weather();
  f.setMode('fog', true);
  check('fog: visibility well down, road damp but not soaked', f.visibility < 0.4 && f.wetness > 0.1 && f.wetness < 0.4, `visibility ${f2(f.visibility)}, wetness ${f2(f.wetness)}`);
  const s = new Weather();
  s.setMode('storm', true);
  check('a fixed weather can be set instantly (new session)', s.kind === 'storm' && s.rain === 1 && s.wetness === 1);
}

// ---------- Surfaces under the wheels (the real city road)
{
  const track = new Track();
  const weather = new Weather();
  weather.setMode('clear', true);
  const field = new GripField(track, weather);
  const out: SurfaceSample = { kind: 'road', grip: 1, drag: 1, water: 0 };
  const at = (i: number, lat: number): SurfaceSample => {
    field.sample(track.px[i] + track.rx(i) * lat, track.pz[i] + track.rz(i) * lat, { idx: -1 }, out);
    return { ...out };
  };
  const i = 100;
  const kinds = [at(i, 0), at(i, ROAD.halfWidth - 0.5), at(i, ROAD.halfWidth + 2), at(i, SIDEWALK_OUTER + 3), at(i, -(SIDEWALK_OUTER + 3))].map((x) => x.kind);
  check('road / pavement / grass are told apart by the distance from the road centre', kinds.join(',') === 'road,road,pavement,grass,grass', kinds.join(','));
  check('dry grass grips about half as well as asphalt and drags', at(i, SIDEWALK_OUTER + 3).grip === SURFACE_GRIP.grass.dry && SURFACE_GRIP.grass.drag > 3);
  weather.setMode('storm', true);
  const wet = at(i, 0);
  check('soaked asphalt grips ≈ 0.72 of dry', Math.abs(wet.grip - 0.72) < 0.01, f2(wet.grip));
  // Puddles: inside one there is water (the puddles are full in a storm), outside none.
  const p = field.puddles[3];
  const inside: SurfaceSample = { kind: 'road', grip: 1, drag: 1, water: 0 };
  field.sample(p.x, p.z, { idx: -1 }, inside);
  const outside: SurfaceSample = { kind: 'road', grip: 1, drag: 1, water: 0 };
  field.sample(p.x + p.tz * 6, p.z - p.tx * 6, { idx: -1 }, outside);
  check(`${field.puddles.length} puddles on the road; standing water inside one, none beside it`, inside.water > 0.4 && field.sample !== undefined && (outside.kind !== 'road' || outside.water < inside.water), `inside ${f2(inside.water)}, 6 m across ${f2(outside.water)} (${outside.kind})`);
  check('every puddle lies on the asphalt', field.puddles.every((q) => track.distanceTo(q.x, q.z) < ROAD.halfWidth - 0.5));
  weather.setMode('clear', true);
  field.sample(p.x, p.z, { idx: -1 }, inside);
  check('no standing water when the puddles have dried', inside.water === 0);
}

// ---------- Physics on uniform test surfaces
const physics = await PhysicsWorld.create();
physics.addGround(1600);
let slot = 0;
class Uniform implements SurfaceProvider {
  constructor(
    public kind: SurfaceKind,
    public wetness: number,
    public water = 0,
    public ambient = 20,
  ) {}
  sample(_x: number, _z: number, _h: { idx: number }, out: SurfaceSample): void {
    const s = SURFACE_GRIP[this.kind];
    out.kind = this.kind;
    out.grip = s.dry * (1 - s.wetLoss * this.wetness);
    out.drag = s.drag;
    out.water = this.water;
  }
}
function makeCar(surface: SurfaceProvider | null, tyrePressure = 0, wear = 0): VehiclePhysics {
  const z = -1500 + slot++ * 60;
  const car = new VehiclePhysics(physics, new Vector3(-1400, 0, z), 0);
  if (tyrePressure) car.applyTuning({ ...car.car, tyrePressure }, car.drivetrain.engine);
  car.surface = surface;
  car.reset(new Vector3(-1400, 0, z), 0);
  car.tyres.wear.fill(wear);
  for (let i = 0; i < 60; i++) step(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  return car;
}
function step(car: VehiclePhysics, inp: DriverInput): void {
  car.prePhysicsStep(FIXED_DT, inp);
  physics.step();
}
function hold(car: VehiclePhysics, v: number, steer: number): DriverInput {
  const e = v - car.forwardSpeed;
  return { throttle: Math.max(0, Math.min(1, e * 0.6 + 0.25)), brake: e < -1.5 ? Math.min(1, -e * 0.2) : 0, steer, handbrake: false };
}
function accelTo(car: VehiclePhysics, v: number): void {
  for (let t = 0; car.forwardSpeed < v && t < 40; t += FIXED_DT) step(car, { throttle: 1, brake: 0, steer: 0, handbrake: false });
}
function brake100(surface: SurfaceProvider | null, wear = 0): number {
  const car = makeCar(surface, 0, wear);
  accelTo(car, 100 / 3.6);
  let d = 0;
  while (car.forwardSpeed > 0.3) {
    const a = car.body.translation();
    step(car, { throttle: 0, brake: 1, steer: 0, handbrake: false });
    const b = car.body.translation();
    d += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return d;
}
/** Max lateral g at 50 km/h (slow steering ramp). */
function maxLat(surface: SurfaceProvider | null): number {
  const car = makeCar(surface);
  const v = 50 / 3.6;
  accelTo(car, v);
  let best = 0;
  const win: number[] = [];
  for (let k = 0; k < 60 * 12; k++) {
    step(car, hold(car, v, Math.min(1, k / 600)));
    win.push(Math.abs(car.yawRate * car.forwardSpeed) / 9.81);
    if (win.length > 30) win.shift();
    if (Math.atan2(Math.abs(car.rearSlip), Math.abs(car.forwardSpeed)) > 0.25 || car.forwardSpeed < v * 0.8) break;
    if (win.length === 30) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 30);
  }
  return best;
}
/** Steer 0.25 for 1 s at a speed: yaw rate reached (how well the car still turns). */
function turnAt(surface: SurfaceProvider | null, kmh: number, tyrePressure = 0, wear = 0): { yaw: number; aqua: number } {
  const car = makeCar(surface, tyrePressure, wear);
  accelTo(car, kmh / 3.6);
  let aqua = 0;
  for (let i = 0; i < 60; i++) {
    step(car, hold(car, kmh / 3.6, 0.25));
    aqua = Math.max(aqua, car.aquaplane[0]);
  }
  return { yaw: Math.abs(car.yawRate), aqua };
}

{
  const dry = brake100(null);
  const dryRoad = brake100(new Uniform('road', 0));
  const wet = brake100(new Uniform('road', 1));
  const grass = brake100(new Uniform('grass', 0));
  check('a dry road behaves exactly like no surface at all (nothing changed in the dry)', Math.abs(dry - dryRoad) < 0.05, `${f2(dry)} vs ${f2(dryRoad)} m`);
  check('wet road: 100–0 km/h takes clearly longer (real cars: about ×1.2–1.4)', wet > dry * 1.2 && wet < dry * 1.5, `${f2(dry)} → ${f2(wet)} m`);
  check('grass: much longer stops than asphalt', grass > dry * 1.35, `${f2(grass)} m`);
  const worn = brake100(new Uniform('road', 1), 0.9);
  check('worn tyres stop clearly longer on a wet road', worn > wet * 1.12, `new ${f2(wet)} m, 90 % worn ${f2(worn)} m`);
  const wornDry = brake100(null, 0.15);
  check('lightly worn tyres are no worse in the dry', Math.abs(wornDry - dry) < 0.05, `${f2(wornDry)} m`);
  const gDry = maxLat(null);
  const gWet = maxLat(new Uniform('road', 1));
  const gGrass = maxLat(new Uniform('grass', 0));
  check('cornering grip: wet road and grass well below dry', gWet < gDry * 0.85 && gGrass < gDry * 0.7, `${f2(gDry)} / wet ${f2(gWet)} / grass ${f2(gGrass)} g`);
  // Coasting on grass loses speed faster (rolling drag).
  const coast = (s: SurfaceProvider | null): number => {
    const car = makeCar(s);
    accelTo(car, 40 / 3.6);
    const v0 = car.forwardSpeed;
    for (let i = 0; i < 180; i++) step(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    return (v0 - car.forwardSpeed) * 3.6;
  };
  const cRoad = coast(null);
  const cGrass = coast(new Uniform('grass', 0));
  check('grass drags: coasting loses speed faster', cGrass > cRoad * 1.5, `3 s coast from 40 km/h: −${f2(cRoad)} vs −${f2(cGrass)} km/h`);
  // Drive force is limited by the tyres once something lowers grip (the dry launch is the calibrated one).
  const t60 = (s: SurfaceProvider | null): number => {
    const car = makeCar(s);
    let t = 0;
    for (; car.forwardSpeed < 60 / 3.6 && t < 30; t += FIXED_DT) step(car, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    return t;
  };
  const aDry = t60(null);
  const aDryRoad = t60(new Uniform('road', 0));
  const aWet = t60(new Uniform('road', 1));
  const aGrass = t60(new Uniform('grass', 0));
  check('traction: the dry launch is unchanged on a dry road', Math.abs(aDryRoad - aDry) < 0.02, `0–60 km/h ${f2(aDry)} vs ${f2(aDryRoad)} s`);
  check('traction: slower launches on a wet road and on grass', aWet > aDry * 1.05 && aGrass > aWet, `0–60 km/h dry ${f2(aDry)} / wet ${f2(aWet)} / grass ${f2(aGrass)} s`);
}

// Aquaplaning: standing water hardly matters slowly, takes the steering away fast.
{
  const water = new Uniform('road', 1, 1);
  const wetOnly = new Uniform('road', 1, 0);
  const slow = turnAt(water, 50);
  const slowRef = turnAt(wetOnly, 50);
  const fast = turnAt(water, 120);
  const fastRef = turnAt(wetOnly, 120);
  check('in a puddle at 50 km/h: no aquaplaning, the car turns like on a wet road', slow.aqua === 0 && Math.abs(slow.yaw - slowRef.yaw) < 0.02, `yaw ${f2(slow.yaw)} vs ${f2(slowRef.yaw)} rad/s`);
  check('in standing water at 120 km/h the tyres aquaplane and the car barely turns', fast.aqua > 0.6 && fast.yaw < fastRef.yaw * 0.6, `aquaplane ${f2(fast.aqua)}; yaw ${f2(fast.yaw)} vs ${f2(fastRef.yaw)} rad/s on a wet road`);
  const lowP = turnAt(water, 95, -2);
  const highP = turnAt(water, 95, 2);
  const worn = turnAt(water, 95, 0, 0.9);
  const fresh = turnAt(water, 95, 0, 0);
  check('aquaplaning starts at a lower speed with low tyre pressure', lowP.aqua > highP.aqua, `at 95 km/h: low ${f2(lowP.aqua)} / high ${f2(highP.aqua)}`);
  check('aquaplaning starts at a lower speed on worn tyres', worn.aqua > fresh.aqua + 0.2, `at 95 km/h: new ${f2(fresh.aqua)} / 90 % worn ${f2(worn.aqua)}`);
}

// Tyre heat and wear.
{
  const t = new TyreModel(20);
  check('tyres start in their grip window', t.grip(0, 0) === 1, `${t.temp[0]} °C`);
  for (let k = 0; k < 600; k++) t.step(0, 0.1, 0, 3300, 25, 20, 0, 0);
  const cruise = t.temp[0];
  for (let k = 0; k < 150; k++) t.step(0, 0.1, 6, 4000, 15, 20, 0, 0);
  const hot = t.temp[0];
  check('cruising keeps tyres warm, sliding overheats them and costs grip', cruise > 30 && cruise < 60 && hot > 120 && t.grip(0, 0) < 0.95, `cruise ${cruise.toFixed(0)} °C, after 15 s sliding ${hot.toFixed(0)} °C, grip ${f2(t.grip(0, 0))}`);
  const w0 = t.wear[0];
  for (let k = 0; k < 600; k++) t.step(0, 0.1, 0, 3300, 25, 20, 0, 0);
  check('overheated tyres cool down again when driven gently (back in the grip window)', t.temp[0] < 80 && t.grip(0, 0) === 1, `${t.temp[0].toFixed(0)} °C`);
  check('sliding wears the tyre; renewing it restores the tread', w0 > 0.002, `${(w0 * 100).toFixed(2)} % after 15 s of sliding`);
  const lowP = new TyreModel(20);
  const highP = new TyreModel(20);
  for (let k = 0; k < 600; k++) {
    lowP.step(0, 0.1, 0, 3300, 30, 20, 0, -2);
    highP.step(0, 0.1, 0, 3300, 30, 20, 0, 2);
  }
  check('low tyre pressure runs hotter (more carcass flex)', lowP.temp[0] > highP.temp[0] + 3, `${lowP.temp[0].toFixed(0)} vs ${highP.temp[0].toFixed(0)} °C at 108 km/h`);
  const wetCool = new TyreModel(20);
  const dryCool = new TyreModel(20);
  wetCool.temp.fill(110);
  dryCool.temp.fill(110);
  for (let k = 0; k < 100; k++) {
    wetCool.step(0, 0.1, 0, 3300, 20, 13, 1, 0);
    dryCool.step(0, 0.1, 0, 3300, 20, 20, 0, 0);
  }
  check('a wet road cools hot tyres faster', wetCool.temp[0] < dryCool.temp[0] - 10, `${wetCool.temp[0].toFixed(0)} vs ${dryCool.temp[0].toFixed(0)} °C after 10 s`);
  t.renew(20);
  check('new tyres: no wear, back in the window', t.avgWear === 0 && t.grip(0, 1) === 1);
  // In the car: hard sliding heats the tyres, a gentle drive does not.
  const gentle = makeCar(null);
  for (let i = 0; i < 60 * 30; i++) step(gentle, hold(gentle, 20, 0));
  const slide = makeCar(null);
  accelTo(slide, 15);
  for (let i = 0; i < 60 * 12; i++) step(slide, { throttle: 1, brake: 0, steer: i % 120 < 60 ? 1 : -1, handbrake: i % 120 < 20 });
  const tg = Math.max(...gentle.tyres.temp);
  const ts = Math.max(...slide.tyres.temp);
  check('in the car: 30 s of gentle driving stays cool, 12 s of slides heat the tyres', tg < 60 && ts > 95, `${tg.toFixed(0)} °C vs ${ts.toFixed(0)} °C; wear ${(gentle.tyres.avgWear * 100).toFixed(2)} % vs ${(slide.tyres.avgWear * 100).toFixed(2)} %`);
}

console.log(failures === 0 ? '\nALL WEATHER / SURFACE / TYRE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
