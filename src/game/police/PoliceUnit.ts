import { Vector3 } from 'three';
import { CAR } from '../config';
import type { DriverInput } from '../Drivetrain';
import type { Vehicle } from '../Vehicle';
import type { Track } from '../world/Track';
import { curvature } from '../missions/RaceAI';
import { planRoute } from '../navigation/Navigation';

const WHEELBASE = CAR.wheelBaseFront - CAR.wheelBaseRear;
/** Lateral grip used for corner speeds (m/s², a little under the race AI's: police drive in traffic). */
const GRIP = 9;
const DECEL = 6.5;
/** Pursuit top speed (m/s ≈ 190 km/h). */
export const PURSUIT_TOP = 53;
/** Pursuit top speed (m/s) per wanted level 1..3: low levels can be outrun, 3 stars is relentless. */
export const STAR_TOP_SPEED = [30, 38, PURSUIT_TOP] as const;
/** Patrol cruising speed (m/s ≈ 47 km/h). */
export const PATROL_SPEED = 13;
/** Within this distance the unit steers straight at the target (with lead) instead of following the road. */
const DIRECT_RANGE = 35;
const LANE_INNER = 1.75;
const LANE_OUTER = 5.25;

/** Fastest speed from which the target's speed can still be reached (≈4 m/s² braking) before a 7.5 m gap. */
function approachSpeed(targetSpeed: number, dist: number): number {
  return Math.sqrt(targetSpeed * targetSpeed + 8 * Math.max(0, dist - 7.5));
}

export interface PursuitTarget {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Road sample nearest the target. */
  idx: number;
  onFoot: boolean;
}

/** Something on the road to drive around (traffic cars, other units). */
export interface RoadObstacle {
  x: number;
  z: number;
  /** Speed along its heading (m/s); only used to follow when every lane is blocked. */
  speed: number;
}

/**
 * Drives one police car: patrols a lane at city speed, or pursues a target. Far away it follows the
 * road (shortest way round the loop, lane changes around traffic, corner speed limits); close in it
 * steers straight at the target with a little lead. Recovery (stuck, flipped, facing the wrong way
 * for too long) is requested through `needsRespawn` — the owner places the car out of the player's sight.
 */
export class PoliceUnit {
  readonly input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  idx = 0;
  dir: 1 | -1 = 1;
  /** Current lateral offset (smoothed towards the chosen lane). */
  lane = LANE_OUTER;
  stuck = 0;
  misaligned = 0;
  needsRespawn = false;
  /** Distance to the target at the last update (Infinity when patrolling). */
  targetDist = Infinity;
  private readonly fwd = new Vector3();
  private readonly tmp = new Vector3();

  constructor(
    readonly vehicle: Vehicle,
    private readonly track: Track,
  ) {}

  /** Put the car on the road at sample `i`, in the lane for direction `dir`, facing that way. */
  place(i: number, dir: 1 | -1, lane = LANE_OUTER): void {
    const t = this.track;
    const k = ((i % t.count) + t.count) % t.count;
    this.idx = k;
    this.dir = dir;
    this.lane = dir * lane;
    this.tmp.set(t.px[k] + t.rx(k) * this.lane, 0, t.pz[k] + t.rz(k) * this.lane);
    const yaw = Math.atan2(-t.tz[k], t.tx[k]) + (dir < 0 ? Math.PI : 0);
    this.vehicle.reset(this.tmp, yaw);
    this.stuck = 0;
    this.misaligned = 0;
    this.needsRespawn = false;
  }

  /**
   * One fixed step, before world.step(). `target` null = patrol. `hold` = stop and wait (busted).
   */
  /** Pursuit top speed (m/s); set from the wanted level by the police system. */
  topSpeed: number = PURSUIT_TOP;

  fixedUpdate(dt: number, target: PursuitTarget | null, hold: boolean, obstacles: readonly RoadObstacle[]): void {
    const inp = this.input;
    const vp = this.vehicle.physics;
    const body = vp.body;
    const p = body.translation();
    const t = this.track;
    const n = t.count;
    this.idx = t.trackIndex(p.x, p.z, this.idx);
    if (hold) {
      inp.throttle = 0;
      inp.brake = Math.abs(vp.forwardSpeed) > 0.5 ? 1 : 0;
      inp.steer = 0;
      inp.handbrake = Math.abs(vp.forwardSpeed) <= 0.5;
      this.vehicle.fixedUpdate(dt, inp);
      this.stuck = 0;
      this.misaligned = 0;
      return;
    }
    const r = body.rotation();
    this.fwd.set(1 - 2 * (r.y * r.y + r.z * r.z), 2 * (r.x * r.y + r.w * r.z), 2 * (r.x * r.z - r.w * r.y));
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const fx = this.fwd.x / fl;
    const fz = this.fwd.z / fl;
    const speed = Math.max(0, vp.forwardSpeed);

    let ax: number;
    let az: number;
    let vTarget: number;
    this.targetDist = Infinity;
    if (target) {
      const dist = Math.hypot(target.x - p.x, target.z - p.z);
      this.targetDist = dist;
      const tv = Math.hypot(target.vx, target.vz);
      if (dist < DIRECT_RANGE) {
        const lead = target.onFoot ? 0 : Math.min(0.8, dist / 25);
        ax = target.x + target.vx * lead;
        az = target.z + target.vz * lead;
        if (target.onFoot) vTarget = Math.max(0, (dist - 7) * 1.2);
        // Closing speed that can still be braked away (≈4 m/s²) before the 7.5 m following gap.
        // Inside the gap: drop back in proportion (direct steering cuts corners, so matching speed is not enough).
        else vTarget = dist < 8 ? Math.max(0, tv - 0.5 - (8 - dist) * 1.5) : Math.min(tv + 14, approachSpeed(tv, dist));
        // A car (usually another unit) right in front and nearer than the target: follow it instead of shunting it.
        vTarget = Math.min(vTarget, this.followAhead(obstacles, p.x, p.z, fx, fz, dist), this.cornerSpeed(this.topSpeed));
        // Keep the road direction current so leaving direct mode does not flip-flop.
        this.dir = planRoute(t, this.idx, target.idx, this.dir).dir;
      } else {
        this.dir = planRoute(t, this.idx, target.idx, this.dir).dir;
        const want = this.chooseLane(obstacles, p.x, p.z, true);
        this.lane += Math.sign(want - this.lane) * Math.min(Math.abs(want - this.lane), 3.2 * dt);
        const look = Math.round(4 + speed * 0.32);
        const j = (((this.idx + this.dir * look) % n) + n) % n;
        ax = t.px[j] + t.rx(j) * this.lane;
        az = t.pz[j] + t.rz(j) * this.lane;
        vTarget = Math.min(this.cornerSpeed(this.topSpeed), this.blockedSpeed, target.onFoot ? approachSpeed(0, dist - 2) : approachSpeed(tv, dist));
      }
    } else {
      const want = this.chooseLane(obstacles, p.x, p.z, false);
      this.lane += Math.sign(want - this.lane) * Math.min(Math.abs(want - this.lane), 1.5 * dt);
      const look = Math.round(4 + speed * 0.32);
      const j = (((this.idx + this.dir * look) % n) + n) % n;
      ax = t.px[j] + t.rx(j) * this.lane;
      az = t.pz[j] + t.rz(j) * this.lane;
      vTarget = Math.min(PATROL_SPEED, this.cornerSpeed(PATROL_SPEED), this.blockedSpeed);
    }

    // --- Steering: pure pursuit to the aim point.
    const dx = ax - p.x;
    const dz = az - p.z;
    const ld = Math.max(3, Math.hypot(dx, dz));
    const lx = dx * fx + dz * fz;
    const lz = -dx * fz + dz * fx;
    const maxSteer = CAR.maxSteerLow / (1 + speed / CAR.steerSpeedFalloff);
    if (lx < -1) {
      // Aim point behind: slow down and turn round on full lock.
      this.misaligned += dt;
      inp.steer = lz >= 0 ? 1 : -1;
      vTarget = Math.min(vTarget, 6);
    } else {
      this.misaligned = Math.max(0, this.misaligned - dt * 2);
      const alpha = Math.atan2(lz, lx);
      const delta = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / ld);
      inp.steer = Math.max(-1, Math.min(1, delta / maxSteer));
    }

    // --- Pedals.
    if (speed < vTarget - 0.6) {
      inp.throttle = 1;
      inp.brake = 0;
    } else if (speed > vTarget + 1.5) {
      inp.throttle = 0;
      inp.brake = Math.min(1, (speed - vTarget) / 5);
    } else {
      inp.throttle = vTarget < 0.5 ? 0 : 0.35;
      inp.brake = vTarget < 0.5 && speed > 0.3 ? 0.6 : 0;
    }
    inp.handbrake = vTarget < 0.5 && speed < 0.5;
    this.vehicle.fixedUpdate(dt, inp);

    // --- Recovery requests.
    const wantsToMove = vTarget > 2;
    if (speed < 1 && wantsToMove) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 2.5 || this.misaligned > 4 || vp.flippedTime > 2) this.needsRespawn = true;
  }

  /** Following speed behind the nearest obstacle in our path that is closer than `maxDist`. */
  private followAhead(obstacles: readonly RoadObstacle[], x: number, z: number, fx: number, fz: number, maxDist: number): number {
    let v = Infinity;
    for (const o of obstacles) {
      const ex = o.x - x;
      const ez = o.z - z;
      const along = ex * fx + ez * fz;
      if (along < 0.5 || along > maxDist - 1) continue; // behind us, ourselves, or beyond the target
      if (Math.abs(-ex * fz + ez * fx) > 2.2) continue; // not in our path
      v = Math.min(v, along < 8 ? Math.max(0, o.speed - 0.5 - (8 - along) * 1.5) : approachSpeed(o.speed, along));
    }
    return v;
  }

  /** Speed limit from the bends ahead in the travel direction (corner speed + braking distance). */
  private cornerSpeed(top: number): number {
    const kappa = curvature(this.track);
    const n = this.track.count;
    let v = top;
    for (let d = 0; d < 75; d += 2) {
      const s = (((this.idx + this.dir * d) % n) + n) % n;
      const vCorner = Math.sqrt(GRIP / Math.max(kappa[s], 1e-4));
      const dist = Math.max(0, d * this.track.spacing - 6);
      v = Math.min(v, Math.sqrt(vCorner * vCorner + 2 * DECEL * dist));
    }
    return v;
  }

  /** Follow speed when every lane ahead is blocked (set by chooseLane). */
  private blockedSpeed = Infinity;
  /** Scratch: along, lateral, speed triples of obstacles ahead. */
  private readonly near: number[] = [];

  /**
   * Pick a lane that is clear for the next stretch. Pursuit may borrow the inner oncoming lane;
   * patrol keeps to its own side and follows when blocked.
   */
  private chooseLane(obstacles: readonly RoadObstacle[], x: number, z: number, pursuit: boolean): number {
    const t = this.track;
    const k = this.idx;
    const tx = t.tx[k] * this.dir;
    const tz = t.tz[k] * this.dir;
    const speed = Math.max(0, this.vehicle.physics.forwardSpeed);
    // Look far enough ahead to finish a lane change (≈1.2 s of lateral travel) before reaching the obstacle.
    const ahead = pursuit ? Math.max(30, speed * 2.6) : Math.max(22, speed * 2);
    const lanes = pursuit ? [this.dir * LANE_INNER, this.dir * LANE_OUTER, -this.dir * LANE_INNER] : [this.dir * LANE_OUTER, this.dir * LANE_INNER];
    // Current lane first if it is still free (avoids weaving).
    const cur = lanes.reduce((a, b) => (Math.abs(b - this.lane) < Math.abs(a - this.lane) ? b : a));
    const order = [cur, ...lanes.filter((l) => l !== cur)];
    this.blockedSpeed = Infinity;
    let follow = Infinity;
    // Obstacles ahead in road coordinates: nearest sample within the next ~50 m (works in bends).
    const near = this.near;
    near.length = 0;
    const n = t.count;
    for (const o of obstacles) {
      const ex = o.x - x;
      const ez = o.z - z;
      if (ex * ex + ez * ez > (ahead + 8) * (ahead + 8) || ex * tx + ez * tz < -2) continue;
      let best = Infinity;
      let bj = -1;
      let bm = 0;
      for (let m = 0; m <= Math.ceil(ahead / t.spacing) + 2; m++) {
        const j = (((k + this.dir * m) % n) + n) % n;
        const d = (o.x - t.px[j]) ** 2 + (o.z - t.pz[j]) ** 2;
        if (d < best) {
          best = d;
          bj = j;
          bm = m;
        }
      }
      const along = bm * t.spacing - ((x - t.px[k]) * tx + (z - t.pz[k]) * tz);
      if (bj < 0 || along < 1 || along > ahead) continue;
      near.push(along, (o.x - t.px[bj]) * t.rx(bj) + (o.z - t.pz[bj]) * t.rz(bj), o.speed);
    }
    for (const lane of order) {
      let clear = true;
      for (let q = 0; q < near.length; q += 3) {
        if (Math.abs(near[q + 1] - lane) < 2.1) {
          clear = false;
          if (lane === cur) follow = Math.min(follow, Math.max(0, near[q + 2]) + Math.max(0, near[q] - 10) * 0.5);
          break;
        }
      }
      if (clear) return lane;
    }
    this.blockedSpeed = follow;
    return cur;
  }
}
