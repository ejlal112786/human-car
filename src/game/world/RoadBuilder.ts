import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Material,
} from 'three';
import { ROAD, SIDEWALK_OUTER } from '../config';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { TextureSet } from './Textures';
import type { Track } from './Track';

/** Accumulates quads swept along the track centre line. */
class StripBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  constructor(private readonly track: Track) {}

  /**
   * Sweep the cross-section segment (offA, yA) → (offB, yB) along the track.
   * Offsets are measured to the right of the centre line. The face normal is
   * (B − A) × forward, so order the endpoints to choose which side faces out.
   * @param uA,uB texture U at each endpoint
   * @param vScale metres of track per texture V unit
   * @param include optional per-sample predicate (for dashed lines)
   */
  sweep(
    offA: number,
    yA: number,
    offB: number,
    yB: number,
    uA: number,
    uB: number,
    vScale: number,
    include?: (i: number, dist: number) => boolean,
  ): void {
    const t = this.track;
    const n = t.count;
    for (let i = 0; i < n; i++) {
      if (include && !include(i, t.dist[i])) continue;
      const j = (i + 1) % n;
      const d0 = t.dist[i];
      const d1 = i + 1 === n ? t.length : t.dist[j];
      const ax0 = t.px[i] + t.rx(i) * offA;
      const az0 = t.pz[i] + t.rz(i) * offA;
      const bx0 = t.px[i] + t.rx(i) * offB;
      const bz0 = t.pz[i] + t.rz(i) * offB;
      const ax1 = t.px[j] + t.rx(j) * offA;
      const az1 = t.pz[j] + t.rz(j) * offA;
      const bx1 = t.px[j] + t.rx(j) * offB;
      const bz1 = t.pz[j] + t.rz(j) * offB;
      // normal = (B0 - A0) x (A1 - A0)
      const ex = bx0 - ax0;
      const ey = yB - yA;
      const ez = bz0 - az0;
      const fx = ax1 - ax0;
      const fz = az1 - az0;
      let nx = ey * fz - ez * 0;
      let ny = ez * fx - ex * fz;
      let nz = ex * 0 - ey * fx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const base = this.pos.length / 3;
      this.pos.push(ax0, yA, az0, bx0, yB, bz0, ax1, yA, az1, bx1, yB, bz1);
      for (let k = 0; k < 4; k++) this.nrm.push(nx, ny, nz);
      this.uv.push(uA, d0 / vScale, uB, d0 / vScale, uA, d1 / vScale, uB, d1 / vScale);
      this.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export interface RoadResult {
  group: Group;
  /** Materials that get a wet look in the rain (asphalt first). */
  wetMaterials: MeshStandardMaterial[];
  dispose(): void;
}

/** Builds asphalt, markings, curbs and sidewalks plus their static colliders. */
export function buildRoad(track: Track, tex: TextureSet, physics: PhysicsWorld): RoadResult {
  const group = new Group();
  group.name = 'road';
  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const hw = ROAD.halfWidth;
  const y = ROAD.surfaceY;
  const sh = ROAD.sidewalkHeight;
  const curbOut = hw + ROAD.curbWidth;

  const add = (geo: BufferGeometry, mat: Material, receive = true): Mesh => {
    const m = new Mesh(geo, mat);
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    geometries.push(geo);
    return m;
  };

  // --- Asphalt
  const asphaltMat = new MeshStandardMaterial({
    map: tex.asphalt,
    roughnessMap: tex.asphaltRough,
    roughness: 0.95,
    metalness: 0,
  });
  materials.push(asphaltMat);
  const asphalt = new StripBuilder(track);
  asphalt.sweep(-hw, y, hw, y, 0, 1, hw * 2);
  add(asphalt.build(), asphaltMat);

  // --- Markings (decals slightly above the asphalt, with polygon offset)
  const decal = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, roughness: 0.65, metalness: 0 };
  const whiteMat = new MeshStandardMaterial({ color: 0xe6e6e2, ...decal });
  const yellowMat = new MeshStandardMaterial({ color: 0xe2b230, ...decal });
  materials.push(whiteMat, yellowMat);
  const my = y + 0.004;
  const white = new StripBuilder(track);
  const dashed = (_i: number, d: number) => d % 10 < 4;
  white.sweep(ROAD.laneWidth - 0.08, my, ROAD.laneWidth + 0.08, my, 0, 1, 1, dashed);
  white.sweep(-ROAD.laneWidth - 0.08, my, -ROAD.laneWidth + 0.08, my, 0, 1, 1, dashed);
  white.sweep(hw - 0.42, my, hw - 0.24, my, 0, 1, 1);
  white.sweep(-hw + 0.24, my, -hw + 0.42, my, 0, 1, 1);
  add(white.build(), whiteMat);
  const yellow = new StripBuilder(track);
  yellow.sweep(-0.3, my, -0.14, my, 0, 1, 1);
  yellow.sweep(0.14, my, 0.3, my, 0, 1, 1);
  add(yellow.build(), yellowMat);

  // --- Start line (checkered band across the road)
  const checkerMat = new MeshStandardMaterial({ map: tex.checker, ...decal, roughness: 0.7 });
  materials.push(checkerMat);
  const start = new StripBuilder(track);
  start.sweep(-hw + 0.45, my + 0.001, hw - 0.45, my + 0.001, 0, 6.5, 2, (i) => i === 4);
  add(start.build(), checkerMat);

  // --- Curbs + sidewalks (visual and physical)
  const curbMat = new MeshStandardMaterial({ map: tex.curb, roughness: 0.8, metalness: 0 });
  const walkMat = new MeshStandardMaterial({ map: tex.sidewalk, roughness: 0.92, metalness: 0 });
  materials.push(curbMat, walkMat);
  const curb = new StripBuilder(track);
  // left side (negative offsets): inner face faces right (+r): A high, B low
  curb.sweep(-hw, sh, -hw, y, 0, 0.15, 2);
  curb.sweep(-curbOut, sh, -hw, sh, 0, 1, 2);
  // right side: inner face faces left: A low, B high
  curb.sweep(hw, y, hw, sh, 0, 0.15, 2);
  curb.sweep(hw, sh, curbOut, sh, 0, 1, 2);
  const curbGeo = curb.build();
  add(curbGeo, curbMat);

  const walk = new StripBuilder(track);
  const sw = ROAD.sidewalkWidth;
  walk.sweep(-SIDEWALK_OUTER, sh, -curbOut, sh, 0, sw / 2, 2);
  walk.sweep(curbOut, sh, SIDEWALK_OUTER, sh, 0, sw / 2, 2);
  // outer faces: left faces −r (A low, B high), right faces +r (A high, B low)
  walk.sweep(-SIDEWALK_OUTER, 0, -SIDEWALK_OUTER, sh, 0, 0.08, 2);
  walk.sweep(SIDEWALK_OUTER, sh, SIDEWALK_OUTER, 0, 0, 0.08, 2);
  const walkGeo = walk.build();
  add(walkGeo, walkMat);

  // Physics: one trimesh for curbs + sidewalks on both sides.
  const verts = new Float32Array(curb.pos.length + walk.pos.length);
  verts.set(curb.pos, 0);
  verts.set(walk.pos, curb.pos.length);
  const offset = curb.pos.length / 3;
  const idx = new Uint32Array(curb.idx.length + walk.idx.length);
  idx.set(curb.idx, 0);
  for (let i = 0; i < walk.idx.length; i++) idx[curb.idx.length + i] = walk.idx[i] + offset;
  physics.addStaticTrimesh(verts, idx);

  return {
    group,
    wetMaterials: [asphaltMat, whiteMat, yellowMat, checkerMat, curbMat, walkMat],
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
