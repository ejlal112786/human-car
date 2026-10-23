import {
  DEFAULT_VEHICLE,
  MAX_UPGRADE,
  PART_SLOTS,
  UPGRADE_KINDS,
  VEHICLES,
  factoryLook,
  freeParts,
  noUpgrades,
  partDef,
  partKey,
  vehicleById,
  type CarLook,
  type PartSlot,
  type UpgradeLevels,
  type CarSetup,
  neutralSetup,
  sanitizeSetup,
} from '../vehicles/VehicleCatalog';
import { LEVELS, PAINTS } from './Levels';

/** Per-car garage state. */
export interface CarSave {
  paint: string;
  upgrades: UpgradeLevels;
  /** Cosmetic parts bought for this car ("slot:id"; the factory fit is always owned and not listed). */
  parts: string[];
  /** Parts currently fitted. */
  look: CarLook;
  /** Free garage setup (tyre pressure, gearing, springs, brake bias). */
  setup: CarSetup;
  /** Tyre wear per wheel (FL, FR, RL, RR; 0 new … 1 worn out). */
  tyreWear: number[];
}

/** Fresh garage state for a newly owned car. */
export function newCarSave(id: string): CarSave {
  const def = vehicleById(id);
  return { paint: def.defaultPaint, upgrades: noUpgrades(), parts: [], look: factoryLook(def), setup: neutralSetup(), tyreWear: [0, 0, 0, 0] };
}

/** Does this car own the part (bought, or part of its factory fit)? */
export function ownsPart(c: CarSave, carId: string, slot: PartSlot, id: string): boolean {
  const key = partKey(slot, id);
  return c.parts.includes(key) || freeParts(vehicleById(carId)).includes(key);
}

function sanitizeCar(id: string, raw: unknown): CarSave {
  const def = vehicleById(id);
  const c = (raw && typeof raw === 'object' ? raw : {}) as { paint?: unknown; upgrades?: unknown; parts?: unknown; look?: unknown; setup?: unknown; tyreWear?: unknown };
  const out = newCarSave(id);
  if (typeof c.paint === 'string' && PAINTS.some((x) => x.id === c.paint)) out.paint = c.paint;
  out.upgrades = sanitizeUpgrades(c.upgrades);
  out.setup = sanitizeSetup(c.setup);
  if (Array.isArray(c.tyreWear) && c.tyreWear.length === 4 && c.tyreWear.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    out.tyreWear = c.tyreWear.map((x: number) => Math.min(1, Math.max(0, x)));
  }
  const free = freeParts(def);
  if (Array.isArray(c.parts)) {
    for (const k of c.parts) {
      if (typeof k !== 'string' || free.includes(k) || out.parts.includes(k)) continue;
      const [slot, pid] = k.split(':');
      if (PART_SLOTS.includes(slot as PartSlot) && partDef(slot as PartSlot, pid)) out.parts.push(k);
    }
  }
  const look = c.look && typeof c.look === 'object' ? (c.look as Record<string, unknown>) : {};
  for (const slot of PART_SLOTS) {
    const v = look[slot];
    if (typeof v === 'string' && partDef(slot, v) && ownsPart(out, id, slot, v)) (out.look as unknown as Record<string, string>)[slot] = v;
  }
  return out;
}

/** Price of a new set of tyres for an owned car (better tyre upgrades cost more to replace). */
export function tyrePrice(p: Progress, id: string): number {
  const def = vehicleById(id);
  const level = p.cars[id]?.upgrades.tyres ?? 0;
  return Math.round((400 * def.upgradeCost * (1 + 0.25 * level)) / 50) * 50;
}

/** Most-worn tyre of an owned car (0..1). */
export function tyreWearOf(p: Progress, id: string): number {
  const w = p.cars[id]?.tyreWear ?? [0, 0, 0, 0];
  return Math.max(...w);
}

/** Fit new tyres to an owned car (paid). False if not owned, not worn (under 5 %) or not affordable. */
export function fitNewTyres(p: Progress, id: string): boolean {
  if (!p.owned.includes(id) || tyreWearOf(p, id) < 0.05) return false;
  const price = tyrePrice(p, id);
  if (p.credits < price) return false;
  p.credits -= price;
  p.cars[id].tyreWear = [0, 0, 0, 0];
  saveProgress(p);
  return true;
}

/** Result of one career event. */
export interface EventResult {
  time: number;
  stars: number;
  /** Finishing position for races (null for timed events). */
  position: number | null;
}

/** Saved progress (localStorage), version 2. */
export interface Progress {
  version: 2;
  /** Number of missions unlocked (1 = only the first). */
  unlocked: number;
  /** Best result per mission id (`score` for score-based missions such as Drift). */
  best: Record<string, { time: number; stars: number; score?: number }>;
  /** Campaign layout the `unlocked` count refers to (2 = the 15-mission campaign). */
  campaign: 2;
  /** Paint of the selected car (mirrors cars[car].paint). */
  paint: string;
  credits: number;
  /** Lifetime credits earned. */
  earned: number;
  /** Selected vehicle id. */
  car: string;
  owned: string[];
  cars: Record<string, CarSave>;
  /** Career event results by event id. */
  career: Record<string, EventResult>;
  /** Owned cars held at the police impound lot (car id → recovery fee). */
  impound: Record<string, number>;
  /** Serving a jail sentence (arrested, not yet escaped or bailed out): saved so a reload can't skip it. */
  jail: JailSave | null;
  /** Times arrested (stats). */
  arrests: number;
}

export interface JailSave {
  /** Escape checkpoint reached (0 = cell). */
  checkpoint: number;
  /** Bail (credits) to be released legally. */
  bail: number;
  /** Items picked up at the checkpoint (keycard…), kept when caught. */
  items: string[];
}

export const JAIL_ITEMS = ['keycard'] as const;
const MAX_FEE = 50_000;

export const PROGRESS_KEY = 'city-racer.progress.v2';
export const PROGRESS_BACKUP_KEY = 'city-racer.progress.v2.backup';
export const PROGRESS_V1_KEY = 'city-racer.progress.v1';
const MAX_CREDITS = 9_999_999;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function defaultProgress(): Progress {
  return {
    version: 2,
    unlocked: 1,
    best: {},
    campaign: 2,
    paint: PAINTS[0].id,
    credits: 0,
    earned: 0,
    car: DEFAULT_VEHICLE,
    owned: [DEFAULT_VEHICLE],
    cars: { [DEFAULT_VEHICLE]: { ...newCarSave(DEFAULT_VEHICLE), paint: PAINTS[0].id } },
    career: {},
    impound: {},
    jail: null,
    arrests: 0,
  };
}

function sanitizeUpgrades(raw: unknown): UpgradeLevels {
  const u = noUpgrades();
  if (!raw || typeof raw !== 'object') return u;
  for (const k of UPGRADE_KINDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (isNum(v)) u[k] = Math.max(0, Math.min(MAX_UPGRADE, Math.floor(v)));
  }
  return u;
}

/**
 * Validate anything loaded from storage (any version, any garbage) into a well-formed Progress.
 * Unknown ids are dropped, numbers clamped; a v1 save (no version field) keeps its missions and paint.
 */
export function sanitizeProgress(raw: unknown): Progress {
  const p = defaultProgress();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
  const r = raw as Record<string, unknown>;
  if (isNum(r.unlocked)) {
    const n = Math.max(1, Math.floor(r.unlocked));
    if (r.campaign === 2) p.unlocked = Math.min(LEVELS.length, n);
    else {
      // Saves from the 5-mission layout: everything that was unlocked stays unlocked in the new order.
      const lastOld = OLD_LAYOUT[Math.min(OLD_LAYOUT.length, n) - 1];
      p.unlocked = Math.max(1, LEVELS.findIndex((l) => l.id === lastOld) + 1);
    }
  }
  if (r.best && typeof r.best === 'object') {
    LEVELS.forEach((l, k) => {
      const b = (r.best as Record<string, unknown>)[l.id] as { time?: unknown; stars?: unknown; score?: unknown } | undefined;
      if (b && isNum(b.time) && b.time > 0 && isNum(b.stars)) {
        p.best[l.id] = { time: b.time, stars: Math.max(1, Math.min(3, Math.floor(b.stars))) };
        if (isNum(b.score)) p.best[l.id].score = Math.max(0, Math.min(1e9, Math.round(b.score)));
        // A cleared mission always opens the next one.
        p.unlocked = Math.max(p.unlocked, Math.min(LEVELS.length, k + 2));
      }
    });
  }
  if (isNum(r.credits)) p.credits = Math.max(0, Math.min(MAX_CREDITS, Math.floor(r.credits)));
  if (isNum(r.earned)) p.earned = Math.max(p.credits, Math.min(MAX_CREDITS * 10, Math.floor(r.earned)));
  if (Array.isArray(r.owned)) {
    for (const id of r.owned) if (typeof id === 'string' && VEHICLES.some((v) => v.id === id) && !p.owned.includes(id)) p.owned.push(id);
  }
  const cars = r.cars && typeof r.cars === 'object' ? (r.cars as Record<string, unknown>) : {};
  for (const id of p.owned) p.cars[id] = sanitizeCar(id, cars[id]);
  if (typeof r.car === 'string' && p.owned.includes(r.car)) p.car = r.car;
  // v1 saves (and v2 mirrors): top-level paint is the selected car's paint.
  if (typeof r.paint === 'string' && PAINTS.some((x) => x.id === r.paint)) p.cars[p.car].paint = r.paint;
  p.paint = p.cars[p.car].paint;
  if (r.career && typeof r.career === 'object') {
    for (const [id, v] of Object.entries(r.career as Record<string, unknown>)) {
      if (!/^[a-z0-9-]{1,40}$/.test(id) || !v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      if (!isNum(e.time) || e.time <= 0 || !isNum(e.stars)) continue;
      p.career[id] = {
        time: e.time,
        stars: Math.max(1, Math.min(3, Math.floor(e.stars))),
        position: isNum(e.position) ? Math.max(1, Math.min(8, Math.floor(e.position))) : null,
      };
    }
  }
  if (r.impound && typeof r.impound === 'object' && !Array.isArray(r.impound)) {
    for (const [id, fee] of Object.entries(r.impound as Record<string, unknown>)) {
      if (p.owned.includes(id) && isNum(fee)) p.impound[id] = Math.max(0, Math.min(MAX_FEE, Math.floor(fee)));
    }
  }
  if (r.jail && typeof r.jail === 'object' && !Array.isArray(r.jail)) {
    const j = r.jail as Record<string, unknown>;
    p.jail = {
      checkpoint: isNum(j.checkpoint) ? Math.max(0, Math.min(3, Math.floor(j.checkpoint))) : 0,
      bail: isNum(j.bail) ? Math.max(0, Math.min(MAX_FEE, Math.floor(j.bail))) : 0,
      items: Array.isArray(j.items) ? j.items.filter((x): x is string => typeof x === 'string' && (JAIL_ITEMS as readonly string[]).includes(x)).slice(0, JAIL_ITEMS.length) : [],
    };
  }
  if (isNum(r.arrests)) p.arrests = Math.max(0, Math.min(1e6, Math.floor(r.arrests)));
  return p;
}

/** Fee to get a car back from the impound (by wanted level at the arrest). */
export function impoundFee(stars: number): number {
  return 400 + 300 * Math.max(1, Math.min(3, Math.round(stars)));
}

/** Bail to leave jail legally (by wanted level at the arrest). */
export function bailFor(stars: number): number {
  return 500 + 500 * Math.max(1, Math.min(3, Math.round(stars)));
}

export function isImpounded(p: Progress, carId: string): boolean {
  return p.impound[carId] !== undefined;
}

/** Hold an owned car at the impound (keeps the higher fee if it is already there). Returns false for cars the player doesn't own. */
export function impoundCar(p: Progress, carId: string, fee: number): boolean {
  if (!p.owned.includes(carId)) return false;
  p.impound[carId] = Math.max(p.impound[carId] ?? 0, Math.max(0, Math.min(MAX_FEE, Math.floor(fee))));
  return true;
}

/** Pay the fee and get the car back. Returns false when not impounded or not enough credits. */
export function payImpound(p: Progress, carId: string): boolean {
  const fee = p.impound[carId];
  if (fee === undefined || p.credits < fee) return false;
  p.credits -= fee;
  delete p.impound[carId];
  return true;
}

/** Take the car back without paying (broken out of the lot: the police deal with that). */
export function releaseImpound(p: Progress, carId: string): boolean {
  if (p.impound[carId] === undefined) return false;
  delete p.impound[carId];
  return true;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function parse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Where the last load came from (for tests): 'main' | 'backup' | 'v1' | 'default'. */
export let lastLoadSource: 'main' | 'backup' | 'v1' | 'default' = 'default';

/**
 * Load progress: the main v2 save; if it is missing or unreadable, the backup copy (last good
 * save); otherwise migrate a v1 save; otherwise start fresh. Never throws.
 */
export function loadProgress(): Progress {
  const ls = storage();
  if (!ls) {
    lastLoadSource = 'default';
    return defaultProgress();
  }
  let main: unknown = null;
  let backup: unknown = null;
  let v1: unknown = null;
  try {
    main = parse(ls.getItem(PROGRESS_KEY));
    backup = parse(ls.getItem(PROGRESS_BACKUP_KEY));
    v1 = parse(ls.getItem(PROGRESS_V1_KEY));
  } catch {
    /* storage blocked */
  }
  const ok = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && (x as { version?: unknown }).version === 2;
  if (ok(main)) {
    lastLoadSource = 'main';
    return sanitizeProgress(main);
  }
  if (ok(backup)) {
    lastLoadSource = 'backup';
    const p = sanitizeProgress(backup);
    saveProgress(p);
    return p;
  }
  if (v1 && typeof v1 === 'object') {
    lastLoadSource = 'v1';
    const p = sanitizeProgress(v1);
    saveProgress(p);
    return p;
  }
  lastLoadSource = 'default';
  return defaultProgress();
}

/**
 * The main save as it is in storage right now, if it is a valid v2 save (another tab of the game may have
 * written it since this tab loaded). Null when missing, unreadable or blocked: never adopt garbage. Never throws.
 */
export function readStoredProgress(): Progress | null {
  const ls = storage();
  if (!ls) return null;
  let raw: unknown = null;
  try {
    raw = parse(ls.getItem(PROGRESS_KEY));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { version?: unknown }).version !== 2) return null;
  return sanitizeProgress(raw);
}

/**
 * Replace the contents of `target` with `src` in place (the menu and game share one Progress object).
 * Returns false (and leaves `target` alone) when both already hold the same progress.
 */
export function adoptProgress(target: Progress, src: Progress): boolean {
  if (JSON.stringify(sanitizeProgress(target)) === JSON.stringify(src)) return false;
  const t = target as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) delete t[k];
  Object.assign(target, src);
  return true;
}

/** Save to the main key, then mirror to the backup key (so one damaged entry is always recoverable). */
export function saveProgress(p: Progress): void {
  const ls = storage();
  if (!ls) return;
  let text: string;
  try {
    text = JSON.stringify(sanitizeProgress(p));
  } catch {
    return;
  }
  try {
    ls.setItem(PROGRESS_KEY, text);
    ls.setItem(PROGRESS_BACKUP_KEY, text);
  } catch {
    /* storage full / unavailable: keep playing with in-memory progress */
  }
}

export function totalStars(p: Progress): number {
  let n = 0;
  for (const id in p.best) n += p.best[id].stars;
  for (const id in p.career) n += p.career[id].stars;
  return n;
}

export function isPaintUnlocked(p: Progress, paintId: string): boolean {
  const paint = PAINTS.find((x) => x.id === paintId);
  return !!paint && totalStars(p) >= paint.stars;
}

/** Credits for finishing an event: full on the first clear, 30 % on replays, +300 per newly earned star. */
export function rewardFor(base: number, stars: number, firstClear: boolean, newStars: number): number {
  const k = 1 + 0.25 * (Math.max(1, stars) - 1);
  return Math.round(((firstClear ? base : base * 0.3) * k + newStars * 300) / 10) * 10;
}

/** Credits per mission (by index, campaign order). */
export const MISSION_REWARDS = [500, 600, 800, 800, 1000, 1200, 1200, 1400, 1600, 1600, 1800, 2000, 2200, 2600, 3200];

/** Mission ids of the original 5-mission layout (save migration). */
const OLD_LAYOUT = ['find-your-ride', 'city-driving', 'obstacle-course', 'time-trial', 'street-race'];

/** Stars earned in campaign missions only (mission star gates). */
export function missionStars(p: Progress): number {
  let n = 0;
  for (const id in p.best) n += p.best[id].stars;
  return n;
}

/** Why mission `index` is locked (null = playable). */
export function missionLockReason(p: Progress, index: number): string | null {
  const lv = LEVELS[index];
  if (!lv) return 'Unknown mission';
  if (index >= p.unlocked) return 'Complete the previous mission to unlock';
  const need = lv.requiresStars ?? 0;
  const have = missionStars(p);
  if (have < need) return `Needs ${need} mission stars (you have ${have})`;
  return null;
}

export function isMissionUnlocked(p: Progress, index: number): boolean {
  return missionLockReason(p, index) === null;
}

export function addCredits(p: Progress, amount: number): void {
  p.credits = Math.max(0, Math.min(MAX_CREDITS, p.credits + Math.round(amount)));
  p.earned = Math.min(MAX_CREDITS * 10, p.earned + Math.max(0, Math.round(amount)));
}

export interface CompletionResult {
  stars: number;
  newBest: boolean;
  previousBest: number | null;
  /** Score-based missions: the previous best score (null = first clear or time-based). */
  previousScore: number | null;
  unlockedLevel: number | null;
  unlockedPaints: string[];
  credits: number;
}

/** Record a completed mission; returns what changed (for the results screen). */
export function recordCompletion(p: Progress, levelIndex: number, time: number, stars: number, score: number | null = null): CompletionResult {
  const level = LEVELS[levelIndex];
  const starsBefore = totalStars(p);
  const prev = p.best[level.id];
  // Score-based missions keep the run with the highest score; the rest the fastest time.
  const scored = score !== null;
  const newBest = !prev || (scored ? score > (prev.score ?? -1) : time < prev.time);
  const keep = newBest ? { time, score } : { time: prev.time, score: prev.score ?? null };
  p.best[level.id] = { time: keep.time, stars: Math.max(stars, prev?.stars ?? 0) };
  if (keep.score !== null && keep.score !== undefined) p.best[level.id].score = keep.score;
  let unlockedLevel: number | null = null;
  if (levelIndex + 1 < LEVELS.length && p.unlocked < levelIndex + 2) {
    p.unlocked = levelIndex + 2;
    unlockedLevel = levelIndex + 1;
  }
  const starsAfter = totalStars(p);
  const credits = rewardFor(MISSION_REWARDS[levelIndex] ?? 500, stars, !prev, starsAfter - starsBefore);
  addCredits(p, credits);
  const unlockedPaints = PAINTS.filter((x) => x.stars > starsBefore && x.stars <= starsAfter).map((x) => x.name);
  saveProgress(p);
  return {
    stars,
    newBest,
    previousBest: prev && !scored ? prev.time : null,
    previousScore: prev && scored ? (prev.score ?? null) : null,
    unlockedLevel,
    unlockedPaints,
    credits,
  };
}
