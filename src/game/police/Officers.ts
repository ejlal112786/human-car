import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharacterController, CHARACTER } from '../character/CharacterController';
import type { CharacterModel, LoadedCharacter } from '../character/CharacterModel';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { Vehicle } from '../Vehicle';

/**
 * Police officers on foot: a small pool of real characters (Rapier kinematic capsule + character
 * controller, so they collide with buildings, cars and the player) wearing a recoloured uniform and a cap.
 * They get out of a stopped unit near a player on foot, run to the player with the sidearm drawn and stop
 * at arm's length; they walk back and get in when the player drives off or the pursuit ends. One can stand
 * guard behind a roadblock. Shot or run into by the player's car they go down (stylised, no injury detail)
 * and get up again. The arrest sequence drives them through `script` mode.
 */

export const OFFICER_POOL = 4;
/** Officers stop this far from the player (m). */
export const OFFICER_STANDOFF = 1.5;
/** Sidearm drawn and aimed within this distance of the player (m). */
const AIM_RANGE = 14;
/** Officers go back to their car when the player (driving) is further than this (m)… */
const RECALL_DRIVING = 26;
/** …or when they are this far from their car (m). */
const LEASH = 70;
/** A returning officer that can't reach the door in this time just gets in (s). */
const RETURN_TIMEOUT = 12;
/** Knocked down for this long (s). */
const DOWN_TIME = 5;
/** Fade in / out at the car door (s). */
const FADE_TIME = 0.35;

export type OfficerMode = 'off' | 'chase' | 'guard' | 'return' | 'down' | 'script';

export interface Officer {
  readonly id: number;
  readonly ctrl: CharacterController;
  readonly model: CharacterModel | null;
  readonly cap: Group | null;
  mode: OfficerMode;
  /** Unit (car) index the officer belongs to. */
  unit: number;
  /** Seconds in the current mode. */
  t: number;
  /** Mode to resume after getting up. */
  resume: OfficerMode;
  /** Pose weights (blended in the fixed step so test stepping shows them). */
  aimW: number;
  lowW: number;
  handsW: number;
  /** Visibility fade (door). */
  fade: number;
  fadeDir: number;
  /** Knocked-down tilt (0..1). */
  tilt: number;
  /** Unsticking: sidestep timer / direction, time spent blocked. */
  sideT: number;
  sideDir: number;
  slowT: number;
  /** Which side of the car the officer uses (+1 / −1 along the car's local Z). */
  side: number;
  /** Guard post (roadblock). */
  postX: number;
  postZ: number;
  /** Script mode target (arrest sequence): walk / run to (x, z); face `faceYaw` when there (null = movement). */
  goX: number;
  goZ: number;
  goRun: boolean;
  faceYaw: number | null;
  /** Script mode: the sidearm is aimed at the player. */
  scriptAim: boolean;
}

export interface OfficerContext {
  /** Player position (feet) and whether they are on foot. */
  px: number;
  py: number;
  pz: number;
  onFoot: boolean;
  /** Pursuit / search in progress (officers act); false = everybody goes back to the cars. */
  chasing: boolean;
  /** The player's car while driving (officers dive away from / are knocked down by it), else null. */
  car: Vehicle | null;
}

const SRC = { shirt: [198, 47, 43], pants: [44, 58, 87] } as const;
const UNIFORM = { shirt: [30, 46, 92], pants: [26, 30, 42] } as const;

export interface UniformColours {
  readonly shirt: readonly number[];
  readonly pants: readonly number[];
}

/** First texture map found on the character asset (the shared palette), or null. */
export function characterPalette(scene: Object3D): Texture | null {
  let src: Texture | null = null;
  scene.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (m.isMesh && !src) src = (m.material as MeshStandardMaterial).map ?? null;
  });
  return src;
}

/**
 * Clone of the character asset wearing `tex` (from {@link uniformTexture}); materials are per clone,
 * the texture is shared. Used for officers and jail guards.
 */
export function uniformedClone(asset: LoadedCharacter, tex: Texture | null): LoadedCharacter {
  const body = cloneSkinned(asset.scene) as Group;
  body.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mat = (m.material as MeshStandardMaterial).clone();
    if (tex) mat.map = tex;
    m.material = mat;
  });
  return { scene: body, clips: asset.clips };
}

/** The character palette texture with the shirt / trousers swapped for the uniform (same method as the pedestrian outfits). */
export function uniformTexture(src: Texture, uniform: UniformColours = UNIFORM): CanvasTexture | null {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  if (!img || !img.width || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  const px = data.data;
  const pairs: Array<[readonly number[], readonly number[]]> = [
    [SRC.shirt, uniform.shirt],
    [SRC.pants, uniform.pants],
  ];
  for (let i = 0; i < px.length; i += 4) {
    for (const [from, to] of pairs) {
      if (Math.abs(px[i] - from[0]) + Math.abs(px[i + 1] - from[1]) + Math.abs(px[i + 2] - from[2]) < 10) {
        px[i] = to[0];
        px[i + 1] = to[1];
        px[i + 2] = to[2];
        break;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.flipY = src.flipY;
  tex.colorSpace = src.colorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.needsUpdate = true;
  return tex;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function approach(cur: number, target: number, rate: number, dt: number): number {
  const d = target - cur;
  const m = rate * dt;
  return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
}

export class Officers {
  readonly list: Officer[] = [];
  /** Officers knocked down by the player since the last drain (police offences). */
  readonly knocked: Array<'shot' | 'car'> = [];
  private readonly sharedMats: Material[] = [];
  private readonly sharedGeo: Array<BoxGeometry | CylinderGeometry> = [];
  private readonly sharedTex: Texture[] = [];
  private readonly v = new Vector3();
  private readonly head = new Vector3();
  private readonly heads = new Map<number, Object3D | null>();

  /**
   * `makeModel` builds a character model from a (cloned) asset; null = headless (physics only, no models).
   * Injected so this module does not import the bundled model file.
   */
  constructor(
    physics: PhysicsWorld,
    asset: LoadedCharacter | null,
    makeModel: ((asset: LoadedCharacter) => CharacterModel) | null,
  ) {
    let tex: CanvasTexture | null = null;
    let capParts: { crown: CylinderGeometry; brim: BoxGeometry; band: CylinderGeometry; mat: MeshStandardMaterial; badge: MeshStandardMaterial; badgeGeo: BoxGeometry } | null = null;
    if (makeModel && asset) {
      const src = characterPalette(asset.scene);
      if (src) tex = uniformTexture(src);
      if (tex) this.sharedTex.push(tex);
      const mat = new MeshStandardMaterial({ color: 0x1a2440, roughness: 0.7 });
      const badge = new MeshStandardMaterial({ color: 0xd8b84a, roughness: 0.35, metalness: 0.7 });
      capParts = {
        crown: new CylinderGeometry(0.115, 0.12, 0.085, 14),
        band: new CylinderGeometry(0.122, 0.122, 0.03, 14),
        brim: new BoxGeometry(0.17, 0.014, 0.09),
        badgeGeo: new BoxGeometry(0.04, 0.035, 0.01),
        mat,
        badge,
      };
      this.sharedGeo.push(capParts.crown, capParts.band, capParts.brim, capParts.badgeGeo);
      this.sharedMats.push(mat, badge);
    }
    for (let k = 0; k < OFFICER_POOL; k++) {
      const ctrl = new CharacterController(physics);
      ctrl.setEnabled(false);
      let model: CharacterModel | null = null;
      let cap: Group | null = null;
      if (makeModel && asset && capParts) {
        model = makeModel(uniformedClone(asset, tex));
        model.root.name = 'police-officer';
        model.setGunShown(true);
        model.setVisible(false);
        cap = new Group();
        cap.name = 'officer-cap';
        const crown = new Mesh(capParts.crown, capParts.mat);
        crown.position.y = 0.04;
        const band = new Mesh(capParts.band, capParts.mat);
        const brim = new Mesh(capParts.brim, capParts.mat);
        brim.position.set(0, -0.005, 0.1);
        const badge = new Mesh(capParts.badgeGeo, capParts.badge);
        badge.position.set(0, 0.03, 0.12);
        for (const m of [crown, band, brim, badge]) m.castShadow = true;
        cap.add(crown, band, brim, badge);
        // Sized for the asset's large low-poly head.
        cap.scale.setScalar(1.5);
        model.root.add(cap);
      }
      this.list.push({
        id: k,
        ctrl,
        model,
        cap,
        mode: 'off',
        unit: -1,
        t: 0,
        resume: 'chase',
        aimW: 0,
        lowW: 0,
        handsW: 0,
        fade: 0,
        fadeDir: 0,
        tilt: 0,
        sideT: 0,
        sideDir: 1,
        slowT: 0,
        side: 1,
        postX: 0,
        postZ: 0,
        goX: 0,
        goZ: 0,
        goRun: false,
        faceYaw: null,
        scriptAim: false,
      });
    }
  }

  /** Officers out of their cars (any mode but off). */
  get outCount(): number {
    let n = 0;
    for (const o of this.list) if (o.mode !== 'off') n++;
    return n;
  }

  countFor(unit: number): number {
    let n = 0;
    for (const o of this.list) if (o.mode !== 'off' && o.unit === unit) n++;
    return n;
  }

  /**
   * Get an officer out of `car` (unit `unit`). `side` picks the door (+1 / −1 along the car's local Z);
   * `mode` chase = go for the player, guard = stand at (postX, postZ). Returns null when the pool is used up.
   */
  deploy(unit: number, car: Vehicle, side: number, mode: 'chase' | 'guard', postX = 0, postZ = 0): Officer | null {
    const o = this.list.find((x) => x.mode === 'off');
    if (!o) return null;
    const p = car.physicsPosition;
    const r = car.physics.body.rotation();
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
    const fz = 2 * (r.x * r.z - r.w * r.y);
    const fl = Math.hypot(fx, fz) || 1;
    const lx = -fz / fl;
    const lz = fx / fl;
    const feet = this.v.set(p.x + lx * side * 1.55 + (fx / fl) * 0.25, Math.max(0, p.y - car.physics.car.rideHeight), p.z + lz * side * 1.55 + (fz / fl) * 0.25);
    o.ctrl.setEnabled(true);
    o.ctrl.teleport(feet, Math.atan2(lx * side, lz * side));
    o.mode = mode;
    o.unit = unit;
    o.t = 0;
    o.side = side;
    o.postX = postX;
    o.postZ = postZ;
    o.fade = 0;
    o.fadeDir = 1;
    o.tilt = 0;
    o.aimW = 0;
    o.lowW = 0;
    o.handsW = 0;
    o.sideT = 0;
    o.slowT = 0;
    o.faceYaw = null;
    o.scriptAim = false;
    o.ctrl.faceYaw = null;
    if (o.model) {
      o.model.resetPose();
      o.model.setVisible(true);
      o.model.setOpacity(0.01);
    }
    return o;
  }

  /** Send the officers of `unit` (or all, unit < 0) back to their cars. */
  recall(unit = -1): void {
    for (const o of this.list) {
      if (o.mode === 'off' || o.mode === 'return' || (unit >= 0 && o.unit !== unit)) continue;
      if (o.mode === 'down') {
        o.resume = 'return';
        continue;
      }
      this.setMode(o, 'return');
    }
  }

  /** Remove everybody at once (police switched off, level change). */
  clear(): void {
    for (const o of this.list) this.off(o);
  }

  /** Nearest standing officer (chasing / guarding / scripted) to (x, z), Infinity if none. */
  nearest(x: number, z: number): number {
    let best = Infinity;
    for (const o of this.list) {
      if (o.mode !== 'chase' && o.mode !== 'guard' && o.mode !== 'script') continue;
      best = Math.min(best, Math.hypot(o.ctrl.position.x - x, o.ctrl.position.z - z));
    }
    return best;
  }

  /** Officer index owning a collider, or −1. */
  byCollider(handle: number): number {
    for (const o of this.list) if (o.mode !== 'off' && o.ctrl.collider.handle === handle) return o.id;
    return -1;
  }

  /** The player shot officer `i`: knocked down (stylised), gets up after DOWN_TIME. */
  hit(i: number): void {
    const o = this.list[i];
    if (!o || o.mode === 'off' || o.mode === 'down') return;
    this.knockDown(o);
    this.knocked.push('shot');
  }

  private knockDown(o: Officer): void {
    if (o.mode !== 'script') o.resume = o.mode === 'return' ? 'return' : o.mode;
    else o.resume = 'chase';
    this.setMode(o, 'down');
    o.ctrl.setEnabled(false);
  }

  private setMode(o: Officer, m: OfficerMode): void {
    o.mode = m;
    o.t = 0;
    o.sideT = 0;
    o.slowT = 0;
  }

  private off(o: Officer): void {
    o.mode = 'off';
    o.unit = -1;
    o.t = 0;
    o.fade = 0;
    o.fadeDir = 0;
    o.ctrl.setEnabled(false);
    o.model?.setVisible(false);
  }

  /** Arrest sequence: take direct control of officer `i` (walk / run to a point, aim or not). */
  script(i: number, x: number, z: number, run: boolean, faceYaw: number | null, aim: boolean): void {
    const o = this.list[i];
    if (!o || o.mode === 'off') return;
    if (o.mode === 'down') {
      o.resume = 'script';
    } else if (o.mode !== 'script') this.setMode(o, 'script');
    o.goX = x;
    o.goZ = z;
    o.goRun = run;
    o.faceYaw = faceYaw;
    o.scriptAim = aim;
  }

  /** One fixed step, before world.step(). `cars(k)` = the unit's car if that unit is active, else null. */
  fixedUpdate(dt: number, ctx: OfficerContext, cars: (k: number) => Vehicle | null): void {
    for (const o of this.list) {
      if (o.mode === 'off') continue;
      o.t += dt;
      o.fade = Math.max(0, Math.min(1, o.fade + (o.fadeDir * dt) / FADE_TIME));
      const car = o.unit >= 0 ? cars(o.unit) : null;

      if (o.mode === 'down') {
        o.tilt = Math.min(1, o.tilt + dt * 4);
        o.aimW = approach(o.aimW, 0, 6, dt);
        o.lowW = approach(o.lowW, 0, 6, dt);
        if (o.t >= DOWN_TIME) {
          o.ctrl.setEnabled(true);
          o.ctrl.teleport(o.ctrl.position, o.ctrl.yaw);
          this.setMode(o, o.resume === 'down' ? 'chase' : o.resume);
        }
        o.ctrl.prevPosition.copy(o.ctrl.position);
        o.ctrl.prevYaw = o.ctrl.yaw;
        continue;
      }
      o.tilt = Math.max(0, o.tilt - dt * 2);

      // The player's car: an officer in its path goes down (they would otherwise be an immovable post).
      if (ctx.car && this.carHits(o, ctx.car, dt)) {
        this.knockDown(o);
        this.knocked.push('car');
        continue;
      }

      // Mode changes.
      const dPlayer = Math.hypot(ctx.px - o.ctrl.position.x, ctx.pz - o.ctrl.position.z);
      if (o.mode === 'chase' || o.mode === 'guard') {
        const leash = car ? Math.hypot(car.physicsPosition.x - o.ctrl.position.x, car.physicsPosition.z - o.ctrl.position.z) : 0;
        const driveOff = o.mode === 'chase' && !ctx.onFoot && dPlayer > RECALL_DRIVING;
        if (!ctx.chasing || !car || driveOff || leash > LEASH) this.setMode(o, 'return');
        else if (o.mode === 'guard' && ctx.onFoot && dPlayer < 25) this.setMode(o, 'chase');
      }

      let tx = o.ctrl.position.x;
      let tz = o.ctrl.position.z;
      let run = false;
      let stopAt = 0.3;
      let aim = false;
      let face: number | null = null;
      if (o.mode === 'chase') {
        tx = ctx.px;
        tz = ctx.pz;
        stopAt = OFFICER_STANDOFF;
        run = dPlayer > 5;
        aim = dPlayer < AIM_RANGE && o.t > 0.6;
        if (dPlayer < AIM_RANGE) face = Math.atan2(ctx.px - o.ctrl.position.x, ctx.pz - o.ctrl.position.z);
      } else if (o.mode === 'guard') {
        tx = o.postX;
        tz = o.postZ;
        stopAt = 0.4;
        face = Math.atan2(ctx.px - o.ctrl.position.x, ctx.pz - o.ctrl.position.z);
        aim = dPlayer < 32;
      } else if (o.mode === 'return') {
        if (!car) {
          // The car left (stuck recovery / despawn): walk off and get picked up out of the way.
          if (o.t > 2) this.off(o);
          continue;
        }
        const p = car.physicsPosition;
        const r = car.physics.body.rotation();
        const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
        const fz = 2 * (r.x * r.z - r.w * r.y);
        const fl = Math.hypot(fx, fz) || 1;
        tx = p.x + (-fz / fl) * o.side * 1.45;
        tz = p.z + (fx / fl) * o.side * 1.45;
        run = Math.hypot(tx - o.ctrl.position.x, tz - o.ctrl.position.z) > 6;
        const at = Math.hypot(tx - o.ctrl.position.x, tz - o.ctrl.position.z) < 0.9;
        if ((at || o.t > RETURN_TIMEOUT) && o.fadeDir >= 0) o.fadeDir = -1;
        if (o.fadeDir < 0 && o.fade <= 0) {
          this.off(o);
          continue;
        }
      } else if (o.mode === 'script') {
        tx = o.goX;
        tz = o.goZ;
        run = o.goRun;
        stopAt = 0.25;
        aim = o.scriptAim;
        face = o.faceYaw;
      }

      // Steering towards (tx, tz) with a sidestep when blocked.
      let dx = tx - o.ctrl.position.x;
      let dz = tz - o.ctrl.position.z;
      const d = Math.hypot(dx, dz);
      let mx = 0;
      let mz = 0;
      if (d > stopAt) {
        dx /= d;
        dz /= d;
        const mag = Math.min(1, (d - stopAt) / 0.6 + 0.25);
        if (o.sideT > 0) {
          o.sideT -= dt;
          mx = (dx * 0.35 - dz * o.sideDir) * mag;
          mz = (dz * 0.35 + dx * o.sideDir) * mag;
        } else {
          mx = dx * mag;
          mz = dz * mag;
        }
        if (mag > 0.5 && o.ctrl.actualSpeed < 0.35 && o.t > 0.5) o.slowT += dt;
        else o.slowT = Math.max(0, o.slowT - dt);
        if (o.slowT > 0.5) {
          o.slowT = 0;
          o.sideT = 0.9;
          o.sideDir = -o.sideDir;
        }
      } else o.slowT = 0;
      // Hold position while fading in at the door.
      if (o.fadeDir > 0 && o.fade < 1) {
        mx = 0;
        mz = 0;
      }
      o.ctrl.faceYaw = face !== null && d <= stopAt + 2.5 ? face : face !== null && aim ? face : null;
      o.ctrl.step(dt, mx, mz, run && !aim, false);
      o.aimW = approach(o.aimW, aim ? 1 : 0, 4, dt);
      o.lowW = approach(o.lowW, !aim && o.mode !== 'return' ? 0.6 : 0, 3, dt);
    }
  }

  /** True when the moving car is about to run into officer `o` (oriented box around the car, ahead by its speed). */
  private carHits(o: Officer, car: Vehicle, dt: number): boolean {
    const vp = car.physics;
    const speed = Math.abs(vp.forwardSpeed);
    if (speed < 4) return false;
    const p = car.physicsPosition;
    const r = vp.body.rotation();
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
    const fz = 2 * (r.x * r.z - r.w * r.y);
    const fl = Math.hypot(fx, fz) || 1;
    const ox = o.ctrl.position.x - p.x;
    const oz = o.ctrl.position.z - p.z;
    const along = (ox * fx + oz * fz) / fl;
    const side = (ox * -fz + oz * fx) / fl;
    const reach = 2.35 + CHARACTER.radius + speed * dt * 3;
    const ahead = vp.forwardSpeed >= 0 ? along > -2.3 && along < reach : along < 2.3 && along > -reach;
    return ahead && Math.abs(side) < 1.0 + CHARACTER.radius;
  }

  /** Interpolated transforms and animation (render frame). */
  render(alpha: number, dt: number): void {
    for (const o of this.list) {
      const m = o.model;
      if (!m || o.mode === 'off') continue;
      const c = o.ctrl;
      m.root.position.lerpVectors(c.prevPosition, c.position, alpha);
      const yaw = c.prevYaw + wrap(c.yaw - c.prevYaw) * alpha;
      m.root.rotation.order = 'YXZ';
      m.root.rotation.set(-o.tilt * 1.35, yaw, 0);
      m.setOpacity(o.fade);
      m.overlay.aim = o.aimW;
      m.overlay.lowReady = o.lowW * (1 - o.aimW);
      m.overlay.handsUp = o.handsW;
      m.gunInHand = o.aimW > 0.3 || o.lowW > 0.3;
      m.aimPitch = 0;
      m.update(dt, o.mode === 'down' ? 0 : c.actualSpeed, c.turnSpeed, false);
      // Cap on the head bone, kept level in the character frame.
      if (o.cap) {
        let head = this.heads.get(o.id);
        if (head === undefined) {
          head = m.root.getObjectByName('Head') ?? null;
          this.heads.set(o.id, head);
        }
        if (head) {
          head.getWorldPosition(this.head);
          m.root.worldToLocal(this.head);
          o.cap.position.set(this.head.x, this.head.y + 0.27, this.head.z + 0.01);
        }
      }
    }
  }

  dispose(): void {
    for (const o of this.list) {
      o.ctrl.dispose();
      o.model?.dispose();
    }
    for (const g of this.sharedGeo) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    for (const t of this.sharedTex) t.dispose();
  }
}
