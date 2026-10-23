import {
  AdditiveBlending,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../PhysicsWorld';
import { PISTOL_POINTS, createPistol, slideOffset, type PistolInstance } from './PistolMesh';

/** Distance (m) from the eye to the rear sight in the sights view. */
export const ADS_REAR_SIGHT_DIST = 0.34;
/** The view model takes over from the third-person gun above this sights blend. */
export const ADS_VIEW_THRESHOLD = 0.6;
/** Closest wall distance (m) before the gun is pulled back ("tucked") so it never pokes through walls. */
const TUCK_DIST = 0.62;

const MAX_CASINGS = 16;
const CASING_LIFE = 5;

interface Casing {
  p: Vector3;
  v: Vector3;
  spin: Vector3;
  rot: Euler;
  age: number;
  floor: number;
  resting: boolean;
}

/**
 * Spent brass: thrown out of the ejection port to the right, they bounce on the ground and lie
 * there for a few seconds. One instanced mesh, fixed pool (oldest reused), no physics bodies.
 */
export class Casings {
  readonly mesh: InstancedMesh;
  private readonly list: Casing[] = [];
  private next = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);
  private readonly hidden = new Matrix4().makeScale(0, 0, 0);

  constructor(scene: Scene) {
    const g = new CylinderGeometry(0.0045, 0.0045, 0.019, 6);
    const mat = new MeshStandardMaterial({ color: 0xc9a54a, roughness: 0.35, metalness: 0.85 });
    this.mesh = new InstancedMesh(g, mat, MAX_CASINGS);
    this.mesh.name = 'casings';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX_CASINGS; i++) {
      this.mesh.setMatrixAt(i, this.hidden);
      this.list.push({ p: new Vector3(), v: new Vector3(), spin: new Vector3(), rot: new Euler(), age: CASING_LIFE, floor: 0, resting: true });
    }
    scene.add(this.mesh);
  }

  /** Eject one casing at `pos` with velocity `vel`; it lands on the ground at height `floor`. */
  eject(pos: Vector3, vel: Vector3, floor: number): void {
    const c = this.list[this.next];
    this.next = (this.next + 1) % MAX_CASINGS;
    c.p.copy(pos);
    c.v.copy(vel);
    c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 20, 18 + Math.random() * 12);
    c.rot.set(0, 0, Math.PI / 2);
    c.age = 0;
    c.floor = floor + 0.0045;
    c.resting = false;
  }

  /** Number of casings currently visible (tests). */
  get active(): number {
    return this.list.filter((c) => c.age < CASING_LIFE).length;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    let any = false;
    for (let i = 0; i < MAX_CASINGS; i++) {
      const c = this.list[i];
      if (c.age >= CASING_LIFE) continue;
      any = true;
      c.age += dt;
      if (c.age >= CASING_LIFE) {
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      if (!c.resting) {
        c.v.y -= 9.81 * dt;
        c.p.addScaledVector(c.v, dt);
        c.rot.x += c.spin.x * dt;
        c.rot.y += c.spin.y * dt;
        c.rot.z += c.spin.z * dt;
        if (c.p.y < c.floor) {
          c.p.y = c.floor;
          // Brass bounces a little and skitters; settles lying on its side.
          c.v.y = -c.v.y * 0.32;
          c.v.x *= 0.55;
          c.v.z *= 0.55;
          c.spin.multiplyScalar(0.5);
          if (Math.abs(c.v.y) < 0.35) {
            c.resting = true;
            c.rot.set(0, c.rot.y, Math.PI / 2);
          }
        }
      }
      this.q.setFromEuler(c.rot);
      this.m.compose(c.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Remove every casing (level change). */
  clear(): void {
    for (let i = 0; i < MAX_CASINGS; i++) {
      this.list[i].age = CASING_LIFE;
      this.mesh.setMatrixAt(i, this.hidden);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Inputs for one frame of the sights view. */
export interface AdsFrame {
  /** 0..1 sights blend from the character camera. */
  ads: number;
  /** 0..1 recoil from the weapon. */
  recoil: number;
  sinceShot: number;
  /** Magazine empty → slide locked back. */
  empty: boolean;
  /** Character horizontal speed (m/s) for the walking bob. */
  speed: number;
  /** Collider to ignore in the wall check (the player's capsule). */
  self: RAPIER.Collider | null;
}

/**
 * First-person "view model" for aiming down the sights: the same CC0 pistol, held in two gloved hands,
 * placed in camera space so the rear and front sights line up exactly on the screen centre (where the
 * shot goes). Raises in from below as the camera reaches the eye, kicks back on each shot, the slide
 * cycles (and locks back on an empty magazine), and the gun is pulled back near walls.
 */
export class AdsView {
  readonly root = new Group();
  private readonly pistol: PistolInstance;
  private readonly flash: Mesh;
  private readonly materials: Material[] = [];
  private tuck = 0;
  private bobT = 0;
  private readonly ray: RAPIER.Ray;
  private readonly off = new Vector3();
  private readonly qx = new Quaternion();
  private readonly qFlip = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  private readonly fwd = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly ax = new Vector3(1, 0, 0);
  private readonly az = new Vector3(0, 0, 1);

  constructor(
    scene: Scene,
    private readonly physics: PhysicsWorld,
  ) {
    this.root.name = 'ads-view';
    this.pistol = createPistol(false);
    this.materials.push(...this.pistol.materials);
    this.root.add(this.pistol.root);
    this.buildHands();
    const flashMat = new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.materials.push(flashMat);
    this.flash = new Mesh(new PlaneGeometry(0.09, 0.09), flashMat);
    const cross = new Mesh(this.flash.geometry, flashMat);
    cross.rotation.y = Math.PI / 2;
    this.flash.add(cross);
    this.flash.position.set(0, PISTOL_POINTS.muzzleY, PISTOL_POINTS.muzzleZ + 0.035);
    this.flash.visible = false;
    this.pistol.root.add(this.flash);
    this.root.visible = false;
    scene.add(this.root);
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  /** Two-handed grip: gloves + sleeves (simple shapes; most of the arms are below the view). */
  private buildHands(): void {
    const glove = new MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.9 });
    const sleeve = new MeshStandardMaterial({ color: 0x2f3a4f, roughness: 0.92 });
    this.materials.push(glove, sleeve);
    const add = (m: Mesh, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Mesh => {
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      this.pistol.root.add(m);
      return m;
    };
    // Thumbs-forward two-hand grip from rounded shapes (model +X = the gun's left side).
    const palm = new SphereGeometry(1, 14, 10);
    const finger = new CapsuleGeometry(0.0075, 0.03, 4, 8);
    const thumb = new CapsuleGeometry(0.0072, 0.038, 4, 8);
    // Shooting hand: back of the hand flat on the backstrap, web right under the slide.
    add(new Mesh(palm, glove), -0.004, -0.05, -0.03, -0.3).scale.set(0.016, 0.03, 0.011);
    // Support hand: heel on the left grip panel …
    add(new Mesh(palm, glove), 0.021, -0.052, -0.01, -0.3).scale.set(0.01, 0.03, 0.026);
    // … its fingers wrapped round the front of the grip under the trigger guard (stacked, slightly angled).
    for (let k = 0; k < 4; k++) {
      const y = -0.03 - k * 0.0155;
      add(new Mesh(finger, glove), 0.003, y, 0.016 - k * 0.004, 0, 0, Math.PI / 2);
    }
    // Both thumbs along the left of the frame, pointing at the target.
    add(new Mesh(thumb, glove), 0.0155, 0.003, 0.004, Math.PI / 2 - 0.06);
    add(new Mesh(thumb, glove), 0.0175, -0.011, 0.022, Math.PI / 2 - 0.1);
    // Forearms from the wrists back, down and out to the elbows (a V into the lower corners of the view;
    // model −X = the shooter's right).
    const arm = (wx: number, wy: number, wz: number, ex: number, ey: number, ez: number): void => {
      const w = new Vector3(wx, wy, wz);
      const e = new Vector3(ex, ey, ez);
      const len = w.distanceTo(e);
      const m = new Mesh(new CylinderGeometry(0.019, 0.03, len, 10), sleeve);
      m.position.copy(w).add(e).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), e.clone().sub(w).normalize());
      this.pistol.root.add(m);
    };
    arm(-0.006, -0.068, -0.042, -0.2, -0.26, -0.3);
    arm(0.024, -0.07, -0.026, 0.21, -0.25, -0.27);
  }

  /** Current slide travel (m, back = positive) and gun tuck (0..1); tests. */
  get slide(): number {
    return -this.pistol.slide.position.z;
  }

  get tuckAmount(): number {
    return this.tuck;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** World position of the muzzle (tracer / effects origin while in the sights view). */
  muzzleWorld(out: Vector3): Vector3 {
    return this.flash.getWorldPosition(out);
  }

  /** World position and a world velocity for a casing leaving the ejection port. */
  ejection(pos: Vector3, vel: Vector3): void {
    pos.set(PISTOL_POINTS.ejectX, PISTOL_POINTS.ejectY, PISTOL_POINTS.ejectZ);
    this.pistol.root.localToWorld(pos);
    this.pistol.root.getWorldQuaternion(this.tmpQ);
    // Model −X is the right side of the gun; out to the right, up and slightly back.
    vel.set(-1.6 - Math.random() * 0.6, 1.3 + Math.random() * 0.5, -0.4).applyQuaternion(this.tmpQ);
  }

  /** Per render frame, after the camera has been placed. */
  update(dt: number, camera: PerspectiveCamera, f: AdsFrame): void {
    const show = f.ads > ADS_VIEW_THRESHOLD;
    this.root.visible = show;
    if (!show) {
      this.tuck = 0;
      return;
    }
    const k = Math.min(1, (f.ads - ADS_VIEW_THRESHOLD) / (1 - ADS_VIEW_THRESHOLD));
    const raise = 1 - k * k * (3 - 2 * k);

    // Wall check along the view: pull the gun back and tilt it up when something is very close.
    camera.getWorldDirection(this.fwd);
    const o = this.ray.origin;
    o.x = camera.position.x;
    o.y = camera.position.y;
    o.z = camera.position.z;
    const d = this.ray.dir;
    d.x = this.fwd.x;
    d.y = this.fwd.y;
    d.z = this.fwd.z;
    const F = this.physics.R.QueryFilterFlags;
    const hit = this.physics.world.castRay(this.ray, TUCK_DIST, true, F.EXCLUDE_SENSORS, undefined, f.self ?? undefined);
    const want = hit ? Math.min(1, (TUCK_DIST - hit.timeOfImpact) / (TUCK_DIST - 0.25)) : 0;
    this.tuck += (want - this.tuck) * (dt > 0 ? 1 - Math.exp(-14 * dt) : 1);

    if (dt > 0) this.bobT += dt * (1.5 + Math.min(4, f.speed) * 1.4);
    const bob = Math.min(1, f.speed / 3) * 0.004;
    const r = f.recoil;
    // Camera space: +X right, +Y up, −Z forward. The model's +Z (barrel) is flipped to −Z.
    this.off.set(
      0.055 * raise + Math.sin(this.bobT) * bob,
      -PISTOL_POINTS.sightY - 0.075 * raise + 0.006 * r - 0.1 * this.tuck - Math.abs(Math.cos(this.bobT)) * bob,
      -(ADS_REAR_SIGHT_DIST - PISTOL_POINTS.rearSightZ) + 0.026 * r + 0.08 * this.tuck,
    );
    this.root.position.copy(this.off).applyQuaternion(camera.quaternion).add(camera.position);
    // Muzzle climb + raise tilt + tuck tilt (camera-space X), small cant while raising.
    // (tuck: low ready — muzzle tipped down, out of the middle of the view)
    this.qx.setFromAxisAngle(this.ax, 0.11 * r + 0.25 * raise - 0.7 * this.tuck);
    this.tmpQ.setFromAxisAngle(this.az, -0.25 * raise);
    this.root.quaternion.copy(camera.quaternion).multiply(this.qx).multiply(this.tmpQ).multiply(this.qFlip);

    this.pistol.slide.position.z = -slideOffset(f.sinceShot, f.empty);
    this.flash.visible = f.sinceShot < 0.05;
    if (this.flash.visible) this.flash.rotation.z = Math.random() * Math.PI;
    this.root.updateMatrixWorld(true);
  }

  /** Sights in world space for tests: rear and front sight tops, and the camera they should line up for. */
  sightWorld(rear: Vector3, front: Vector3): void {
    rear.set(0, PISTOL_POINTS.sightY, PISTOL_POINTS.rearSightZ);
    front.set(0, PISTOL_POINTS.sightY, PISTOL_POINTS.frontSightZ);
    this.pistol.root.localToWorld(rear);
    this.pistol.root.localToWorld(front);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.tmp.set(0, 0, 0);
  }
}
