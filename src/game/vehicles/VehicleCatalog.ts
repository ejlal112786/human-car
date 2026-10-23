import { CAR, ENGINE, type CarParams, type EngineParams } from '../config';
import { torqueAt } from '../Drivetrain';

/** Body style of the procedural car model. */
export type CarStyle = 'coupe' | 'hatch' | 'muscle' | 'super' | 'sedan' | 'suv' | 'offroad' | 'race' | 'motorcycle';

export const UPGRADE_KINDS = ['engine', 'tyres', 'brakes', 'suspension'] as const;
export type UpgradeKind = (typeof UPGRADE_KINDS)[number];
export const MAX_UPGRADE = 3;
export type UpgradeLevels = Record<UpgradeKind, number>;

type Overrides<T> = { -readonly [K in keyof T]?: T[K] };

export interface VehicleDef {
  id: string;
  name: string;
  /** Short class label shown in the garage. */
  kind: string;
  style: CarStyle;
  description: string;
  /** Purchase price in credits (0 = owned from the start). */
  price: number;
  /** Total mission/event stars needed before it can be bought. */
  requiresStars: number;
  /** Paint used when first bought. */
  defaultPaint: string;
  /**
   * Changes from the baseline chassis. Collider and wheel mount positions are shared by every car;
   * wheel radius and suspension rest length may differ (ride height is derived from them, see rideHeightOf).
   */
  car: Overrides<CarParams>;
  engine: Overrides<EngineParams>;
  /** Multiplier on upgrade prices. */
  upgradeCost: number;
  /** Engine sound character. */
  audio: {
    cylinders: number;
    pitch: number;
    growl: number;
    /** Forced induction sound: turbo (whistle that spools up, blow-off valve on lift) or supercharger (whine locked to rpm). */
    induction?: 'turbo' | 'super';
    /** Loudness of the induction sound (1 = a typical performance turbo). */
    boost?: number;
  };
}

const scaleCurve = (k: number, curve: EngineParams['torqueCurve'] = ENGINE.torqueCurve): EngineParams['torqueCurve'] =>
  curve.map(([r, t]) => [r, Math.round(t * k)] as const);

export const VEHICLES: readonly VehicleDef[] = [
  {
    id: 'kestrel',
    name: 'Kestrel GT',
    kind: 'Sports coupe',
    style: 'coupe',
    description: 'Balanced rear-drive coupe. Predictable grip, good brakes, a willing V8.',
    price: 0,
    requiresStars: 0,
    defaultPaint: 'red',
    car: {},
    engine: {},
    upgradeCost: 1,
    audio: { cylinders: 8, pitch: 1, growl: 1 },
  },
  {
    id: 'pip',
    name: 'Pip GTi',
    kind: 'Hot hatch',
    style: 'hatch',
    description: 'Light front-wheel-drive hatch with a small turbo and short gearing. Pulls itself out of corners and refuses to oversteer on the throttle, but runs out of puff at speed.',
    price: 3000,
    requiresStars: 0,
    defaultPaint: 'white',
    car: {
      mass: 1080,
      centerOfMass: { x: 0.3, y: -0.22, z: 0 },
      inertia: { x: 400, y: 1950, z: 1800 },
      driveFront: 1,
      // Front drive: throttle cannot keep the rear sliding.
      driftFrictionScale: 1,
      driftSideStiffness: 0.75,
      frictionSlipFront: 1.42,
      frictionSlipRear: 1.44,
      sideStiffnessRear: 1.1,
      maxSteerLow: 0.64,
      steerRateIn: 3.9,
      steerRateOut: 6.2,
      brakeImpulseFront: 60,
      brakeImpulseRear: 40,
      dragCoefficient: 0.6,
      downforceCoefficient: 0.2,
      yawDamping: 820,
    },
    engine: {
      torqueCurve: scaleCurve(0.62),
      maxDriveForce: 7400,
      gearRatios: [3.45, 2.32, 1.72, 1.34, 1.1, 0.92],
      finalDrive: 4.15,
      redlineRpm: 6800,
      limiterRpm: 7000,
      upshiftRpm: 6500,
      downshiftRpm: 3000,
    },
    upgradeCost: 0.7,
    audio: { cylinders: 4, pitch: 1.25, growl: 0.6, induction: 'turbo', boost: 1 },
  },
  {
    id: 'brute',
    name: 'Brute V8',
    kind: 'Muscle car',
    style: 'muscle',
    description: 'Supercharged V8: huge low-down torque and a lazy, heavy front. The tail steps out if you are greedy with the throttle.',
    price: 9000,
    requiresStars: 6,
    defaultPaint: 'black',
    car: {
      mass: 1620,
      centerOfMass: { x: 0.12, y: -0.17, z: 0 },
      inertia: { x: 620, y: 3050, z: 2800 },
      suspensionStiffness: 26,
      suspensionCompression: 2.2,
      suspensionRelaxation: 2.7,
      frictionSlipFront: 1.2,
      frictionSlipRear: 1.1,
      sideStiffnessRear: 0.86,
      handbrakeSideStiffness: 0.18,
      maxSteerLow: 0.52,
      steerRateIn: 2.8,
      steerRateOut: 4.8,
      brakeImpulseFront: 70,
      brakeImpulseRear: 42,
      dragCoefficient: 0.55,
      downforceCoefficient: 0.18,
      yawDamping: 720,
    },
    engine: {
      torqueCurve: [
        [800, 420],
        [2000, 600],
        [3200, 690],
        [4400, 700],
        [5400, 660],
        [6200, 590],
        [6600, 540],
      ],
      maxDriveForce: 12600,
      gearRatios: [2.85, 1.95, 1.45, 1.15, 0.95, 0.79],
      finalDrive: 3.55,
      redlineRpm: 6400,
      limiterRpm: 6600,
      upshiftRpm: 6150,
      downshiftRpm: 2700,
      shiftTime: 0.26,
    },
    upgradeCost: 1.25,
    audio: { cylinders: 8, pitch: 0.78, growl: 1.5, induction: 'super', boost: 1 },
  },
  {
    id: 'vortex',
    name: 'Vortex RS',
    kind: 'Supercar',
    style: 'super',
    description: 'Mid-engined, all-wheel drive, screaming high-rev engine, big downforce and huge brakes. Fast everywhere.',
    price: 24000,
    requiresStars: 12,
    defaultPaint: 'orange',
    car: {
      mass: 1290,
      centerOfMass: { x: -0.12, y: -0.28, z: 0 },
      driveFront: 0.35,
      driftFrictionScale: 0.82,
      inertia: { x: 480, y: 2350, z: 2150 },
      suspensionStiffness: 40,
      suspensionCompression: 3.0,
      suspensionRelaxation: 3.6,
      frictionSlipFront: 1.62,
      frictionSlipRear: 1.58,
      sideStiffnessFront: 1.1,
      sideStiffnessRear: 1.08,
      maxSteerLow: 0.6,
      steerRateIn: 3.7,
      steerRateOut: 6.0,
      brakeImpulseFront: 96,
      brakeImpulseRear: 62,
      dragCoefficient: 0.47,
      downforceCoefficient: 1.05,
      yawDamping: 1000,
    },
    engine: {
      torqueCurve: [
        [800, 300],
        [2500, 440],
        [4000, 560],
        [5500, 640],
        [7000, 660],
        [8000, 630],
        [8800, 580],
      ],
      maxDriveForce: 13800,
      gearRatios: [3.05, 2.18, 1.68, 1.36, 1.12, 0.94],
      finalDrive: 3.85,
      redlineRpm: 8600,
      limiterRpm: 8800,
      upshiftRpm: 8250,
      downshiftRpm: 3800,
      shiftTime: 0.15,
    },
    upgradeCost: 1.6,
    audio: { cylinders: 10, pitch: 1.18, growl: 1.1 },
  },
  {
    id: 'meridian',
    name: 'Meridian LX',
    kind: 'Sedan',
    style: 'sedan',
    description: 'Comfortable front-drive family saloon with a small turbo. Soft springs, lazy steering and a long, stable wheelbase feel — calm, safe and cheap to run.',
    price: 1500,
    requiresStars: 0,
    defaultPaint: 'silver',
    car: {
      mass: 1480,
      centerOfMass: { x: 0.22, y: -0.18, z: 0 },
      inertia: { x: 600, y: 2900, z: 2700 },
      driveFront: 1,
      driftFrictionScale: 1,
      driftSideStiffness: 0.8,
      suspensionStiffness: 22,
      suspensionCompression: 2.0,
      suspensionRelaxation: 2.4,
      maxSuspensionTravel: 0.28,
      frictionSlipFront: 1.22,
      frictionSlipRear: 1.24,
      sideStiffnessRear: 1.08,
      maxSteerLow: 0.55,
      steerRateIn: 2.6,
      steerRateOut: 4.6,
      brakeImpulseFront: 62,
      brakeImpulseRear: 40,
      dragCoefficient: 0.44,
      downforceCoefficient: 0.12,
      yawDamping: 1050,
    },
    engine: {
      torqueCurve: scaleCurve(0.7),
      maxDriveForce: 7600,
      gearRatios: [3.3, 2.1, 1.5, 1.15, 0.93, 0.76],
      finalDrive: 3.6,
      redlineRpm: 6400,
      limiterRpm: 6600,
      upshiftRpm: 5800,
      downshiftRpm: 2600,
      shiftTime: 0.3,
    },
    upgradeCost: 0.6,
    audio: { cylinders: 4, pitch: 1.05, growl: 0.45, induction: 'turbo', boost: 0.45 },
  },
  {
    id: 'atlas',
    name: 'Atlas XR',
    kind: 'SUV',
    style: 'suv',
    description: 'Heavy turbocharged all-wheel-drive SUV on bigger wheels and tall, soft suspension. Strong launch and stable in a straight line, but it leans, dives under braking and needs room to stop.',
    price: 6000,
    requiresStars: 4,
    defaultPaint: 'blue',
    car: {
      mass: 2050,
      centerOfMass: { x: 0.12, y: 0.0, z: 0 },
      inertia: { x: 900, y: 4300, z: 3900 },
      wheelRadius: 0.38,
      suspensionRestLength: 0.36,
      driveFront: 0.45,
      driftFrictionScale: 0.9,
      driftSideStiffness: 0.5,
      suspensionStiffness: 19,
      suspensionCompression: 1.9,
      suspensionRelaxation: 2.3,
      maxSuspensionTravel: 0.32,
      maxSuspensionForce: 90000,
      frictionSlipFront: 1.22,
      frictionSlipRear: 1.22,
      maxSteerLow: 0.54,
      steerRateIn: 2.7,
      steerRateOut: 4.6,
      brakeImpulseFront: 92,
      brakeImpulseRear: 58,
      handbrakeImpulse: 120,
      engineBrakeImpulse: 5,
      dragCoefficient: 0.78,
      rollingResistance: 280,
      downforceCoefficient: 0.05,
      yawDamping: 1500,
    },
    engine: {
      torqueCurve: [
        [800, 380],
        [1800, 560],
        [3000, 620],
        [4200, 610],
        [5200, 560],
        [6000, 500],
        [6300, 460],
      ],
      maxDriveForce: 12000,
      gearRatios: [3.5, 2.25, 1.6, 1.22, 1.0, 0.82],
      finalDrive: 3.9,
      redlineRpm: 6100,
      limiterRpm: 6300,
      upshiftRpm: 5700,
      downshiftRpm: 2500,
      shiftTime: 0.3,
    },
    upgradeCost: 1.1,
    audio: { cylinders: 6, pitch: 0.85, growl: 0.9, induction: 'turbo', boost: 0.75 },
  },
  {
    id: 'ridgeback',
    name: 'Ridgeback 4x4',
    kind: 'Off-roader',
    style: 'offroad',
    description: 'Turbo-diesel with locked 50/50 four-wheel drive, the biggest wheels and the longest suspension travel in the garage. Shrugs off kerbs and bumps; all-terrain tyres give up early on tarmac and it tops out low.',
    price: 7500,
    requiresStars: 8,
    defaultPaint: 'green',
    car: {
      mass: 1820,
      centerOfMass: { x: 0.15, y: -0.06, z: 0 },
      inertia: { x: 820, y: 3800, z: 3500 },
      wheelRadius: 0.41,
      suspensionRestLength: 0.42,
      driveFront: 0.5,
      driftFrictionScale: 0.92,
      driftSideStiffness: 0.45,
      suspensionStiffness: 17,
      suspensionCompression: 1.7,
      suspensionRelaxation: 2.1,
      maxSuspensionTravel: 0.4,
      maxSuspensionForce: 90000,
      frictionSlipFront: 1.12,
      frictionSlipRear: 1.12,
      sideStiffnessFront: 0.9,
      sideStiffnessRear: 0.92,
      maxSteerLow: 0.6,
      steerRateIn: 2.9,
      steerRateOut: 4.8,
      brakeImpulseFront: 78,
      brakeImpulseRear: 52,
      handbrakeImpulse: 110,
      engineBrakeImpulse: 6,
      dragCoefficient: 0.95,
      rollingResistance: 480,
      downforceCoefficient: 0,
      yawDamping: 1300,
    },
    engine: {
      torqueCurve: [
        [800, 420],
        [1600, 580],
        [2600, 640],
        [3600, 620],
        [4600, 560],
        [5200, 500],
        [5500, 460],
      ],
      maxDriveForce: 12400,
      gearRatios: [4.1, 2.6, 1.75, 1.3, 1.0, 0.84],
      finalDrive: 4.1,
      redlineRpm: 5300,
      limiterRpm: 5500,
      upshiftRpm: 5000,
      downshiftRpm: 2200,
      shiftTime: 0.32,
    },
    upgradeCost: 1.15,
    audio: { cylinders: 6, pitch: 0.7, growl: 1.3, induction: 'turbo', boost: 0.6 },
  },
  {
    id: 'apex',
    name: 'Apex R',
    kind: 'Race car',
    style: 'race',
    description: 'Stripped rear-drive racer: very light, slammed on stiff springs, slick tyres, a huge wing and race brakes. Sequential gearbox with lightning shifts. Unforgiving if you overdrive it.',
    price: 40000,
    requiresStars: 30,
    defaultPaint: 'yellow',
    car: {
      mass: 1060,
      centerOfMass: { x: -0.08, y: -0.33, z: 0 },
      inertia: { x: 380, y: 1850, z: 1700 },
      wheelRadius: 0.33,
      suspensionRestLength: 0.24,
      suspensionStiffness: 58,
      suspensionCompression: 3.6,
      suspensionRelaxation: 4.2,
      maxSuspensionTravel: 0.16,
      frictionSlipFront: 1.78,
      frictionSlipRear: 1.74,
      sideStiffnessFront: 1.15,
      sideStiffnessRear: 1.1,
      handbrakeSideStiffness: 0.2,
      maxSteerLow: 0.56,
      steerRateIn: 4.3,
      steerRateOut: 7.0,
      brakeImpulseFront: 104,
      brakeImpulseRear: 70,
      dragCoefficient: 0.52,
      downforceCoefficient: 1.6,
      yawDamping: 820,
      angularDamping: 0.35,
    },
    engine: {
      torqueCurve: [
        [800, 230],
        [3000, 380],
        [5000, 470],
        [6800, 520],
        [8200, 525],
        [9000, 500],
        [9400, 470],
      ],
      maxDriveForce: 12600,
      gearRatios: [2.9, 2.15, 1.7, 1.4, 1.17, 0.95],
      finalDrive: 3.9,
      redlineRpm: 9200,
      limiterRpm: 9400,
      upshiftRpm: 9000,
      downshiftRpm: 4600,
      shiftTime: 0.08,
    },
    upgradeCost: 1.8,
    audio: { cylinders: 6, pitch: 1.35, growl: 1.2 },
  },
  {
    id: 'dune-650',
    name: 'Dune 650',
    kind: 'Dual-sport motorcycle',
    style: 'motorcycle',
    description: 'Light dual-sport with long-travel suspension and a tractable 650 cc twin. Softer setup, upright stance and lower power for forgiving city riding.',
    price: 4500,
    requiresStars: 2,
    defaultPaint: 'yellow',
    car: {
      mass: 190,
      centerOfMass: { x: -0.06, y: -0.13, z: 0 },
      inertia: { x: 78, y: 260, z: 250 },
      halfExtents: { x: 1.1, y: 0.47, z: 0.36 },
      wheelRadius: 0.36,
      wheelWidth: 0.13,
      wheelBaseFront: 1.02,
      wheelBaseRear: -1.02,
      trackHalf: 0.13,
      suspensionRestLength: 0.29,
      suspensionStiffness: 26,
      suspensionCompression: 2.4,
      suspensionRelaxation: 2.9,
      maxSuspensionTravel: 0.27,
      maxSuspensionForce: 14000,
      rideHeight: 0.58,
      maxSteerLow: 0.43,
      steerRateIn: 2.6,
      steerRateOut: 4.1,
      brakeImpulseFront: 34,
      brakeImpulseRear: 22,
      dragCoefficient: 0.39,
      rollingResistance: 42,
      downforceCoefficient: 0.08,
      tyreMu: 0.82,
      rollArm: 0.1,
      yawDamping: 155,
    },
    engine: {
      torqueCurve: [[800, 32], [2400, 45], [4500, 61], [6500, 68], [8000, 62]],
      maxDriveForce: 2200,
      gearRatios: [2.65, 1.85, 1.42, 1.17, 1.0, 0.88],
      finalDrive: 3.45,
      redlineRpm: 8200,
      limiterRpm: 8500,
      upshiftRpm: 7600,
      downshiftRpm: 3500,
      shiftTime: 0.16,
    },
    upgradeCost: 0.8,
    audio: { cylinders: 2, pitch: 1.1, growl: 1.2 },
  },
  {
    id: 'striker-900',
    name: 'Striker 900',
    kind: 'Sport motorcycle',
    style: 'motorcycle',
    description: 'Light, upright sport bike with a high-revving 900 cc inline-four. Leans into turns; inputs remain gamepad-friendly.',
    price: 6500,
    requiresStars: 3,
    defaultPaint: 'blue',
    car: {
      mass: 220,
      centerOfMass: { x: -0.04, y: -0.15, z: 0 },
      inertia: { x: 90, y: 320, z: 310 },
      halfExtents: { x: 1.15, y: 0.48, z: 0.36 },
      wheelRadius: 0.32,
      wheelWidth: 0.12,
      wheelBaseFront: 1.08,
      wheelBaseRear: -1.08,
      trackHalf: 0.12,
      suspensionRestLength: 0.22,
      suspensionStiffness: 36,
      maxSuspensionTravel: 0.18,
      rideHeight: 0.42,
      maxSteerLow: 0.38,
      steerRateIn: 2.1,
      steerRateOut: 3.8,
      brakeImpulseFront: 38,
      brakeImpulseRear: 24,
      dragCoefficient: 0.31,
      rollingResistance: 45,
      downforceCoefficient: 0.12,
      tyreMu: 0.92,
      yawDamping: 170,
      rollArm: 0.12,
    },
    engine: {
      torqueCurve: [[900, 35], [3000, 60], [6000, 82], [9000, 96], [11500, 90], [13000, 72]],
      maxDriveForce: 2900,
      gearRatios: [2.75, 2.05, 1.62, 1.35, 1.15, 1.0],
      finalDrive: 3.1,
      redlineRpm: 12800,
      limiterRpm: 13200,
      upshiftRpm: 12000,
      downshiftRpm: 5600,
      shiftTime: 0.13,
    },
    upgradeCost: 0.9,
    audio: { cylinders: 4, pitch: 1.55, growl: 0.7 },
  },
];

/** Garage display order: cheapest / most basic first, then by price. */
export const GARAGE_ORDER: readonly string[] = ['kestrel', 'meridian', 'pip', 'dune-650', 'striker-900', 'atlas', 'ridgeback', 'brute', 'vortex', 'apex'];

export const DEFAULT_VEHICLE = VEHICLES[0].id;

export function vehicleById(id: string): VehicleDef {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}

/** Base upgrade prices per level (1..3), scaled by the car's `upgradeCost`. */
export const UPGRADE_BASE: Record<UpgradeKind, readonly number[]> = {
  engine: [1500, 3000, 5000],
  tyres: [1000, 2000, 3500],
  brakes: [800, 1600, 2800],
  suspension: [900, 1800, 3000],
};

export const UPGRADE_INFO: Record<UpgradeKind, { name: string; effect: string }> = {
  engine: { name: 'Engine', effect: '+6% torque per level' },
  tyres: { name: 'Tyres', effect: '+4.5% grip per level' },
  brakes: { name: 'Brakes', effect: 'Stronger brakes and ABS: shorter stops (+4% peak braking grip per level)' },
  suspension: { name: 'Suspension', effect: '+15% spring rate, firmer dampers, lower ride and centre of mass per level' },
};

/** Price of the next level of an upgrade (null when maxed). */
export function upgradePrice(def: VehicleDef, kind: UpgradeKind, currentLevel: number): number | null {
  if (currentLevel >= MAX_UPGRADE) return null;
  return Math.round((UPGRADE_BASE[kind][currentLevel] * def.upgradeCost) / 50) * 50;
}

export function noUpgrades(): UpgradeLevels {
  return { engine: 0, tyres: 0, brakes: 0, suspension: 0 };
}

/**
 * Free garage setup (adjustments, not purchases). Each value is a whole step in −SETUP_STEPS … +SETUP_STEPS;
 * 0 is the factory setting. Effects are applied in tuningFor and measured in scripts/setup-test.ts.
 */
// Gearing (final drive) was built and measured but left out: with the automatic gearbox shifting at a
// fixed rpm and every car drag-limited below its rev limiter, ±24 % final drive changed 80–160 km/h and
// top speed by only a few per cent, and not consistently in one direction.
export const SETUP_KEYS = ['tyrePressure', 'springs', 'brakeBias'] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];
export type CarSetup = Record<SetupKey, number>;
export const SETUP_STEPS = 2;

export function neutralSetup(): CarSetup {
  return { tyrePressure: 0, springs: 0, brakeBias: 0 };
}

const clampStep = (v: number): number => Math.max(-SETUP_STEPS, Math.min(SETUP_STEPS, Math.round(v)));
/** Front share of the brake force for a bias step (factory share ± 6 % per step). */
const brakeShare = (car: Pick<CarParams, 'brakeImpulseFront' | 'brakeImpulseRear'>, step: number): number =>
  car.brakeImpulseFront / (car.brakeImpulseFront + car.brakeImpulseRear) + 0.06 * clampStep(step);

export const SETUP_INFO: Record<SetupKey, { name: string; low: string; high: string; value: (step: number, def: VehicleDef) => string }> = {
  tyrePressure: {
    name: 'Tyre pressure',
    low: 'Low: more grip, more rolling drag',
    high: 'High: less grip, less rolling drag',
    value: (s) => `${(2.2 + 0.15 * clampStep(s)).toFixed(2)} bar`,
  },
  springs: {
    name: 'Springs',
    low: 'Soft: more body roll and brake dive',
    high: 'Stiff: flatter body, less dive',
    value: (s) => `${Math.round(100 * (1 + 0.15 * clampStep(s)))} % rate`,
  },
  brakeBias: {
    name: 'Brake bias',
    low: 'Rear: turns in more when braking into a corner, but longer stops (rear tyres lock up sooner)',
    high: 'Front: steadier when braking into a corner, less rotation',
    value: (s, def) => `${Math.round(100 * brakeShare({ ...CAR, ...def.car }, s))} % front`,
  },
};

/** Clamp anything (old saves, garbage) into a valid setup. */
export function sanitizeSetup(raw: unknown): CarSetup {
  const out = neutralSetup();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of SETUP_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampStep(v);
  }
  return out;
}

/**
 * Chassis height above the road at rest: suspension rest length + wheel radius minus the static sag.
 * Rapier's suspension force per wheel is stiffness x compression x chassis mass, so four wheels carry
 * the weight at a compression of g / (4 x stiffness) whatever the mass (0.077 m for the baseline).
 */
export function rideHeightOf(car: Pick<CarParams, 'suspensionRestLength' | 'wheelRadius' | 'suspensionStiffness' | 'maxSuspensionTravel'>): number {
  const sag = Math.min(car.maxSuspensionTravel, 9.81 / (4 * car.suspensionStiffness));
  return car.suspensionRestLength + car.wheelRadius - sag;
}

/** Full physics parameters for a car with the given upgrades. */
export function tuningFor(def: VehicleDef, up: UpgradeLevels = noUpgrades(), setup: CarSetup = neutralSetup()): { car: CarParams; engine: EngineParams } {
  const baseCar: CarParams = { ...CAR, ...def.car };
  const baseEngine: EngineParams = { ...ENGINE, ...def.engine };
  const e = 1 + 0.06 * up.engine;
  const g = 1 + 0.045 * up.tyres;
  const b = 1 + 0.12 * up.brakes;
  const k = 1 + 0.15 * up.suspension;
  const d = 1 + 0.1 * up.suspension;
  const drop = 0.015 * up.suspension;
  const rest = baseCar.suspensionRestLength - drop;
  const car: CarParams = {
    ...baseCar,
    suspensionStiffness: baseCar.suspensionStiffness * k,
    suspensionCompression: baseCar.suspensionCompression * d,
    suspensionRelaxation: baseCar.suspensionRelaxation * d,
    suspensionRestLength: rest,
    centerOfMass: { ...baseCar.centerOfMass, y: baseCar.centerOfMass.y - drop },
    frictionSlipFront: baseCar.frictionSlipFront * g,
    frictionSlipRear: baseCar.frictionSlipRear * g,
    sideStiffnessFront: baseCar.sideStiffnessFront * (1 + 0.03 * up.tyres),
    sideStiffnessRear: baseCar.sideStiffnessRear * (1 + 0.03 * up.tyres),
    brakeImpulseFront: baseCar.brakeImpulseFront * b,
    brakeImpulseRear: baseCar.brakeImpulseRear * b,
    // Braking is limited by tyre grip; better pads and ABS work closer to the tyre's peak.
    longitudinalMu: baseCar.longitudinalMu * (1 + 0.04 * up.brakes),
  };
  const m = car as { -readonly [K in keyof CarParams]: CarParams[K] };
  // Setup. Tyre pressure: a softer tyre has a bigger contact patch (grip) and more rolling resistance.
  // (A carcass-stiffness effect on steering response was tried and is not measurable in this tyre model.)
  const tp = clampStep(setup.tyrePressure) / SETUP_STEPS;
  m.tyrePressure = clampStep(setup.tyrePressure);
  if (tp !== 0) {
    m.frictionSlipFront *= 1 - 0.05 * tp;
    m.frictionSlipRear *= 1 - 0.05 * tp;
    m.rollingResistance *= 1 - 0.2 * tp;
  }
  // Springs: rate ± 15 % per step; dampers follow √rate so the damping ratio stays the same.
  const ks = 1 + 0.15 * clampStep(setup.springs);
  if (ks !== 1) {
    m.suspensionStiffness *= ks;
    m.suspensionCompression *= Math.sqrt(ks);
    m.suspensionRelaxation *= Math.sqrt(ks);
  }
  // Brake bias: same total brake force, split differently.
  if (clampStep(setup.brakeBias) !== 0) {
    const total = car.brakeImpulseFront + car.brakeImpulseRear;
    const share = brakeShare(car, setup.brakeBias);
    m.brakeImpulseFront = total * share;
    m.brakeImpulseRear = total * (1 - share);
  }
  (car as { rideHeight: number }).rideHeight = rideHeightOf(car);
  const engine: EngineParams = {
    ...baseEngine,
    torqueCurve: up.engine ? scaleCurve(e, baseEngine.torqueCurve) : baseEngine.torqueCurve,
    maxDriveForce: baseEngine.maxDriveForce * e,
  };
  return { car, engine };
}

export interface VehicleStats {
  powerKw: number;
  massKg: number;
  topSpeedKmh: number;
  /** Peak drive force / weight (acceleration potential, m/s²). */
  accel: number;
  grip: number;
  braking: number;
  /** 'RWD' | 'FWD' | 'AWD' with the front torque share for AWD. */
  drivetrain: string;
  /** Static weight on the front axle (%). */
  frontWeight: number;
  /** Suspension natural frequency proxy (spring rate / mass; higher = stiffer). */
  stiffness: number;
  /** Ground clearance at rest (cm, body underside to road). */
  clearanceCm: number;
  /** Steering response (max lock x steering rate). */
  steering: number;
}

export function drivetrainLabel(car: CarParams): string {
  if (car.driveFront <= 0.01) return 'RWD';
  if (car.driveFront >= 0.99) return 'FWD';
  return `AWD ${Math.round(car.driveFront * 100)}:${Math.round((1 - car.driveFront) * 100)}`;
}

/** Display figures derived from the physics parameters (the handling test checks they rank correctly). */
export function vehicleStats(def: VehicleDef, up: UpgradeLevels = noUpgrades()): VehicleStats {
  const { car, engine } = tuningFor(def, up);
  let peakW = 0;
  for (const [rpm, nm] of engine.torqueCurve) peakW = Math.max(peakW, (nm * rpm * Math.PI * 2) / 60);
  // Top speed: the speed where the drive force (same gearbox, torque curve, traction cap and limiter as
  // Drivetrain) stops exceeding aero drag + rolling resistance + the body's linear damping.
  const TWO_PI = Math.PI * 2;
  const driveAt = (v: number): number => {
    const ratios = engine.gearRatios;
    const rpmOf = (g: number): number => ((v / car.wheelRadius) * ratios[g] * engine.finalDrive * 60) / TWO_PI;
    // The automatic box sits in the lowest gear below the upshift point (top gear runs to the limiter).
    let g = 0;
    while (g < ratios.length - 1 && rpmOf(g) > engine.upshiftRpm) g++;
    const rpm = rpmOf(g);
    if (rpm >= engine.limiterRpm) return 0;
    const f = (torqueAt(engine.torqueCurve, Math.max(engine.idleRpm, rpm)) * ratios[g] * engine.finalDrive * engine.efficiency) / car.wheelRadius;
    return Math.min(f, engine.maxDriveForce);
  };
  const resistAt = (v: number): number => car.dragCoefficient * v * v + car.rollingResistance + car.linearDamping * car.mass * v;
  let topV = 5;
  while (topV < 130 && driveAt(topV + 0.05) > resistAt(topV + 0.05)) topV += 0.05;
  const firstGearForce = Math.min(
    engine.maxDriveForce,
    (Math.max(...engine.torqueCurve.map((x) => x[1])) * engine.gearRatios[0] * engine.finalDrive * engine.efficiency) / car.wheelRadius,
  );
  return {
    powerKw: Math.round(peakW / 1000),
    massKg: car.mass,
    topSpeedKmh: Math.round(topV * 3.6),
    accel: firstGearForce / car.mass,
    grip: ((car.frictionSlipFront + car.frictionSlipRear) / 2) * (1 + car.downforceCoefficient * 0.25),
    braking: ((car.brakeImpulseFront + car.brakeImpulseRear) * 2) / car.mass,
    drivetrain: drivetrainLabel(car),
    frontWeight: Math.round(((car.centerOfMass.x - car.wheelBaseRear) / (car.wheelBaseFront - car.wheelBaseRear)) * 100),
    stiffness: (car.suspensionStiffness * 1350) / car.mass,
    clearanceCm: Math.round((car.rideHeight - car.colliderOffsetY - car.halfExtents.y) * 100),
    steering: car.maxSteerLow * car.steerRateIn,
  };
}

// ---------------------------------------------------------------- cosmetic parts

/** Rim designs (drawn by CarModel). */
export type WheelDesign = 'five' | 'mesh' | 'dish' | 'turbine' | 'beadlock';
/** Rear spoilers. */
export type SpoilerKind = 'none' | 'roof' | 'lip' | 'wing' | 'gt';
/** Body kits. */
export type KitKind = 'stock' | 'street' | 'rally';
export type PartSlot = 'wheels' | 'spoiler' | 'kit';
export const PART_SLOTS: readonly PartSlot[] = ['wheels', 'spoiler', 'kit'];

/** Visual configuration of one car. Parts are cosmetic: they do not change the handling. */
export interface CarLook {
  wheels: WheelDesign;
  spoiler: SpoilerKind;
  kit: KitKind;
}

export interface PartDef {
  slot: PartSlot;
  id: string;
  name: string;
  /** Base price (scaled per car, see partPrice). */
  price: number;
}

export const PARTS: readonly PartDef[] = [
  { slot: 'wheels', id: 'five', name: 'Five-spoke', price: 600 },
  { slot: 'wheels', id: 'mesh', name: 'Cross-mesh', price: 900 },
  { slot: 'wheels', id: 'dish', name: 'Deep dish', price: 800 },
  { slot: 'wheels', id: 'turbine', name: 'Turbine', price: 700 },
  { slot: 'wheels', id: 'beadlock', name: 'Beadlock', price: 1100 },
  { slot: 'spoiler', id: 'none', name: 'No spoiler', price: 0 },
  { slot: 'spoiler', id: 'roof', name: 'Roof spoiler', price: 400 },
  { slot: 'spoiler', id: 'lip', name: 'Ducktail', price: 500 },
  { slot: 'spoiler', id: 'wing', name: 'Sport wing', price: 900 },
  { slot: 'spoiler', id: 'gt', name: 'GT wing', price: 1600 },
  { slot: 'kit', id: 'stock', name: 'Stock body', price: 0 },
  { slot: 'kit', id: 'street', name: 'Street kit', price: 2200 },
  { slot: 'kit', id: 'rally', name: 'Rally kit', price: 1800 },
];

export const PART_SLOT_NAME: Record<PartSlot, string> = { wheels: 'Wheels', spoiler: 'Spoiler', kit: 'Body kit' };

/** What each body style leaves the factory with (always owned, free to refit). */
export const FACTORY_LOOK: Record<CarStyle, CarLook> = {
  coupe: { wheels: 'five', spoiler: 'wing', kit: 'stock' },
  hatch: { wheels: 'five', spoiler: 'roof', kit: 'stock' },
  muscle: { wheels: 'dish', spoiler: 'lip', kit: 'stock' },
  super: { wheels: 'turbine', spoiler: 'gt', kit: 'stock' },
  sedan: { wheels: 'five', spoiler: 'none', kit: 'stock' },
  suv: { wheels: 'turbine', spoiler: 'roof', kit: 'stock' },
  offroad: { wheels: 'beadlock', spoiler: 'none', kit: 'rally' },
  race: { wheels: 'mesh', spoiler: 'gt', kit: 'street' },
  motorcycle: { wheels: 'five', spoiler: 'none', kit: 'stock' },
};

export function partDef(slot: PartSlot, id: string): PartDef | undefined {
  return PARTS.find((p) => p.slot === slot && p.id === id);
}

export const partKey = (slot: PartSlot, id: string): string => `${slot}:${id}`;

/** Parts a car owns without buying: its factory fit, plus the free "remove" options. */
export function freeParts(def: VehicleDef): string[] {
  const f = FACTORY_LOOK[def.style];
  const keys = new Set<string>([partKey('wheels', f.wheels), partKey('spoiler', f.spoiler), partKey('kit', f.kit)]);
  for (const p of PARTS) if (p.price === 0) keys.add(partKey(p.slot, p.id));
  return [...keys];
}

/** Price of a part for this car (0 when it is part of the factory fit). */
export function partPrice(def: VehicleDef, slot: PartSlot, id: string): number {
  const p = partDef(slot, id);
  if (!p || freeParts(def).includes(partKey(slot, id))) return 0;
  return Math.round((p.price * Math.max(0.7, def.upgradeCost)) / 50) * 50;
}

export function factoryLook(def: VehicleDef): CarLook {
  return { ...FACTORY_LOOK[def.style] };
}
