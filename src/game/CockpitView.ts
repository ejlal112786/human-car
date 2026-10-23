import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Plane,
  Quaternion,
  Shape,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
  type PerspectiveCamera,
} from 'three';
import type { CarModel } from './CarModel';
import { fovForAspect } from './character/CharacterCamera';
import type { Vehicle } from './Vehicle';

/**
 * In-car (cockpit) view: a simple interior fitted to the current car's body style, and a driver's-head camera
 * that moves with the real chassis motion (g-forces, bumps, impacts, surface, engine). Purely visual: it only
 * reads the vehicle state and never touches physics.
 *
 * Design frame of every car (see CarModel): +X forward, +Y up, +Z right, left-hand drive (driver at z < 0).
 */

// ------------------------------------------------------------------------------------------------ interior

/** Driver's eye in the cabin frame (scaled with the cabin per style). */
const EYE = { x: -0.37, y: 0.975, z: -0.36 };
/** Cabin footprint whose body top is clipped away (body frame; the front edge follows the windscreen). */
const TUB = { rear: -1.25, halfWidth: 0.745, floor: 0.45 };
/** Dashboard profile in the cabin frame (kept under the windscreen glass for every style). */
const DASH_FRONT_X = 0.78;

const MAT = {
  dash: () => new MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.85, metalness: 0.05, side: DoubleSide }),
  trim: () => new MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.7, metalness: 0.1, side: DoubleSide }),
  liner: () => new MeshStandardMaterial({ color: 0x55575c, roughness: 0.95, metalness: 0, side: DoubleSide }),
  seat: () => new MeshStandardMaterial({ color: 0x232427, roughness: 0.9, metalness: 0, side: DoubleSide }),
  rubber: () => new MeshStandardMaterial({ color: 0x111214, roughness: 0.6, metalness: 0.05 }),
  metal: () => new MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.35, metalness: 0.8 }),
};

/** Instrument cluster drawn on a small canvas, redrawn only when a shown value changes (≤ 12 times a second). */
class Cluster {
  readonly canvas = document.createElement('canvas');
  readonly texture: CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D | null;
  private key = '';
  private timer = 0;
  constructor() {
    this.canvas.width = 384;
    this.canvas.height = 144;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
  }

  update(dt: number, kmh: number, rpm: number, redline: number, gear: string, force = false): void {
    this.timer -= dt;
    if (!force && this.timer > 0) return;
    const maxRpm = Math.ceil((redline + 800) / 1000) * 1000;
    const key = `${Math.round(kmh)}|${Math.round(rpm / 50)}|${gear}|${maxRpm}`;
    if (!force && key === this.key) return;
    this.timer = 1 / 12;
    this.key = key;
    const c = this.ctx;
    if (!c) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.fillStyle = '#07080a';
    c.fillRect(0, 0, W, H);
    const dial = (cx: number, value: number, max: number, red: number, step: number, label: string): void => {
      const r = 62;
      const cy = 74;
      const a0 = Math.PI * 0.75;
      const sweep = Math.PI * 1.5;
      c.strokeStyle = '#2a2d33';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();
      for (let v = 0; v <= max + 1e-6; v += step) {
        const a = a0 + (v / max) * sweep;
        c.strokeStyle = v >= red ? '#ff4a3d' : '#d8dde4';
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
        c.lineTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14));
        c.stroke();
      }
      c.fillStyle = '#8b929c';
      c.font = 'bold 12px sans-serif';
      c.textAlign = 'center';
      c.fillText(label, cx, cy + 34);
      const a = a0 + (Math.min(max, Math.max(0, value)) / max) * sweep;
      c.strokeStyle = '#ff7a2a';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
      c.stroke();
      c.fillStyle = '#ff7a2a';
      c.beginPath();
      c.arc(cx, cy, 6, 0, Math.PI * 2);
      c.fill();
    };
    dial(76, rpm, maxRpm, redline, 1000, 'RPM ×1000');
    dial(W - 76, kmh, 280, 999, 20, 'km/h');
    // Centre: gear and digital speed.
    c.textAlign = 'center';
    c.fillStyle = '#f3f5f8';
    c.font = 'bold 54px sans-serif';
    c.fillText(gear, W / 2, 78);
    c.font = 'bold 22px monospace';
    c.fillStyle = '#9fd4ff';
    c.fillText(String(Math.round(kmh)), W / 2, 112);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** The interior meshes for one car body (rebuilt when the driven car's body changes). */
export class CockpitInterior {
  readonly group = new Group();
  /** Driver's eye in the model frame (root of the car model). */
  readonly eye = new Vector3();
  private model: CarModel | null = null;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private wheel: Group | null = null;
  private readonly wheelAxis = new Vector3();
  private readonly wheelBase = new Quaternion();
  private readonly cluster = new Cluster();
  /** Clipping box (model frame) that removes the body top inside the cabin, and its world-space copy. */
  private readonly localPlanes: Plane[] = [];
  private readonly worldPlanes: Plane[] = [];
  private clipped: Material | null = null;
  private shown = false;
  private readonly tmpQ = new Quaternion();
  private readonly v = new Vector3();

  constructor() {
    this.group.name = 'cockpit-interior';
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.shown;
  }

  get builtFor(): CarModel | null {
    return this.model;
  }

  /** Is this world point inside the clipped cabin box (tests)? */
  clipsPoint(world: Vector3): boolean {
    return this.worldPlanes.length > 0 && this.worldPlanes.every((p) => p.distanceToPoint(world) < 0);
  }

  get clipping(): boolean {
    return this.clipped !== null;
  }

  /**
   * Per frame: show / hide for the current car, rebuild when its body changed, clip the body top, turn the
   * steering wheel and refresh the gauges. `vehicle.object` must already hold this frame's transform.
   */
  update(dt: number, vehicle: Vehicle, show: boolean): void {
    if (show && vehicle.model !== this.model) this.build(vehicle.model);
    const on = show && this.model === vehicle.model;
    if (on !== this.shown) {
      this.shown = on;
      this.group.visible = on;
      this.setClip(on ? vehicle.model.paintMaterial : null);
    }
    if (!on) return;
    vehicle.object.updateMatrixWorld();
    const m = vehicle.model.root.matrixWorld;
    for (let i = 0; i < this.localPlanes.length; i++) this.worldPlanes[i].copy(this.localPlanes[i]).applyMatrix4(m);
    const vp = vehicle.physics;
    if (this.wheel) {
      // Hand-wheel angle from the front wheels' angle (≈ 12:1 steering ratio, limited to what the hands can do).
      const steer = (vp.wheels[0].steer + vp.wheels[1].steer) / 2;
      const angle = MathUtils.clamp(steer * 12, -2.6, 2.6);
      this.wheel.quaternion.copy(this.tmpQ.setFromAxisAngle(this.wheelAxis, angle)).multiply(this.wheelBase);
    }
    const d = vp.drivetrain;
    this.cluster.update(dt, Math.abs(vp.forwardSpeed) * 3.6, d.rpm, d.engine.redlineRpm, d.gearLabel);
  }

  private setClip(mat: Material | null): void {
    if (this.clipped && this.clipped !== mat) {
      this.clipped.clippingPlanes = null;
      this.clipped.clipIntersection = false;
      this.clipped.needsUpdate = true;
    }
    this.clipped = mat;
    if (mat) {
      mat.clippingPlanes = this.worldPlanes;
      mat.clipIntersection = true;
      mat.needsUpdate = true;
    }
  }

  private clear(): void {
    this.setClip(null);
    this.shown = false;
    this.group.removeFromParent();
    this.group.clear();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.wheel = null;
  }

  private mat<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private add(geo: BufferGeometry, mat: Material, parent: Group = this.group): Mesh {
    this.geometries.push(geo);
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }

  /** Box between two points (model frame), `w` across and `h` up. */
  private beam(a: Vector3, b: Vector3, w: number, h: number, mat: Material): Mesh {
    const len = a.distanceTo(b);
    const mesh = this.add(new BoxGeometry(len, h, w), mat);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), this.v.copy(b).sub(a).normalize());
    return mesh;
  }

  /** Flat quad through four model-frame corners (double-sided material). */
  private quad(p: Vector3[], mat: Material): Mesh {
    const g = new BufferGeometry();
    const pos = [p[0], p[1], p[2], p[0], p[2], p[3]].flatMap((q) => [q.x, q.y, q.z]);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return this.add(g, mat);
  }

  /** Axis-aligned box from min / max corners (model frame). */
  private block(min: Vector3, max: Vector3, mat: Material): Mesh {
    const mesh = this.add(new BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z), mat);
    mesh.position.copy(min).add(max).multiplyScalar(0.5);
    return mesh;
  }

  private build(model: CarModel): void {
    this.clear();
    this.model = model;
    const P = (x: number, y: number, z: number, cabin: boolean): Vector3 => model.designPoint(x, y, z, cabin, new Vector3());
    const dash = this.mat(MAT.dash());
    const trim = this.mat(MAT.trim());
    const liner = this.mat(MAT.liner());
    const seat = this.mat(MAT.seat());
    const rubber = this.mat(MAT.rubber());
    const metal = this.mat(MAT.metal());

    model.designPoint(EYE.x, EYE.y, EYE.z, true, this.eye);
    const front = P(DASH_FRONT_X, 0.84, 0, true);
    const floorY = P(0, TUB.floor, 0, false).y;
    const hw = P(0, 0, TUB.halfWidth, false).z;
    const rear = P(TUB.rear, 0, 0, false).x;
    const belt = P(0, 0.885, 0, false).y;
    // Liner sits under the roof panel's lowest point (1.13 minus its bevel), so the paint never shows from inside.
    const roofIn = P(-0.45, 1.095, 0, true).y;

    // --- Clip box: body top inside the cabin footprint (below the roof, above the floor).
    const box = { x0: rear, x1: front.x, y0: floorY - 0.02, y1: P(0, 1.11, 0, true).y, z: hw + 0.005 };
    this.localPlanes.length = 0;
    this.localPlanes.push(
      new Plane(new Vector3(1, 0, 0), -box.x1),
      new Plane(new Vector3(-1, 0, 0), box.x0),
      new Plane(new Vector3(0, 1, 0), -box.y1),
      new Plane(new Vector3(0, -1, 0), box.y0),
      new Plane(new Vector3(0, 0, 1), -box.z),
      new Plane(new Vector3(0, 0, -1), -box.z),
    );
    this.worldPlanes.length = 0;
    for (const p of this.localPlanes) this.worldPlanes.push(p.clone());

    // --- Tub: floor, door panels with a sill on top, rear bulkhead (rear seat back).
    this.quad([new Vector3(rear, floorY, -hw), new Vector3(front.x, floorY, -hw), new Vector3(front.x, floorY, hw), new Vector3(rear, floorY, hw)], seat);
    for (const s of [-1, 1]) {
      const z = s * hw;
      this.quad([new Vector3(rear, floorY, z), new Vector3(front.x, floorY, z), new Vector3(front.x, belt, z), new Vector3(rear, belt, z)], trim);
      this.block(new Vector3(rear, belt - 0.012, Math.min(z, z - s * 0.06)), new Vector3(front.x, belt + 0.012, Math.max(z, z - s * 0.06)), dash);
      // arm rest
      this.block(new Vector3(this.eye.x - 0.35, belt - 0.2, s < 0 ? z : z - 0.07), new Vector3(this.eye.x + 0.25, belt - 0.15, s < 0 ? z + 0.07 : z), seat);
    }
    this.quad([new Vector3(rear, floorY, -hw), new Vector3(rear, floorY, hw), new Vector3(rear, belt + 0.04, hw), new Vector3(rear, belt + 0.04, -hw)], seat);

    // --- Dashboard: profile under the windscreen, extruded across the cabin.
    const prof: Array<[number, number, boolean]> = [
      [DASH_FRONT_X, 0.83, true],
      [0.45, 0.865, true],
      [0.28, 0.875, true],
      [0.22, 0.84, true],
      [0.16, 0.68, true],
      [0.1, TUB.floor, false],
    ];
    const shape = new Shape();
    const pts = prof.map(([x, y, c]) => P(x, y, 0, c));
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.lineTo(front.x, floorY);
    shape.closePath();
    const dashGeo = new ExtrudeGeometry(shape, { depth: hw * 2, bevelEnabled: false });
    dashGeo.translate(0, 0, -hw);
    this.add(dashGeo, dash);

    // Low cabins (race car) squash the dash heights; shrink the wheel and cluster with them so the rim stays below the eye line.
    const sy = Math.min(1, Math.max(0.6, (P(0, 1.0, 0, true).y - P(0, 0.8, 0, true).y) / 0.2));
    // --- Instrument cluster behind the wheel, with a hood over it.
    const cl = P(0.27, 0.86, EYE.z, true);
    const clusterMat = this.mat(new MeshBasicMaterial({ map: this.cluster.texture, toneMapped: false }));
    const face = this.add(new BoxGeometry(0.004, 0.105 * sy, 0.28), clusterMat);
    face.position.copy(cl);
    face.rotation.z = -0.32; // lean back towards the driver
    this.cluster.update(0, 0, 900, 6500, 'N', true);
    const hood = this.add(new BoxGeometry(0.13, 0.018, 0.33), dash);
    hood.position.set(cl.x - 0.02, cl.y + 0.065 * sy, cl.z);
    hood.rotation.z = -0.12;

    // --- Steering wheel: rim, hub, three spokes, column into the dash.
    const wc = P(0.07, 0.81, EYE.z, true);
    const wheel = new Group();
    wheel.position.copy(wc);
    wheel.scale.setScalar(sy < 1 ? sy * 0.92 : 1);
    this.group.add(wheel);
    this.add(new TorusGeometry(0.165, 0.017, 10, 40), rubber, wheel);
    const hub = this.add(new CylinderGeometry(0.045, 0.05, 0.04, 16), dash, wheel);
    hub.rotation.x = Math.PI / 2;
    for (const a of [0, Math.PI, -Math.PI / 2]) {
      const sp = this.add(new BoxGeometry(0.15, 0.028, 0.012), trim, wheel);
      sp.position.set(Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0);
      sp.rotation.z = a;
    }
    // Torus lies in its XY plane (axis +Z): turn the axis to point back and up at the driver.
    this.wheelAxis.set(-1, 0.48, 0).normalize();
    this.wheelBase.setFromUnitVectors(new Vector3(0, 0, 1), this.wheelAxis);
    // keep the wheel's "up" (spoke-free top) pointing up after the turn
    const upAfter = new Vector3(0, 1, 0).applyQuaternion(this.wheelBase);
    const upWant = new Vector3(0, 1, 0).projectOnPlane(this.wheelAxis).normalize();
    const twist = new Quaternion().setFromUnitVectors(upAfter.projectOnPlane(this.wheelAxis).normalize(), upWant);
    this.wheelBase.premultiply(twist);
    wheel.quaternion.copy(this.wheelBase);
    this.wheel = wheel;
    const colEnd = P(0.25, 0.74, EYE.z, true);
    const col = this.add(new CylinderGeometry(0.03, 0.035, wc.distanceTo(colEnd), 10), dash);
    col.position.copy(wc).add(colEnd).multiplyScalar(0.5);
    col.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), this.v.copy(colEnd).sub(wc).normalize());

    // --- Centre console with a gear lever.
    this.block(new Vector3(this.eye.x - 0.45, floorY, -0.1), new Vector3(P(0.14, 0, 0, true).x, P(0, 0.62, 0, false).y, 0.1), dash);
    const lever = this.add(new CylinderGeometry(0.008, 0.01, 0.14, 8), metal);
    lever.position.set(this.eye.x + 0.25, P(0, 0.62, 0, false).y + 0.07, 0);
    lever.rotation.z = 0.25;
    const knob = this.add(new CylinderGeometry(0.022, 0.018, 0.04, 12), rubber);
    knob.position.set(this.eye.x + 0.23, P(0, 0.62, 0, false).y + 0.15, 0);

    // --- Seats: driver cushion (seen when looking down), passenger cushion + backrest + headrest.
    const cushionTop = Math.min(this.eye.y - 0.42, P(0, 0.56, 0, false).y);
    for (const s of [-1, 1]) {
      const zc = s * 0.36 * (hw / TUB.halfWidth);
      this.block(new Vector3(this.eye.x - 0.32, floorY, zc - 0.24), new Vector3(this.eye.x + 0.2, cushionTop, zc + 0.24), seat);
      if (s > 0) {
        this.beam(new Vector3(this.eye.x - 0.3, cushionTop, zc), new Vector3(this.eye.x - 0.42, this.eye.y - 0.04, zc), 0.46, 0.09, seat);
        this.block(new Vector3(this.eye.x - 0.5, this.eye.y - 0.02, zc - 0.13), new Vector3(this.eye.x - 0.38, this.eye.y + 0.12, zc + 0.13), seat);
      }
    }

    // --- Glasshouse frame: A-pillars, header, roof liner, side rails, B-pillars.
    for (const s of [-1, 1]) {
      this.beam(P(0.84, 0.83, s * 0.69, true), P(-0.03, 1.1, s * 0.585, true), 0.05, 0.07, trim);
      this.beam(P(-0.03, 1.09, s * 0.585, true), P(-1.0, 1.09, s * 0.59, true), 0.05, 0.04, trim);
      this.beam(P(-0.98, 0.86, s * 0.71, true), P(-1.0, 1.1, s * 0.59, true), 0.09, 0.05, trim);
    }
    this.beam(P(-0.03, 1.09, -0.6, true), P(-0.03, 1.09, 0.6, true), 0.06, 0.04, trim);
    this.quad([P(0.0, 0, -0.62, true).setY(roofIn), P(0.0, 0, 0.62, true).setY(roofIn), P(-1.12, 0, 0.62, true).setY(roofIn), P(-1.12, 0, -0.62, true).setY(roofIn)], liner);

    model.root.add(this.group);
    this.group.visible = false;
    this.shown = false;
  }

  dispose(): void {
    this.clear();
    this.cluster.dispose();
    this.model = null;
  }
}

// ------------------------------------------------------------------------------------------------ camera

/** Head moves this far (m) per m/s² of chassis acceleration (opposite to it), per axis. */
const LAG = { fwd: 0.0055, side: 0.0048, up: 0.0035 };
const LAG_MAX = { fwd: 0.07, side: 0.06, up: 0.03 };
/** Neck: spring stiffness (rad/s) and damping ratio. */
const NECK_W = 9;
const NECK_Z = 0.6;
const BASE_FOV = 62;

function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}

/** Driver's-head camera. `sample` runs on the fixed step (reads the chassis), `update` every frame. */
export class CockpitCamera {
  /** Motion multiplier: 1 full, 0.45 reduced, 0 off (Settings → Camera motion). The chassis' own roll / pitch stay. */
  motion = 1;
  /** Head offset (car frame: x forward, y up, z right) and its velocity. */
  readonly offset = new Vector3();
  private readonly vel = new Vector3();
  /** Low-passed chassis acceleration (car frame, m/s²). */
  readonly accel = new Vector3();
  private readonly prevV = new Vector3();
  private hasPrev = false;
  private readonly prevSusp = [0, 0, 0, 0];
  private bump = 0;
  private kickAmt = 0;
  private time = 0;
  private yaw = 0;
  private pitch = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private release = 0;
  private dragging = false;
  private fov = BASE_FOV;
  private readonly q = new Quaternion();
  private readonly qi = new Quaternion();
  private readonly e = new Euler(0, 0, 0, 'YXZ');
  private readonly v = new Vector3();
  private readonly w = new Vector3();
  /** Last frame's shake / rumble levels (tests and controller rumble). */
  readonly level = { vibration: 0, road: 0, bump: 0 };

  constructor(private readonly camera: PerspectiveCamera) {}

  reset(): void {
    this.offset.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    this.hasPrev = false;
    this.bump = 0;
    this.kickAmt = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.yaw = 0;
    this.pitch = 0;
  }

  /** Collision jolt (same scale as the chase camera's shake). */
  kick(amount: number): void {
    this.kickAmt = Math.min(0.3, Math.max(this.kickAmt, amount));
    this.vel.y += amount * 0.6 * this.motion;
  }

  /** Fixed step: chassis acceleration in the car frame and suspension hits. */
  sample(vehicle: Vehicle, dt: number): void {
    const vp = vehicle.physics;
    const lv = vp.body.linvel();
    const r = vp.body.rotation();
    if (this.hasPrev && dt > 0) {
      this.v.set((lv.x - this.prevV.x) / dt, (lv.y - this.prevV.y) / dt, (lv.z - this.prevV.z) / dt);
      this.qi.set(r.x, r.y, r.z, r.w).invert();
      this.v.applyQuaternion(this.qi);
      // Ignore physically impossible spikes (resets, teleports) and smooth step noise.
      if (this.v.lengthSq() < 60 * 60) this.accel.lerp(this.v, damp(18, dt));
    }
    this.prevV.set(lv.x, lv.y, lv.z);
    this.hasPrev = true;
    // Suspension compressing fast = the wheel hit something (kerb, bump, landing).
    for (let i = 0; i < 4; i++) {
      const len = vp.wheels[i].suspension;
      const rate = (len - this.prevSusp[i]) / dt;
      this.prevSusp[i] = len;
      if (rate < -0.6) this.bump = Math.min(1, this.bump + (-rate - 0.6) * 0.08);
    }
    this.level.bump = this.bump;
    this.bump *= Math.exp(-dt * 14);
  }

  /** Recent suspension hit 0..1 (also drives controller rumble in the chase view). */
  get bumpLevel(): number {
    return this.level.bump;
  }

  /** Mouse / touch / right-stick look (springs back a moment after release). */
  input(dx: number, dy: number, dragging: boolean): void {
    if (dx || dy) {
      this.lookYaw = MathUtils.clamp(this.lookYaw - dx * 0.006, -1.9, 1.9);
      this.lookPitch = MathUtils.clamp(this.lookPitch - dy * 0.004, -0.55, 0.45);
    }
    if (this.dragging && !dragging) this.release = 1;
    this.dragging = dragging;
  }

  update(dt: number, vehicle: Vehicle, eye: Vector3): void {
    const vp = vehicle.physics;
    const m = this.motion;
    this.time += dt;
    if (m === 0) {
      // Camera motion Off: the head is fixed to the seat (the chassis' own pitch and roll remain).
      this.offset.set(0, 0, 0);
      this.vel.set(0, 0, 0);
    } else if (dt > 0) {
      // Head lags behind the chassis: target opposite to the acceleration, through a damped neck spring.
      const a = this.accel;
      this.w.set(
        MathUtils.clamp(-a.x * LAG.fwd, -LAG_MAX.fwd, LAG_MAX.fwd),
        MathUtils.clamp(-(a.y) * LAG.up, -LAG_MAX.up, LAG_MAX.up),
        MathUtils.clamp(-a.z * LAG.side, -LAG_MAX.side, LAG_MAX.side),
      ).multiplyScalar(m);
      // Bumps: vertical jolt from the suspension, decaying.
      if (this.level.bump > 0.01) this.vel.y += this.level.bump * 0.9 * m * Math.min(1, dt * 60);
      // Integrate the neck in fixed substeps so the head moves at the same speed at 10 fps and at 144 fps.
      const n = Math.min(12, Math.ceil(dt / (1 / 120)));
      const h = dt / n;
      for (let k = 0; k < n; k++) {
        this.vel.addScaledVector(this.v.copy(this.w).sub(this.offset), NECK_W * NECK_W * h);
        this.vel.multiplyScalar(Math.max(0, 1 - 2 * NECK_Z * NECK_W * h));
        this.offset.addScaledVector(this.vel, h);
      }
      this.offset.x = MathUtils.clamp(this.offset.x, -LAG_MAX.fwd, LAG_MAX.fwd);
      this.offset.y = MathUtils.clamp(this.offset.y, -LAG_MAX.up, LAG_MAX.up);
      this.offset.z = MathUtils.clamp(this.offset.z, -LAG_MAX.side, LAG_MAX.side);
    }

    // Small fast motion: engine vibration (rpm, throttle) and road texture by surface and speed.
    const d = vp.drivetrain;
    const rpmK = Math.min(1, d.rpm / d.engine.redlineRpm);
    const vib = (0.0005 + 0.0011 * d.appliedThrottle) * rpmK * m;
    const speed = Math.abs(vp.forwardSpeed);
    let rough = 0;
    for (let i = 0; i < 4; i++) {
      const k = vp.surfaceKind[i];
      rough += (k === 'grass' ? 1 : k === 'pavement' ? 0.35 : 0.12) * (vp.wheels[i].contact ? 1 : 0);
    }
    const road = (rough / 4) * Math.min(1, speed / 25) * 0.006 * m;
    this.level.vibration = vib;
    this.level.road = road;
    const t = this.time;
    const kick = this.kickAmt * m;
    this.kickAmt *= Math.exp(-dt * 7);
    const jx = Math.sin(t * 97) * vib + Math.sin(t * 13.1) * road + Math.sin(t * 71) * kick * 0.08;
    const jy = Math.sin(t * 131 + 1.3) * vib + Math.sin(t * 9.7 + 0.4) * road * 1.6 + Math.sin(t * 53 + 1.3) * kick * 0.1;

    // Look: drag springs back; the head also turns slightly into corners (towards the apex).
    if (!this.dragging) {
      if (this.release > 0) this.release -= dt;
      else {
        const k = damp(3, dt);
        this.lookYaw -= this.lookYaw * k;
        this.lookPitch -= this.lookPitch * k;
      }
    }
    const apex = MathUtils.clamp(vp.yawRate * 0.12, -0.18, 0.18) * Math.min(1, speed / 8);
    this.yaw += (apex - this.yaw) * damp(4, dt);
    // Head tilts against the side force and nods under braking (on top of the chassis' own roll and pitch).
    const roll = MathUtils.clamp(this.accel.z * 0.0032, -0.05, 0.05) * m;
    this.pitch += (MathUtils.clamp(this.accel.x * 0.0022, -0.04, 0.03) * m - this.pitch) * damp(6, dt);

    // Pose: car frame → world (the camera looks along its −Z, the car's forward is +X).
    const obj = vehicle.object;
    this.v.copy(eye).add(vehicle.model.root.position);
    this.v.x += this.offset.x;
    this.v.y += this.offset.y + jy;
    this.v.z += this.offset.z + jx;
    obj.localToWorld(this.camera.position.copy(this.v));
    this.e.set(-0.07 + this.pitch + this.lookPitch + jy * 2, -Math.PI / 2 + this.yaw + this.lookYaw, roll + jx * 2);
    this.q.setFromEuler(this.e);
    this.camera.quaternion.copy(obj.quaternion).multiply(this.q);

    const targetFov = BASE_FOV + 4 * Math.min(1, speed / 60);
    this.fov += (targetFov - this.fov) * (dt > 0 ? damp(2.5, dt) : 1);
    const fov = fovForAspect(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
