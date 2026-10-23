import { BufferGeometry, Float32BufferAttribute } from 'three';

type V3 = readonly [number, number, number];

/**
 * Collects quads into flat arrays and emits a single BufferGeometry.
 * Used to merge many static objects (buildings, roofs) into few draw calls.
 */
export class GeometryAccumulator {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];

  constructor(private readonly withColor = false) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * Adds quad a-b-c-d (in perimeter order). Winding is fixed automatically so the
   * front face points along `normal`.
   */
  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    normal: V3,
    uv: readonly [number, number, number, number, number, number, number, number] = [0, 0, 1, 0, 1, 1, 0, 1],
    color: V3 = [1, 1, 1],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const flip = nx * normal[0] + ny * normal[1] + nz * normal[2] < 0;
    const verts = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    const uvIdx = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k++) {
      const v = verts[k];
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(normal[0], normal[1], normal[2]);
      const ui = uvIdx[k];
      this.uv.push(uv[ui * 2], uv[ui * 2 + 1]);
      if (this.withColor) this.col.push(color[0], color[1], color[2]);
    }
  }

  /** Oriented box (yaw about Y) with UVs scaled in metres by tileW/tileH on the sides. */
  box(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    yaw: number,
    opts: { tileW?: number; tileH?: number; top?: boolean; bottom?: boolean; sides?: boolean; color?: V3; uOffset?: number } = {},
  ): void {
    const { tileW = 1, tileH = 1, top = true, bottom = false, sides = true, color = [1, 1, 1], uOffset = 0 } = opts;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // local (x,z) -> world, rotation about +Y
    const tx = (lx: number, lz: number) => cx + lx * cos + lz * sin;
    const tz = (lx: number, lz: number) => cz - lx * sin + lz * cos;
    const hw = w / 2;
    const hd = d / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const corners: Array<[number, number]> = [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ];
    if (sides) {
      let u = uOffset;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = corners[k];
        const [bx, bz] = corners[(k + 1) % 4];
        const len = Math.hypot(bx - ax, bz - az);
        // outward normal in local space
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const ml = Math.hypot(mx, mz) || 1;
        const lnx = mx / ml;
        const lnz = mz / ml;
        const n: V3 = [lnx * cos + lnz * sin, 0, -lnx * sin + lnz * cos];
        const u0 = u;
        const u1 = u + len / tileW;
        const v1 = h / tileH;
        this.quad(
          [tx(ax, az), y0, tz(ax, az)],
          [tx(bx, bz), y0, tz(bx, bz)],
          [tx(bx, bz), y1, tz(bx, bz)],
          [tx(ax, az), y1, tz(ax, az)],
          n,
          [u0, 0, u1, 0, u1, v1, u0, v1],
          color,
        );
        u = u1;
      }
    }
    const cornerAt = (k: number, y: number): V3 => [tx(corners[k][0], corners[k][1]), y, tz(corners[k][0], corners[k][1])];
    if (top) this.quad(cornerAt(0, y1), cornerAt(1, y1), cornerAt(2, y1), cornerAt(3, y1), [0, 1, 0], [0, 0, w / tileW, 0, w / tileW, d / tileW, 0, d / tileW], color);
    if (bottom) this.quad(cornerAt(0, y0), cornerAt(1, y0), cornerAt(2, y0), cornerAt(3, y0), [0, -1, 0], undefined, color);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    if (this.withColor) g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
