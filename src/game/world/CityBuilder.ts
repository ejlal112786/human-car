import { Group, Mesh, MeshStandardMaterial, type BufferGeometry, type Material } from 'three';
import { SIDEWALK_OUTER } from '../config';
import type { PhysicsWorld } from '../PhysicsWorld';
import { GeometryAccumulator } from './GeometryAccumulator';
import { mulberry32, randRange } from './random';
import type { TextureSet } from './Textures';
import type { Track } from './Track';

export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  yaw: number;
  style: number;
  /** Assigned to a small, stable subset of buildings for the Quaternius facade renderer. */
  quaterniusModel?: string;
  district?: 'Portside' | 'Market District' | 'Old Quarter';
}

export interface CityResult {
  group: Group;
  footprints: Footprint[];
  dispose(): void;
}

const DOWNTOWN = { x: 40, z: -110 };
const MAX_BUILDINGS = 430;

/** Separating-axis overlap test for two oriented rectangles in the XZ plane. */
function overlaps(a: Footprint, b: Footprint, margin: number): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ra = Math.hypot(a.w, a.d) / 2 + margin;
  const rb = Math.hypot(b.w, b.d) / 2;
  if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return false;
  const axes = [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2];
  for (const ang of axes) {
    const ax = Math.cos(ang);
    const az = -Math.sin(ang);
    const proj = (f: Footprint, m: number) => {
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      // half extents projected on axis: local x axis = (c, -s), local z axis = (s, c)
      return Math.abs((f.w / 2 + m) * (c * ax - s * az)) + Math.abs((f.d / 2 + m) * (s * ax + c * az));
    };
    const dist = Math.abs(dx * ax + dz * az);
    if (dist > proj(a, margin) + proj(b, 0)) return false;
  }
  return true;
}

/** True when no road sample lies within `clearance` of the rectangle. */
function clearOfRoad(track: Track, f: Footprint, clearance: number): boolean {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const hw = f.w / 2 + clearance;
  const hd = f.d / 2 + clearance;
  const r2 = (Math.hypot(f.w, f.d) / 2 + clearance) ** 2;
  for (let i = 0; i < track.count; i++) {
    const dx = track.px[i] - f.x;
    const dz = track.pz[i] - f.z;
    if (dx * dx + dz * dz > r2) continue;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) < hw && Math.abs(lz) < hd) return false;
  }
  return true;
}

function districtAt(track: Track, x: number, z: number): NonNullable<Footprint['district']> {
  const i = track.nearestIndex(x, z);
  const f = track.dist[i] / track.length;
  if (f < 0.31) return 'Portside';
  if (f < 0.62) return 'Market District';
  return 'Old Quarter';
}

function heightFor(rnd: () => number, x: number, z: number, district: NonNullable<Footprint['district']>): number {
  const dd = Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z);
  const downtown = Math.exp(-(dd * dd) / (2 * 170 * 170));
  const base = district === 'Portside' ? randRange(rnd, 8, 20) : district === 'Old Quarter' ? randRange(rnd, 7, 23) : randRange(rnd, 10, 26);
  const chance = district === 'Portside' ? 0.16 : district === 'Old Quarter' ? 0.12 : 0.25 + downtown * 0.5;
  const tower = rnd() < chance ? randRange(rnd, district === 'Old Quarter' ? 8 : 15, district === 'Portside' ? 42 : 85) * (district === 'Market District' ? 0.35 + downtown : 0.7) : 0;
  return Math.round((base + tower) / 3.4) * 3.4 + 1;
}

/** Procedurally places buildings along the streets and fills the surrounding blocks. */
export function buildCity(track: Track, tex: TextureSet, physics: PhysicsWorld): CityResult {
  const rnd = mulberry32(20240611);
  const footprints: Footprint[] = [];
  const styleCount = tex.facades.length;

  const tryPlace = (f: Footprint, roadClearance: number): boolean => {
    if (footprints.length >= MAX_BUILDINGS) return false;
    if (!clearOfRoad(track, f, roadClearance)) return false;
    for (const o of footprints) if (overlaps(f, o, 2.5)) return false;
    f.district = districtAt(track, f.x, f.z);
    f.h = heightFor(rnd, f.x, f.z, f.district);
    footprints.push(f);
    return true;
  };

  // 1) Street frontage on both sides of the road.
  for (const side of [-1, 1]) {
    let s = randRange(rnd, 0, 10);
    while (s < track.length - 10) {
      const w = randRange(rnd, 14, 30);
      const d = randRange(rnd, 14, 26);
      const setback = randRange(rnd, 2.5, 6);
      const i = Math.round((s + w / 2) / track.spacing) % track.count;
      const off = side * (SIDEWALK_OUTER + setback + d / 2);
      const x = track.px[i] + track.rx(i) * off;
      const z = track.pz[i] + track.rz(i) * off;
      const yaw = Math.atan2(-track.tz[i], track.tx[i]);
      const placed = tryPlace({ x, z, w, d, h: 0, yaw, style: Math.floor(rnd() * styleCount) }, SIDEWALK_OUTER + 1.5);
      s += placed ? w + randRange(rnd, 3, 9) : 5;
    }
  }

  // 2) Fill blocks further from the road for skyline depth.
  const b = track.bounds();
  const pad = 170;
  for (let gx = b.minX - pad; gx <= b.maxX + pad; gx += 36) {
    for (let gz = b.minZ - pad; gz <= b.maxZ + pad; gz += 36) {
      if (rnd() < 0.18) continue;
      const x = gx + randRange(rnd, -8, 8);
      const z = gz + randRange(rnd, -8, 8);
      const i = track.nearestIndex(x, z);
      const yaw = Math.atan2(-track.tz[i], track.tx[i]) + (rnd() < 0.5 ? 0 : Math.PI / 2);
      const w = randRange(rnd, 16, 30);
      const d = randRange(rnd, 16, 30);
      tryPlace({ x, z, w, d, h: 0, yaw, style: Math.floor(rnd() * styleCount) }, SIDEWALK_OUTER + 6);
    }
  }

  // 3) Merge geometry per facade style; roofs and rooftop clutter go into one mesh.
  const walls = tex.facades.map(() => new GeometryAccumulator(true));
  const roofs = new GeometryAccumulator(true);
  const quaterniusModels: Record<NonNullable<Footprint['district']>, string[]> = {
    Portside: ['1story', '2story_balcony'],
    'Market District': ['3story_slim', '4story', '6story_stack'],
    'Old Quarter': ['1story', '2story_balcony', '4story'],
  };
  // Preserve the continuous road loop but give its three neighborhoods distinct urban profiles.
  for (let i = 7; i < footprints.length; i += 13) {
    const lot = footprints[i];
    const models = quaterniusModels[lot.district ?? 'Market District'];
    lot.quaterniusModel = models[Math.floor(i / 13) % models.length];
  }
  for (const f of footprints) {
    if (!f.quaterniusModel) {
    const tint = 0.85 + rnd() * 0.2;
    const fac = tex.facades[f.style];
    walls[f.style].box(f.x, f.h / 2, f.z, f.w, f.h, f.d, f.yaw, {
      tileW: fac.tileW,
      tileH: fac.tileH,
      top: false,
      color: f.district === 'Portside' ? [tint * 0.78, tint * 0.9, tint] : f.district === 'Old Quarter' ? [tint, tint * 0.84, tint * 0.68] : [tint, tint, tint * (0.97 + rnd() * 0.06)],
      uOffset: Math.floor(rnd() * 4) * 0.25,
    });
    const rc = 0.55 + rnd() * 0.15;
    roofs.box(f.x, f.h + 0.5, f.z, f.w + 0.4, 1.0, f.d + 0.4, f.yaw, { color: [rc, rc, rc] }); // parapet slab
    const units = Math.floor(rnd() * 3);
    for (let k = 0; k < units; k++) {
      const ux = randRange(rnd, -f.w / 3, f.w / 3);
      const uz = randRange(rnd, -f.d / 3, f.d / 3);
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      const uh = randRange(rnd, 1.2, 3);
      roofs.box(f.x + ux * c + uz * s, f.h + 1 + uh / 2, f.z - ux * s + uz * c, randRange(rnd, 2, 5), uh, randRange(rnd, 2, 5), f.yaw, {
        color: [0.72, 0.73, 0.74],
      });
    }
    }
    physics.addStaticBox(f.x, f.h / 2, f.z, f.w / 2, f.h / 2, f.d / 2, f.yaw, 0.3);
  }

  const group = new Group();
  group.name = 'city';
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  walls.forEach((acc, i) => {
    if (acc.vertexCount === 0) return;
    const fac = tex.facades[i];
    const mat = new MeshStandardMaterial({ map: fac.map, roughnessMap: fac.rough, roughness: 1, metalness: 0.05, vertexColors: true, envMapIntensity: 1.2 });
    const geo = acc.build();
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    geometries.push(geo);
    materials.push(mat);
  });
  const roofMat = new MeshStandardMaterial({ color: 0x8a8c90, roughness: 0.9, metalness: 0, vertexColors: true });
  const roofGeo = roofs.build();
  const roofMesh = new Mesh(roofGeo, roofMat);
  roofMesh.castShadow = true;
  roofMesh.receiveShadow = true;
  roofMesh.matrixAutoUpdate = false;
  group.add(roofMesh);
  geometries.push(roofGeo);
  materials.push(roofMat);

  return {
    group,
    footprints,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
