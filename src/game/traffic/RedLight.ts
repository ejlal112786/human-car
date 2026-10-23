import { CROSSINGS, CROSS_HALF, STOP_BACK } from '../world/Crossings';
import type { Track } from '../world/Track';
import type { TrafficSignals } from './TrafficSignals';

/**
 * Detects the player's car crossing a junction stop line, in its direction of travel, while that
 * signal shows red. Shared by the police (offences) and the traffic missions (penalties).
 */
export class RedLightDetector {
  private prevIdx = -1;

  reset(): void {
    this.prevIdx = -1;
  }

  /** Call once per fixed step while driving; returns true when a red light was run this step. */
  update(track: Track, signals: TrafficSignals, idx: number, x: number, z: number, speed: number, inCar: boolean): boolean {
    if (!inCar) {
      this.prevIdx = -1;
      return false;
    }
    const n = track.count;
    const prev = this.prevIdx;
    this.prevIdx = idx;
    if (prev < 0 || speed <= 5) return false;
    const step = ((((idx - prev) % n) + n + n / 2) % n) - n / 2;
    if (step === 0 || Math.abs(step) >= 12) return false;
    const dir = step > 0 ? 1 : -1;
    const lat = (x - track.px[idx]) * track.rx(idx) + (z - track.pz[idx]) * track.rz(idx);
    if (Math.abs(lat) >= 7) return false;
    let ran = false;
    CROSSINGS.forEach((c, k) => {
      const line = (((c - dir * (CROSS_HALF + STOP_BACK)) % n) + n) % n;
      // Did we pass `line` going in `dir` this step?
      const a = ((((line - prev) * dir) % n) + n) % n;
      if (a > 0 && a <= Math.abs(step) && signals.car(k) === 'red') ran = true;
    });
    return ran;
  }
}
