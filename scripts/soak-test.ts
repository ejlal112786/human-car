/**
 * Long-session soak test (headless: real traffic + pedestrians + signals + Rapier, no rendering).
 * The player walks, drives round the loop and idles in a repeating cycle, so spawning / despawning
 * sweeps the whole city again and again. Looks for slow failures that short tests cannot see:
 * gridlock, rule violations, NaN drift, pool / physics-body / heap growth, flow degradation.
 * Usage: npm run test:soak [-- minutes [startSample]]   (default 60 simulated minutes from sample 120)
 */
declare const process: { exit(code: number): never; argv: string[]; env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } };
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { PED_RADIUS, PedestrianSystem, type PedThreat } from '../src/game/pedestrians/PedestrianSystem';
import { pedestrianObstacles } from '../src/game/pedestrians/obstacles';
import { buildCityGraph } from '../src/game/traffic/cityGraph';
import { KIND_HALF } from '../src/game/traffic/TrafficModels';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { TrafficSystem, type TrafficAgent } from '../src/game/traffic/TrafficSystem';
import { CROSSINGS } from '../src/game/world/Crossings';
import { DynamicProps } from '../src/game/world/Props';
import { Track } from '../src/game/world/Track';

const MINUTES = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 60;
const gc = (globalThis as unknown as { gc?: () => void }).gc;
const heapMB = (): number => {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
};

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures++;
}

const physics = await PhysicsWorld.create();
physics.addGround(800);
const track = new Track(2);
const props = new DynamicProps(physics, track);
const signals = new TrafficSignals(CROSSINGS.length);
const graph = buildCityGraph(track, props.positions);
const traffic = new TrafficSystem(physics, graph, signals, null, [13, 5]);
traffic.setDensity(18);
const statics = pedestrianObstacles(track, props.positions);
const peds = new PedestrianSystem(track, signals, statics, 24);
peds.setDensity(24);
const flat: number[] = [];
props.obstacles(flat);
peds.setDynamicObstacles(flat);

// Player path: the outer sidewalk line, round and round the loop.
const fp = (i: number): [number, number] => {
  const k = ((Math.floor(i) % track.count) + track.count) % track.count;
  return [track.px[k] + track.rx(k) * 9.5, track.pz[k] + track.rz(k) * 9.5];
};
// Repeating 10-minute cycle: walk 3 min (1.4 m/s, pedestrians react to the player), drive 5 min (14 m/s), idle 2 min.
const phaseAt = (t: number): 'walk' | 'drive' | 'idle' => {
  const c = t % 600;
  return c < 180 ? 'walk' : c < 480 ? 'drive' : 'idle';
};
let fi = Number(process.argv[3]) >= 0 && process.argv[3] !== undefined ? Number(process.argv[3]) : 120;
let [fx, fz] = fp(fi);
traffic.setEnabled(true, fx, fz, []);
peds.setEnabled(true, fx, fz);

const carPool = traffic.cars.length;
const pedPool = peds.peds.length;
const bodies0 = physics.world.bodies.len();
const colliders0 = physics.world.colliders.len();

let nonFinite = 0;
let nonFiniteInfo = '';
let overlaps = 0;
let offRoad = 0;
let carMaxStill = 0;
let pedMaxStill = 0;
const carStill = new Map<number, number>();
const pedStill = new Map<number, number>();
let lapCount = 0;
let lastLapI = fi;
const minute: Array<{ m: number; phase: string; cars: number; peds: number; bodies: number; colliders: number; speed: number; crossDone: number; redStops: number }> = [];
let speedSum = 0;
let speedN = 0;
let heapAt10 = 0;
let maxBodies = bodies0;
let maxColliders = colliders0;
let minCarsSettled = Infinity;
let minPedsSettled = Infinity;

let clearLow = Infinity;
const clearEvents: string[] = [];
const fin = (...v: number[]): boolean => v.every((x) => Number.isFinite(x));
function obbOverlap(A: { x: number; z: number; yaw: number; kind: number }, B: { x: number; z: number; yaw: number; kind: number }): boolean {
  const ha = KIND_HALF[Math.min(A.kind, KIND_HALF.length - 1)];
  const hb = KIND_HALF[Math.min(B.kind, KIND_HALF.length - 1)];
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  for (const ang of [A.yaw, A.yaw + Math.PI / 2, B.yaw, B.yaw + Math.PI / 2]) {
    const ax = Math.cos(ang);
    const az = -Math.sin(ang);
    const proj = (h: { x: number; z: number }, yaw: number): number => {
      const hx = Math.cos(yaw);
      const hz = -Math.sin(yaw);
      return Math.abs(h.x * (hx * ax + hz * az)) + Math.abs(h.z * (-hz * ax + hx * az));
    };
    if (Math.abs(dx * ax + dz * az) > proj(ha, A.yaw) + proj(hb, B.yaw)) return false;
  }
  return true;
}

const agents: TrafficAgent[] = [];
const threat: PedThreat[] = [{ x: 0, z: 0, vx: 0, vz: 0, yaw: 0, halfLen: 0.3, halfWidth: 0.3, person: true }];
const noThreat: PedThreat[] = [];
const [traceFrom, traceTo] = (process.env.SOAK_TRACE ?? '-1--1').split(/-(?=\d)/).map(Number);
const steps = Math.round((MINUTES * 60) / FIXED_DT);
const wall0 = Date.now();
let phaseStart = 0;
let lastPhase = phaseAt(0);
for (let n = 0; n < steps; n++) {
  const t = n * FIXED_DT;
  const phase = phaseAt(t);
  if (phase !== lastPhase) {
    phaseStart = t;
    lastPhase = phase;
  }
  const v = phase === 'walk' ? 1.4 : phase === 'drive' ? 14 : 0;
  fi += (v * FIXED_DT) / track.spacing;
  if (fi - lastLapI >= track.count) {
    lapCount++;
    lastLapI += track.count;
  }
  [fx, fz] = fp(fi);
  signals.update(FIXED_DT);
  agents.length = 0;
  peds.roadAgents(agents);
  traffic.fixedUpdate(FIXED_DT, fx, fz, agents);
  if (phase === 'walk') {
    threat[0].x = fx;
    threat[0].z = fz;
  }
  peds.fixedUpdate(FIXED_DT, fx, fz, phase === 'walk' ? threat : noThreat);
  physics.step();
  // Debug aid: SOAK_TRACE=fromMin-toMin prints every pedestrian closer than 5 cm to furniture in that window.
  if (traceFrom >= 0 && t >= traceFrom * 60 && t <= traceTo * 60) {
    peds.peds.forEach((p, k) => {
      if (p.mode === 0 || p.far) return;
      const c = peds.staticClearance(p.x, p.z) - PED_RADIUS;
      if (c < 0.05) console.log(`trace ${(t / 60).toFixed(4)} min ped ${k} mode ${p.mode} s ${p.s.toFixed(2)} lat ${p.lat.toFixed(2)} target ${p.targetLat.toFixed(2)} speed ${p.speed.toFixed(2)} clear ${c.toFixed(3)} player ${Math.hypot(p.x - fx, p.z - fz).toFixed(2)} m (${phase})`);
    });
  }

  if (n % 30 === 0) {
    const cars = traffic.cars;
    let activeCars = 0;
    for (let a = 0; a < cars.length; a++) {
      const A = cars[a];
      if (A.mode !== 1) continue;
      activeCars++;
      if (!fin(A.x, A.z, A.yaw, A.v)) {
        nonFinite++;
        nonFiniteInfo ||= `car ${a} at ${t.toFixed(1)} s`;
        continue;
      }
      const ti = track.trackIndex(A.x, A.z, graph.trackIdx[A.node], 30);
      if (Math.abs(graph.lateral(ti, A.x, A.z)) > 6.2) offRoad++;
      speedSum += A.v;
      speedN++;
      const st = A.v < 0.1 ? (carStill.get(a) ?? 0) + 0.5 : 0;
      carStill.set(a, st);
      carMaxStill = Math.max(carMaxStill, st);
      for (let b = a + 1; b < cars.length; b++) {
        const B = cars[b];
        if (B.mode !== 1) continue;
        if ((B.x - A.x) ** 2 + (B.z - A.z) ** 2 > 49) continue;
        if (obbOverlap(A as never, B as never)) overlaps++;
      }
    }
    let activePeds = 0;
    peds.peds.forEach((p, k) => {
      if (p.mode === 0) {
        pedStill.delete(k);
        return;
      }
      activePeds++;
      if (!fin(p.x, p.z, p.speed)) {
        nonFinite++;
        nonFiniteInfo ||= `ped ${k} at ${t.toFixed(1)} s`;
        return;
      }
      const st = p.speed < 0.05 && p.mode !== 4 ? (pedStill.get(k) ?? 0) + 0.5 : 0;
      pedStill.set(k, st);
      pedMaxStill = Math.max(pedMaxStill, st);
    });
    // Population once the player has been in one phase for 30 s (spawning has caught up).
    if (t - phaseStart > 30) {
      minCarsSettled = Math.min(minCarsSettled, activeCars);
      minPedsSettled = Math.min(minPedsSettled, activePeds);
    }
    if (peds.stats.minClear < clearLow) {
      clearLow = peds.stats.minClear;
      if (clearLow < 0) clearEvents.push(`${(t / 60).toFixed(1)} min (${phase}): ${clearLow.toFixed(3)} m, ${peds.minClearInfo}`);
    }
    maxBodies = Math.max(maxBodies, physics.world.bodies.len());
    maxColliders = Math.max(maxColliders, physics.world.colliders.len());
  }
  if (n % 3600 === 3599) {
    const m = Math.round(((n + 1) * FIXED_DT) / 60);
    let activeCars = 0;
    for (const c of traffic.cars) if (c.mode === 1) activeCars++;
    minute.push({
      m,
      phase,
      cars: activeCars,
      peds: peds.peds.filter((p) => p.mode !== 0).length,
      bodies: physics.world.bodies.len(),
      colliders: physics.world.colliders.len(),
      speed: speedN ? speedSum / speedN : 0,
      crossDone: peds.stats.crossDone,
      redStops: traffic.stats.redStops,
    });
    speedSum = 0;
    speedN = 0;
    if (m === 10) heapAt10 = heapMB();
    if (m % 10 === 0) {
      const r = minute[minute.length - 1];
      console.log(`(min ${String(m).padStart(3)}) ${r.phase.padEnd(5)} cars ${r.cars}  peds ${r.peds}  bodies ${r.bodies}  colliders ${r.colliders}  mean car speed ${(r.speed * 3.6).toFixed(1)} km/h  crossings ${r.crossDone}  red stops ${r.redStops}  laps ${lapCount}  heap ${heapMB().toFixed(1)} MB  wall ${((Date.now() - wall0) / 1000).toFixed(0)} s`);
    }
  }
}

const heapEnd = heapMB();
const ts = traffic.stats;
const ps = peds.stats;
const tenMin = (from: number, to: number): number => {
  const rows = minute.filter((r) => r.m > from && r.m <= to);
  return rows.reduce((s, r) => s + r.speed, 0) / Math.max(1, rows.length);
};
const firstFlow = tenMin(0, 10);
const lastFlow = tenMin(MINUTES - 10, MINUTES);
const crossFirstHalf = minute.find((r) => r.m === Math.floor(MINUTES / 2))?.crossDone ?? 0;

console.log(`\n${MINUTES} simulated minutes, ${lapCount} player laps of the loop, ${((Date.now() - wall0) / 1000).toFixed(0)} s wall time`);
check('no NaN / infinite positions or speeds (cars, pedestrians)', nonFinite === 0, nonFinite ? `${nonFinite} samples, first ${nonFiniteInfo}` : 'none');
check('no two traffic cars ever overlap', overlaps === 0, `${overlaps} samples`);
check('traffic stays on the carriageway', offRoad === 0, `${offRoad} samples`);
check('no red-light violations; pedestrians follow the crossing rules', ts.violations === 0 && ps.badStarts === 0 && ps.offCrossingRoad === 0 && ps.onRoadAtGreen === 0, `violations ${ts.violations}, bad starts ${ps.badStarts}, off-crossing ${ps.offCrossingRoad}, on road at green ${ps.onRoadAtGreen}`);
check('no gridlock: no car stands still for more than 60 s', carMaxStill <= 60, `longest stop ${carMaxStill.toFixed(1)} s`);
check('no pedestrian stuck for over 45 s', pedMaxStill < 45, `longest stand ${pedMaxStill.toFixed(1)} s`);
check('pedestrians never brush into lamps, trees, poles or props', ps.minClear > 0, `min clearance ${ps.minClear.toFixed(3)} m${clearEvents.length ? `; first below 0: ${clearEvents[0]}` : ''}`);
check('population maintained around the player in every phase', minCarsSettled >= 8 && minPedsSettled >= 12, `min ${minCarsSettled} cars, ${minPedsSettled} pedestrians (30 s into a phase)`);
check('traffic flow does not degrade over the session', lastFlow > 5 && lastFlow > 0.7 * firstFlow, `first 10 min ${(firstFlow * 3.6).toFixed(1)} km/h, last 10 min ${(lastFlow * 3.6).toFixed(1)} km/h`);
check('pedestrians keep crossing throughout', ps.crossDone - crossFirstHalf >= 5 && crossFirstHalf >= 5, `${crossFirstHalf} in the first half, ${ps.crossDone - crossFirstHalf} in the second`);
check('object pools do not grow (cars, pedestrians)', traffic.cars.length === carPool && peds.peds.length === pedPool, `cars ${carPool} -> ${traffic.cars.length}, peds ${pedPool} -> ${peds.peds.length}`);
check('no physics body / collider leak', physics.world.bodies.len() <= bodies0 + 2 && maxBodies <= bodies0 + 40 && physics.world.colliders.len() <= colliders0 + 2, `bodies ${bodies0} -> ${physics.world.bodies.len()} (max ${maxBodies}), colliders ${colliders0} -> ${physics.world.colliders.len()} (max ${maxColliders})`);
if (gc) check('heap stable after warm-up (10 min -> end, after GC)', heapEnd - heapAt10 < 3, `${heapAt10.toFixed(1)} MB -> ${heapEnd.toFixed(1)} MB (${(heapEnd - heapAt10 >= 0 ? '+' : '')}${(heapEnd - heapAt10).toFixed(2)} MB)`);
else console.log('(heap check skipped: run with node --expose-gc)');
if (clearEvents.length) console.log(`(info) pedestrian clearance records below 0:\n  ${clearEvents.join('\n  ')}`);
console.log(`(info) red stops ${ts.redStops}, lane changes ${ts.laneChanges}, crossings ${ps.crossStarted}/${ps.crossDone}, dodges ${ps.dodges}, min car gap ${ts.minGap.toFixed(2)} m, min ped clearance ${ps.minClear.toFixed(2)} m`);
console.log(failures === 0 ? '\nSOAK TEST PASSED' : `\n${failures} SOAK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
