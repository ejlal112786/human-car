import { ROAD } from '../config';
import type { Track } from '../world/Track';

/**
 * Directed lane graph built from the road network.
 *
 * Every lane is a chain of waypoint nodes (~4 m apart). Each node knows its successor in the
 * driving direction and its left / right neighbour in the same direction (lane-change edges),
 * plus metadata the traffic AI needs: a comfortable speed for the bend, whether something
 * static blocks the lane there, and which signal's stop line (if any) sits at the node.
 *
 * The city currently has one closed four-lane circuit (two lanes each way), so every node has a
 * single successor; the representation (explicit successor/neighbour indices) does not assume that.
 * All data lives in typed arrays: no per-frame allocation when querying it.
 */
export interface LaneDef {
  /** Lateral offset of the lane centre from the road centre line (m, + = right of the track direction). */
  offset: number;
  /** +1 = travels with increasing track index, -1 = against it. */
  dir: 1 | -1;
}

/** Right-hand traffic: lanes 0/1 drive with the track direction, 2/3 against it. Inner lanes first. */
export const LANES: readonly LaneDef[] = [
  { offset: ROAD.laneWidth * 0.5, dir: 1 },
  { offset: ROAD.laneWidth * 1.5, dir: 1 },
  { offset: -ROAD.laneWidth * 0.5, dir: -1 },
  { offset: -ROAD.laneWidth * 1.5, dir: -1 },
];

/** Samples between consecutive nodes of a lane. */
export const NODE_STRIDE = 2;
/** Comfortable lateral acceleration used for bend speeds (m/s²). */
const COMFORT_LAT_ACCEL = 2.6;
/** Default urban speed limit (m/s, 50 km/h). */
export const CITY_SPEED = 13.9;

export interface StaticBlocker {
  x: number;
  z: number;
  /** Footprint radius (m). */
  radius: number;
}

export class LaneGraph {
  readonly nodeCount: number;
  readonly perLane: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Unit driving direction at the node. */
  readonly dx: Float32Array;
  readonly dz: Float32Array;
  readonly lane: Uint8Array;
  /** Track sample index of the node. */
  readonly trackIdx: Uint16Array;
  readonly next: Int32Array;
  readonly left: Int32Array;
  readonly right: Int32Array;
  /** Distance to the successor (m). */
  readonly segLen: Float32Array;
  /** Comfortable speed (m/s) at the node. */
  readonly speed: Float32Array;
  /** 1 if a static obstacle occupies this lane near the node. */
  readonly blocked: Uint8Array;
  /** Signal index whose stop line is at this node, or -1. */
  readonly stopLine: Int16Array;
  /** 1 inside a crossing (no lane changes, never stop here). */
  readonly crossing: Uint8Array;

  constructor(
    readonly track: Track,
    blockers: readonly StaticBlocker[] = [],
  ) {
    const perLane = Math.floor(track.count / NODE_STRIDE);
    this.perLane = perLane;
    const n = perLane * LANES.length;
    this.nodeCount = n;
    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    this.dx = new Float32Array(n);
    this.dz = new Float32Array(n);
    this.lane = new Uint8Array(n);
    this.trackIdx = new Uint16Array(n);
    this.next = new Int32Array(n);
    this.left = new Int32Array(n).fill(-1);
    this.right = new Int32Array(n).fill(-1);
    this.segLen = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    this.stopLine = new Int16Array(n).fill(-1);
    this.crossing = new Uint8Array(n);

    const curvature = this.curvatureTable();
    for (let l = 0; l < LANES.length; l++) {
      const { offset, dir } = LANES[l];
      for (let k = 0; k < perLane; k++) {
        const id = l * perLane + k;
        // Lanes driving against the track direction walk the samples backwards.
        const slot = dir > 0 ? k : (perLane - k) % perLane;
        const i = slot * NODE_STRIDE;
        this.trackIdx[id] = i;
        this.lane[id] = l;
        this.x[id] = track.px[i] + track.rx(i) * offset;
        this.z[id] = track.pz[i] + track.rz(i) * offset;
        this.dx[id] = track.tx[i] * dir;
        this.dz[id] = track.tz[i] * dir;
        this.next[id] = l * perLane + ((k + 1) % perLane);
        this.speed[id] = Math.min(CITY_SPEED, Math.sqrt(COMFORT_LAT_ACCEL / Math.max(curvature[i], 1e-4)));
      }
    }
    for (let id = 0; id < n; id++) {
      const nx = this.next[id];
      this.segLen[id] = Math.hypot(this.x[nx] - this.x[id], this.z[nx] - this.z[id]);
    }
    // Lane-change edges between same-direction lanes at the same track sample.
    for (let k = 0; k < perLane; k++) {
      this.link(0 * perLane + k, 1 * perLane + k); // fwd: lane 0 (inner) is left of lane 1
      this.link(2 * perLane + k, 3 * perLane + k); // rev: lane 2 (inner) is left of lane 3
    }
    // Look ahead a few nodes when slowing for bends so cars brake before them, not in them.
    const tmp = new Float32Array(n);
    for (let id = 0; id < n; id++) {
      let v = this.speed[id];
      let j = id;
      let d = 0;
      for (let s = 0; s < 8; s++) {
        d += this.segLen[j];
        j = this.next[j];
        v = Math.min(v, Math.sqrt(this.speed[j] * this.speed[j] + 2 * 2.0 * d));
      }
      tmp[id] = v;
    }
    this.speed.set(tmp);
    for (const b of blockers) this.markBlocked(b);
  }

  private link(leftId: number, rightId: number): void {
    this.right[leftId] = rightId;
    this.left[rightId] = leftId;
  }

  private curvatureTable(): Float32Array {
    const t = this.track;
    const n = t.count;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = Math.atan2(t.tz[i], t.tx[i]);
      const b = Math.atan2(t.tz[j], t.tx[j]);
      raw[i] = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) / t.spacing;
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = -3; d <= 3; d++) s += raw[(i + d + n) % n];
      out[i] = s / 7;
    }
    return out;
  }

  /** Node id for (lane, track sample) — the node at or just behind the sample in driving direction. */
  nodeAt(lane: number, trackIndex: number): number {
    const t = this.track;
    const i = ((Math.round(trackIndex) % t.count) + t.count) % t.count;
    const slot = Math.floor(i / NODE_STRIDE) % this.perLane;
    const k = LANES[lane].dir > 0 ? slot : (this.perLane - slot) % this.perLane;
    return lane * this.perLane + k;
  }

  /** Signed lateral offset of (x, z) relative to the road centre at track sample i. */
  lateral(i: number, x: number, z: number): number {
    const t = this.track;
    return (x - t.px[i]) * t.rx(i) + (z - t.pz[i]) * t.rz(i);
  }

  /** Lane whose area contains the lateral offset, or -1 off the carriageway. */
  static laneForOffset(lat: number): number {
    if (lat >= 0 && lat < ROAD.laneWidth) return 0;
    if (lat >= ROAD.laneWidth && lat <= ROAD.halfWidth) return 1;
    if (lat < 0 && lat > -ROAD.laneWidth) return 2;
    if (lat <= -ROAD.laneWidth && lat >= -ROAD.halfWidth) return 3;
    return -1;
  }

  /** Mark nodes of every lane the blocker intrudes on (car half-width + clearance). */
  private markBlocked(b: StaticBlocker): void {
    const i = this.track.nearestIndex(b.x, b.z);
    const lat = this.lateral(i, b.x, b.z);
    if (Math.abs(lat) > ROAD.halfWidth + 1) return;
    for (let l = 0; l < LANES.length; l++) {
      if (Math.abs(lat - LANES[l].offset) > 0.9 + b.radius + 0.35) continue;
      // Block ~8 m either side of the obstacle.
      for (let d = -4; d <= 4; d++) this.blocked[this.nodeAt(l, i + d)] = 1;
    }
  }

  /** Mark the crossing area and the stop lines of a signalised crossing at track sample `i`. */
  addCrossing(i: number, signal: number, halfLengthSamples: number, stopBackSamples: number): void {
    for (let l = 0; l < LANES.length; l++) {
      const dir = LANES[l].dir;
      for (let d = -halfLengthSamples; d <= halfLengthSamples; d++) this.crossing[this.nodeAt(l, i + d)] = 1;
      // Stop line before the crossing in this lane's driving direction.
      this.stopLine[this.nodeAt(l, i - dir * (halfLengthSamples + stopBackSamples))] = signal;
    }
  }

  /** Along-lane distance from node a forward to node b on the same lane (m); Infinity if other lane. */
  forwardDistance(a: number, b: number): number {
    if (this.lane[a] !== this.lane[b]) return Infinity;
    const pl = this.perLane;
    const ka = a % pl;
    const kb = b % pl;
    const steps = (kb - ka + pl) % pl;
    return steps * (this.track.length / pl);
  }
}
