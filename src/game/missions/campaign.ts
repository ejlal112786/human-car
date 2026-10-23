/**
 * The ten campaign missions added to the original five (see LEVELS in Levels.ts for the order).
 * Positions use the same track frame as Levels.ts: `i` = road sample (~2 m, increasing in the
 * driving direction), `off` = metres right of the centre line (lanes +1.75 / +5.25, road edge 7).
 * Time limits, star times and score targets were calibrated with scripts/campaign-test.ts.
 */
import type { GateSpec, LevelDef, ObstacleSpec, ZoneSpec } from './Levels';

const N = 984;
const wrap = (i: number): number => ((i % N) + N) % N;
const gate = (i: number): GateSpec => ({ i: wrap(i), off: 0, halfWidth: 8.6 });

/** Four cones marking the corners of a bay (just outside it). */
/** Cones framing a bay: both entry corners and the kerb-side front corner (the road side ahead stays open to drive out). */
function bayCones(z: ZoneSpec, out: ObstacleSpec[]): void {
  const di = (z.length / 2 + 0.5) / 2;
  const front = z.facing ?? 1;
  const roadSide = -Math.sign(z.off) || -1;
  for (const s of [-1, 1]) for (const w of [-1, 1]) {
    if (s === front && w === roadSide) continue;
    out.push({ kind: 'cone', i: z.i + s * di, off: z.off + w * (z.width / 2 + 0.35) });
  }
}

/** Alternating slalom gates around a centre line of cones (like the Obstacle Course). */
function slalom(at: number[], centre: number, out: ObstacleSpec[], gates: GateSpec[]): void {
  at.forEach((i, k) => {
    out.push({ kind: 'cone', i, off: centre });
    const left = k % 2 === 0;
    out.push({ kind: 'cone', i, off: left ? centre - 3.35 : centre + 3.35 });
    gates.push({ i, off: left ? centre - 1.68 : centre + 1.68, halfWidth: 1.6, slalom: true });
  });
}

// ---------------------------------------------------------------- Driving School
function drivingSchool(): LevelDef {
  const obstacles: ObstacleSpec[] = [];
  const gates: GateSpec[] = [];
  const stopBox: ZoneSpec = { i: 101, off: 3.5, length: 10, width: 6.4, hold: 1, maxSpeed: 0.5 };
  bayCones(stopBox, obstacles);
  slalom([130, 139, 148, 157], 3.5, obstacles, gates);
  const bay: ZoneSpec = { i: 212, off: 5.25, length: 6.6, width: 3.2, hold: 1.5, maxSpeed: 0.4 };
  bayCones(bay, obstacles);
  return {
    id: 'driving-school',
    number: 2,
    kind: 'school',
    title: 'Driving School',
    summary: 'Six lessons: accelerate, brake, reverse, steer, handbrake turn and park.',
    objectives: ['Accelerate to 40 km/h', 'Brake and stop in the box', 'Reverse 8 metres', 'Weave through the cone slalom', 'Swing the car round with the handbrake', 'Park in the bay'],
    tips: ['Hold brake when stopped to reverse', 'Handbrake: Space (or the HB button) while steering', 'Missed slalom gates add 3 s'],
    playerStart: { i: 36, off: 9.1 },
    carStart: { i: 40, off: 5.25 },
    timeLimit: 240,
    clockOnEnter: true,
    gates,
    obstacles,
    penalties: { perProp: 1, perHit: 2, perMissedGate: 3, maxStrikes: 15 },
    tasks: [
      { kind: 'speed', kmh: 40, text: 'Accelerate to 40 km/h' },
      { kind: 'zone', zone: stopBox, text: 'Brake and stop inside the box', done: 'Good stop!' },
      { kind: 'reverse', metres: 8, text: 'Reverse 8 metres (hold brake)' },
      { kind: 'gates', count: 4, text: 'Steer through the slalom' },
      { kind: 'handbrake', degrees: 90, text: 'Handbrake turn: at 30+ km/h, steer and pull the handbrake — turn 90°' },
      { kind: 'zone', zone: bay, text: 'Park inside the marked bay', done: 'Lesson complete' },
    ],
    stars: [80, 115],
  };
}

// ---------------------------------------------------------------- Precision Parking
function precisionParking(): LevelDef {
  const obstacles: ObstacleSpec[] = [];
  const a: ZoneSpec = { i: 372, off: 5.25, length: 6.4, width: 3.0, hold: 1.5, maxSpeed: 0.4, facing: 1 };
  const b: ZoneSpec = { i: 392, off: 5.45, length: 7.0, width: 3.0, hold: 1.5, maxSpeed: 0.4, facing: 1 };
  const c: ZoneSpec = { i: 380, off: -5.25, length: 6.4, width: 3.0, hold: 1.5, maxSpeed: 0.4, facing: -1 };
  bayCones(a, obstacles);
  bayCones(c, obstacles);
  // Parallel bay: parked cars in front of and behind the space (~11.6 m between bumpers).
  obstacles.push({ kind: 'parked', i: 388, off: 5.45 }, { kind: 'parked', i: 396, off: 5.45 });
  // More parked cars along the kerb so the bays read as a street.
  obstacles.push({ kind: 'parked', i: 351, off: 5.45 }, { kind: 'parked', i: 372, off: -5.45, yaw: Math.PI }, { kind: 'parked', i: 388, off: -5.45, yaw: Math.PI });
  return {
    id: 'precision-parking',
    number: 4,
    kind: 'parking',
    title: 'Precision Parking',
    summary: 'Three bays, three techniques. Every bump costs time.',
    objectives: ['Pull into the first bay', 'Parallel park between the two cars', 'Turn round and park facing the other way'],
    tips: ['The whole car must be inside the lines', 'Reversing into the parallel bay is easiest', 'Bumping a car or moving a cone costs time; 6 strikes fail the test'],
    playerStart: { i: 352, off: 9.1 },
    carStart: { i: 356, off: 5.25 },
    timeLimit: 180,
    clockOnEnter: true,
    gates: [],
    obstacles,
    penalties: { perProp: 2, perHit: 3, perMissedGate: 0, maxStrikes: 6, hitImpact: 1.2 },
    tasks: [
      { kind: 'zone', zone: a, text: 'Pull into the first bay', done: 'Bay 1 done' },
      { kind: 'zone', zone: b, text: 'Parallel park between the cars', done: 'Bay 2 done' },
      { kind: 'zone', zone: c, text: 'Park on the other side, facing back', done: 'All bays done' },
    ],
    stars: [80, 120],
  };
}

// ---------------------------------------------------------------- Traffic Challenge
function trafficChallenge(): LevelDef {
  return {
    id: 'rush-hour',
    number: 7,
    kind: 'traffic',
    title: 'Rush Hour',
    summary: 'Cross town through live traffic. Collisions and red lights cost time.',
    objectives: ['Drive through every checkpoint', 'Stop at red lights', 'Avoid other cars and pedestrians'],
    tips: ['Running a red light adds 4 s', 'A collision adds 5 s — four strikes and you fail', 'Traffic slows at junctions: overtake on straights'],
    playerStart: { i: 192, off: 9.1 },
    carStart: { i: 196, off: 5.25 },
    timeLimit: 110,
    clockOnEnter: true,
    gates: [250, 300, 350, 400, 450, 500, 550, 600, 646].map(gate),
    obstacles: [],
    penalties: { perProp: 2, perHit: 5, perMissedGate: 0, maxStrikes: 4, hitImpact: 2 },
    traffic: 'both',
    redLight: 4,
    stars: [62, 80],
  };
}

// ---------------------------------------------------------------- Speed Challenge
function speedChallenge(): LevelDef {
  return {
    id: 'speed-trap',
    number: 8,
    kind: 'speed',
    title: 'Speed Trap',
    summary: 'Keep your average speed up through the timed sections of the north sweepers.',
    objectives: ['Get in your car', 'Average the target speed through each speed section', 'Reach the finish'],
    tips: ['A failed section adds 5 s', 'Fail both sections and the run is over', 'Carry speed: lift early instead of braking hard'],
    playerStart: { i: 686, off: 9.1 },
    carStart: { i: 690, off: 1.75 },
    timeLimit: 70,
    clockOnEnter: true,
    gates: [730, 760, 790, 820, 850, 880, 910].map(gate),
    obstacles: [],
    speed: {
      sections: [
        { from: 0, to: 2, kmh: 95 },
        { from: 3, to: 5, kmh: 100 },
      ],
      penalty: 5,
      maxFailed: 1,
    },
    stars: [36, 42],
  };
}

// ---------------------------------------------------------------- Delivery
function delivery(): LevelDef {
  const obstacles: ObstacleSpec[] = [];
  const pick: ZoneSpec = { i: 548, off: 5.25, length: 8, width: 3.6, hold: 1, maxSpeed: 0.8 };
  const drop: ZoneSpec = { i: 846, off: 5.25, length: 8, width: 3.6, hold: 1, maxSpeed: 0.8 };
  bayCones(pick, obstacles);
  bayCones(drop, obstacles);
  return {
    id: 'fragile-cargo',
    number: 10,
    kind: 'delivery',
    title: 'Fragile Cargo',
    summary: 'Collect a crate of glassware at the depot and deliver it across town — fast, but in one piece.',
    objectives: ['Stop at the depot to load the cargo', 'Deliver it to the drop-off', 'Keep the cargo intact'],
    tips: ['Every knock damages the cargo; at 0 % the delivery fails', '3 stars need the cargo at 80 % or better', 'The hairpin after the garage is the danger zone'],
    playerStart: { i: 516, off: 9.1 },
    carStart: { i: 520, off: 5.25 },
    timeLimit: 85,
    clockOnEnter: true,
    gates: [],
    obstacles,
    cargo: { perImpact: 14, gold: 80 },
    tasks: [
      { kind: 'zone', zone: pick, text: 'Stop in the depot bay to load the cargo', done: 'Cargo loaded', pickup: true },
      { kind: 'zone', zone: drop, text: 'Deliver the cargo to the drop-off', done: 'Delivered!' },
    ],
    stars: [58, 70],
  };
}

// ---------------------------------------------------------------- Drift Challenge
function driftChallenge(): LevelDef {
  return {
    id: 'drift-king',
    number: 11,
    kind: 'drift',
    title: 'Drift King',
    summary: 'Slide through the hairpins of the old quarter. Long, fast drifts build a multiplier.',
    objectives: ['Get in your car', 'Score drift points through the hairpins', 'Pass every checkpoint before the clock runs out'],
    tips: ['Kick the back out with the handbrake, then balance with throttle and steering', 'Longer drifts raise the multiplier (up to x5)', 'Crashing loses the drift in progress'],
    playerStart: { i: 846, off: 9.1 },
    carStart: { i: 850, off: 3.5 },
    timeLimit: 45,
    clockOnEnter: true,
    gates: [872, 892, 912, 932, 952, 972].map(gate),
    obstacles: [],
    drift: { target: 600, stars: [1400, 900] },
  };
}

// ---------------------------------------------------------------- Police Escape
function policeEscape(): LevelDef {
  const hideout: ZoneSpec = { i: 872, off: 5.25, length: 8, width: 3.8, hold: 1, maxSpeed: 1 };
  return {
    id: 'hot-pursuit',
    number: 12,
    kind: 'escape',
    title: 'Hot Pursuit',
    summary: 'The police are already on to you. Shake them off and hide in the lock-up.',
    objectives: ['Get in your car — the police are coming', 'Get away from the patrol cars', 'Stop in the hideout with no police nearby'],
    tips: ['If a patrol car boxes you in and you stop, you are busted', 'The hideout only works with no police within 60 m', 'Red lights and speeding past police raise your wanted level'],
    playerStart: { i: 596, off: 9.1 },
    carStart: { i: 600, off: 5.25 },
    timeLimit: 150,
    clockOnEnter: true,
    gates: [],
    obstacles: [],
    police: { stars: 2, behind: 45 },
    tasks: [{ kind: 'zone', zone: hideout, text: 'Lose the police and reach the hideout', done: 'Safe!', clearOfPolice: 60 }],
    stars: [60, 90],
  };
}

// ---------------------------------------------------------------- Advanced Obstacle Course
function advancedCourse(): { obstacles: ObstacleSpec[]; gates: GateSpec[]; zone: ZoneSpec } {
  const obstacles: ObstacleSpec[] = [];
  const gates: GateSpec[] = [];
  // Keep the course on the right-hand carriageway.
  for (let i = 402; i <= 556; i += 6) obstacles.push({ kind: 'cone', i, off: -0.2 });
  // 1) Sweepers: booms sliding across the carriageway — time the gap.
  obstacles.push({ kind: 'slider', i: 418, off: 3.5, move: { amp: 1.75, period: 4.2 } });
  obstacles.push({ kind: 'slider', i: 432, off: 3.5, move: { amp: 1.75, period: 3.6, phase: 0.5 } });
  obstacles.push({ kind: 'slider', i: 446, off: 3.5, move: { amp: 1.75, period: 4.6, phase: 0.25 } });
  gates.push({ i: 452, off: 3.5, halfWidth: 3.4 });
  // 2) Crate chicane: heavy crates you can shove, but every one moved costs time.
  for (const [i, off] of [
    [464, 0.9], [464, 2.0], [465, 1.45],
    [476, 6.1], [476, 5.0], [477, 5.55],
    [488, 0.9], [488, 2.0], [489, 1.45],
  ] as const)
    obstacles.push({ kind: 'crate', i, off });
  gates.push({ i: 464, off: 4.8, halfWidth: 1.9 }, { i: 476, off: 2.2, halfWidth: 1.9 }, { i: 488, off: 4.8, halfWidth: 1.9 });
  // 3) Bumps with a barrel slalom.
  obstacles.push({ kind: 'bump', i: 500, off: 3.5 });
  slalom([508, 516, 524], 3.5, obstacles, gates);
  obstacles.push({ kind: 'bump', i: 530, off: 3.5 });
  // 4) Narrow barrier squeeze (~2.7 m clear).
  for (let i = 536; i <= 546; i++) {
    obstacles.push({ kind: 'barrier', i, off: 1.95 });
    obstacles.push({ kind: 'barrier', i, off: 5.05 });
  }
  gates.push({ i: 535, off: 3.5, halfWidth: 1.4 });
  // 5) Finish bay framed by barrels.
  const zone: ZoneSpec = { i: 566, off: 3.5, length: 5.8, width: 3.0, hold: 1.5, maxSpeed: 0.6 };
  for (const s of [-1, 1]) for (const w of [-1, 1]) obstacles.push({ kind: 'barrel', i: zone.i + s * 1.6, off: zone.off + w * 1.85 });
  return { obstacles, gates, zone };
}

function advanced(): LevelDef {
  const c = advancedCourse();
  return {
    id: 'gauntlet',
    number: 13,
    kind: 'advanced',
    title: 'The Gauntlet',
    summary: 'Sweeping booms, heavy crates, bumps, a slalom and a tight squeeze — then stop dead in the bay.',
    objectives: ['Time your run past the sweeping booms', 'Thread the crate chicane', 'Clear the cone slalom and the barrier squeeze', 'Park in the bay and hold still'],
    tips: ['Booms move on a fixed rhythm — wait for the gap', 'Moved crates or barrels add 2 s, hits add 3 s', '10 strikes and the run is over'],
    playerStart: { i: 392, off: 9.1 },
    carStart: { i: 396, off: 3.5 },
    timeLimit: 170,
    clockOnEnter: true,
    gates: c.gates,
    zone: c.zone,
    obstacles: c.obstacles,
    penalties: { perProp: 2, perHit: 3, perMissedGate: 5, maxStrikes: 10 },
    stars: [80, 110],
  };
}

// ---------------------------------------------------------------- Circuit Championship
function circuit(): LevelDef {
  const grid = 790;
  return {
    id: 'circuit-championship',
    number: 14,
    kind: 'circuit',
    title: 'Circuit Championship',
    summary: 'Three laps of the city against the championship field. Finish on the podium.',
    objectives: ['Get in your car on the grid', 'Complete 3 laps', 'Finish in the top 3 (1st = 3 stars)'],
    tips: ['Stars come from your finishing position', 'Tyres and brakes upgrades pay off over three laps', 'You may not leave the car during the race'],
    playerStart: { i: grid - 2, off: 9.1 },
    carStart: { i: grid, off: 1.75 },
    clockOnEnter: true,
    gates: [870, 950, 46, 126, 206, 286, 366, 446, 526, 606, 686, grid + 10].map(gate),
    obstacles: [],
    laps: 3,
    race: {
      requiredPosition: 3,
      byPosition: true,
      opponents: [
        { name: 'Ace', paint: 0x1f4fbf, skill: 0.82, i: grid + 6, off: 1.75, line: 1.75, car: 'kestrel', upgrades: 1 },
        { name: 'Mako', paint: 0xe0a21a, skill: 0.84, i: grid + 6, off: 5.25, line: 2.0, car: 'brute', upgrades: 1 },
        { name: 'Jinx', paint: 0x23a36b, skill: 0.8, i: grid, off: 5.25, line: 2.3, car: 'kestrel', upgrades: 2 },
      ],
    },
  };
}

// ---------------------------------------------------------------- City Grand Prix
function grandPrix(): LevelDef {
  const grid = 480;
  return {
    id: 'city-grand-prix',
    number: 15,
    kind: 'gp',
    title: 'City Grand Prix',
    summary: 'The big one: two laps on open streets, through traffic, against the best drivers in town.',
    objectives: ['Get in your car on the grid', 'Two laps through every checkpoint', 'Win — traffic is still on the road'],
    tips: ['Traffic runs in the race direction only', 'Rivals brake for traffic too: pass them in the gaps', 'A faster, upgraded car is recommended'],
    playerStart: { i: grid - 2, off: 9.1 },
    carStart: { i: grid, off: 1.75 },
    clockOnEnter: true,
    gates: [560, 640, 720, 800, 880, 960, 56, 136, 216, 296, 376, 490].map(gate),
    obstacles: [],
    laps: 2,
    traffic: 'same',
    race: {
      requiredPosition: 1,
      opponents: [
        { name: 'Zero', paint: 0x111111, skill: 0.84, i: grid + 6, off: 1.75, line: 1.75, car: 'vortex', upgrades: 0 },
        { name: 'Halo', paint: 0xf2f2f2, skill: 0.86, i: grid + 6, off: 5.25, line: 2.0, car: 'brute', upgrades: 2 },
        { name: 'Rift', paint: 0xc81d25, skill: 0.88, i: grid, off: 5.25, line: 2.3, car: 'kestrel', upgrades: 3 },
      ],
    },
    stars: [145, 160],
  };
}

export const DRIVING_SCHOOL = drivingSchool();
export const PRECISION_PARKING = precisionParking();
export const TRAFFIC_CHALLENGE = trafficChallenge();
export const SPEED_CHALLENGE = speedChallenge();
export const DELIVERY = delivery();
export const DRIFT_CHALLENGE = driftChallenge();
export const POLICE_ESCAPE = policeEscape();
export const ADVANCED_COURSE = advanced();
export const CIRCUIT = circuit();
export const GRAND_PRIX = grandPrix();
