import type RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { fovForAspect } from './character/CharacterCamera';
import { CAMERA } from './config';
import type { PhysicsWorld } from './PhysicsWorld';
import type { Vehicle } from './Vehicle';

function dampFactor(sharpness: number, dt: number): number {
  return 1 - Math.exp(-sharpness * dt);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Third-person chase camera.
 * The camera is placed in a car-relative frame whose yaw is smoothed (so turns
 * swing the view naturally) while the position itself is not lagged, which keeps
 * the car framed even at high speed. Drags (fed in through {@link input}) orbit; wheel zooms.
 * A ray cast against static geometry keeps the camera out of buildings.
 */
export class FollowCamera {
  private yaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private zoom = 1;
  private distance: number = CAMERA.distance;
  private pivotY = 0;
  private fov: number = CAMERA.fov;
  private dragging = false;
  private releaseTimer = 0;
  private collisionDist = Infinity;
  private shakeAmount = 0;
  private shakeTime = 0;

  private readonly desired = new Vector3();
  private readonly look = new Vector3();
  private readonly pivot = new Vector3();
  private readonly ray: RAPIER.Ray;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly physics: PhysicsWorld,
  ) {
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  /**
   * Look input for this frame: drag deltas (pixels, sensitivity applied), whether a drag is
   * active, and wheel steps. The orbit springs back a moment after the drag ends.
   */
  input(dx: number, dy: number, dragging: boolean, zoomSteps: number): void {
    if (dx || dy) {
      this.orbitYaw = wrapAngle(this.orbitYaw - dx * 0.006);
      this.orbitPitch = MathUtils.clamp(this.orbitPitch + dy * 0.004, -0.2, 0.95);
    }
    if (this.dragging && !dragging) this.releaseTimer = CAMERA.orbitReturnDelay;
    this.dragging = dragging;
    if (zoomSteps) this.zoom = MathUtils.clamp(this.zoom * Math.pow(1.08, zoomSteps), 0.6, 1.8);
  }

  private headingOf(vehicle: Vehicle): number {
    const f = vehicle.forward;
    return Math.atan2(-f.z, f.x);
  }

  /** Add a short decaying shake (e.g. on collisions). amount is roughly metres of jitter. */
  shake(amount: number): void {
    this.shakeAmount = Math.min(0.35, Math.max(this.shakeAmount, amount));
  }

  /** Jump straight to the resting chase position (used on spawn / reset). */
  snap(vehicle: Vehicle): void {
    this.yaw = this.headingOf(vehicle);
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.releaseTimer = 0;
    this.distance = CAMERA.distance;
    this.pivotY = vehicle.object.position.y;
    this.fov = CAMERA.fov;
    this.collisionDist = Infinity;
    this.shakeAmount = 0;
    this.update(0, vehicle, 0);
  }

  /** Garage orbit: player-controlled pitch and zoom (kept apart from the driving zoom). */
  private showPitch = 0.12;
  private showZoom = 1;
  private showZoomTarget = 1;

  /**
   * Circle the car. Attract mode (menus): slow automatic orbit. Interactive (garage): drags orbit the car,
   * wheel / pinch zoom, and the slow automatic orbit resumes after a few idle seconds.
   */
  orbitShowcase(dt: number, vehicle: Vehicle, interactive = false, dx = 0, dy = 0, zoomSteps = 0, idle = 99): void {
    if (interactive) {
      if (dx || dy) {
        this.orbitYaw = wrapAngle(this.orbitYaw - dx * 0.006);
        this.showPitch = MathUtils.clamp(this.showPitch + dy * 0.004, 0.0, 0.85);
      }
      if (zoomSteps) this.showZoomTarget = MathUtils.clamp(this.showZoomTarget * Math.pow(1.08, zoomSteps), 0.55, 1.6);
    } else {
      this.showPitch += (0.12 - this.showPitch) * (dt > 0 ? dampFactor(2, dt) : 1);
      this.showZoomTarget = 1;
    }
    if (!interactive || idle > 3) this.orbitYaw = wrapAngle(this.orbitYaw + dt * 0.18 * Math.min(1, interactive ? idle - 3 : 1));
    this.showZoom += (this.showZoomTarget - this.showZoom) * (dt > 0 ? dampFactor(8, dt) : 1);
    this.orbitPitch = this.showPitch;
    this.releaseTimer = 1;
    const driveZoom = this.zoom;
    this.zoom = this.showZoom;
    this.update(dt, vehicle, 0);
    this.zoom = driveZoom;
  }

  /** Garage view state (tests). */
  get showcaseView(): { yaw: number; pitch: number; zoom: number } {
    return { yaw: this.orbitYaw, pitch: this.showPitch, zoom: this.showZoomTarget };
  }

  update(dt: number, vehicle: Vehicle, speed: number): void {
    const car = vehicle.object.position;
    const speedK = MathUtils.clamp(speed / 55, 0, 1);

    // Smoothed heading follows the car; more responsive at speed.
    const heading = this.headingOf(vehicle);
    const yawRate = CAMERA.yawSharpness * (0.8 + speedK * 0.6);
    this.yaw = wrapAngle(this.yaw + wrapAngle(heading - this.yaw) * (dt > 0 ? dampFactor(yawRate, dt) : 1));

    // Orbit springs back after the mouse is released.
    if (!this.dragging) {
      if (this.releaseTimer > 0) this.releaseTimer -= dt;
      else {
        const k = dampFactor(3, dt);
        this.orbitYaw -= this.orbitYaw * k;
        this.orbitPitch -= this.orbitPitch * k;
      }
    }

    const targetDist = MathUtils.lerp(CAMERA.distance, CAMERA.distanceAtSpeed, speedK) * this.zoom;
    this.distance += (targetDist - this.distance) * (dt > 0 ? dampFactor(3, dt) : 1);
    // Vertical pivot is damped to soak up bumps (curbs) without lagging horizontally.
    this.pivotY += (car.y - this.pivotY) * (dt > 0 ? dampFactor(10, dt) : 1);

    const yaw = this.yaw + this.orbitYaw;
    const pitch = this.orbitPitch;
    const back = this.distance * Math.cos(pitch);
    this.pivot.set(car.x, this.pivotY + 0.9, car.z);
    this.desired.set(
      car.x - Math.cos(yaw) * back,
      this.pivotY + CAMERA.height + this.distance * Math.sin(pitch) * 1.2,
      car.z + Math.sin(yaw) * back,
    );

    // Keep the camera from clipping into static geometry.
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
      const hit = this.physics.world.castRay(this.ray, len, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_KINEMATIC | F.EXCLUDE_SENSORS);
      if (hit) allowed = Math.max(CAMERA.minDistance, hit.timeOfImpact - 0.35);
    }
    // Pull in instantly when blocked, ease back out when clear.
    if (allowed < this.collisionDist || dt === 0) this.collisionDist = allowed;
    else this.collisionDist += (allowed - this.collisionDist) * dampFactor(4, dt);
    const useDist = Math.min(len, this.collisionDist);
    if (len > 0.01) {
      const k = useDist / len;
      this.camera.position.set(this.pivot.x + dx * k, this.pivot.y + dy * k, this.pivot.z + dz * k);
    }
    if (this.shakeAmount > 0.001 && dt > 0) {
      this.shakeTime += dt;
      const a = this.shakeAmount;
      this.camera.position.x += Math.sin(this.shakeTime * 71) * a;
      this.camera.position.y += Math.sin(this.shakeTime * 53 + 1.3) * a * 0.6;
      this.camera.position.z += Math.sin(this.shakeTime * 67 + 2.1) * a;
      this.shakeAmount *= Math.exp(-dt * 7);
    }
    if (this.camera.position.y < 0.4) this.camera.position.y = 0.4;

    // Look slightly ahead of the car in its direction of travel.
    const f = vehicle.forward;
    this.look.set(car.x + f.x * CAMERA.lookAhead, this.pivotY + CAMERA.lookHeight - 0.2, car.z + f.z * CAMERA.lookAhead);
    this.camera.lookAt(this.look);

    const targetFov = MathUtils.lerp(CAMERA.fov, CAMERA.fovAtSpeed, speedK * speedK);
    this.fov += (targetFov - this.fov) * (dt > 0 ? dampFactor(2.5, dt) : 1);
    const fov = fovForAspect(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    /* no listeners: input arrives through input() */
  }
}
