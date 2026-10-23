import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../PhysicsWorld';
import { mulberry32 } from '../world/random';
import { LANES, LaneGraph } from './LaneGraph';
import { KIND_HALF, TRAFFIC_PAINTS, type TrafficKind, type TrafficRenderer } from './TrafficModels';
import type { TrafficSignals } from './TrafficSignals';

/**
 * Something the traffic must not drive into: the player's car or character, race opponents,
 * police cars, pedestrians on the carriageway. The owner fills a reusable array every step.
 */
const ALL_LANES: readonly number[] = LANES.map((_, k) => k);
const FORWARD_LANES: readonly number[] = LANES.map((l, k) => (l.dir === 1 ? k : -1)).filter((k) => k >= 0);

export interface TrafficAgent {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Half extent along the road (m). */
  halfLen: number;
  /** Half extent across the road (m). */
  halfWidth: number;
  person: boolean;
  /** Dynamic vehicles can knock traffic cars out of their lane. */
  vehicle: boolean;
  /** Owner-defined id (reported in collision events). */
  id: number;
  /** Track index hint (maintained by the traffic system). */
  hint: number;
}

export function createAgent(id: number, person: boolean): TrafficAgent {
  return { x: 0, z: 0, vx: 0, vz: 0, halfLen: person ? 0.35 : 2.3, halfWidth: person ? 0.35 : 1.0, person, vehicle: !person, id, hint: 0 };
}

export type TrafficEvent =
  | { type: 'hit'; car: number; agent: number; speed: number; x: number; z: number }
  | { type: 'horn'; car: number; x: number; z: number }
  /** A threatened driver stopped and got out (driver door point x/z, car yaw). */
  | { type: 'abandon'; car: number; x: number; z: number; yaw: number };

/** What a traffic car turns into when the player takes it (see {@link TrafficSystem.release}). */
export interface ReleasedCar {
  kind: TrafficKind;
  paint: number;
  x: number;
  z: number;
  yaw: number;
}

/** Braking of a threatened driver (m/s²) and the speed above which they flee instead of stopping. */
const HOLD_DECEL = 6;
const FLEE_SPEED = 9;

const enum Mode {
  Off = 0,
  Drive = 1,
  Wreck = 2,
}

// Intelligent Driver Model parameters.
const IDM_A = 1.8; // max acceleration (m/s²)
const IDM_B = 3.0; // comfortable deceleration (m/s²)
const IDM_S0 = 2.5; // jam distance (m)
const IDM_T = 1.25; // time headway (s)
const MAX_DECEL = 9;
const LOOKAHEAD = 90;
const LANE_CHANGE_TIME = 2.6;
const SPAWN_MIN = 140;
const SPAWN_MAX = 270;
const DESPAWN = 310;
/** Closing speed (m/s) above which a dynamic vehicle knocks a traffic car out of its lane. */
const KNOCK_SPEED = 2.5;

class Car {
  mode = Mode.Off;
  node = 0;
  u = 0;
  v = 0;
  personal = 1;
  /** Driver-frame lateral offset from the lane centre (m, + = right); non-zero during lane changes. */
  latFrom = 0;
  changeT = 1;
  fromLane = -1;
  cooldown = 0;
  leadGap = Infinity;
  leadV = 0;
  leadKind = 0; // 0 none, 1 car, 2 agent, 3 stop line, 4 static block
  committed = false;
  braking = false;
  waitTime = 0;
  hornCooldown = 0;
  restTime = 0;
  x = 0;
  z = 0;
  yaw = 0;
  px = 0;
  pz = 0;
  pyaw = 0;
  /** Quaternion of the body (wrecks tumble; driving cars only yaw). */
  qx = 0;
  qy = 0;
  qz = 0;
  qw = 1;
  pq = [0, 0, 0, 1];
  y = 0;
  py = 0;
  /** A driver is at the wheel (false once they got out: the car never rejoins the traffic). */
  occupied = true;
  /** Threatened: braking to a stop, then the driver gets out. */
  held = false;
  /** Seconds of panicked fast driving left (threatened at speed). */
  fleeing = 0;
  paint = 0;
  constructor(
    readonly kind: TrafficKind,
    readonly slot: number,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
  ) {}
  get halfLen(): number {
    return KIND_HALF[this.kind].x;
  }
}

export interface TrafficStats {
  active: number;
  driving: number;
  wrecks: number;
  laneChanges: number;
  forcedChanges: number;
  redStops: number;
  violations: number;
  hits: number;
  minGap: number;
}

export class TrafficSystem {
  readonly cars: Car[] = [];
  readonly events: TrafficEvent[] = [];
  readonly stats: TrafficStats = { active: 0, driving: 0, wrecks: 0, laneChanges: 0, forcedChanges: 0, redStops: 0, violations: 0, hits: 0, minGap: Infinity };
  private enabled = false;
  private target = 0;
  private tick = 0;
  private focusHint = 0;
  private readonly rnd = mulberry32(4242);
  private readonly L: number;
  private readonly loop: number;
  /** Per lane: sorted node slots (k) carrying a stop line, and the signal index. */
  private readonly stops: Array<Array<[number, number]>> = [];
  private readonly agentS = new Float32Array(64);
  private readonly agentLat = new Float32Array(64);
  private readonly agentTi = new Int32Array(64);

  constructor(
    private readonly physics: PhysicsWorld,
    readonly graph: LaneGraph,
    private readonly signals: TrafficSignals,
    private readonly renderer: TrafficRenderer | null,
    capacity: readonly number[],
  ) {
    const { R, world } = physics;
    this.loop = graph.track.length;
    this.L = this.loop / graph.perLane;
    for (let kind = 0 as TrafficKind; kind < capacity.length; kind = (kind + 1) as TrafficKind) {
      for (let slot = 0; slot < capacity[kind]; slot++) {
        const he = KIND_HALF[kind];
        const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -60 - this.cars.length * 4, 0).setLinearDamping(0.6).setAngularDamping(2.5));
        const col = world.createCollider(R.ColliderDesc.cuboid(he.x, he.y, he.z).setTranslation(0, he.y + 0.12, 0).setDensity(1250 / (8 * he.x * he.y * he.z)).setFriction(0.55).setRestitution(0.1), body);
        body.setEnabled(false);
        this.cars.push(new Car(kind, slot, body, col));
      }
    }
    for (let l = 0; l < LANES.length; l++) {
      const list: Array<[number, number]> = [];
      for (let k = 0; k < graph.perLane; k++) {
        const s = graph.stopLine[l * graph.perLane + k];
        if (s >= 0) list.push([k, s]);
      }
      this.stops.push(list);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 0 = traffic in both directions, 1 = only in the driving direction of the track. */
  private dir: 0 | 1 = 0;

  setDirection(dir: 0 | 1): void {
    this.dir = dir;
  }

  /** Number of cars to keep around the focus point. */
  setDensity(n: number): void {
    this.target = Math.max(0, Math.min(this.cars.length, Math.round(n)));
  }

  /** Turn the traffic on (populating the road around the focus) or off (removing every car). */
  setEnabled(on: boolean, focusX = 0, focusZ = 0, avoid: ReadonlyArray<readonly [number, number]> = []): void {
    for (const c of this.cars) if (c.mode !== Mode.Off) this.despawn(c);
    this.enabled = on;
    this.events.length = 0;
    this.updateStats();
    if (!on) return;
    const g = this.graph;
    const fi = g.track.nearestIndex(focusX, focusZ);
    this.focusHint = fi;
    // Populate both directions, evenly, keeping clear of the focus and given points (parked car).
    let guard = 0;
    while (this.activeCount() < this.target && guard++ < 400) {
      const along = (this.rnd() * 2 - 1) * SPAWN_MAX;
      if (Math.abs(along) < 40) continue;
      this.trySpawn(fi + Math.round(along / g.track.spacing), avoid);
    }
    this.updateStats();
  }

  private activeCount(): number {
    let n = 0;
    for (const c of this.cars) if (c.mode !== Mode.Off) n++;
    return n;
  }

  /** Centre-line position of a car along its own lane (m, in [0, loop)). */
  private sOf(c: Car): number {
    const g = this.graph;
    return ((c.node % g.perLane) + c.u / g.segLen[c.node]) * this.L;
  }

  private trySpawn(trackIndex: number, avoid: ReadonlyArray<readonly [number, number]> = []): boolean {
    const g = this.graph;
    // Direction filter (City Grand Prix): only lanes driving the way of the track.
    const r = this.rnd();
    const lanes = this.dir === 1 ? FORWARD_LANES : ALL_LANES;
    const lane = lanes[Math.min(lanes.length - 1, Math.floor(r * lanes.length))];
    const node = g.nodeAt(lane, trackIndex);
    for (let d = -3; d <= 6; d++) {
      let j = node;
      for (let s = 0; s < Math.abs(d); s++) j = g.next[j];
      if (g.blocked[j] || g.crossing[j]) return false;
    }
    const x = g.x[node];
    const z = g.z[node];
    for (const [ax, az] of avoid) if ((ax - x) ** 2 + (az - z) ** 2 < 30 * 30) return false;
    const s = (node % g.perLane) * this.L;
    for (const o of this.cars) {
      if (o.mode === Mode.Off) continue;
      if (o.mode === Mode.Wreck) {
        if ((o.x - x) ** 2 + (o.z - z) ** 2 < 30 * 30) return false;
        continue;
      }
      const ol = g.lane[o.node];
      if (ol !== lane && o.fromLane !== lane) continue;
      const ds = Math.abs(this.wrap(this.sOf(o) - s));
      if (ds < 26) return false;
    }
    const free = this.cars.find((c) => c.mode === Mode.Off && (this.rnd() < 0.72 ? c.kind === 0 : c.kind === 1)) ?? this.cars.find((c) => c.mode === Mode.Off);
    if (!free) return false;
    free.mode = Mode.Drive;
    free.node = node;
    free.u = 0;
    free.personal = 0.82 + this.rnd() * 0.3;
    free.v = g.speed[node] * free.personal * 0.8;
    free.changeT = 1;
    free.latFrom = 0;
    free.fromLane = -1;
    free.cooldown = 2 + this.rnd() * 3;
    free.leadGap = Infinity;
    free.leadKind = 0;
    free.waitTime = 0;
    free.restTime = 0;
    free.committed = false;
    free.occupied = true;
    free.held = false;
    free.fleeing = 0;
    const { R } = this.physics;
    free.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
    free.body.setEnabled(true);
    // The paint is only drawn when there is a renderer (as before: headless runs keep the same random
    // sequence, so their traffic is unchanged by the crime update).
    free.paint = this.renderer ? TRAFFIC_PAINTS[Math.floor(this.rnd() * TRAFFIC_PAINTS.length)] : TRAFFIC_PAINTS[0];
    this.renderer?.setPaint(free.kind, free.slot, free.paint);
    this.pose(free);
    free.px = free.x;
    free.pz = free.z;
    free.pyaw = free.yaw;
    free.body.setTranslation({ x: free.x, y: 0, z: free.z }, true);
    free.body.setRotation({ x: 0, y: Math.sin(free.yaw / 2), z: 0, w: Math.cos(free.yaw / 2) }, true);
    return true;
  }

  /**
   * The player threatens the driver of car `i`: a car that is slow enough brakes to a stop and the driver
   * gets out ('abandon' event); a fast one speeds away instead. Returns what the driver did.
   */
  threaten(i: number): 'stop' | 'flee' | 'none' {
    const c = this.cars[i];
    if (!c || c.mode !== Mode.Drive || !c.occupied || c.held) return 'none';
    if (c.v > FLEE_SPEED) {
      c.fleeing = 6;
      return 'flee';
    }
    c.held = true;
    return 'stop';
  }

  /** Index of the active car whose collider is `handle`, or -1. */
  carByCollider(handle: number): number {
    for (let i = 0; i < this.cars.length; i++) if (this.cars[i].mode !== Mode.Off && this.cars[i].collider.handle === handle) return i;
    return -1;
  }

  /**
   * Take car `i` out of the traffic (the player is getting in): it disappears from the simulation and its
   * pose / body / paint are returned so a drivable vehicle can take its place.
   */
  release(i: number): ReleasedCar | null {
    const c = this.cars[i];
    if (!c || c.mode === Mode.Off) return null;
    const out: ReleasedCar = { kind: c.kind, paint: c.paint, x: c.x, z: c.z, yaw: c.yaw };
    this.despawn(c);
    return out;
  }

  private despawn(c: Car): void {
    c.mode = Mode.Off;
    const { R } = this.physics;
    c.body.setBodyType(R.RigidBodyType.KinematicPositionBased, false);
    c.body.setTranslation({ x: 0, y: -60 - c.slot * 4 - c.kind * 100, z: 0 }, false);
    c.body.setEnabled(false);
    this.renderer?.hide(c.kind, c.slot);
  }

  private wrap(d: number): number {
    const L = this.loop;
    d %= L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  /** Lane position → world pose (x, z, yaw) including the lane-change offset. */
  private pose(c: Car): void {
    const g = this.graph;
    const a = c.node;
    const b = g.next[a];
    const f = Math.min(1, c.u / g.segLen[a]);
    let hx = g.dx[a] + (g.dx[b] - g.dx[a]) * f;
    let hz = g.dz[a] + (g.dz[b] - g.dz[a]) * f;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    let lat = 0;
    let latRate = 0;
    if (c.changeT < 1) {
      const t = c.changeT;
      const sm = t * t * (3 - 2 * t);
      lat = c.latFrom * (1 - sm);
      latRate = (-c.latFrom * 6 * t * (1 - t)) / LANE_CHANGE_TIME;
    }
    // Driver-frame right = (-hz, hx)
    c.x = g.x[a] + (g.x[b] - g.x[a]) * f - hz * lat;
    c.z = g.z[a] + (g.z[b] - g.z[a]) * f + hx * lat;
    const yawRoad = Math.atan2(-hz, hx);
    c.yaw = yawRoad - Math.atan2(latRate, Math.max(c.v, 3));
  }

  // ------------------------------------------------------------------ simulation

  /**
   * One fixed step. `focus` is the player's position (spawning is centred on it); `agents` are the
   * dynamic things on or near the road the cars must respect.
   */
  fixedUpdate(dt: number, focusX: number, focusZ: number, agents: readonly TrafficAgent[]): void {
    if (!this.enabled) return;
    this.tick++;
    const g = this.graph;
    const t = g.track;
    // Agents: track position (cheap windowed search from the previous hint).
    const na = Math.min(agents.length, this.agentS.length);
    for (let k = 0; k < na; k++) {
      const a = agents[k];
      a.hint = t.trackIndex(a.x, a.z, a.hint, 12);
      this.agentTi[k] = a.hint;
      this.agentLat[k] = g.lateral(a.hint, a.x, a.z);
    }
    this.focusHint = t.trackIndex(focusX, focusZ, this.focusHint, 20);

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.mode === Mode.Off) continue;
      c.px = c.x;
      c.pz = c.z;
      c.pyaw = c.yaw;
      c.py = c.y;
      c.pq[0] = c.qx;
      c.pq[1] = c.qy;
      c.pq[2] = c.qz;
      c.pq[3] = c.qw;
      if (c.mode === Mode.Wreck) {
        this.stepWreck(c, dt);
        continue;
      }
      const far = Math.abs(this.wrap((g.trackIdx[c.node] - this.focusHint) * t.spacing)) > 150;
      if ((this.tick + i) % (far ? 12 : 4) === 0) this.decide(c, i, agents, na);
      this.drive(c, i, dt);
      if (this.checkKnock(c, i, agents, na)) continue;
      const half = c.yaw / 2;
      c.qx = 0;
      c.qy = Math.sin(half);
      c.qz = 0;
      c.qw = Math.cos(half);
      c.y = 0;
      c.body.setNextKinematicTranslation({ x: c.x, y: 0, z: c.z });
      c.body.setNextKinematicRotation({ x: 0, y: c.qy, z: 0, w: c.qw });
    }
    if (this.tick % 30 === 0) this.manage(focusX, focusZ);
    this.updateStats();
  }

  private drive(c: Car, _i: number, dt: number): void {
    const g = this.graph;
    c.cooldown -= dt;
    c.hornCooldown -= dt;
    // Desired speed: the slower of here and a few nodes ahead (bends were smoothed at build time).
    let v0 = g.speed[c.node];
    const n1 = g.next[c.node];
    v0 = Math.min(v0, g.speed[n1], g.speed[g.next[n1]]) * c.personal;
    // Lead gap is extrapolated between decisions.
    if (c.leadKind !== 0) c.leadGap += (c.leadV - c.v) * dt;
    const v = c.v;
    let acc = IDM_A * (1 - Math.pow(v / Math.max(v0, 0.5), 4));
    if (c.leadKind !== 0 && c.leadGap < LOOKAHEAD + 20) {
      const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * (v - c.leadV)) / (2 * Math.sqrt(IDM_A * IDM_B)));
      const gap = Math.max(c.leadGap, 0.05);
      acc -= IDM_A * (sStar / gap) * (sStar / gap);
    }
    if (c.fleeing > 0) {
      // Threatened at speed: the driver floors it (still following the lane and the car ahead).
      c.fleeing -= dt;
      acc = Math.max(acc, Math.min(IDM_A * 1.6, (v0 * 1.35 - v) * 2));
      if (c.leadKind !== 0 && c.leadGap < 10) acc = Math.min(acc, -IDM_B);
    }
    if (c.held) acc = Math.min(acc, -HOLD_DECEL);
    acc = Math.max(-MAX_DECEL, Math.min(c.fleeing > 0 ? IDM_A * 1.6 : IDM_A, acc));
    c.v = Math.max(0, v + acc * dt);
    if (c.leadKind !== 0 && c.leadGap < 0.4) c.v = 0;
    c.braking = acc < -0.9 || (c.v < 0.4 && c.leadKind !== 0 && c.leadGap < 12);
    // Advance along the lane.
    c.u += c.v * dt;
    while (c.u >= g.segLen[c.node]) {
      c.u -= g.segLen[c.node];
      c.node = g.next[c.node];
      const sig = g.stopLine[c.node];
      if (sig >= 0) {
        if (this.signals.car(sig) === 'red' && !c.committed) this.stats.violations++;
        c.committed = false;
      }
    }
    if (c.changeT < 1) {
      c.changeT = Math.min(1, c.changeT + dt / LANE_CHANGE_TIME);
      if (c.changeT >= 1) c.fromLane = -1;
    }
    // Waiting behind something that does not move (a parked car, a person): honk, then go around.
    if (c.v < 0.3 && c.leadKind === 2 && c.leadV < 0.3) c.waitTime += dt;
    else c.waitTime = 0;
    if (c.held && c.v === 0) {
      // Stopped: the driver gets out on the driver's side (left-hand drive) and the car stays where it is.
      this.pose(c);
      const i = this.cars.indexOf(c);
      const fx = Math.cos(c.yaw);
      const fz = -Math.sin(c.yaw);
      const side = KIND_HALF[c.kind].z + 0.55;
      this.events.push({ type: 'abandon', car: i, x: c.x + fz * side - fx * 0.3, z: c.z - fx * side - fz * 0.3, yaw: c.yaw });
      c.held = false;
      c.occupied = false;
      this.toWreck(c);
      return;
    }
    if (c.waitTime > 3.5 && c.hornCooldown <= 0) {
      c.hornCooldown = 7;
      this.events.push({ type: 'horn', car: this.cars.indexOf(c), x: c.x, z: c.z });
    }
    this.pose(c);
  }

  /** Leader search (cars, agents, stop lines, static blockers) and lane-change decision. */
  private decide(c: Car, _i: number, agents: readonly TrafficAgent[], na: number): void {
    const g = this.graph;
    const t = g.track;
    const lane = g.lane[c.node];
    const sC = this.sOf(c);
    const hl = c.halfLen;
    let gap = Infinity;
    let lv = 0;
    let kind = 0;
    const consider = (d: number, otherHalf: number, v: number, k: number): void => {
      const gg = d - hl - otherHalf;
      if (d > -hl && gg < gap) {
        gap = gg;
        lv = v;
        kind = k;
      }
    };
    // Other traffic in this lane (or still half in it during a lane change).
    for (const o of this.cars) {
      if (o === c || o.mode !== Mode.Drive) continue;
      const ol = g.lane[o.node];
      const inLane = ol === lane || (o.fromLane === lane && o.changeT < 0.55);
      const iAmLeaving = c.fromLane >= 0 && c.changeT < 0.45 && (ol === c.fromLane || o.fromLane === c.fromLane);
      if (!inLane && !iAmLeaving) continue;
      const d = this.wrap(this.sOf(o) - sC);
      if (d > 0 && d < LOOKAHEAD) consider(d, o.halfLen, o.v, 1);
    }
    // Wrecks and agents: project onto this lane.
    const dir = LANES[lane].dir;
    for (const o of this.cars) {
      if (o.mode !== Mode.Wreck) continue;
      const ti = t.trackIndex(o.x, o.z, g.trackIdx[c.node], 50);
      const lat = g.lateral(ti, o.x, o.z);
      if (Math.abs(lat - LANES[lane].offset) > 0.9 + 1.4 + 0.3) continue;
      const s = dir > 0 ? ti * t.spacing : this.loop - ti * t.spacing;
      const d = this.wrap(s - sC);
      if (d > 0 && d < LOOKAHEAD) consider(d, o.halfLen, 0, 2);
    }
    for (let k = 0; k < na; k++) {
      const a = agents[k];
      const lat = this.agentLat[k];
      if (Math.abs(lat - LANES[lane].offset) > 0.9 + a.halfWidth + 0.3) continue;
      const ti = this.agentTi[k];
      const s = dir > 0 ? ti * t.spacing : this.loop - ti * t.spacing;
      const d = this.wrap(s - sC);
      // People: anywhere from our rear bumper forward. Vehicles only when they are really ahead (centre in
      // front of ours) — a car beside or behind us must not stop us (that deadlocks both).
      if ((a.person ? d <= -hl : d <= 0.5) || d > LOOKAHEAD) continue;
      const vAlong = a.person ? 0 : a.vx * t.tx[ti] * dir + a.vz * t.tz[ti] * dir;
      consider(d, a.person ? a.halfWidth : a.halfLen, Math.max(0, vAlong), 2);
    }
    // Signals.
    const stops = this.stops[lane];
    const k0 = c.node % g.perLane;
    for (const [k, sig] of stops) {
      const steps = (k - k0 + g.perLane) % g.perLane;
      const d = steps * this.L - (c.u / g.segLen[c.node]) * this.L;
      if (d < -0.5 || d > LOOKAHEAD) continue;
      const light = this.signals.car(sig);
      if (light === 'green') {
        c.committed = false;
        continue;
      }
      if (light === 'yellow' && !c.committed) {
        const stopDist = (c.v * c.v) / (2 * 3.2);
        if (d - hl < stopDist + 1) c.committed = true; // too close to stop comfortably: go
      }
      if (c.committed) continue;
      if (d - hl < gap) {
        gap = d - hl;
        lv = 0;
        kind = 3;
      }
      break;
    }
    // Static obstacles in the lane ahead.
    let j = c.node;
    let dd = -(c.u / g.segLen[c.node]) * this.L;
    let blockedAhead = Infinity;
    for (let s = 0; s < 14; s++) {
      if (g.blocked[j] && dd > -2) {
        blockedAhead = dd;
        break;
      }
      dd += this.L;
      j = g.next[j];
    }
    if (blockedAhead < Infinity && blockedAhead - hl - 2 < gap) {
      gap = blockedAhead - hl - 2;
      lv = 0;
      kind = 4;
    }
    if (kind === 3 && c.leadKind !== 3 && c.v > 1) this.stats.redStops++;
    c.leadGap = gap;
    c.leadV = lv;
    c.leadKind = kind;
    if (gap < this.stats.minGap && kind === 1) this.stats.minGap = gap;

    // ---- Lane change (MOBIL-like): only between same-direction lanes, never in a crossing.
    if (c.changeT < 1 || c.cooldown > 0 || g.crossing[c.node]) return;
    const forced = kind === 4 && gap < 55;
    const stuck = kind === 2 && c.waitTime > 5.5;
    const slowLeader = (kind === 1 || kind === 2) && gap < 35 && lv < g.speed[c.node] * c.personal * 0.6;
    if (kind === 3 && gap < 25) return; // queueing at a red light: stay in lane
    const inner = lane === 0 || lane === 2;
    const keepRight = inner && kind !== 4 && (gap > 60 || kind === 0) && this.rnd() < 0.08;
    if (!forced && !stuck && !slowLeader && !keepRight) return;
    const sides = keepRight ? [g.right[c.node]] : [g.left[c.node], g.right[c.node]];
    for (const target of sides) {
      if (target < 0) continue;
      if (this.laneChangeSafe(c, target, forced || stuck, agents, na)) {
        this.startChange(c, target, forced || stuck);
        return;
      }
    }
  }

  private laneChangeSafe(c: Car, target: number, relaxed: boolean, agents: readonly TrafficAgent[], na: number): boolean {
    const g = this.graph;
    const t = g.track;
    const tl = g.lane[target];
    // Target lane must be open for the next ~45 m.
    let j = target;
    for (let s = 0; s < 12; s++) {
      if (g.blocked[j]) return false;
      j = g.next[j];
    }
    const sC = this.sOf(c);
    const back = relaxed ? 7 : 12;
    const front = relaxed ? 9 : 16;
    for (const o of this.cars) {
      if (o === c || o.mode === Mode.Off) continue;
      if (o.mode === Mode.Wreck) {
        if ((o.x - c.x) ** 2 + (o.z - c.z) ** 2 < 14 * 14) return false;
        continue;
      }
      const ol = g.lane[o.node];
      if (ol !== tl && o.fromLane !== tl) continue;
      const d = this.wrap(this.sOf(o) - sC);
      if (d < 0 && -d - c.halfLen - o.halfLen < Math.max(back, (o.v - c.v) * 2.5 + back)) return false;
      if (d >= 0 && d - c.halfLen - o.halfLen < Math.max(front, (c.v - o.v) * 2 + front)) return false;
    }
    const dir = LANES[tl].dir;
    for (let k = 0; k < na; k++) {
      const a = agents[k];
      if (Math.abs(this.agentLat[k] - LANES[tl].offset) > 0.9 + a.halfWidth + 0.5) continue;
      const ti = this.agentTi[k];
      const s = dir > 0 ? ti * t.spacing : this.loop - ti * t.spacing;
      const d = this.wrap(s - sC);
      if (d > -20 && d < 30) return false;
    }
    return true;
  }

  private startChange(c: Car, target: number, forced: boolean): void {
    const g = this.graph;
    const fromLane = g.lane[c.node];
    const isRight = g.right[c.node] === target;
    const f = c.u / g.segLen[c.node];
    c.node = target;
    c.u = f * g.segLen[target];
    c.fromLane = fromLane;
    c.latFrom = isRight ? -3.5 : 3.5;
    c.changeT = 0;
    c.cooldown = 6 + this.rnd() * 4;
    c.waitTime = 0;
    c.leadKind = 0;
    c.leadGap = Infinity;
    this.stats.laneChanges++;
    if (forced) this.stats.forcedChanges++;
  }

  /** A dynamic vehicle about to hit a lane-following car turns it into a free physics body. */
  private checkKnock(c: Car, i: number, agents: readonly TrafficAgent[], na: number): boolean {
    const hx = Math.cos(c.yaw);
    const hz = -Math.sin(c.yaw);
    for (let k = 0; k < na; k++) {
      const a = agents[k];
      if (!a.vehicle) continue;
      const dx = a.x - c.x;
      const dz = a.z - c.z;
      if (dx * dx + dz * dz > 49) continue;
      const lx = dx * hx + dz * hz;
      const lz = -dx * hz + dz * hx;
      if (Math.abs(lx) > c.halfLen + 2.3 + 0.7 || Math.abs(lz) > KIND_HALF[c.kind].z + 1.0 + 0.7) continue;
      const rvx = a.vx - hx * c.v;
      const rvz = a.vz - hz * c.v;
      const dl = Math.hypot(dx, dz) || 1;
      const closing = -(rvx * dx + rvz * dz) / dl;
      if (closing < KNOCK_SPEED) continue;
      this.toWreck(c);
      this.stats.hits++;
      this.events.push({ type: 'hit', car: i, agent: a.id, speed: closing, x: c.x, z: c.z });
      return true;
    }
    return false;
  }

  private toWreck(c: Car): void {
    const { R } = this.physics;
    c.mode = Mode.Wreck;
    c.restTime = 0;
    c.braking = true;
    const half = c.yaw / 2;
    c.body.setBodyType(R.RigidBodyType.Dynamic, true);
    c.body.setTranslation({ x: c.x, y: 0.02, z: c.z }, true);
    c.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    c.body.setLinvel({ x: Math.cos(c.yaw) * c.v, y: 0, z: -Math.sin(c.yaw) * c.v }, true);
    c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private stepWreck(c: Car, dt: number): void {
    const p = c.body.translation();
    const r = c.body.rotation();
    c.x = p.x;
    c.z = p.z;
    c.y = p.y;
    c.qx = r.x;
    c.qy = r.y;
    c.qz = r.z;
    c.qw = r.w;
    c.yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.z * r.z));
    const lv = c.body.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    c.restTime = speed < 0.3 ? c.restTime + dt : 0;
    if (c.restTime > 3) this.tryRecover(c);
  }

  /** A wreck that came to rest upright and roughly in a lane re-joins the traffic from there. */
  private tryRecover(c: Car): void {
    const g = this.graph;
    const t = g.track;
    const upright = 1 - 2 * (c.qx * c.qx + c.qz * c.qz) > 0.9;
    if (!c.occupied) return; // abandoned: nobody to drive it away
    const ti = t.nearestIndex(c.x, c.z);
    const lat = g.lateral(ti, c.x, c.z);
    const lane = LaneGraph.laneForOffset(lat);
    c.restTime = 0;
    if (!upright || lane < 0) return;
    const dir = LANES[lane].dir;
    const align = Math.cos(c.yaw) * t.tx[ti] * dir - Math.sin(c.yaw) * t.tz[ti] * dir;
    if (align < 0.85 || Math.abs(lat - LANES[lane].offset) > 1.2) return;
    const node = g.nodeAt(lane, ti);
    // Never recover into another car.
    for (const o of this.cars) if (o !== c && o.mode !== Mode.Off && (o.x - g.x[node]) ** 2 + (o.z - g.z[node]) ** 2 < 8 * 8) return;
    const { R } = this.physics;
    c.mode = Mode.Drive;
    c.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
    c.node = node;
    c.u = 0;
    c.v = 0;
    c.changeT = 1;
    c.fromLane = -1;
    c.leadKind = 0;
    c.leadGap = Infinity;
    c.cooldown = 3;
    this.pose(c);
  }

  /** Despawn far cars, spawn new ones out of sight to keep the target density around the focus. */
  private manage(focusX: number, focusZ: number): void {
    const g = this.graph;
    const t = g.track;
    for (const c of this.cars) {
      if (c.mode === Mode.Off) continue;
      const ti = c.mode === Mode.Drive ? g.trackIdx[c.node] : t.trackIndex(c.x, c.z, this.focusHint, 200);
      const d = Math.abs(this.wrap((ti - this.focusHint) * t.spacing));
      const direct = Math.hypot(c.x - focusX, c.z - focusZ);
      if (d > DESPAWN && direct > 120) this.despawn(c);
    }
    let n = this.activeCount();
    for (let attempt = 0; attempt < 4 && n < this.target; attempt++) {
      const along = (SPAWN_MIN + this.rnd() * (SPAWN_MAX - SPAWN_MIN)) * (this.rnd() < 0.5 ? -1 : 1);
      const ti = this.focusHint + Math.round(along / t.spacing);
      const x = t.px[((ti % t.count) + t.count) % t.count];
      const z = t.pz[((ti % t.count) + t.count) % t.count];
      if (Math.hypot(x - focusX, z - focusZ) < 110) continue; // the loop folds back near some streets
      if (this.trySpawn(ti)) n++;
    }
  }

  private updateStats(): void {
    let a = 0;
    let d = 0;
    let w = 0;
    for (const c of this.cars) {
      if (c.mode === Mode.Off) continue;
      a++;
      if (c.mode === Mode.Drive) d++;
      else w++;
    }
    this.stats.active = a;
    this.stats.driving = d;
    this.stats.wrecks = w;
  }

  /** Visual interpolation between the last two fixed steps. */
  render(alpha: number): void {
    const r = this.renderer;
    if (!r) return;
    for (const c of this.cars) {
      if (c.mode === Mode.Off) continue;
      const x = c.px + (c.x - c.px) * alpha;
      const z = c.pz + (c.z - c.pz) * alpha;
      if (c.mode === Mode.Drive) {
        let dy = c.yaw - c.pyaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const yaw = c.pyaw + dy * alpha;
        r.set(c.kind, c.slot, x, 0, z, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2), c.braking);
      } else {
        r.set(c.kind, c.slot, x, c.py + (c.y - c.py) * alpha, z, c.qx, c.qy, c.qz, c.qw, true);
      }
    }
    r.commit();
  }

  /** Snapshot for tests: [x, z, speed, lane, mode] per active car. */
  snapshot(): Array<{ x: number; z: number; v: number; lane: number; mode: number; leadKind: number; gap: number }> {
    const out = [];
    for (const c of this.cars) {
      if (c.mode === Mode.Off) continue;
      out.push({ x: c.x, z: c.z, v: c.v, lane: this.graph.lane[c.node], mode: c.mode, leadKind: c.leadKind, gap: c.leadGap });
    }
    return out;
  }

  dispose(): void {
    for (const c of this.cars) this.physics.world.removeRigidBody(c.body);
    this.cars.length = 0;
  }
}
