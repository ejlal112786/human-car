import { ROAD } from '../config';
import type { TrafficSignals } from '../traffic/TrafficSignals';
import { createAgent, type TrafficAgent } from '../traffic/TrafficSystem';
import { CROSSINGS } from '../world/Crossings';
import type { Track } from '../world/Track';

/**
 * Pedestrian simulation (no rendering, no physics bodies).
 *
 * Pedestrians live in track coordinates — arc length `s` along the road centre line and a signed
 * lateral offset `lat` — and walk on four one-way sidewalk lines (inner + outer on each side). Static
 * furniture and props are avoided by choosing a clear lateral offset inside the sidewalk band ahead
 * of each pedestrian; the band itself guarantees they never leave the sidewalk except on a marked
 * crossing, which they only enter on a WALK light with enough time left to finish.
 * Vehicles that drive at them trigger a dodge; anything slow (a parked car, the player on foot) is
 * treated as an obstacle and walked around.
 */

const CURB = ROAD.halfWidth + ROAD.curbWidth; // 7.35
/** Sidewalk band usable by pedestrians (|lat|), with margin to the curb and to the building line. */
export const PED_BAND_MIN = CURB + 0.4;
export const PED_BAND_MAX = ROAD.halfWidth + ROAD.curbWidth + ROAD.sidewalkWidth - 0.35;
export const PED_RADIUS = 0.28;
/** Kerb-side waiting offset at a crossing. */
const WAIT_LAT = CURB + 0.65;

/** Sidewalk lines: side (+1 right of the track direction), nominal |lat|, walking direction along s. */
export const PED_LINES: ReadonlyArray<{ side: number; lat: number; dir: number }> = [
  { side: 1, lat: 8.75, dir: 1 },
  { side: 1, lat: 10.85, dir: -1 },
  { side: -1, lat: 8.75, dir: -1 },
  { side: -1, lat: 10.85, dir: 1 },
];

export const enum PedMode {
  Off = 0,
  Walk = 1,
  Pause = 2,
  ToCurb = 3,
  Wait = 4,
  Cross = 5,
  Dodge = 6,
  Stumble = 7,
  /** Hands up, standing still (threatened at gunpoint). */
  Surrender = 8,
  /** Standing still on the phone to the police; reports after the call. */
  Phone = 9,
  /** Knocked down (stylised, non-graphic): lies flat for a while, then gets up and runs. */
  Down = 10,
  /** Off the carriageway to the sidewalk at a run (a driver who left their car). */
  ToSidewalk = 11,
}

export const PED_VARIANT_COUNT = 12;
const PED_APPEARANCE_CYCLE = [6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4, 5] as const;
interface GroupLead { leader: Pedestrian; id: number; s: number; line: number; pace: number; dir: number; }

export interface Pedestrian {
  mode: PedMode;
  s: number;
  lat: number;
  /** Walking direction along s (+1 / -1). */
  dir: number;
  /** Line index into PED_LINES (side follows it). */
  line: number;
  side: number;
  /** Preferred walking speed and current actual speed (m/s). */
  pace: number;
  speed: number;
  x: number;
  z: number;
  yaw: number;
  prevX: number;
  prevZ: number;
  prevYaw: number;
  /** Visual variant (outfit) and height scale. */
  variant: number;
  scale: number;
  /** Shared id for a small sidewalk pair (keeps their pace and spacing coherent). */
  groupId: number;
  timer: number;
  crossing: number;
  crossFrom: number;
  crossTo: number;
  cooldown: number;
  dodgeX: number;
  dodgeZ: number;
  /** Lateral dodge direction (sign of lat change). */
  dodgeLat: number;
  targetLat: number;
  blockedTime: number;
  /** Whether this pedestrian is updated at the reduced (far) rate this tick. */
  far: boolean;
  acc: number;
  /** Along-track position of the danger being fled. */
  fleeS: number;
  /** A driver who got out of a car (allowed on the carriageway until they reach the sidewalk). */
  fromCar: boolean;
  /** Seconds of panicked running left (fleeing danger along the sidewalk). */
  panic: number;
  /** Seconds since being knocked down (render: fall animation). */
  downT: number;
}

/** Something pedestrians must react to: the player (car or on foot), race cars, wrecks. */
export interface PedThreat {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Heading (rad, car convention: forward = (cos, -sin)); ignored for people. */
  yaw: number;
  halfLen: number;
  halfWidth: number;
  person: boolean;
}

export type PedEvent =
  | { type: 'pedHit'; ped: number; speed: number; x: number; z: number }
  /** A witness finished a call to the police about the player. */
  | { type: 'report'; ped: number; x: number; z: number }
  | { type: 'pedDown'; ped: number; x: number; z: number };

/** Danger the player causes near pedestrians. */
export type Alarm = 'shot' | 'aim' | 'crash';
/** Seconds of panicked running after an alarm, call duration, time lying down. */
const PANIC_TIME = 9;
const CALL_TIME = 4.5;
const DOWN_TIME = 7;
/** At most this many witnesses on the phone at the same time. */
const MAX_CALLERS = 2;

export interface PedStats {
  active: number;
  crossStarted: number;
  crossDone: number;
  /** Crossings started without a WALK light with >= MIN_WALK_LEFT seconds remaining (must stay 0). */
  badStarts: number;
  /** Samples of a pedestrian on the carriageway while not on a marked crossing (must stay 0). */
  offCrossingRoad: number;
  /** Samples of a pedestrian on the carriageway of a crossing whose car light is green. */
  onRoadAtGreen: number;
  dodges: number;
  hits: number;
  flees: number;
  surrenders: number;
  calls: number;
  reports: number;
  knockdowns: number;
  drivers: number;
  turnarounds: number;
  /** Smallest clearance to a static obstacle seen (m, surface to body). */
  minClear: number;
  /** Smallest centre distance between two pedestrians (walking / waiting). */
  minSep: number;
}

const MIN_WALK_LEFT = 3;
const CROSS_PACE = 1.35;
const HURRY_PACE = 2.3;
const RUN_PACE = 3.6;
const FAR_DIST = 80;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PedestrianSystem {
  readonly peds: Pedestrian[] = [];
  readonly events: PedEvent[] = [];
  readonly stats: PedStats = {
    active: 0,
    crossStarted: 0,
    crossDone: 0,
    badStarts: 0,
    offCrossingRoad: 0,
    onRoadAtGreen: 0,
    dodges: 0,
    hits: 0,
    flees: 0,
    surrenders: 0,
    calls: 0,
    reports: 0,
    knockdowns: 0,
    drivers: 0,
    turnarounds: 0,
    minClear: Infinity,
    minSep: Infinity,
  };
  /** Where the smallest obstacle clearance was observed (diagnostics for tests). */
  minClearInfo = '';
  minSepInfo = '';
  private enabled = false;
  private density = 0;
  private tick = 0;
  private appearanceSerial = 0;
  private groupSerial = 1;
  private groupPending: GroupLead | null = null;
  private focusS = 0;
  private focusHint = 0;
  private readonly rnd = mulberry32(9137);
  /** Static obstacles bucketed by nearest track sample: flat [x, z, r] triples. */
  private readonly staticBuckets: number[][];
  private readonly dynBuckets: number[][];
  /** Obstacles from slow threats, rebuilt every tick (flat [x, z, r]). */
  private readonly transient: number[] = [];
  private readonly agentPool: TrafficAgent[] = [];
  private readonly crossS: number[];
  private readonly propCache: number[] = [];

  constructor(
    private readonly track: Track,
    private readonly signals: TrafficSignals,
    staticObstacles: ReadonlyArray<readonly [number, number, number]>,
    capacity: number,
  ) {
    const n = track.count;
    this.staticBuckets = Array.from({ length: n }, () => []);
    this.dynBuckets = Array.from({ length: n }, () => []);
    for (const [x, z, r] of staticObstacles) {
      const i = track.nearestIndex(x, z);
      if (track.distanceTo(x, z) > PED_BAND_MAX + r + 1) continue;
      this.staticBuckets[i].push(x, z, r);
    }
    this.crossS = CROSSINGS.map((c) => c * track.spacing);
    for (let k = 0; k < capacity; k++) {
      this.peds.push({
        mode: PedMode.Off, s: 0, lat: 0, dir: 1, line: 0, side: 1, pace: 1.3, speed: 0, x: 0, z: 0, yaw: 0, prevX: 0, prevZ: 0, prevYaw: 0,
        variant: k % PED_VARIANT_COUNT, scale: k % PED_VARIANT_COUNT === 7 ? 0.84 : 1, groupId: -1, timer: 0, crossing: -1, crossFrom: 0, crossTo: 0, cooldown: 0, dodgeX: 0, dodgeZ: 0, dodgeLat: 0, targetLat: 0,
        blockedTime: 0, far: false, acc: 0, panic: 0, downT: 0, fleeS: 0, fromCar: false,
      });
      this.agentPool.push(createAgent(100 + k, true));
    }
  }

  get capacity(): number {
    return this.peds.length;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setDensity(n: number): void {
    this.density = Math.max(0, Math.min(this.peds.length, Math.round(n)));
  }

  /** Update the moveable-prop obstacles (flat [x, z, r] triples). Cheap when nothing moved. */
  setDynamicObstacles(flat: readonly number[]): void {
    const t = this.track;
    let same = flat.length === this.propCache.length;
    if (same) for (let k = 0; k < flat.length; k++) if (Math.abs(flat[k] - this.propCache[k]) > 0.05) { same = false; break; }
    if (same) return;
    this.propCache.length = 0;
    this.propCache.push(...flat);
    for (const b of this.dynBuckets) b.length = 0;
    for (let k = 0; k < flat.length; k += 3) {
      const x = flat[k];
      const z = flat[k + 1];
      if (t.distanceTo(x, z) > PED_BAND_MAX + 2 || t.distanceTo(x, z) < CURB - 1.5) continue;
      this.dynBuckets[t.nearestIndex(x, z)].push(x, z, flat[k + 2]);
    }
  }

  // ------------------------------------------------------------------ geometry
  private wrapS(s: number): number {
    const L = this.track.length;
    return ((s % L) + L) % L;
  }

  /** Signed along-track difference a - b in (-L/2, L/2]. */
  private ds(a: number, b: number): number {
    const L = this.track.length;
    let d = (a - b) % L;
    if (d > L / 2) d -= L;
    if (d <= -L / 2) d += L;
    return d;
  }

  /** World XZ of track coordinates. */
  pos(s: number, lat: number, out: { x: number; z: number }): void {
    const t = this.track;
    const f = this.wrapS(s) / t.spacing;
    const i0 = Math.floor(f) % t.count;
    const i1 = (i0 + 1) % t.count;
    const u = f - Math.floor(f);
    const rx = t.rx(i0) * (1 - u) + t.rx(i1) * u;
    const rz = t.rz(i0) * (1 - u) + t.rz(i1) * u;
    out.x = t.px[i0] * (1 - u) + t.px[i1] * u + rx * lat;
    out.z = t.pz[i0] * (1 - u) + t.pz[i1] * u + rz * lat;
  }

  private readonly tmpA = { x: 0, z: 0 };
  private readonly tmpB = { x: 0, z: 0 };

  /** Clearance (surface distance) from a world point to the nearest obstacle near sample index i. */
  private clearance(x: number, z: number, i: number, ignoreTransient = false): number {
    const n = this.track.count;
    let best = Infinity;
    for (let d = -3; d <= 3; d++) {
      const k = (i + d + n) % n;
      for (const list of [this.staticBuckets[k], this.dynBuckets[k]]) {
        for (let q = 0; q < list.length; q += 3) {
          const c = Math.hypot(x - list[q], z - list[q + 1]) - list[q + 2];
          if (c < best) best = c;
        }
      }
    }
    if (!ignoreTransient) {
      const tr = this.transient;
      for (let q = 0; q < tr.length; q += 3) {
        const c = Math.hypot(x - tr[q], z - tr[q + 1]) - tr[q + 2];
        if (c < best) best = c;
      }
    }
    return best;
  }

  /** Static-only clearance (for statistics). */
  staticClearance(x: number, z: number): number {
    return this.clearance(x, z, this.track.nearestIndex(x, z), true);
  }

  /**
   * Choose the lateral offset (same sign as `side`) closest to `nominal` that is clear of obstacles
   * along the next few metres in the walking direction. Returns NaN if the whole band is blocked.
   */
  private routeLat(s: number, dir: number, side: number, nominal: number, from: number, ratio = 1): number {
    const t = this.track;
    const need = PED_RADIUS + 0.12;
    const i = Math.floor(this.wrapS(s) / t.spacing) % t.count;
    // The side-step itself is a diagonal (forward `ratio` m per lateral m): it must not get closer to any
    // obstacle than the pedestrian is now (so stepping away from something already close stays allowed).
    this.pos(s, side * from, this.tmpA);
    const needPath = Math.min(need, this.clearance(this.tmpA.x, this.tmpA.z, i) - 0.01);
    const ok = (lat: number): boolean => {
      for (let a = 0; a <= 3; a++) {
        this.pos(s + dir * a * 0.8, side * lat, this.tmpA);
        if (this.clearance(this.tmpA.x, this.tmpA.z, i) < need) return false;
      }
      const dLat = lat - from;
      if (Math.abs(dLat) > 0.05) {
        const n = Math.min(16, Math.ceil(Math.abs(dLat) / 0.15));
        for (let j = 1; j <= n; j++) {
          const f = j / n;
          this.pos(s + dir * Math.abs(dLat) * ratio * f, side * (from + dLat * f), this.tmpB);
          if (this.clearance(this.tmpB.x, this.tmpB.z, i) < needPath) return false;
        }
      }
      return true;
    };
    if (ok(nominal)) return nominal;
    for (let d = 0.15; d < PED_BAND_MAX - PED_BAND_MIN + 0.01; d += 0.15) {
      for (const sgn of nominal - from >= 0 ? [-1, 1] : [1, -1]) {
        const l = nominal + sgn * d;
        if (l < PED_BAND_MIN || l > PED_BAND_MAX) continue;
        if (ok(l)) return l;
      }
    }
    return NaN;
  }

  // ------------------------------------------------------------------ lifecycle
  setEnabled(on: boolean, fx: number, fz: number): void {
    for (const p of this.peds) { p.mode = PedMode.Off; p.groupId = -1; }
    this.groupPending = null;
    this.appearanceSerial = 0;
    this.enabled = on;
    this.events.length = 0;
    if (!on) {
      this.updateStats();
      return;
    }
    this.focusHint = this.track.nearestIndex(fx, fz);
    this.focusS = this.focusHint * this.track.spacing;
    for (let k = 0; k < this.density * 3 && this.activeCount() < this.density; k++) {
      const along = (this.rnd() * 2 - 1) * 140;
      this.trySpawn(this.focusS + along, fx, fz, 6);
    }
    this.updateStats();
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.mode !== PedMode.Off) n++;
    return n;
  }

  private trySpawn(s: number, fx: number, fz: number, minDist: number): boolean {
    const p = this.peds.find((q) => q.mode === PedMode.Off);
    if (!p) return false;
    const pairing = this.groupPending;
    this.groupPending = null;
    s = this.wrapS(pairing ? pairing.s + pairing.dir * 2.4 : s);
    // Never spawn on (or right next to) a crossing; always on a sidewalk line.
    for (const cs of this.crossS) if (Math.abs(this.ds(s, cs)) < 4) return false;
    const line = pairing ? pairing.line : Math.floor(this.rnd() * PED_LINES.length);
    const L = PED_LINES[line];
    const lat = this.routeLat(s, L.dir, L.side, L.lat, L.lat);
    if (Number.isNaN(lat)) return false;
    this.pos(s, L.side * lat, this.tmpA);
    if (Math.hypot(this.tmpA.x - fx, this.tmpA.z - fz) < minDist) return false;
    // Not on another road segment (the loop passes close to itself in places).
    if (this.track.distanceTo(this.tmpA.x, this.tmpA.z) < PED_BAND_MIN - 0.05) return false;
    for (const q of this.peds) if (q.mode !== PedMode.Off && Math.hypot(q.x - this.tmpA.x, q.z - this.tmpA.z) < 2) return false;
    p.mode = PedMode.Walk;
    p.s = s;
    p.line = line;
    p.side = L.side;
    p.dir = L.dir;
    p.lat = L.side * lat;
    p.targetLat = p.lat;
    p.pace = pairing?.pace ?? (1.15 + this.rnd() * 0.45);
    p.speed = p.pace;
    p.groupId = pairing?.id ?? -1;
    if (pairing) pairing.leader.groupId = pairing.id;
    const serial = this.appearanceSerial++;
    p.variant = PED_APPEARANCE_CYCLE[serial % PED_VARIANT_COUNT];
    p.scale = p.variant === 7 ? 0.76 + this.rnd() * 0.11 : p.variant === 6 ? 0.93 + this.rnd() * 0.06 : 0.93 + this.rnd() * 0.12;
    p.timer = 0;
    p.crossing = -1;
    p.cooldown = 4 + this.rnd() * 10;
    p.blockedTime = 0;
    p.acc = 0;
    p.panic = 0;
    p.downT = 0;
    p.x = p.prevX = this.tmpA.x;
    p.z = p.prevZ = this.tmpA.z;
    this.pos(s + p.dir, p.lat, this.tmpB);
    p.yaw = p.prevYaw = Math.atan2(this.tmpB.x - p.x, this.tmpB.z - p.z);
    if (!pairing && serial % 4 === 0) this.groupPending = { leader: p, id: this.groupSerial++, s: p.s, line, pace: p.pace, dir: p.dir };
    return true;
  }

  private manage(fx: number, fz: number): void {
    for (const p of this.peds) {
      if (p.mode === PedMode.Off || p.mode === PedMode.Cross) continue;
      const along = Math.abs(this.ds(p.s, this.focusS));
      if (along > 175 && Math.hypot(p.x - fx, p.z - fz) > 120) p.mode = PedMode.Off;
    }
    let tries = 6;
    while (this.activeCount() < this.density && tries-- > 0) {
      const along = (45 + this.rnd() * 110) * (this.rnd() < 0.5 ? -1 : 1);
      this.trySpawn(this.focusS + along, fx, fz, 40);
    }
  }

  // ------------------------------------------------------------------ simulation
  /** Pedestrians currently on the carriageway, as traffic agents (people), appended to `out`. */
  roadAgents(out: TrafficAgent[]): void {
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (p.mode === PedMode.Off || Math.abs(p.lat) > CURB + 0.3) continue;
      const a = this.agentPool[k];
      a.x = p.x;
      a.z = p.z;
      const dt = 1 / 60;
      a.vx = (p.x - p.prevX) / dt;
      a.vz = (p.z - p.prevZ) / dt;
      out.push(a);
    }
  }

  fixedUpdate(dt: number, fx: number, fz: number, threats: readonly PedThreat[]): void {
    if (!this.enabled) return;
    this.tick++;
    const t = this.track;
    this.focusHint = t.trackIndex(fx, fz, this.focusHint, 30);
    this.focusS = this.focusHint * t.spacing;
    if (this.tick % 30 === 0) this.manage(fx, fz);

    // Slow threats (parked cars, the player on foot) become obstacles; fast vehicles trigger dodges.
    const tr = this.transient;
    tr.length = 0;
    for (const th of threats) {
      const sp = Math.hypot(th.vx, th.vz);
      if (th.person) tr.push(th.x, th.z, 0.35);
      else if (sp < 2.5) {
        const cx = Math.cos(th.yaw);
        const cz = -Math.sin(th.yaw);
        const r = th.halfWidth + 0.1;
        const reach = Math.max(0, th.halfLen - r);
        for (const f of [-1, -0.5, 0, 0.5, 1]) tr.push(th.x + cx * reach * f, th.z + cz * reach * f, r);
      }
    }

    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (p.mode === PedMode.Off) continue;
      p.prevX = p.x;
      p.prevZ = p.z;
      p.prevYaw = p.yaw;
      const dist = Math.hypot(p.x - fx, p.z - fz);
      p.far = dist > FAR_DIST;
      // Far pedestrians (well outside any interaction) step at a third of the rate.
      let step = dt;
      if (p.far && p.mode === PedMode.Walk) {
        p.acc += dt;
        if ((this.tick + k) % 3 !== 0) continue;
        step = p.acc;
      }
      p.acc = 0;
      if (!p.far) this.react(p, k, threats);
      this.advance(p, step);
      this.pos(p.s, p.lat, this.tmpA);
      p.x = this.tmpA.x;
      p.z = this.tmpA.z;
      const mvx = p.x - p.prevX;
      const mvz = p.z - p.prevZ;
      const m = Math.hypot(mvx, mvz);
      p.speed = m / step;
      if (m > 0.004 && p.mode !== PedMode.Stumble && p.mode !== PedMode.Down) {
        const target = Math.atan2(mvx, mvz);
        const d = Math.atan2(Math.sin(target - p.yaw), Math.cos(target - p.yaw));
        p.yaw += d * Math.min(1, step * 9);
      } else if (p.mode === PedMode.Wait) {
        // Face across the road while waiting.
        const i = Math.floor(this.wrapS(p.s) / t.spacing) % t.count;
        const target = Math.atan2(-p.side * t.rx(i), -p.side * t.rz(i));
        const d = Math.atan2(Math.sin(target - p.yaw), Math.cos(target - p.yaw));
        p.yaw += d * Math.min(1, step * 4);
      }
    }
    this.separate();
    this.measure();
  }

  /** Dodge fast vehicles heading at us; register contact as a hit. */
  private react(p: Pedestrian, k: number, threats: readonly PedThreat[]): void {
    for (const th of threats) {
      if (th.person) continue;
      const vx = th.vx;
      const vz = th.vz;
      const sp = Math.hypot(vx, vz);
      const rx = p.x - th.x;
      const rz = p.z - th.z;
      // Contact: inside the vehicle footprint (+ body radius).
      const cx = Math.cos(th.yaw);
      const cz = -Math.sin(th.yaw);
      const lx = rx * cx + rz * cz;
      const lz = -rx * cz + rz * cx;
      if (Math.abs(lx) < th.halfLen + PED_RADIUS && Math.abs(lz) < th.halfWidth + PED_RADIUS) {
        if (sp > 2.5 && p.mode !== PedMode.Stumble && p.mode !== PedMode.Down) {
          this.stats.hits++;
          this.events.push({ type: 'pedHit', ped: k, speed: sp, x: p.x, z: p.z });
          p.mode = PedMode.Stumble;
          p.timer = 1.6;
        }
        // Push out sideways (out of the footprint).
        const push = (th.halfWidth + PED_RADIUS + 0.05 - Math.abs(lz)) * Math.sign(lz || 1);
        p.dodgeX = -cz * Math.sign(lz || 1);
        p.dodgeZ = cx * Math.sign(lz || 1);
        this.shift(p, -cz * push, cx * push, p.mode === PedMode.Cross);
        continue;
      }
      if (sp < 2.5 || p.mode === PedMode.Dodge || p.mode === PedMode.Stumble || p.mode >= PedMode.Surrender) continue;
      // Time of closest approach of the vehicle (moving at v) to the pedestrian, and the miss distance.
      const tc = (rx * vx + rz * vz) / (sp * sp);
      if (tc <= 0 || tc > 1.8) continue;
      const mx = rx - vx * tc;
      const mz = rz - vz * tc;
      const miss = Math.hypot(mx, mz);
      if (miss > th.halfWidth + 1.3) continue;
      // Where is the vehicle laterally (track frame)? A car driving along its own carriageway is no
      // danger to people on the sidewalk even when its straight-line extrapolation cuts a curve.
      const t = this.track;
      const pi = Math.floor(this.wrapS(p.s) / t.spacing) % t.count;
      const ci = t.trackIndex(th.x, th.z, pi, 25);
      const carLat = (th.x - t.px[ci]) * t.rx(ci) + (th.z - t.pz[ci]) * t.rz(ci);
      const along = Math.abs((vx * t.tx[ci] + vz * t.tz[ci]) / sp);
      if (p.mode !== PedMode.Cross && carLat * p.side < CURB - 0.3 && along > 0.9) continue;
      if (p.mode !== PedMode.Cross) {
        // Side-step across the sidewalk to whichever edge of the band ends up further from the car.
        const outward = Math.abs(p.side * PED_BAND_MAX - carLat);
        const inward = Math.abs(p.side * PED_BAND_MIN - carLat);
        p.dodgeLat = outward >= inward ? p.side : -p.side;
      }
      if (p.mode === PedMode.Cross) {
        // On a crossing: run for the nearer kerb instead.
        p.timer = -1;
        p.pace = RUN_PACE;
        if (Math.abs(p.lat - p.crossFrom) < Math.abs(p.lat - p.crossTo)) {
          const f = p.crossFrom;
          p.crossFrom = p.crossTo;
          p.crossTo = f;
        }
      } else {
        p.mode = PedMode.Dodge;
        p.timer = 1.0;
      }
      this.stats.dodges++;
    }
  }

  /** Move a pedestrian by a world-space displacement, staying inside the walkable area. */
  private shift(p: Pedestrian, wx: number, wz: number, allowRoad: boolean): void {
    const t = this.track;
    const i = Math.floor(this.wrapS(p.s) / t.spacing) % t.count;
    const dl = wx * t.rx(i) + wz * t.rz(i);
    const dsv = wx * t.tx[i] + wz * t.tz[i];
    p.s = this.wrapS(p.s + dsv);
    let lat = p.lat + dl;
    if (!allowRoad) {
      const a = Math.min(PED_BAND_MAX, Math.max(PED_BAND_MIN, Math.abs(lat)));
      lat = p.side * a;
    }
    // Never into furniture: undo the lateral part if it would clip an obstacle.
    this.pos(p.s, lat, this.tmpA);
    if (this.clearance(this.tmpA.x, this.tmpA.z, i, true) < PED_RADIUS) lat = p.lat;
    p.lat = lat;
  }

  private advance(p: Pedestrian, dt: number): void {
    const t = this.track;
    switch (p.mode) {
      case PedMode.Surrender: {
        p.timer -= dt;
        if (p.timer <= 0) this.afterThreat(p);
        return;
      }
      case PedMode.Phone: {
        p.timer -= dt;
        if (p.timer <= 0) {
          this.events.push({ type: 'report', ped: this.peds.indexOf(p), x: p.x, z: p.z });
          this.stats.reports++;
          this.afterThreat(p);
        }
        return;
      }
      case PedMode.Down: {
        p.downT += dt;
        p.timer -= dt;
        if (p.timer <= 0) this.afterThreat(p);
        return;
      }
      case PedMode.ToSidewalk: {
        const target = p.side * (PED_BAND_MIN + 0.3);
        const d = target - p.lat;
        this.shift(p, 0, 0, true);
        p.lat += Math.sign(d) * Math.min(Math.abs(d), RUN_PACE * dt);
        if (Math.abs(d) < 0.05) this.flee(p, p.fleeS);
        return;
      }
      case PedMode.Stumble: {
        p.timer -= dt;
        this.shift(p, p.dodgeX * dt * 1.2 * Math.max(0, p.timer - 0.8), p.dodgeZ * dt * 1.2 * Math.max(0, p.timer - 0.8), p.crossing >= 0);
        if (p.timer <= 0) this.rejoin(p);
        return;
      }
      case PedMode.Dodge: {
        p.timer -= dt;
        const target = p.dodgeLat > 0 === p.side > 0 ? PED_BAND_MAX : PED_BAND_MIN;
        const d = p.side * target - p.lat;
        const before = p.lat;
        p.lat += Math.sign(d) * Math.min(Math.abs(d), RUN_PACE * dt);
        this.pos(p.s, p.lat, this.tmpA);
        if (this.clearance(this.tmpA.x, this.tmpA.z, Math.floor(this.wrapS(p.s) / this.track.spacing) % this.track.count, true) < PED_RADIUS) p.lat = before;
        if (p.timer <= 0) this.rejoin(p);
        return;
      }
      case PedMode.Pause: {
        p.timer -= dt;
        if (p.timer <= 0) p.mode = PedMode.Walk;
        return;
      }
      case PedMode.ToCurb: {
        // First along the sidewalk to the chosen spot, then straight across to the kerb
        // (both legs were checked clear of furniture when the spot was chosen).
        const dsv = this.ds(p.crossFrom, p.s);
        const target = p.side * WAIT_LAT;
        const d = target - p.lat;
        if (Math.abs(dsv) > 0.02) p.s = this.wrapS(p.s + Math.sign(dsv) * Math.min(Math.abs(dsv), p.pace * dt));
        else p.lat += Math.sign(d) * Math.min(Math.abs(d), 1.2 * dt);
        if (Math.abs(d) < 0.02 && Math.abs(dsv) < 0.02) {
          p.mode = PedMode.Wait;
          p.timer = 0;
        }
        return;
      }
      case PedMode.Wait: {
        p.timer += dt;
        const k = p.crossing;
        if (this.signals.ped(k) === 'walk' && this.signals.walkRemaining(k) >= MIN_WALK_LEFT) {
          p.mode = PedMode.Cross;
          p.crossFrom = p.lat;
          p.crossTo = -p.side * WAIT_LAT;
          p.pace = CROSS_PACE + this.rnd() * 0.25;
          p.timer = 0;
          this.stats.crossStarted++;
          if (this.signals.ped(k) !== 'walk' || this.signals.walkRemaining(k) < MIN_WALK_LEFT) this.stats.badStarts++;
        }
        return;
      }
      case PedMode.Cross: {
        const k = p.crossing;
        const hurry = this.signals.ped(k) !== 'walk';
        const pace = Math.max(p.pace, hurry ? HURRY_PACE : 0);
        const d = p.crossTo - p.lat;
        p.lat += Math.sign(d) * Math.min(Math.abs(d), pace * dt);
        if (Math.abs(d) < 0.02) {
          this.stats.crossDone++;
          p.side = Math.sign(p.crossTo);
          p.crossing = -1;
          p.cooldown = 25 + this.rnd() * 30;
          this.rejoin(p);
        }
        return;
      }
      default:
        break;
    }

    // --- Walk along the line
    p.cooldown -= dt;
    const L = PED_LINES[p.line];
    // Re-plan the lateral offset a few times a second.
    if ((this.tick + p.variant) % 4 === 0 || Number.isNaN(p.targetLat)) {
      // Forward metres per lateral metre while side-stepping (lateral 0.9 m/s, pace x 0.6 during big steps).
      const lat = this.routeLat(p.s, p.dir, p.side, L.lat, Math.abs(p.lat), Math.max(0.5, (p.pace * 0.6) / 0.9));
      if (Number.isNaN(lat)) p.targetLat = NaN;
      else p.targetLat = p.side * lat;
    }
    let pace = p.panic > 0 ? RUN_PACE : p.pace;
    if (p.panic > 0) p.panic -= dt;
    if (Number.isNaN(p.targetLat)) {
      // Way ahead fully blocked: stop, then turn around onto the other line of this side.
      pace = 0;
      p.blockedTime += dt;
      if (p.blockedTime > 1.5) {
        const other = PED_LINES.findIndex((q, idx) => idx !== p.line && q.side === p.side);
        p.line = other;
        p.dir = PED_LINES[other].dir;
        p.blockedTime = 0;
        p.targetLat = p.lat;
        this.stats.turnarounds++;
      }
    } else {
      p.blockedTime = 0;
      const dl = p.targetLat - p.lat;
      const maxL = 0.9 * dt;
      p.lat += Math.sign(dl) * Math.min(Math.abs(dl), maxL);
      // Slow down while side-stepping a lot.
      if (Math.abs(dl) > 0.4) pace *= 0.6;
    }
    // Follow the pedestrian ahead on the same side (same direction) with a comfortable gap.
    for (const q of this.peds) {
      if (q === p || q.mode === PedMode.Off || q.side !== p.side) continue;
      const ahead = this.ds(q.s, p.s) * p.dir;
      if (ahead <= 0 || ahead > 2.6 || Math.abs(q.lat - p.lat) > 0.65) continue;
      const qMovingSame = q.mode === PedMode.Walk && q.dir === p.dir;
      const limit = qMovingSame ? Math.max(0, (ahead - 1.0) * 1.4) : Math.max(0, (ahead - 1.1) * 1.2);
      if (limit < pace) pace = limit;
    }
    // Physical speed → arc-length speed (offset lines are longer/shorter than the centre line on curves).
    this.pos(p.s, p.lat, this.tmpA);
    this.pos(p.s + 1, p.lat, this.tmpB);
    const scale = Math.max(0.3, Math.hypot(this.tmpB.x - this.tmpA.x, this.tmpB.z - this.tmpA.z));
    const prevS = p.s;
    p.s = this.wrapS(p.s + (p.dir * pace * dt) / scale);

    // Arriving at a crossing: maybe cross.
    for (let k = 0; k < this.crossS.length; k++) {
      const before = this.ds(prevS, this.crossS[k]) * p.dir;
      const after = this.ds(p.s, this.crossS[k]) * p.dir;
      if (before < -1.2 && after >= -1.2 && p.cooldown <= 0 && p.panic <= 0 && this.rnd() < 0.55) {
        // Pick a clear spot at the kerb on this side's half of the crosswalk ("keep right", so people
        // crossing in opposite directions pass each other), apart from others waiting.
        const spots = [0.5, 1.1, 1.6];
        for (const off of spots) {
          const sc = this.wrapS(this.crossS[k] + off * p.side);
          const i = Math.floor(sc / t.spacing) % t.count;
          const need = PED_RADIUS + 0.08;
          let clear = true;
          // leg 1: along at the current offset; leg 2: across to the kerb
          const dsv = this.ds(sc, p.s);
          for (let a = 0; a <= 1.0001 && clear; a += 0.1) {
            this.pos(p.s + dsv * a, p.lat, this.tmpA);
            if (this.clearance(this.tmpA.x, this.tmpA.z, i, true) < need) clear = false;
            this.pos(sc, p.lat + (p.side * WAIT_LAT - p.lat) * a, this.tmpA);
            if (this.clearance(this.tmpA.x, this.tmpA.z, i, true) < need) clear = false;
          }
          if (!clear) continue;
          let taken = false;
          for (const q of this.peds)
            if (q !== p && q.crossing === k && (q.mode === PedMode.ToCurb || q.mode === PedMode.Wait) && q.side === p.side && Math.abs(this.ds(q.crossFrom, sc)) < 0.5) taken = true;
          if (taken) continue;
          p.mode = PedMode.ToCurb;
          p.crossing = k;
          p.crossFrom = sc;
          break;
        }
        break;
      }
    }
    if (p.mode === PedMode.Walk && p.panic <= 0 && this.rnd() < dt * 0.012) {
      p.mode = PedMode.Pause;
      p.timer = 2 + this.rnd() * 4;
    }
  }

  /** After crossing / dodging / stumbling: pick a line on the current side and continue walking. */
  // ------------------------------------------------------------------ danger reactions

  /** Along-track coordinate of a world point (nearest road sample). */
  private sOf(x: number, z: number): number {
    return this.track.nearestIndex(x, z) * this.track.spacing;
  }

  /** Run away along the sidewalk from along-track position `fromS` (panicked walk: same obstacle avoidance). */
  private flee(p: Pedestrian, fromS: number): void {
    if (Math.abs(p.lat) < CURB) {
      // Still on the road: get to the sidewalk first.
      p.side = p.lat >= 0 ? 1 : -1;
      p.fleeS = fromS;
      p.mode = PedMode.ToSidewalk;
      return;
    }
    p.fromCar = false;
    const away = this.ds(p.s, fromS) >= 0 ? 1 : -1;
    const line = PED_LINES.findIndex((q) => q.side === p.side && q.dir === away);
    p.mode = PedMode.Walk;
    p.crossing = -1;
    p.line = line >= 0 ? line : p.line;
    p.dir = PED_LINES[p.line].dir;
    p.targetLat = NaN;
    p.panic = PANIC_TIME * (0.8 + this.rnd() * 0.4);
    this.stats.flees++;
  }

  /** The threat is over (surrender / call / knock-down ended): get away from where it happened. */
  private afterThreat(p: Pedestrian): void {
    p.downT = 0;
    this.flee(p, p.fleeS);
  }

  private callers(): number {
    let n = 0;
    for (const p of this.peds) if (p.mode === PedMode.Phone) n++;
    return n;
  }

  /**
   * Danger at (x, z) caused by the player at (px, pz): pedestrians within `radius` react. Close ones put
   * their hands up (gunpoint) or run, farther ones run or call the police. Returns how many reacted.
   */
  alarm(kind: Alarm, x: number, z: number, radius: number, px: number, pz: number): number {
    if (!this.enabled) return 0;
    const fromS = this.sOf(px, pz);
    let n = 0;
    for (const p of this.peds) {
      if (p.mode === PedMode.Off || p.mode === PedMode.Down || p.mode === PedMode.Phone || p.mode === PedMode.ToSidewalk) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius) continue;
      const dp = Math.hypot(p.x - px, p.z - pz);
      p.fleeS = fromS;
      n++;
      if (p.mode === PedMode.Cross) {
        // On a crossing: hurry to the far kerb (never stop in the road).
        p.pace = RUN_PACE;
        continue;
      }
      if (p.mode === PedMode.Surrender) {
        p.timer = Math.max(p.timer, 2.5);
        continue;
      }
      const r = this.rnd();
      if (kind !== 'crash' && dp < 9 && r < 0.45) {
        p.mode = PedMode.Surrender;
        p.timer = 3 + this.rnd() * 2;
        this.stats.surrenders++;
      } else if (dp > 14 && r > 0.72 && this.callers() < MAX_CALLERS) {
        p.mode = PedMode.Phone;
        p.timer = CALL_TIME;
        this.stats.calls++;
      } else this.flee(p, fromS);
    }
    return n;
  }

  /** The player aims at pedestrian k: hands up while aimed at (refreshed every call). */
  aimedAt(k: number, px: number, pz: number): void {
    const p = this.peds[k];
    if (!p || p.mode === PedMode.Off || p.mode === PedMode.Down || p.mode === PedMode.Cross || p.mode === PedMode.ToSidewalk) return;
    if (p.mode !== PedMode.Surrender) this.stats.surrenders++;
    p.mode = PedMode.Surrender;
    p.timer = Math.max(p.timer, 1.5);
    p.fleeS = this.sOf(px, pz);
  }

  /** Pedestrian k was hit by a shot: knocked down (no injury detail), gets up later and runs. */
  knockDown(k: number, px: number, pz: number): void {
    const p = this.peds[k];
    if (!p || p.mode === PedMode.Off || p.mode === PedMode.Down) return;
    p.mode = PedMode.Down;
    p.downT = 0;
    p.timer = DOWN_TIME;
    p.crossing = -1;
    p.fleeS = this.sOf(px, pz);
    this.stats.knockdowns++;
    this.events.push({ type: 'pedDown', ped: k, x: p.x, z: p.z });
  }

  /**
   * A driver gets out of their car at (x, z): a pedestrian appears there with their hands up, then runs to
   * the sidewalk and away from the player. Reuses a free slot or the farthest calm walker.
   */
  spawnDriver(x: number, z: number, px: number, pz: number): number {
    if (!this.enabled) return -1;
    let k = this.peds.findIndex((q) => q.mode === PedMode.Off);
    if (k < 0) {
      let best = -1;
      for (let j = 0; j < this.peds.length; j++) {
        const q = this.peds[j];
        if (q.mode !== PedMode.Walk || q.panic > 0) continue;
        const d = Math.hypot(q.x - x, q.z - z);
        if (best < 0 || d > Math.hypot(this.peds[best].x - x, this.peds[best].z - z)) best = j;
      }
      k = best;
    }
    if (k < 0) return -1;
    const p = this.peds[k];
    const t = this.track;
    const i = t.nearestIndex(x, z);
    p.s = i * t.spacing;
    p.lat = (x - t.px[i]) * t.rx(i) + (z - t.pz[i]) * t.rz(i);
    p.side = p.lat >= 0 ? 1 : -1;
    p.line = PED_LINES.findIndex((q) => q.side === p.side);
    p.dir = PED_LINES[p.line].dir;
    p.mode = PedMode.Surrender;
    p.timer = 1.6;
    p.crossing = -1;
    p.panic = 0;
    p.downT = 0;
    p.fromCar = true;
    p.fleeS = this.sOf(px, pz);
    p.groupId = -1;
    p.variant = Math.floor(this.rnd() * PED_VARIANT_COUNT);
    p.scale = p.variant === 7 ? 0.78 + this.rnd() * 0.1 : p.variant === 6 ? 0.9 + this.rnd() * 0.08 : 0.93 + this.rnd() * 0.12;
    this.pos(p.s, p.lat, this.tmpA);
    p.x = p.prevX = this.tmpA.x;
    p.z = p.prevZ = this.tmpA.z;
    p.yaw = p.prevYaw = Math.atan2(px - p.x, pz - p.z);
    this.stats.drivers++;
    return k;
  }

  /** Index of the pedestrian whose body (capsule ~ 0.35 m × 1.8 m) a ray hits first within `maxT`, or -1. */
  rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, groundY: number): { k: number; t: number } | null {
    let best: { k: number; t: number } | null = null;
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (p.mode === PedMode.Off || p.mode === PedMode.Down) continue;
      // Closest approach of the ray to the body's vertical axis (2D), then the height at that point.
      const rx = p.x - ox;
      const rz = p.z - oz;
      const hl = Math.hypot(dx, dz);
      if (hl < 1e-6) continue;
      const tc = (rx * dx + rz * dz) / (hl * hl);
      if (tc < 0 || tc > maxT) continue;
      const mx = rx - dx * tc;
      const mz = rz - dz * tc;
      if (mx * mx + mz * mz > 0.36 * 0.36) continue;
      const y = oy + dy * tc - groundY;
      if (y < 0 || y > 1.8 * p.scale) continue;
      if (!best || tc < best.t) best = { k, t: tc };
    }
    return best;
  }

  private rejoin(p: Pedestrian): void {
    const options = PED_LINES.map((q, idx) => ({ q, idx })).filter((o) => o.q.side === p.side);
    const pick = options[Math.floor(this.rnd() * options.length)] ?? options[0];
    p.line = pick.idx;
    p.dir = pick.q.dir;
    p.mode = PedMode.Walk;
    p.pace = 1.15 + this.rnd() * 0.45;
    p.targetLat = NaN;
    p.crossing = -1;
    p.fromCar = false;
  }

  /** Keep bodies apart (pairs closer than 0.62 m are pushed apart laterally / along). */
  private separate(): void {
    const P = this.peds;
    for (let a = 0; a < P.length; a++) {
      const A = P[a];
      if (A.mode === PedMode.Off) continue;
      for (let b = a + 1; b < P.length; b++) {
        const B = P[b];
        if (B.mode === PedMode.Off) continue;
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const d = Math.hypot(dx, dz);
        if (d >= 0.62 || d < 1e-4) continue;
        const push = (0.62 - d) * 0.5;
        const ux = dx / d;
        const uz = dz / d;
        this.shift(A, -ux * push, -uz * push, A.mode === PedMode.Cross);
        this.shift(B, ux * push, uz * push, B.mode === PedMode.Cross);
        for (const Q of [A, B]) {
          this.pos(Q.s, Q.lat, this.tmpA);
          Q.x = this.tmpA.x;
          Q.z = this.tmpA.z;
        }
      }
    }
  }

  private measure(): void {
    const st = this.stats;
    const t = this.track;
    for (const p of this.peds) {
      if (p.mode === PedMode.Off) continue;
      const onRoad = Math.abs(p.lat) < CURB;
      if (onRoad) {
        if (p.mode === PedMode.ToSidewalk || p.fromCar) {
          // A driver who got out of a car, on the way to the sidewalk: legitimately on the carriageway.
        } else if (p.mode !== PedMode.Cross && !(p.crossing >= 0)) st.offCrossingRoad++;
        else if (p.crossing >= 0 && this.signals.car(p.crossing) === 'green') st.onRoadAtGreen++;
      }
      // Also never on another road segment where the loop passes nearby.
      // (brute-force search, so staggered: each pedestrian is checked twice a second)
      if (!onRoad && (this.tick + p.variant * 5 + Math.floor(p.scale * 1000)) % 30 === 0 && p.mode !== PedMode.Cross && t.distanceTo(p.x, p.z) < CURB - 0.05) st.offCrossingRoad++;
      if (!p.far) {
        const c = this.clearance(p.x, p.z, Math.floor(this.wrapS(p.s) / t.spacing) % t.count, true) - PED_RADIUS;
        if (c < st.minClear) {
          st.minClear = c;
          this.minClearInfo = `mode ${p.mode} lat ${p.lat.toFixed(2)} s ${p.s.toFixed(1)} target ${p.targetLat.toFixed(2)}`;
        }
      }
    }
    if (this.tick % 10 === 0) {
      for (let a = 0; a < this.peds.length; a++) {
        const A = this.peds[a];
        if (A.mode === PedMode.Off) continue;
        for (let b = a + 1; b < this.peds.length; b++) {
          const B = this.peds[b];
          if (B.mode === PedMode.Off) continue;
          const d = Math.hypot(A.x - B.x, A.z - B.z);
          if (d < st.minSep) {
            st.minSep = d;
            this.minSepInfo = `modes ${A.mode}/${B.mode} lat ${A.lat.toFixed(2)}/${B.lat.toFixed(2)} far ${A.far}/${B.far} s ${A.s.toFixed(1)}/${B.s.toFixed(1)}`;
          }
        }
      }
    }
    this.updateStats();
  }

  private updateStats(): void {
    this.stats.active = this.activeCount();
  }

  resetStats(): void {
    const st = this.stats;
    st.crossStarted = st.crossDone = st.badStarts = st.offCrossingRoad = st.onRoadAtGreen = st.dodges = st.hits = st.turnarounds = 0;
    st.flees = st.surrenders = st.calls = st.reports = st.knockdowns = st.drivers = 0;
    st.minClear = Infinity;
    st.minSep = Infinity;
  }
}
