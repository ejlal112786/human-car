import { mulberry32 } from './random';

/**
 * Weather simulation (no rendering): cloud cover, rain and fog blend towards the current weather, the road
 * gets wet while it rains and dries afterwards, and puddles fill once the road is soaked. In dynamic mode the
 * weather changes every few minutes (seeded, so a run is reproducible). Everything runs on the fixed step.
 */
export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'storm', 'fog'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
export type WeatherMode = 'dynamic' | WeatherKind;
export const WEATHER_MODES: readonly WeatherMode[] = ['dynamic', ...WEATHER_KINDS];

export const WEATHER_NAME: Record<WeatherKind, string> = {
  clear: 'Clear',
  cloudy: 'Overcast',
  rain: 'Rain',
  storm: 'Heavy rain',
  fog: 'Fog',
};

/** Target cloud cover / rain intensity / fog density (0..1) per weather. */
const TARGET: Record<WeatherKind, { cloud: number; rain: number; fog: number }> = {
  clear: { cloud: 0.08, rain: 0, fog: 0 },
  cloudy: { cloud: 0.75, rain: 0, fog: 0.08 },
  rain: { cloud: 0.88, rain: 0.55, fog: 0.2 },
  storm: { cloud: 1, rain: 1, fog: 0.32 },
  fog: { cloud: 0.6, rain: 0, fog: 1 },
};

/** Dynamic mode: which weather may follow which (weights). */
const NEXT: Record<WeatherKind, Array<[WeatherKind, number]>> = {
  clear: [['clear', 2], ['cloudy', 3], ['fog', 1]],
  cloudy: [['clear', 2], ['rain', 3], ['cloudy', 1], ['fog', 1]],
  rain: [['cloudy', 2], ['storm', 2], ['rain', 1]],
  storm: [['rain', 3], ['cloudy', 1]],
  fog: [['clear', 2], ['cloudy', 2]],
};

/** Seconds of steady weather in dynamic mode before the next change (min, max); the first change waits FIRST_CHANGE_S. */
const HOLD_S: [number, number] = [150, 300];
export const FIRST_CHANGE_S = 300;
/** Time constant (s) with which cloud / rain / fog follow the target. */
const BLEND_S = 25;
/** Rain 1 soaks a dry road in ~WET_S seconds; a wet road dries in ~DRY_S once the rain stops. */
const WET_S = 30;
const DRY_S = 160;

export class Weather {
  mode: WeatherMode = 'dynamic';
  kind: WeatherKind = 'clear';
  cloud = TARGET.clear.cloud;
  rain = 0;
  fog = 0;
  /** Road water film 0 (dry) … 1 (soaked). */
  wetness = 0;
  /** Puddle fill 0 … 1 (lags behind the wetness). */
  puddles = 0;
  /** Seconds until the next dynamic change. */
  private hold = FIRST_CHANGE_S;
  private rnd: () => number;

  constructor(seed = 20261021) {
    this.rnd = mulberry32(seed);
  }

  /** Restart the random sequence (the QA test hook uses a fixed seed so automated runs are reproducible). */
  reseed(seed: number): void {
    this.rnd = mulberry32(seed);
  }

  /** Apply a settings choice. A fixed weather takes over smoothly; `instant` jumps straight to it (new session / tests). */
  setMode(mode: WeatherMode, instant = false): void {
    this.mode = mode;
    if (mode !== 'dynamic') this.kind = mode;
    else if (instant) this.kind = 'clear';
    if (instant) this.snap();
    if (mode === 'dynamic') this.hold = FIRST_CHANGE_S;
  }

  /** Jump to the current weather's steady state (road wet if it is raining). */
  snap(): void {
    const t = TARGET[this.kind];
    this.cloud = t.cloud;
    this.rain = t.rain;
    this.fog = t.fog;
    this.wetness = t.rain > 0 ? 1 : t.fog > 0.5 ? 0.25 : 0;
    this.puddles = t.rain > 0.3 ? 1 : 0;
  }

  update(dt: number): void {
    if (this.mode === 'dynamic') {
      this.hold -= dt;
      if (this.hold <= 0) {
        this.kind = this.pick(NEXT[this.kind]);
        this.hold = HOLD_S[0] + this.rnd() * (HOLD_S[1] - HOLD_S[0]);
      }
    }
    const t = TARGET[this.kind];
    const k = Math.min(1, dt / BLEND_S);
    this.cloud += (t.cloud - this.cloud) * k;
    this.rain += (t.rain - this.rain) * k;
    this.fog += (t.fog - this.fog) * k;
    if (Math.abs(this.rain - t.rain) < 1e-3) this.rain = t.rain;
    // Road water: rain wets it, otherwise it dries; fog keeps a damp film.
    const damp = 0.25 * this.fog;
    if (this.rain > 0.02) this.wetness = Math.min(1, this.wetness + (this.rain / WET_S) * dt);
    else this.wetness = Math.max(damp, this.wetness - dt / DRY_S);
    if (this.wetness < damp) this.wetness = Math.min(damp, this.wetness + dt / WET_S);
    // Puddles fill on a soaked road in steady rain and drain more slowly than the film dries.
    if (this.wetness > 0.6 && this.rain > 0.3) this.puddles = Math.min(1, this.puddles + dt / 40);
    else this.puddles = Math.max(0, this.puddles - dt / (DRY_S * 1.5));
  }

  /** Visibility distance factor (1 clear … ~0.3 in thick fog) for fog rendering and police sight. */
  get visibility(): number {
    return 1 - 0.7 * this.fog - 0.15 * this.rain;
  }

  private pick(options: Array<[WeatherKind, number]>): WeatherKind {
    const total = options.reduce((a, [, w]) => a + w, 0);
    let r = this.rnd() * total;
    for (const [k, w] of options) {
      r -= w;
      if (r <= 0) return k;
    }
    return options[options.length - 1][0];
  }
}
