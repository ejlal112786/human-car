/**
 * Explicit game state machine.
 *
 *   menu      – title / missions / garage / settings screens (showcase camera)
 *   briefing  – mission briefing (world loaded, simulation frozen)
 *   onFoot    – the character controller runs, the car is parked
 *   entering  – scripted walk to the door + fade (no player control)
 *   driving   – the vehicle controller runs, the character is hidden and disabled
 *   exiting   – scripted fade-in next to the car (no player control)
 *   paused    – remembers the state to resume
 *   complete / failed – mission result screens
 *
 * Every transition is checked against the table below; an illegal request is refused
 * (and reported in development builds) instead of leaving the game half-switched.
 */
export type GameStateName = 'menu' | 'briefing' | 'onFoot' | 'entering' | 'driving' | 'exiting' | 'paused' | 'complete' | 'failed';

const ALLOWED: Record<GameStateName, readonly GameStateName[]> = {
  menu: ['briefing', 'onFoot', 'menu'],
  briefing: ['onFoot', 'menu'],
  onFoot: ['entering', 'paused', 'complete', 'failed', 'menu', 'onFoot'],
  entering: ['driving', 'paused', 'failed', 'onFoot', 'menu'],
  driving: ['exiting', 'paused', 'complete', 'failed', 'menu', 'onFoot'],
  exiting: ['onFoot', 'paused', 'failed', 'menu'],
  paused: ['onFoot', 'entering', 'driving', 'exiting', 'menu', 'briefing'],
  complete: ['briefing', 'onFoot', 'menu'],
  failed: ['onFoot', 'menu'],
};

/** States in which the simulation advances. */
export const SIMULATING: ReadonlySet<GameStateName> = new Set(['onFoot', 'entering', 'driving', 'exiting']);

export class GameStateMachine {
  private current: GameStateName = 'menu';
  /** State to return to when unpausing. */
  private resumeTo: GameStateName | null = null;
  /** Seconds (sim time) spent in the current state. */
  time = 0;
  private readonly listeners: Array<(to: GameStateName, from: GameStateName) => void> = [];

  get state(): GameStateName {
    return this.current;
  }

  get resumeState(): GameStateName | null {
    return this.resumeTo;
  }

  get simulating(): boolean {
    return SIMULATING.has(this.current);
  }

  is(...names: GameStateName[]): boolean {
    return names.includes(this.current);
  }

  can(to: GameStateName): boolean {
    if (this.current === 'paused' && (to === 'onFoot' || to === 'driving' || to === 'entering' || to === 'exiting')) {
      // Unpausing may only return to where we were — except restart, which always lands on foot.
      return to === this.resumeTo || to === 'onFoot';
    }
    return ALLOWED[this.current].includes(to);
  }

  /** Attempt a transition; returns false (and changes nothing) if it is not allowed. */
  go(to: GameStateName): boolean {
    if (!this.can(to)) {
      if (import.meta.env.DEV) console.warn(`[state] refused ${this.current} → ${to}`);
      return false;
    }
    const from = this.current;
    if (to === 'paused') this.resumeTo = from;
    else if (from === 'paused') this.resumeTo = null;
    this.current = to;
    this.time = 0;
    for (const l of this.listeners) l(to, from);
    return true;
  }

  onChange(l: (to: GameStateName, from: GameStateName) => void): void {
    this.listeners.push(l);
  }
}
