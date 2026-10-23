import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Shape,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ROAD } from '../config';
import type { PhysicsWorld } from '../PhysicsWorld';
import { mulberry32, randRange } from './random';
import type { Track } from './Track';

/**
 * Give an instanced shadow caster its own depth material for the shadow pass.
 *
 * Otherwise three.js renders every caster with one shared MeshDepthMaterial, and each switch
 * between instanced / non-instanced meshes (or meshes with / without instance colours) marks
 * that material's program as changed, so the renderer rebuilds its shader parameters on every
 * switch, every frame. Per-mesh depth materials never switch. three.js still copies the source
 * material's side / alpha settings onto them, so the shadow output is unchanged.
 */
export function ownShadowDepth(mesh: InstancedMesh, mats: Material[]): void {
  const depth = new MeshDepthMaterial();
  mesh.customDepthMaterial = depth;
  mats.push(depth);
}

const CURB_OUT = ROAD.halfWidth + ROAD.curbWidth;
const WALK_Y = ROAD.sidewalkHeight;

export function paint(geo: BufferGeometry, color: Color): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(arr, 3));
  return g;
}

export function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('Failed to merge prop geometry.');
  return g;
}

/** Lateral offsets (from the road centre line) of the sidewalk furniture rows. */
export const LAMP_LAT = CURB_OUT + 0.6;
export const TREE_LAT = CURB_OUT + 2.7;

/**
 * Candidate sites for streetlights ([x, z, yaw], yaw turns the arm towards the road) and trees ([x, z]).
 * Shared by the renderer (which drops sites that clash with other props) and by pedestrian path planning.
 */
export function streetFurnitureSites(track: Track): { lights: Array<[number, number, number]>; trees: Array<[number, number]> } {
  const spacingL = 36;
  const lights: Array<[number, number, number]> = [];
  const trees: Array<[number, number]> = [];
  for (const side of [-1, 1]) {
    for (let s = side > 0 ? 0 : spacingL / 2; s < track.length; s += spacingL) {
      const i = Math.round(s / track.spacing) % track.count;
      const off = side * LAMP_LAT;
      // local +X must point toward the road centre
      const dx = -side * track.rx(i);
      const dz = -side * track.rz(i);
      lights.push([track.px[i] + track.rx(i) * off, track.pz[i] + track.rz(i) * off, Math.atan2(-dz, dx)]);
    }
    for (let s = side > 0 ? spacingL / 2 : 0; s < track.length; s += spacingL) {
      const i = Math.round((s + 3) / track.spacing) % track.count;
      const off = side * TREE_LAT;
      trees.push([track.px[i] + track.rx(i) * off, track.pz[i] + track.rz(i) * off]);
    }
  }
  return { lights, trees };
}

/** Static street furniture: streetlights and trees (instanced, with fixed colliders). */
export function buildStaticProps(track: Track, physics: PhysicsWorld, isBlocked: (x: number, z: number) => boolean): { group: Group; dispose(): void } {
  const group = new Group();
  group.name = 'static-props';
  const rnd = mulberry32(777);
  const dummy = new Object3D();

  // --- Streetlights
  const metal = new MeshStandardMaterial({ color: 0x3b4046, roughness: 0.45, metalness: 0.8 });
  const lampMat = new MeshStandardMaterial({ color: 0xf4f1e6, emissive: 0xfff2cc, emissiveIntensity: 0.6, roughness: 0.3 });
  const poleGeo = merged([
    new CylinderGeometry(0.08, 0.13, 8, 10).translate(0, 4, 0),
    new CylinderGeometry(0.2, 0.22, 0.5, 10).translate(0, 0.25, 0),
    new BoxGeometry(2.3, 0.1, 0.1).translate(1.1, 7.9, 0),
    new BoxGeometry(0.8, 0.12, 0.36).translate(2.2, 7.88, 0),
  ]);
  const lampGeo = new BoxGeometry(0.66, 0.04, 0.28).translate(2.2, 7.8, 0);

  const sites = streetFurnitureSites(track);
  const lightPos = sites.lights.filter(([x, z]) => !isBlocked(x, z));
  const poles = new InstancedMesh(poleGeo, metal, lightPos.length);
  const lamps = new InstancedMesh(lampGeo, lampMat, lightPos.length);
  lightPos.forEach(([x, z, yaw], k) => {
    dummy.position.set(x, WALK_Y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.updateMatrix();
    poles.setMatrixAt(k, dummy.matrix);
    lamps.setMatrixAt(k, dummy.matrix);
    physics.addStaticCylinder(x, WALK_Y + 4, z, 4, 0.14);
  });
  poles.castShadow = true;
  poles.computeBoundingSphere();
  lamps.computeBoundingSphere();
  group.add(poles, lamps);

  // --- Trees
  const trunkMat = new MeshStandardMaterial({ color: 0x5a4330, roughness: 0.95 });
  const leafMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  const trunkGeo = new CylinderGeometry(0.12, 0.18, 3.2, 7).translate(0, 1.6, 0);
  const leafGeo = merged([
    new IcosahedronGeometry(1.7, 1).translate(0, 4.3, 0),
    new IcosahedronGeometry(1.25, 1).translate(0.5, 5.4, 0.3),
    new IcosahedronGeometry(1.1, 1).translate(-0.6, 3.8, -0.4),
  ]);
  const treePos: Array<[number, number, number]> = [];
  for (const [x, z] of sites.trees) {
    if (isBlocked(x, z)) continue;
    treePos.push([x, z, randRange(rnd, 0.8, 1.25)]);
  }
  const trunks = new InstancedMesh(trunkGeo, trunkMat, treePos.length);
  const leaves = new InstancedMesh(leafGeo, leafMat, treePos.length);
  const leafColor = new Color();
  treePos.forEach(([x, z, sc], k) => {
    dummy.position.set(x, WALK_Y, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    trunks.setMatrixAt(k, dummy.matrix);
    leaves.setMatrixAt(k, dummy.matrix);
    leafColor.setHSL(0.25 + rnd() * 0.07, 0.42 + rnd() * 0.2, 0.17 + rnd() * 0.07);
    leaves.setColorAt(k, leafColor);
    physics.addStaticCylinder(x, WALK_Y + 1.6, z, 1.6, 0.22 * sc);
  });
  dummy.scale.setScalar(1);
  trunks.castShadow = true;
  leaves.castShadow = true;
  trunks.computeBoundingSphere();
  leaves.computeBoundingSphere();
  group.add(trunks, leaves);

  const geos = [poleGeo, lampGeo, trunkGeo, leafGeo];
  const mats: Material[] = [metal, lampMat, trunkMat, leafMat];
  ownShadowDepth(poles, mats);
  ownShadowDepth(trunks, mats);
  ownShadowDepth(leaves, mats);
  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      poles.dispose();
      lamps.dispose();
      trunks.dispose();
      leaves.dispose();
    },
  };
}

interface DynamicKind {
  mesh: InstancedMesh;
  /** Footprint radius for path planning (pedestrians). */
  radius: number;
  bodies: RAPIER.RigidBody[];
  initial: Array<{ p: Vector3; q: Quaternion }>;
}

/** Traffic cone, 0.74 m tall, centred on its collider (cone half-height 0.36). */
/**
 * Traffic-cone collider matching `coneGeometry`: a heavy square rubber base plate plus the cone body.
 * The flat plate gives a four-point ground contact, so cones stand still when woken up by a restart or
 * a nearby impact (a bare Rapier cone balances on its circular rim and could topple on its own). The
 * plate's underside is at local y = -0.37, so a cone spawned at y = 0.37 already rests on the road.
 */
export function coneColliders(C: typeof RAPIER.ColliderDesc): RAPIER.ColliderDesc[] {
  return [
    C.cuboid(0.21, 0.02, 0.21).setTranslation(0, -0.35, 0).setDensity(300).setFriction(0.7).setRestitution(0.1),
    C.cone(0.34, 0.17).setTranslation(0, 0.01, 0).setDensity(55).setFriction(0.7).setRestitution(0.2),
  ];
}

export function coneGeometry(): BufferGeometry {
  const orange = new Color(0xff5a14);
  const whiteC = new Color(0xf2f2f2);
  return merged([
    paint(new BoxGeometry(0.42, 0.04, 0.42).translate(0, -0.35, 0), new Color(0x1d1d1d)),
    paint(new ConeGeometry(0.17, 0.42, 14, 1, true).translate(0, 0.14, 0), orange),
    paint(new CylinderGeometry(0.08, 0.13, 0.12, 14, 1, true).translate(0, 0.0, 0), whiteC),
    paint(new CylinderGeometry(0.13, 0.17, 0.2, 14, 1, true).translate(0, -0.23, 0), orange),
  ]);
}

/** Concrete jersey barrier: 1.9 m long (local X), 0.8 m tall, centred (half extents 0.95, 0.4, 0.3). */
export function barrierGeometry(): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-0.3, 0);
  shape.lineTo(0.3, 0);
  shape.lineTo(0.28, 0.08);
  shape.lineTo(0.14, 0.3);
  shape.lineTo(0.1, 0.8);
  shape.lineTo(-0.1, 0.8);
  shape.lineTo(-0.14, 0.3);
  shape.lineTo(-0.28, 0.08);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: 1.9, bevelEnabled: false });
  // extrusion is along +Z; rotate so the long axis is local X, centre it
  geo.rotateY(Math.PI / 2).translate(-0.95, -0.4, 0);
  return geo;
}

/** Oil-drum barrel, 0.9 m tall, radius 0.3, centred. */
export function barrelGeometry(): BufferGeometry {
  return merged([
    paint(new CylinderGeometry(0.3, 0.3, 0.9, 16), new Color(0x1f5fa8)),
    paint(new CylinderGeometry(0.305, 0.305, 0.06, 16).translate(0, 0.2, 0), new Color(0xd8d8d8)),
    paint(new CylinderGeometry(0.305, 0.305, 0.06, 16).translate(0, -0.2, 0), new Color(0xd8d8d8)),
  ]);
}

interface PropSpec {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Physically simulated roadside objects (cones, barrels, crates, concrete barriers)
 * that the car can knock over. Rendered with one InstancedMesh per type.
 */
export class DynamicProps {
  readonly group = new Group();
  private readonly kinds: DynamicKind[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Material[] = [];
  private readonly m4 = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);

  constructor(
    private readonly physics: PhysicsWorld,
    track: Track,
  ) {
    this.group.name = 'dynamic-props';
    const at = (i: number, off: number, y: number, yawOffset = 0): PropSpec => {
      const k = ((i % track.count) + track.count) % track.count;
      return {
        x: track.px[k] + track.rx(k) * off,
        y,
        z: track.pz[k] + track.rz(k) * off,
        yaw: Math.atan2(-track.tz[k], track.tx[k]) + yawOffset,
      };
    };

    // --- Placement plan
    const cones: PropSpec[] = [];
    const barriers: PropSpec[] = [];
    const barrels: PropSpec[] = [];
    const crates: PropSpec[] = [];
    // Slalom in the opposite-direction inner lane along the start straight (the outer lane stays open for traffic).
    for (let k = 0; k < 6; k++) cones.push(at(12 + k * 5, k % 2 ? -2.7 : -1.0, 0.37));
    // Construction zone on the outer right lane (taper + barriers).
    const cz = Math.round(track.count * 0.29);
    for (let k = 0; k < 7; k++) cones.push(at(cz + k * 2, 6.4 - k * 0.42, 0.37));
    for (let k = 0; k < 6; k++) barriers.push(at(cz + 16 + k * 2, 5.15, 0.4)); // resting height (half-height 0.4)
    for (let k = 0; k < 6; k++) cones.push(at(cz + 16 + k * 2, 3.7, 0.37));
    // Barrel and crate clusters on sidewalks / roadside near corners.
    const clusters = [0.12, 0.45, 0.63, 0.8];
    for (const f of clusters) {
      const i = Math.round(track.count * f);
      for (let k = 0; k < 3; k++) barrels.push(at(i + k, 8.6 + (k % 2) * 0.75, WALK_Y + 0.45));
      crates.push(at(i + 4, 9.1, WALK_Y + 0.5, 0.2));
      crates.push(at(i + 4, 9.1, WALK_Y + 1.5, 0.5));
      crates.push(at(i + 5, 9.3, WALK_Y + 0.5, -0.1));
    }
    const orangeZone = Math.round(track.count * 0.55);
    for (let k = 0; k < 5; k++) cones.push(at(orangeZone + k * 3, -6.3, 0.37));

    // --- Cones
    const coneGeo = coneGeometry();
    const coneMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
    this.addKind(coneGeo, coneMat, cones, coneColliders, 0.3);

    // --- Concrete jersey barriers
    const barrierGeo = barrierGeometry();
    const barrierMat = new MeshStandardMaterial({ color: 0xc9c6bd, roughness: 0.95 });
    this.addKind(barrierGeo, barrierMat, barriers, (d) => d.cuboid(0.95, 0.4, 0.22).setDensity(1100).setFriction(0.8), 0.98);

    // --- Barrels
    const barrelGeo = barrelGeometry();
    const barrelMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 });
    this.addKind(barrelGeo, barrelMat, barrels, (d) => d.cylinder(0.45, 0.3).setDensity(120).setFriction(0.5).setRestitution(0.15), 0.32);

    // --- Crates
    const crateGeo = new BoxGeometry(1, 1, 1);
    const crateMat = new MeshStandardMaterial({ color: 0x9b7444, roughness: 0.85 });
    this.addKind(crateGeo, crateMat, crates, (d) => d.cuboid(0.5, 0.5, 0.5).setDensity(45).setFriction(0.7), 0.7);

    for (const list of [cones, barriers, barrels, crates]) for (const sp of list) this.positions.push([sp.x, sp.z]);
  }

  /** Initial XZ positions of every prop (used to keep static props from overlapping them). */
  readonly positions: Array<[number, number]> = [];

  private addKind(
    geo: BufferGeometry,
    mat: Material,
    specs: PropSpec[],
    collider: (d: typeof RAPIER.ColliderDesc) => RAPIER.ColliderDesc | RAPIER.ColliderDesc[],
    radius: number,
  ): void {
    const { R, world } = this.physics;
    const mesh = new InstancedMesh(geo, mat, specs.length);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    ownShadowDepth(mesh, this.mats);
    const kind: DynamicKind = { mesh, radius, bodies: [], initial: [] };
    for (const sp of specs) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sp.yaw);
      const p = new Vector3(sp.x, sp.y, sp.z);
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q).setLinearDamping(0.1).setAngularDamping(0.3),
      );
      const descs = collider(R.ColliderDesc);
      for (const d of Array.isArray(descs) ? descs : [descs]) world.createCollider(d, body);
      body.sleep();
      kind.bodies.push(body);
      kind.initial.push({ p, q });
    }
    this.kinds.push(kind);
    this.geos.push(geo);
    this.mats.push(mat);
    this.group.add(mesh);
    this.sync(true);
  }

  /** Copy body transforms into instance matrices (skips sleeping bodies). */
  sync(force = false): void {
    for (const k of this.kinds) {
      let dirty = false;
      for (let i = 0; i < k.bodies.length; i++) {
        const b = k.bodies[i];
        if (!force && b.isSleeping()) continue;
        const t = b.translation();
        const r = b.rotation();
        this.v.set(t.x, t.y, t.z);
        this.q.set(r.x, r.y, r.z, r.w);
        this.m4.compose(this.v, this.q, this.s);
        k.mesh.setMatrixAt(i, this.m4);
        dirty = true;
      }
      if (dirty) k.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  reset(): void {
    for (const k of this.kinds) {
      for (let i = 0; i < k.bodies.length; i++) {
        const b = k.bodies[i];
        const { p, q } = k.initial[i];
        b.setTranslation(p, false);
        b.setRotation(q, false);
        b.setLinvel({ x: 0, y: 0, z: 0 }, false);
        b.setAngvel({ x: 0, y: 0, z: 0 }, false);
        b.sleep();
      }
    }
    this.sync(true);
  }

  /** Append the current [x, z, radius] of every prop to `out` (flat triples). */
  obstacles(out: number[]): void {
    for (const k of this.kinds)
      for (const b of k.bodies) {
        const t = b.translation();
        out.push(t.x, t.z, k.radius);
      }
  }

  /** Number of props that have been displaced from their start position. */
  displacedCount(): number {
    let n = 0;
    for (const k of this.kinds)
      for (let i = 0; i < k.bodies.length; i++) {
        const t = k.bodies[i].translation();
        const p = k.initial[i].p;
        if (Math.abs(t.x - p.x) + Math.abs(t.z - p.z) > 0.5) n++;
      }
    return n;
  }

  dispose(): void {
    for (const k of this.kinds) {
      for (const b of k.bodies) this.physics.world.removeRigidBody(b);
      k.mesh.dispose();
    }
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
