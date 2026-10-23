/**
 * Headless physics regression test (runs real Rapier in Node): vehicle dynamics,
 * on-foot character controller (curbs, walls, jump) and the safe exit-spot search.
 * Usage: npm run test:physics
 */
declare const process: { exit(code: number): never };
import { Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { VehiclePhysics } from '../src/game/VehiclePhysics';
import { CHARACTER, CharacterController } from '../src/game/character/CharacterController';
import type { Vehicle } from '../src/game/Vehicle';
import { VehicleInteraction } from '../src/game/VehicleInteraction';
import { ObstacleManager } from '../src/game/missions/ObstacleManager';
import { LEVELS } from '../src/game/missions/Levels';
import { DynamicProps } from '../src/game/world/Props';
import { Track } from '../src/game/world/Track';

const input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures++;
}
function setInput(t = 0, b = 0, s = 0, h = false): void {
  input.throttle = t; input.brake = b; input.steer = s; input.handbrake = h;
}

const physics = await PhysicsWorld.create();
physics.addGround(2000);
// Wall for the collision test far down the +Z axis.
physics.addStaticBox(0, 2, 600, 30, 2, 1);

const car = new VehiclePhysics(physics, new Vector3(0, 0, 0), 0);
let time = 0;
function run(seconds: number, each?: () => boolean | void): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.prePhysicsStep(FIXED_DT, input);
    physics.step();
    time += FIXED_DT;
    if (each && each() === true) break;
  }
}
const pos = () => car.body.translation();
const kmh = () => car.forwardSpeed * 3.6;
const upY = () => { const r = car.body.rotation(); return 1 - 2 * (r.x * r.x + r.z * r.z); };

// 1. Settle
setInput();
run(2);
const p0 = pos();
check('settles at ride height', Math.abs(p0.y - 0.56) < 0.06 && Math.abs(car.forwardSpeed) < 0.05, `y=${p0.y.toFixed(3)} v=${car.forwardSpeed.toFixed(3)}`);
check('stays put when idle', Math.hypot(p0.x, p0.z) < 0.1, `drift=${Math.hypot(p0.x, p0.z).toFixed(3)}`);
check('idle gear N', car.drivetrain.gearLabel === 'N', car.drivetrain.gearLabel);

// 2. Acceleration (forward = +X)
setInput(1);
let t100 = -1; let maxGear = 1; const gearsSeen = new Set<string>();
const tStart = time;
run(14, () => {
  gearsSeen.add(car.drivetrain.gearLabel);
  maxGear = Math.max(maxGear, car.drivetrain.gear);
  if (t100 < 0 && kmh() >= 100) t100 = time - tStart;
});
check('accelerates forward along +X', pos().x > 100, `x=${pos().x.toFixed(1)}`);
check('0-100 km/h in 3-8 s', t100 > 3 && t100 < 8, `t=${t100.toFixed(2)}s`);
check('upshifts through gears', maxGear >= 4, `gears=${[...gearsSeen].join(',')} speed=${kmh().toFixed(0)}km/h rpm=${car.drivetrain.rpm.toFixed(0)}`);
check('stays upright under acceleration', upY() > 0.95, `upY=${upY().toFixed(3)}`);
let cruiseSlip = 0; let cruiseImpact = 0;
setInput(0.5); run(2, () => { cruiseSlip = Math.max(cruiseSlip, car.maxSlip); cruiseImpact = Math.max(cruiseImpact, car.impact); car.impact = 0; });
check('no skid or impact signal while cruising straight', cruiseSlip < 0.05 && cruiseImpact === 0, `slip=${cruiseSlip.toFixed(3)} impact=${cruiseImpact.toFixed(2)}`);

// 3. Braking from current speed down to 100 then to stop
setInput(0, 0); run(0.1);
while (kmh() > 100) { setInput(0, 1); run(FIXED_DT); }
const brakeStartX = pos().x; const brakeStartT = time;
setInput(0, 1);
run(10, () => car.forwardSpeed < 0.5);
const brakeDist = pos().x - brakeStartX;
check('brakes 100-0 in 30-60 m', brakeDist > 30 && brakeDist < 60, `dist=${brakeDist.toFixed(1)}m t=${(time - brakeStartT).toFixed(2)}s`);
check('straight-line braking stable', Math.abs(pos().z) < 2 && upY() > 0.95, `z=${pos().z.toFixed(2)}`);

// 4. Reverse: keep holding S
run(3);
check('reverses when holding S at standstill', car.forwardSpeed < -3 && car.drivetrain.gearLabel === 'R', `v=${kmh().toFixed(1)}km/h gear=${car.drivetrain.gearLabel}`);
run(5);
check('reverse speed capped', kmh() > -40, `v=${kmh().toFixed(1)}km/h`);
// W brakes while reversing then drives forward
setInput(1, 0); run(4);
check('W switches back to forward drive', car.forwardSpeed > 5 && car.drivetrain.gearLabel !== 'R', `v=${kmh().toFixed(1)} gear=${car.drivetrain.gearLabel}`);

// 5. Steering right at ~50 km/h: velocity should rotate toward +Z (right)
car.reset(new Vector3(0, 0, -300), 0); setInput(); run(1);
setInput(1); run(10, () => kmh() >= 50);
setInput(0.35, 0, 1);
const zBefore = pos().z;
let maxYawRate = 0;
run(2.5, () => { maxYawRate = Math.max(maxYawRate, Math.abs(car.body.angvel().y)); });
check('D steers right (+Z)', pos().z - zBefore > 5, `dz=${(pos().z - zBefore).toFixed(1)} speed=${kmh().toFixed(0)}`);
check('no spin at moderate speed', maxYawRate < 1.6 && upY() > 0.9, `maxYawRate=${maxYawRate.toFixed(2)} upY=${upY().toFixed(2)}`);
setInput(0.35, 0, -1); const z2 = pos().z;
// A should curve the other way relative to current heading; measure yaw rate sign
let yawSum = 0; run(1.5, () => { yawSum += car.body.angvel().y; });
check('A steers left (positive yaw about +Y)', yawSum > 0, `yawSum=${yawSum.toFixed(1)}`);
void z2;

// 6. High-speed full-lock: must not roll over or spin wildly
car.reset(new Vector3(0, 0, 300), 0); setInput(); run(1);
setInput(1); run(25, () => kmh() >= 130);
const hsSpeed = kmh();
setInput(1, 0, 1);
let minUp = 1; maxYawRate = 0; let maxLatG = 0;
run(3, () => {
  minUp = Math.min(minUp, upY()); maxYawRate = Math.max(maxYawRate, Math.abs(car.body.angvel().y));
  const v = car.body.linvel(); const w = car.body.angvel();
  maxLatG = Math.max(maxLatG, Math.abs(Math.hypot(v.x, v.z) * w.y) / 9.81);
});
check('high-speed full lock stays upright', minUp > 0.85, `entry=${hsSpeed.toFixed(0)}km/h minUp=${minUp.toFixed(3)}`);
check('high-speed yaw bounded', maxYawRate < 1.8, `maxYawRate=${maxYawRate.toFixed(2)} latG~${maxLatG.toFixed(2)}`);
setInput(); run(3);

// 7. Handbrake turn at ~70 km/h vs. the same steering without handbrake
function turnTest(handbrake: boolean): { heading: number; maxSlip: number; minUp: number; tyre: number } {
  car.reset(new Vector3(-300, 0, 0), 0); setInput(); run(1);
  setInput(1); run(15, () => kmh() >= 70);
  setInput(0, 0, 0.8, handbrake);
  let maxSlip = 0; let mu = 1; let heading = 0; let tyre = 0;
  run(1.5, () => { maxSlip = Math.max(maxSlip, Math.abs(car.rearSlip)); mu = Math.min(mu, upY()); heading += car.yawRate * FIXED_DT; tyre = Math.max(tyre, car.wheels[2].slip, car.wheels[3].slip); });
  return { heading: Math.abs(heading), maxSlip, minUp: mu, tyre };
}
const noHb = turnTest(false);
const hb = turnTest(true);
check('handbrake makes the rear slide', hb.maxSlip > 4 && hb.maxSlip > noHb.maxSlip * 1.5, `rearSlip hb=${hb.maxSlip.toFixed(2)} vs ${noHb.maxSlip.toFixed(2)} m/s`);
check('handbrake rotates the car more', hb.heading > noHb.heading * 1.15, `heading hb=${(hb.heading * 57.3).toFixed(0)}deg vs ${(noHb.heading * 57.3).toFixed(0)}deg`);
check('handbrake keeps car upright', hb.minUp > 0.85, `minUp=${hb.minUp.toFixed(3)}`);
check('rear tyre slip signal (skid marks) during handbrake turn', hb.tyre > 0.6, `rear tyre slip=${hb.tyre.toFixed(2)} (no handbrake: ${noHb.tyre.toFixed(2)})`);
setInput(0, 0, 0, true); run(4);
check('handbrake brings car to stop', Math.abs(car.forwardSpeed) < 1, `v=${kmh().toFixed(1)}km/h`);

// 8. Collision with a wall at z=600 (heading +Z: yaw = -PI/2 maps +X to +Z)
car.reset(new Vector3(0, 0, 450), -Math.PI / 2); setInput(); run(1);
setInput(1);
let maxZ = -1e9; let wallImpact = 0;
run(20, () => { maxZ = Math.max(maxZ, pos().z); wallImpact = Math.max(wallImpact, car.impact); car.impact = 0; });
check('wall hit produces an impact signal', wallImpact > 5, `impact dv=${wallImpact.toFixed(1)}m/s`);
check('wall stops the car (no tunnelling)', maxZ < 599 && pos().z < 599, `maxZ=${maxZ.toFixed(2)} wallFace=599`);
check('car pinned against wall has ~0 speed', Math.abs(car.forwardSpeed) < 1.5, `v=${kmh().toFixed(1)}km/h`);

// 9. Flip detection (drives the game's auto-recovery after 2.5 s on the roof)
car.reset(new Vector3(-200, 0, -200), 0); setInput(); run(0.5);
check('upright car does not count as flipped', car.flippedTime === 0, `flippedTime=${car.flippedTime.toFixed(2)}`);
{
  const p = pos();
  car.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
  car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true); // roll 180° about the forward axis
}
run(3);
check('car on its roof accumulates flip time (> 2.5 s recovery threshold)', upY() < 0 && car.flippedTime > 2.5, `upY=${upY().toFixed(2)} flippedTime=${car.flippedTime.toFixed(2)}s`);

// 10. Reset
car.reset(new Vector3(10, 0, 10), 0); setInput(); run(1.5);
check('reset clears flip state and restores upright pose', car.flippedTime === 0 && upY() > 0.99, `flippedTime=${car.flippedTime} upY=${upY().toFixed(3)}`);
const pr = pos();
check('reset restores position and zero motion', Math.abs(pr.x - 10) < 0.2 && Math.abs(pr.z - 10) < 0.2 && Math.abs(car.forwardSpeed) < 0.05, `p=(${pr.x.toFixed(2)},${pr.y.toFixed(2)},${pr.z.toFixed(2)})`);

// 11. Fast stepping (PhysicsWorld.step skips Rapier's per-step JS handle-map sync) must give
//     exactly the same simulation as the stock World.step().
{
  const mk = async () => {
    const w = await PhysicsWorld.create();
    w.addGround(2000);
    for (let i = 0; i < 400; i++) w.addStaticBox(-300 + (i % 20) * 30, 2, 200 + Math.floor(i / 20) * 30, 4, 2, 4); // city-like clutter
    w.addStaticBox(0, 2, 120, 30, 2, 1); // wall ahead of a +Z run
    const c = new VehiclePhysics(w, new Vector3(0, 0, 0), -Math.PI / 2); // heading +Z
    return { w, c };
  };
  const A = await mk(); // fast path
  const B = await mk(); // stock World.step()
  const script: Array<[number, DriverInput]> = [
    [1.0, { throttle: 0, brake: 0, steer: 0, handbrake: false }],
    [3.0, { throttle: 1, brake: 0, steer: 0, handbrake: false }],
    [1.2, { throttle: 0, brake: 0, steer: 1, handbrake: true }],
    [1.0, { throttle: 0.6, brake: 0, steer: -0.5, handbrake: false }],
    [6.0, { throttle: 1, brake: 0, steer: 0, handbrake: false }],
  ];
  let maxDiff = 0; let steps = 0; let tFast = 0; let tStock = 0;
  for (const [secs, inp] of script) {
    for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
      A.c.prePhysicsStep(FIXED_DT, inp); let t0 = performance.now(); A.w.step(); tFast += performance.now() - t0;
      B.c.prePhysicsStep(FIXED_DT, inp); t0 = performance.now(); B.w.step(true); tStock += performance.now() - t0;
      const a = A.c.body.translation(); const b = B.c.body.translation();
      const ra = A.c.body.rotation(); const rb = B.c.body.rotation();
      maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z), Math.abs(ra.x - rb.x), Math.abs(ra.y - rb.y), Math.abs(ra.z - rb.z), Math.abs(ra.w - rb.w));
      steps++;
    }
  }
  // Phase 2: both cars restart 60 m from the wall and drive into it (contacts + impact).
  A.c.reset(new Vector3(0, 0, 60), -Math.PI / 2); B.c.reset(new Vector3(0, 0, 60), -Math.PI / 2);
  const go: DriverInput = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  let impactA = 0; let impactB = 0; let maxZ = -1e9;
  for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
    A.c.prePhysicsStep(FIXED_DT, go); A.w.step();
    B.c.prePhysicsStep(FIXED_DT, go); B.w.step(true);
    impactA = Math.max(impactA, A.c.impact); impactB = Math.max(impactB, B.c.impact); A.c.impact = 0; B.c.impact = 0;
    const a = A.c.body.translation(); const b = B.c.body.translation();
    maxZ = Math.max(maxZ, a.z);
    maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    steps++;
  }
  const pA = A.c.body.translation();
  check('fast step == stock World.step() (identical trajectory incl. wall contact)', maxDiff === 0 && maxZ > 116 && maxZ < 119 && impactA > 5 && impactA === impactB, `${steps} steps, max |diff|=${maxDiff}, wall reached z=${maxZ.toFixed(2)} (face 119), impact ${impactA.toFixed(1)} vs ${impactB.toFixed(1)} m/s, ${A.w.counts.colliders} colliders, final z=${pA.z.toFixed(2)}`);
  const R = A.w.R;
  const hit = A.w.world.castRay(new R.Ray({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 1 }), 500, true, R.QueryFilterFlags.EXCLUDE_DYNAMIC);
  check('ray casts still resolve colliders after fast steps', !!hit && !!hit.collider && hit.collider.isValid?.() !== false, hit ? `hit at ${hit.timeOfImpact.toFixed(2)} m` : 'no hit');
  console.log(`      (step time for this 400-box world: fast ${(tFast / steps * 1000).toFixed(0)} us vs stock ${(tStock / steps * 1000).toFixed(0)} us)`);
  A.c.dispose(); A.w.dispose(); B.c.dispose(); B.w.dispose();
}

console.log('\n--- character controller and exit spots');
car.dispose(); physics.dispose();

// ===================================================================== character controller
{
  const w = await PhysicsWorld.create();
  w.addGround(200);
  // Curb like RoadBuilder's: vertical 0.15 m face at x = 5 then a 3 m wide pavement (trimesh).
  const h = 0.15;
  w.addStaticTrimesh(
    new Float32Array([5, 0, -20, 5, 0, 20, 5, h, 20, 5, h, -20, 8, h, 20, 8, h, -20]),
    new Uint32Array([0, 2, 1, 0, 3, 2, 3, 4, 2, 3, 5, 4]),
  );
  // 0.6 m high wall-step (too high to climb) along x = -5, and a tall wall at z = 10.
  w.addStaticBox(-6, 0.3, 0, 1, 0.3, 20);
  w.addStaticBox(0, 2, 11, 30, 2, 1);
  const ch = new CharacterController(w);
  w.step(); // queries only see colliders after the first step (the game's world is always stepped)
  const stepN = (sec: number, mx: number, mz: number, run = false, jumpOnce = false): void => {
    const n = Math.round(sec / FIXED_DT);
    for (let i = 0; i < n; i++) {
      ch.step(FIXED_DT, mx, mz, run, jumpOnce && i === 0);
      w.step();
    }
  };
  ch.teleport(new Vector3(0, 0, 0), 0);
  stepN(0.5, 0, 0);
  check('character settles grounded on flat ground', ch.grounded && Math.abs(ch.position.y) < 0.06, `y=${ch.position.y.toFixed(3)}`);
  stepN(1, 0, 1);
  check('walk speed', Math.abs(ch.planarSpeed - CHARACTER.walkSpeed) < 0.05, `${ch.planarSpeed.toFixed(2)} m/s`);
  stepN(1, 0, 1, true);
  check('run speed', Math.abs(ch.planarSpeed - CHARACTER.runSpeed) < 0.05, `${ch.planarSpeed.toFixed(2)} m/s`);
  stepN(0.5, 0, 0);
  // Walk (and run) up the curb from a standstill.
  for (const run of [false, true]) {
    ch.teleport(new Vector3(3.5, 0, 0), Math.PI / 2);
    stepN(0.3, 0, 0);
    stepN(run ? 0.75 : 2.2, 1, 0, run);
    check(`${run ? 'runs' : 'walks'} up a 0.15 m curb`, ch.position.x > 5.5 && Math.abs(ch.position.y - h) < 0.06 && ch.grounded, `x=${ch.position.x.toFixed(2)} y=${ch.position.y.toFixed(3)}`);
  }
  // Too-high step blocks.
  ch.teleport(new Vector3(-2, 0, 0), -Math.PI / 2);
  stepN(2, -1, 0, true);
  check('0.6 m ledge blocks (no climbing walls)', ch.position.x > -5 - CHARACTER.radius - 0.05 && ch.position.y < 0.1, `x=${ch.position.x.toFixed(2)} y=${ch.position.y.toFixed(2)}`);
  check('animation speed drops when pushing into a wall', ch.actualSpeed < 0.6, `${ch.actualSpeed.toFixed(2)} m/s achieved vs ${ch.planarSpeed.toFixed(2)} commanded`);
  // Tall wall: never penetrates, slides along it diagonally.
  ch.teleport(new Vector3(0, 0, 7), 0);
  let maxZ = -1e9;
  const n = Math.round(2 / FIXED_DT);
  for (let i = 0; i < n; i++) { ch.step(FIXED_DT, 0.7, 0.7, true, false); w.step(); maxZ = Math.max(maxZ, ch.position.z); }
  check('wall stops the capsule (no penetration)', maxZ < 10 - CHARACTER.radius + 0.05, `max z=${maxZ.toFixed(3)} (wall face at 10)`);
  check('slides along the wall', ch.position.x > 3, `x=${ch.position.x.toFixed(2)}`);
  // Jump.
  ch.teleport(new Vector3(0, 0, -5), 0);
  stepN(0.3, 0, 0);
  let peak = 0;
  for (let i = 0; i < 90; i++) { ch.step(FIXED_DT, 0, 0, false, i === 0); w.step(); peak = Math.max(peak, ch.position.y); }
  check('jump rises ~0.7 m and lands', peak > 0.55 && peak < 0.9 && ch.grounded && Math.abs(ch.position.y) < 0.06, `peak=${peak.toFixed(2)} end y=${ch.position.y.toFixed(3)}`);
  // Disabled while driving: does not move and does not collide.
  ch.setEnabled(false);
  const before = ch.position.clone();
  stepN(1, 0, 1, true);
  check('disabled controller does not move', ch.position.distanceTo(before) < 1e-6, `moved ${ch.position.distanceTo(before).toFixed(4)} m`);
  ch.setEnabled(true);

  // ------------------------------------------------------------- exit-spot search
  const vi = new VehicleInteraction(w);
  const carP = new VehiclePhysics(w, new Vector3(-20, 0, -40), 0);
  const stub = { physics: carP, isActive: true } as unknown as Vehicle;
  const settle = (): void => { for (let i = 0; i < 90; i++) { carP.prePhysicsStep(FIXED_DT, { throttle: 0, brake: 0, steer: 0, handbrake: true }); w.step(); } };
  settle();
  ch.teleport(new Vector3(0, 0, 60), 0);
  let spot = vi.findExit(stub, ch.body);
  const cp = carP.body.translation();
  check('open space: exits on the driver side (candidate 0)', !!spot && vi.lastExitCandidate === 0 && spot.feet.z < cp.z, spot ? `cand ${vi.lastExitCandidate} at (${spot.feet.x.toFixed(2)}, ${spot.feet.z.toFixed(2)}) car z ${cp.z.toFixed(2)}` : 'none');
  // Wall right against the driver door (−Z side): must pick another side, never through the wall.
  w.addStaticBox(-20, 2, -41.6, 6, 2, 0.3);
  settle();
  spot = vi.findExit(stub, ch.body);
  check('wall at the driver door: exits elsewhere, not behind the wall', !!spot && spot.feet.z > -41.3, spot ? `cand ${vi.lastExitCandidate} z=${spot.feet.z.toFixed(2)}` : 'none');
  // Boxed in on every side: no exit at all (player stays in the car).
  w.addStaticBox(-20, 2, -38.4, 6, 2, 0.3);
  w.addStaticBox(-23.2, 2, -40, 0.3, 2, 2);
  w.addStaticBox(-16.8, 2, -40, 0.3, 2, 2);
  settle();
  spot = vi.findExit(stub, ch.body);
  check('boxed in: no exit spot (stays in the car)', spot === null, spot ? `cand ${vi.lastExitCandidate}` : 'null');
  // Low concrete barrier (0.8 m tall, like Mission 3's passage) right beside the driver door: the exit
  // must not go over it or put the character on top of it.
  const carB = new VehiclePhysics(w, new Vector3(-60, 0, -40), 0);
  w.addStaticBox(-60, 0.4, -41.65, 3, 0.4, 0.22);
  for (let i = 0; i < 90; i++) { carB.prePhysicsStep(FIXED_DT, { throttle: 0, brake: 0, steer: 0, handbrake: true }); w.step(); }
  const stubB = { physics: carB, isActive: true } as unknown as Vehicle;
  spot = vi.findExit(stubB, ch.body);
  check('low barrier at the driver door: exits elsewhere, on the road, not on/over the barrier', !!spot && vi.lastExitCandidate !== 0 && spot.feet.y < 0.3 && spot.feet.z > -41.4, spot ? `cand ${vi.lastExitCandidate} y=${spot.feet.y.toFixed(2)} z=${spot.feet.z.toFixed(2)}` : 'none');
  // Exit spot on the ground level of the curb (pavement), never below ground.
  const carQ = new VehiclePhysics(w, new Vector3(3.6, 0, 0), Math.PI / 2);
  for (let i = 0; i < 90; i++) { carQ.prePhysicsStep(FIXED_DT, { throttle: 0, brake: 0, steer: 0, handbrake: true }); w.step(); }
  const stubQ = { physics: carQ, isActive: true } as unknown as Vehicle;
  spot = vi.findExit(stubQ, ch.body);
  check('exit next to a curb lands on a real surface (y 0 or 0.15)', !!spot && (Math.abs(spot.feet.y) < 0.02 || Math.abs(spot.feet.y - h) < 0.02), spot ? `y=${spot.feet.y.toFixed(3)} x=${spot.feet.x.toFixed(2)}` : 'none');
}

// ===================================================================== mission obstacles
console.log('\n--- mission obstacles and street props');
{
  // Restarting a mission puts every prop back and wakes it; nothing may topple or drift on its own
  // (a falling cone would cost the player a penalty without being touched).
  const track = new Track(2);
  type RB = import('@dimforge/rapier3d-compat').RigidBody;
  type Pool = { kind: string; active: number; bodies: RB[]; initial: { p: { x: number; y: number; z: number } }[]; def: { dynamic: boolean } };
  for (const level of LEVELS) {
    if (!level.obstacles.some((o) => o.kind === 'cone' || o.kind === 'barrel')) continue;
    const w = await PhysicsWorld.create();
    w.addGround(800);
    const om = new ObstacleManager(w, track);
    const pools = (om as unknown as { pools: Pool[] }).pools;
    om.load(level.obstacles);
    w.step();
    om.reset();
    for (let i = 0; i < 120; i++) w.step();
    let penalties = 0;
    let moved = 0;
    for (let r = 0; r < 10; r++) {
      om.reset();
      om.takeNewlyDisplaced();
      for (let i = 0; i < 150; i++) {
        if (i % 30 === 0) for (const pl of pools) if (pl.def.dynamic) for (let k = 0; k < pl.active; k++) pl.bodies[k].wakeUp();
        w.step();
        penalties += om.takeNewlyDisplaced();
      }
      for (const pl of pools) if (pl.def.dynamic) for (let k = 0; k < pl.active; k++) {
        const t = pl.bodies[k].translation();
        const p = pl.initial[k].p;
        if (Math.abs(t.y - p.y) > 0.03 || Math.hypot(t.x - p.x, t.z - p.z) > 0.05) moved++;
      }
    }
    const n = pools.filter((pl) => pl.def.dynamic).reduce((a, pl) => a + pl.active, 0);
    check(`${level.title}: ${n} cones / barrels stay put over 10 restarts (kept awake)`, penalties === 0 && moved === 0, `${penalties} spurious penalties, ${moved} moved`);
    om.dispose();
    w.dispose();
  }
  // Street props (free roam) spawn at rest too.
  const w = await PhysicsWorld.create();
  w.addGround(800);
  const props = new DynamicProps(w, track);
  type Kind = { bodies: RB[]; initial: { p: { x: number; y: number; z: number } }[] };
  const kinds = (props as unknown as { kinds: Kind[] }).kinds;
  for (const k of kinds) for (const b of k.bodies) b.wakeUp();
  for (let i = 0; i < 180; i++) w.step();
  let drift = 0;
  // Kinds in creation order: cones, barriers, barrels, crates. Barrels and crates stand on the pavement,
  // which this bare test world does not have, so only the road props (cones, barriers) are checked.
  const per: number[] = [];
  kinds.forEach((k) => { let m = 0; k.bodies.forEach((b, i) => { const t = b.translation(); const p = k.initial[i].p; if (Math.abs(t.y - p.y) > 0.03 || Math.hypot(t.x - p.x, t.z - p.z) > 0.05) m++; }); per.push(m); });
  drift = per[0] + per[1];
  check(`street cones (${kinds[0].bodies.length}) and barriers (${kinds[1].bodies.length}) on the road stand still when woken`, drift === 0, `moved per kind: ${per.join(' / ')}`);
  props.dispose();
  w.dispose();
}

console.log(failures === 0 ? '\nALL PHYSICS CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
