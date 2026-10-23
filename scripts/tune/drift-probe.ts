import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../../src/game/config';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { Vehicle } from '../../src/game/Vehicle';
import { vehicleById, type VehicleDef } from '../../src/game/vehicles/VehicleCatalog';
declare const process: { argv: string[] };
const physics = await PhysicsWorld.create();
physics.addGround(800);
const car = new Vehicle(physics, new Scene(), new Vector3(0, 0, 0), 0);
const over = JSON.parse(process.argv[2] ?? '{}');
const KICK = Number(process.argv[3] ?? 0.35);
const CS = Number(process.argv[5] ?? 0.6);
const KP = Number(process.argv[6] ?? 0.5);
/** Kick with the handbrake at v0, then hold a power slide: counter-steer along the velocity, throttle by angle. */
function trial(def: VehicleDef, v0: number, target: number, label: string) {
  car.configure(def, { engine: 1, tyres: 1, brakes: 1, suspension: 0 }, 0xff0000);
  car.reset(new Vector3(-300, 0.6, 0), 0);
  let t = 0, maxA = 0, inBand = 0, spun = false, minV = 99;
  let phase = 0, pt = 0;
  for (let s = 0; s < 60 * 14; s++) {
    const lv = car.physics.body.linvel();
    const r = car.physics.body.rotation();
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z), fz = 2 * (r.x * r.z - r.w * r.y);
    const fl = Math.hypot(fx, fz);
    const vLong = (lv.x * fx + lv.z * fz) / fl, vLat = (lv.x * -fz + lv.z * fx) / fl;
    const sp = Math.hypot(lv.x, lv.z);
    const beta = Math.atan2(vLat, Math.max(0.5, vLong));
    let inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    if (phase === 0) { inp.throttle = sp < v0 ? 1 : 0; if (sp >= v0) { phase = 1; pt = 0; } }
    else if (phase === 1) { inp = { throttle: 0.3, brake: 0, steer: -1, handbrake: true }; pt += FIXED_DT; if (pt > KICK) { phase = 2; pt = 0; } }
    else {
      pt += FIXED_DT;
      const b = Math.abs(beta) * 57.3;
      const maxSteer = 0.58 / (1 + sp / 16);
      // Counter-steer partly along the velocity, steer into the turn when the angle is below target.
      const dirTurn = -1; // kicked left
      const err = target - b; // >0: need more angle
      inp.steer = Math.max(-1, Math.min(1, (beta * CS) / maxSteer + dirTurn * KP * err / 10));
      inp.throttle = b < target - 6 ? 1 : b < target + 6 ? 0.7 : b < target + 18 ? 0.4 : 0.1;
    }
    car.fixedUpdate(FIXED_DT, inp);
    physics.step();
    car.afterStep();
    t += FIXED_DT;
    if (process.argv[4] === label && phase >= 1 && s % 6 === 0 && pt < 3) {
      const av = car.physics.body.angvel();
      console.log(`  ph${phase} t+${pt.toFixed(2)} v=${sp.toFixed(1)} beta=${(beta * 57.3).toFixed(1)} yaw=${(av.y * 57.3).toFixed(0)} rearSlip=${car.physics.rearSlip.toFixed(2)} grip=${((car.physics as unknown as { rearGrip: number }).rearGrip).toFixed(2)} in=${inp.throttle.toFixed(2)}/${inp.steer.toFixed(2)}${inp.handbrake ? 'H' : ''}`);
    }
    if (phase === 2 && pt < 4) {
      const a = Math.abs(beta) * 57.3;
      if (sp > 7 && vLong > 0) { maxA = Math.max(maxA, a); if (a >= 12 && a <= 75) inBand += FIXED_DT; }
      if (vLong < 0 || a > 100) spun = true;
      minV = Math.min(minV, sp);
    }
  }
  console.log(`${label.padEnd(26)} max ${maxA.toFixed(0).padStart(3)}°  in band ${inBand.toFixed(2)}/4 s  minV ${minV.toFixed(1)}${spun ? '  SPUN' : ''}`);
}
/** Grip test: steady 60 m radius corner at 20 m/s with a simple steering controller — slip must stay small. */
function grip(def: VehicleDef, label: string) {
  car.configure(def, { engine: 1, tyres: 1, brakes: 1, suspension: 0 }, 0xff0000);
  car.reset(new Vector3(-300, 0.6, 0), 0);
  let maxA = 0;
  for (let s = 0; s < 60 * 14; s++) {
    const lv = car.physics.body.linvel();
    const sp = Math.hypot(lv.x, lv.z);
    const r = car.physics.body.rotation();
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z), fz = 2 * (r.x * r.z - r.w * r.y);
    const fl = Math.hypot(fx, fz);
    const vLong = (lv.x * fx + lv.z * fz) / fl, vLat = (lv.x * -fz + lv.z * fx) / fl;
    const t = s * FIXED_DT;
    const inp = { throttle: sp < 20 ? 0.8 : 0.25, brake: 0, steer: t > 6 ? 0.55 : 0, handbrake: false };
    car.fixedUpdate(FIXED_DT, inp);
    physics.step();
    car.afterStep();
    if (t > 8 && sp > 5) maxA = Math.max(maxA, Math.abs(Math.atan2(vLat, vLong)) * 57.3);
  }
  console.log(`${label.padEnd(26)} grip corner max slip ${maxA.toFixed(1)}°`);
}
for (const id of ['kestrel', 'pip', 'brute', 'vortex']) {
  const base = vehicleById(id);
  const def = { ...base, car: { ...base.car, ...over } };
  for (const v0 of [13, 17]) trial(def, v0, 28, `${id} v${v0}`);
  grip(def, id);
}
