/** One-off calibration: per car, how much corner grip / braking can the AI plan with before it crashes? */
declare const process: { argv: string[] };
import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../../src/game/config';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { Vehicle } from '../../src/game/Vehicle';
import { Track } from '../../src/game/world/Track';
import { AiRacer } from '../../src/game/missions/RaceAI';
import { vehicleById } from '../../src/game/vehicles/VehicleCatalog';

const track = new Track(2);
const physics = await PhysicsWorld.create();
physics.addGround(800);
const car = new Vehicle(physics, new Scene(), new Vector3(), 0);
const [carId, lvl, grips, decels, starts] = process.argv.slice(2);
const L = Number(lvl);
for (const start of (starts ?? '830').split(',').map(Number)) for (const g of (grips === 'auto' ? '0' : grips).split(',').map(Number)) for (const d of decels.split(',').map(Number)) {
  const auto = grips === 'auto';
  car.configure(vehicleById(carId), { engine: L, tyres: L, brakes: L, suspension: 0 }, 0xffffff);
  const ai = new AiRacer(car, { name: 't', paint: 0, skill: auto ? d : 1, line: 1.75, i: start, off: 1.75 }, track, auto ? null : { grip: g, decel: d });
  ai.reset();
  let t = 0, maxOff = 0, maxSlip = 0, maxLat = 0, latSum = 0, latN = 0;
  for (let i = 0; i < Math.round(200 / FIXED_DT) && !ai.finished; i++) {
    ai.fixedUpdate(FIXED_DT, true, []);
    physics.step();
    t += FIXED_DT;
    ai.afterStep(t, track.count);
    const p = car.physics.body.translation();
    const k = ai.idx;
    const off = Math.abs((p.x - track.px[k]) * track.rx(k) + (p.z - track.pz[k]) * track.rz(k));
    maxOff = Math.max(maxOff, off);
    const v = car.physics.body.linvel();
    const sp = Math.hypot(v.x, v.z);
    const lat = Math.abs(car.physics.forwardSpeed * car.physics.body.angvel().y);
    if (sp > 15) { maxLat = Math.max(maxLat, lat); if (lat > 6) { latSum += lat; latN++; } }
    if (sp > 5) maxSlip = Math.max(maxSlip, Math.sqrt(Math.max(0, sp * sp - car.physics.forwardSpeed ** 2)));
  }
  console.log(`${carId} L${L} start ${start} ${auto ? `skill ${d.toFixed(2)} profile ${ai.profile.grip.toFixed(3)}/${ai.profile.decel.toFixed(3)}` : `grip ${g.toFixed(2)} decel ${d.toFixed(2)}`}: ${ai.finished ? ai.finishTime.toFixed(2) + ' s' : 'DNF'}  respawns ${ai.respawns}  maxOff ${maxOff.toFixed(2)} m  maxSideslip ${maxSlip.toFixed(2)} m/s  maxLat ${(maxLat / 9.81).toFixed(2)} g  cornerAvg ${(latSum / Math.max(1, latN) / 9.81).toFixed(2)} g`);
}
