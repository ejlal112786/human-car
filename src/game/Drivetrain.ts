import { CAR, ENGINE, type CarParams, type EngineParams } from './config';

/** Normalised driver input for one physics step. */
export interface DriverInput {
  /** Accelerate pedal / key, 0..1. */
  throttle: number;
  /** Brake / reverse pedal / key, 0..1. */
  brake: number;
  /** Steering, -1 (left) .. 1 (right). */
  steer: number;
  handbrake: boolean;
}

/** Wheel-level commands produced by the drivetrain for the vehicle controller. */
export interface DriveOutput {
  /** Half the total drive force, signed along the car's forward axis (VehiclePhysics splits it between the axles by car.driveFront). */
  engineForcePerWheel: number;
  brakeFront: number;
  brakeRear: number;
  handbrake: boolean;
}

export type GearLabel = 'R' | 'N' | '1' | '2' | '3' | '4' | '5' | '6';

const TWO_PI = Math.PI * 2;
/** Speed below which the car is considered "nearly stopped" for brake → reverse switching. */
const DIRECTION_SWITCH_SPEED = 0.9;

export function torqueAt(curve: EngineParams['torqueCurve'], rpm: number): number {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [r1, t1] = curve[i];
    if (rpm <= r1) {
      const [r0, t0] = curve[i - 1];
      const k = (rpm - r0) / (r1 - r0);
      return t0 + (t1 - t0) * k;
    }
  }
  return curve[curve.length - 1][1];
}

/**
 * Simple engine + automatic gearbox model (the drive force is split front/rear by VehiclePhysics).
 * Converts driver input and the current forward speed into wheel forces,
 * and tracks the real gear and engine RPM shown on the HUD.
 */
export class Drivetrain {
  /** 1..6 for forward gears; ignored while reversing. */
  gear = 1;
  reversing = false;
  /** Engine / gearbox parameters (per vehicle; see VehiclePhysics.applyTuning). */
  engine: EngineParams = ENGINE;
  /** Engine output multiplier (damage). 1 = healthy. */
  powerScale = 1;
  /** Chassis parameters used for wheel radius and brakes. */
  car: CarParams = CAR;
  rpm: number = ENGINE.idleRpm;
  private shiftTimer = 0;
  private readonly out: DriveOutput = {
    engineForcePerWheel: 0,
    brakeFront: 0,
    brakeRear: 0,
    handbrake: false,
  };
  /** Effective throttle actually delivered to the engine this step (for HUD/audio). */
  appliedThrottle = 0;
  braking = false;

  reset(): void {
    this.gear = 1;
    this.reversing = false;
    this.rpm = this.engine.idleRpm;
    this.shiftTimer = 0;
    this.appliedThrottle = 0;
    this.braking = false;
  }

  get gearLabel(): GearLabel {
    if (this.reversing) return 'R';
    if (this.gear === 1 && this.appliedThrottle < 0.01 && Math.abs(this.lastSpeed) < 0.3) return 'N';
    return String(this.gear) as GearLabel;
  }

  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  private lastSpeed = 0;

  /**
   * @param dt fixed timestep
   * @param forwardSpeed signed speed along the chassis forward axis (m/s)
   */
  update(dt: number, forwardSpeed: number, input: DriverInput): DriveOutput {
    this.lastSpeed = forwardSpeed;
    const out = this.out;
    const r = this.car.wheelRadius;

    // --- Direction logic: S brakes while moving forward, reverses when nearly stopped (and vice versa).
    if (!this.reversing && input.brake > 0 && input.throttle === 0 && forwardSpeed <= DIRECTION_SWITCH_SPEED) {
      this.reversing = true;
      this.gear = 1;
    } else if (this.reversing && input.throttle > 0 && forwardSpeed >= -DIRECTION_SWITCH_SPEED) {
      this.reversing = false;
      this.gear = 1;
    }
    let throttle: number;
    let brake: number;
    if (!this.reversing) {
      throttle = input.throttle;
      brake = forwardSpeed > DIRECTION_SWITCH_SPEED ? input.brake : 0;
    } else {
      // In reverse, S drives backwards and W acts as the brake.
      throttle = input.throttle > 0 ? 0 : input.brake;
      brake = input.throttle;
    }

    // --- Gearbox
    const absSpeed = Math.abs(forwardSpeed);
    const wheelRadPerSec = absSpeed / r;
    const ratio = this.reversing ? this.engine.reverseRatio : this.engine.gearRatios[this.gear - 1];
    const wheelRpm = (wheelRadPerSec * ratio * this.engine.finalDrive * 60) / TWO_PI;

    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    if (!this.reversing && this.shiftTimer <= 0) {
      const maxGear = this.engine.gearRatios.length;
      if (wheelRpm > this.engine.upshiftRpm && this.gear < maxGear && forwardSpeed > 0) {
        this.gear++;
        this.shiftTimer = this.engine.shiftTime;
      } else if (this.gear > 1) {
        const lowerRatio = this.engine.gearRatios[this.gear - 2];
        const rpmInLower = (wheelRadPerSec * lowerRatio * this.engine.finalDrive * 60) / TWO_PI;
        const kickdown = throttle > 0.9 && rpmInLower < this.engine.upshiftRpm - 1400 && wheelRpm < 4200;
        if (wheelRpm < this.engine.downshiftRpm || kickdown) {
          this.gear--;
          this.shiftTimer = this.engine.shiftTime * 0.8;
        }
      }
    }

    // --- Engine RPM: locked to the wheels, with clutch slip in first/reverse at low speed.
    let targetRpm = Math.max(this.engine.idleRpm, wheelRpm);
    if ((this.gear === 1 || this.reversing) && absSpeed < 6) {
      targetRpm = Math.max(targetRpm, this.engine.idleRpm + throttle * 3600);
    } else if (this.shiftTimer > 0) {
      targetRpm = Math.max(this.engine.idleRpm, wheelRpm * 0.96);
    }
    targetRpm = Math.min(targetRpm, this.engine.limiterRpm);
    const rpmRate = 1 - Math.exp(-dt * 14);
    this.rpm += (targetRpm - this.rpm) * rpmRate;

    // --- Engine force
    let force = 0;
    const limiterCut = wheelRpm >= this.engine.limiterRpm;
    if (throttle > 0 && this.shiftTimer <= 0 && !limiterCut) {
      const torque = torqueAt(this.engine.torqueCurve, this.rpm) * throttle;
      force = (torque * ratio * this.engine.finalDrive * this.engine.efficiency) / r;
      force = Math.min(force, this.engine.maxDriveForce);
      if (this.reversing) {
        // soft speed cap in reverse
        const k = Math.max(0, 1 - absSpeed / this.engine.reverseMaxSpeed);
        force = -force * 0.55 * k;
      }
    }
    this.appliedThrottle = force !== 0 ? throttle : 0;

    // --- Brakes
    let brakeFront = 0;
    let brakeRear = 0;
    if (brake > 0) {
      brakeFront = this.car.brakeImpulseFront * brake;
      brakeRear = this.car.brakeImpulseRear * brake;
    } else if (throttle === 0) {
      // engine braking / rolling resistance; also holds the car when stopped
      const hold = absSpeed < 0.5 ? 6 : this.car.engineBrakeImpulse;
      brakeFront = hold * 0.5;
      brakeRear = hold;
    }
    if (input.handbrake) {
      brakeRear = Math.max(brakeRear, this.car.handbrakeImpulse);
      force = 0;
    }
    this.braking = brake > 0;

    out.engineForcePerWheel = force * 0.5 * this.powerScale;
    out.brakeFront = brakeFront;
    out.brakeRear = brakeRear;
    out.handbrake = input.handbrake;
    return out;
  }
}
