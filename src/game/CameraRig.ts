import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { CharacterCamera } from './character/CharacterCamera';
import { CockpitCamera } from './CockpitView';
import { FollowCamera } from './FollowCamera';
import type { LookInput } from './LookInput';
import type { PhysicsWorld } from './PhysicsWorld';
import type { Vehicle } from './Vehicle';

export type CameraMode = 'showcase' | 'vehicle' | 'character';

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Owns the chase camera (driving), the orbit camera (on foot) and the menu showcase,
 * routes look input to whichever is active, and blends smoothly from the previous
 * camera pose whenever the mode changes (getting in / out of the car).
 */
export class CameraRig {
  readonly follow: FollowCamera;
  readonly character: CharacterCamera;
  /** Driver's-head camera (vehicle mode with the cockpit view on). */
  readonly cockpit: CockpitCamera;
  /** Driver's eye in the car model frame (set by the cockpit interior for the current body). */
  readonly cockpitEye = new Vector3();
  private cockpitOn = false;
  /** The chase camera did not run while the cockpit was on: snap it to the car before using it again. */
  private followStale = false;
  /** Chase-camera collision shake multiplier (Settings → Camera motion). */
  shakeScale = 1;
  private mode: CameraMode = 'showcase';
  private blendT = 1;
  private blendDur = 0;
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private fromFov = 60;
  private readonly look = { dx: 0, dy: 0, zoom: 0 };
  private readonly blendQuat = new Quaternion();
  /** Garage: the showcase orbit follows drags / wheel / pinch instead of only circling. */
  interactiveShowcase = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    physics: PhysicsWorld,
    private readonly lookInput: LookInput,
  ) {
    this.follow = new FollowCamera(camera, physics);
    this.character = new CharacterCamera(camera, physics);
    this.cockpit = new CockpitCamera(camera);
  }

  /** Is the in-car view in use (vehicle mode with the cockpit on)? */
  get cockpitActive(): boolean {
    return this.mode === 'vehicle' && this.cockpitOn;
  }

  /** Switch the driving view between chase and cockpit; the change blends over `blend` seconds. */
  setCockpit(on: boolean, blend = 0.35): void {
    if (on === this.cockpitOn) return;
    this.cockpitOn = on;
    if (on) this.cockpit.reset();
    else this.followStale = true;
    if (this.mode === 'vehicle' && blend > 0) this.startBlend(blend);
  }

  private startBlend(blend: number): void {
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.fromFov = this.camera.fov;
    this.blendT = 0;
    this.blendDur = blend;
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  get blending(): boolean {
    return this.blendT < 1;
  }

  /** Switch camera; with `blend` > 0 the view travels from the current pose over that many seconds. */
  setMode(mode: CameraMode, blend = 0): void {
    this.mode = mode;
    if (mode === 'vehicle') this.cockpit.reset();
    if (blend > 0) {
      this.startBlend(blend);
    } else {
      this.blendT = 1;
    }
  }

  /**
   * Per-frame update. `feet`, `moveYaw`, `speed` describe the character (used in character mode).
   */
  update(dt: number, vehicle: Vehicle, feet: Vector3, moveYaw: number, speed: number): void {
    this.lookInput.tick(dt);
    this.lookInput.consume(this.look);
    const { dx, dy, zoom } = this.look;
    if (this.mode === 'showcase') {
      this.follow.orbitShowcase(dt, vehicle, this.interactiveShowcase, dx, dy, zoom, this.lookInput.idleTime);
    } else if (this.mode === 'vehicle' && this.cockpitOn) {
      this.cockpit.input(dx, dy, this.lookInput.dragging);
      this.cockpit.update(dt, vehicle, this.cockpitEye);
    } else if (this.mode === 'vehicle') {
      if (this.followStale) {
        this.followStale = false;
        this.follow.snap(vehicle);
      }
      this.follow.input(dx, dy, this.lookInput.dragging, zoom);
      this.follow.update(dt, vehicle, Math.abs(vehicle.physics.forwardSpeed));
    } else {
      this.character.input(dx, dy, zoom);
      this.character.update(dt, feet, moveYaw, speed, this.lookInput.idleTime);
    }
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + (this.blendDur > 0 ? dt / this.blendDur : 1));
      const k = smoothstep(this.blendT);
      this.camera.position.lerpVectors(this.fromPos, this.camera.position, k);
      // (slerpQuaternions(a, b) copies `a` into `this` first, so the target is copied out before blending.)
      this.blendQuat.copy(this.camera.quaternion);
      this.camera.quaternion.slerpQuaternions(this.fromQuat, this.blendQuat, k);
      const fov = this.fromFov + (this.camera.fov - this.fromFov) * k;
      if (Math.abs(fov - this.camera.fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  /** Complete any running mode blend immediately. */
  finishBlend(): void {
    this.blendT = 1;
  }

  shake(amount: number): void {
    if (this.mode === 'vehicle' && this.cockpitOn) this.cockpit.kick(amount);
    else if (this.mode === 'vehicle') this.follow.shake(amount * this.shakeScale);
    else if (this.mode === 'character') this.character.kick(amount);
  }
}
