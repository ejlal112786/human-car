/**
 * Central tuning constants. Units: metres, seconds, kilograms, newtons, radians.
 */

/** Fixed physics timestep (60 Hz). */
export const FIXED_DT = 1 / 60;
/** Maximum physics sub-steps per rendered frame (prevents the "spiral of death"). */
export const MAX_SUBSTEPS = 5;

export const GRAVITY = -9.81;

export const ROAD = {
  /** Half width of the asphalt carriageway (4 lanes x 3.5 m). */
  halfWidth: 7,
  laneWidth: 3.5,
  curbWidth: 0.35,
  sidewalkWidth: 4.2,
  /** Height of curb + sidewalk top above the road. */
  sidewalkHeight: 0.15,
  /** Height of the asphalt mesh above the ground plane (visual only). */
  surfaceY: 0.02,
} as const;

/** Outer edge of the sidewalk measured from the road centre line. */
export const SIDEWALK_OUTER = ROAD.halfWidth + ROAD.curbWidth + ROAD.sidewalkWidth;

export const CAR = {
  mass: 1350,
  /** Chassis-local centre-of-mass offset (lower = more stable). */
  centerOfMass: { x: 0.05, y: -0.22, z: 0 },
  inertia: { x: 520, y: 2500, z: 2300 },
  halfExtents: { x: 2.18, y: 0.34, z: 0.9 },
  colliderOffsetY: 0.08,

  wheelRadius: 0.34,
  wheelWidth: 0.27,
  wheelBaseFront: 1.34,
  wheelBaseRear: -1.31,
  trackHalf: 0.82,
  /** Height of the suspension mount in chassis space. */
  wheelMountY: 0,
  suspensionRestLength: 0.3,
  suspensionStiffness: 32,
  suspensionCompression: 2.6,
  suspensionRelaxation: 3.2,
  maxSuspensionTravel: 0.25,
  maxSuspensionForce: 60000,
  frictionSlipFront: 1.35,
  frictionSlipRear: 1.3,
  sideStiffnessFront: 1.0,
  sideStiffnessRear: 1.0,
  /** Rear lateral stiffness while the handbrake is held (lets the tail slide). */
  handbrakeSideStiffness: 0.22,
  /** Rear lateral stiffness in a power slide (rear already sliding past driftEnterSlip with throttle on). 1 = no drift help. */
  driftSideStiffness: 0.3,
  /** Rear-axle slip angle (rad) above which throttle starts to keep the rear sliding. */
  driftEnterSlip: 0.12,
  /** Rear friction limit multiplier while the handbrake is held. */
  handbrakeFrictionScale: 0.6,
  /** Rear friction limit multiplier in a full power slide (wheelspin costs lateral grip). 1 = no power oversteer. */
  driftFrictionScale: 0.7,

  /** Share of engine force sent to the front axle: 0 = rear-wheel drive, 1 = front-wheel drive, between = AWD. */
  driveFront: 0,

  /** Distance from the chassis origin down to the ground at rest (used for spawning); = rest length + radius - static sag. */
  rideHeight: 0.56,

  maxSteerLow: 0.58,
  steerSpeedFalloff: 16,
  steerRateIn: 3.2,
  steerRateOut: 5.5,

  /** Brake impulse (N·s per physics step) per wheel at full pedal. */
  brakeImpulseFront: 70,
  brakeImpulseRear: 45,
  handbrakeImpulse: 90,
  /** Light brake applied when coasting to emulate engine braking. */
  engineBrakeImpulse: 3.5,

  dragCoefficient: 0.5, // 0.5 * rho * Cd * A
  rollingResistance: 190, // N
  downforceCoefficient: 0.35,
  /** Extra yaw damping (N·m per rad/s) to keep the car from spinning uncontrollably. */
  yawDamping: 900,

  // --- Realism layer (shared by every car unless a car overrides it; see docs/REALISM-UPDATE.md)
  /** Road-tyre friction: multiplies frictionSlipFront / Rear (the per-car values keep their ratios). */
  tyreMu: 0.82,
  /** Multiplies downforceCoefficient (road cars make little downforce). */
  aeroScale: 0.3,
  /**
   * Roll moment arm (m): tyre side forces act at the road, below the centre of mass, but the ray-cast
   * vehicle applies them without that lever. A torque mass · lateral acceleration · rollArm about the
   * chassis' forward axis restores body roll and the lateral load transfer that comes with it. 0 = off.
   */
  rollArm: 0.4,
  /** Tyre load sensitivity: friction coefficient falls by this fraction per 100 % extra load on a wheel. 0 = off. */
  loadSensitivity: 0.15,
  /** Steering rate falls with speed: rate / (1 + speed / steerRateFalloff) (m/s). 0 = constant rate. */
  steerRateFalloff: 50,
  /** Garage tyre-pressure step (−2 … +2, set by tuningFor): tyre heat and aquaplaning speed. */
  tyrePressure: 0,
  /** Brake force per wheel limited to friction × load × this (0 = no limit). */
  longitudinalMu: 1.0,
  /**
   * Drive force per axle limited to (both tyres' grip) × this, only while surface / weather / tyre state lowers
   * grip. 1.5 is the lowest value that leaves every car's dry launch unchanged, so the step from 'no limit'
   * to 'limit' at the edge of dry conditions is negligible; on a wet road (×0.72) it bites.
   */
  tractionMu: 1.5,
  linearDamping: 0.02,
  angularDamping: 0.4,
} as const;

export const ENGINE = {
  idleRpm: 900,
  redlineRpm: 7400,
  limiterRpm: 7600,
  upshiftRpm: 7000,
  downshiftRpm: 3100,
  gearRatios: [3.15, 2.18, 1.64, 1.3, 1.06, 0.87],
  reverseRatio: 3.0,
  finalDrive: 3.7,
  efficiency: 0.85,
  shiftTime: 0.22,
  /** Hard cap on the total wheel force (simple traction control). */
  maxDriveForce: 9800,
  reverseMaxSpeed: 9, // m/s (~32 km/h)
  /** Torque curve sampled as [rpm, Nm]. */
  torqueCurve: [
    [800, 260],
    [2000, 380],
    [3500, 470],
    [5000, 520],
    [6200, 510],
    [7000, 470],
    [7600, 420],
  ] as ReadonlyArray<readonly [number, number]>,
} as const;

/** Literal `as const` types widened to plain numbers (so tuned copies can hold other values). */
type Widen<T> = T extends number
  ? number
  : T extends boolean
    ? boolean
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<Widen<U>>
      : T extends object
        ? { readonly [K in keyof T]: Widen<T[K]> }
        : T;
/** Chassis / tyre / suspension parameters of one vehicle (defaults: {@link CAR}). */
export type CarParams = Widen<typeof CAR>;
/** Engine and gearbox parameters of one vehicle (defaults: {@link ENGINE}). */
export type EngineParams = Widen<typeof ENGINE>;

export const CAMERA = {
  distance: 6.4,
  distanceAtSpeed: 7.6,
  height: 2.25,
  lookAhead: 2.5,
  lookHeight: 1.0,
  fov: 62,
  fovAtSpeed: 74,
  positionSharpness: 9,
  yawSharpness: 5.5,
  orbitReturnDelay: 1.6,
  minDistance: 2.2,
} as const;
