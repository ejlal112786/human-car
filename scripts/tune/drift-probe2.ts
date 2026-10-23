import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../../src/game/config';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { Vehicle } from '../../src/game/Vehicle';
import { vehicleById } from '../../src/game/vehicles/VehicleCatalog';
declare const process: { argv: string[] };
const physics = await PhysicsWorld.create();
physics.addGround(800);
const car = new Vehicle(physics, new Scene(), new Vector3(0, 0, 0), 0);
const over = JSON.parse(process.argv[2] ?? '{}');
const hold = Number(process.argv[3] ?? 0.35);
const base = vehicleById('kestrel');
car.configure({ ...base, car: { ...base.car, ...over } }, { engine: 1, tyres: 1, brakes: 1, suspension: 0 }, 0xff0000);
car.reset(new Vector3(-300, 0.6, 0), 0);
let phase = 0, pt = 0;
for (let s = 0; s < 60 * 12; s++) {
  const lv = car.physics.body.linvel();
  const r = car.physics.body.rotation();
  const fx = 1 - 2 * (r.y * r.y + r.z * r.z), fz = 2 * (r.x * r.z - r.w * r.y);
  const fl = Math.hypot(fx, fz);
  const vLong = (lv.x * fx + lv.z * fz) / fl, vLat = (lv.x * -fz + lv.z * fx) / fl;
  const sp = Math.hypot(lv.x, lv.z);
  let inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  if (phase === 0) { inp.throttle = sp < 17 ? 1 : 0; if (sp >= 17) phase = 1; }
  else if (phase === 1) { inp = { throttle: 0, brake: 0, steer: -1, handbrake: pt < hold }; pt += FIXED_DT; }
  car.fixedUpdate(FIXED_DT, inp);
  physics.step();
  car.afterStep();
  if (phase === 1 && Math.round(pt * 60) % 6 === 0 && pt < 2.5) {
    const av = car.physics.body.angvel();
    console.log(`t+${pt.toFixed(2)} v=${sp.toFixed(1)} beta=${(Math.atan2(vLat, vLong) * 57.3).toFixed(1)} yawRate=${(av.y * 57.3).toFixed(0)}°/s rearSlip=${car.physics.rearSlip.toFixed(2)} steerIn=${(car.physics as unknown as { steerInput: number }).steerInput.toFixed(2)} hb=${inp.handbrake}`);
  }
}
