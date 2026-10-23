/**
 * Signal controllers for the signalised pedestrian crossings.
 *
 * Each crossing runs the same fixed cycle (offset per crossing so they do not all switch together):
 *   cars GREEN → cars YELLOW → all red → pedestrians WALK → pedestrians FLASHING → all red → …
 * The state is a pure function of the controller clock, so it is deterministic and testable.
 */
export type CarLight = 'green' | 'yellow' | 'red';
export type PedLight = 'walk' | 'flash' | 'dont';

export const PHASES = {
  green: 14,
  yellow: 3,
  allRed1: 1.5,
  walk: 8,
  flash: 4,
  allRed2: 1.5,
} as const;
export const CYCLE = PHASES.green + PHASES.yellow + PHASES.allRed1 + PHASES.walk + PHASES.flash + PHASES.allRed2;

export class TrafficSignals {
  /** Controller clock (s). */
  time = 0;
  private readonly offsets: Float32Array;
  /** Bumped whenever any light changes (visuals re-sync only then). */
  version = 0;
  private readonly lastKey: Int8Array;

  constructor(readonly count: number) {
    this.offsets = new Float32Array(count);
    for (let k = 0; k < count; k++) this.offsets[k] = (k * 11.3) % CYCLE;
    this.lastKey = new Int8Array(count).fill(-1);
  }

  reset(): void {
    this.time = 0;
    this.lastKey.fill(-1);
    this.version++;
  }

  update(dt: number): void {
    this.time += dt;
    for (let k = 0; k < this.count; k++) {
      const key = this.phaseIndex(k);
      if (key !== this.lastKey[k]) {
        this.lastKey[k] = key;
        this.version++;
      }
    }
  }

  /** Race mode: the main road is held green and pedestrians wait (marshalled crossings). */
  held = false;

  setHeld(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    this.lastKey.fill(-1);
    this.version++;
  }

  /** Position in the cycle (s) for signal k. */
  private local(k: number): number {
    return (this.time + this.offsets[k]) % CYCLE;
  }

  /** 0 green, 1 yellow, 2 all-red, 3 walk, 4 flash, 5 all-red. */
  phaseIndex(k: number): number {
    if (this.held) return 0;
    let t = this.local(k);
    const seq = [PHASES.green, PHASES.yellow, PHASES.allRed1, PHASES.walk, PHASES.flash, PHASES.allRed2];
    for (let p = 0; p < seq.length; p++) {
      if (t < seq[p]) return p;
      t -= seq[p];
    }
    return 5;
  }

  car(k: number): CarLight {
    const p = this.phaseIndex(k);
    return p === 0 ? 'green' : p === 1 ? 'yellow' : 'red';
  }

  ped(k: number): PedLight {
    const p = this.phaseIndex(k);
    return p === 3 ? 'walk' : p === 4 ? 'flash' : 'dont';
  }

  /** Seconds until the car light of signal k next turns green (0 if green now). */
  untilCarGreen(k: number): number {
    if (this.held) return 0;
    const t = this.local(k);
    return t < PHASES.green ? 0 : CYCLE - t;
  }

  /** Seconds of walk phase remaining for signal k (0 if not walking). */
  walkRemaining(k: number): number {
    if (this.held) return 0;
    const t = this.local(k) - (PHASES.green + PHASES.yellow + PHASES.allRed1);
    return t >= 0 && t < PHASES.walk ? PHASES.walk - t : 0;
  }

  /** Test hook: jump the clock so signal k is at the start of phase p. */
  setPhase(k: number, p: number): void {
    const seq = [PHASES.green, PHASES.yellow, PHASES.allRed1, PHASES.walk, PHASES.flash, PHASES.allRed2];
    let start = 0;
    for (let q = 0; q < p; q++) start += seq[q];
    this.time = (((start + 0.01 - this.offsets[k]) % CYCLE) + CYCLE) % CYCLE;
    this.update(0);
  }
}
