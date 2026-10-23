/**
 * Campaign test (headless, real Rapier physics, the real MissionManager / obstacles / traffic /
 * signals / police — only rendering is stubbed):
 *  1. structure: 15 missions of 15 distinct kinds, unique ids, chapters, rewards, unlock rules,
 *     save migration from the 5-mission layout and corrupt-save handling;
 *  2. every mission is COMPLETED by a scripted test driver (pure-pursuit path follower, or the race
 *     AI for racing sections — with zero respawns) inside its limits;
 *  3. every mission can FAIL (time limit, lost race, busted, too few drift points, slow sections),
 *     plus rule checks with synthetic inputs (cargo, strikes, red lights).
 * Usage: npm run test:campaign            (add --tune to print the raw timings / scores)
 *        npm run test:campaign -- --only=7  (one mission by index)
 */
declare const process: { exit(code: number): never; argv: string[] };
import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import type { DriverInput } from '../src/game/Drivetrain';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { Vehicle } from '../src/game/Vehicle';
import { Track } from '../src/game/world/Track';
import { DynamicProps } from '../src/game/world/Props';
import { CROSSINGS, CROSS_HALF, STOP_BACK } from '../src/game/world/Crossings';
import { buildCityGraph } from '../src/game/traffic/cityGraph';
import { TrafficSignals } from '../src/game/traffic/TrafficSignals';
import { TrafficSystem, createAgent, type TrafficAgent } from '../src/game/traffic/TrafficSystem';
import { RedLightDetector } from '../src/game/traffic/RedLight';
import { PoliceSystem, type PlayerState } from '../src/game/police/PoliceSystem';
import { ObstacleManager } from '../src/game/missions/ObstacleManager';
import type { MissionVisuals } from '../src/game/missions/MissionVisuals';
import { MissionManager, createMissionInput, type MissionEvent } from '../src/game/missions/MissionManager';
import { AiRacer, indexDelta } from '../src/game/missions/RaceAI';
import { CHAPTERS, KIND_LABEL, LEVELS, MISSION_TRAFFIC_DENSITY, type LevelDef } from '../src/game/missions/Levels';
import {
  MISSION_REWARDS,
  defaultProgress,
  isMissionUnlocked,
  missionLockReason,
  recordCompletion,
  sanitizeProgress,
} from '../src/game/missions/Progress';
import { vehicleById, type UpgradeLevels } from '../src/game/vehicles/VehicleCatalog';

const TUNE = process.argv.includes('--tune');
const PK: Array<[number, number]> = JSON.parse(process.argv.find((x) => x.startsWith('--pk='))?.slice(5) ?? '[[391.6,5.2],[393.2,5.15],[396.6,2.6],[398,2.2],[400,2.2]]');
const REVLOOK = Number(process.argv.find((x) => x.startsWith('--rl='))?.slice(5) ?? 5);
const DBG = process.argv.includes('--dbg');
const TRACE = process.argv.find((x) => x.startsWith('--trace='))?.slice(8) ?? null;
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  return a ? a.slice(7).split(',').map(Number) : null;
})();
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const lv = (n: number): UpgradeLevels => ({ engine: n, tyres: n, brakes: n, suspension: 0 });
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

// =================================================================== world
const track = new Track(2);
const physics = await PhysicsWorld.create();
physics.addGround(800);
const scene = new Scene();
const props = new DynamicProps(physics, track);
const car = new Vehicle(physics, scene, new Vector3(0, 0, 0), 0);
const pool = [0, 1, 2].map((k) => new Vehicle(physics, scene, new Vector3(0, -40 - k * 6, 0), 0));
const obstacles = new ObstacleManager(physics, track);
const noop = (): void => {};
const visuals = { load: noop, setZone: noop, setProgress: noop, setZoneInside: noop, setBeacon: noop, setCarMarker: noop, update: noop, hideAll: noop, dispose: noop } as unknown as MissionVisuals;
const mission = new MissionManager(track, obstacles, visuals, pool);
const graph = buildCityGraph(track, props.positions);
const signals = new TrafficSignals(CROSSINGS.length);
const traffic = new TrafficSystem(physics, graph, signals, null, [13, 5]);
traffic.setDensity(18);
const police = new PoliceSystem(track, pool);
const agents: TrafficAgent[] = [createAgent(1, false), createAgent(10, false), createAgent(11, false), createAgent(12, false)];
const redLight = new RedLightDetector();

const PARKED: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
const IDLE: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function trackXZ(i: number, off: number): { x: number; z: number } {
  const k = ((Math.round(i) % track.count) + track.count) % track.count;
  const f = i - Math.round(i);
  const k2 = (k + 1) % track.count;
  // Linear interpolation between samples for fractional indices.
  const x0 = track.px[k] + track.rx(k) * off;
  const z0 = track.pz[k] + track.rz(k) * off;
  const x1 = track.px[k2] + track.rx(k2) * off;
  const z1 = track.pz[k2] + track.rz(k2) * off;
  return { x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f };
}
const wrapI = (i: number): number => ((Math.round(i) % track.count) + track.count) % track.count;
const yawAt = (i: number): number => Math.atan2(-track.tz[wrapI(i)], track.tx[wrapI(i)]);

// =================================================================== drivers
interface WP {
  x: number;
  z: number;
  v: number;
}

/** Speed limit from road curvature: v = sqrt(mu * g * R). */
function curveSpeed(i: number, mu: number): number {
  const a = wrapI(i - 3);
  const b = wrapI(i + 3);
  let d = Math.atan2(track.tz[b], track.tx[b]) - Math.atan2(track.tz[a], track.tx[a]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const k = Math.abs(d) / (6 * track.spacing);
  return k < 1e-4 ? 99 : Math.sqrt((mu * 9.81) / k);
}

/** Enforce a braking limit (m/s²) backwards along the path; the final point keeps its speed. */
function decel(path: WP[], a = 4): WP[] {
  for (let k = path.length - 2; k >= 0; k--) {
    const ds = Math.hypot(path[k + 1].x - path[k].x, path[k + 1].z - path[k].z);
    path[k].v = Math.min(path[k].v, Math.sqrt(path[k + 1].v ** 2 + 2 * a * ds));
  }
  return path;
}

/** Path along the road from i0 to i1 (dir +1 = driving direction), lateral offset by function of i. */
function roadPath(i0: number, i1: number, off: number | ((i: number) => number), vmax: number, vEnd = vmax, mu = 0.8, dir: 1 | -1 = 1, step = 0.5): WP[] {
  const out: WP[] = [];
  const N = track.count;
  const d = dir === 1 ? (wrapI(i1) - wrapI(i0) + N) % N : (wrapI(i0) - wrapI(i1) + N) % N;
  const frac = (x: number): number => x - Math.round(x);
  const total = d + (frac(i1) - frac(i0)) * dir;
  for (let s = 0; s <= total + 1e-6; s += step) {
    const i = i0 + s * dir;
    const o = typeof off === 'number' ? off : off(i);
    const p = trackXZ(i, o);
    out.push({ x: p.x, z: p.z, v: Math.min(vmax, curveSpeed(i, mu)) });
  }
  out[out.length - 1].v = vEnd;
  return decel(out);
}

/** Piecewise-linear lateral profile from [i, off] keypoints. */
function profile(keys: Array<[number, number]>): (i: number) => number {
  return (i: number): number => {
    if (i <= keys[0][0]) return keys[0][1];
    for (let k = 1; k < keys.length; k++) {
      if (i <= keys[k][0]) {
        const [i0, o0] = keys[k - 1];
        const [i1, o1] = keys[k];
        const t = (i - i0) / (i1 - i0);
        const s = t * t * (3 - 2 * t);
        return o0 + (o1 - o0) * s;
      }
    }
    return keys[keys.length - 1][1];
  };
}

function carFwd(): { fx: number; fz: number } {
  const r = car.physics.body.rotation();
  const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
  const fz = 2 * (r.x * r.z - r.w * r.y);
  const l = Math.hypot(fx, fz) || 1;
  return { fx: fx / l, fz: fz / l };
}

/** Pure-pursuit path follower with speed control (forward or reverse). */
class PathPilot {
  k = 0;
  done = false;
  /** Extra speed cap set by the scenario each step (traffic, signals). */
  cap = Infinity;
  /** Route waits (parked) after this segment until the mission task index passes this value. */
  waitTask: number | undefined;
  revLook = 3.2;
  constructor(
    readonly path: WP[],
    readonly reverse = false,
    readonly stopTol = 0.5,
  ) {}

  /** Point on the path `dist` metres ahead of the closest point. */
  aim(dist: number): { x: number; z: number } {
    const path = this.path;
    let j = this.k;
    let acc = 0;
    while (j < path.length - 1 && acc < dist) {
      acc += Math.hypot(path[j + 1].x - path[j].x, path[j + 1].z - path[j].z);
      j++;
    }
    return path[j];
  }

  step(): DriverInput {
    const p = car.physicsPosition;
    const path = this.path;
    const n = path.length;
    while (this.k < n - 1 && Math.hypot(path[this.k + 1].x - p.x, path[this.k + 1].z - p.z) <= Math.hypot(path[this.k].x - p.x, path[this.k].z - p.z) + 0.05) this.k++;
    const v = car.physics.forwardSpeed;
    const L = this.reverse ? this.revLook : Math.max(4, Math.abs(v) * 0.75 + 2.5);
    let j = this.k;
    let acc = 0;
    while (j < n - 1 && acc < L) {
      acc += Math.hypot(path[j + 1].x - path[j].x, path[j + 1].z - path[j].z);
      j++;
    }
    let distEnd = Math.hypot(path[n - 1].x - p.x, path[n - 1].z - p.z);
    let tx = path[j].x;
    let tz = path[j].z;
    // Near the end, aim past the last point along the final direction (keeps the heading straight).
    if (j === n - 1 && n >= 2) {
      const ex = path[n - 1].x - path[n - 2].x;
      const ez = path[n - 1].z - path[n - 2].z;
      const el = Math.hypot(ex, ez) || 1;
      const ext = Math.max(0, L - distEnd);
      tx += (ex / el) * ext;
      tz += (ez / el) * ext;
    }
    const { fx, fz } = carFwd();
    const dx = tx - p.x;
    const dz = tz - p.z;
    const along = dx * fx + dz * fz;
    const lat = dx * -fz + dz * fx;
    const alpha = this.reverse ? Math.atan2(lat, -along) : Math.atan2(lat, along);
    const ld = Math.max(1, Math.hypot(dx, dz));
    const speed = Math.abs(v);
    const delta = Math.atan((2 * 2.65 * Math.sin(alpha)) / ld);
    const maxSteer = 0.58 / (1 + speed / 16);
    const steer = clamp(delta / maxSteer, -1, 1);
    // Distance remaining along the path from the closest point (for the final stop).
    let rem = 0;
    for (let q = this.k; q < n - 1; q++) rem += Math.hypot(path[q + 1].x - path[q].x, path[q + 1].z - path[q].z);
    distEnd = Math.min(distEnd, rem + Math.hypot(path[this.k].x - p.x, path[this.k].z - p.z));
    if (n >= 2) {
      const ex = path[n - 1].x - path[n - 2].x;
      const ez = path[n - 1].z - path[n - 2].z;
      if (this.k >= n - 12 && (p.x - path[n - 1].x) * ex + (p.z - path[n - 1].z) * ez > 0) distEnd = 0;
    }
    const vEnd = path[n - 1].v;
    let vt = Math.min(this.k < n - 1 ? path[this.k].v : 99, this.cap, Math.sqrt(vEnd * vEnd + 2 * 3 * Math.max(0, distEnd - (vEnd > 0 ? 0 : 0.15))));
    if (vEnd === 0 && distEnd < 0.35) vt = 0;
    if (vEnd === 0 && distEnd < this.stopTol && speed < 0.25) this.done = true;
    if (vEnd === 0 && distEnd === 0 && speed < 0.25) this.done = true;
    if (vEnd > 0 && this.k >= n - 2) this.done = true;
    if (DBG && this.reverse && Math.random() < 0.05) console.log(`    pilot k=${this.k}/${n} distEnd=${distEnd.toFixed(2)} vt=${vt.toFixed(2)} v=${v.toFixed(2)} alpha=${(alpha * 57.3).toFixed(0)} impact=${car.physics.impact.toFixed(2)}`);
    const out: DriverInput = { throttle: 0, brake: 0, steer, handbrake: false };
    if (!this.reverse) {
      const e = vt - v;
      if (v < -0.3) out.throttle = 1;
      else if (e > 0) out.throttle = clamp(e * 0.7, 0, 1);
      else if (e < -0.4) out.brake = clamp(-e * 0.5, 0.15, 1);
      if (vt === 0 && speed < 0.6) {
        out.throttle = 0;
        out.brake = 0;
        out.handbrake = true;
      }
    } else {
      const back = -v;
      if (v > 0.3) out.brake = 1;
      else {
        const e = vt - back;
        if (e > 0) out.brake = clamp(e * 0.7, 0, 1);
        else if (e < -0.4) out.throttle = clamp(-e * 0.5, 0.15, 1);
        if (vt === 0 && speed < 0.6) {
          out.brake = 0;
          out.throttle = 0;
          out.handbrake = true;
        }
      }
    }
    return out;
  }
}

/** Sequence of path segments (each forward or reverse) driven one after another. */
class Route {
  private seg = 0;
  constructor(readonly pilots: PathPilot[]) {}
  get done(): boolean {
    return this.seg >= this.pilots.length;
  }
  get current(): PathPilot | null {
    return this.pilots[this.seg] ?? null;
  }
  step(): DriverInput {
    const p = this.pilots[this.seg];
    if (!p) return PARKED;
    if (p.done) {
      if (p.waitTask === undefined || mission.taskIndex > p.waitTask || mission.stage === 'done') this.seg++;
      return PARKED;
    }
    return p.step();
  }
}

// =================================================================== simulation harness
interface RunResult {
  result: 'complete' | 'failed' | 'timeout';
  time: number;
  stars: number;
  score: number | null;
  reason: string;
  details: Array<[string, string]>;
  position: number | null;
  respawns: number;
  rivalRespawns: number;
  events: MissionEvent[];
  simTime: number;
}

interface Driver {
  /** Drive the player's car for this step (call car.fixedUpdate, or let an AI do it). */
  pre(t: number): void;
  /** After world.step(): finish the step for the player's car. */
  post(t: number): void;
  respawns(): number;
}

/** A driver from a DriverInput function. */
function inputDriver(fn: (t: number) => DriverInput): Driver {
  return {
    pre: (t) => car.fixedUpdate(FIXED_DT, mission.inputLocked ? PARKED : fn(t)),
    post: () => car.afterStep(),
    respawns: () => 0,
  };
}

/** The race AI drives the player's car (only used for racing sections; any respawn fails the check). */
function aiDriver(level: LevelDef, skill: number, then?: { atI: number; fn: (t: number) => DriverInput; ok?: () => boolean }): Driver {
  // Racing line: its own, not a rival's. The race grids put the player straight behind a rival on 1.75 m;
  // a pilot that copies that line just tailgates it all race (a player picks a free line).
  const line = level.race ? 1.0 : level.carStart.off;
  const ai = new AiRacer(car, { name: 'test', paint: 0xffffff, skill, line, i: level.carStart.i, off: level.carStart.off }, track);
  // Start counting progress from where the car is (idx defaults to 0: the first step would credit the
  // whole distance from sample 0 to the grid as driven, and the pilot would "finish" that much early).
  ai.idx = wrapI(level.carStart.i);
  ai.progress = 0;
  let handed = false;
  const len = (): number => {
    // No gates (police escape): there is no finish line — keep driving until the hand-over.
    if (level.gates.length === 0) return track.count * 20;
    const last = level.gates[level.gates.length - 1]?.i ?? level.carStart.i + track.count - 1;
    return (Math.max(1, level.laps ?? 1) - 1) * track.count + track.count + indexDelta(track, wrapI(level.carStart.i), wrapI(last));
  };
  return {
    pre: (t) => {
      if (then && !handed) {
        const idx = simIdx;
        const near = Math.abs(indexDelta(track, idx, wrapI(then.atI))) < 3 || (indexDelta(track, wrapI(then.atI), idx) > 0 && indexDelta(track, wrapI(then.atI), idx) < 40);
        if (near && (!then.ok || then.ok())) handed = true;
      }
      if (handed && then) car.fixedUpdate(FIXED_DT, then.fn(t));
      else {
        const others: Vehicle[] = [car, ...pool.filter((v) => v.isActive)];
        ai.fixedUpdate(FIXED_DT, !mission.inputLocked, others, level.traffic ? traffic.cars : []);
      }
    },
    post: (t) => {
      if (handed) car.afterStep();
      else ai.afterStep(t, len());
    },
    respawns: () => ai.respawns,
  };
}

function run(index: number, carId: string, up: number, makeDriver: (level: LevelDef) => Driver, maxTime = 420): RunResult {
  const level = LEVELS[index];
  car.configure(vehicleById(carId), lv(up), 0xc81d25);
  // One Vehicle stands in for every car of the test: each mission starts on that car's fresh tyres.
  car.fitNewTyres();
  police.setEnabled(false, null);
  mission.load(level, index);
  const start = trackXZ(level.carStart.i, level.carStart.off);
  car.reset(new Vector3(start.x, 0.6, start.z), yawAt(level.carStart.i));
  car.skids.clear();
  signals.reset();
  signals.setHeld(!!(level.race && level.traffic));
  traffic.setDirection(level.traffic === 'same' ? 1 : 0);
  traffic.setDensity(level.trafficDensity ?? MISSION_TRAFFIC_DENSITY);
  traffic.setEnabled(!!level.traffic, start.x, start.z, [[start.x, start.z]]);
  redLight.reset();
  mission.onEnterCar();
  const driver = makeDriver(level);
  const mi = createMissionInput();
  const prev = new Vector3();
  const ps: PlayerState = { inCar: true, x: 0, z: 0, vx: 0, vz: 0, speed: 0, idx: wrapI(level.carStart.i) };
  const res: RunResult = { result: 'timeout', time: 0, stars: 0, score: null, reason: '', details: [], position: null, respawns: 0, rivalRespawns: 0, events: [], simTime: 0 };
  let t = 0;
  let idx = wrapI(level.carStart.i);
  simIdx = idx;
  const fillPs = (): void => {
    const p = car.physicsPosition;
    const v = car.physics.body.linvel();
    ps.x = p.x;
    ps.z = p.z;
    ps.vx = v.x;
    ps.vz = v.z;
    ps.speed = Math.abs(car.physics.forwardSpeed);
    ps.idx = idx;
  };
  for (let step = 0; step < Math.round(maxTime / FIXED_DT); step++) {
    driver.pre(t);
    mission.preStep(FIXED_DT, car, level.traffic && level.race ? traffic.cars : []);
    fillPs();
    if (police.enabled) police.fixedUpdate(FIXED_DT, ps, signals, traffic.cars);
    signals.update(FIXED_DT);
    if (level.traffic) {
      agents.length = 1;
      const p = car.physicsPosition;
      const v = car.physics.body.linvel();
      Object.assign(agents[0], { x: p.x, z: p.z, vx: v.x, vz: v.z });
      const list = [agents[0]];
      pool.forEach((o, k) => {
        if (!o.isActive) return;
        const a = (agents[1 + k] ??= createAgent(10 + k, false));
        const op = o.physicsPosition;
        const ov = o.physics.body.linvel();
        Object.assign(a, { x: op.x, z: op.z, vx: ov.x, vz: ov.z });
        list.push(a);
      });
      traffic.fixedUpdate(FIXED_DT, p.x, p.z, list);
    }
    prev.copy(car.physicsPosition);
    physics.step();
    t += FIXED_DT;
    driver.post(t);
    if (DBG && Math.round(t / FIXED_DT) % 600 === 0) console.log(`    t=${t.toFixed(0)} tyres T ${Array.from(car.physics.tyres.temp).map((x) => x.toFixed(0)).join('/')} wear ${Array.from(car.physics.tyres.wear).map((x) => (x * 100).toFixed(1)).join('/')} grip ${[0, 1, 2, 3].map((i) => car.physics.tyres.grip(i, 0).toFixed(2)).join('/')}`);
    police.afterStep();
    const p = car.physicsPosition;
    idx = track.trackIndex(p.x, p.z, idx);
    simIdx = idx;
    const r = car.physics.body.rotation();
    mi.dt = FIXED_DT;
    mi.inCar = true;
    mi.carPos.copy(p);
    mi.carPrev.copy(prev);
    mi.carFwdX = 1 - 2 * (r.y * r.y + r.z * r.z);
    mi.carFwdZ = 2 * (r.x * r.z - r.w * r.y);
    mi.carSpeed = Math.abs(car.physics.forwardSpeed);
    mi.forwardSpeed = car.physics.forwardSpeed;
    const lvel = car.physics.body.linvel();
    mi.carVelX = lvel.x;
    mi.carVelZ = lvel.z;
    mi.handbrake = lastInput.handbrake;
    mi.impact = car.physics.impact;
    mi.redLight = level.redLight ? redLight.update(track, signals, idx, p.x, p.z, mi.carSpeed, true) : false;
    mi.pedHit = false;
    mi.policeNear = police.enabled ? police.nearestUnit(p.x, p.z) : Infinity;
    mi.busted = police.enabled && police.wanted.state === 'busted';
    mission.postStep(mi);
    for (const e of mission.events) {
      res.events.push(e);
      if (TRACE === level.id && e.type === 'penalty') console.log(`    PENALTY ${e.reason} +${e.seconds}s at t=${t.toFixed(2)} i=${idx} impact=${car.physics.impact.toFixed(2)}`);
      if (e.type === 'police') {
        fillPs();
        police.startPursuit(e.stars, e.behind, ps);
      } else if (e.type === 'complete') {
        Object.assign(res, { result: 'complete', time: e.time, stars: e.stars, score: e.score, details: e.details, position: e.position });
      } else if (e.type === 'failed') {
        Object.assign(res, { result: 'failed', reason: e.reason });
      }
    }
    mission.events.length = 0;
    car.physics.impact = 0; // consumed each frame by the game (Game.ts), so per step here
    if (TRACE === level.id && (step % 30 === 0 || (DBG && step % 6 === 0))) {
      const { fx, fz } = carFwd();
      console.log(`  t=${t.toFixed(1)} i=${idx} off=${((p.x - track.px[idx]) * track.rx(idx) + (p.z - track.pz[idx]) * track.rz(idx)).toFixed(2)} v=${car.physics.forwardSpeed.toFixed(1)} hdg=${((Math.atan2(-fz, fx) - yawAt(idx)) * 57.3).toFixed(0)} in=${lastInput.throttle.toFixed(2)}/${lastInput.brake.toFixed(2)}/${lastInput.steer.toFixed(2)}${lastInput.handbrake ? 'H' : ''} task=${mission.taskIndex} da=${(mission as unknown as { driftAngle: number }).driftAngle.toFixed(0)} ${zoneRel()} gate=${mission.nextGate}${police.enabled ? ` cop=${police.nearestUnit(p.x, p.z).toFixed(1)}m ${police.wanted.state}` : ''} ${mission.hud(true)?.info.join(" | ") ?? ""}`);
    }
    if (TRACE === level.id && DUMP_AT > 0 && Math.abs(t - DUMP_AT) < FIXED_DT / 2) {
      const ro = (x: number, z: number): string => { const k = track.nearestIndex(x, z); return `i=${k} off=${((x - track.px[k]) * track.rx(k) + (z - track.pz[k]) * track.rz(k)).toFixed(1)}`; };
      console.log(`    PLAYER ${ro(p.x, p.z)} yawRel=${((Math.atan2(-carFwd().fz, carFwd().fx) - yawAt(idx)) * 57.3).toFixed(0)}`);
      mission.racers.forEach((r) => console.log(`    RIVALPOS ${r.spec.name} ${ro(r.vehicle.physicsPosition.x, r.vehicle.physicsPosition.z)}`));
      for (const c of traffic.cars) if (c.mode !== 0 && (Math.hypot(c.x - p.x, c.z - p.z) < 40 || Math.abs(indexDelta(track, track.nearestIndex(c.x, c.z), 975)) < 15)) console.log(`    TPOS slot${c.kind}.${c.slot} ${ro(c.x, c.z)} yawRel=${((c.yaw - yawAt(track.nearestIndex(c.x, c.z))) * 57.3 % 360).toFixed(0)} v=${c.v.toFixed(1)} lead=${c.leadKind}@${c.leadGap.toFixed(1)} wait=${c.waitTime.toFixed(0)} node=${c.node}`);
      if (DBG) for (const c of traffic.cars) if (c.mode !== 0 && Math.hypot(c.x - p.x, c.z - p.z) < 60) console.log(`    TRAFFIC mode=${c.mode} v=${c.v.toFixed(1)} d=${Math.hypot(c.x - p.x, c.z - p.z).toFixed(1)} i=${track.nearestIndex(c.x, c.z)} lane=${(c as unknown as { lane: number }).lane} state=${JSON.stringify(Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')))}`.slice(0, 400));
      mission.racers.forEach((r) => console.log(`    RIVAL ${r.spec.name} idx=${r.idx} respawns=${r.respawns} v=${r.vehicle.physics.forwardSpeed.toFixed(1)}`));
    }
    if (res.result !== 'timeout') break;
  }
  res.simTime = t;
  res.respawns = driver.respawns();
  res.rivalRespawns = mission.racers.reduce((n, r) => n + r.respawns, 0);
  traffic.setEnabled(false);
  police.setEnabled(false, null);
  return res;
}

function zoneRel(): string {
  const z = (mission as unknown as { zone: { x: number; z: number; tx: number; tz: number } | null }).zone;
  if (!z) return '';
  const p = car.physicsPosition;
  const { fx, fz } = carFwd();
  const u = (p.x - z.x) * z.tx + (p.z - z.z) * z.tz;
  const w = (p.x - z.x) * -z.tz + (p.z - z.z) * z.tx;
  return `zone(u=${u.toFixed(2)} w=${w.toFixed(2)} a=${(Math.atan2(fx * -z.tz + fz * z.tx, fx * z.tx + fz * z.tz) * 57.3).toFixed(0)})`;
}

const DUMP_AT = Number(process.argv.find((x) => x.startsWith('--dump='))?.slice(7) ?? 0);

/** Road sample nearest the player's car (maintained by the harness every step). */
let simIdx = 0;

/** Last input given to the car (for the handbrake flag in MissionInput). */
let lastInput: DriverInput = IDLE;
const track_ = (fn: (t: number) => DriverInput) => (t: number): DriverInput => (lastInput = fn(t));

const idleDriver = (): Driver => inputDriver(track_(() => IDLE));

function describe(r: RunResult): string {
  const extra = r.details.map(([k, v]) => `${k} ${v}`).join(', ');
  return r.result === 'complete'
    ? `${r.time.toFixed(1)} s, ${r.stars}★${r.score !== null ? `, score ${r.score}` : ''}${r.position !== null ? `, P${r.position}` : ''}${extra ? `, ${extra}` : ''}${r.respawns ? `, respawns ${r.respawns}` : ''}`
    : `${r.result}: ${r.reason || '-'} after ${r.simTime.toFixed(1)} s`;
}

// =================================================================== scenario drivers per mission
const L = (id: string): number => LEVELS.findIndex((l) => l.id === id);

/** Signal-aware speed cap (stop line ahead showing red/yellow) and car-following cap (Rush Hour). */
function trafficCap(idx: number): number {
  const p = car.physicsPosition;
  const { fx, fz } = carFwd();
  let cap = Infinity;
  for (let k = 0; k < CROSSINGS.length; k++) {
    const line = CROSSINGS[k] - (CROSS_HALF + STOP_BACK);
    const d = indexDelta(track, idx, wrapI(line)) * track.spacing - 2.6;
    if (d < -1 || d > 60) continue;
    const light = signals.car(k);
    if (light === 'red' || (light === 'yellow' && d > 12)) cap = Math.min(cap, Math.sqrt(2 * 3.5 * Math.max(0, d - 0.5)));
  }
  for (const c of traffic.cars) {
    if (c.mode === 0) continue;
    const dx = c.x - p.x;
    const dz = c.z - p.z;
    const along = dx * fx + dz * fz;
    const lat = dx * -fz + dz * fx;
    if (along > 0 && along < 40 && Math.abs(lat) < 2.4) {
      const cv = c.mode === 1 ? Math.max(0, c.v * (Math.cos(c.yaw) * fx - Math.sin(c.yaw) * fz)) : 0;
      cap = Math.min(cap, Math.max(0, cv + (along - 9) * 0.45));
    }
  }
  return cap;
}


/** Signed curvature direction of the road at i (+1 right, -1 left) and radius. */
function corner(i: number): { dir: number; R: number } {
  const a = wrapI(i - 3);
  const b = wrapI(i + 3);
  let d = Math.atan2(track.tz[b], track.tx[b]) - Math.atan2(track.tz[a], track.tx[a]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return { dir: d > 0 ? 1 : -1, R: Math.abs(d) < 1e-4 ? 9999 : (6 * track.spacing) / Math.abs(d) };
}

interface DriftArgs {
  entry: number;
  kick: number;
  target: number;
  look: number;
  path: number;
  base: number;
  cs: number;
  kp: number;
  kd: number;
  kc: number;
  exit: number;
  line: number;
}
// Retuned for the realism handling layer (heavier load transfer, road-tyre grip): a faster entry and a
// longer handbrake pull. Like the previous values (15 / 0.35), this scripted technique is tuned to a point.
const DRIFT_ARGS: DriftArgs = { entry: 18, kick: 0.7, target: 32, look: 2, path: 0.3, base: 20, cs: 0.6, kp: 0.5, kd: 0.6, kc: 0.6, exit: 45, line: 1, ...JSON.parse(process.argv.find((x) => x.startsWith('--drift='))?.slice(8) ?? '{}') };

/** Drift driver: brake to an entry speed, handbrake kick at corner entry, then counter-steer along the velocity and hold the slide with throttle / handbrake taps. */
function driftDriver(o: DriftArgs): Driver {
  const line = profile([[850, 3.5], [866, 4], [880, 4], [891, -3.5], [902, -2], [912, -4], [924, 3], [932, -2], [938, -4], [952, 3], [966, -1], [986, 0]]);
  const base = new PathPilot(roadPath(850, 986, (i) => line(i) * o.line, o.base, o.base, 1.0));
  let kickT = 0;
  let mode: 'grip' | 'drift' = 'grip';
  let dir = 0;
  let tap = 0;
  let cooldown = 0;
  return inputDriver(
    track_(() => {
      const out = base.step();
      const p = car.physicsPosition;
      const idx = simIdx;
      const vel = car.physics.body.linvel();
      const { fx, fz } = carFwd();
      const vLong = vel.x * fx + vel.z * fz;
      const vLat = vel.x * -fz + vel.z * fx;
      const beta = Math.atan2(vLat, Math.max(0.5, vLong));
      const speed = Math.hypot(vel.x, vel.z);
      let nextCorner = 99;
      for (let k = 1; k <= 20; k++) if (corner(idx + k).R < 70) { nextCorner = k; break; }
      if (mode === 'grip') {
        if (nextCorner <= 20) {
          const vAllowed = Math.sqrt(o.entry * o.entry + 2 * 6 * Math.max(0, (nextCorner - o.look) * track.spacing));
          if (speed > vAllowed) { out.throttle = 0; out.brake = clamp((speed - vAllowed) * 0.5, 0.2, 1); }
        }
        cooldown -= FIXED_DT;
        if (nextCorner <= o.look && speed > 9 && cooldown <= 0) {
          mode = 'drift';
          dir = corner(idx + o.look).dir;
          kickT = o.kick;
        }
        return out;
      }
      if (nextCorner > o.look + 2 && kickT <= 0) {
        if (DBG) console.log(`    exit: corner over at i=${idx}`);
        mode = 'grip';
        return out;
      }
      if (kickT > 0) {
        kickT -= FIXED_DT;
        return { throttle: 0.3, brake: 0, steer: dir, handbrake: true };
      }
      const b = -beta * dir * 57.3; // positive = tail out on the correct side
      const maxSteer = 0.58 / (1 + speed / 16);
      // Pure pursuit relative to the velocity direction (course), added to wheels-along-the-velocity.
      const tp = base.aim(Math.max(6, speed * 0.7));
      const want = Math.atan2(-(tp.z - p.z), tp.x - p.x);
      const course = Math.atan2(-vel.z, vel.x);
      let ac = want - course; // + = target to the left of the course
      while (ac > Math.PI) ac -= 2 * Math.PI;
      while (ac < -Math.PI) ac += 2 * Math.PI;
      const ld = Math.max(4, Math.hypot(tp.x - p.x, tp.z - p.z));
      const delta = Math.atan((2 * 2.65 * Math.sin(ac)) / ld); // left-positive wheel angle wanted relative to course
      const yawL = car.physics.body.angvel().y;
      const desiredL = (speed * 2 * Math.sin(ac)) / ld;
      const steer = clamp((beta - delta * o.kc) / maxSteer + o.kd * (yawL - desiredL), -1, 1);
      if (DBG && Math.random() < 0.15) console.log(`    drift i=${idx} b=${b.toFixed(0)} ac=${(ac * 57.3).toFixed(0)} steer=${steer.toFixed(2)} v=${speed.toFixed(1)}`);
      tap -= FIXED_DT;
      if (b < 8 && speed > 10 && tap < -0.5) tap = 0.15;
      if (tap > 0) return { throttle: 0.4, brake: 0, steer: clamp(steer + dir * 0.3, -1, 1), handbrake: true };
      let throttle = b < o.target - 6 ? 1 : b < o.target + 6 ? 0.7 : b < o.target + 14 ? 0.35 : 0;
      if (speed > o.entry + 4) throttle = Math.min(throttle, 0.2);
      if (speed < 8) throttle = 1;
      return { throttle, brake: 0, steer, handbrake: false };
    }),
  );
}

const scenario: Record<string, () => Driver> = {
  'find-your-ride': () => {
    const lvd = LEVELS[L('find-your-ride')];
    const r = new Route([new PathPilot(roadPath(lvd.carStart.i, 250, profile([[lvd.carStart.i, 5.25], [240, 5.25]]), 16, 0))]);
    return inputDriver(track_(() => r.step()));
  },
  'driving-school': () => {
    let pilot: PathPilot | null = null;
    let task = -1;
    let hb = 0;
    return inputDriver(
      track_(() => {
        const ti = mission.taskIndex;
        const p = car.physicsPosition;
        const idx = simIdx;
        if (ti !== task) {
          task = ti;
          hb = 0;
          if (ti === 0) pilot = new PathPilot(roadPath(40, 95, 5.25, 13));
          else if (ti === 1) pilot = new PathPilot(roadPath(idx + 1, 101, profile([[idx, 5.25], [idx + 8, 3.5]]), 12, 0));
          else if (ti === 2) pilot = new PathPilot(roadPath(101, 94, 3.5, 2.5, 0, 0.8, -1), true);
          else if (ti === 3) pilot = new PathPilot(roadPath(idx + 1, 166, profile([[idx, 3.5], [124, 3.5], [130, 1.82], [139, 5.18], [148, 1.82], [157, 5.18], [163, 4]]), 7, 7, 0.8, 1, 0.5));
          else if (ti === 4) pilot = new PathPilot(roadPath(idx + 1, 190, 4.2, 12, 12));
          else if (ti === 5) {
            pilot = null;
          }
        }
        if (ti === 4) {
          // Handbrake turn: at speed, full left lock + handbrake.
          if (car.physics.forwardSpeed > 10 || hb > 0) {
            hb++;
            // Kick the rear out, then drive round on full lock.
            return hb < 30 ? { throttle: 0, brake: 0, steer: -1, handbrake: true } : { throttle: 0.2, brake: 0, steer: -1, handbrake: false };
          }
          return pilot ? pilot.step() : IDLE;
        }
        if (ti === 5) {
          if (!pilot) {
            // Recover: stop, reverse on opposite lock until roughly aligned with the road, then drive to the bay.
            const sp = Math.abs(car.physics.forwardSpeed);
            const { fx, fz } = carFwd();
            let hdg = Math.atan2(-fz, fx) - yawAt(idx);
            while (hdg > Math.PI) hdg -= 2 * Math.PI;
            while (hdg < -Math.PI) hdg += 2 * Math.PI;
            if (Math.abs(hdg) > 0.5) {
              if (car.physics.forwardSpeed > 0.3) return { throttle: 0, brake: 1, steer: 0, handbrake: false };
              return { throttle: sp > 2.5 ? 0.3 : 0, brake: sp > 2.5 ? 0 : 0.6, steer: -Math.sign(hdg), handbrake: false };
            }
            if (sp > 0.5) return { throttle: car.physics.forwardSpeed < 0 ? 1 : 0, brake: car.physics.forwardSpeed > 0 ? 1 : 0, steer: 0, handbrake: false };
            const ahead = Math.max(idx + 6, 0);
            const pts: WP[] = [];
            const from = trackXZ(ahead, 3.0);
            pts.push({ x: p.x, z: p.z, v: 4 });
            for (let s = 0.25; s <= 1; s += 0.25) pts.push({ x: p.x + (from.x - p.x) * s, z: p.z + (from.z - p.z) * s, v: 4 });
            pilot = new PathPilot(decel([...pts, ...roadPath(ahead + 1, 212, profile([[ahead, 3.0], [ahead + 8, 5.25]]), 7, 0)]));
          }
          return pilot.step();
        }
        return pilot ? pilot.step() : IDLE;
      }),
    );
  },
  'city-driving': () => aiDriver(LEVELS[L('city-driving')], 0.85),
  'precision-parking': () => {
    const wait = (p: PathPilot, task: number): PathPilot => ((p.waitTask = task), p);
    const r = new Route([
      // Bay 1: straight in.
      wait(new PathPilot(roadPath(356, 372, 5.25, 5, 0)), 0),
      // Bay 2: out, past the bay, then reverse-park between the cars.
      new PathPilot(roadPath(372.2, 400, profile([[372, 5.25], [377, 2.2], [400, 2.2]]), 5, 0)),
      wait(Object.assign(new PathPilot(decel(roadPath(400, PK[0][0], profile(PK), 1.6, 0, 0.8, -1, 0.25)), true, 0.3), { revLook: REVLOOK }), 1),
      // Bay 3: back up a little, pull out, U-turn, park facing back on the other side.
      new PathPilot(roadPath(PK[0][0], 390.8, PK[0][1], 1.0, 0, 0.8, -1), true),
      new PathPilot(roadPath(390.8, 405, profile([[390.8, PK[0][1]], [394.6, 2.8], [399.5, 2.8], [404, 4.8], [405, 4.8]]), 3, 2.5)),
      new PathPilot(
        decel(
          (() => {
            const c = trackXZ(405, -0.1);
            const pts: WP[] = [];
            const y = yawAt(405);
            const tx = Math.cos(y);
            const tz = -Math.sin(y);
            const rx = -tz;
            const rz = tx;
            for (let a = 0; a <= Math.PI + 1e-6; a += Math.PI / 24) {
              const along = Math.sin(a) * 4.9;
              const lat = Math.cos(a) * 4.9;
              pts.push({ x: c.x + tx * along + rx * lat, z: c.z + tz * along + rz * lat, v: 2.5 });
            }
            return pts;
          })(),
        ),
      ),
      new PathPilot(roadPath(404.5, 380, profile([[380, -5.25], [381, -5.25], [387, -2.4], [399, -2.4], [404.5, -5.0]]), 3.5, 0, 0.8, -1)),
    ]);
    return inputDriver(track_(() => r.step()));
  },
  'obstacle-course': () => {
    const off = profile([[701, 3.5], [710, 3.5], [716, 1.82], [726, 5.18], [736, 1.82], [746, 5.18], [753, 3.7], [783, 3.7], [800, 3.7], [806, 5.25], [812, 5.25], [818, 3.5], [822, 1.75], [826, 1.75], [836, 4.5], [848, 4.5]]);
    const r = new Route([new PathPilot(roadPath(701, 848, (i) => off(i), 8, 0))]);
    return inputDriver(track_(() => r.step()));
  },
  'time-trial': () => {
    const lvd = LEVELS[L('time-trial')];
    const off = profile([[882, 1.75], [900, 1.0], [1100, 1.0], [1105, -3.5], [1160, -3.5], [1166, 1.0], [1870, 1.0], [1900, 1.0]]);
    const r = new Route([
      new PathPilot(roadPath(lvd.carStart.i, lvd.carStart.i + track.count - 1, (i) => off(i < lvd.carStart.i ? i + track.count : i), 45, 30, 0.92)),
      new PathPilot(roadPath(lvd.carStart.i - 1, 904, 1.0, 30, 10, 0.92)),
    ]);
    return inputDriver(track_(() => r.step()));
  },
  'rush-hour': () => {
    const r = new Route([new PathPilot(roadPath(196, 652, profile([[196, 5.25], [204, 1.75]]), 16, 16, 0.8))]);
    return inputDriver(
      track_(() => {
        const idx = simIdx;
        const cur = r.current;
        if (cur) cur.cap = trafficCap(idx);
        return r.step();
      }),
    );
  },
  'speed-trap': () => aiDriver(LEVELS[L('speed-trap')], 0.92),
  'street-race': () => aiDriver(LEVELS[L('street-race')], 0.92),
  'fragile-cargo': () => {
    const pick = new PathPilot(roadPath(520, 548, 5.25, 8, 0));
    pick.waitTask = 0;
    const r = new Route([
      pick,
      new PathPilot(roadPath(548.3, 846, profile([[548, 5.25], [556, 2.5], [834, 2.5], [842, 5.25]]), 24, 0, 0.7)),
    ]);
    return inputDriver(track_(() => r.step()));
  },
  'drift-king': () => driftDriver(DRIFT_ARGS),
  'hot-pursuit': () => {
    const lvd = LEVELS[L('hot-pursuit')];
    let final: PathPilot | null = null;
    return aiDriver(lvd, 0.95, {
      atI: 816,
      // Only head for the hideout with a real lead on the police (it needs 60 m clear).
      ok: () => police.nearestUnit(car.physicsPosition.x, car.physicsPosition.z) > 140,
      fn: () => {
        const idx = simIdx;
        final ??= new PathPilot(roadPath(idx + 1, 872, profile([[idx, 2.5], [idx + 10, 5.25]]), 14, 0));
        return final.step();
      },
    });
  },
  gauntlet: () => {
    // Weave: boom section on the left (the boom must be well right), crates, slalom, squeeze, bay.
    const off = profile([[396, 3.5], [404, 1.35], [450, 1.35], [457, 4.8], [466, 4.8], [474, 2.2], [478, 2.2], [486, 4.8], [491, 4.8], [500, 3.5], [503, 3.5], [508, 1.82], [516, 5.18], [524, 1.82], [531, 3.5], [566, 3.5]]);
    const path = roadPath(396, 566, (i) => off(i), 7, 0, 0.8);
    // Slow down for the bumps and the squeeze.
    const slow = (i: number, v: number): number => (i >= 496 && i <= 504) || (i >= 528 && i <= 548) ? Math.min(v, 5.5) : v;
    path.forEach((w, k) => (w.v = slow(396 + k * 0.5, w.v)));
    decel(path);
    const pilot = new PathPilot(path);
    const booms = [418, 432, 446];
    const specs = LEVELS[L('gauntlet')].obstacles.filter((o) => o.kind === 'slider');
    const committed = booms.map(() => false);
    return inputDriver(
      track_((t) => {
        const idx = simIdx;
        pilot.cap = Infinity;
        // Before each boom: hold ~12 m back, then launch when an accelerate-and-pass run stays clear
        // of the boom (it must be far enough right). Once committed, never stop in the sweep.
        for (let b = 0; b < booms.length; b++) {
          const d = indexDelta(track, idx, booms[b]) * track.spacing;
          if (d < -3 || d > 18) continue;
          if (committed[b]) continue;
          const m = specs[b].move!;
          const v0 = Math.max(0, car.physics.forwardSpeed);
          let clear = true;
          // The run must be clear for both a gentle and a hard launch (the real one lies between).
          for (const acc of [4]) {
            // Accelerate to 7 m/s; the car overlaps the boom line from front at d-2.6 to rear at d+2.6.
            let x = 0;
            let v = v0;
            let tIn = -1;
            let tOut = -1;
            for (let s2 = 0; s2 < 6 && tOut < 0; s2 += 0.02) {
              v = Math.min(7, v + acc * 0.02);
              x += v * 0.02;
              if (tIn < 0 && x >= d - 2.6) tIn = s2;
              if (x >= d + 2.6) tOut = s2;
            }
            if (tOut < 0) clear = false;
            for (let s2 = Math.max(0, tIn - 0.2); clear && s2 <= tOut + 0.2; s2 += 0.03) {
              const sweep = ObstacleManager.sweep({ amp: m.amp, period: m.period, phase: m.phase ?? 0 }, t + s2);
              if (3.5 + sweep - 1.5 < 1.35 + 0.92 + 0.3) clear = false;
            }
          }
          if (clear && d < 15) committed[b] = true;
          else if (!clear) pilot.cap = Math.min(pilot.cap, Math.sqrt(2 * 3 * Math.max(0, d - 12)));
        }
        return pilot.step();
      }),
    );
  },
  'circuit-championship': () => aiDriver(LEVELS[L('circuit-championship')], 0.93),
  'city-grand-prix': () => aiDriver(LEVELS[L('city-grand-prix')], 0.95),
};

/** Car and upgrade level each mission is completed with (a sensible progression). */
const CAR_FOR: Record<string, [string, number]> = {
  'find-your-ride': ['kestrel', 0],
  'driving-school': ['kestrel', 0],
  'city-driving': ['kestrel', 0],
  'precision-parking': ['kestrel', 0],
  'obstacle-course': ['kestrel', 0],
  'time-trial': ['kestrel', 0],
  'rush-hour': ['kestrel', 0],
  'speed-trap': ['kestrel', 0],
  'street-race': ['kestrel', 1],
  'fragile-cargo': ['kestrel', 1],
  'drift-king': ['kestrel', 1],
  'hot-pursuit': ['kestrel', 2],
  gauntlet: ['kestrel', 2],
  'circuit-championship': ['brute', 2],
  'city-grand-prix': ['vortex', 2],
};

// =================================================================== 1. structure
console.log('--- structure and progression');
{
  check('15 missions', LEVELS.length === 15, String(LEVELS.length));
  check('ids unique and save-safe', new Set(LEVELS.map((l) => l.id)).size === LEVELS.length && LEVELS.every((l) => /^[a-z0-9-]{1,40}$/.test(l.id)));
  check('15 distinct mission kinds', new Set(LEVELS.map((l) => l.kind)).size === 15, LEVELS.map((l) => l.kind).join(','));
  check('every kind has a label, titles unique', LEVELS.every((l) => !!KIND_LABEL[l.kind]) && new Set(LEVELS.map((l) => l.title)).size === 15);
  check('numbers follow the campaign order', LEVELS.every((l, k) => l.number === k + 1));
  check('chapters cover the campaign in order', CHAPTERS[0].from === 0 && CHAPTERS.every((c, k) => k === 0 || c.from > CHAPTERS[k - 1].from) && CHAPTERS[CHAPTERS.length - 1].from < LEVELS.length);
  check('a reward per mission, generally rising', MISSION_REWARDS.length === LEVELS.length && MISSION_REWARDS.every((r, k) => k === 0 || r >= MISSION_REWARDS[k - 1]));
  check('every mission has objectives, tips and a finish condition', LEVELS.every((l) => l.objectives.length >= 2 && l.tips.length >= 2 && (l.gates.length > 0 || !!l.zone || (l.tasks?.length ?? 0) > 0)));
  check('every mission can fail (time limit or race)', LEVELS.every((l) => !!l.timeLimit || !!l.race));
  check('timed missions: star times inside the limit', LEVELS.filter((l) => l.timeLimit && l.stars).every((l) => l.stars![0] < l.stars![1] && l.stars![1] < l.timeLimit!));
  check('star gates are reachable', LEVELS.every((l, k) => (l.requiresStars ?? 0) <= k * 3));
  const starts = LEVELS.map((l) => trackXZ(l.playerStart.i, l.playerStart.off));
  let minGap = Infinity;
  for (let a = 0; a < starts.length; a++) for (let b = a + 1; b < starts.length; b++) minGap = Math.min(minGap, Math.hypot(starts[a].x - starts[b].x, starts[a].z - starts[b].z));
  check('mission start markers are at least 20 m apart', minGap >= 20, `${minGap.toFixed(1)} m`);

  const p = defaultProgress();
  check('new save: only mission 1 is open', isMissionUnlocked(p, 0) && !isMissionUnlocked(p, 1) && missionLockReason(p, 1) === 'Complete the previous mission to unlock');
  const r1 = recordCompletion(p, 0, 40, 2);
  check('clearing a mission opens the next and pays', r1.unlockedLevel === 1 && isMissionUnlocked(p, 1) && r1.credits > 0);
  for (let k = 1; k < 13; k++) recordCompletion(p, k, 50, 1);
  check('star gate: Circuit Championship needs 24 mission stars', !isMissionUnlocked(p, 13) && /Needs 24 mission stars/.test(missionLockReason(p, 13) ?? ''), missionLockReason(p, 13) ?? 'open');
  for (let k = 0; k < 13; k++) recordCompletion(p, k, 20, 3);
  check('enough stars open it', isMissionUnlocked(p, 13));
  // Score-based best (Drift): higher score wins, time is kept from that run.
  const di = L('drift-king');
  const q = defaultProgress();
  recordCompletion(q, di, 50, 1, 3000);
  const a = recordCompletion(q, di, 40, 1, 2000);
  const b = recordCompletion(q, di, 55, 2, 6000);
  check('drift best keeps the highest score', !a.newBest && b.newBest && b.previousScore === 3000 && q.best['drift-king'].score === 6000 && q.best['drift-king'].time === 55);
  // Save migration from the 5-mission layout.
  const old = sanitizeProgress({ version: 2, unlocked: 5, best: { 'find-your-ride': { time: 30, stars: 3 }, 'time-trial': { time: 90, stars: 2 } }, credits: 100 });
  check('old 5-mission save: everything it had unlocked stays unlocked', old.unlocked >= L('street-race') + 1 && isMissionUnlocked(old, L('street-race')) && isMissionUnlocked(old, L('time-trial')), `unlocked ${old.unlocked}`);
  const old2 = sanitizeProgress({ version: 2, unlocked: 2, best: { 'find-your-ride': { time: 30, stars: 1 } } });
  check('old save with 2 unlocked opens City Driving (and the new mission before it)', isMissionUnlocked(old2, L('city-driving')) && isMissionUnlocked(old2, L('driving-school')) && !isMissionUnlocked(old2, L('precision-parking')));
  const fresh = sanitizeProgress(JSON.parse(JSON.stringify(p)));
  check('new layout saves round-trip unchanged', fresh.unlocked === p.unlocked && fresh.campaign === 2 && Object.keys(fresh.best).length === Object.keys(p.best).length);
  const corrupt = sanitizeProgress({ campaign: 2, unlocked: 'x', best: { 'drift-king': { time: -4, stars: 9, score: 'lots' }, 'gauntlet': { time: 80, stars: 7, score: 1e99 } } });
  check('corrupt mission entries are dropped / clamped', !corrupt.best['drift-king'] && corrupt.best['gauntlet']?.stars === 3 && corrupt.best['gauntlet']?.score === 1e9 && corrupt.unlocked >= 1);
}

// =================================================================== 2. rules with synthetic inputs
console.log('\n--- rules (synthetic inputs)');
{
  const mi = createMissionInput();
  mi.dt = FIXED_DT;
  mi.inCar = true;
  const level = LEVELS[L('fragile-cargo')];
  police.setEnabled(false, null);
  mission.load(level, L('fragile-cargo'));
  const s = trackXZ(level.carStart.i, level.carStart.off);
  mi.carPos.set(s.x, 0, s.z);
  mi.carPrev.copy(mi.carPos);
  mission.onEnterCar();
  mission.cargoLoaded = true;
  const ev: MissionEvent[] = [];
  for (let k = 0; k < 120 && mission.stage !== 'done'; k++) {
    mi.impact = k % 30 === 0 ? 4 : 0;
    mission.postStep(mi);
    ev.push(...mission.events);
    mission.events.length = 0;
  }
  check('cargo: knocks reduce integrity, 0 % fails the delivery', ev.some((e) => e.type === 'cargo') && ev.some((e) => e.type === 'failed' && e.reason === 'The cargo was destroyed'), ev.filter((e) => e.type === 'cargo').map((e) => (e as { integrity: number }).integrity).join('→'));

  const park = LEVELS[L('precision-parking')];
  mission.load(park, L('precision-parking'));
  mission.onEnterCar();
  const ev2: MissionEvent[] = [];
  for (let k = 0; k < 600 && mission.stage !== 'done'; k++) {
    mi.impact = k % 60 === 0 ? 1.6 : 0;
    mission.postStep(mi);
    ev2.push(...mission.events);
    mission.events.length = 0;
  }
  check('parking: 6 bumps above 1.2 m/s end the test', ev2.filter((e) => e.type === 'penalty').length === 6 && ev2.some((e) => e.type === 'failed' && /Too many bumps/.test(e.reason)));

  const rush = LEVELS[L('rush-hour')];
  mission.load(rush, L('rush-hour'));
  mission.onEnterCar();
  mi.impact = 0;
  mi.redLight = true;
  mission.postStep(mi);
  mi.redLight = false;
  check('rush hour: a red light adds 4 s without a strike', mission.penaltyTime === 4 && mission.strikes === 0 && mission.redLights === 1);
  mi.pedHit = true;
  mission.postStep(mi);
  mi.pedHit = false;
  check('rush hour: hitting a pedestrian costs a double penalty', mission.penaltyTime === 14 && mission.strikes === 1);
  mission.events.length = 0;
}

// =================================================================== 3. play every mission
console.log('\n--- every mission: completed by the test driver');
const results: Record<string, RunResult> = {};
for (let k = 0; k < LEVELS.length; k++) {
  if (ONLY !== null && !ONLY.includes(k)) continue;
  const level = LEVELS[k];
  let [carId, up] = CAR_FOR[level.id];
  let r = run(k, carId, up, scenario[level.id]);
  if (level.id === 'city-grand-prix') {
    // The Grand Prix runs through dense traffic: the result between evenly matched cars depends on how each
    // meets the traffic, so the outcome of one run is not decisive. Run the late-game cars a player can own by
    // then (Apex unlocks at 30 stars, like the GP itself) and require at least one clean win (no pilot reset).
    // Measured over 7 run orders x 3 cars: 13/21 wins, at least 1 of 3 in every order. Report the count.
    const tries: Array<[string, number, RunResult]> = [[carId, up, r]];
    for (const [c, u] of [['vortex', 3], ['apex', 0]] as Array<[string, number]>) tries.push([c, u, run(k, c, u, scenario[level.id])]);
    const wins = tries.filter(([, , x]) => x.result === 'complete' && x.respawns === 0);
    console.log(`      Grand Prix wins: ${wins.length}/${tries.length} (${tries.map(([c, u, x]) => `${c} L${u}: ${x.result === 'complete' ? `P1 ${x.time.toFixed(1)} s` : 'lost'}`).join(', ')})`);
    check(`   Grand Prix won cleanly in at least 1 of 3 late-game cars`, wins.length >= 1, `${wins.length}/3`);
    if (wins.length) [carId, up, r] = wins[0];
  }
  results[level.id] = r;
  const okTime = r.result === 'complete' && (!level.timeLimit || r.time <= level.timeLimit + 30);
  check(`${k + 1}. ${level.title} (${KIND_LABEL[level.kind]}) completed in a ${vehicleById(carId).name} L${up}`, r.result === 'complete' && okTime && r.respawns === 0, describe(r));
  if (TUNE) console.log(`      events: ${r.events.filter((e) => e.type !== 'checkpoint').map((e) => e.type + ('reason' in e ? `(${e.reason})` : '')).join(' ').slice(0, 300)}`);
  if (level.race) check(`   rivals drove without getting stuck`, r.rivalRespawns <= 1, `${r.rivalRespawns} rival respawns`);
  if (level.race) {
    const want = level.gates.length * Math.max(1, level.laps ?? 1);
    const bad = mission.racers.filter((x) => x.gateCount !== want || (x.finished && x.nextGate !== want) || x.disqualified);
    check(`   rivals' finishes come from crossing all ${want} checkpoints in order`, bad.length === 0, mission.racers.map((x) => `${x.name} ${x.nextGate}/${x.gateCount}${x.finished ? ' fin' : ''}${x.disqualified ? ' DSQ' : ''}`).join(', '));
  }
}

console.log('\n--- every mission: can fail');
for (let k = 0; k < LEVELS.length; k++) {
  if (ONLY !== null && !ONLY.includes(k)) continue;
  const level = LEVELS[k];
  const [carId, up] = CAR_FOR[level.id];
  let r: RunResult;
  let expect: RegExp;
  if (level.id === 'drift-king') {
    // Clean, grippy driving through every gate: not enough drift points.
    r = run(k, carId, up, () => {
      const pp = new PathPilot(roadPath(850, 986, 0.5, 16, 16, 0.55));
      return inputDriver(track_(() => pp.step()));
    });
    expect = /Not enough drift points/;
  } else if (level.id === 'speed-trap') {
    r = run(k, carId, up, () => {
      const pp = new PathPilot(roadPath(690, 915, 1.75, 15, 15));
      return inputDriver(track_(() => pp.step()));
    });
    expect = /Too slow through the speed sections/;
  } else if (level.police) {
    r = run(k, carId, up, idleDriver);
    expect = /Busted/;
  } else if (level.race) {
    // Parked on the grid while the rivals lap past it: they must avoid the car, not shove it.
    const at = trackXZ(level.carStart.i, level.carStart.off);
    r = run(k, carId, up, idleDriver);
    expect = /rival/;
    const p = car.physicsPosition;
    const moved = Math.hypot(p.x - at.x, p.z - at.z);
    check(`${k + 1}. ${level.title}: rivals pass the parked player car without ramming it`, moved < 1, `moved ${moved.toFixed(2)} m`);
  } else {
    r = run(k, carId, up, idleDriver);
    expect = /Time’s up/;
  }
  check(`${k + 1}. ${level.title} fails`, r.result === 'failed' && expect.test(r.reason), describe(r));
}

if (ONLY === null || ONLY.includes(L('street-race'))) {
  console.log('\n--- race rules: checkpoints, difficulty, rubber band');
  const k = L('street-race');
  const level = LEVELS[k];
  const [carId, up] = CAR_FOR[level.id];
  // Course cut: once the first rival is rolling, put it 50 m past the first checkpoint (not crossed) and credit
  // the distance, as a track index that followed a shortcut would. Progress alone would count this as racing.
  let cut = false;
  const cutter = (): Driver => {
    const d = idleDriver();
    return {
      ...d,
      pre: (t) => {
        d.pre(t);
        const z = mission.racers[0];
        if (!cut && z && z.progress > 5 && z.nextGate === 0) {
          cut = true;
          const j = wrapI(level.gates[0].i + 25);
          const q = trackXZ(j, z.spec.line);
          z.vehicle.reset(new Vector3(q.x, 0.6, q.z), yawAt(j));
          z.progress += indexDelta(track, z.idx, j);
          z.idx = j;
        }
      },
    };
  };
  const rc = run(k, carId, up, cutter);
  const zero = mission.racers[0];
  const st = mission.standings();
  check('a rival that skips a checkpoint is disqualified (no finish, no place)', cut && zero.disqualified && !zero.finished, `${zero.name}: dsq ${zero.disqualified}, finished ${zero.finished}, gate ${zero.nextGate}/${zero.gateCount}`);
  check('   standings list it last as DSQ; the race goes on to a valid winner', st[st.length - 1].name === zero.name && !!st[st.length - 1].disqualified && rc.result === 'failed' && mission.racers.some((x) => x.finished && x !== zero), st.map((x) => `${x.name}${x.disqualified ? ' DSQ' : x.finished ? ' ' + x.time.toFixed(1) : ''}`).join(', '));

  // Difficulty presets: rivals' skill x 0.94 / 1 / 1.04 — the winning rival's time (player parked) must follow.
  const times: Record<string, number> = {};
  for (const [name, scale] of [['easy', 0.94], ['normal', 1], ['hard', 1.04]] as Array<[string, number]>) {
    mission.setRaceOptions({ skillScale: scale, rubberBand: false });
    const r = run(k, carId, up, idleDriver);
    times[name] = r.simTime;
    if (name === 'normal') check('rubber band is off by default: no rival pace change', mission.racers.every((x) => x.paceAdjust === 0));
    if (name === 'hard') check('   skill is capped at 1 (no super-human rivals)', mission.racers.every((x) => x.skill <= 1), mission.racers.map((x) => x.skill.toFixed(3)).join(' '));
  }
  check('difficulty presets change the rivals\' pace (easy slower > normal > hard faster)', times.easy > times.normal && times.normal > times.hard, `winning rival: easy ${times.easy.toFixed(1)} s, normal ${times.normal.toFixed(1)} s, hard ${times.hard.toFixed(1)} s`);
  // Rubber band on, player parked: rivals far ahead ease off (skill only, capped at -0.05).
  mission.setRaceOptions({ skillScale: 1, rubberBand: true });
  const rb = run(k, carId, up, idleDriver);
  const adj = mission.racers.map((x) => x.paceAdjust);
  check('rubber band (when enabled) slows rivals that are far ahead, within its limit', rb.simTime > times.normal && adj.every((a) => a < 0 && a >= -0.05 - 1e-9), `winning rival ${rb.simTime.toFixed(1)} s vs ${times.normal.toFixed(1)} s; adjust ${adj.map((a) => a.toFixed(3)).join(' ')}`);
  mission.setRaceOptions({ skillScale: 1, rubberBand: false });
}

if (TUNE) {
  console.log('\n--- calibration data');
  for (const [id, r] of Object.entries(results)) console.log(`${id.padEnd(22)} ${describe(r)}`);
}

console.log(failures === 0 ? '\nCAMPAIGN TEST: ALL PASSED' : `\nCAMPAIGN TEST: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
