import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAR, type CarParams, type EngineParams } from './config';
import { Drivetrain, type DriverInput } from './Drivetrain';
import type { PhysicsWorld } from './PhysicsWorld';
import { TyreModel } from './TyreModel';
import type { SurfaceKind, SurfaceProvider, SurfaceSample } from './world/Surface';

/** How long after a handbrake kick (or while sliding) throttle can sustain a power slide. */
const DRIFT_LATCH_S = 1.2;
/** Rear slip angle (rad, ~20°) above which a slide is treated as a drift even without a kick. */
const DRIFT_BIG_SLIP = 0.35;

export interface WheelState {
  /** Chassis-space mount point. */
  readonly mount: Vector3;
  readonly front: boolean;
  /** Current visual steering angle (radians, positive = left, i.e. about +Y). */
  steer: number;
  /** Current suspension length (metres). */
  suspension: number;
  /** Accumulated wheel rotation about its axle (radians). */
  spin: number;
  contact: boolean;
  /** Tyre slip intensity 0..1 (sideways slide, locked wheel or wheelspin) — drives skid marks/audio. */
  slip: number;
}

const WHEEL_INDEX = { FL: 0, FR: 1, RL: 2, RR: 3 } as const;

/**
 * Rigid-body vehicle using Rapier's ray-cast vehicle controller.
 * Chassis convention: +X forward, +Y up, +Z right.
 */
export class VehiclePhysics {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly drivetrain = new Drivetrain();
  readonly wheels: WheelState[] = [];
  /** Handling parameters of this vehicle (garage tuning); geometry fields are shared by all cars. */
  car: CarParams = CAR;
  private readonly mainCollider: RAPIER.Collider;
  private readonly cabinCollider: RAPIER.Collider;

  /** Normalised steering, -1 (left) .. 1 (right), after rate limiting. */
  steerInput = 0;
  /** Signed speed along the chassis forward axis (m/s). */
  forwardSpeed = 0;
  /** Lateral (sideways) speed of the centre of mass. */
  lateralSpeed = 0;
  /** Lateral speed at the rear axle — large when the tail is sliding. */
  rearSlip = 0;
  /** Yaw rate about the chassis up axis (rad/s, positive = left). */
  yawRate = 0;
  /** Seconds the car has been upside-down / on its side. */
  flippedTime = 0;
  /** Strongest tyre slip this step (0..1). */
  maxSlip = 0;
  /**
   * Velocity change (m/s) caused by a collision in the last step, beyond what tyres
   * and engine can produce. Consumers read it and set it back to 0.
   */
  impact = 0;
  /**
   * Strongest horizontal collision since the last consume (for damage): velocity change (m/s) and
   * direction from the car centre towards the contact in the car frame (+fwd = nose, +right).
   */
  hitDv = 0;
  hitFwd = 0;
  hitRight = 0;
  private readonly prevVel = new Vector3();
  private skipImpact = true;

  /**
   * Extra per-wheel grip factor (FL, FR, RL, RR) set from outside each step — road surface, tyre
   * temperature / wear, weather. 1 = dry tarmac, new tyres.
   */
  readonly gripScale = [1, 1, 1, 1];
  /** Road / weather under the wheels (null = dry asphalt everywhere: menus, headless tests). */
  surface: SurfaceProvider | null = null;
  /** Tyre temperature and wear (always simulated). */
  readonly tyres = new TyreModel();
  /** Surface under each wheel, standing water there (0..1) and how much it is aquaplaning (0..1). */
  readonly surfaceKind: SurfaceKind[] = ['road', 'road', 'road', 'road'];
  readonly wheelWater = new Float32Array(4);
  readonly aquaplane = new Float32Array(4);
  /** Rolling-resistance factor of the surfaces under the wheels (1 = asphalt). */
  surfaceDrag = 1;
  private readonly surfaceHints = [{ idx: -1 }, { idx: -1 }, { idx: -1 }, { idx: -1 }];
  private readonly surfaceTmp: SurfaceSample = { kind: 'road', grip: 1, drag: 1, water: 0 };
  private readonly wheelTmp = new Vector3();
  /** Per-wheel load factor from tyre load sensitivity (updated after each vehicle step). */
  readonly loadFactor = [1, 1, 1, 1];
  /** Normal load per wheel from the last step (N); diagnostics / tyre model. */
  readonly wheelLoad = [0, 0, 0, 0];
  private readonly frictionApplied = [-1, -1, -1, -1];
  private rearGrip = 1;
  private rearGripApplied = -1;
  private rearFriction = 1;
  private rearFrictionApplied = 1;
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly q = new Quaternion();
  private readonly vel = new Vector3();
  private readonly force = new Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    position: Vector3,
    yaw: number,
  ) {
    const { R, world } = physics;
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setLinearDamping(this.car.linearDamping)
      .setAngularDamping(this.car.angularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    const he = this.car.halfExtents;
    const main = R.ColliderDesc.cuboid(he.x, he.y, he.z)
      .setTranslation(0, this.car.colliderOffsetY, 0)
      .setMassProperties(
        this.car.mass,
        this.car.centerOfMass,
        this.car.inertia,
        { w: 1, x: 0, y: 0, z: 0 },
      )
      .setFriction(0.35)
      .setRestitution(0.08);
    this.mainCollider = world.createCollider(main, this.body);
    // Cabin collider (massless) so the roof also collides.
    const cabin = R.ColliderDesc.cuboid(1.05, 0.14, 0.68)
      .setTranslation(-0.42, 0.56, 0)
      .setDensity(0)
      .setFriction(0.35);
    this.cabinCollider = world.createCollider(cabin, this.body);

    this.controller = world.createVehicleController(this.body);
    const mounts: Array<[number, number, boolean]> = [
      [this.car.wheelBaseFront, -this.car.trackHalf, true],
      [this.car.wheelBaseFront, this.car.trackHalf, true],
      [this.car.wheelBaseRear, -this.car.trackHalf, false],
      [this.car.wheelBaseRear, this.car.trackHalf, false],
    ];
    for (let i = 0; i < mounts.length; i++) {
      const [x, z, front] = mounts[i];
      const mount = new Vector3(x, this.car.wheelMountY, z);
      this.controller.addWheel(mount, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, this.car.suspensionRestLength, this.car.wheelRadius);
      this.controller.setWheelSuspensionStiffness(i, this.car.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, this.car.suspensionCompression);
      this.controller.setWheelSuspensionRelaxation(i, this.car.suspensionRelaxation);
      this.controller.setWheelMaxSuspensionTravel(i, this.car.maxSuspensionTravel);
      this.controller.setWheelMaxSuspensionForce(i, this.car.maxSuspensionForce);
      this.controller.setWheelSideFrictionStiffness(i, front ? this.car.sideStiffnessFront : this.car.sideStiffnessRear);
      this.wheels.push({ mount, front, steer: 0, suspension: this.car.suspensionRestLength, spin: 0, contact: false, slip: 0 });
    }

    this.applyFriction();
    this.reset(position, yaw);
  }

  /**
   * Switch handling (garage). The collider and wheel mount points are the same for every car; wheel
   * radius and suspension rest length (hence ride height), mass, inertia, centre of mass, drivetrain
   * split, tyres, suspension, steering, brakes, aero and the engine/gearbox change.
   */
  applyTuning(car: CarParams, engine: EngineParams): void {
    this.car = car;
    this.drivetrain.car = car;
    this.drivetrain.engine = engine;
    this.mainCollider.setMassProperties(car.mass, car.centerOfMass, car.inertia, { w: 1, x: 0, y: 0, z: 0 });
    this.mainCollider.setShape(new this.physics.R.Cuboid(car.halfExtents.x, car.halfExtents.y, car.halfExtents.z));
    const motorcycle = car.trackHalf < 0.2;
    this.cabinCollider.setEnabled(!motorcycle);
    this.body.setLinearDamping(car.linearDamping);
    this.body.setAngularDamping(car.angularDamping);
    for (let i = 0; i < this.wheels.length; i++) {
      const front = this.wheels[i].front;
      const mountX = front ? car.wheelBaseFront : car.wheelBaseRear;
      const mountZ = i % 2 === 0 ? -car.trackHalf : car.trackHalf;
      this.wheels[i].mount.set(mountX, car.wheelMountY, mountZ);
      this.controller.setWheelChassisConnectionPointCs(i, { x: mountX, y: car.wheelMountY, z: mountZ });
      this.controller.setWheelRadius(i, car.wheelRadius);
      this.controller.setWheelSuspensionRestLength(i, car.suspensionRestLength);
      this.controller.setWheelSuspensionStiffness(i, car.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, car.suspensionCompression);
      this.controller.setWheelSuspensionRelaxation(i, car.suspensionRelaxation);
      this.controller.setWheelMaxSuspensionTravel(i, car.maxSuspensionTravel);
      this.controller.setWheelMaxSuspensionForce(i, car.maxSuspensionForce);
      this.controller.setWheelSideFrictionStiffness(i, front ? car.sideStiffnessFront : car.sideStiffnessRear);
      this.frictionApplied[i] = -1;
      this.loadFactor[i] = 1;
    }
    this.rearGrip = car.sideStiffnessRear;
    this.rearGripApplied = car.sideStiffnessRear;
    this.rearFriction = 1;
    this.rearFrictionApplied = 1;
    this.driftLatch = 0;
    this.drivetrain.reset();
    this.applyFriction();
  }

  /** Teleport the car to a ground position and heading, clearing all motion. */
  reset(position: Vector3, yaw: number): void {
    const half = yaw * 0.5;
    this.body.setTranslation({ x: position.x, y: position.y + this.car.rideHeight + 0.05, z: position.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.drivetrain.reset();
    this.steerInput = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.rearSlip = 0;
    this.yawRate = 0;
    this.flippedTime = 0;
    this.maxSlip = 0;
    this.impact = 0;
    this.hitDv = 0;
    this.skipImpact = true;
    this.tyres.reset(this.surface?.ambient ?? 20);
    for (let i = 0; i < 4; i++) {
      this.surfaceHints[i].idx = -1;
      this.aquaplane[i] = 0;
      this.loadFactor[i] = 1;
      this.wheels[i].slip = 0;
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelSteering(i, 0);
      this.wheels[i].steer = 0;
      this.wheels[i].suspension = this.car.suspensionRestLength - 0.08;
    }
    this.setHandbrake(false);
  }

  private setHandbrake(on: boolean): void {
    this.rearGrip = on ? this.car.handbrakeSideStiffness : this.car.sideStiffnessRear;
    this.rearFriction = on ? this.car.handbrakeFrictionScale : 1;
    this.applyRearGrip();
  }

  private applyRearGrip(): void {
    if (Math.abs(this.rearGrip - this.rearGripApplied) < 0.004 && Math.abs(this.rearFriction - this.rearFrictionApplied) < 0.004) return;
    this.rearGripApplied = this.rearGrip;
    this.rearFrictionApplied = this.rearFriction;
    for (const w of [WHEEL_INDEX.RL, WHEEL_INDEX.RR]) this.controller.setWheelSideFrictionStiffness(w, this.rearGrip);
    this.applyFriction();
  }

  /**
   * Friction limit per wheel = the car's tyre value × road-tyre μ × (rear: handbrake / power-slide
   * factor) × load sensitivity × external grip (surface, tyre state, weather). Only changed values are
   * pushed to Rapier.
   */
  private applyFriction(): void {
    const car = this.car;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const base = (front ? car.frictionSlipFront : car.frictionSlipRear * this.rearFriction) * car.tyreMu;
      const v = base * this.loadFactor[i] * this.gripScale[i];
      if (Math.abs(v - this.frictionApplied[i]) > 0.002) {
        this.frictionApplied[i] = v;
        this.controller.setWheelFrictionSlip(i, v);
      }
    }
  }

  /**
   * Grip of each wheel from what it stands on: surface (and its wetness), tyre temperature / wear, and
   * aquaplaning in standing water above the tyre's onset speed. Written to gripScale for applyFriction.
   */
  private updateSurface(): void {
    const s = this.surface;
    const speed = Math.abs(this.forwardSpeed);
    const wet = s ? s.wetness : 0;
    let drag = 0;
    let n = 0;
    const b = this.body.translation();
    for (let i = 0; i < 4; i++) {
      let g = this.tyres.grip(i, wet);
      if (s) {
        const p = this.wheelTmp.copy(this.wheels[i].mount).applyQuaternion(this.q);
        s.sample(b.x + p.x, b.z + p.z, this.surfaceHints[i], this.surfaceTmp);
        const t = this.surfaceTmp;
        this.surfaceKind[i] = t.kind;
        this.wheelWater[i] = t.water;
        // Aquaplaning: above the onset speed the tyre rides up on the water film (grip → 20 % at +10 m/s).
        const a = t.water > 0 ? Math.min(1, Math.max(0, (speed - this.tyres.aquaplaneOnset(i, this.car.tyrePressure)) / 10)) * Math.min(1, t.water * 1.4) : 0;
        this.aquaplane[i] = a;
        g *= t.grip * (1 - 0.8 * a);
        if (this.controller.wheelIsInContact(i)) {
          drag += t.drag;
          n++;
        }
      }
      this.gripScale[i] = g;
    }
    this.surfaceDrag = n > 0 ? drag / n : 1;
  }

  /** Friction limit currently applied to wheel i (tests / HUD). */
  frictionOf(i: number): number {
    return this.frictionApplied[i];
  }

  /**
   * Rear lateral grip for this step: low while the handbrake is held (the tail steps out); in a power
   * slide — the rear axle already sliding past driftEnterSlip with throttle applied — it blends down to
   * driftSideStiffness so the slide can be held with counter-steer and throttle. Lifting off restores grip.
   */
  /** Mechanical damage (set from DamageModel.damageEffects by Vehicle): alignment pull (rad, + = left). */
  damageSteerOffset = 0;
  /** Mechanical damage: fraction of the steering lock still available. */
  damageLockScale = 1;
  /** Mechanical damage: drag factor (bent panels → lower top speed). */
  damageDragScale = 1;

  /** Seconds left in which throttle may keep a slide going (refreshed while sliding). */
  private driftLatch = 0;
  /** User-selectable stability aid: 1 is the calibrated baseline, >1 is more forgiving. */
  stabilityAssist = 1;

  private updateRearGrip(dt: number, handbrake: boolean, throttle: number, speed: number): void {
    const car = this.car;
    let target = car.sideStiffnessRear;
    let friction = 1;
    this.driftLatch = Math.max(0, this.driftLatch - dt);
    if (handbrake && speed > 0.5) {
      target = car.handbrakeSideStiffness;
      friction = car.handbrakeFrictionScale;
      if (speed > 6) this.driftLatch = DRIFT_LATCH_S;
    } else if (speed > 6 && this.forwardSpeed > 0 && !this.drivetrain.reversing && throttle > 0.05) {
      const beta = Math.atan2(Math.abs(this.rearSlip), Math.abs(this.forwardSpeed));
      // Power slides only continue a slide that was started on purpose (handbrake) or that is
      // already big; ordinary hard cornering keeps full rear grip.
      if (beta > car.driftEnterSlip && (this.driftLatch > 0 || beta > DRIFT_BIG_SLIP)) {
        this.driftLatch = DRIFT_LATCH_S;
        const k = Math.min(1, (beta - car.driftEnterSlip) / 0.1) * Math.min(1, throttle * 1.25);
        target = car.sideStiffnessRear + (car.driftSideStiffness - car.sideStiffnessRear) * k;
        friction = 1 + (car.driftFrictionScale - 1) * k;
      }
    }
    // Grip drops quickly but recovers a little more gently (no snap back).
    const rate = target < this.rearGrip ? 14 : 6;
    this.rearGrip += (target - this.rearGrip) * Math.min(1, dt * rate);
    this.rearFriction += (friction - this.rearFriction) * Math.min(1, dt * (friction < this.rearFriction ? 14 : 6));
    this.applyRearGrip();
  }

  private updateBasis(): void {
    const r = this.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    this.fwd.set(1, 0, 0).applyQuaternion(this.q);
    this.right.set(0, 0, 1).applyQuaternion(this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    const v = this.body.linvel();
    this.vel.set(v.x, v.y, v.z);
    this.forwardSpeed = this.vel.dot(this.fwd);
    this.lateralSpeed = this.vel.dot(this.right);
    const av = this.body.angvel();
    this.yawRate = av.x * this.up.x + av.y * this.up.y + av.z * this.up.z;
    // v_rear = v + w x r_rear, with r_rear = fwd * wheelBaseRear  =>  lateral part = lat - yawRate * rearX
    this.rearSlip = this.lateralSpeed - this.yawRate * this.car.wheelBaseRear;
  }

  /** Apply driver input and advance the vehicle controller. Call once per fixed step, before world.step(). */
  prePhysicsStep(dt: number, input: DriverInput): void {
    this.updateBasis();
    const speed = Math.abs(this.forwardSpeed);

    // Collision detection from abrupt velocity change between steps (tyres/brakes can
    // change velocity by at most ~0.3 m/s per 60 Hz step, so anything far above that is an impact).
    if (!this.skipImpact) {
      const dv = this.prevVel.distanceTo(this.vel);
      if (dv > 1.6) this.impact = Math.max(this.impact, dv);
      // Horizontal part only (landings are not crashes). The contact pushed the car, so it lies
      // opposite to the velocity change.
      const dx = this.vel.x - this.prevVel.x;
      const dz = this.vel.z - this.prevVel.z;
      const dvH = Math.hypot(dx, dz);
      if (dvH > 1.6 && dvH > this.hitDv) {
        this.hitDv = dvH;
        this.hitFwd = -(dx * this.fwd.x + dz * this.fwd.z) / dvH;
        this.hitRight = -(dx * this.right.x + dz * this.right.z) / dvH;
      }
    }
    this.skipImpact = false;
    this.prevVel.copy(this.vel);

    // --- Steering: rate-limited, with speed-dependent maximum angle.
    const target = input.steer;
    const returning = Math.abs(target) < Math.abs(this.steerInput) || Math.sign(target) !== Math.sign(this.steerInput);
    // Heavier, slower steering at speed (a real rack + tyre self-aligning torque); returning stays quicker.
    const rateFall = this.car.steerRateFalloff > 0 && !returning ? 1 + speed / this.car.steerRateFalloff : 1;
    const rate = ((returning ? this.car.steerRateOut : this.car.steerRateIn) / rateFall) * dt;
    const diff = target - this.steerInput;
    this.steerInput += Math.max(-rate, Math.min(rate, diff));
    const maxSteer = this.car.maxSteerLow / (1 + speed / this.car.steerSpeedFalloff);
    // Rapier steers about +Y: positive = left. Our input: positive = right.
    // Damage: less lock with a crushed nose, and a bent alignment pulls to the side that was hit.
    const steerAngle = -this.steerInput * maxSteer * this.damageLockScale + this.damageSteerOffset;

    // --- Drivetrain
    const drive = this.drivetrain.update(dt, this.forwardSpeed, input);
    this.updateRearGrip(dt, drive.handbrake, drive.handbrake ? 0 : input.throttle, speed);

    const c = this.controller;
    c.setWheelSteering(WHEEL_INDEX.FL, steerAngle);
    c.setWheelSteering(WHEEL_INDEX.FR, steerAngle);
    // Drivetrain split: engineForcePerWheel is half the total drive force; driveFront of it goes to the front axle.
    const split = this.car.driveFront;
    const frontForce = drive.engineForcePerWheel * split;
    const rearForce = drive.engineForcePerWheel * (1 - split);

    // --- Aerodynamics, rolling resistance and yaw stability (applied as forces during world.step()).
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const v2 = this.vel.lengthSq();
    if (v2 > 0.01) {
      const vLen = Math.sqrt(v2);
      const dragMag = this.car.dragCoefficient * this.damageDragScale * v2 + (this.anyWheelContact() ? this.car.rollingResistance * this.surfaceDrag : 0);
      this.force.copy(this.vel).multiplyScalar(-dragMag / vLen);
      // downforce along the chassis' down axis
      this.force.addScaledVector(this.up, -this.car.downforceCoefficient * this.car.aeroScale * this.forwardSpeed * this.forwardSpeed);
      this.body.addForce(this.force, false);
    }
    const yawTorque = -this.yawRate * this.car.yawDamping * this.stabilityAssist;
    let tx = this.up.x * yawTorque;
    let ty = this.up.y * yawTorque;
    let tz = this.up.z * yawTorque;
    if (this.car.rollArm > 0 && this.anyWheelContact()) {
      // Roll moment of the tyre side forces about the centre of mass (centripetal acceleration v·r,
      // positive = towards the left). Turning left, the body rolls out to the right.
      const aLat = Math.max(-15, Math.min(15, this.forwardSpeed * this.yawRate));
      const roll = this.car.mass * aLat * this.car.rollArm;
      tx += this.fwd.x * roll;
      ty += this.fwd.y * roll;
      tz += this.fwd.z * roll;
    }
    this.body.addTorque({ x: tx, y: ty, z: tz }, false);

    this.updateSurface();
    this.applyFriction();
    // Drive and brake forces, each limited by what that tyre can transmit (Rapier's ray-cast vehicle limits
    // only the side force by the friction value; without this a car would brake as hard on wet grass as on
    // dry asphalt). Load is last step's suspension force.
    const muB = this.car.longitudinalMu;
    const muT = this.car.tractionMu;
    const gripOf = (i: number): number => this.frictionApplied[i] * Math.max(0, this.wheelLoad[i]);
    // Drive is limited per axle (the axle's two tyres together, like a limited-slip differential), so load
    // moving to the outside wheel in a corner does not cut drive; brakes act on each wheel.
    // The drive limit uses the tyre's normal grip scaled only by surface / weather / tyre state (gripScale),
    // not the handbrake / power-oversteer rear-grip cut: the existing wheelspin model already covers that.
    const car = this.car;
    const tractionOf = (i: number): number =>
      (i < 2 ? car.frictionSlipFront : car.frictionSlipRear) * car.tyreMu * this.loadFactor[i] * this.gripScale[i] * Math.max(0, this.wheelLoad[i]);
    // Only where something lowers grip: on dry asphalt with tyres in their window the calibrated drivetrain
    // already stays within traction, and the limit would only bite on load transients (kerbs, contact).
    const reduced = (a: number, b: number): boolean => this.gripScale[a] < 0.999 || this.gripScale[b] < 0.999;
    const axleFront = reduced(0, 1) ? (tractionOf(0) + tractionOf(1)) / 2 : Infinity;
    const axleRear = reduced(2, 3) ? (tractionOf(2) + tractionOf(3)) / 2 : Infinity;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const grip = gripOf(i);
      const f = front ? frontForce : rearForce;
      const axle = front ? axleFront : axleRear;
      c.setWheelEngineForce(i, muT > 0 ? Math.sign(f) * Math.min(Math.abs(f), axle * muT) : f);
      const b = front ? drive.brakeFront : drive.brakeRear;
      c.setWheelBrake(i, muB > 0 ? Math.min(b, grip * muB * dt) : b);
    }
    c.updateVehicle(dt);
    this.updateLoads();

    // --- Wheel visuals state and per-wheel slip
    const launching =
      !this.drivetrain.reversing && this.drivetrain.gear === 1 && input.throttle > 0.9 && this.forwardSpeed > 0.3 && this.forwardSpeed < 9;
    let maxSlip = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.steer = w.front ? steerAngle : 0;
      w.contact = c.wheelIsInContact(i);
      w.suspension = c.wheelSuspensionLength(i) ?? this.car.suspensionRestLength;
      const locked = !w.front && drive.handbrake;
      if (!locked) w.spin += (this.forwardSpeed / this.car.wheelRadius) * dt;

      let slip = 0;
      if (w.contact) {
        // Lateral velocity of the contact patch in the wheel's own frame.
        const latAxle = this.lateralSpeed - this.yawRate * w.mount.x;
        const lateral = this.forwardSpeed * Math.sin(w.steer) + latAxle * Math.cos(w.steer);
        slip = Math.min(1, Math.max(0, (Math.abs(lateral) - 2.2) / 4));
        if (locked && speed > 2) slip = Math.max(slip, Math.min(1, 0.35 + speed / 15));
        if (launching) {
          // Launch wheelspin on the driven wheels (an AWD car shares the torque, so spins less).
          const share = w.front ? split : 1 - split;
          if (share > 0.2) slip = Math.max(slip, 0.75 * Math.min(1, share * 1.6) * (1 - this.forwardSpeed / 9));
        }
      }
      w.slip = slip;
      if (slip > maxSlip) maxSlip = slip;
      // Tyre heat / wear from the real sliding speed of the contact patch (sideways, locked, wheelspin).
      let slipSpeed = 0;
      if (w.contact) {
        const latAxle = this.lateralSpeed - this.yawRate * w.mount.x;
        slipSpeed = Math.abs(this.forwardSpeed * Math.sin(w.steer) + latAxle * Math.cos(w.steer));
        if (locked) slipSpeed = Math.hypot(slipSpeed, speed);
        else if (launching) slipSpeed = Math.max(slipSpeed, 6 * slip);
      }
      this.tyres.step(i, dt, slipSpeed, w.contact ? this.wheelLoad[i] : 0, speed, this.surface?.ambient ?? 20, this.surface ? this.surface.wetness : 0, this.car.tyrePressure);
    }
    this.maxSlip = maxSlip;

    // --- Flip detection (used for auto-recovery)
    if (this.up.y < 0.35 && speed < 2) this.flippedTime += dt;
    else this.flippedTime = 0;
  }

  /** Wheel loads from the suspension, and the load-sensitivity factor each tyre gets next step. */
  private updateLoads(): void {
    const c = this.controller;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const f = c.wheelIsInContact(i) ? Math.max(0, c.wheelSuspensionForce(i) ?? 0) : 0;
      this.wheelLoad[i] = f;
      if (f > 0) {
        sum += f;
        n++;
      }
    }
    const ls = this.car.loadSensitivity;
    const mean = n > 0 ? sum / n : 0;
    for (let i = 0; i < 4; i++) {
      // A tyre carrying more than its share has a lower friction coefficient (real tyres are sub-linear).
      this.loadFactor[i] = ls > 0 && mean > 1 && this.wheelLoad[i] > 0 ? Math.max(0.7, Math.min(1.25, 1 - ls * (this.wheelLoad[i] / mean - 1))) : 1;
    }
  }

  private anyWheelContact(): boolean {
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) return true;
    return false;
  }

  /** Total "slip" indicator 0..1 based on lateral speed and handbrake (for skid effects). */
  get slip(): number {
    const lat = Math.max(Math.abs(this.rearSlip), Math.abs(this.lateralSpeed));
    return Math.min(1, Math.max(0, (lat - 1.5) / 5));
  }

  get speedKmh(): number {
    return Math.abs(this.forwardSpeed) * 3.6;
  }

  dispose(): void {
    this.physics.world.removeVehicleController(this.controller);
    this.physics.world.removeRigidBody(this.body);
  }
}
