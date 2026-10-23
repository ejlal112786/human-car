declare const process: { argv: string[] };
import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../../src/game/config';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { Vehicle } from '../../src/game/Vehicle';
import { Track } from '../../src/game/world/Track';
import { AiRacer, curvature } from '../../src/game/missions/RaceAI';
import { vehicleById } from '../../src/game/vehicles/VehicleCatalog';
const track = new Track(2);
const physics = await PhysicsWorld.create();
physics.addGround(800);
const car = new Vehicle(physics, new Scene(), new Vector3(), 0);
const [carId, lvl, skill, start] = process.argv.slice(2);
const L = Number(lvl);
car.configure(vehicleById(carId), { engine: L, tyres: L, brakes: L, suspension: 0 }, 0xffffff);
const ai = new AiRacer(car, { name: 't', paint: 0, skill: Number(skill), line: 1.75, i: Number(start ?? 830), off: 1.75 }, track);
ai.reset();
const kap = curvature(track);
let t = 0; let lastPrint = -1; let wasOff = false;
const hist: string[] = [];
const inp = (ai as unknown as { input: { throttle: number; brake: number; steer: number } }).input;
for (let i = 0; i < Math.round(200 / FIXED_DT) && !ai.finished; i++) {
  ai.fixedUpdate(FIXED_DT, true, []);
  physics.step();
  t += FIXED_DT;
  ai.afterStep(t, track.count);
  const p = car.physics.body.translation();
  const k = ai.idx;
  const off = (p.x - track.px[k]) * track.rx(k) + (p.z - track.pz[k]) * track.rz(k);
  const v = car.physics.body.linvel();
  const sp = Math.hypot(v.x, v.z);
  const side = Math.sqrt(Math.max(0, sp * sp - car.physics.forwardSpeed ** 2));
  const line = `t ${t.toFixed(2)} i ${k} kap ${kap[k].toFixed(4)} off ${off.toFixed(1)} v ${sp.toFixed(1)} side ${side.toFixed(1)} yaw ${car.physics.body.angvel().y.toFixed(2)} thr ${inp.throttle.toFixed(2)} brk ${inp.brake.toFixed(2)} st ${inp.steer.toFixed(2)} gear ${car.physics.drivetrain.gear ?? ''}`;
  hist.push(line); if (hist.length > 240) hist.shift();
  const isOff = Math.abs(off) > 6.5;
  if (isOff && !wasOff) { console.log('--- OFF ROAD'); for (let h = 0; h < hist.length; h += 10) console.log(hist[h]); }
  if (isOff && t - lastPrint > 0.5) { console.log(line); lastPrint = t; }
  wasOff = isOff;
}
console.log('finish', ai.finishTime.toFixed(2));
