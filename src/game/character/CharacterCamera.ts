import type RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import type { PhysicsWorld } from '../PhysicsWorld';

const PIVOT_HEIGHT = 1.55;
const DEFAULT_DISTANCE = 4.4;
const MIN_PITCH = -0.32;
const MAX_PITCH = 1.15;
export const CHARACTER_FOV = 60;
/** While aiming the view looks this much higher than the orbit pitch, so the default orbit (looking
 *  down at the character) aims roughly level instead of at the pavement. */
export const AIM_PITCH_BIAS = 0.22;
/** Aim-down-sights: eye height (standing; crouch lowers it with the capsule), vertical FOV, blend rate. */
export const ADS_EYE_HEIGHT = 1.62;
export const ADS_FOV = 40;
const ADS_RATE = 13;
/** Breathing sway half-amplitude (rad) standing still; crouching halves it, moving raises it. */
export const ADS_SWAY = 0.0016;

function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Vertical FOV that keeps at least the horizontal view of a square screen in portrait. */
export function fovForAspect(vfov: number, aspect: number): number {
  if (aspect >= 1) return vfov;
  const h = Math.atan(Math.tan(MathUtils.degToRad(vfov) / 2) / aspect) * 2;
  return Math.min(100, MathUtils.radToDeg(h));
}

/**
 * Third-person orbit camera for the on-foot player.
 * Mouse / touch drag orbits (yaw + pitch), the wheel zooms, a ray cast against static
 * geometry pulls the camera in front of walls, and after a few idle seconds the camera
 * drifts back behind the direction the character is walking.
 */
export class CharacterCamera {
  /** Camera forward direction angle: forward = (sin yaw, 0, cos yaw). */
  yaw = 0;
  pitch = 0.28;
  private distance = DEFAULT_DISTANCE;
  /** Targets set each frame by the game: over-the-shoulder aim (0/1) and crouch (0/1). */
  aimTarget = 0;
  crouchTarget = 0;
  /** Aim down the sights (0/1): the camera moves to the eye behind the rear sight. */
  adsTarget = 0;
  private aimBlend = 0;
  private adsBlend = 0;
  private swayT = 0;
  private readonly eye = new Vector3();
  private readonly adsLook = new Vector3();
  /** Recoil kick (rad of extra upward look), decays quickly. */
  private kickPitch = 0;
  private crouchBlend = 0;
  private zoom = 1;
  private collisionDist = Infinity;
  private pivotY = 0;
  private readonly pivot = new Vector3();
  private readonly desired = new Vector3();
  private readonly look = new Vector3();
  private readonly ray: RAPIER.Ray;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly physics: PhysicsWorld,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  /** Apply drag deltas (pixels, sensitivity already applied) and wheel steps. */
  input(dx: number, dy: number, zoomSteps: number): void {
    // Zoomed sights view: slower look so the same hand movement covers the same screen distance.
    const s = 1 - 0.45 * this.adsBlend;
    this.yaw = wrapAngle(this.yaw - dx * 0.0052 * s);
    this.pitch = MathUtils.clamp(this.pitch + dy * 0.0042 * s, MIN_PITCH, MAX_PITCH);
    if (zoomSteps) this.zoom = MathUtils.clamp(this.zoom * Math.pow(1.1, zoomSteps), 0.55, 1.7);
  }

  /** Gunshot recoil: the view kicks up a little and settles within the fire cycle (a follow-up shot fired
   *  straight away goes slightly high, like real muzzle climb). */
  kick(amount: number): void {
    this.kickPitch = Math.min(0.06, this.kickPitch + amount * 0.5);
  }

  /** 0..1 how far the view is into the sights. */
  get ads(): number {
    return this.adsBlend;
  }

  /** Leave the sights view at once (entering a car, cut-scenes, arrest). */
  resetAds(): void {
    this.adsTarget = 0;
    this.adsBlend = 0;
  }

  /** Place the camera behind a character facing `facingYaw` (spawn / exiting the car). */
  snap(feet: Vector3, facingYaw: number): void {
    this.yaw = facingYaw;
    this.pitch = 0.28;
    this.pivotY = feet.y;
    this.collisionDist = Infinity;
    this.update(0, feet, 0, 0, 99);
  }

  /**
   * @param feet interpolated feet position
   * @param moveYaw direction the character is moving (atan2(vx, vz))
   * @param speed horizontal speed
   * @param idleTime seconds since the player last dragged the camera
   */
  update(dt: number, feet: Vector3, moveYaw: number, speed: number, idleTime: number): void {
    // Auto-follow: after 2.5 s without manual look, ease behind the walking direction.
    const kb = dt > 0 ? damp(10, dt) : 1;
    if (dt > 0) this.kickPitch *= Math.exp(-14 * dt);
    this.aimBlend += (this.aimTarget - this.aimBlend) * kb;
    this.crouchBlend += (this.crouchTarget - this.crouchBlend) * kb;
    this.adsBlend += (this.adsTarget - this.adsBlend) * (dt > 0 ? damp(ADS_RATE, dt) : 1);
    if (this.adsBlend < 0.002 && this.adsTarget === 0) this.adsBlend = 0;
    const ads = this.adsBlend;
    const aim = this.aimBlend;
    if (dt > 0 && idleTime > 2.5 && speed > 1.2 && aim < 0.05) {
      const k = damp(0.9 * Math.min(1, speed / 4), dt);
      this.yaw = wrapAngle(this.yaw + wrapAngle(moveYaw - this.yaw) * k);
      this.pitch += (0.28 - this.pitch) * k;
    }
    this.pivotY += (feet.y - this.pivotY) * (dt > 0 ? damp(12, dt) : 1);
    const cp = Math.cos(this.pitch);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // Over-the-shoulder: the pivot slides towards the right shoulder and the camera moves in.
    // With forward = (sin y, cos y), screen-right is (-cos y, sin y).
    const side = 0.55 * aim;
    this.pivot.set(feet.x - fz * side, this.pivotY + PIVOT_HEIGHT - 0.42 * this.crouchBlend - 0.05 * aim, feet.z + fx * side);
    const want = DEFAULT_DISTANCE * this.zoom * (1 - aim) + 2.6 * aim;
    this.distance += (want - this.distance) * (dt > 0 ? damp(8, dt) : 1);

    this.desired.set(
      this.pivot.x - fx * this.distance * cp,
      this.pivot.y + Math.sin(this.pitch) * this.distance,
      this.pivot.z - fz * this.distance * cp,
    );

    // Keep the camera out of walls: cast from the head towards the desired position.
    const dx = this.desired.x - this.pivot.x;
    const dy = this.desired.y - this.pivot.y;
    const dz = this.desired.z - this.pivot.z;
    const len = Math.hypot(dx, dy, dz);
    let allowed = len;
    if (len > 0.01) {
      const o = this.ray.origin;
      o.x = this.pivot.x;
      o.y = this.pivot.y;
      o.z = this.pivot.z;
      const d = this.ray.dir;
      d.x = dx / len;
      d.y = dy / len;
      d.z = dz / len;
      const F = this.physics.R.QueryFilterFlags;
      const hit = this.physics.world.castRay(this.ray, len + 0.3, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_KINEMATIC | F.EXCLUDE_SENSORS);
      if (hit) allowed = Math.max(0.5, hit.timeOfImpact - 0.3);
    }
    if (allowed < this.collisionDist || dt === 0) this.collisionDist = allowed;
    else this.collisionDist += (allowed - this.collisionDist) * damp(5, dt);
    const use = Math.min(len, this.collisionDist);
    const k = len > 0.01 ? use / len : 0;
    this.camera.position.set(this.pivot.x + dx * k, this.pivot.y + dy * k, this.pivot.z + dz * k);
    if (this.camera.position.y < 0.35) this.camera.position.y = 0.35;
    this.look.set(this.pivot.x, this.pivot.y - 0.15 - Math.max(0, 0.3 - this.pitch) * 0.4, this.pivot.z);
    if (aim > 0.001) {
      // Aim: look along the camera's yaw/pitch through the pivot, so the screen centre (crosshair)
      // points down the firing ray instead of at the character's head.
      const lp = this.pitch - AIM_PITCH_BIAS;
      const lc = Math.cos(lp);
      const ax = this.pivot.x + fx * lc * 30;
      const ay = this.pivot.y - Math.sin(lp) * 30;
      const az = this.pivot.z + fz * lc * 30;
      this.look.set(this.look.x + (ax - this.look.x) * aim, this.look.y + (ay - this.look.y) * aim, this.look.z + (az - this.look.z) * aim);
    }
    if (ads > 0.001) {
      // Sights: the eye sits just in front of the face, looking along the aim direction.
      const lp = this.pitch - AIM_PITCH_BIAS;
      const lc = Math.cos(lp);
      this.eye.set(feet.x + fx * 0.06, this.pivotY + ADS_EYE_HEIGHT - 0.42 * this.crouchBlend, feet.z + fz * 0.06);
      this.adsLook.set(this.eye.x + fx * lc * 30, this.eye.y - Math.sin(lp) * 30, this.eye.z + fz * lc * 30);
      this.camera.position.lerp(this.eye, ads);
      this.look.lerp(this.adsLook, ads);
    }
    this.camera.lookAt(this.look);
    if (this.kickPitch > 1e-4) this.camera.rotateX(this.kickPitch);
    if (ads > 0.001) {
      // Breathing sway (figure of eight); shots follow it because they leave along the camera axis.
      if (dt > 0) this.swayT += dt;
      const amp = ADS_SWAY * (1 - 0.5 * this.crouchBlend) * (1 + Math.min(2.5, speed) * 0.8) * ads;
      this.camera.rotateY(Math.sin(this.swayT * 0.9) * amp);
      this.camera.rotateX(Math.sin(this.swayT * 1.8) * amp * 0.6);
    }

    const tps = CHARACTER_FOV * (1 - 0.2 * aim);
    const fov = fovForAspect(tps + (ADS_FOV - tps) * ads, this.camera.aspect);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
