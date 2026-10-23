import { Group, Quaternion, Vector3, type Scene } from 'three';
import { CarModel } from './CarModel';
import type { CarLook, CarSetup, CarStyle, VehicleDef, UpgradeLevels } from './vehicles/VehicleCatalog';
import { FACTORY_LOOK, tuningFor } from './vehicles/VehicleCatalog';
import { HitAccumulator, applyHit, createDamage, damageEffects, repairDamage, type HitResult } from './damage/DamageModel';
import { CAR } from './config';
import type { DriverInput } from './Drivetrain';
import type { PhysicsWorld } from './PhysicsWorld';
import { SkidMarks } from './SkidMarks';
import { VehiclePhysics } from './VehiclePhysics';

/**
 * The player car: Rapier-driven physics plus the visual model.
 * Rendering interpolates between the last two fixed physics states so motion
 * stays smooth at any display refresh rate.
 */
export class Vehicle {
  readonly physics: VehiclePhysics;
  model: CarModel;
  /** Garage vehicle currently driven (handling + body style). */
  vehicleId = 'kestrel';
  /** Collision damage (player car only; see updateDamage). */
  readonly damage = createDamage();
  private readonly hits = new HitAccumulator();
  /** Interpolated chassis transform (parent of the visual model). */
  readonly object = new Group();
  readonly forward = new Vector3(1, 0, 0);
  readonly skids: SkidMarks;
  private readonly contact = new Vector3();

  private readonly prevPos = new Vector3();
  private readonly currPos = new Vector3();
  private readonly prevQuat = new Quaternion();
  private readonly currQuat = new Quaternion();

  private active = true;
  /** Optional per-wheel contact listener (tyre smoke): world contact point and slip. */
  onWheelSlip: ((x: number, y: number, z: number, slip: number) => void) | null = null;

  constructor(world: PhysicsWorld, scene: Scene, spawn: Vector3, yaw: number, paint?: number) {
    this.physics = new VehiclePhysics(world, spawn, yaw);
    this.model = new CarModel(paint);
    this.model.root.position.y = -CAR.rideHeight;
    this.modelKey = `coupe|${FACTORY_LOOK.coupe.wheels}|${FACTORY_LOOK.coupe.spoiler}|${FACTORY_LOOK.coupe.kit}|${CAR.wheelRadius.toFixed(3)}|${CAR.rideHeight.toFixed(3)}`;
    this.object.name = 'player-car';
    this.object.add(this.model.root);
    scene.add(this.object);
    this.skids = new SkidMarks(scene, 4);
    this.captureState(true);
    this.render(1);
  }

  /**
   * Become a garage vehicle: apply its handling (with upgrades) and rebuild the body if the style
   * changed. Physics geometry is shared, so the car keeps its position and collision shape.
   */
  configure(def: VehicleDef, upgrades: UpgradeLevels, paint: number, look?: CarLook, setup?: CarSetup): void {
    const t = tuningFor(def, upgrades, setup);
    // Keep the wheels on the ground when the ride height changes (garage preview while paused).
    const dy = t.car.rideHeight - this.physics.car.rideHeight;
    this.physics.applyTuning(t.car, t.engine);
    if (Math.abs(dy) > 1e-4) {
      const b = this.physics.body.translation();
      this.physics.body.setTranslation({ x: b.x, y: b.y + dy, z: b.z }, true);
      this.captureState(true);
      this.render(1);
    }
    this.vehicleId = def.id;
    this.setStyle(def.style, paint, look);
  }

  /**
   * Rebuild the body when the style, parts or wheel geometry changed (otherwise only repaint).
   * Uses the current physics wheel radius / ride height, so call after applyTuning.
   */
  setStyle(style: CarStyle, paint: number, look: CarLook = FACTORY_LOOK[style]): void {
    const car = this.physics.car;
    const key = `${style}|${look.wheels}|${look.spoiler}|${look.kit}|${car.wheelRadius.toFixed(3)}|${car.rideHeight.toFixed(3)}`;
    if (this.modelKey !== key) {
      this.modelKey = key;
      const old = this.model;
      this.model = new CarModel(paint, style, { look, wheelRadius: car.wheelRadius, rideHeight: car.rideHeight });
      this.model.root.position.y = -car.rideHeight;
      this.object.add(this.model.root);
      old.dispose();
      this.model.updateWheels(this.physics.wheels);
      this.model.setDamage(this.damage);
    }
    this.model.setPaint(paint);
  }

  private modelKey = '';

  /** Turn physics collisions into damage (call once per fixed step, after the world step). */
  updateDamage(dt: number): HitResult | null {
    const p = this.physics;
    if (p.hitDv > 0) {
      this.hits.add(p.hitDv, p.hitFwd, p.hitRight);
      p.hitDv = 0;
    }
    const h = this.hits.tick(dt);
    if (!h) return null;
    const r = applyHit(this.damage, h.dv, h.hitFwd, h.hitRight);
    if (r) {
      this.model.setDamage(this.damage);
      this.applyDamageEffects();
    }
    return r;
  }

  repair(): void {
    repairDamage(this.damage);
    this.hits.clear();
    this.physics.hitDv = 0;
    this.model.setDamage(this.damage);
    this.applyDamageEffects();
  }

  /** Push the mechanical effects of the current damage into the physics (power, alignment, lock, drag). */
  applyDamageEffects(): void {
    const fx = damageEffects(this.damage);
    const p = this.physics;
    p.drivetrain.powerScale = fx.powerScale;
    p.damageSteerOffset = fx.steerPull;
    p.damageLockScale = fx.steerLockScale;
    p.damageDragScale = fx.dragScale;
  }

  fixedUpdate(dt: number, input: DriverInput): void {
    this.physics.prePhysicsStep(dt, input);
  }

  /** Call after each world.step() to record the new physics state. */
  afterStep(): void {
    this.captureState(false);
    this.emitSkids();
  }

  /** Feed each wheel's ground contact point and slip into the skid-mark buffer. */
  private emitSkids(): void {
    const wheels = this.physics.wheels;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (!w.contact || w.slip <= 0.02) {
        this.skids.add(i, 0, 0, 0, 0);
        continue;
      }
      this.contact
        .set(w.mount.x, w.mount.y - w.suspension - this.physics.car.wheelRadius, w.mount.z)
        .applyQuaternion(this.currQuat)
        .add(this.currPos);
      this.skids.add(i, this.contact.x, this.contact.y, this.contact.z, w.slip);
      if (this.onWheelSlip && w.slip > 0.3) this.onWheelSlip(this.contact.x, this.contact.y, this.contact.z, w.slip);
    }
  }

  private captureState(snap: boolean): void {
    if (!snap) {
      this.prevPos.copy(this.currPos);
      this.prevQuat.copy(this.currQuat);
    }
    const t = this.physics.body.translation();
    const r = this.physics.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
    if (snap) {
      this.prevPos.copy(this.currPos);
      this.prevQuat.copy(this.currQuat);
    }
  }

  /** Update visuals; alpha in [0,1] is the fraction between the previous and current physics step. */
  render(alpha: number): void {
    this.object.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.object.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    this.forward.set(1, 0, 0).applyQuaternion(this.object.quaternion);
    this.model.updateWheels(this.physics.wheels);
    if (this.model.style === 'motorcycle') this.model.setBikeLean(this.physics.steerInput, this.physics.forwardSpeed);
    const dt = this.physics.drivetrain;
    this.model.setLights(dt.braking, dt.reversing);
    this.skids.flush();
  }

  /** Physics-step position of the chassis (not interpolated). */
  get physicsPosition(): Vector3 {
    return this.currPos;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Take the car out of the world (pooled opponents) or put it back. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.physics.body.setEnabled(on);
    this.object.visible = on;
    if (!on) this.skids.clear();
  }

  /** New tyres (no wear). For AI cars when they are assigned; the player's own car keeps its wear. */
  fitNewTyres(): void {
    this.physics.tyres.renew(this.physics.surface?.ambient ?? 20);
  }

  reset(position: Vector3, yaw: number): void {
    this.physics.reset(position, yaw);
    this.skids.breakTrails();
    this.captureState(true);
    this.render(1);
  }

  dispose(): void {
    this.physics.dispose();
    this.model.dispose();
    this.skids.dispose();
    this.object.removeFromParent();
  }
}
