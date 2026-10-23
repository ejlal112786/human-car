import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  Vector3,
  type Material,
} from 'three';
import type { PhysicsWorld } from '../PhysicsWorld';
import { barrelGeometry, barrierGeometry, coneColliders, coneGeometry, merged, ownShadowDepth, paint } from '../world/Props';
import type { Track } from '../world/Track';
import type { ObstacleKind, ObstacleSpec } from './Levels';

interface KindDef {
  capacity: number;
  dynamic: boolean;
  /** Moved by the course (sliders): kinematic bodies driven each fixed step. */
  kinematic?: boolean;
  /** Per-instance tint palette (multiplied with the vertex colours). */
  tints?: number[];
  /** Height of the body centre above the road surface. */
  y: number;
  /** Default yaw relative to the road (barriers lie along it, roadblocks across it). */
  yaw: number;
  geo: () => BufferGeometry;
  mat: () => MeshStandardMaterial;
  collider: (R: typeof RAPIER) => RAPIER.ColliderDesc | RAPIER.ColliderDesc[];
}

/** Speed bump: a trapezoid hump 9 cm high and 0.7 m deep (local X = along the road), 7 m across. */
function bumpProfile(): Array<[number, number]> {
  return [
    [-0.35, 0],
    [0.35, 0],
    [0.15, 0.09],
    [-0.15, 0.09],
  ];
}

function bumpGeometry(): BufferGeometry {
  const s = new Shape();
  const p = bumpProfile();
  s.moveTo(p[0][0], p[0][1]);
  for (let k = 1; k < p.length; k++) s.lineTo(p[k][0], p[k][1]);
  s.closePath();
  // Profile in XY (X = along the road, Y = height), extruded across the road (Z), centred.
  const g = new ExtrudeGeometry(s, { depth: 7, bevelEnabled: false });
  g.translate(0, 0, -3.5);
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  // Yellow / black stripes across the road, coloured per triangle.
  const pos = ng.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let t = 0; t < pos.count; t += 3) {
    const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const c = Math.floor((cz + 3.5) / 0.7) % 2 === 0 ? [0.95, 0.75, 0.08] : [0.1, 0.1, 0.1];
    for (let k = 0; k < 3; k++) col.set(c, (t + k) * 3);
  }
  ng.setAttribute('color', new Float32BufferAttribute(col, 3));
  ng.computeVertexNormals();
  return ng;
}

/** Red/white striped roadblock board on two legs, 3 m wide, 1.1 m tall (centre at 0.55 m). */
function roadblockGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const red = new Color(0xd01818);
  const white = new Color(0xf4f4f4);
  for (let k = 0; k < 6; k++) {
    const x = -1.25 + k * 0.5;
    parts.push(paint(new BoxGeometry(0.5, 0.32, 0.06).translate(x, 0.28, 0), k % 2 ? white : red));
    parts.push(paint(new BoxGeometry(0.5, 0.16, 0.06).translate(x, -0.08, 0), k % 2 ? red : white));
  }
  const leg = new Color(0x2a2a2a);
  for (const x of [-1.3, 1.3]) {
    parts.push(paint(new BoxGeometry(0.08, 1.1, 0.08).translate(x, 0, 0), leg));
    parts.push(paint(new BoxGeometry(0.16, 0.06, 0.6).translate(x, -0.52, 0), leg));
  }
  // flashing-lamp housings on top
  for (const x of [-1.0, 1.0]) parts.push(paint(new CylinderGeometry(0.07, 0.07, 0.12, 10).translate(x, 0.5, 0), new Color(0xffa000)));
  return merged(parts);
}

/** Wooden crate, 0.8 m cube (centred). */
function crateGeometry(): BufferGeometry {
  const wood = new Color(0xa8773f);
  const dark = new Color(0x5e3f1d);
  const parts: BufferGeometry[] = [paint(new BoxGeometry(0.76, 0.76, 0.76), wood)];
  // Frame battens on every edge.
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      parts.push(paint(new BoxGeometry(0.8, 0.09, 0.09).translate(0, a * 0.36, b * 0.36), dark));
      parts.push(paint(new BoxGeometry(0.09, 0.8, 0.09).translate(a * 0.36, 0, b * 0.36), dark));
      parts.push(paint(new BoxGeometry(0.09, 0.09, 0.8).translate(a * 0.36, b * 0.36, 0), dark));
    }
  return merged(parts);
}

/** Sweeping boom: a striped wall 3.0 m across the road (local Z), 0.9 m tall, on a dark base. */
function sliderGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const red = new Color(0xd01818);
  const white = new Color(0xf4f4f4);
  for (let k = 0; k < 8; k++) parts.push(paint(new BoxGeometry(0.34, 0.62, 0.375).translate(0, 0.08, -1.3125 + k * 0.375), k % 2 ? white : red));
  parts.push(paint(new BoxGeometry(0.4, 0.22, 3.0).translate(0, -0.34, 0), new Color(0x262626)));
  for (const z of [-1.25, 1.25]) parts.push(paint(new CylinderGeometry(0.08, 0.08, 0.1, 10).translate(0, 0.44, z), new Color(0xffa000)));
  return merged(parts);
}

/** Parked car: simple saloon, 4.4 m long (local X), 1.8 m wide; body centre 0.7 m above the road. */
function parkedCarGeometry(): BufferGeometry {
  const body = new Color(0xe6e6e6);
  const glass = new Color(0x1a2430);
  const tyre = new Color(0x161616);
  const parts: BufferGeometry[] = [
    paint(new BoxGeometry(4.4, 0.62, 1.8).translate(0, -0.1, 0), body),
    paint(new BoxGeometry(2.3, 0.56, 1.6).translate(-0.25, 0.48, 0), glass),
    paint(new BoxGeometry(2.1, 0.08, 1.56).translate(-0.25, 0.78, 0), body),
    paint(new BoxGeometry(0.05, 0.14, 0.5).translate(2.2, -0.02, 0.55), new Color(0xfff4d0)),
    paint(new BoxGeometry(0.05, 0.14, 0.5).translate(2.2, -0.02, -0.55), new Color(0xfff4d0)),
    paint(new BoxGeometry(0.05, 0.12, 0.45).translate(-2.2, 0.02, 0.6), new Color(0x900000)),
    paint(new BoxGeometry(0.05, 0.12, 0.45).translate(-2.2, 0.02, -0.6), new Color(0x900000)),
  ];
  for (const x of [-1.35, 1.35]) for (const z of [-0.82, 0.82]) parts.push(paint(new CylinderGeometry(0.34, 0.34, 0.24, 14).rotateX(Math.PI / 2).translate(x, -0.36, z), tyre));
  return merged(parts);
}

const KINDS: Record<ObstacleKind, KindDef> = {
  cone: {
    capacity: 56,
    dynamic: true,
    y: 0.37,
    yaw: 0,
    geo: coneGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
    collider: (R) => coneColliders(R.ColliderDesc),
  },
  barrel: {
    capacity: 12,
    dynamic: true,
    y: 0.45,
    yaw: 0,
    geo: barrelGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 }),
    collider: (R) => R.ColliderDesc.cylinder(0.45, 0.3).setDensity(120).setFriction(0.5).setRestitution(0.15),
  },
  barrier: {
    capacity: 64,
    dynamic: false,
    y: 0.4,
    yaw: 0,
    geo: barrierGeometry,
    mat: () => new MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.95 }),
    collider: (R) => R.ColliderDesc.cuboid(0.95, 0.4, 0.22).setFriction(0.6).setRestitution(0.05),
  },
  roadblock: {
    capacity: 8,
    dynamic: false,
    y: 0.55,
    yaw: Math.PI / 2,
    geo: roadblockGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }),
    collider: (R) => R.ColliderDesc.cuboid(1.5, 0.55, 0.2).setFriction(0.6).setRestitution(0.05),
  },
  bump: {
    capacity: 4,
    dynamic: false,
    y: 0,
    yaw: 0,
    geo: bumpGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    collider: (R) => {
      const pts: number[] = [];
      for (const [x, y] of bumpProfile()) for (const z of [-3.5, 3.5]) pts.push(x, y, z);
      const d = R.ColliderDesc.convexHull(new Float32Array(pts));
      if (!d) throw new Error('Speed bump hull failed');
      return d.setFriction(1);
    },
  },
  crate: {
    capacity: 12,
    dynamic: true,
    y: 0.4,
    yaw: 0,
    geo: crateGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    collider: (R) => R.ColliderDesc.cuboid(0.4, 0.4, 0.4).setDensity(150).setFriction(0.7).setRestitution(0.05),
  },
  slider: {
    capacity: 6,
    dynamic: false,
    kinematic: true,
    y: 0.45,
    yaw: 0,
    geo: sliderGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
    collider: (R) => R.ColliderDesc.cuboid(0.2, 0.45, 1.5).setFriction(0.5).setRestitution(0.05),
  },
  parked: {
    capacity: 8,
    dynamic: false,
    y: 0.7,
    yaw: 0,
    tints: [0x9fb4c8, 0xd9d9d9, 0x5a6b8c, 0xc9a24a, 0x7a2a2a, 0x3c5a3c],
    geo: parkedCarGeometry,
    mat: () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 }),
    collider: (R) => R.ColliderDesc.cuboid(2.2, 0.7, 0.9).setFriction(0.6).setRestitution(0.05),
  },
};

interface Pool {
  kind: ObstacleKind;
  def: KindDef;
  mesh: InstancedMesh;
  bodies: RAPIER.RigidBody[];
  /** Spawn transform of each active body (for reset). */
  initial: Array<{ p: Vector3; q: Quaternion }>;
  active: number;
  /** Per-active-body: penalty already counted for displacing it. */
  hit: boolean[];
  /** Sliders: sweep (unit right vector, amplitude, period, phase) per active body. */
  moves: Array<{ rx: number; rz: number; amp: number; period: number; phase: number } | null>;
}

const PARK = { x: 0, y: -50, z: 0 };

/**
 * Level-specific obstacles: cones and barrels (dynamic, knocked over by the car),
 * concrete barriers, roadblocks and speed bumps (static). Bodies and instanced meshes are
 * pooled and created once, so switching missions never creates or leaks GPU / physics objects;
 * unused bodies are disabled and parked below the world.
 */
export class ObstacleManager {
  readonly group = new Group();
  private readonly pools: Pool[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Material[] = [];
  private readonly m4 = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly tint = new Color();
  /** Course time for the sliders (s since the last reset). */
  private time = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly track: Track,
  ) {
    this.group.name = 'mission-obstacles';
    const { R, world } = physics;
    for (const kind of Object.keys(KINDS) as ObstacleKind[]) {
      const def = KINDS[kind];
      const geo = def.geo();
      const mat = def.mat();
      const mesh = new InstancedMesh(geo, mat, def.capacity);
      mesh.count = 0;
      if (def.dynamic || def.kinematic) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = kind !== 'bump';
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      ownShadowDepth(mesh, this.mats);
      const bodies: RAPIER.RigidBody[] = [];
      for (let k = 0; k < def.capacity; k++) {
        const desc = def.dynamic
          ? R.RigidBodyDesc.dynamic().setLinearDamping(0.1).setAngularDamping(0.3)
          : def.kinematic
            ? R.RigidBodyDesc.kinematicPositionBased()
            : R.RigidBodyDesc.fixed();
        const body = world.createRigidBody(desc.setTranslation(PARK.x, PARK.y - k, PARK.z).setEnabled(false));
        const descs = def.collider(R);
        for (const d of Array.isArray(descs) ? descs : [descs]) world.createCollider(d, body);
        bodies.push(body);
      }
      this.pools.push({ kind, def, mesh, bodies, initial: [], active: 0, hit: [], moves: [] });
      this.geos.push(geo);
      this.mats.push(mat);
      this.group.add(mesh);
    }
  }

  /** World position for a track-relative spec. */
  private place(spec: { i: number; off: number }, out: Vector3): number {
    const t = this.track;
    const k = ((Math.round(spec.i) % t.count) + t.count) % t.count;
    out.set(t.px[k] + t.rx(k) * spec.off, 0, t.pz[k] + t.rz(k) * spec.off);
    return Math.atan2(-t.tz[k], t.tx[k]);
  }

  /** Activate the obstacles of a level (deactivating everything else). */
  load(specs: readonly ObstacleSpec[]): void {
    for (const pool of this.pools) {
      for (let k = 0; k < pool.active; k++) this.park(pool.bodies[k], k);
      pool.active = 0;
      pool.initial.length = 0;
      pool.hit.length = 0;
      pool.moves.length = 0;
    }
    for (const spec of specs) {
      const pool = this.pools.find((p) => p.kind === spec.kind);
      if (!pool) continue;
      if (pool.active >= pool.def.capacity) {
        console.warn(`Obstacle pool full: ${spec.kind}`);
        continue;
      }
      const p = new Vector3();
      const roadYaw = this.place(spec, p);
      p.y = pool.def.y;
      // Model space has +X forward; the road direction yaw rotates +X onto the tangent.
      const q = new Quaternion().setFromAxisAngle(this.up, roadYaw + pool.def.yaw + (spec.yaw ?? 0));
      pool.initial.push({ p, q });
      pool.hit.push(false);
      const t = this.track;
      const k = ((Math.round(spec.i) % t.count) + t.count) % t.count;
      pool.moves.push(
        pool.def.kinematic && spec.move ? { rx: t.rx(k), rz: t.rz(k), amp: spec.move.amp, period: spec.move.period, phase: spec.move.phase ?? 0 } : null,
      );
      if (pool.def.tints) {
        const tint = pool.def.tints[pool.active % pool.def.tints.length];
        pool.mesh.setColorAt(pool.active, this.tint.setHex(tint));
      }
      pool.active++;
    }
    for (const pool of this.pools) {
      pool.mesh.count = pool.active;
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
    this.reset();
  }

  private park(body: RAPIER.RigidBody, k: number): void {
    body.setEnabled(false);
    body.setTranslation({ x: PARK.x, y: PARK.y - k, z: PARK.z }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  /** Restore every active obstacle to its spawn transform (mission restart). */
  reset(): void {
    this.time = 0;
    for (const pool of this.pools) {
      for (let k = 0; k < pool.active; k++) {
        const b = pool.bodies[k];
        const { p, q } = pool.initial[k];
        b.setEnabled(true);
        b.setTranslation(p, false);
        b.setRotation(q, false);
        if (pool.def.dynamic) {
          b.setLinvel({ x: 0, y: 0, z: 0 }, false);
          b.setAngvel({ x: 0, y: 0, z: 0 }, false);
          b.sleep();
        }
        pool.hit[k] = false;
      }
    }
    this.moveSliders(0, true);
    this.sync(true);
  }

  /** Sweep position offset (m) of slider `k` of a pool at course time `t`. */
  static sweep(m: { amp: number; period: number; phase: number }, t: number): number {
    return m.amp * Math.sin(2 * Math.PI * (t / m.period + m.phase));
  }

  /** Advance the moving obstacles; call once per fixed step before world.step(). */
  fixedUpdate(dt: number): void {
    this.time += dt;
    this.moveSliders(this.time, false);
  }

  private moveSliders(t: number, teleport: boolean): void {
    for (const pool of this.pools) {
      if (!pool.def.kinematic) continue;
      for (let k = 0; k < pool.active; k++) {
        const m = pool.moves[k];
        if (!m) continue;
        const d = ObstacleManager.sweep(m, t);
        const p0 = pool.initial[k].p;
        const target = { x: p0.x + m.rx * d, y: p0.y, z: p0.z + m.rz * d };
        // Kinematic bodies are moved by the solver towards the target (pushing what they touch);
        // only a reset places them directly.
        if (teleport) pool.bodies[k].setTranslation(target, false);
        else pool.bodies[k].setNextKinematicTranslation(target);
      }
    }
  }

  /** Current world positions of the active sliders (test / AI use). */
  sliderPositions(out: Array<{ x: number; z: number }>): void {
    out.length = 0;
    const pool = this.pools.find((p) => p.kind === 'slider');
    if (!pool) return;
    for (let k = 0; k < pool.active; k++) {
      const t = pool.bodies[k].translation();
      out.push({ x: t.x, z: t.z });
    }
  }

  /** Copy dynamic body transforms into the instance matrices. */
  sync(force = false): void {
    for (const pool of this.pools) {
      if (!force && !pool.def.dynamic && !pool.def.kinematic) continue;
      let dirty = false;
      for (let k = 0; k < pool.active; k++) {
        const b = pool.bodies[k];
        if (!force && pool.def.dynamic && b.isSleeping()) continue;
        const t = b.translation();
        const r = b.rotation();
        this.v.set(t.x, t.y, t.z);
        this.q.set(r.x, r.y, r.z, r.w);
        this.m4.compose(this.v, this.q, this.s);
        pool.mesh.setMatrixAt(k, this.m4);
        dirty = true;
      }
      if (dirty) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Count dynamic obstacles newly displaced by more than 0.4 m since the last call
   * (each obstacle is counted once per mission attempt). Used for penalties.
   */
  takeNewlyDisplaced(): number {
    let n = 0;
    for (const pool of this.pools) {
      if (!pool.def.dynamic) continue;
      for (let k = 0; k < pool.active; k++) {
        if (pool.hit[k]) continue;
        const b = pool.bodies[k];
        if (b.isSleeping()) continue;
        const t = b.translation();
        const p = pool.initial[k].p;
        if ((t.x - p.x) ** 2 + (t.z - p.z) ** 2 > 0.16 || Math.abs(t.y - p.y) > 0.15) {
          pool.hit[k] = true;
          n++;
        }
      }
    }
    return n;
  }

  /** Active obstacle count per kind (diagnostics / tests). */
  get counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.pools) out[p.kind] = p.active;
    return out;
  }

  /** Number of dynamic obstacles currently away from their spawn point. */
  displacedCount(): number {
    let n = 0;
    for (const pool of this.pools) {
      if (!pool.def.dynamic) continue;
      for (let k = 0; k < pool.active; k++) {
        const t = pool.bodies[k].translation();
        const p = pool.initial[k].p;
        if ((t.x - p.x) ** 2 + (t.z - p.z) ** 2 > 0.16) n++;
      }
    }
    return n;
  }

  /** Spawn positions of active obstacles (used to keep spawn points clear). */
  forEachActive(cb: (x: number, z: number, kind: ObstacleKind) => void): void {
    for (const pool of this.pools) for (let k = 0; k < pool.active; k++) cb(pool.initial[k].p.x, pool.initial[k].p.z, pool.kind);
  }

  dispose(): void {
    for (const pool of this.pools) {
      for (const b of pool.bodies) this.physics.world.removeRigidBody(b);
      pool.mesh.dispose();
    }
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
