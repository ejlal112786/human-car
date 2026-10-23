/**
 * Arrest sequence (pure state machine; the game moves the characters and shows the UI).
 *
 *   idle ─begin()→ surrender ─→ cuffed ─→ escort ─→ transfer ─→ done ─reset()→ idle
 *
 *   surrender – officers close in with sidearms drawn. In a car: "get out" (E), forced after
 *               EXIT_FORCE s; if the player can't get out (no room) the sequence goes straight to
 *               the transfer after SURRENDER_MAX s. On foot: hands up (at least SURRENDER_MIN s)
 *               until an officer is at arm's length.
 *   cuffed    – short beat with the officer next to the player.
 *   escort    – the officer walks the player to the back door of the police car.
 *   transfer  – fade + arrest summary; skippable after TRANSFER_MIN s, automatic after TRANSFER_MAX s.
 *
 * Every phase has a hard time limit, so the sequence always ends (never stuck), and begin() is refused
 * unless idle, so a second bust can't restart or stack it.
 */

export type ArrestPhase = 'idle' | 'surrender' | 'cuffed' | 'escort' | 'transfer' | 'done';

export const EXIT_FORCE = 3;
export const SURRENDER_MAX = 7;
/** Hands up on foot for at least this long (s) before the cuffs, so the surrender is seen and never skipped. */
export const SURRENDER_MIN = 1.5;
export const CUFF_TIME = 1.2;
export const ESCORT_MAX = 10;
export const TRANSFER_MIN = 0.8;
export const TRANSFER_MAX = 7;
/** Officer distance (m) that counts as "at arm's length" for the cuffs. */
export const CUFF_RANGE = 2.2;

export interface ArrestSummary {
  stars: number;
  fine: number;
  /** What happened to the car used in the chase. */
  vehicle: { kind: 'own' | 'stolen' | 'none'; name: string; fee: number };
  bail: number;
}

export interface ArrestInput {
  inCar: boolean;
  /** Distance from the player to the nearest officer on foot (Infinity = none). */
  officerDist: number;
  /** The player has reached the police car door (escort). */
  atDoor: boolean;
  /** The player asked to skip the transfer. */
  skip: boolean;
}

export type ArrestEvent = 'forceExit' | 'cuffed' | 'escort' | 'transfer' | 'done';

export class ArrestSequence {
  phase: ArrestPhase = 'idle';
  /** Seconds in the current phase / since begin(). */
  t = 0;
  total = 0;
  summary: ArrestSummary | null = null;
  /** Arrests started (tests) and begin() calls refused because one was running. */
  started = 0;
  refused = 0;
  private exitAsked = false;
  /** Time on foot in the current phase (surrender: hands up). */
  private footT = 0;
  readonly events: ArrestEvent[] = [];

  get active(): boolean {
    return this.phase !== 'idle';
  }

  begin(summary: ArrestSummary): boolean {
    if (this.phase !== 'idle') {
      this.refused++;
      return false;
    }
    this.summary = summary;
    this.started++;
    this.total = 0;
    this.exitAsked = false;
    this.go('surrender');
    return true;
  }

  step(dt: number, inp: ArrestInput): void {
    if (this.phase === 'idle' || this.phase === 'done') return;
    this.t += dt;
    this.total += dt;
    switch (this.phase) {
      case 'surrender':
        if (inp.inCar) {
          if (!this.exitAsked && this.t >= EXIT_FORCE) {
            this.exitAsked = true;
            this.events.push('forceExit');
          }
          if (this.t >= SURRENDER_MAX) this.go('transfer');
        } else {
          this.footT += dt;
          if (this.footT >= SURRENDER_MIN && (inp.officerDist <= CUFF_RANGE || this.t >= SURRENDER_MAX)) this.go('cuffed');
        }
        break;
      case 'cuffed':
        if (this.t >= CUFF_TIME) this.go('escort');
        break;
      case 'escort':
        if (inp.atDoor || this.t >= ESCORT_MAX) this.go('transfer');
        break;
      case 'transfer':
        if ((inp.skip && this.t >= TRANSFER_MIN) || this.t >= TRANSFER_MAX) this.go('done');
        break;
    }
  }

  /** Back to idle (after the jail took over, or the level was left). */
  reset(): void {
    this.phase = 'idle';
    this.t = 0;
    this.summary = null;
    this.events.length = 0;
  }

  private go(p: ArrestPhase): void {
    this.phase = p;
    this.t = 0;
    this.footT = 0;
    if (p === 'cuffed' || p === 'escort' || p === 'transfer' || p === 'done') this.events.push(p);
  }
}
