/**
 * Navigation core (pure, no rendering): points of interest, routing along the road network and
 * arrival detection. The city's drivable network is one closed loop (with junctions and crossings
 * on it), so a route is "follow the loop forwards or backwards" — whichever is shorter, with
 * hysteresis so the suggestion does not flip-flop near the half-way point.
 */
import type { LevelDef } from '../missions/Levels';
import type { Track } from '../world/Track';

export type PoiKind = 'mission' | 'garage' | 'event' | 'impound';

export interface Poi {
  id: string;
  kind: PoiKind;
  /** Short label for map and HUD. */
  label: string;
  /** Longer description for the map list. */
  detail: string;
  /** Road sample and lateral offset of the marker. */
  i: number;
  off: number;
  x: number;
  z: number;
  /** Mission / event index this POI starts (if any). */
  index: number;
}

/** The city garage (repairs, cars, upgrades): pavement bay on the right of sample 540. */
export const GARAGE_SPOT = { i: 540, off: 9.4 } as const;
/**
 * Police impound lot: pavement office on the right of sample 292 (a straight stretch away from crossings,
 * mission starts and the garage); impounded cars stand at the kerb ~10 m before it (carI / carOff, where
 * parked cars stand), released prisoners are let out a few metres up the street (releaseI).
 */
export const IMPOUND_SPOT = { i: 292, off: 9.4, carI: 287, carOff: 6.0, releaseI: 297 } as const;
/** Within this distance (m, horizontal) of a POI the player has arrived. */
export const ARRIVE_RADIUS = 9;

export function poiPosition(track: Track, i: number, off: number): { x: number; z: number } {
  const k = ((Math.round(i) % track.count) + track.count) % track.count;
  return { x: track.px[k] + track.rx(k) * off, z: track.pz[k] + track.rz(k) * off };
}

export function buildPois(track: Track, levels: readonly LevelDef[], events: ReadonlyArray<{ id: string; title: string; detail: string; i: number; off: number }> = []): Poi[] {
  const pois: Poi[] = [];
  levels.forEach((lv, k) => {
    const off = Math.sign(lv.playerStart.off || 1) * 7.9;
    const p = poiPosition(track, lv.playerStart.i, off);
    pois.push({ id: `mission-${k}`, kind: 'mission', label: `Mission ${k + 1}`, detail: lv.title, i: lv.playerStart.i, off, ...p, index: k });
  });
  const g = poiPosition(track, GARAGE_SPOT.i, GARAGE_SPOT.off);
  pois.push({ id: 'garage', kind: 'garage', label: 'Garage', detail: 'Cars, upgrades, paint and repairs', i: GARAGE_SPOT.i, off: GARAGE_SPOT.off, ...g, index: -1 });
  const im = poiPosition(track, IMPOUND_SPOT.i, IMPOUND_SPOT.off);
  pois.push({ id: 'impound', kind: 'impound', label: 'Impound lot', detail: 'Police impound: recover confiscated cars', i: IMPOUND_SPOT.i, off: IMPOUND_SPOT.off, ...im, index: -1 });
  events.forEach((e, k) => {
    const p = poiPosition(track, e.i, e.off);
    pois.push({ id: e.id, kind: 'event', label: e.title, detail: e.detail, i: e.i, off: e.off, ...p, index: k });
  });
  return pois;
}

export interface RoutePlan {
  /** +1 = along increasing sample index, −1 = decreasing. */
  dir: 1 | -1;
  /** Number of road samples to travel. */
  steps: number;
  /** Route length along the road (m). */
  meters: number;
}

/**
 * Shortest way round the loop from sample `from` to sample `to`. `prevDir` keeps the previous
 * choice unless the other way is clearly (≥ 8 %, ≥ 20 m) shorter.
 */
export function planRoute(track: Track, from: number, to: number, prevDir: 1 | -1 | 0 = 0): RoutePlan {
  const n = track.count;
  const fwd = (((to - from) % n) + n) % n;
  const back = (n - fwd) % n;
  const ds = track.length / n;
  let dir: 1 | -1 = fwd <= back ? 1 : -1;
  if (prevDir !== 0 && prevDir !== dir) {
    const keep = prevDir === 1 ? fwd : back;
    const other = prevDir === 1 ? back : fwd;
    if ((keep - other) * ds < Math.max(20, keep * ds * 0.08)) dir = prevDir;
  }
  const steps = dir === 1 ? fwd : back;
  return { dir, steps, meters: steps * ds };
}

/**
 * Route polyline (x,z pairs) from the player's position along the road to the POI.
 * Writes into `out` (reused) and returns the number of points. Samples are thinned to every
 * `stride` road samples to keep drawing cheap.
 */
export function routePolyline(track: Track, x: number, z: number, from: number, plan: RoutePlan, poi: Poi, out: Float32Array, stride = 3): number {
  let n = 0;
  const cap = out.length >> 1;
  const push = (px: number, pz: number): void => {
    if (n >= cap) return;
    out[n * 2] = px;
    out[n * 2 + 1] = pz;
    n++;
  };
  push(x, z);
  const count = track.count;
  // Keep the route on the player's side of the road (lane centre at ±5.25 / pavement for POIs).
  const lane = plan.dir === 1 ? 3.5 : -3.5;
  for (let s = stride; s < plan.steps; s += stride) {
    const k = (((from + plan.dir * s) % count) + count) % count;
    push(track.px[k] + track.rx(k) * lane, track.pz[k] + track.rz(k) * lane);
  }
  push(poi.x, poi.z);
  return n;
}

/**
 * Direction hint: is the route ahead of the vehicle or behind it?
 * `fx, fz` = forward vector of the player (car or character).
 */
export function routeHeading(track: Track, from: number, plan: RoutePlan, fx: number, fz: number): 'ahead' | 'behind' {
  const k = ((from % track.count) + track.count) % track.count;
  const dot = (track.tx[k] * fx + track.tz[k] * fz) * plan.dir;
  return dot >= -0.2 ? 'ahead' : 'behind';
}

/** Horizontal distance to a POI. */
export function poiDistance(poi: Poi, x: number, z: number): number {
  return Math.hypot(poi.x - x, poi.z - z);
}

/** Nearest POI within `radius` (or null). */
export function poiAt(pois: readonly Poi[], x: number, z: number, radius = ARRIVE_RADIUS): Poi | null {
  let best: Poi | null = null;
  let bd = radius;
  for (const p of pois) {
    const d = poiDistance(p, x, z);
    if (d <= bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
