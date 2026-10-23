import { Vector3 } from 'three';
import { CAR, type CarParams } from '../config';
import type { DriverInput } from '../Drivetrain';
import type { Vehicle } from '../Vehicle';
import type { Track } from '../world/Track';
import type { OpponentSpec } from './Levels';

/**
 * Lateral grip used to plan corner speeds (m/s²) before the driver's skill factor. Tuned as 9.5 when the
 * stock car reached 1.25 g on the skid pad; the realism layer (road-tyre μ, little downforce, load
 * sensitivity) brought that to 0.98 g (scripts/tune/handling-probe.ts), so the plan keeps the same margin.
 */
const GRIP = 9.5 * (0.98 / 1.25);
/** Planned braking deceleration (m/s²). */
const DECEL = 6.5;
const TOP_SPEED = 58;
const WHEELBASE = CAR.wheelBaseFront - CAR.wheelBaseRear;
/** Furthest a rival's centre may go from the road centre line (half width 7 m − half a car − margin). */
const ROAD_LIMIT = 5.6;
/** Slip angle (rad) above which the driver treats the car as sliding, and the extra slip that cuts power completely. */
const SLIP_ONSET = 0.1;
const SLIP_RANGE = 0.1;
/** Counter-steer per radian of excess slip (rad of steering). */
const COUNTER_STEER = 1.0;
/** Yaw-rate surplus (rad/s) tolerated over the line's own yaw rate, and its weight as slip. */
const YAW_MARGIN = 0.15;
const YAW_TO_SLIP = 0.25;
/** Lateral shift used to pass a slower car (one lane). */
const PASS_OFFSET = 3.3;
/** Lane-change rate (m/s of lateral shift). */
const SHIFT_RATE = 2.5;
/** Lane changes need the road over their whole length to bend less than 4x this (1/m, i.e. radius > ~28 m). */
const PASS_MAX_CURVATURE = 0.009;
/** Recovery steering: off the racing line by more than this (m), or heading error above RECOVER_HEADING (rad). */
const RECOVER_OFFSET = 6;
const RECOVER_HEADING = 1.0;
/** Heading error (rad) that gives full lock in recovery, and the speed cap (m/s) while recovering. */
const RECOVER_STEER_GAIN = 0.5;
const RECOVER_SPEED = 12;
/** Largest lane change (m) started at once above 12 m/s: about one lane. */
const MAX_SWING = 4.5;
/** Lateral clearance (m, centre to centre) a line needs from a car to count as free. */
const LINE_CLEAR = 2.0;
/** Fraction of the planned braking used when closing on a car ahead (keeps a margin for the brake lag). */
const FOLLOW_DECEL = 0.7;
/** Gap (m, centre to centre) kept to a stopped car ahead. */
const STOP_GAP = 7;
/** Stuck this long (s) while wanting to drive → back off with opposite lock. */
const STUCK_REVERSE = 1.0;
/** Duration of one reversing manoeuvre (s). */
const REVERSE_TIME = 1.4;
/** Failed reversing attempts (without progress) before the last-resort reset. */
const MAX_ATTEMPTS = 4;
/** Progress (samples) that counts as having got going again. */
const ATTEMPT_PROGRESS = 15;
/** After finishing: roll on at this speed along the right-hand edge for COOLDOWN_TIME seconds, then stop. */
const COOLDOWN_SPEED = 9;
const COOLDOWN_TIME = 6;
/** Speed limit through the construction zone: it sits in a bend, and running wide there clips the cone line. */
const WORK_ZONE_SPEED = 19;

const curvatureCache = new WeakMap<Track, Float32Array>();

/** Unsigned curvature (1/m) per track sample, lightly smoothed. */
export function curvature(track: Track): Float32Array {
  let k = curvatureCache.get(track);
  if (k) return k;
  const n = track.count;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = Math.atan2(track.tz[i], track.tx[i]);
    const b = Math.atan2(track.tz[j], track.tx[j]);
    raw[i] = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) / track.spacing;
  }
  k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += raw[(i + d + n) % n];
    k[i] = s / 7;
  }
  curvatureCache.set(track, k);
  return k;
}

/** Signed sample delta in (-count/2, count/2]. */
/** Ambient traffic car as seen by a racer (TrafficSystem cars satisfy this). */
export interface AmbientCar {
  /** 0 = inactive, 1 = driving in its lane, 2 = knocked loose. */
  mode: number;
  x: number;
  z: number;
  /** Lane speed (m/s). */
  v: number;
  yaw: number;
}

export function indexDelta(track: Track, from: number, to: number): number {
  const n = track.count;
  let d = (to - from) % n;
  if (d > n / 2) d -= n;
  if (d <= -n / 2) d += n;
  return d;
}

/**
 * One computer-controlled rival. It drives the same VehiclePhysics as the player
 * (so it brakes, slides and collides the same way) using pure-pursuit steering towards
 * its racing line and a target speed derived from the curvature of the road ahead.
 */
/** Per-car scaling of the planned corner grip and braking (1 = the stock Kestrel GT the constants were tuned on). */
export interface AiCarProfile {
  grip: number;
  decel: number;
}

export const NEUTRAL_PROFILE: Readonly<AiCarProfile> = { grip: 1, decel: 1 };

const gripIndex = (c: CarParams): number => ((c.frictionSlipFront + c.frictionSlipRear) / 2) * c.tyreMu * (1 + c.downforceCoefficient * c.aeroScale * 0.25);
/** Braking deceleration (m/s²): what the brakes give, but never more than the tyres can transmit (VehiclePhysics limits it). */
const brakeIndex = (c: CarParams): number => {
  const brakes = (((c.brakeImpulseFront + c.brakeImpulseRear) * 2) / c.mass) * 60;
  const tyres = c.longitudinalMu > 0 ? 9.81 * ((c.frictionSlipFront + c.frictionSlipRear) / 2) * c.tyreMu * c.longitudinalMu : Infinity;
  return Math.min(brakes, tyres);
};

/**
 * How hard a rival may plan to corner and brake in this car, relative to the stock Kestrel GT. Tyre
 * friction gains in the physics are sub-linear (measured skidpad: Vortex 1.21× the Kestrel for a 1.40×
 * friction index, Brute 0.93× for 0.83×), hence the square root. Sweeps of every car and upgrade level
 * (scripts/tune/ai-grip-sweep.ts) confirm the resulting lines stay on the road.
 */
export function aiProfileFor(c: CarParams): AiCarProfile {
  return {
    grip: Math.sqrt(gripIndex(c) / gripIndex(CAR)),
    decel: Math.sqrt(brakeIndex(c) / brakeIndex(CAR)),
  };
}

/** A checkpoint the racer must cross (forwards, inside the opening) in order; `mark` = its progress (samples). */
export interface RaceGate {
  x: number;
  z: number;
  tx: number;
  tz: number;
  halfWidth: number;
  mark: number;
}

/**
 * Extra width (m) of a gate opening for AI racers: a rival recovering along the pavement edge still counts
 * (it cannot drive back to a missed gate like a player can); real shortcuts are tens of metres off.
 */
const GATE_TOLERANCE = 3;
/** A racer this far (samples) past a gate's road position without having crossed it is disqualified. */
const GATE_MISS_SAMPLES = 15;

export class AiRacer {
  /** Current nearest track sample. */
  idx = 0;
  /** Samples travelled since the start (unwrapped). */
  progress = 0;
  finished = false;
  finishTime = 0;
  /** Missed a checkpoint (cut the course): out of the race, ranked last, never finishes. */
  disqualified = false;
  /** Checkpoints in race order (all laps); empty = finish by distance (tuning tools). */
  private gates: readonly RaceGate[] = [];
  /** Index of the next checkpoint to cross. */
  nextGate = 0;
  private lastX = 0;
  private lastZ = 0;
  /**
   * Driving skill multiplier (difficulty preset; 1 = the level's skill). Changes how hard the driver plans
   * corners and straights — never the car's grip, power or position.
   */
  skillScale = 1;
  /** Additive skill change from the optional rubber band (0 when it is off). */
  paceAdjust = 0;
  private stuckTime = 0;
  /** Current / wanted lateral offset from the racing line while passing another car (m). */
  private shift = 0;
  private shiftTarget = 0;
  /** Seconds to keep the passing line after the way ahead is clear. */
  private passTimer = 0;
  /** Seconds since crossing the finish line. */
  private cooldown = 0;
  /** Seconds of reversing left in the current unstick manoeuvre (0 = driving forward). */
  private reverseLeft = 0;
  /** Side (−1 left, +1 right) the nose is swung towards while reversing. */
  private reverseSide: -1 | 1 = -1;
  /** Consecutive reversing attempts since the racer last made real progress. */
  private attempts = 0;
  private attemptMark = 0;
  /** Last computed target speed (m/s), used by the stuck detector. */
  private lastTarget = 0;
  /** What limited the speed in the last step (diagnostics / tests): distance and speed of the car in the way. */
  readonly blocker = { dist: Infinity, speed: 0, cap: Infinity, racer: false };
  private readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly fwd = new Vector3();
  private readonly tmp = new Vector3();

  constructor(
    readonly vehicle: Vehicle,
    readonly spec: OpponentSpec,
    private readonly track: Track,
    /** Fixed corner / brake scaling (tuning tools); by default it follows the car's tuning at reset(). */
    private readonly fixedProfile: Readonly<AiCarProfile> | null = null,
  ) {
    this.profile = fixedProfile ?? aiProfileFor(vehicle.physics.car);
  }

  /** How much harder than the reference car this car may corner / brake. */
  profile: Readonly<AiCarProfile>;

  /** Times this racer was reset onto the road as a last resort (flipped, or reversing did not help). */
  respawns = 0;
  /** Reversing manoeuvres used to get unstuck (no reset involved). */
  reversals = 0;

  get name(): string {
    return this.spec.name;
  }

  /** Effective driving skill: level skill x difficulty, plus the rubber band if enabled (0.5..1). */
  get skill(): number {
    return Math.max(0.5, Math.min(1, this.spec.skill * this.skillScale + this.paceAdjust));
  }

  /** Out of the race: finished, or disqualified. */
  get done(): boolean {
    return this.finished || this.disqualified;
  }

  /** Checkpoints to pass in order (with progress marks from this racer's grid slot). */
  setGates(gates: readonly RaceGate[]): void {
    this.gates = gates;
    this.nextGate = 0;
  }

  get gateCount(): number {
    return this.gates.length;
  }

  /** Put the car on its grid slot. */
  reset(): void {
    const t = this.track;
    const k = ((this.spec.i % t.count) + t.count) % t.count;
    this.tmp.set(t.px[k] + t.rx(k) * this.spec.off, 0, t.pz[k] + t.rz(k) * this.spec.off);
    this.vehicle.reset(this.tmp, Math.atan2(-t.tz[k], t.tx[k]));
    this.idx = k;
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.disqualified = false;
    this.nextGate = 0;
    this.lastX = this.tmp.x;
    this.lastZ = this.tmp.z;
    this.paceAdjust = 0;
    this.stuckTime = 0;
    this.shift = 0;
    this.shiftTarget = 0;
    this.passTimer = 0;
    this.cooldown = 0;
    this.respawns = 0;
    this.reversals = 0;
    this.reverseLeft = 0;
    this.attempts = 0;
    this.attemptMark = 0;
    this.lastTarget = 0;
    this.profile = this.fixedProfile ?? aiProfileFor(this.vehicle.physics.car);
  }

  /**
   * Compute driver input and feed the vehicle. Call once per fixed step, before world.step().
   * `traffic` lists every car on the course (other rivals and the player's car; this racer's own car is
   * skipped), so the rival follows or overtakes instead of driving into them.
   */
  fixedUpdate(dt: number, go: boolean, traffic: readonly Vehicle[] = [], cars: readonly AmbientCar[] = []): void {
    const inp = this.input;
    const vp = this.vehicle.physics;
    if (this.done) this.cooldown += dt;
    // Before the start, or parked after the cool-down: hold still.
    if (!go || (this.done && this.cooldown > COOLDOWN_TIME && Math.abs(vp.forwardSpeed) < 0.5)) {
      inp.throttle = 0;
      inp.brake = 0;
      inp.steer = 0;
      inp.handbrake = true;
      this.vehicle.fixedUpdate(dt, inp);
      return;
    }
    const t = this.track;
    const n = t.count;
    const body = vp.body;
    const p = body.translation();
    const r = body.rotation();
    // Chassis forward (+X) in world space.
    this.fwd.set(1 - 2 * (r.y * r.y + r.z * r.z), 2 * (r.x * r.y + r.w * r.z), 2 * (r.x * r.z - r.w * r.y));
    const speed = Math.max(0, vp.forwardSpeed);

    // --- Unstick: back off with opposite lock so the nose swings towards free road, then drive on.
    if (this.reverseLeft > 0) {
      this.reverseLeft -= dt;
      inp.throttle = 0;
      inp.handbrake = false;
      // Reverse pedal; stop early if something is right behind (never reverse into another car).
      const blockedBehind = this.behindBlocked(traffic, cars, p.x, p.z, this.fwd.x, this.fwd.z);
      inp.brake = blockedBehind ? 0 : 1;
      if (blockedBehind) this.reverseLeft = 0;
      // Reversing: steering right swings the nose left.
      inp.steer = -this.reverseSide;
      this.vehicle.fixedUpdate(dt, inp);
      if (this.reverseLeft <= 0) this.stuckTime = 0;
      return;
    }

    // --- Steering: pure pursuit towards a point on the racing line ahead.
    // Off the road or pointing well away from it (spun by a hit, knocked wide): pure pursuit diverges there —
    // its curvature shrinks as the target recedes — so aim at the road just ahead with heading control.
    const ki = this.idx;
    const latNow = (p.x - t.px[ki]) * t.rx(ki) + (p.z - t.pz[ki]) * t.rz(ki);
    const lineNow = this.done ? this.maxLine(ki) : Math.max(-ROAD_LIMIT, Math.min(this.maxLine(ki), this.lineAt(ki) + this.shift));
    const offRoad = Math.abs(latNow - lineNow) > RECOVER_OFFSET;
    const look = offRoad ? 6 : Math.round(4 + speed * 0.32);
    const j = (this.idx + look) % n;
    // After the finish, pull over to the right-hand edge so the racing line stays free for the others.
    const line = this.done ? this.maxLine(j) : Math.max(-ROAD_LIMIT, Math.min(this.maxLine(j), this.lineAt(j) + this.shift));
    const tx = t.px[j] + t.rx(j) * line - p.x;
    const tz = t.pz[j] + t.rz(j) * line - p.z;
    const ld = Math.max(3, Math.hypot(tx, tz));
    const fx = this.fwd.x;
    const fz = this.fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    // local: x forward, z right (right = (-fz, fx) in the XZ plane for +X-forward chassis)
    const lx = (tx * fx + tz * fz) / fl;
    const lz = (tx * -fz + tz * fx) / fl;
    const alpha = Math.atan2(lz, lx);
    const delta = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / ld);
    const maxSteer = CAR.maxSteerLow / (1 + speed / CAR.steerSpeedFalloff);
    // Slip angle (+ = travelling to the right of where the nose points). Counter-steer into a slide.
    const lv = body.linvel();
    const vRight = (lv.x * -fz + lv.z * fx) / fl;
    const slip = speed > 4 ? Math.atan2(vRight, Math.max(speed, 1)) : 0;
    // Yaw beyond what the line needs (the tail stepping out, e.g. braking into a bend) counts as sliding too.
    const wantYaw = (speed * 2 * Math.sin(alpha)) / ld;
    const overYaw = Math.max(0, Math.abs(body.angvel().y) - Math.abs(wantYaw) - YAW_MARGIN);
    const slide = Math.max(0, Math.abs(slip) - SLIP_ONSET) + overYaw * YAW_TO_SLIP;
    inp.steer = Math.max(-1, Math.min(1, (delta + Math.sign(slip) * slide * COUNTER_STEER) / maxSteer));
    const lost = offRoad || Math.abs(alpha) > RECOVER_HEADING;
    if (lost) inp.steer = Math.max(-1, Math.min(1, alpha / RECOVER_STEER_GAIN));

    // --- Speed: slowest of (corner speed + braking distance) over the next ~150 m.
    const kappa = curvature(t);
    const skill = this.skill;
    const grip = GRIP * this.profile.grip * skill;
    const decel = DECEL * this.profile.decel;
    let target = TOP_SPEED * (0.86 + 0.14 * skill);
    for (let d = 0; d < 75; d += 2) {
      const s = (this.idx + d) % n;
      let vCorner = Math.sqrt(grip / Math.max(kappa[s], 1e-4));
      if (this.inWorkZone(s)) vCorner = Math.min(vCorner, WORK_ZONE_SPEED);
      const dist = Math.max(0, d * t.spacing - 6);
      target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * decel * dist));
    }
    const free = target;
    target = Math.min(target, this.traffic(dt, traffic, cars, p.x, p.z, fx / fl, fz / fl, speed));
    if (this.done) target = Math.min(target, this.cooldown < COOLDOWN_TIME ? COOLDOWN_SPEED : 0);
    // Recovering: slow enough to turn back onto the road (more speed once pointing along it again).
    if (lost) target = Math.min(target, RECOVER_SPEED);
    // "Wants to drive" = the road allows speed even if a car in the way does not.
    this.lastTarget = free;
    if (speed < target - 0.6) {
      inp.throttle = 1;
      inp.brake = 0;
    } else if (speed > target + 1.8) {
      inp.throttle = 0;
      inp.brake = Math.min(1, (speed - target) / 6);
    } else {
      inp.throttle = 0.35;
      inp.brake = 0;
    }
    // Traction aid: a sliding car gets no more power and only gentle braking until it straightens up.
    if (slide > 0) {
      const k = Math.max(0, 1 - slide / SLIP_RANGE);
      inp.throttle = Math.min(inp.throttle, 0.35 * k);
      inp.brake = Math.min(inp.brake, 0.15 + 0.35 * k);
    }
    inp.handbrake = false;
    this.vehicle.fixedUpdate(dt, inp);

    // --- Recovery. Stuck (barely moving although the road ahead allows speed): reverse with opposite
    // lock towards the freer side and take a free line. Only a flipped car, or one that is still stuck
    // after several attempts, is reset — and then without gaining ground.
    if (this.progress - this.attemptMark > ATTEMPT_PROGRESS) this.attempts = 0;
    if (speed < 1 && !this.done && this.lastTarget > 3) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    if (vp.flippedTime > 2) this.respawn(traffic, cars);
    else if (this.stuckTime > STUCK_REVERSE) {
      if (this.attempts >= MAX_ATTEMPTS) this.respawn(traffic, cars);
      else this.startReverse(traffic, cars);
    }
  }

  /** Begin one reversing manoeuvre and pick the line to take afterwards. */
  private startReverse(traffic: readonly Vehicle[], cars: readonly AmbientCar[]): void {
    const best = this.freeLine(traffic, cars, this.idx);
    const here = this.lineAt(this.idx) + this.shift;
    this.reverseSide = best < here ? -1 : 1;
    // Turned across the road (nose into a kerb or wall): first swing the nose back towards the road direction.
    const t = this.track;
    const k = this.idx;
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const noseRight = (this.fwd.x * t.rx(k) + this.fwd.z * t.rz(k)) / fl;
    if (Math.abs(noseRight) > 0.34) this.reverseSide = noseRight > 0 ? -1 : 1;
    this.shiftTarget = this.clampShift(best - this.lineAt(this.idx));
    this.passTimer = 4;
    this.reverseLeft = REVERSE_TIME;
    this.stuckTime = 0;
    if (this.attempts === 0) this.attemptMark = this.progress;
    this.attempts++;
    this.reversals++;
  }

  private clampShift(v: number): number {
    return Math.max(-ROAD_LIMIT - this.spec.line, Math.min(ROAD_LIMIT, v));
  }

  /** Road-frame position of (x, z) relative to sample `from`: samples ahead and lateral offset at that point. */
  private roadFrame(x: number, z: number, from: number): { ahead: number; lat: number } {
    const t = this.track;
    const n = t.count;
    const wrap = (i: number): number => ((i % n) + n) % n;
    // Two projections on the local tangent: the road bends between samples.
    let k = wrap(from + Math.round(((x - t.px[from]) * t.tx[from] + (z - t.pz[from]) * t.tz[from]) / t.spacing));
    k = wrap(k + Math.round(((x - t.px[k]) * t.tx[k] + (z - t.pz[k]) * t.tz[k]) / t.spacing));
    const ahead = indexDelta(t, from, k) * t.spacing + ((x - t.px[k]) * t.tx[k] + (z - t.pz[k]) * t.tz[k]);
    return { ahead, lat: (x - t.px[k]) * t.rx(k) + (z - t.pz[k]) * t.rz(k) };
  }

  /**
   * The road line (offset from the centre line, m) with the most room ahead from sample `from`: every
   * car within 45 m ahead blocks the lines within LINE_CLEAR of it. Ties go to the line nearest our own.
   */
  /** Room ahead (m) on the line chosen by the last freeLine() call, on our current line, and on the racing line. */
  private readonly room = { best: 0, here: 0, racing: 0 };

  /** Distance (m) over which freeLine() measures room: the follow logic's look-ahead (at least 45 m). */
  private horizon = 45;

  private freeLine(traffic: readonly Vehicle[], cars: readonly AmbientCar[], from: number, maxSwing = Infinity): number {
    const here = this.lineAt(from) + this.shift;
    const racing = this.lineAt(from);
    let best = here;
    let bestRoom = -Infinity;
    const obs: Array<{ ahead: number; lat: number }> = [];
    for (const o of traffic) {
      if (o === this.vehicle) continue;
      const q = o.physics.body.translation();
      obs.push(this.roadFrame(q.x, q.z, from));
    }
    const t = this.track;
    const own = Math.max(0, this.vehicle.physics.forwardSpeed);
    for (const c of cars) {
      if (c.mode === 0) continue;
      const f = this.roadFrame(c.x, c.z, from);
      // An oncoming lane car closes fast: count it where it will be in 2 s, so its lane never looks open.
      const dot = Math.cos(c.yaw) * t.tx[from] - Math.sin(c.yaw) * t.tz[from];
      if (c.mode === 1 && dot < -0.3) f.ahead = Math.max(0, f.ahead - (c.v + own) * 2);
      obs.push(f);
    }
    const hi = this.maxLine(from);
    const roomOn = (line: number): number => {
      let room = this.horizon;
      for (const o of obs) if (o.ahead > -1 && o.ahead < room && Math.abs(o.lat - line) < LINE_CLEAR) room = Math.max(0, o.ahead);
      return room;
    };
    for (let line = -ROAD_LIMIT; line <= hi + 1e-6; line += 0.7) {
      if (Math.abs(line - here) > maxSwing) continue;
      const room = roomOn(line);
      const score = room - Math.abs(line - here) * 0.4;
      if (score > bestRoom) {
        bestRoom = score;
        best = line;
        this.room.best = room;
      }
    }
    this.room.here = roomOn(here);
    this.room.racing = roomOn(racing);
    return best;
  }

  /** A car within 3 m behind us, roughly in line: reversing would hit it. */
  private behindBlocked(traffic: readonly Vehicle[], cars: readonly AmbientCar[], px: number, pz: number, fx: number, fz: number): boolean {
    const fl = Math.hypot(fx, fz) || 1;
    const ux = fx / fl;
    const uz = fz / fl;
    const near = (x: number, z: number): boolean => {
      const along = (x - px) * ux + (z - pz) * uz;
      const lat = (x - px) * -uz + (z - pz) * ux;
      return along < -1 && along > -7.5 && Math.abs(lat) < 2.2;
    };
    for (const o of traffic) {
      if (o === this.vehicle) continue;
      const q = o.physics.body.translation();
      if (near(q.x, q.z)) return true;
    }
    for (const c of cars) if (c.mode !== 0 && near(c.x, c.z)) return true;
    return false;
  }

  private lineAt(j: number): number {
    return Math.min(this.spec.line, this.maxLine(j));
  }

  /** No bend tighter than radius ≈ 28 m over the next `metres` (at least 50 m): room for a lane change. */
  private gentleAhead(metres: number): boolean {
    const kappa = curvature(this.track);
    const n = this.track.count;
    const count = Math.max(25, Math.ceil(metres / this.track.spacing));
    for (let d = 0; d < count; d += 2) if (kappa[(this.idx + d) % n] > PASS_MAX_CURVATURE * 4) return false;
    return true;
  }

  /** Right-most usable line at sample j: the Foundry Street construction zone narrows the right-hand lanes. */
  private maxLine(j: number): number {
    // 1.1 m keeps a car width (half-width 0.9) plus ~1 m of corner-cutting clear of the 3.7 m cone line.
    return this.inWorkZone(j) ? 1.1 : ROAD_LIMIT;
  }

  /** The construction zone narrows the right-hand side of the road (see Props: taper + barriers). */
  private inWorkZone(j: number): boolean {
    return j > 278 && j < 318;
  }

  /**
   * Car-awareness: returns a speed cap that keeps a safe gap to the car ahead, and moves the passing
   * offset (`shiftTarget`) one lane to the left when that is free, so a faster rival overtakes instead of
   * rear-ending it.
   * (ux, uz) is the unit forward vector; lateral offsets are positive to the right, like track offsets.
   */
  private traffic(dt: number, traffic: readonly Vehicle[], cars: readonly AmbientCar[], px: number, pz: number, ux: number, uz: number, speed: number): number {
    let aheadDist = Infinity;
    let aheadSpeed = 0;
    let aheadRacer = false;
    let leftBusy = false;
    let rightBusy = false;
    const decel = DECEL * this.profile.decel * FOLLOW_DECEL;
    // Look at least as far as it takes to stop (plus reaction distance), so a stopped car is never seen too late.
    const look = 12 + speed * 0.6 + (speed * speed) / (2 * decel);
    // Lane choice looks as far as the follow logic: a slow car that already makes us brake must also count
    // against its line, so we change lines early instead of slowing down behind it first.
    this.horizon = Math.max(45, look);
    const t = this.track;
    const n = t.count;
    // A car is "in the way" when it is ahead along the road and within LINE_CLEAR of the line we will be on there.
    const inWay = (x: number, z: number): number => {
      const f = this.roadFrame(x, z, this.idx);
      if (f.ahead <= 0.5 || f.ahead > look) return Infinity;
      const k = (this.idx + Math.round(f.ahead / t.spacing)) % n;
      const ours = Math.max(-ROAD_LIMIT, Math.min(this.maxLine(k), this.lineAt(k) + this.shift));
      const target = Math.max(-ROAD_LIMIT, Math.min(this.maxLine(k), this.lineAt(k) + this.shiftTarget));
      return Math.min(Math.abs(f.lat - ours), Math.abs(f.lat - target)) < LINE_CLEAR ? f.ahead : Infinity;
    };
    for (const o of traffic) {
      if (o === this.vehicle) continue;
      const q = o.physics.body.translation();
      const dx = q.x - px;
      const dz = q.z - pz;
      const along = dx * ux + dz * uz;
      const lat = dx * -uz + dz * ux;
      // Cars alongside, just ahead, or just behind and closing make that side unavailable for a lane change
      // (a car queued behind us must not keep us from pulling out).
      if (along > -7 && along < 9 && (along > -2.5 || o.physics.forwardSpeed > speed + 1)) {
        if (lat > 1.0 && lat < PASS_OFFSET + 1.6) rightBusy = true;
        if (lat < -1.0 && lat > -PASS_OFFSET - 1.6) leftBusy = true;
      }
      const d = inWay(q.x, q.z);
      if (d < aheadDist) {
        aheadDist = d;
        aheadSpeed = Math.max(0, o.physics.forwardSpeed);
        aheadRacer = true;
      }
    }
    // Ambient traffic (City Grand Prix): kinematic lane cars and knocked-loose ones.
    for (const c of cars) {
      if (c.mode === 0) continue;
      const dx = c.x - px;
      const dz = c.z - pz;
      const along = dx * ux + dz * uz;
      const lat = dx * -uz + dz * ux;
      if (along > -7 && along < 9 && (along > -2.5 || (c.mode === 1 && c.v > speed + 1))) {
        if (lat > 1.0 && lat < PASS_OFFSET + 1.6) rightBusy = true;
        if (lat < -1.0 && lat > -PASS_OFFSET - 1.6) leftBusy = true;
      }
      const d = inWay(c.x, c.z);
      if (d < aheadDist) {
        aheadDist = d;
        // Lane car heading (cos yaw, -sin yaw) projected on our direction; knocked-loose cars count as stopped.
        aheadSpeed = c.mode === 1 ? Math.max(0, c.v * (Math.cos(c.yaw) * ux - Math.sin(c.yaw) * uz)) : 0;
        aheadRacer = false;
      }
    }
    const here = this.lineAt(this.idx) + this.shift;
    let cap = Infinity;
    if (aheadDist < Infinity) {
      // A slower car ahead is passed on whichever line has clearly more room (stopped ones anywhere; moving
      // ones only where the road ahead is gentle), never across a car alongside. Otherwise just follow.
      const slow = aheadSpeed < 4;
      // Worth passing: stopped / crawling, or clearly slower than the road allows us to go.
      const slower = slow || aheadSpeed < this.lastTarget - 4;
      if (this.shiftTarget === this.shift && slower) {
        // At speed, one lane at a time: a full-width swing across the road takes seconds and ends in a slide.
        const best = this.freeLine(traffic, cars, this.idx, speed < 12 ? Infinity : MAX_SWING);
        const side = best < here ? leftBusy : rightBusy;
        // The whole lane change must happen on gentle road: it takes |Δ| / SHIFT_RATE seconds, and a car still
        // swinging across the road when a corner arrives slides wide (off the course). Slow cars may always move.
        const swing = Math.abs(best - here);
        const gentle = speed < 12 || this.gentleAhead(speed * (swing / SHIFT_RATE) + 15);
        // Change line only into real room (at least 12 m more than on our line) and never across a car alongside.
        if (swing > 0.5 && gentle && !side && this.room.best > this.room.here + 12) this.shiftTarget = this.clampShift(best - this.lineAt(this.idx));
      }
      this.passTimer = 2.5;
      // Never drive into it: the fastest speed from which we can still brake to its speed before the gap.
      const gap = Math.max(0, aheadDist - STOP_GAP);
      cap = Math.sqrt(aheadSpeed * aheadSpeed + 2 * decel * gap);
      if (aheadDist < STOP_GAP) cap = Math.max(0, aheadSpeed - (STOP_GAP - aheadDist) * 1.5);
    } else if (this.shiftTarget !== 0 && (this.passTimer -= dt) <= 0) {
      // Back to the racing line once clear — only if it has room ahead (no car on it within 40 m), and
      // never across a car that is alongside.
      this.freeLine(traffic, cars, this.idx);
      const gentle = speed < 12 || this.gentleAhead(speed * (Math.abs(this.shift) / SHIFT_RATE) + 15);
      if ((this.shift > 0 ? !leftBusy : !rightBusy) && this.room.racing >= 40 && gentle) this.shiftTarget = 0;
      else this.passTimer = 0.5;
    }
    const ds = this.shiftTarget - this.shift;
    this.shift += Math.sign(ds) * Math.min(Math.abs(ds), SHIFT_RATE * dt);
    this.blocker.dist = aheadDist;
    this.blocker.speed = aheadSpeed;
    this.blocker.cap = cap;
    this.blocker.racer = aheadRacer;
    return cap;
  }

  /**
   * Last resort (flipped, or still stuck after several reversing attempts): put the car back on the road
   * at its own sample or slightly behind it (never ahead), on the freest line, with the passing state cleared.
   */
  private respawn(traffic: readonly Vehicle[] = [], cars: readonly AmbientCar[] = []): void {
    const t = this.track;
    const n = t.count;
    let k = this.idx;
    let line = this.lineAt(k);
    for (const back of [0, 4, 8, 12]) {
      const kk = (((this.idx - back) % n) + n) % n;
      const l = this.freeLine(traffic, cars, kk);
      const x = t.px[kk] + t.rx(kk) * l;
      const z = t.pz[kk] + t.rz(kk) * l;
      let clear = true;
      for (const o of traffic) {
        if (o === this.vehicle) continue;
        const q = o.physics.body.translation();
        if (Math.hypot(q.x - x, q.z - z) < 6) clear = false;
      }
      for (const c of cars) if (c.mode !== 0 && Math.hypot(c.x - x, c.z - z) < 6) clear = false;
      k = kk;
      line = l;
      if (clear) break;
    }
    this.tmp.set(t.px[k] + t.rx(k) * line, 0, t.pz[k] + t.rz(k) * line);
    this.vehicle.reset(this.tmp, Math.atan2(-t.tz[k], t.tx[k]));
    // Progress follows the car (moving back costs ground; it is never credited).
    this.progress += indexDelta(t, this.idx, k);
    this.idx = k;
    this.shift = line - this.lineAt(k);
    this.shiftTarget = this.shift;
    this.passTimer = 3;
    this.stuckTime = 0;
    this.reverseLeft = 0;
    this.attempts = 0;
    this.attemptMark = this.progress;
    this.lastX = this.tmp.x;
    this.lastZ = this.tmp.z;
    this.respawns++;
  }

  /** After world.step(): record state and advance progress. */
  afterStep(elapsed: number, raceLength: number): void {
    this.vehicle.afterStep();
    const p = this.vehicle.physics.body.translation();
    const next = this.track.trackIndex(p.x, p.z, this.idx);
    this.progress += indexDelta(this.track, this.idx, next);
    this.idx = next;
    if (this.done) {
      this.lastX = p.x;
      this.lastZ = p.z;
      return;
    }
    if (this.gates.length) {
      // Checkpoints, same rule as the player: the gate line crossed forwards, inside the opening, in order.
      const g = this.gates[this.nextGate];
      const dPrev = (this.lastX - g.x) * g.tx + (this.lastZ - g.z) * g.tz;
      const dCur = (p.x - g.x) * g.tx + (p.z - g.z) * g.tz;
      let passed = false;
      if (dPrev < 0 && dCur >= 0) {
        const k = dPrev / (dPrev - dCur);
        const cx = this.lastX + (p.x - this.lastX) * k;
        const cz = this.lastZ + (p.z - this.lastZ) * k;
        passed = Math.abs((cx - g.x) * -g.tz + (cz - g.z) * g.tx) <= g.halfWidth + GATE_TOLERANCE;
      }
      if (passed) {
        this.nextGate++;
        if (this.nextGate >= this.gates.length) {
          this.finished = true;
          this.finishTime = elapsed;
        }
      } else if (this.progress > g.mark + GATE_MISS_SAMPLES) {
        // Went past without a valid crossing (cut the course): no finish, no place.
        this.disqualified = true;
      }
    } else if (this.progress >= raceLength) {
      this.finished = true;
      this.finishTime = elapsed;
    }
    this.lastX = p.x;
    this.lastZ = p.z;
  }
}
