/**
 * Career: a series of increasingly difficult street events, raced with the mission system
 * (checkpoint sprints, time trials and races are ordinary LevelDefs). Pure data + progress logic —
 * no rendering — so it can be tested headless.
 *
 * Unlocking: each event needs the previous one cleared, and the later tiers also need a number of
 * career stars (earned in career events only), so the player has to go back and improve results —
 * usually by upgrading or buying a faster car in the garage.
 */
import type { GateSpec, LevelDef, OpponentSpec } from '../missions/Levels';
import { addCredits, rewardFor, saveProgress, totalStars, type Progress } from '../missions/Progress';
import { PAINTS } from '../missions/Levels';

export type CareerTier = 'Rookie' | 'Pro' | 'Elite';

export interface CareerEvent {
  id: string;
  tier: CareerTier;
  /** The playable level (kind checkpoints / timetrial / race). */
  level: LevelDef;
  /** Credits for the first clear (replays pay 30 %; see rewardFor). */
  reward: number;
  /** Previous event that must be cleared first (null = open from the start). */
  after: string | null;
  /** Career stars needed (sum of best stars over all career events). */
  stars: number;
  /** Advice shown in the event list (not enforced). */
  advice: string;
}

const N = 984; // road samples round the loop (Track(2))
const wrap = (i: number): number => ((i % N) + N) % N;
const gate = (i: number): GateSpec => ({ i: wrap(i), off: 0, halfWidth: 8.6 });

/** Gates every `step` samples from `from` (exclusive) to `to` (inclusive), going round the loop. */
function gatesAlong(from: number, to: number, step: number): GateSpec[] {
  const len = wrap(to - from) || N;
  const out: GateSpec[] = [];
  for (let d = step; d < len - step / 2; d += step) out.push(gate(from + d));
  out.push(gate(to));
  return out;
}

function timedEvent(o: { id: string; number: number; kind: 'checkpoints' | 'timetrial'; title: string; summary: string; start: number; finish: number; timeLimit: number; stars: [number, number]; tips: string[] }): LevelDef {
  const full = wrap(o.finish - o.start) < 40;
  return {
    id: o.id,
    number: o.number,
    kind: o.kind,
    title: o.title,
    summary: o.summary,
    objectives: ['Get in your car', full ? 'Drive a full lap through every checkpoint' : 'Drive through every checkpoint in order', 'Beat the clock'],
    tips: o.tips,
    playerStart: { i: wrap(o.start - 5), off: 9.1 },
    carStart: { i: wrap(o.start), off: 5.25 },
    timeLimit: o.timeLimit,
    clockOnEnter: true,
    gates: gatesAlong(o.start, o.finish, 50),
    obstacles: [],
    stars: o.stars,
  };
}

function raceEvent(o: { id: string; number: number; title: string; summary: string; grid: number; requiredPosition: number; rivals: Array<Omit<OpponentSpec, 'i' | 'off'>>; stars: [number, number]; tips: string[] }): LevelDef {
  // Grid like the Street Race: player inside lane, rivals beside and ahead.
  const slots: Array<[number, number]> = [
    [6, 1.75],
    [6, 5.25],
    [0, 5.25],
  ];
  return {
    id: o.id,
    number: o.number,
    kind: 'race',
    title: o.title,
    summary: o.summary,
    objectives: ['Get in your car on the grid', 'Wait for the start signal', o.requiredPosition === 1 ? 'Win the race' : `Finish in the top ${o.requiredPosition}`],
    tips: o.tips,
    playerStart: { i: wrap(o.grid - 2), off: 9.1 },
    carStart: { i: wrap(o.grid), off: 1.75 },
    clockOnEnter: true,
    gates: gatesAlong(o.grid + 10, o.grid + 10, 80),
    obstacles: [],
    race: {
      requiredPosition: o.requiredPosition,
      opponents: o.rivals.map((r, k) => ({ ...r, i: wrap(o.grid + slots[k][0]), off: slots[k][1] })),
    },
    stars: o.stars,
  };
}

/**
 * The career, in order. Time limits and star times were set from AI lap times (scripts/career-test.ts)
 * scaled by the same ratios as the shipped missions: limits 2.0× → 1.45× the ideal AI time in the
 * starter car (City Driving uses 2.3×), so each timed event needs a higher average speed.
 */
export const CAREER: readonly CareerEvent[] = [
  {
    id: 'harbor-sprint',
    tier: 'Rookie',
    reward: 600,
    after: null,
    stars: 0,
    advice: 'Any car',
    level: timedEvent({
      id: 'harbor-sprint',
      number: 1,
      kind: 'checkpoints',
      title: 'Harbor Sprint',
      summary: 'A short dash along the waterfront. Clear every checkpoint before the clock runs out.',
      start: 120,
      finish: 420,
      timeLimit: 46,
      stars: [34, 40],
      tips: ['The clock starts when you get in', 'Follow the arrow on the minimap'],
    }),
  },
  {
    id: 'rookie-cup',
    tier: 'Rookie',
    reward: 900,
    after: 'harbor-sprint',
    stars: 0,
    advice: 'Any car',
    level: raceEvent({
      id: 'rookie-cup',
      number: 2,
      title: 'Rookie Cup',
      summary: 'Your first race: one lap against two club drivers. A top-two finish qualifies.',
      grid: 452,
      requiredPosition: 2,
      rivals: [
        { name: 'Dash', paint: 0x8a5cd6, skill: 0.62, line: 1.75 },
        { name: 'Rook', paint: 0x2f9fd0, skill: 0.66, line: 2.1 },
      ],
      stars: [75, 79],
      tips: ['Second place is enough here', 'Rivals brake early in the tight bends'],
    }),
  },
  {
    id: 'foundry-attack',
    tier: 'Pro',
    reward: 1200,
    after: 'rookie-cup',
    stars: 3,
    advice: 'Engine or tyre upgrades help',
    level: timedEvent({
      id: 'foundry-attack',
      number: 3,
      kind: 'timetrial',
      title: 'Foundry Time Attack',
      summary: 'Half a lap through the industrial district with a tight clock.',
      // Same 484-sample route length as before, moved clear of the Hot Pursuit marker (i596).
      start: 640,
      finish: 140,
      timeLimit: 60,
      stars: [46, 53],
      tips: ['Carry speed onto the long straights', 'Upgraded tyres let you brake later'],
    }),
  },
  {
    id: 'pro-duel',
    tier: 'Pro',
    reward: 1600,
    after: 'foundry-attack',
    stars: 5,
    advice: 'Upgraded Kestrel or Brute V8',
    level: raceEvent({
      id: 'pro-duel',
      number: 4,
      title: 'Pro Duel',
      summary: 'One rival, one lap, winner takes all. Vex drives a tuned Brute V8.',
      grid: 760,
      requiredPosition: 1,
      rivals: [{ name: 'Vex', paint: 0xd23c3c, skill: 0.82, line: 1.75, car: 'brute', upgrades: 1 }],
      stars: [70.5, 73],
      tips: ['The Brute is quick on the straights but heavy in the bends', 'Pass under braking'],
    }),
  },
  {
    id: 'grand-loop',
    tier: 'Elite',
    reward: 2200,
    after: 'pro-duel',
    stars: 8,
    advice: 'Fully upgraded car recommended',
    level: timedEvent({
      id: 'grand-loop',
      number: 5,
      kind: 'timetrial',
      title: 'Grand Loop',
      summary: 'A full lap of the city with an elite target time. No detours, no excuses.',
      // Full lap; starts clear of the Precision Parking marker (i352).
      start: 420,
      finish: 420,
      timeLimit: 104,
      stars: [80, 88],
      tips: ['A clean lap beats a fast, messy one', 'Every checkpoint counts'],
    }),
  },
  {
    id: 'elite-race',
    tier: 'Elite',
    reward: 3000,
    after: 'grand-loop',
    stars: 11,
    advice: 'A fully upgraded Kestrel GT',
    level: raceEvent({
      id: 'elite-race',
      number: 6,
      title: 'Elite Night Run',
      summary: 'Three of the city\u2019s best in upgraded cars. Only a win counts.',
      grid: 160,
      requiredPosition: 1,
      rivals: [
        { name: 'Kite', paint: 0x23a36b, skill: 0.87, line: 1.75, car: 'brute', upgrades: 2 },
        { name: 'Onyx', paint: 0x30343a, skill: 0.8, line: 2.0, car: 'kestrel', upgrades: 3 },
        { name: 'Blitz', paint: 0xe0a21a, skill: 0.89, line: 2.3, car: 'brute', upgrades: 3 },
      ],
      stars: [68.5, 70],
      tips: ['Blitz\u2019s tuned Brute is quick out of the bends: brake early, exit fast', 'Contact slows everyone down'],
    }),
  },
  {
    id: 'championship',
    tier: 'Elite',
    reward: 5000,
    after: 'elite-race',
    stars: 13,
    advice: 'Vortex RS (a maxed Kestrel GT is just enough)',
    level: raceEvent({
      id: 'championship',
      number: 7,
      title: 'City Championship',
      summary: 'The final. Three champions in tuned supercars. Win it to rule the streets.',
      // Full lap; grid clear of the Drift King marker (i846).
      grid: 812,
      requiredPosition: 1,
      rivals: [
        { name: 'Zero', paint: 0xf2f2f2, skill: 0.71, line: 1.75, car: 'vortex', upgrades: 1 },
        { name: 'Halo', paint: 0xd4af37, skill: 0.74, line: 2.0, car: 'vortex', upgrades: 0 },
        { name: 'Rift', paint: 0x1f4fbf, skill: 0.92, line: 2.3, car: 'brute', upgrades: 3 },
      ],
      stars: [68.5, 71.5],
      tips: ['Upgrade everything before you enter', 'The rivals rarely make mistakes'],
    }),
  },
];

export function careerEvent(id: string): CareerEvent | null {
  return CAREER.find((e) => e.id === id) ?? null;
}

/** Stars earned in career events (best per event). */
export function careerStars(p: Progress): number {
  let n = 0;
  for (const e of CAREER) n += p.career[e.id]?.stars ?? 0;
  return n;
}

export interface CareerStatus {
  event: CareerEvent;
  unlocked: boolean;
  /** Why it is locked (null when unlocked). */
  lockReason: string | null;
  best: { time: number; stars: number; position: number | null } | null;
}

export function careerStatus(p: Progress): CareerStatus[] {
  const stars = careerStars(p);
  return CAREER.map((event) => {
    let lockReason: string | null = null;
    if (event.after && !p.career[event.after]) lockReason = `Clear ${careerEvent(event.after)?.level.title ?? 'the previous event'} first`;
    else if (stars < event.stars) lockReason = `Needs ${event.stars} career stars (you have ${stars})`;
    return { event, unlocked: lockReason === null, lockReason, best: p.career[event.id] ?? null };
  });
}

export function isCareerUnlocked(p: Progress, id: string): boolean {
  return careerStatus(p).find((s) => s.event.id === id)?.unlocked ?? false;
}

export interface CareerResult {
  stars: number;
  newBest: boolean;
  previousBest: number | null;
  credits: number;
  /** Events that this result unlocked (titles). */
  unlockedEvents: string[];
  unlockedPaints: string[];
}

/** Record a cleared career event: best time / stars, credits, newly unlocked events. Saves. */
export function recordCareer(p: Progress, id: string, time: number, stars: number, position: number | null): CareerResult | null {
  const event = careerEvent(id);
  if (!event || !Number.isFinite(time) || time <= 0) return null;
  const before = new Set(careerStatus(p).filter((s) => s.unlocked).map((s) => s.event.id));
  const starsBefore = totalStars(p);
  const prev = p.career[id];
  const newBest = !prev || time < prev.time;
  const s = Math.max(1, Math.min(3, Math.floor(stars)));
  p.career[id] = {
    time: newBest ? time : prev.time,
    stars: Math.max(s, prev?.stars ?? 0),
    position: position === null ? (prev?.position ?? null) : Math.min(position, prev?.position ?? 99),
  };
  const starsAfter = totalStars(p);
  const credits = rewardFor(event.reward, s, !prev, starsAfter - starsBefore);
  addCredits(p, credits);
  const unlockedEvents = careerStatus(p)
    .filter((st) => st.unlocked && !before.has(st.event.id))
    .map((st) => st.event.level.title);
  const unlockedPaints = PAINTS.filter((x) => x.stars > starsBefore && x.stars <= starsAfter).map((x) => x.name);
  saveProgress(p);
  return { stars: s, newBest, previousBest: prev ? prev.time : null, credits, unlockedEvents, unlockedPaints };
}
