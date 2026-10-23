import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Mesh, MeshBasicMaterial, type Scene } from 'three';

const MAX_SEGMENTS = 3000;
const HALF_WIDTH = 0.12;
const MIN_STEP = 0.3;
const MAX_STEP = 3;
/** Height above the physics contact point (the asphalt mesh sits 2 cm above physics ground). */
const LIFT = 0.032;
const MAX_ALPHA = 0.6;

interface Trail {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** End edge of the previous segment, reused so consecutive quads join seamlessly. */
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  alpha: number;
  hasEdge: boolean;
}

/**
 * Tyre marks: a fixed-size ring buffer of quads rendered in a single draw call.
 * Oldest segments are overwritten; only modified ranges are uploaded to the GPU.
 */
export class SkidMarks {
  readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly trails: Trail[] = [];
  private next = 0;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;
  private wrapped = false;
  /** Total segments written since the last clear (for diagnostics/QA). */
  segmentCount = 0;

  constructor(scene: Scene, wheels = 4) {
    const verts = MAX_SEGMENTS * 4;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4).fill(1);
    for (let i = 0; i < verts; i++) this.colors[i * 4 + 3] = 0;
    const index = new Uint16Array(MAX_SEGMENTS * 6);
    for (let s = 0; s < MAX_SEGMENTS; s++) {
      const v = s * 4;
      index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6); // CCW seen from above
    }
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(new BufferAttribute(index, 1));
    const mat = new MeshBasicMaterial({
      color: 0x0c0c0c,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = 'skid-marks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    for (let i = 0; i < wheels; i++)
      this.trails.push({ active: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, alpha: 0, hasEdge: false });
  }

  /** Feed a wheel contact point. intensity 0 ends the trail for that wheel. */
  add(wheel: number, x: number, y: number, z: number, intensity: number): void {
    const t = this.trails[wheel];
    if (intensity <= 0.02) {
      t.active = false;
      t.hasEdge = false;
      return;
    }
    const alpha = Math.min(1, intensity) * MAX_ALPHA;
    if (!t.active) {
      t.active = true;
      t.hasEdge = false;
      t.x = x;
      t.y = y;
      t.z = z;
      t.alpha = alpha;
      return;
    }
    const dx = x - t.x;
    const dz = z - t.z;
    const d = Math.hypot(dx, dz);
    if (d < MIN_STEP) return;
    if (d > MAX_STEP || Math.abs(y - t.y) > 0.5) {
      // teleport / jump: restart the trail here
      t.x = x;
      t.y = y;
      t.z = z;
      t.alpha = alpha;
      t.hasEdge = false;
      return;
    }
    const sx = (-dz / d) * HALF_WIDTH;
    const sz = (dx / d) * HALF_WIDTH;
    if (!t.hasEdge) {
      t.lx = t.x - sx;
      t.lz = t.z - sz;
      t.rx = t.x + sx;
      t.rz = t.z + sz;
    }
    const s = this.next;
    const p = s * 12;
    const y0 = t.y + LIFT;
    const y1 = y + LIFT;
    const P = this.positions;
    P[p] = t.lx;
    P[p + 1] = y0;
    P[p + 2] = t.lz;
    P[p + 3] = t.rx;
    P[p + 4] = y0;
    P[p + 5] = t.rz;
    P[p + 6] = x - sx;
    P[p + 7] = y1;
    P[p + 8] = z - sz;
    P[p + 9] = x + sx;
    P[p + 10] = y1;
    P[p + 11] = z + sz;
    const c = s * 16;
    this.colors[c + 3] = t.alpha;
    this.colors[c + 7] = t.alpha;
    this.colors[c + 11] = alpha;
    this.colors[c + 15] = alpha;
    this.markDirty(s);
    this.next = (s + 1) % MAX_SEGMENTS;
    if (this.next === 0) this.wrapped = true;
    this.segmentCount++;

    t.x = x;
    t.y = y;
    t.z = z;
    t.alpha = alpha;
    t.lx = x - sx;
    t.lz = z - sz;
    t.rx = x + sx;
    t.rz = z + sz;
    t.hasEdge = true;
  }

  private markDirty(segment: number): void {
    if (segment < this.dirtyFrom) this.dirtyFrom = segment;
    if (segment > this.dirtyTo) this.dirtyTo = segment;
  }

  /** End every trail (after a reset/teleport) without deleting existing marks. */
  breakTrails(): void {
    for (const t of this.trails) {
      t.active = false;
      t.hasEdge = false;
    }
  }

  clear(): void {
    this.positions.fill(0);
    for (let i = 3; i < this.colors.length; i += 4) this.colors[i] = 0;
    this.next = 0;
    this.wrapped = false;
    this.segmentCount = 0;
    this.breakTrails();
    this.dirtyFrom = 0;
    this.dirtyTo = MAX_SEGMENTS - 1;
  }

  /** Upload modified ranges; call once per rendered frame. */
  flush(): void {
    if (this.dirtyTo < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyTo - from + 1;
    this.posAttr.clearUpdateRanges();
    this.colAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(from * 12, count * 12);
    this.colAttr.addUpdateRange(from * 16, count * 16);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
  }

  get isWrapped(): boolean {
    return this.wrapped;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}
