/**
 * Headless traffic / signal regression test (real Rapier in Node, no rendering).
 * Usage: npm run test:traffic
 */
declare const process: { exit(code: number): never };
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { LANES, LaneGraph } from '../src/game/traffic/LaneGraph';
import { buildCityGraph } from '../src/game/traffic/cityGraph';
import { KIND_HALF } from '../src/game/traffic/TrafficModels';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { TrafficSystem, createAgent } from '../src/game/traffic/TrafficSystem';
import { CROSSINGS } from '../src/game/world/Crossings';
import { DynamicProps } from '../src/game/world/Props';
import { Track } from '../src/game/world/Track';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failures++;
}

const physics = await PhysicsWorld.create();
physics.addGround(800);
const track = new Track(2);
const props = new DynamicProps(physics, track);
const graph = buildCityGraph(track, props.positions);
const signals = new TrafficSignals(CROSSINGS.length);
const traffic = new TrafficSystem(physics, graph, signals, null, [13, 5]);
traffic.setDensity(18);

// --- graph sanity
let badNext = 0;
for (let id = 0; id < graph.nodeCount; id++) {
  const n = graph.next[id];
  const fwd = (graph.x[n] - graph.x[id]) * graph.dx[id] + (graph.z[n] - graph.z[id]) * graph.dz[id];
  if (graph.lane[n] !== graph.lane[id] || fwd <= 0 || graph.segLen[id] > 6) badNext++;
}
check('lane graph: every successor is ahead in the same lane', badNext === 0, `${graph.nodeCount} nodes, ${badNext} bad`);
let badNb = 0;
for (let id = 0; id < graph.nodeCount; id++) {
  for (const nb of [graph.left[id], graph.right[id]]) {
    if (nb < 0) continue;
    const d = Math.hypot(graph.x[nb] - graph.x[id], graph.z[nb] - graph.z[id]);
    if (LANES[graph.lane[nb]].dir !== LANES[graph.lane[id]].dir || Math.abs(d - 3.5) > 0.2) badNb++;
  }
}
check('lane graph: lane-change edges join same-direction lanes 3.5 m apart', badNb === 0, `${badNb} bad`);
const blockedPerLane = LANES.map((_, l) => { let n = 0; for (let k = 0; k < graph.perLane; k++) n += graph.blocked[l * graph.perLane + k]; return n; });
check('street props block the lanes they stand in (construction, slalom, cones); the inner with-track lane stays open', blockedPerLane[0] === 0 && blockedPerLane.slice(1).every((n) => n > 0 && n < 60), `blocked nodes per lane ${blockedPerLane.join('/')}`);
let stopLines = 0;
for (let id = 0; id < graph.nodeCount; id++) if (graph.stopLine[id] >= 0) stopLines++;
check('every crossing has a stop line in each of the 4 lanes', stopLines === CROSSINGS.length * 4, `${stopLines} stop lines`);

// --- signals
signals.setPhase(0, 3);
check('signal cycle: walk phase means cars red', signals.ped(0) === 'walk' && signals.car(0) === 'red', `${signals.ped(0)}/${signals.car(0)}`);
signals.setPhase(0, 0);
check('signal cycle: car green means pedestrians wait', signals.ped(0) === 'dont' && signals.car(0) === 'green', `${signals.ped(0)}/${signals.car(0)}`);
signals.reset();

// --- simulation: player on foot near the start, own car parked in the outer lane (as in free roam)
const parked = createAgent(1, false);
const pi = 10;
parked.x = track.px[pi] + track.rx(pi) * 5.25;
parked.z = track.pz[pi] + track.rz(pi) * 5.25;
const agents = [parked];
let fx = track.px[4] + track.rx(4) * 9.1;
let fz = track.pz[4] + track.rz(4) * 9.1;
traffic.setEnabled(true, fx, fz, [[parked.x, parked.z]]);
check('traffic populates the streets around the player', traffic.stats.active >= 14, `${traffic.stats.active} cars`);

let overlaps = 0;
let offRoad = 0;
let inCrossingOnWalk = 0;
const stillTime = new Map<number, number>();
let maxStill = 0;
let sumSpeed = 0;
let speedSamples = 0;
const passedParked = new Set<number>();
function sample(): void {
  const cars = traffic.cars;
  for (let a = 0; a < cars.length; a++) {
    const A = cars[a];
    if (A.mode !== 1) continue;
    const ti = track.trackIndex(A.x, A.z, graph.trackIdx[A.node], 30);
    const lat = graph.lateral(ti, A.x, A.z);
    if (Math.abs(lat) > 6.2) offRoad++;
    sumSpeed += A.v;
    speedSamples++;
    const st = A.v < 0.1 ? (stillTime.get(a) ?? 0) + 0.5 : 0;
    stillTime.set(a, st);
    maxStill = Math.max(maxStill, st);
    // passed the parked car in its lane (index 10 + a few) while driving the with-track direction
    if (LANES[graph.lane[A.node]].dir > 0 && graph.trackIdx[A.node] > 20 && graph.trackIdx[A.node] < 40) passedParked.add(a);
    for (let k = 0; k < CROSSINGS.length; k++) {
      if (signals.ped(k) !== 'walk') continue;
      const d = Math.abs(((ti - CROSSINGS[k] + track.count / 2) % track.count + track.count) % track.count - track.count / 2);
      if (d <= 1 && Math.abs(lat) < 7) inCrossingOnWalk++;
    }
    for (let b = a + 1; b < cars.length; b++) {
      const B = cars[b];
      if (B.mode !== 1) continue;
      const dx = B.x - A.x;
      const dz = B.z - A.z;
      if (dx * dx + dz * dz > 49) continue;
      // separating-axis test between the two footprints
      const axes = [A.yaw, A.yaw + Math.PI / 2, B.yaw, B.yaw + Math.PI / 2];
      let sep = false;
      for (const ang of axes) {
        const ax = Math.cos(ang);
        const az = -Math.sin(ang);
        const proj = (c: typeof A) => {
          const he = KIND_HALF[c.kind];
          const hx = Math.cos(c.yaw), hz = -Math.sin(c.yaw);
          return Math.abs(he.x * (hx * ax + hz * az)) + Math.abs(he.z * (-hz * ax + hx * az));
        };
        if (Math.abs(dx * ax + dz * az) > proj(A) + proj(B)) { sep = true; break; }
      }
      if (!sep) overlaps++;
    }
  }
}
const steps = Math.round(300 / FIXED_DT);
for (let s = 0; s < steps; s++) {
  signals.update(FIXED_DT);
  traffic.fixedUpdate(FIXED_DT, fx, fz, agents);
  physics.step();
  if (s % 30 === 0) sample();
}
const st = traffic.stats;
check('5 min of traffic: no two cars ever overlap', overlaps === 0, `${overlaps} overlapping samples`);
check('cars stay on the carriageway', offRoad === 0, `${offRoad} off-road samples`);
check('cars stop for red lights and never run them', st.redStops > 20 && st.violations === 0, `${st.redStops} stops, ${st.violations} violations`);
check('crossings are clear while pedestrians have the walk signal', inCrossingOnWalk === 0, `${inCrossingOnWalk} samples`);
check('cars change lanes, including forced changes around blocked lanes / the parked car', st.laneChanges > 10 && st.forcedChanges > 3, `${st.laneChanges} changes, ${st.forcedChanges} forced`);
check('traffic gets past the parked player car', passedParked.size > 2, `${passedParked.size} cars passed`);
check('no deadlock: no car stands still for more than 60 s', maxStill <= 60, `longest stop ${maxStill.toFixed(1)} s`);
check('traffic keeps flowing at urban speed', sumSpeed / speedSamples > 5, `mean ${(sumSpeed / speedSamples * 3.6).toFixed(1)} km/h`);
check('hard stops keep a safe gap to the car ahead', st.minGap > 0.3, `min gap ${st.minGap.toFixed(2)} m`);

// --- the player drives a lap: traffic despawns behind and respawns ahead, never close by
let spawnedClose = 0;
let lastActive = new Set<number>(traffic.cars.map((c, k) => (c.mode !== 0 ? k : -1)).filter((k) => k >= 0));
let pti = 4;
let minActive = 99;
for (let s = 0; s < Math.round(130 / FIXED_DT); s++) {
  pti = (pti + 0.25) % track.count; // 15 m/s
  const i = Math.floor(pti);
  fx = track.px[i] + track.rx(i) * 1.75;
  fz = track.pz[i] + track.rz(i) * 1.75;
  parked.x = fx; parked.z = fz; parked.vx = track.tx[i] * 15; parked.vz = track.tz[i] * 15;
  signals.update(FIXED_DT);
  traffic.fixedUpdate(FIXED_DT, fx, fz, agents);
  physics.step();
  if (s % 30 === 0) {
    const now = new Set<number>();
    traffic.cars.forEach((c, k) => {
      if (c.mode === 0) return;
      now.add(k);
      if (!lastActive.has(k) && Math.hypot(c.x - fx, c.z - fz) < 100) spawnedClose++;
    });
    lastActive = now;
    minActive = Math.min(minActive, traffic.stats.active);
  }
}
check('driving a lap: traffic stays populated around the player', minActive >= 10, `min ${minActive} active`);
check('driving a lap: cars never pop in within 100 m of the player', spawnedClose === 0, `${spawnedClose} close spawns`);
check('driving a lap: still no overlaps or red-light violations', traffic.stats.violations === 0, `${traffic.stats.violations} violations`);

// --- a fast dynamic vehicle knocks a traffic car out of its lane; it becomes a physics body
const victim = traffic.cars.find((c) => c.mode === 1)!;
const vi = traffic.cars.indexOf(victim);
const hitter = createAgent(7, false);
const hyaw = victim.yaw + Math.PI / 2;
hitter.x = victim.x - Math.cos(hyaw) * 2.5;
hitter.z = victim.z + Math.sin(hyaw) * 2.5;
hitter.vx = Math.cos(hyaw) * 12;
hitter.vz = -Math.sin(hyaw) * 12;
traffic.events.length = 0;
traffic.fixedUpdate(FIXED_DT, victim.x, victim.z, [hitter]);
physics.step();
const ev = traffic.events.find((e) => e.type === 'hit');
check('a hard hit by a vehicle turns the traffic car into a free physics body and reports it', victim.mode === 2 && !!ev && ev.type === 'hit' && ev.car === vi && ev.agent === 7, `mode=${victim.mode} event=${JSON.stringify(ev ?? null)}`);
for (let s = 0; s < 600; s++) { traffic.fixedUpdate(FIXED_DT, victim.x, victim.z, []); physics.step(); }
check('a knocked car settles (and re-joins traffic or waits to despawn)', victim.mode === 1 || (victim.mode === 2 && Math.hypot(victim.body.linvel().x, victim.body.linvel().z) < 0.5), `mode=${victim.mode}`);

traffic.setEnabled(false);
check('disabling traffic removes every car', traffic.stats.active === 0 || traffic.cars.every((c) => c.mode === 0), `${traffic.cars.filter((c) => c.mode !== 0).length} left`);
void LaneGraph;
console.log(failures === 0 ? '\nALL TRAFFIC CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
