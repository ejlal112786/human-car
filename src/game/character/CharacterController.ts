import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { PhysicsWorld } from '../PhysicsWorld';

export const CHARACTER = {
  radius: 0.3,
  /** Half length of the capsule's cylindrical part; total height = 2 * (halfHeight + radius) = 1.8 m. */
  halfHeight: 0.6,
  walkSpeed: 1.9,
  runSpeed: 5.4,
  /** Ground acceleration / deceleration (m/s²). */
  accel: 18,
  airAccel: 4,
  jumpSpeed: 5.0,
  gravity: -18,
  /** Curbs and steps up to this height are climbed automatically. */
  stepHeight: 0.38,
  snapToGround: 0.35,
  /** Seconds after leaving the ground during which a jump is still accepted. */
  coyoteTime: 0.12,
  /** Fastest the character turns to face its movement direction (rad/s). */
  turnRate: 12,
} as const;

/** Height of the capsule centre above the feet (standing). */
const CENTER_Y = CHARACTER.halfHeight + CHARACTER.radius;
/** Crouched capsule: total height 1.1 m (fits under 1.2 m ducts). */
export const CROUCH_HALF = 0.25;
const CROUCH_CENTER_Y = CROUCH_HALF + CHARACTER.radius;
/** Speed factors while crouched / aiming. */
export const CROUCH_SPEED = 0.5;
export const AIM_SPEED = 0.75;

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Physics side of the on-foot player: a kinematic capsule moved by Rapier's
 * KinematicCharacterController (collides with buildings, props, the car and the
 * world boundary; climbs curbs; snaps to the ground; gravity and jumping).
 * Runs inside the game's fixed timestep, before world.step().
 */
export class CharacterController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  /** Feet position after the last fixed step. */
  readonly position = new Vector3();
  /** Feet position before the last fixed step (render interpolation). */
  readonly prevPosition = new Vector3();
  readonly velocity = new Vector3();
  /** Facing angle: the model's forward vector is (sin yaw, 0, cos yaw). */
  yaw = 0;
  prevYaw = 0;
  /** Angular speed of the facing (rad/s), used to animate turning on the spot. */
  turnSpeed = 0;
  grounded = true;
  /** Seconds since the controller last touched the ground. */
  airTime = 0;
  /** Set for one step when a jump starts (animation trigger). */
  jumped = false;
  /** Smoothed horizontal speed actually achieved (m/s); lower than the commanded speed against walls. */
  actualSpeed = 0;
  private enabled = true;
  private readonly desired = { x: 0, y: 0, z: 0 };
  private readonly next = { x: 0, y: 0, z: 0 };
  /** Crouched (short capsule, slow, quiet). */
  crouched = false;
  private centerY = CENTER_Y;
  /** Facing override (aiming: the character faces the camera); null = face the movement direction. */
  faceYaw: number | null = null;
  /** Aiming: walk speed reduced, no running. */
  aiming = false;

  constructor(private readonly physics: PhysicsWorld) {
    const { R, world } = physics;
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, CENTER_Y, 0));
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(CHARACTER.halfHeight, CHARACTER.radius).setFriction(0).setRestitution(0),
      this.body,
    );
    const kcc = world.createCharacterController(0.03);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    kcc.setMinSlopeSlideAngle((35 * Math.PI) / 180);
    kcc.enableAutostep(CHARACTER.stepHeight, 0.12, false);
    kcc.enableSnapToGround(CHARACTER.snapToGround);
    kcc.setSlideEnabled(true);
    // Walking into cones, barrels and crates pushes them around.
    kcc.setApplyImpulsesToDynamicBodies(true);
    kcc.setCharacterMass(75);
    this.kcc = kcc;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Remove the capsule from the simulation (while the player is in the car) or bring it back. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.body.setEnabled(on);
  }

  /** Place the feet at `feet`, facing `yaw`, at rest. */
  teleport(feet: Vector3, yaw: number): void {
    this.position.copy(feet);
    this.prevPosition.copy(feet);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.prevYaw = yaw;
    this.turnSpeed = 0;
    this.actualSpeed = 0;
    this.grounded = true;
    this.airTime = 0;
    this.body.setTranslation({ x: feet.x, y: feet.y + this.centerY, z: feet.z }, true);
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + this.centerY, z: feet.z });
  }

  /**
   * Crouch / stand up. Standing up is refused (returns false) while something is overhead,
   * e.g. inside a duct. The feet stay where they are.
   */
  setCrouch(on: boolean): boolean {
    if (on === this.crouched) return true;
    const { R, world } = this.physics;
    if (!on) {
      const head = this.position.y + CROUCH_CENTER_Y * 2;
      const ray = new R.Ray({ x: this.position.x, y: head - 0.05, z: this.position.z }, { x: 0, y: 1, z: 0 });
      const hit = world.castRay(ray, CENTER_Y * 2 - CROUCH_CENTER_Y * 2 + 0.1, true, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.collider);
      if (hit) return false;
    }
    this.crouched = on;
    this.centerY = on ? CROUCH_CENTER_Y : CENTER_Y;
    this.collider.setShape(new R.Capsule(on ? CROUCH_HALF : CHARACTER.halfHeight, CHARACTER.radius));
    this.teleportKeep();
    return true;
  }

  /** Re-place the capsule over the current feet (after a shape change), keeping velocity and facing. */
  private teleportKeep(): void {
    const f = this.position;
    this.body.setTranslation({ x: f.x, y: f.y + this.centerY, z: f.z }, true);
    this.body.setNextKinematicTranslation({ x: f.x, y: f.y + this.centerY, z: f.z });
  }

  /**
   * One fixed step. `moveX/moveZ` is the desired world-space direction scaled by stick
   * magnitude (length <= 1); `run` selects the run speed; `jump` requests a jump.
   */
  step(dt: number, moveX: number, moveZ: number, run: boolean, jump: boolean): void {
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;
    this.jumped = false;
    if (!this.enabled) return;

    const mag = Math.min(1, Math.hypot(moveX, moveZ));
    const base = this.crouched ? CHARACTER.walkSpeed * CROUCH_SPEED : this.aiming ? CHARACTER.walkSpeed * AIM_SPEED : run ? CHARACTER.runSpeed : CHARACTER.walkSpeed;
    const speed = base * mag;
    const tx = mag > 1e-3 ? (moveX / mag) * speed : 0;
    const tz = mag > 1e-3 ? (moveZ / mag) * speed : 0;
    const a = (this.grounded ? CHARACTER.accel : CHARACTER.airAccel) * dt;
    const dvx = tx - this.velocity.x;
    const dvz = tz - this.velocity.z;
    const dl = Math.hypot(dvx, dvz);
    if (dl <= a) {
      this.velocity.x = tx;
      this.velocity.z = tz;
    } else {
      this.velocity.x += (dvx / dl) * a;
      this.velocity.z += (dvz / dl) * a;
    }

    if (jump && !this.crouched && (this.grounded || this.airTime < CHARACTER.coyoteTime) && this.velocity.y <= 0.1) {
      this.velocity.y = CHARACTER.jumpSpeed;
      this.grounded = false;
      this.airTime = CHARACTER.coyoteTime;
      this.jumped = true;
    }
    this.velocity.y += CHARACTER.gravity * dt;
    if (this.grounded && this.velocity.y < -2) this.velocity.y = -2;

    this.desired.x = this.velocity.x * dt;
    this.desired.y = this.velocity.y * dt;
    this.desired.z = this.velocity.z * dt;
    this.kcc.computeColliderMovement(this.collider, this.desired, this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded) {
      this.airTime = 0;
      if (this.velocity.y < 0) this.velocity.y = -0.5;
    } else {
      this.airTime += dt;
      // Bumped a ceiling / overhang: stop rising.
      if (this.velocity.y > 0 && m.y < this.desired.y * 0.5) this.velocity.y = 0;
    }
    // Note: the velocity is deliberately NOT clipped to the achieved movement when blocked.
    // Doing so starves Rapier's autostep (tiny requested moves never climb the curb).
    // The speed actually achieved is tracked separately for the animation.
    if (dt > 0) {
      const achieved = Math.hypot(m.x, m.z) / dt;
      this.actualSpeed += (achieved - this.actualSpeed) * Math.min(1, dt * 12);
    }
    if (!wasGrounded && this.grounded) this.velocity.y = -0.5;

    const t = this.body.translation();
    this.next.x = t.x + m.x;
    this.next.y = t.y + m.y;
    this.next.z = t.z + m.z;
    // Safety net: never fall through the world.
    if (this.next.y < this.centerY - 0.5) {
      this.next.y = this.centerY;
      this.velocity.y = 0;
    }
    this.body.setNextKinematicTranslation(this.next);
    this.position.set(this.next.x, this.next.y - this.centerY, this.next.z);

    // Face the direction of travel (or the aim direction).
    if (this.faceYaw !== null || mag > 0.05) {
      const targetYaw = this.faceYaw ?? Math.atan2(moveX, moveZ);
      const diff = wrapAngle(targetYaw - this.yaw);
      const maxTurn = CHARACTER.turnRate * dt;
      this.yaw = wrapAngle(this.yaw + Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 14))));
    }
    this.turnSpeed = dt > 0 ? Math.abs(wrapAngle(this.yaw - this.prevYaw)) / dt : 0;
  }

  /** Horizontal speed (m/s). */
  get planarSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.kcc);
    this.physics.world.removeRigidBody(this.body);
  }
}
