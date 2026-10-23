import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { CHARACTER } from './character/CharacterController';
import type { PhysicsWorld } from './PhysicsWorld';
import type { Vehicle } from './Vehicle';

/** Door handle points in the car frame (x forward, z right); left-hand drive, so the driver door is z < 0. */
const DOOR_X = -0.25;
const DOOR_Z = 1.45;
/** Max distance from a door point to get in. */
export const ENTER_RADIUS = 1.8;
/** Max car speed (m/s) for getting in / out. */
export const ENTER_MAX_SPEED = 1.5;
export const EXIT_MAX_SPEED = 2.2;

/** Candidate exit spots in the car frame, in order of preference: driver side, passenger side, behind, in front, then wider. */
const EXIT_CANDIDATES: ReadonlyArray<readonly [number, number]> = [
  [DOOR_X, -1.6],
  [DOOR_X, 1.6],
  [-3.0, 0],
  [3.0, 0],
  [DOOR_X, -2.6],
  [DOOR_X, 2.6],
  [-1.6, -1.8],
  [-1.6, 1.8],
  [-4.2, 0],
  [4.2, 0],
];

export interface DoorInfo {
  side: -1 | 1;
  /** World position of the door point (ground level of the character). */
  point: Vector3;
  distance: number;
}

export interface ExitSpot {
  feet: Vector3;
  /** Character yaw (atan2(x, z) convention: model faces +Z) facing away from the car. */
  yaw: number;
}

/**
 * Decides when the player can get in or out of the car and where to put the character
 * on exit: ground must exist at a sensible height, there must be a clear line from the
 * cabin (no stepping through walls) and a character-sized capsule must fit without
 * touching anything solid.
 */
/** Max height difference between the ground under the car and a valid exit spot (curb = 0.18 m). */
const EXIT_MAX_STEP = 0.45;
/** Heights above the car's ground at which the cabin → exit-spot line must be clear. */
const EXIT_RAY_HEIGHTS = [0.35, 0.9] as const;

export class VehicleInteraction {
  private readonly ray: RAPIER.Ray;
  private readonly capsule: RAPIER.Capsule;
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly p = new Vector3();
  private readonly door: DoorInfo = { side: -1, point: new Vector3(), distance: 0 };
  private readonly spot: ExitSpot = { feet: new Vector3(), yaw: 0 };
  private readonly identity = { x: 0, y: 0, z: 0, w: 1 };
  /** Result of the last exit search, for tests: index of the chosen candidate (-1 = none). */
  lastExitCandidate = -1;

  constructor(private readonly physics: PhysicsWorld) {
    const R = physics.R;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.capsule = new R.Capsule(CHARACTER.halfHeight, CHARACTER.radius);
  }

  /** Car frame vectors flattened to the ground plane. */
  private frame(vehicle: Vehicle): { x: number; y: number; z: number } {
    const b = vehicle.physics.body;
    const r = b.rotation();
    this.fwd.set(1 - 2 * (r.y * r.y + r.z * r.z), 0, 2 * (r.x * r.z - r.w * r.y));
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(1, 0, 0);
    this.fwd.normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    return b.translation();
  }

  /** World up-component of the car's up axis (1 = upright). */
  carUpY(vehicle: Vehicle): number {
    const r = vehicle.physics.body.rotation();
    return 1 - 2 * (r.x * r.x + r.z * r.z);
  }

  /** Nearest door within reach of the character (null if none). Does not check speed / attitude. */
  nearestDoor(vehicle: Vehicle, feet: Vector3): DoorInfo | null {
    if (!vehicle.isActive) return null;
    const c = this.frame(vehicle);
    let best: DoorInfo | null = null;
    for (const side of [-1, 1] as const) {
      this.p.set(c.x + this.fwd.x * DOOR_X + this.right.x * side * DOOR_Z, feet.y, c.z + this.fwd.z * DOOR_X + this.right.z * side * DOOR_Z);
      const d = Math.hypot(this.p.x - feet.x, this.p.z - feet.z);
      if (Math.abs(feet.y - (c.y - 0.5)) > 1.6) continue; // different level (e.g. under a ramp)
      if (d <= ENTER_RADIUS && (!best || d < best.distance)) {
        this.door.side = side;
        this.door.point.copy(this.p);
        this.door.distance = d;
        best = this.door;
      }
    }
    return best;
  }

  /** Reason the car cannot be entered right now, or null. */
  enterBlockReason(vehicle: Vehicle): string | null {
    if (this.carUpY(vehicle) < 0.7) return 'The car needs to be upright';
    if (Math.abs(vehicle.physics.forwardSpeed) > ENTER_MAX_SPEED) return 'Wait for the car to stop';
    return null;
  }

  /** Reason the player cannot get out right now, or null. */
  exitBlockReason(vehicle: Vehicle): string | null {
    if (Math.abs(vehicle.physics.forwardSpeed) > EXIT_MAX_SPEED) return 'Slow down to get out';
    return null;
  }

  /**
   * Find a safe place next to the car for the character. Returns null when every candidate
   * is blocked (walls, other cars, props) or has no ground.
   */
  findExit(vehicle: Vehicle, character: RAPIER.RigidBody | null): ExitSpot | null {
    const { world, R } = this.physics;
    const F = R.QueryFilterFlags;
    const car = vehicle.physics.body;
    const c = this.frame(vehicle);
    // Reference ground height under the car.
    const groundUnderCar = this.groundAt(c.x, c.z, c.y + 1, 4);
    const refY = groundUnderCar ?? c.y - 0.55;
    this.lastExitCandidate = -1;
    for (let k = 0; k < EXIT_CANDIDATES.length; k++) {
      const [lx, lz] = EXIT_CANDIDATES[k];
      const x = c.x + this.fwd.x * lx + this.right.x * lz;
      const z = c.z + this.fwd.z * lx + this.right.z * lz;
      const h = this.groundAt(x, z, refY + 1.5, 3.5);
      // The spot must be walkable ground at about the car's level: a curb step is fine, but the top of
      // a concrete barrier, roadblock or wall (also static geometry) is not.
      if (h === null || Math.abs(h - refY) > EXIT_MAX_STEP) continue;
      // Clear line from the cabin to the spot (never through a wall, fence or barrier), checked at
      // knee and chest height so low obstacles block as well as walls.
      const dx = x - c.x;
      const dz = z - c.z;
      const len = Math.hypot(dx, dz);
      this.ray.dir = { x: dx / len, y: 0, z: dz / len };
      let blocked = false;
      for (const rise of EXIT_RAY_HEIGHTS) {
        this.ray.origin = { x: c.x, y: refY + rise, z: c.z };
        if (world.castRay(this.ray, len + CHARACTER.radius, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_SENSORS, undefined, undefined, car)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      // The capsule must not overlap anything solid (buildings, props, other cars, the car itself).
      const centre = { x, y: h + CHARACTER.halfHeight + CHARACTER.radius + 0.03, z };
      const hit = world.intersectionWithShape(centre, this.identity, this.capsule, F.EXCLUDE_SENSORS, undefined, undefined, character ?? undefined);
      if (hit) continue;
      this.spot.feet.set(x, h, z);
      // Face away from the car, along the line from the cabin.
      this.spot.yaw = Math.atan2(dx, dz);
      this.lastExitCandidate = k;
      return this.spot;
    }
    return null;
  }

  /** Height of static ground at (x, z), casting down from `fromY` (null if nothing within `depth`). */
  private groundAt(x: number, z: number, fromY: number, depth: number): number | null {
    const { world, R } = this.physics;
    const F = R.QueryFilterFlags;
    this.ray.origin = { x, y: fromY, z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = world.castRayAndGetNormal(this.ray, depth, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_KINEMATIC | F.EXCLUDE_SENSORS);
    if (!hit || hit.normal.y < 0.7) return null;
    return fromY - hit.timeOfImpact;
  }

  /** Door point world position for a side (for the walk-to-door animation). */
  doorPoint(vehicle: Vehicle, side: -1 | 1, out: Vector3): Vector3 {
    const c = this.frame(vehicle);
    return out.set(c.x + this.fwd.x * DOOR_X + this.right.x * side * DOOR_Z, 0, c.z + this.fwd.z * DOOR_X + this.right.z * side * DOOR_Z);
  }

  /** Character yaw that faces the car from a door point. */
  faceCarYaw(vehicle: Vehicle, side: -1 | 1): number {
    this.frame(vehicle);
    // Facing direction = -side * right.
    return Math.atan2(-side * this.right.x, -side * this.right.z);
  }
}
