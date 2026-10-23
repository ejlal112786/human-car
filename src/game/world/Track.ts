import { CatmullRomCurve3, Vector3 } from 'three';
import { ROAD } from '../config';

/** Closed circuit control points (x, z) in metres. */
const CONTROL_POINTS: ReadonlyArray<readonly [number, number]> = [
  [90, 0],
  [190, 0],
  [265, -40],
  [300, -140],
  [262, -238],
  [150, -262],
  [62, -205],
  [-40, -222],
  [-160, -282],
  [-282, -222],
  [-306, -82],
  [-222, 18],
  [-262, 122],
  [-182, 222],
  [-44, 205],
  [34, 138],
  [14, 62],
  [34, 14],
];

/** Street names shown by the HUD location indicator, by fraction of the lap. */
const STREETS: ReadonlyArray<readonly [number, string]> = [
  [0.0, 'Portside · Harbor Ave'],
  [0.12, 'Portside · Eastgate Curve'],
  [0.22, 'Portside · Foundry St'],
  [0.31, 'Market District · Foundry St'],
  [0.36, 'Market District · Market Blvd'],
  [0.5, 'Market District · Westline Dr'],
  [0.62, 'Old Quarter · Old Mill Bend'],
  [0.74, 'Old Quarter · Parkside Rd'],
  [0.86, 'Old Quarter · Station Hill'],
  [0.95, 'Portside · Harbor Ave'],
];

/**
 * The drivable road centre line, sampled at roughly uniform arc-length spacing.
 * Provides fast proximity queries used by world generation, the minimap and the HUD.
 */
export class Track {
  readonly curve: CatmullRomCurve3;
  readonly length: number;
  readonly count: number;
  /** Sample positions and unit tangents in the XZ plane. */
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Distance along the centre line for each sample. */
  readonly dist: Float32Array;
  readonly spacing: number;

  constructor(spacing = 2) {
    const pts = CONTROL_POINTS.map(([x, z]) => new Vector3(x, 0, z));
    this.curve = new CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    this.count = Math.max(16, Math.round(this.length / spacing));
    this.spacing = this.length / this.count;
    this.px = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.tx = new Float32Array(this.count);
    this.tz = new Float32Array(this.count);
    this.dist = new Float32Array(this.count);
    const p = new Vector3();
    const t = new Vector3();
    for (let i = 0; i < this.count; i++) {
      const u = i / this.count;
      this.curve.getPointAt(u, p);
      this.curve.getTangentAt(u, t);
      t.y = 0;
      t.normalize();
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.tx[i] = t.x;
      this.tz[i] = t.z;
      this.dist[i] = u * this.length;
    }
  }

  /** Right-hand normal (x component) at sample i. */
  rx(i: number): number {
    return -this.tz[i];
  }
  /** Right-hand normal (z component) at sample i. */
  rz(i: number): number {
    return this.tx[i];
  }

  /** Brute-force nearest sample (used at build time). */
  nearestIndex(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Approximate distance from (x, z) to the centre line. */
  distanceTo(x: number, z: number): number {
    const i = this.nearestIndex(x, z);
    return this.distanceToSegmentNear(i, x, z);
  }

  private distanceToSegmentNear(i: number, x: number, z: number): number {
    let best = Infinity;
    for (const j of [i - 1, i]) {
      const a = (j + this.count) % this.count;
      const b = (a + 1) % this.count;
      const ax = this.px[a];
      const az = this.pz[a];
      const bx = this.px[b] - ax;
      const bz = this.pz[b] - az;
      const len2 = bx * bx + bz * bz;
      let k = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0;
      k = Math.max(0, Math.min(1, k));
      const dx = ax + bx * k - x;
      const dz = az + bz * k - z;
      best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
    }
    return best;
  }

  /**
   * Nearest sample searching only around a previous index (cheap per-frame tracking).
   * Falls back to a full search if the result is far away (e.g. after a reset).
   */
  trackIndex(x: number, z: number, previous: number, window = 40): number {
    let best = previous;
    let bestD = Infinity;
    for (let k = -window; k <= window; k++) {
      const i = (previous + k + this.count) % this.count;
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > 60 * 60) return this.nearestIndex(x, z);
    return best;
  }

  streetName(index: number): string {
    const f = index / this.count;
    let name = STREETS[0][1];
    for (const [start, n] of STREETS) if (f >= start) name = n;
    return name;
  }

  /** Spawn pose: right-hand inner lane at the start of the lap, facing along the track. */
  startPose(out: Vector3): number {
    const i = 0;
    const laneOffset = ROAD.laneWidth * 0.5;
    out.set(this.px[i] + this.rx(i) * laneOffset, 0, this.pz[i] + this.rz(i) * laneOffset);
    return Math.atan2(-this.tz[i], this.tx[i]);
  }

  /** Bounding box of the centre line. */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
    }
    return { minX, maxX, minZ, maxZ };
  }
}
