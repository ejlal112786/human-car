import { ROAD, SIDEWALK_OUTER } from '../config';
import { mulberry32 } from './random';
import type { Track } from './Track';
import type { Weather } from './Weather';

/**
 * What a tyre is standing on: surface grip (including the road's wetness), extra rolling drag and standing
 * water depth (puddles) at a point. The city has one road network (the track ribbon) with kerbs and
 * pavements; everything else a car can reach is grass.
 */
export type SurfaceKind = 'road' | 'pavement' | 'grass';

export interface SurfaceSample {
  kind: SurfaceKind;
  /** Friction factor of the surface (1 = dry asphalt). */
  grip: number;
  /** Rolling-resistance factor (1 = asphalt). */
  drag: number;
  /** Standing water depth factor 0..1 (a puddle × how full the puddles are). */
  water: number;
}

/** Used by VehiclePhysics; `hint` is a per-wheel cache of the nearest track sample. */
export interface SurfaceProvider {
  sample(x: number, z: number, hint: { idx: number }, out: SurfaceSample): void;
  readonly wetness: number;
  /** Air temperature (°C) for the tyres. */
  readonly ambient: number;
}

/** Dry friction and the share lost when soaked, per surface (wet asphalt ≈ 0.7 of dry; wet grass is poor). */
export const SURFACE_GRIP: Record<SurfaceKind, { dry: number; wetLoss: number; drag: number }> = {
  road: { dry: 1, wetLoss: 0.28, drag: 1 },
  pavement: { dry: 0.95, wetLoss: 0.32, drag: 1.1 },
  grass: { dry: 0.55, wetLoss: 0.25, drag: 5 },
};

export interface Puddle {
  x: number;
  z: number;
  /** Track sample it lies on. */
  idx: number;
  /** Half-length along the road / half-width across (m) and the road direction. */
  a: number;
  b: number;
  tx: number;
  tz: number;
  depth: number;
}

/** Puddles sit in the wheel tracks of the lanes, in hollows along the road (seeded: the same every run). */
export function makePuddles(track: Track, count = 44, seed = 7319): Puddle[] {
  const rnd = mulberry32(seed);
  const out: Puddle[] = [];
  const n = track.count;
  for (let k = 0; k < count; k++) {
    const idx = Math.floor(((k + rnd() * 0.8) / count) * n) % n;
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = side * (1.2 + rnd() * (ROAD.halfWidth - 2.4));
    const rx = track.rx(idx);
    const rz = track.rz(idx);
    out.push({
      x: track.px[idx] + rx * lat,
      z: track.pz[idx] + rz * lat,
      idx,
      a: 1.6 + rnd() * 2.2,
      b: 0.8 + rnd() * 0.9,
      tx: track.tx[idx],
      tz: track.tz[idx],
      depth: 0.55 + rnd() * 0.45,
    });
  }
  return out.sort((p, q) => p.idx - q.idx);
}

export class GripField implements SurfaceProvider {
  readonly puddles: Puddle[];

  constructor(
    private readonly track: Track,
    private readonly weather: Weather,
    puddles?: Puddle[],
  ) {
    this.puddles = puddles ?? makePuddles(track);
  }

  get wetness(): number {
    return this.weather.wetness;
  }

  get ambient(): number {
    return 20 - 7 * this.weather.rain - 6 * this.weather.fog;
  }

  sample(x: number, z: number, hint: { idx: number }, out: SurfaceSample): void {
    const t = this.track;
    const idx = hint.idx >= 0 ? t.trackIndex(x, z, hint.idx, 12) : t.nearestIndex(x, z);
    hint.idx = idx;
    const d = Math.hypot(x - t.px[idx], z - t.pz[idx]);
    const kind: SurfaceKind = d <= ROAD.halfWidth ? 'road' : d <= SIDEWALK_OUTER + 0.3 ? 'pavement' : 'grass';
    const s = SURFACE_GRIP[kind];
    const w = this.weather.wetness;
    out.kind = kind;
    out.grip = s.dry * (1 - s.wetLoss * w);
    out.drag = s.drag;
    out.water = 0;
    const fill = this.weather.puddles;
    if (kind === 'road' && fill > 0.01) out.water = this.puddleDepth(x, z, idx) * fill;
  }

  /** Depth factor of the puddle at (x, z) (0 outside), looking only at puddles near track sample idx. */
  puddleDepth(x: number, z: number, idx: number): number {
    const P = this.puddles;
    const n = this.track.count;
    let best = 0;
    // Puddles are sorted by idx; a few dozen, so a short scan of the neighbourhood is enough.
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      let di = Math.abs(p.idx - idx);
      if (di > n / 2) di = n - di;
      if (di > 4) continue;
      const dx = x - p.x;
      const dz = z - p.z;
      const u = (dx * p.tx + dz * p.tz) / p.a;
      const v = (dx * -p.tz + dz * p.tx) / p.b;
      const r2 = u * u + v * v;
      if (r2 < 1) best = Math.max(best, p.depth * (1 - r2 * 0.5));
    }
    return best;
  }
}
