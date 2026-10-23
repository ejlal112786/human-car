/**
 * Handling probe (real Rapier, fixed 60 Hz step, no rendering): measures the numbers used to judge handling
 * changes before / after.
 *   0–100 km/h, braking 100→0 distance, pitch (squat under throttle, dive under braking),
 *   steady-state body roll per g, maximum cornering (lateral g) at 60 / 100 / 140 km/h,
 *   steering response (time to 63 % of the final yaw rate after a step at 100 km/h),
 *   rollover check (full lock at 120 km/h + fast slalom), lift-off / trail-brake stability.
 * Usage: npx tsx scripts/tune/handling-probe.ts ['{"downforceCoefficient":0.1}'] [vehicleId]
 *   The optional JSON overrides fields of the car's CarParams (for A/B comparison).
 */
declare const process: { argv: string[] };
import { Euler, Quaternion, Vector3 } from 'three';
import { CAR, ENGINE, FIXED_DT, type CarParams, type EngineParams } from '../../src/game/config';
import type { DriverInput } from '../../src/game/Drivetrain';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { VehiclePhysics } from '../../src/game/VehiclePhysics';
import { tuningFor, vehicleById } from '../../src/game/vehicles/VehicleCatalog';

const overrides = process.argv[2] ? (JSON.parse(process.argv[2]) as Partial<CarParams>) : {};
const vehicleId = process.argv[3] ?? '';

const physics = await PhysicsWorld.create();
physics.addGround(1600);
let slot = 0;

function makeCar(): VehiclePhysics {
  // Each test on its own strip of ground (far from the others).
  const z = -700 + (slot++ % 14) * 100;
  const car = new VehiclePhysics(physics, new Vector3(-700, 0, z), 0);
  let p: CarParams = CAR;
  let e: EngineParams = ENGINE;
  if (vehicleId) {
    const vp = tuningFor(vehicleById(vehicleId));
    p = vp.car;
    e = vp.engine;
  }
  car.applyTuning({ ...p, ...overrides } as CarParams, e);
  car.reset(new Vector3(-700, 0, z), 0);
  for (let i = 0; i < 90; i++) step(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  return car;
}
function step(car: VehiclePhysics, inp: DriverInput): void {
  car.prePhysicsStep(FIXED_DT, inp);
  physics.step();
}
const q = new Quaternion();
const e = new Euler();
function angles(car: VehiclePhysics): { roll: number; pitch: number; upY: number } {
  const r = car.body.rotation();
  q.set(r.x, r.y, r.z, r.w);
  e.setFromQuaternion(q, 'YZX');
  // Chassis: +X forward, +Z right. Roll = about X, pitch = about Z.
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  return { roll: (e.x * 180) / Math.PI, pitch: (e.z * 180) / Math.PI, upY: up.y };
}
/** Hold a speed with a P controller (throttle / brake). */
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

const out: Record<string, string | number> = {};

// 0–100 and squat.
{
  const car = makeCar();
  const rest = angles(car).pitch;
  let squat = 0;
  let t = 0;
  while (car.forwardSpeed < 100 / 3.6 && t < 30) {
    step(car, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    t += FIXED_DT;
    if (t < 1.5) squat = Math.max(squat, angles(car).pitch - rest);
  }
  out['0-100 s'] = +t.toFixed(2);
  out['squat deg'] = +squat.toFixed(2);
  // Braking 100→0 and dive.
  let d = 0;
  let dive = 0;
  while (car.forwardSpeed > 0.3) {
    const x0 = car.body.translation();
    step(car, { throttle: 0, brake: 1, steer: 0, handbrake: false });
    const x1 = car.body.translation();
    d += Math.hypot(x1.x - x0.x, x1.z - x0.z);
    dive = Math.max(dive, rest - angles(car).pitch);
  }
  out['brake 100-0 m'] = +d.toFixed(1);
  out['dive deg'] = +dive.toFixed(2);
}

// Max lateral g at constant speed: slow steering ramp; record the best 0.5 s average of v·yawRate while stable.
function maxLat(vKmh: number): { g: number; rollPerG: number; slipAtMax: number } {
  const car = makeCar();
  const v = vKmh / 3.6;
  accelTo(car, v);
  for (let i = 0; i < 60; i++) step(car, hold(car, v, 0));
  const rest = angles(car).roll;
  let best = 0;
  let rollAt = 0;
  let slipAt = 0;
  const win: number[] = [];
  for (let k = 0; k < 60 * 12; k++) {
    const steer = Math.min(1, k / (60 * 10));
    step(car, hold(car, v, steer));
    const lat = Math.abs(car.yawRate * car.forwardSpeed) / 9.81;
    win.push(lat);
    if (win.length > 30) win.shift();
    const beta = Math.atan2(Math.abs(car.rearSlip), Math.abs(car.forwardSpeed));
    if (beta > 0.25 || car.forwardSpeed < v * 0.8) break; // spun / scrubbed off
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (avg > best && win.length === 30) {
      best = avg;
      rollAt = Math.abs(angles(car).roll - rest);
      slipAt = beta;
    }
  }
  return { g: best, rollPerG: best > 0.05 ? rollAt / best : 0, slipAtMax: slipAt };
}
for (const v of [60, 100, 140]) {
  const r = maxLat(v);
  out[`max lat g @${v}`] = +r.g.toFixed(3);
  if (v === 100) {
    out['roll deg/g @100'] = +r.rollPerG.toFixed(2);
    out['rear slip at max @100 (rad)'] = +r.slipAtMax.toFixed(3);
  }
}

// Steering response at 100 km/h: step to 30 % steer, time to 63 % of the yaw rate after 2 s.
{
  const car = makeCar();
  accelTo(car, 100 / 3.6);
  for (let i = 0; i < 60; i++) step(car, hold(car, 100 / 3.6, 0));
  const trace: number[] = [];
  for (let i = 0; i < 120; i++) {
    step(car, hold(car, 100 / 3.6, 0.3));
    trace.push(Math.abs(car.yawRate));
  }
  const fin = trace[trace.length - 1];
  const i63 = trace.findIndex((y) => y >= fin * 0.63);
  out['yaw response 63% @100 (s)'] = +((i63 + 1) * FIXED_DT).toFixed(2);
}

// Rollover / stability: full lock at 120 km/h for 3 s, then a slalom at 110 km/h.
{
  const car = makeCar();
  accelTo(car, 120 / 3.6);
  let minUp = 1;
  for (let i = 0; i < 180; i++) {
    step(car, { throttle: 0.6, brake: 0, steer: 1, handbrake: false });
    minUp = Math.min(minUp, angles(car).upY);
  }
  const car2 = makeCar();
  accelTo(car2, 110 / 3.6);
  for (let i = 0; i < 60 * 8; i++) {
    const s = Math.sin((i * FIXED_DT * Math.PI * 2) / 2.2) > 0 ? 1 : -1;
    step(car2, hold(car2, 110 / 3.6, s));
    minUp = Math.min(minUp, angles(car2).upY);
  }
  out['min up.y (full lock 120 + slalom 110)'] = +minUp.toFixed(3);
  out['rolled over'] = minUp < 0.5 ? 'YES' : 'no';
}

// Lift-off in a fast bend: at 100 km/h hold 0.6 g, then lift completely: peak extra yaw rate (oversteer).
{
  const car = makeCar();
  accelTo(car, 100 / 3.6);
  for (let i = 0; i < 60; i++) step(car, hold(car, 100 / 3.6, 0));
  for (let i = 0; i < 150; i++) step(car, hold(car, 100 / 3.6, 0.35));
  const y0 = Math.abs(car.yawRate);
  let peak = 0;
  let beta = 0;
  for (let i = 0; i < 90; i++) {
    step(car, { throttle: 0, brake: 0.5, steer: 0.35, handbrake: false });
    peak = Math.max(peak, Math.abs(car.yawRate) - y0);
    beta = Math.max(beta, Math.atan2(Math.abs(car.rearSlip), Math.abs(car.forwardSpeed)));
  }
  out['trail-brake extra yaw (rad/s)'] = +peak.toFixed(3);
  out['trail-brake max rear slip (rad)'] = +beta.toFixed(3);
}

console.log(JSON.stringify({ vehicle: vehicleId || 'stock', overrides, ...out }, null, 1));
