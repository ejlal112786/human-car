/**
 * Mission definitions. Every position is expressed along the circuit's centre line:
 * `i` is a track sample index (samples are ~2 m apart, increasing in the driving direction)
 * and `off` is the lateral offset in metres (positive = right of the centre line).
 * The road is 14 m wide (|off| <= 7), the sidewalk spans |off| 7.35..11.55.
 * All layouts are fixed data, so every mission is reproducible.
 */

/**
 * cone / barrel / crate: dynamic props (knocked over, penalised in obstacle missions).
 * barrier / roadblock / bump / parked: static. slider: a kinematic barrier that sweeps across the road.
 */
/** Ambient traffic density of traffic missions unless the level sets its own (= the 'high' free-roam density). */
export const MISSION_TRAFFIC_DENSITY = 18;

export type ObstacleKind = 'cone' | 'barrel' | 'barrier' | 'roadblock' | 'bump' | 'crate' | 'slider' | 'parked';

export interface TrackPos {
  i: number;
  off: number;
}

export interface ObstacleSpec extends TrackPos {
  kind: ObstacleKind;
  /** Yaw relative to the road direction (radians). Barriers default to along the road. */
  yaw?: number;
  /** Sliders only: sideways sweep amplitude (m) and period (s); phase in [0, 1). */
  move?: { amp: number; period: number; phase?: number };
}

export interface GateSpec extends TrackPos {
  /** Half width of the passable opening (m). Full-road gates use ~8.5. */
  halfWidth: number;
  /** Slalom gates are marked by cones; missing one costs time instead of blocking progress. */
  slalom?: boolean;
}

export interface ZoneSpec extends TrackPos {
  /** Bay length along the road and width across it (m). */
  length: number;
  width: number;
  /** Seconds the car must stay inside (below `maxSpeed`) to complete. */
  hold: number;
  maxSpeed: number;
  /** Required heading: 1 = facing along the road direction, -1 = facing against it (default: any). */
  facing?: 1 | -1;
}

/**
 * Steps of a task-based mission (Driving School, Parking, Delivery, Police Escape), done in order.
 * `gates` consumes the next `count` entries of LevelDef.gates.
 */
export type TaskSpec =
  | { kind: 'speed'; kmh: number; text: string }
  | { kind: 'reverse'; metres: number; text: string }
  | { kind: 'handbrake'; degrees: number; text: string }
  | { kind: 'gates'; count: number; text: string }
  | {
      kind: 'zone';
      zone: ZoneSpec;
      text: string;
      /** Shown when the step is done. */
      done?: string;
      /** Loads the cargo (Delivery). */
      pickup?: boolean;
      /** Police Escape: no police unit may be within this distance (m) while parking. */
      clearOfPolice?: number;
    };

/** Speed Challenge section: from passing gate `from` (-1 = the start) to gate `to`, average at least `kmh`. */
export interface SpeedSection {
  from: number;
  to: number;
  kmh: number;
}

export interface OpponentSpec extends TrackPos {
  name: string;
  paint: number;
  /** Fraction of the grip-limited cornering speed this driver uses (0..1). */
  skill: number;
  /** Preferred lateral line. */
  line: number;
  /** Rival's car (VehicleCatalog id; default Kestrel GT) and upgrade level applied to every part (0–3). */
  car?: string;
  upgrades?: number;
}

export type LevelKind =
  | 'tutorial'
  | 'school'
  | 'checkpoints'
  | 'parking'
  | 'obstacles'
  | 'timetrial'
  | 'traffic'
  | 'speed'
  | 'race'
  | 'delivery'
  | 'drift'
  | 'escape'
  | 'advanced'
  | 'circuit'
  | 'gp'
  | 'free';

export interface LevelDef {
  id: string;
  number: number;
  kind: LevelKind;
  title: string;
  /** One-line summary for level cards. */
  summary: string;
  /** Objectives shown on the briefing screen. */
  objectives: string[];
  /** Short tips shown on the briefing screen. */
  tips: string[];
  playerStart: TrackPos;
  carStart: TrackPos;
  /** Countdown limit in seconds (mission fails at 0). */
  timeLimit?: number;
  /** The clock starts when the player first gets into the car (otherwise at mission start). */
  clockOnEnter: boolean;
  gates: GateSpec[];
  zone?: ZoneSpec;
  obstacles: ObstacleSpec[];
  /** `hitImpact`: collision speed change (m/s) that counts as a hit (default 2.5). */
  penalties?: { perProp: number; perHit: number; perMissedGate: number; maxStrikes: number; hitImpact?: number };
  /** Total mission stars needed before the mission unlocks (in addition to clearing the previous one). */
  requiresStars?: number;
  /** `byPosition`: stars come from the finishing place (1st 3, 2nd 2, 3rd 1) instead of the time. */
  race?: { opponents: OpponentSpec[]; requiredPosition: number; byPosition?: boolean };
  /** Finish-time thresholds (seconds, penalties included) for 3 and 2 stars. Finishing earns 1. */
  stars?: [number, number];
  /** Ordered steps (replaces the gates-then-zone flow). */
  tasks?: TaskSpec[];
  /** Laps of the gate sequence (races / circuits). */
  laps?: number;
  /** Speed Challenge: sections with a minimum average speed; failing more than `maxFailed` ends the run. */
  speed?: { sections: SpeedSection[]; penalty: number; maxFailed: number };
  /** Drift Challenge: points needed to pass, and for 3 / 2 stars (stars come from the score). */
  drift?: { target: number; stars: [number, number] };
  /** Delivery: fragile cargo (lost per m/s of impact above 1 m/s); 3 stars need at least `gold` % left. */
  cargo?: { perImpact: number; gold: number };
  /** Police Escape: wanted level when the run starts and how far behind the units appear (m). */
  police?: { stars: number; behind: number };
  /** Ambient traffic during the mission ('same' = only in the direction of the run). */
  traffic?: 'both' | 'same';
  /**
   * Ambient cars kept around the player during the mission (default MISSION_TRAFFIC_DENSITY). Fixed per mission
   * so that difficulty and race results do not depend on the graphics quality preset (which sets free-roam density).
   */
  trafficDensity?: number;
  /** Seconds added for running a red light. */
  redLight?: number;
}

import {
  ADVANCED_COURSE,
  CIRCUIT,
  DELIVERY,
  DRIFT_CHALLENGE,
  DRIVING_SCHOOL,
  GRAND_PRIX,
  POLICE_ESCAPE,
  PRECISION_PARKING,
  SPEED_CHALLENGE,
  TRAFFIC_CHALLENGE,
} from './campaign';

const fullGate = (i: number): GateSpec => ({ i, off: 0, halfWidth: 8.6 });

// ---------------------------------------------------------------- Level 3 layout
function obstacleCourse(): { obstacles: ObstacleSpec[]; gates: GateSpec[] } {
  const obstacles: ObstacleSpec[] = [];
  const gates: GateSpec[] = [];
  // Course boundary: cones along the centre line keep the course on the right-hand carriageway.
  for (let i = 704; i <= 858; i += 5) obstacles.push({ kind: 'cone', i, off: -0.2 });
  // 1) Slalom: weave around a line of cones (alternating gates, 3.7 m wide).
  const slalom = [716, 726, 736, 746];
  slalom.forEach((i, k) => {
    obstacles.push({ kind: 'cone', i, off: 3.5 });
    const left = k % 2 === 0;
    obstacles.push({ kind: 'cone', i, off: left ? 0.15 : 6.85 });
    gates.push({ i, off: left ? 1.82 : 5.18, halfWidth: 1.6, slalom: true });
  });
  // 2) Narrow passage between two rows of concrete barriers (~2.9 m clear).
  for (let i = 760; i <= 782; i += 1) {
    obstacles.push({ kind: 'barrier', i, off: 2.05 });
    obstacles.push({ kind: 'barrier', i, off: 5.35 });
  }
  gates.push({ i: 759, off: 3.7, halfWidth: 1.5 });
  gates.push({ i: 783, off: 3.7, halfWidth: 1.5 });
  // 3) Speed bumps across the course.
  obstacles.push({ kind: 'bump', i: 791, off: 3.5 }, { kind: 'bump', i: 797, off: 3.5 });
  // 4) Chicane: two roadblocks force a left-right swerve.
  obstacles.push({ kind: 'roadblock', i: 810, off: 1.7 }, { kind: 'roadblock', i: 824, off: 5.35 });
  gates.push({ i: 810, off: 5.25, halfWidth: 1.8 });
  gates.push({ i: 824, off: 1.75, halfWidth: 1.8 });
  // 5) Parking bay framed by barrels (completion zone, see `zone`).
  for (const [i, off] of [
    [845, 2.8],
    [845, 6.2],
    [851, 2.8],
    [851, 6.2],
  ] as const)
    obstacles.push({ kind: 'barrel', i, off });
  return { obstacles, gates };
}

const course = obstacleCourse();

// ---------------------------------------------------------------- Level 4 detour
function detour(): ObstacleSpec[] {
  const o: ObstacleSpec[] = [];
  // Taper of cones guiding traffic out of the closed right-hand lanes.
  for (let k = 0; k < 8; k++) o.push({ kind: 'cone', i: 126 + k * 2, off: 6.4 - k * 0.8 });
  // Street closed: roadblocks across both right-hand lanes, then a line of barriers.
  o.push({ kind: 'roadblock', i: 143, off: 1.7 }, { kind: 'roadblock', i: 143, off: 5.3 });
  for (let i = 146; i <= 170; i += 1) o.push({ kind: 'barrier', i, off: 0.5 });
  o.push({ kind: 'roadblock', i: 172, off: 1.7 }, { kind: 'roadblock', i: 172, off: 5.3 });
  return o;
}

const ORIGINAL: readonly LevelDef[] = [
  {
    id: 'find-your-ride',
    number: 1,
    kind: 'tutorial',
    title: 'Find Your Ride',
    summary: 'Find your car, get in and park it at Harbor Avenue.',
    objectives: ['Walk to your parked car', 'Get in', 'Drive to the marked parking bay', 'Stop inside the bay'],
    tips: ['Move with W A S D, hold Shift to run', 'Drag the mouse to look around', 'Press E next to the car to get in'],
    playerStart: { i: 14, off: 9.1 },
    carStart: { i: 22, off: 5.25 },
    clockOnEnter: false,
    gates: [],
    zone: { i: 250, off: 5.25, length: 7, width: 3.6, hold: 0.6, maxSpeed: 2.5 },
    obstacles: [
      { kind: 'cone', i: 246, off: 3.2 },
      { kind: 'cone', i: 246, off: 7.0 },
      { kind: 'cone', i: 254, off: 3.2 },
      { kind: 'cone', i: 254, off: 7.0 },
    ],
    timeLimit: 180,
    stars: [60, 95],
  },
  {
    id: 'city-driving',
    number: 3,
    kind: 'checkpoints',
    title: 'City Driving',
    summary: 'Clear nine checkpoints through Foundry Street before time runs out.',
    objectives: ['Get in your car', 'Drive through every checkpoint in order', 'Reach the finish before the timer hits zero'],
    tips: ['Brake before the corners, not in them', 'The clock starts when you get in', 'Follow the arrow on the minimap'],
    playerStart: { i: 326, off: 9.1 },
    carStart: { i: 332, off: 5.25 },
    timeLimit: 60,
    clockOnEnter: true,
    gates: [370, 410, 450, 490, 530, 570, 610, 650, 692].map(fullGate),
    obstacles: [],
    stars: [40, 50],
  },
  {
    id: 'obstacle-course',
    number: 5,
    kind: 'obstacles',
    title: 'Obstacle Course',
    summary: 'Slalom, a narrow passage, speed bumps, a chicane and a precision park.',
    objectives: [
      'Weave through the slalom gates',
      'Thread the narrow barrier passage',
      'Clear the chicane',
      'Park in the bay and hold still',
    ],
    tips: ['Each cone or barrel you move adds 2 s', 'Hitting a barrier adds 3 s', '12 strikes and the run is over'],
    playerStart: { i: 697, off: 9.1 },
    carStart: { i: 701, off: 3.5 },
    timeLimit: 150,
    clockOnEnter: true,
    gates: course.gates,
    zone: { i: 848, off: 4.5, length: 5.6, width: 3.0, hold: 1.5, maxSpeed: 0.6 },
    obstacles: course.obstacles,
    penalties: { perProp: 2, perHit: 3, perMissedGate: 5, maxStrikes: 12 },
    stars: [65, 90],
  },
  {
    id: 'time-trial',
    number: 6,
    kind: 'timetrial',
    title: 'Time Trial',
    summary: 'A full lap of the city against the clock, with a closed street to detour around.',
    objectives: ['Complete a full lap through all 14 checkpoints in order', 'Take the detour around the closed street', 'Beat the clock'],
    tips: ['Your best time is saved', 'The construction zone narrows the road on Foundry Street', 'Use the handbrake for the tightest corners'],
    playerStart: { i: 876, off: 9.1 },
    carStart: { i: 882, off: 1.75 },
    timeLimit: 125,
    clockOnEnter: true,
    gates: [950, 40, 110, 185, 250, 330, 400, 470, 540, 610, 680, 750, 820, 892].map(fullGate),
    obstacles: detour(),
    stars: [88, 105],
  },
  {
    id: 'street-race',
    number: 9,
    kind: 'race',
    title: 'Street Race',
    summary: 'One lap against three rivals. Only a win counts.',
    objectives: ['Get in your car on the grid', 'Wait for the start signal', 'Finish the lap in 1st place'],
    tips: ['Rivals brake late but take wide lines', 'Contact slows everyone down', 'You may not leave the car during the race'],
    playerStart: { i: 2, off: 9.1 },
    carStart: { i: 4, off: 1.75 },
    clockOnEnter: true,
    gates: [90, 170, 250, 330, 410, 490, 570, 650, 730, 810, 890, 14].map(fullGate),
    obstacles: [],
    race: {
      requiredPosition: 1,
      opponents: [
        { name: 'Viper', paint: 0x1f4fbf, skill: 0.8, i: 10, off: 1.75, line: 1.75 },
        { name: 'Blaze', paint: 0xe0a21a, skill: 0.77, i: 10, off: 5.25, line: 2.0 },
        { name: 'Nova', paint: 0x23a36b, skill: 0.74, i: 4, off: 5.25, line: 2.3 },
      ],
    },
    stars: [82, 92],
  },
];

/** The campaign, in order (difficulty curve). Mission ids are stable save keys. */
export const LEVELS: readonly LevelDef[] = [
  ORIGINAL[0], // Find Your Ride
  DRIVING_SCHOOL,
  ORIGINAL[1], // City Driving
  PRECISION_PARKING,
  ORIGINAL[2], // Obstacle Course
  ORIGINAL[3], // Time Trial
  TRAFFIC_CHALLENGE,
  SPEED_CHALLENGE,
  ORIGINAL[4], // Street Race
  DELIVERY,
  DRIFT_CHALLENGE,
  POLICE_ESCAPE,
  ADVANCED_COURSE,
  { ...CIRCUIT, requiresStars: 24 },
  { ...GRAND_PRIX, requiresStars: 30 },
];

/** Campaign chapters (by mission index range, inclusive start). */
export const CHAPTERS: ReadonlyArray<{ name: string; from: number }> = [
  { name: 'Learner', from: 0 },
  { name: 'Street', from: 4 },
  { name: 'Pro', from: 9 },
  { name: 'Champion', from: 12 },
];

/** Short label for the kind of mission (level cards, briefing). */
export const KIND_LABEL: Record<LevelKind, string> = {
  tutorial: 'Find the car',
  school: 'Driving school',
  checkpoints: 'Checkpoint run',
  parking: 'Parking',
  obstacles: 'Obstacles',
  timetrial: 'Time trial',
  traffic: 'Traffic',
  speed: 'Speed',
  race: 'Race',
  delivery: 'Delivery',
  drift: 'Drift',
  escape: 'Police escape',
  advanced: 'Obstacles+',
  circuit: 'Circuit race',
  gp: 'Grand Prix',
  free: 'Free roam',
};

/** Free roam: the city with no objectives. */
export const FREE_ROAM: LevelDef = {
  id: 'free-roam',
  number: 0,
  kind: 'free',
  title: 'Free Roam',
  summary: 'Explore the city on foot or behind the wheel.',
  objectives: ['Explore the city at your own pace'],
  tips: [],
  playerStart: { i: 4, off: 9.1 },
  carStart: { i: 10, off: 5.25 },
  clockOnEnter: false,
  gates: [],
  obstacles: [],
};

export function levelById(id: string): LevelDef | undefined {
  return id === FREE_ROAM.id ? FREE_ROAM : LEVELS.find((l) => l.id === id);
}

/** Paint colours offered in the garage, unlocked by the total number of stars earned. */
export const PAINTS: ReadonlyArray<{ id: string; name: string; color: number; stars: number }> = [
  { id: 'red', name: 'Racing Red', color: 0x8c0a10, stars: 0 },
  { id: 'blue', name: 'Midnight Blue', color: 0x0d2a6b, stars: 0 },
  { id: 'white', name: 'Arctic White', color: 0xd9dcdf, stars: 2 },
  { id: 'lime', name: 'Acid Lime', color: 0x6fae12, stars: 5 },
  { id: 'orange', name: 'Sunset Orange', color: 0xd4520f, stars: 8 },
  { id: 'black', name: 'Stealth Black', color: 0x101114, stars: 11 },
  { id: 'gold', name: 'Champion Gold', color: 0xb8902a, stars: 14 },
  { id: 'silver', name: 'Liquid Silver', color: 0x9aa1a8, stars: 3 },
  { id: 'green', name: 'Forest Green', color: 0x1f4a2a, stars: 7 },
  { id: 'yellow', name: 'Signal Yellow', color: 0xe0b40c, stars: 17 },
];
