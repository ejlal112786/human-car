/**
 * Wanted level and pursuit state machine (pure logic — no physics, no rendering).
 *
 *   clear    – nobody is looking for the player; offences witnessed by police raise heat
 *   pursuit  – a police unit is within SIGHT_RANGE; heat keeps rising slowly
 *   search   – no unit within SIGHT_RANGE; after SEARCH_TIME unseen the player has escaped
 *   busted   – the player was held (slow, close to a unit) for BUST_TIME; a fine is charged and
 *              the pursuit ends after a short hold
 *
 * Offences only count when witnessed (a unit within WITNESS_RANGE), except hitting a pedestrian,
 * which bystanders always report.
 */

export type PursuitState = 'clear' | 'pursuit' | 'search' | 'busted';
export type Offence =
  | 'redLight'
  | 'hitTraffic'
  | 'hitPedestrian'
  | 'hitPolice'
  | 'speeding'
  | 'gunfire'
  | 'assault'
  | 'carjack'
  | 'carTheft'
  | 'shootPolice'
  | 'impoundTheft';

export const MAX_STARS = 3;
export const WITNESS_RANGE = 90;
export const SIGHT_RANGE = 150;
export const SEARCH_TIME = 10;
export const BUST_RANGE = 8;
export const BUST_SPEED = 2;
export const BUST_TIME = 4;
export const FOOT_BUST_RANGE = 7;
export const FOOT_BUST_TIME = 3;
/** Seconds the busted state is held before everything resets. */
export const BUSTED_HOLD = 3;
/** Heat per offence. */
export const OFFENCE_HEAT: Record<Offence, number> = {
  redLight: 1,
  speeding: 1,
  hitTraffic: 1,
  hitPedestrian: 3,
  hitPolice: 2,
  gunfire: 2,
  assault: 3,
  carjack: 2,
  carTheft: 1,
  shootPolice: 4,
  impoundTheft: 4,
};
/** Offences that count even without a police witness (victims and bystanders call it in). */
export const ALWAYS_REPORTED: ReadonlySet<Offence> = new Set<Offence>(['hitPedestrian', 'assault', 'carjack', 'shootPolice', 'impoundTheft']);
/** Heat needed for 1 / 2 / 3 stars. */
export const STAR_HEAT = [1, 4, 8] as const;
/** Pursuit time per extra heat point (long chases escalate). */
export const ESCALATE_EVERY = 30;
/** Fine per star when busted (credits). */
export const FINE_PER_STAR = 250;

export interface WantedInput {
  /** Distance from the player to the nearest active police unit (Infinity = none). */
  nearestUnit: number;
  /** Player speed (m/s): car speed when driving, walking speed on foot. */
  playerSpeed: number;
  /** On foot: held when a unit stays within FOOT_BUST_RANGE for FOOT_BUST_TIME, whatever the speed. */
  onFoot?: boolean;
  /**
   * Line-of-sight override: whether any officer or unit can actually see the player (range AND a clear view).
   * Undefined = range only (nearestUnit <= SIGHT_RANGE), as in the headless tests.
   */
  seen?: boolean;
}

export interface WantedEvent {
  type: 'stars' | 'state' | 'escaped' | 'busted';
  stars: number;
  state: PursuitState;
}

export class WantedSystem {
  heat = 0;
  stars = 0;
  state: PursuitState = 'clear';
  /** Seconds since the last sighting (search) / spent held (bust) / in the current state. */
  unseen = 0;
  bustTimer = 0;
  stateTime = 0;
  private escalate = 0;
  /**
   * Busted resets to clear by itself after BUSTED_HOLD (Police Escape mission). Free roam turns this off: the
   * arrest sequence holds the busted state until it calls release(), so nothing can re-trigger mid-arrest.
   */
  autoRelease = true;
  /** Events since the last drain (UI toasts, audio). */
  readonly events: WantedEvent[] = [];

  /** Report an offence. Returns true when it counted (witnessed or always reported). */
  offence(o: Offence, nearestUnit: number): boolean {
    if (this.state === 'busted') return false;
    const witnessed = ALWAYS_REPORTED.has(o) || nearestUnit <= WITNESS_RANGE;
    if (!witnessed) return false;
    this.addHeat(OFFENCE_HEAT[o]);
    if (this.state === 'clear' && this.stars > 0) this.setState(nearestUnit <= SIGHT_RANGE ? 'pursuit' : 'search');
    return true;
  }

  /**
   * A witness phoned the police about the player (gunfire nobody in uniform saw). Clear record: one star
   * and the police come searching; already wanted: the search is refreshed. Returns true when it changed anything.
   */
  report(): boolean {
    if (this.state === 'busted') return false;
    if (this.stars === 0) this.addHeat(STAR_HEAT[0]);
    if (this.state === 'clear') {
      this.setState('search');
      this.unseen = 0;
      return true;
    }
    if (this.state === 'search') {
      this.unseen = 0;
      return true;
    }
    return false;
  }

  update(dt: number, inp: WantedInput): void {
    this.stateTime += dt;
    if (this.state === 'clear') return;
    if (this.state === 'busted') {
      if (this.autoRelease && this.stateTime >= BUSTED_HOLD) this.reset('clear');
      return;
    }
    const seen = inp.seen ?? inp.nearestUnit <= SIGHT_RANGE;
    // Being held: slow and right next to a unit.
    const held = inp.onFoot ? inp.nearestUnit <= FOOT_BUST_RANGE : inp.nearestUnit <= BUST_RANGE && inp.playerSpeed < BUST_SPEED;
    if (held) this.bustTimer += dt;
    else this.bustTimer = Math.max(0, this.bustTimer - dt * 2);
    if (this.bustTimer >= (inp.onFoot ? FOOT_BUST_TIME : BUST_TIME)) {
      const stars = this.stars;
      this.setState('busted');
      this.events.push({ type: 'busted', stars, state: 'busted' });
      return;
    }
    if (this.state === 'pursuit') {
      this.escalate += dt;
      if (this.escalate >= ESCALATE_EVERY) {
        this.escalate = 0;
        this.addHeat(1);
      }
      if (!seen) {
        this.setState('search');
        this.unseen = 0;
      }
    } else if (this.state === 'search') {
      if (seen) {
        this.setState('pursuit');
        return;
      }
      this.unseen += dt;
      if (this.unseen >= SEARCH_TIME) {
        const stars = this.stars;
        this.reset('clear');
        this.events.push({ type: 'escaped', stars, state: 'clear' });
      }
    }
  }

  /** End a held arrest (autoRelease off): record cleared. No-op unless busted. */
  release(): void {
    if (this.state === 'busted') this.reset('clear');
  }

  /** Start an active pursuit at `stars` (mission start). */
  force(stars: number): void {
    const s = Math.max(1, Math.min(MAX_STARS, Math.round(stars)));
    this.reset('clear');
    this.events.length = 0;
    this.addHeat(STAR_HEAT[s - 1]);
    this.setState('pursuit');
  }

  /** Fine for the stars held at the moment of the arrest. */
  static fine(stars: number, credits: number): number {
    return Math.max(0, Math.min(credits, stars * FINE_PER_STAR));
  }

  /** Units that should be chasing (one per star). */
  get unitsWanted(): number {
    return this.state === 'pursuit' || this.state === 'search' ? this.stars : 0;
  }

  reset(state: PursuitState = 'clear'): void {
    this.heat = 0;
    this.escalate = 0;
    this.bustTimer = 0;
    this.unseen = 0;
    const had = this.stars;
    this.stars = 0;
    if (had !== 0) this.events.push({ type: 'stars', stars: 0, state });
    this.setState(state);
  }

  private addHeat(h: number): void {
    this.heat += h;
    let s = 0;
    for (const t of STAR_HEAT) if (this.heat >= t) s++;
    s = Math.min(MAX_STARS, s);
    if (s !== this.stars) {
      this.stars = s;
      this.events.push({ type: 'stars', stars: s, state: this.state });
    }
  }

  private setState(s: PursuitState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateTime = 0;
    this.events.push({ type: 'state', stars: this.stars, state: s });
  }
}
