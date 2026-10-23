import { Vector3 } from 'three';
import type { Vehicle } from '../Vehicle';
import type { Track } from '../world/Track';
import type { LevelDef, TaskSpec, ZoneSpec } from './Levels';
import type { MissionVisuals } from './MissionVisuals';
import type { ObstacleManager } from './ObstacleManager';
import { AiRacer, indexDelta, type AmbientCar, type RaceGate } from './RaceAI';
import { vehicleById } from '../vehicles/VehicleCatalog';

export type MissionStage = 'toCar' | 'countdown' | 'drive' | 'park' | 'done';

export type MissionEvent =
  | { type: 'checkpoint'; index: number; total: number }
  | { type: 'missedGate'; seconds: number }
  | { type: 'penalty'; seconds: number; reason: string }
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  | { type: 'lap'; lap: number; total: number }
  | { type: 'task'; text: string; next: string | null }
  | { type: 'section'; index: number; avg: number; target: number; ok: boolean }
  | { type: 'drift'; points: number; lost: boolean }
  | { type: 'cargo'; integrity: number }
  | { type: 'police'; stars: number; behind: number }
  | { type: 'complete'; time: number; stars: number; position: number | null; score: number | null; details: Array<[string, string]> }
  | { type: 'failed'; reason: string };

/** Per-step facts about the player that the mission needs. */
export interface MissionInput {
  dt: number;
  inCar: boolean;
  carPos: Vector3;
  carPrev: Vector3;
  /** Car forward direction (XZ). */
  carFwdX: number;
  carFwdZ: number;
  /** |forward speed| (m/s). */
  carSpeed: number;
  /** Signed forward speed (m/s, negative = reversing). */
  forwardSpeed: number;
  /** World velocity (XZ, m/s). */
  carVelX: number;
  carVelZ: number;
  handbrake: boolean;
  /** Collision velocity change this step (m/s), 0 if none. */
  impact: number;
  /** The player ran a red light this step. */
  redLight: boolean;
  /** The player's car hit a pedestrian this step. */
  pedHit: boolean;
  /** Distance to the nearest police unit (Infinity = none). */
  policeNear: number;
  /** The police arrested the player this step. */
  busted: boolean;
}

export function createMissionInput(): MissionInput {
  return {
    dt: 0,
    inCar: false,
    carPos: new Vector3(),
    carPrev: new Vector3(),
    carFwdX: 1,
    carFwdZ: 0,
    carSpeed: 0,
    forwardSpeed: 0,
    carVelX: 0,
    carVelZ: 0,
    handbrake: false,
    impact: 0,
    redLight: false,
    pedHit: false,
    policeNear: Infinity,
    busted: false,
  };
}

export interface MissionHud {
  title: string;
  objective: string;
  /** Large clock text, e.g. "0:42.3" (null = hidden). */
  timer: string | null;
  timerWarning: boolean;
  /** Secondary lines (checkpoints, penalties, position). */
  info: string[];
}

export interface RacerStanding {
  name: string;
  player: boolean;
  finished: boolean;
  time: number;
  /** Rival missed a checkpoint: out of the race (shown as DSQ, ranked last). */
  disqualified?: boolean;
}

/** Race options from the player's settings. */
export interface RaceOptions {
  /** Rival driving-skill multiplier (difficulty preset). */
  skillScale: number;
  /** Rubber band: rivals far ahead drive a little more carefully, far behind a little harder (off by default). */
  rubberBand: boolean;
}

/** Rubber band: skill change per metre of gap to the player, and its limit (only when enabled). */
const RUBBER_PER_M = 0.05 / 300;
const RUBBER_MAX = 0.05;

/** Car half extents for the parking check (chassis frame: x forward, z right). */
const CAR_HALF_LEN = 2.15;
const CAR_HALF_WID = 0.92;

// ---- Drift scoring
/** Points per second per (m/s × degree of slip angle above the floor). */
const DRIFT_POINT_RATE = 1;
/** Minimum speed (m/s) and slip-angle window (degrees) that count as drifting. */
const DRIFT_MIN_SPEED = 7;
const DRIFT_MIN_ANGLE = 12;
const DRIFT_MAX_ANGLE = 75;
/** A drift chain is banked after this long without drifting (s). */
const DRIFT_BANK_AFTER = 1.2;
/** Impact (m/s) that ends the current chain with nothing banked. */
const DRIFT_CRASH = 2.5;
const DRIFT_MAX_MULT = 5;

export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

interface GateFrame {
  /** Track sample of the gate. */
  k: number;
  x: number;
  z: number;
  tx: number;
  tz: number;
  halfWidth: number;
  slalom: boolean;
}

interface ZoneFrame {
  x: number;
  z: number;
  tx: number;
  tz: number;
  hl: number;
  hw: number;
  hold: number;
  maxSpeed: number;
  facing: 0 | 1 | -1;
}

/**
 * Runs the active mission: objective stages, clock, checkpoint gates (passed in order and
 * in the correct direction), penalties, parking bays, race opponents and the completion /
 * failure conditions. All logic advances in fixed simulation steps.
 *
 * Levels either use the classic flow (gates, then an optional bay) or an ordered task list
 * (`LevelDef.tasks`: speed, reverse, handbrake turn, gate runs and bays). Optional rules layer
 * on top: laps, speed sections, drift scoring, fragile cargo, a police pursuit, red-light penalties.
 */
export class MissionManager {
  level: LevelDef | null = null;
  levelIndex = -1;
  stage: MissionStage = 'toCar';
  /** Clock (s), counting while `clockRunning`. */
  elapsed = 0;
  clockRunning = false;
  penaltyTime = 0;
  strikes = 0;
  nextGate = 0;
  zoneHold = 0;
  zoneInside = false;
  countdown = 0;
  hasEntered = false;
  readonly events: MissionEvent[] = [];
  readonly racers: AiRacer[] = [];
  /** Reused list of every car on the course, handed to the AI each step. */
  private readonly traffic: Vehicle[] = [];
  /** Gate frames for the whole run (laps repeat the level's gates). */
  private gates: GateFrame[] = [];
  private perLap = 0;
  private laps = 1;
  private zone: ZoneFrame | null = null;
  private hitCooldown = 0;
  private lastCount = 0;
  private playerIdx = 0;
  private playerProgress = 0;
  private playerRaceLength = 0;
  /** Race finishing position (null until the player finishes a race). */
  finishPosition: number | null = null;
  private readonly corner = new Vector3();

  // ---- task flow
  taskIndex = 0;
  private hbGrace = 0;
  private taskGateEnd = 0;
  private taskProgress = 0;
  private hbPrevYaw = NaN;
  /** Zone blocked by nearby police (Police Escape), for the HUD. */
  policeTooClose = false;

  // ---- rules
  redLights = 0;
  private sectionIndex = -1;
  private sectionDist = 0;
  private sectionTime = 0;
  failedSections = 0;
  readonly sectionResults: Array<{ avg: number; ok: boolean }> = [];
  driftScore = 0;
  driftChain = 0;
  driftChainTime = 0;
  private driftIdle = 0;
  driftAngle = 0;
  cargoLoaded = false;
  cargo = 100;
  private cargoCd = 0;

  constructor(
    private readonly track: Track,
    private readonly obstacles: ObstacleManager,
    private readonly visuals: MissionVisuals,
    private readonly opponentPool: Vehicle[],
  ) {}

  get isFreeRoam(): boolean {
    return !this.level || this.level.kind === 'free';
  }

  /** Driving controls are frozen (race countdown). */
  get inputLocked(): boolean {
    return this.stage === 'countdown';
  }

  /** Current task (task-flow levels only). */
  get task(): TaskSpec | null {
    return this.level?.tasks?.[this.taskIndex] ?? null;
  }

  /** Current lap (1-based) for multi-lap races. */
  get lap(): number {
    return this.perLap ? Math.min(this.laps, Math.floor(this.nextGate / this.perLap) + 1) : 1;
  }

  get lapCount(): number {
    return this.laps;
  }

  /** Whether the player may leave the car right now (null = allowed, otherwise the reason). */
  exitBlockReason(): string | null {
    if (this.level?.race && (this.stage === 'countdown' || this.stage === 'drive')) return 'You can’t leave the car during a race';
    return null;
  }

  private sample(i: number): number {
    const c = this.track.count;
    return ((Math.round(i) % c) + c) % c;
  }

  private frameAt(i: number, off: number, halfWidth: number, slalom: boolean): GateFrame {
    const t = this.track;
    const k = this.sample(i);
    return { k, x: t.px[k] + t.rx(k) * off, z: t.pz[k] + t.rz(k) * off, tx: t.tx[k], tz: t.tz[k], halfWidth, slalom };
  }

  private zoneFrame(z: ZoneSpec): ZoneFrame {
    const f = this.frameAt(z.i, z.off, 0, false);
    return { x: f.x, z: f.z, tx: f.tx, tz: f.tz, hl: z.length / 2, hw: z.width / 2, hold: z.hold, maxSpeed: z.maxSpeed, facing: z.facing ?? 0 };
  }

  /** Road samples from `startI` to the finish line (last gate of the last lap). */
  private raceLength(startI: number): number {
    const last = this.level?.gates[this.level.gates.length - 1];
    if (!last) return 0;
    return (this.laps - 1) * this.track.count + this.track.count + indexDelta(this.track, this.sample(startI), this.sample(last.i));
  }

  load(level: LevelDef, levelIndex: number): void {
    this.level = level;
    this.levelIndex = levelIndex;
    this.laps = Math.max(1, level.laps ?? 1);
    this.perLap = level.gates.length;
    this.obstacles.load(level.obstacles);
    const base = level.gates.map((g) => this.frameAt(g.i, g.off, g.halfWidth, !!g.slalom));
    this.gates = [];
    for (let l = 0; l < this.laps; l++) this.gates.push(...base);
    // Opponents: activate as many pooled cars as the race needs.
    this.racers.length = 0;
    const ops = level.race?.opponents ?? [];
    this.opponentPool.forEach((v, k) => {
      const spec = ops[k];
      v.setActive(!!spec);
      if (spec) {
        // Rivals drive their catalogue car (handling + body) with uniform upgrade levels.
        const u = spec.upgrades ?? 0;
        v.configure(vehicleById(spec.car ?? 'kestrel'), { engine: u, tyres: u, brakes: u, suspension: 0 }, spec.paint);
        v.fitNewTyres();
        this.racers.push(new AiRacer(v, spec, this.track));
      }
    });
    this.reset();
  }

  private raceOptions: RaceOptions = { skillScale: 1, rubberBand: false };

  /** Difficulty / rubber band for rivals; applies from the next (re)start. */
  setRaceOptions(o: RaceOptions): void {
    this.raceOptions = { ...o };
  }

  /**
   * The run's checkpoints as seen from a grid slot: each gate with the progress (samples) at which a car from
   * `startI` reaches it — the first match after the previous gate, so a finish line just ahead of the grid
   * counts at the end of the lap, not at the start.
   */
  private racerGates(startI: number): RaceGate[] {
    const n = this.track.count;
    const s = this.sample(startI);
    const out: RaceGate[] = [];
    let prev = 0;
    for (const g of this.gates) {
      let mark = (((g.k - s) % n) + n) % n;
      while (mark <= prev && out.length) mark += n;
      out.push({ x: g.x, z: g.z, tx: g.tx, tz: g.tz, halfWidth: g.halfWidth, mark });
      prev = mark;
    }
    return out;
  }

  /** Restart the mission: obstacles, gates, clock, opponents. */
  reset(): void {
    this.stage = this.isFreeRoam ? 'drive' : 'toCar';
    this.elapsed = 0;
    this.clockRunning = !!this.level && !this.level.clockOnEnter && !this.isFreeRoam;
    this.penaltyTime = 0;
    this.strikes = 0;
    this.nextGate = 0;
    this.zoneHold = 0;
    this.zoneInside = false;
    this.countdown = 0;
    this.hasEntered = false;
    this.hitCooldown = 0;
    this.finishPosition = null;
    this.events.length = 0;
    this.taskIndex = 0;
    this.taskGateEnd = 0;
    this.taskProgress = 0;
    this.hbPrevYaw = NaN;
    this.policeTooClose = false;
    this.redLights = 0;
    this.sectionIndex = -1;
    this.sectionDist = 0;
    this.sectionTime = 0;
    this.failedSections = 0;
    this.sectionResults.length = 0;
    this.driftScore = 0;
    this.driftChain = 0;
    this.driftChainTime = 0;
    this.driftIdle = 0;
    this.driftAngle = 0;
    this.cargoLoaded = false;
    this.cargo = 100;
    this.cargoCd = 0;
    this.obstacles.reset();
    this.obstacles.takeNewlyDisplaced();
    const level = this.level;
    if (level) {
      // Visuals: the per-lap gates; the zone of the classic flow or of the first zone task.
      const tasks = level.tasks;
      const lastIsGates = tasks ? tasks[tasks.length - 1]?.kind === 'gates' : !level.zone;
      this.visuals.load(level.gates, tasks ? undefined : level.zone, lastIsGates && this.laps === 1);
      this.zone = !tasks && level.zone ? this.zoneFrame(level.zone) : null;
      if (tasks) this.enterTask(0, false);
    }
    this.visuals.setProgress(0);
    this.visuals.setZoneInside(false);
    for (const r of this.racers) {
      r.reset();
      r.vehicle.skids.clear();
      r.skillScale = this.raceOptions.skillScale;
      r.setGates(this.racerGates(r.spec.i));
    }
    if (level) {
      this.playerIdx = this.sample(level.carStart.i);
      this.playerProgress = 0;
      this.playerRaceLength = level.gates.length ? this.raceLength(level.carStart.i) : 0;
    }
  }

  /** The player got into the car. */
  onEnterCar(): void {
    if (this.hasEntered || this.isFreeRoam || this.stage === 'done') return;
    this.hasEntered = true;
    const level = this.level;
    if (level?.race) {
      this.stage = 'countdown';
      this.countdown = 3;
      this.lastCount = 4;
    } else {
      this.stage = level?.tasks ? 'drive' : this.gates.length ? 'drive' : this.zone ? 'park' : 'drive';
      if (level?.clockOnEnter) this.clockRunning = true;
      if (level?.speed?.sections.some((s) => s.from === -1)) this.startSection(-1);
      if (level?.police) this.events.push({ type: 'police', stars: level.police.stars, behind: level.police.behind });
    }
  }

  /**
   * AI and course inputs: call once per fixed step before world.step(). `player` is the player's
   * car (traffic for the AI); `ambient` = city traffic cars the rivals must avoid.
   */
  preStep(dt: number, player?: Vehicle, ambient: readonly AmbientCar[] = []): void {
    this.obstacles.fixedUpdate(dt);
    const go = this.stage === 'drive' || this.stage === 'done';
    const traffic = this.traffic;
    traffic.length = 0;
    if (player) traffic.push(player);
    for (const r of this.racers) traffic.push(r.vehicle);
    if (this.raceOptions.rubberBand && go && this.level?.race) {
      // Optional, explicit: adjust each rival's driving skill by its gap to the player (never grip or position).
      const mine = this.playerRaceLength - this.playerProgress;
      for (const r of this.racers) {
        const ahead = (mine - (this.raceLength(r.spec.i) - r.progress)) * this.track.spacing;
        r.paceAdjust = -Math.max(-RUBBER_MAX, Math.min(RUBBER_MAX, ahead * RUBBER_PER_M));
      }
    }
    for (const r of this.racers) r.fixedUpdate(dt, go && this.level?.race !== undefined, traffic, ambient);
  }

  /** Mission logic: call once per fixed step after world.step(). */
  postStep(inp: MissionInput): void {
    for (const r of this.racers) r.afterStep(this.elapsed, this.raceLength(r.spec.i));
    if (!this.level || this.isFreeRoam || this.stage === 'done') return;
    const level = this.level;
    const dt = inp.dt;

    if (this.stage === 'countdown') {
      this.countdown -= dt;
      const c = Math.ceil(this.countdown);
      if (c !== this.lastCount && c > 0) {
        this.lastCount = c;
        this.events.push({ type: 'countdown', value: c });
      }
      if (this.countdown <= 0) {
        this.stage = 'drive';
        this.clockRunning = true;
        this.events.push({ type: 'go' });
      }
      return;
    }
    if (this.clockRunning) this.elapsed += dt;

    if (inp.busted && level.police) {
      this.fail('Busted — the police caught you');
      return;
    }

    // Player race progress (for standings).
    if (inp.inCar) {
      const next = this.track.trackIndex(inp.carPos.x, inp.carPos.z, this.playerIdx);
      this.playerProgress += indexDelta(this.track, this.playerIdx, next);
      this.playerIdx = next;
    }

    // Gates: crossing the gate line forwards, inside the opening. In the task flow only during a gates task.
    const gateLimit = level.tasks ? (this.task?.kind === 'gates' ? this.taskGateEnd : 0) : this.gates.length;
    if (inp.inCar && this.nextGate < gateLimit) this.checkGate(inp);
    if ((this.stage as MissionStage) === 'done') return;

    // Race lost: enough rivals have finished that the required place is out of reach.
    if (level.race) {
      let done = 0;
      for (const r of this.racers) if (r.finished) done++;
      if (done >= level.race.requiredPosition) {
        this.fail(level.race.requiredPosition === 1 ? 'A rival took the win — only a win counts' : `${done} rivals finished ahead — top ${level.race.requiredPosition} needed`);
        return;
      }
    }

    // Speed sections.
    if (this.sectionIndex >= 0 && inp.inCar) {
      this.sectionTime += dt;
      this.sectionDist += Math.max(0, inp.forwardSpeed) * dt;
    }

    // Drift scoring.
    if (level.drift) this.stepDrift(inp);

    // Penalties: knocked props and hits; red lights and pedestrians where the level says so.
    const pens = level.penalties;
    if (pens) {
      const n = this.obstacles.takeNewlyDisplaced();
      for (let k = 0; k < n; k++) this.addPenalty(pens.perProp, 'Obstacle hit');
      this.hitCooldown -= dt;
      if (inp.impact > (pens.hitImpact ?? 2.5) && this.hitCooldown <= 0 && inp.inCar) {
        this.hitCooldown = 0.8;
        this.addPenalty(pens.perHit, level.traffic ? 'Collision' : level.kind === 'parking' ? 'Bump' : 'Barrier hit');
      }
      if (inp.pedHit && inp.inCar && level.traffic) this.addPenalty(pens.perHit * 2, 'Pedestrian hit');
      if (this.strikes >= pens.maxStrikes) {
        this.fail(level.traffic ? 'Too many collisions — drive more carefully' : level.kind === 'parking' ? 'Too many bumps — the examiner stopped the test' : 'Too many strikes — drive more carefully');
        return;
      }
    }
    if (level.redLight && inp.redLight && inp.inCar) {
      this.redLights++;
      this.penaltyTime += level.redLight;
      this.events.push({ type: 'penalty', seconds: level.redLight, reason: 'Red light' });
    }

    // Fragile cargo.
    if (level.cargo && this.cargoLoaded) {
      this.cargoCd -= dt;
      if (inp.impact > 1 && this.cargoCd <= 0) {
        this.cargoCd = 0.4;
        this.cargo = Math.max(0, this.cargo - Math.min(60, (inp.impact - 1) * level.cargo.perImpact));
        this.events.push({ type: 'cargo', integrity: Math.round(this.cargo) });
        if (this.cargo <= 0) {
          this.fail('The cargo was destroyed');
          return;
        }
      }
    }

    // Tasks (speed / reverse / handbrake) and bays.
    if (level.tasks) {
      this.stepTask(inp);
      if ((this.stage as MissionStage) === 'done') return;
    } else if (this.stage === 'park' && this.zone) {
      if (this.stepZone(inp)) {
        this.complete();
        return;
      }
    }

    // Time limit.
    if (level.timeLimit && this.elapsed >= level.timeLimit) this.fail('Time’s up');
  }

  private checkGate(inp: MissionInput): void {
    const level = this.level!;
    const g = this.gates[this.nextGate];
    const dPrev = (inp.carPrev.x - g.x) * g.tx + (inp.carPrev.z - g.z) * g.tz;
    const dCur = (inp.carPos.x - g.x) * g.tx + (inp.carPos.z - g.z) * g.tz;
    if (dPrev < 0 && dCur >= 0) {
      const k = dPrev / (dPrev - dCur);
      const cx = inp.carPrev.x + (inp.carPos.x - inp.carPrev.x) * k;
      const cz = inp.carPrev.z + (inp.carPos.z - inp.carPrev.z) * k;
      const lat = (cx - g.x) * -g.tz + (cz - g.z) * g.tx;
      if (Math.abs(lat) <= g.halfWidth) this.passGate();
      else if (g.slalom && Math.abs(lat) < 12) {
        const pen = level.penalties?.perMissedGate ?? 5;
        this.addPenalty(pen, 'Missed gate');
        this.events.push({ type: 'missedGate', seconds: pen });
        this.passGate(true);
      }
    }
  }

  /** Parking check for the current bay; returns true once the hold time is reached. */
  private stepZone(inp: MissionInput): boolean {
    const z = this.zone;
    if (!z) return false;
    let inside = inp.inCar && this.carInZone(inp);
    const clear = (this.task?.kind === 'zone' && this.task.clearOfPolice) || 0;
    // The police must be clear when the car stops in the hideout; once it is parked out of sight the
    // hold completes even if a patrol car passes by.
    this.policeTooClose = inside && clear > 0 && this.zoneHold === 0 && inp.policeNear < clear;
    if (this.policeTooClose) inside = false;
    if (inside !== this.zoneInside) {
      this.zoneInside = inside;
      this.visuals.setZoneInside(inside);
    }
    if (inside && inp.carSpeed <= z.maxSpeed) this.zoneHold += inp.dt;
    else this.zoneHold = 0;
    return this.zoneHold >= z.hold;
  }

  private carInZone(inp: MissionInput): boolean {
    const z = this.zone;
    if (!z) return false;
    const fl = Math.hypot(inp.carFwdX, inp.carFwdZ) || 1;
    const fx = inp.carFwdX / fl;
    const fz = inp.carFwdZ / fl;
    if (z.facing !== 0 && (fx * z.tx + fz * z.tz) * z.facing < 0.85) return false;
    const rx = -fz;
    const rz = fx;
    for (const a of [-1, 1])
      for (const b of [-1, 1]) {
        this.corner.set(inp.carPos.x + fx * a * CAR_HALF_LEN + rx * b * CAR_HALF_WID, 0, inp.carPos.z + fz * a * CAR_HALF_LEN + rz * b * CAR_HALF_WID);
        const dx = this.corner.x - z.x;
        const dz = this.corner.z - z.z;
        const u = dx * z.tx + dz * z.tz;
        const w = dx * -z.tz + dz * z.tx;
        if (Math.abs(u) > z.hl || Math.abs(w) > z.hw) return false;
      }
    return true;
  }

  // ------------------------------------------------------------------ task flow

  private enterTask(index: number, announce: boolean): void {
    const tasks = this.level?.tasks;
    if (!tasks) return;
    const prev = tasks[index - 1];
    this.taskIndex = index;
    this.taskProgress = 0;
    this.hbPrevYaw = NaN;
    this.zoneHold = 0;
    this.zoneInside = false;
    this.policeTooClose = false;
    const t = tasks[index];
    if (announce && prev) {
      const doneText = prev.kind === 'zone' && prev.done ? prev.done : 'Done!';
      this.events.push({ type: 'task', text: doneText, next: t ? t.text : null });
    }
    if (!t) return;
    if (t.kind === 'gates') this.taskGateEnd = Math.min(this.gates.length, this.nextGate + t.count);
    this.zone = t.kind === 'zone' ? this.zoneFrame(t.zone) : null;
    this.visuals.setZone(t.kind === 'zone' ? t.zone : null);
  }

  private advanceTask(): void {
    const tasks = this.level?.tasks;
    if (!tasks) return;
    const t = tasks[this.taskIndex];
    if (t?.kind === 'zone' && t.pickup) this.cargoLoaded = true;
    if (this.taskIndex + 1 >= tasks.length) {
      this.zone = null;
      this.visuals.setZone(null);
      this.complete();
      return;
    }
    this.enterTask(this.taskIndex + 1, true);
  }

  private stepTask(inp: MissionInput): void {
    const t = this.task;
    if (!t || !inp.inCar) {
      if (t?.kind === 'handbrake') this.hbPrevYaw = NaN;
      return;
    }
    switch (t.kind) {
      case 'speed':
        if (inp.forwardSpeed * 3.6 >= t.kmh) this.advanceTask();
        break;
      case 'reverse':
        if (inp.forwardSpeed < -0.2) this.taskProgress += -inp.forwardSpeed * inp.dt;
        if (this.taskProgress >= t.metres) this.advanceTask();
        break;
      case 'handbrake': {
        // Heading change while the handbrake is held at speed, or within a short grace after releasing
        // it (kick the rear out with the handbrake, then drive round). Stopping or a long pause resets.
        const yaw = Math.atan2(inp.carFwdZ, inp.carFwdX);
        if (inp.handbrake) this.hbGrace = 1.5;
        else this.hbGrace = Math.max(0, this.hbGrace - inp.dt);
        const turning = (inp.handbrake && inp.carSpeed > 2) || (this.hbGrace > 0 && this.taskProgress > 0 && inp.carSpeed > 1.5);
        if (turning) {
          if (!Number.isNaN(this.hbPrevYaw)) {
            let d = yaw - this.hbPrevYaw;
            if (d > Math.PI) d -= 2 * Math.PI;
            if (d < -Math.PI) d += 2 * Math.PI;
            this.taskProgress += Math.abs(d) * (180 / Math.PI);
          }
          this.hbPrevYaw = yaw;
        } else {
          // Each attempt must be one continuous turn.
          if (!inp.handbrake || inp.carSpeed <= 1.5) this.taskProgress = 0;
          this.hbPrevYaw = NaN;
        }
        if (this.taskProgress >= t.degrees) this.advanceTask();
        break;
      }
      case 'gates':
        break;
      case 'zone':
        if (this.stepZone(inp)) this.advanceTask();
        break;
    }
  }

  /** Task progress for the HUD (0..1, null = none). */
  taskFraction(): number | null {
    const t = this.task;
    if (!t) return null;
    if (t.kind === 'reverse') return Math.min(1, this.taskProgress / t.metres);
    if (t.kind === 'handbrake') return Math.min(1, this.taskProgress / t.degrees);
    return null;
  }

  // ------------------------------------------------------------------ rules

  private startSection(gateIndex: number): void {
    const secs = this.level?.speed?.sections;
    if (!secs) return;
    const k = secs.findIndex((s) => s.from === gateIndex);
    if (k < 0) return;
    this.sectionIndex = k;
    this.sectionDist = 0;
    this.sectionTime = 0;
  }

  private endSection(gateIndex: number): void {
    const sp = this.level?.speed;
    if (!sp || this.sectionIndex < 0) return;
    const s = sp.sections[this.sectionIndex];
    if (s.to !== gateIndex) return;
    const avg = this.sectionTime > 0 ? (this.sectionDist / this.sectionTime) * 3.6 : 0;
    const ok = avg >= s.kmh;
    this.sectionResults.push({ avg, ok });
    this.events.push({ type: 'section', index: this.sectionIndex, avg, target: s.kmh, ok });
    this.sectionIndex = -1;
    if (!ok) {
      this.failedSections++;
      this.addPenalty(sp.penalty, 'Section too slow');
      if (this.failedSections > sp.maxFailed) this.fail('Too slow through the speed sections');
    }
  }

  /** Current speed-section average (km/h) and target, for the HUD. */
  sectionLive(): { index: number; avg: number; target: number } | null {
    const sp = this.level?.speed;
    if (!sp || this.sectionIndex < 0) return null;
    return { index: this.sectionIndex, avg: this.sectionTime > 0.3 ? (this.sectionDist / this.sectionTime) * 3.6 : 0, target: sp.sections[this.sectionIndex].kmh };
  }

  get driftMultiplier(): number {
    return Math.min(DRIFT_MAX_MULT, 1 + Math.floor(this.driftChainTime / 1.5));
  }

  private stepDrift(inp: MissionInput): void {
    if (this.stage !== 'drive' || !this.clockRunning) return;
    const speed = Math.hypot(inp.carVelX, inp.carVelZ);
    let angle = 0;
    if (inp.inCar && speed > DRIFT_MIN_SPEED && inp.forwardSpeed > 0) {
      const fl = Math.hypot(inp.carFwdX, inp.carFwdZ) || 1;
      const cos = (inp.carVelX * inp.carFwdX + inp.carVelZ * inp.carFwdZ) / (speed * fl);
      angle = Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
    }
    this.driftAngle = angle;
    if (inp.impact > DRIFT_CRASH && this.driftChain > 0) {
      this.events.push({ type: 'drift', points: Math.round(this.driftChain), lost: true });
      this.driftChain = 0;
      this.driftChainTime = 0;
      this.driftIdle = 0;
      return;
    }
    if (angle >= DRIFT_MIN_ANGLE && angle <= DRIFT_MAX_ANGLE) {
      this.driftIdle = 0;
      this.driftChainTime += inp.dt;
      // Points grow with speed and angle; the multiplier rewards long chains.
      this.driftChain += inp.dt * speed * (angle - DRIFT_MIN_ANGLE + 8) * DRIFT_POINT_RATE * this.driftMultiplier;
    } else if (this.driftChain > 0) {
      this.driftIdle += inp.dt;
      if (this.driftIdle >= DRIFT_BANK_AFTER) this.bankDrift();
    }
  }

  private bankDrift(): void {
    if (this.driftChain <= 0) return;
    const pts = Math.round(this.driftChain);
    this.driftScore += pts;
    this.events.push({ type: 'drift', points: pts, lost: false });
    this.driftChain = 0;
    this.driftChainTime = 0;
    this.driftIdle = 0;
  }

  // ------------------------------------------------------------------ gates / results

  private passGate(missed = false): void {
    this.nextGate++;
    const level = this.level!;
    const total = this.gates.length;
    const gi = (this.nextGate - 1) % (this.perLap || 1);
    this.visuals.setProgress(this.laps > 1 ? this.nextGate % this.perLap : this.nextGate);
    if (this.laps > 1 && this.nextGate % this.perLap === 0 && this.nextGate < total) {
      this.events.push({ type: 'lap', lap: this.nextGate / this.perLap + 1, total: this.laps });
      // Last lap: the line becomes the finish banner.
      if (this.nextGate / this.perLap === this.laps - 1) this.visuals.load(level.gates, undefined, true);
      this.visuals.setProgress(0);
    } else if (!missed) this.events.push({ type: 'checkpoint', index: this.nextGate, total });
    if (level.speed) {
      this.endSection(gi);
      if (this.stage === 'done') return;
      this.startSection(gi);
    }
    if (level.tasks) {
      if (this.nextGate >= this.taskGateEnd) this.advanceTask();
      return;
    }
    if (this.nextGate >= total) {
      if (this.zone) this.stage = 'park';
      else this.complete();
    }
  }

  private addPenalty(seconds: number, reason: string): void {
    this.penaltyTime += seconds;
    this.strikes++;
    this.events.push({ type: 'penalty', seconds, reason });
  }

  /** 1-based race position of the player (null outside races). */
  playerPosition(): number | null {
    if (!this.level?.race) return null;
    if (this.finishPosition !== null) return this.finishPosition;
    const remaining = this.playerRaceLength - this.playerProgress;
    let pos = 1;
    for (const r of this.racers) {
      if (r.disqualified) continue;
      if (r.finished || this.raceLength(r.spec.i) - r.progress < remaining) pos++;
    }
    return pos;
  }

  /** Final / current standings (race results screen). */
  standings(): RacerStanding[] {
    const list: Array<RacerStanding & { key: number }> = [];
    for (const r of this.racers) {
      const rLen = this.raceLength(r.spec.i);
      const key = r.finished ? r.finishTime : r.disqualified ? 2e6 : 1e6 + (rLen - r.progress);
      list.push({ name: r.name, player: false, finished: r.finished, time: r.finishTime, disqualified: r.disqualified, key });
    }
    const pf = this.stage === 'done' && this.finishPosition !== null;
    list.push({
      name: 'You',
      player: true,
      finished: pf,
      time: this.elapsed,
      key: pf ? this.elapsed : 1e6 + (this.playerRaceLength - this.playerProgress),
    });
    list.sort((a, b) => a.key - b.key);
    return list.map(({ key: _k, ...rest }) => rest);
  }

  private complete(): void {
    const level = this.level;
    if (!level) return;
    const total = this.elapsed + this.penaltyTime;
    let position: number | null = null;
    const details: Array<[string, string]> = [];
    if (level.race) {
      position = 1;
      for (const r of this.racers) if (r.finished && r.finishTime <= this.elapsed) position++;
      this.finishPosition = position;
      details.push(['Position', `${ordinal(position)} of ${this.racers.length + 1}`]);
      if (position > level.race.requiredPosition) {
        this.stage = 'done';
        this.clockRunning = false;
        this.events.push({ type: 'failed', reason: `You finished ${ordinal(position)} — ${level.race.requiredPosition === 1 ? 'only a win counts' : `top ${level.race.requiredPosition} needed`}` });
        return;
      }
    }
    const [s3, s2] = level.stars ?? [0, 0];
    let stars = total <= s3 ? 3 : total <= s2 ? 2 : 1;
    let score: number | null = null;
    if (level.race?.byPosition && position !== null) stars = Math.max(1, 4 - position);
    if (level.drift) {
      this.bankDrift();
      score = this.driftScore;
      details.push(['Drift score', fmtInt(score)]);
      if (score < level.drift.target) {
        this.fail(`Not enough drift points — ${fmtInt(score)} of ${fmtInt(level.drift.target)}`);
        return;
      }
      stars = score >= level.drift.stars[0] ? 3 : score >= level.drift.stars[1] ? 2 : 1;
    }
    if (level.cargo) {
      details.push(['Cargo condition', `${Math.round(this.cargo)}%`]);
      if (this.cargo < level.cargo.gold) stars = Math.min(stars, 2);
    }
    if (level.speed) {
      this.sectionResults.forEach((r, k) => details.push([`Section ${k + 1}`, `${Math.round(r.avg)} km/h ${r.ok ? '✓' : '✗'}`]));
    }
    if (level.redLight) details.push(['Red lights run', String(this.redLights)]);
    this.stage = 'done';
    this.clockRunning = false;
    this.events.push({ type: 'complete', time: total, stars, position, score, details });
  }

  /** End the run as failed (also used by the game, e.g. when the player is arrested). */
  fail(reason: string): void {
    if (this.stage === 'done') return;
    this.stage = 'done';
    this.clockRunning = false;
    this.events.push({ type: 'failed', reason });
  }

  /** World-space XZ of the current navigation target (null = none). */
  target(carPos: Vector3, inCar: boolean, out: Vector3): 'car' | 'gate' | 'zone' | null {
    if (!this.level || this.isFreeRoam || this.stage === 'done') return null;
    if (!inCar) {
      out.copy(carPos);
      return 'car';
    }
    const t = this.task;
    const gatesOk = this.level.tasks ? t?.kind === 'gates' : this.stage === 'drive' || this.stage === 'countdown';
    if (this.nextGate < this.gates.length && gatesOk) {
      const g = this.gates[this.nextGate];
      out.set(g.x, 0, g.z);
      return 'gate';
    }
    if (this.zone && (this.stage === 'park' || t?.kind === 'zone')) {
      out.set(this.zone.x, 0, this.zone.z);
      return 'zone';
    }
    return null;
  }

  /** Text for the mission HUD. */
  hud(inCar: boolean): MissionHud | null {
    const level = this.level;
    if (!level || this.isFreeRoam) return null;
    const info: string[] = [];
    let objective = '';
    const t = this.task;
    if (!inCar && this.stage !== 'done') objective = this.hasEntered ? 'Get back in your car' : level.race ? 'Get in your car on the grid' : 'Find your car and get in';
    else if (this.stage === 'countdown') objective = 'Get ready…';
    else if (this.stage === 'drive' && t) {
      objective = t.kind === 'zone' && this.zoneInside ? 'Hold still…' : this.policeTooClose ? 'Police too close — lose them first!' : t.text;
    } else if (this.stage === 'drive') {
      if (level.race) objective = level.race.requiredPosition === 1 ? 'Win the race' : `Finish in the top ${level.race.requiredPosition}`;
      else if (level.kind === 'tutorial') objective = 'Drive to the marked parking bay';
      else if (level.drift) objective = 'Drift through the hairpins';
      else if (level.speed) objective = this.sectionIndex >= 0 ? 'Keep your speed up!' : 'Drive through the next checkpoint';
      else objective = this.gates[this.nextGate]?.slalom ? 'Weave through the slalom gates' : 'Drive through the next checkpoint';
    } else if (this.stage === 'park') objective = this.zoneInside ? 'Hold still…' : 'Park inside the marked bay and stop';

    if (level.tasks) {
      info.push(`Step ${Math.min(this.taskIndex + 1, level.tasks.length)}/${level.tasks.length}`);
      const f = this.taskFraction();
      if (f !== null && t?.kind === 'reverse') info.push(`Reversed ${(f * t.metres).toFixed(1)} / ${t.metres} m`);
      if (f !== null && t?.kind === 'handbrake') info.push(`Turned ${Math.round(f * t.degrees)}° / ${t.degrees}°`);
      if (t?.kind === 'gates') info.push(`Gate ${Math.min(this.nextGate, this.taskGateEnd) - (this.taskGateEnd - t.count)}/${t.count}`);
    } else if (this.gates.length) {
      if (this.laps > 1) info.push(`Lap ${this.lap}/${this.laps}`);
      const per = this.perLap || this.gates.length;
      info.push(`Checkpoint ${Math.min(this.nextGate - (this.lap - 1) * per, per)}/${per}`);
    }
    if (level.penalties) info.push(`Penalties +${this.penaltyTime}s · Strikes ${this.strikes}/${level.penalties.maxStrikes}`);
    else if (level.redLight && this.penaltyTime > 0) info.push(`Penalties +${this.penaltyTime}s`);
    const live = this.sectionLive();
    if (live) info.push(`Section ${live.index + 1}: ${Math.round(live.avg)} / ${live.target} km/h`);
    if (level.drift) {
      info.push(`Drift score ${fmtInt(this.driftScore)} / ${fmtInt(level.drift.target)}`);
      if (this.driftChain > 0) info.push(`Drift +${fmtInt(this.driftChain)}  x${this.driftMultiplier}`);
    }
    if (level.cargo) info.push(this.cargoLoaded ? `Cargo ${Math.round(this.cargo)}%` : 'Cargo: not loaded');
    const pos = this.playerPosition();
    if (pos !== null && (this.stage === 'drive' || this.stage === 'done')) info.push(`Position ${pos}/${this.racers.length + 1}`);

    let timer: string | null = null;
    let warn = false;
    if (level.timeLimit) {
      const remaining = level.timeLimit - this.elapsed;
      timer = formatTime(remaining);
      warn = this.clockRunning && remaining < 10;
    } else if (this.clockRunning || this.elapsed > 0) timer = formatTime(this.elapsed);
    return { title: level.title, objective, timer, timerWarning: warn, info };
  }
}
