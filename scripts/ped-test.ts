/**
 * Headless pedestrian regression test (with real traffic + Rapier, no rendering).
 * Usage: npm run test:peds
 */
declare const process: { exit(code: number): never };
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { PED_BAND_MAX, PED_BAND_MIN, PED_LINES, PedestrianSystem, type PedThreat } from '../src/game/pedestrians/PedestrianSystem';
import { pedestrianObstacles } from '../src/game/pedestrians/obstacles';
import { buildCityGraph } from '../src/game/traffic/cityGraph';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { TrafficSystem, type TrafficAgent } from '../src/game/traffic/TrafficSystem';
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

// --- Static path sanity: every nominal line point is on the sidewalk, off every road, clear of furniture
// (or has a clear alternative inside the band).
let onRoad = 0;
let noRoute = 0;
let routed = 0;
const tmp = { x: 0, z: 0 };
for (const L of PED_LINES) {
  for (let s = 0; s < track.length; s += 0.5) {
    peds.pos(s, L.side * L.lat, tmp);
    if (track.distanceTo(tmp.x, tmp.z) < PED_BAND_MIN - 0.05) onRoad++;
    if (peds.staticClearance(tmp.x, tmp.z) < 0.4) {
      routed++;
      let ok = false;
      for (let l = PED_BAND_MIN; l <= PED_BAND_MAX; l += 0.15) {
        peds.pos(s, L.side * l, tmp);
        if (peds.staticClearance(tmp.x, tmp.z) >= 0.4) ok = true;
      }
      if (!ok) noRoute++;
    }
  }
}
check('sidewalk lines never touch a road (incl. where the loop passes close to itself)', onRoad === 0, `${onRoad} points`);
check('wherever furniture/props stand on a line there is a clear way round inside the sidewalk', noRoute === 0, `${routed} obstructed points, ${noRoute} without a way round`);

// --- Shared loop: traffic + pedestrians + optional threats
const agents: TrafficAgent[] = [];
function stepAll(fx: number, fz: number, threats: PedThreat[], extraAgents: TrafficAgent[] = []): void {
  signals.update(FIXED_DT);
  agents.length = 0;
  agents.push(...extraAgents);
  peds.roadAgents(agents);
  traffic.fixedUpdate(FIXED_DT, fx, fz, agents);
  peds.fixedUpdate(FIXED_DT, fx, fz, threats);
  physics.step();
}

// Focus near crossing 228 (busy area), walking slowly along the sidewalk.
let fi = 200;
const fp = (i: number): [number, number] => {
  const k = ((Math.round(i) % track.count) + track.count) % track.count;
  return [track.px[k] + track.rx(k) * 9.5, track.pz[k] + track.rz(k) * 9.5];
};
let [fx, fz] = fp(fi);
traffic.setEnabled(true, fx, fz, []);
peds.setEnabled(true, fx, fz);
check('pedestrians populate the sidewalks', peds.stats.active >= 18, `${peds.stats.active} active`);
const spawnOnRoad = peds.peds.filter((p) => p.mode !== 0 && Math.abs(p.lat) < PED_BAND_MIN - 0.01).length;
check('no pedestrian spawns on a road', spawnOnRoad === 0, `${spawnOnRoad}`);

let carPedOverlap = 0;
let closeSpawns = 0;
let maxStill = 0;
const still = new Map<number, number>();
let last = new Set<number>(peds.peds.map((p, k) => (p.mode !== 0 ? k : -1)).filter((k) => k >= 0));
let pedMoved = 0;
const SECONDS = 360;
for (let n = 0; n < SECONDS * 60; n++) {
  fi += (0.9 * FIXED_DT) / track.spacing; // a slow walk along the sidewalk
  [fx, fz] = fp(fi);
  stepAll(fx, fz, [{ x: fx, z: fz, vx: 0, vz: 0, yaw: 0, halfLen: 0.3, halfWidth: 0.3, person: true }]);
  if (n % 10 === 0) {
    const now = new Set<number>();
    peds.peds.forEach((p, k) => {
      if (p.mode === 0) return;
      now.add(k);
      if (!last.has(k) && Math.hypot(p.x - fx, p.z - fz) < 38) closeSpawns++;
      // A traffic car body overlapping a pedestrian (car footprint 2.25 x 0.92 half extents + 0.28).
      for (const c of traffic.cars) {
        if (c.mode !== 1) continue;
        const cx = Math.cos(c.yaw);
        const cz = -Math.sin(c.yaw);
        const rx = p.x - c.x;
        const rz = p.z - c.z;
        const lx = rx * cx + rz * cz;
        const lz = -rx * cz + rz * cx;
        if (Math.abs(lx) < 2.5 && Math.abs(lz) < 1.2) carPedOverlap++;
      }
      if (p.speed < 0.05 && p.mode !== 4) still.set(k, (still.get(k) ?? 0) + 10 * FIXED_DT);
      else still.set(k, 0);
      maxStill = Math.max(maxStill, still.get(k) ?? 0);
      if (p.speed > 0.6) pedMoved++;
    });
    last = now;
  }
}
const st = peds.stats;
check('pedestrians cross the road at the marked crossings', st.crossDone >= 8, `${st.crossStarted} started, ${st.crossDone} completed`);
check('crossings only start on WALK with time to finish', st.badStarts === 0, `${st.badStarts} bad starts`);
check('pedestrians never step onto the road away from a crossing', st.offCrossingRoad === 0, `${st.offCrossingRoad} samples`);
check('the carriageway is clear of pedestrians whenever cars get green', st.onRoadAtGreen === 0, `${st.onRoadAtGreen} samples`);
check('traffic never drives through a pedestrian', carPedOverlap === 0 && traffic.stats.violations === 0, `${carPedOverlap} overlaps, ${traffic.stats.violations} red-light violations`);
check('pedestrians keep clear of lamps, trees, signal poles and props', st.minClear > 0.02, `min clearance ${st.minClear.toFixed(2)} m at ${peds.minClearInfo}`);
check('pedestrians keep apart from each other', st.minSep > 0.45, `min separation ${st.minSep.toFixed(2)} m`);
check('pedestrians keep walking (nobody stuck for over 45 s outside a crossing wait)', maxStill < 45, `longest stand ${maxStill.toFixed(1)} s`);
check('population maintained around the player', peds.stats.active >= 18, `${peds.stats.active} active`);
const visibleLooks = new Set(peds.peds.filter((p) => p.mode !== 0).map((p) => p.variant));
check('active crowd includes woman, skater, rider, shopkeeper, mechanic and courier archetypes', [6, 7, 8, 9, 10, 11].every((look) => visibleLooks.has(look)), `(${[...visibleLooks].sort((a,b)=>a-b).join(', ')})`);
const pairedWalkers = peds.peds.filter((p) => p.mode !== 0 && p.groupId >= 0);
check('some pedestrians walk in coherent pairs rather than as isolated walkers', pairedWalkers.length >= 2 && new Set(pairedWalkers.map((p) => p.groupId)).size > 0, `(${pairedWalkers.length} paired walkers)`);
check('no pedestrian pops into existence within ~40 m of the player', closeSpawns === 0, `${closeSpawns}`);
check('nobody was hit by the walking player', st.hits === 0, `${st.hits} hits`);
console.log(`(info) dodges ${st.dodges}, turnarounds ${st.turnarounds}, traffic redStops ${traffic.stats.redStops}, moving samples ${pedMoved})`);

// --- Dodge: the player's car drives along the sidewalk at a pedestrian at 12 m/s.
traffic.setEnabled(false, 0, 0, []);
peds.setDensity(1);
peds.setEnabled(true, fp(500)[0], fp(500)[1]);
const victim = peds.peds.find((p) => p.mode !== 0)!;
// Put the pedestrian on the inner right line at sample 500, the car 25 m behind it on the same line.
victim.s = 500 * track.spacing;
victim.lat = 8.75;
victim.side = 1;
victim.line = 0;
victim.dir = 1;
victim.mode = 1;
peds.pos(victim.s, victim.lat, tmp);
victim.x = victim.prevX = tmp.x;
victim.z = victim.prevZ = tmp.z;
let carS = victim.s - 25;
let dodged = false;
let wasHit = false;
for (let n = 0; n < 4 * 60; n++) {
  carS += 12 * FIXED_DT;
  const c = { x: 0, z: 0 };
  peds.pos(carS, 8.75, c);
  const c2 = { x: 0, z: 0 };
  peds.pos(carS + 1, 8.75, c2);
  const yaw = Math.atan2(-(c2.z - c.z), c2.x - c.x);
  const vx = Math.cos(yaw) * 12;
  const vz = -Math.sin(yaw) * 12;
  stepAll(c.x, c.z, [{ x: c.x, z: c.z, vx, vz, yaw, halfLen: 2.2, halfWidth: 0.95, person: false }]);
  if ((victim.mode as number) === 6) dodged = true;
  if (peds.events.some((e) => e.type === 'pedHit')) wasHit = true;
  peds.events.length = 0;
}
check('a pedestrian jumps out of the way of a car driving along the sidewalk', dodged && !wasHit, `dodged=${dodged} hit=${wasHit}`);
check('...and stays on the sidewalk while dodging', Math.abs(victim.lat) >= PED_BAND_MIN - 0.01 && Math.abs(victim.lat) <= PED_BAND_MAX + 0.01, `lat ${victim.lat.toFixed(2)}`);

// --- Parked car on the sidewalk: pedestrians walk round it or turn back, never through it.
peds.resetStats();
peds.setDensity(10);
const pi = 430;
const pc = { x: 0, z: 0 };
peds.pos(pi * track.spacing, 9.4, pc);
const pc2 = { x: 0, z: 0 };
peds.pos(pi * track.spacing + 1, 9.4, pc2);
const pyaw = Math.atan2(-(pc2.z - pc.z), pc2.x - pc.x);
peds.setEnabled(true, pc.x, pc.z);
let through = 0;
for (let n = 0; n < 90 * 60; n++) {
  stepAll(pc.x + 30, pc.z, [{ x: pc.x, z: pc.z, vx: 0, vz: 0, yaw: pyaw, halfLen: 2.2, halfWidth: 0.95, person: false }]);
  for (const p of peds.peds) {
    if (p.mode === 0) continue;
    const rx = p.x - pc.x;
    const rz = p.z - pc.z;
    const cx = Math.cos(pyaw);
    const cz = -Math.sin(pyaw);
    if (Math.abs(rx * cx + rz * cz) < 2.2 && Math.abs(-rx * cz + rz * cx) < 0.95) through++;
  }
}
check('pedestrians never walk through a car parked on the sidewalk', through === 0, `${through} samples inside, ${peds.stats.turnarounds} turnarounds`);

peds.setEnabled(false, 0, 0);
check('disabling pedestrians removes everyone', peds.stats.active === 0, `${peds.stats.active}`);

console.log(failures === 0 ? '\nALL PEDESTRIAN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
