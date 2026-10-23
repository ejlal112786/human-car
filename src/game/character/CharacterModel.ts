import {
  AdditiveBlending,
  AnimationMixer,
  Matrix4,
  DoubleSide,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type Object3D,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import characterUrl from '../../assets/character.glb?url';
import { CHARACTER } from './CharacterController';
import { BoneMap, CROUCH_DROP, POSES, applyTargets, type PoseName } from './Poses';
import { PISTOL_POINTS, createPistol, slideOffset } from '../crime/PistolMesh';

/**
 * Natural ground speed of the in-place Walk / Run clips (m/s at timeScale 1), measured from the
 * foot travel during the stance phase. Playback speed is scaled from these so feet don't slide.
 */
const WALK_CLIP_SPEED = 1.4;
const RUN_CLIP_SPEED = 3.7;
/** Phases (0..1) at which a foot plants in each clip (footstep sounds). */
const WALK_STEPS = [0.4, 0.98];
const RUN_STEPS = [0.37, 0.85];

export interface LoadedCharacter {
  scene: Group;
  clips: AnimationClip[];
}

/** Load the character asset (bundled with the game; no external URLs). */
export async function loadCharacter(): Promise<LoadedCharacter> {
  const gltf = await new GLTFLoader().loadAsync(characterUrl);
  return { scene: gltf.scene, clips: gltf.animations };
}

function smooth(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/**
 * Visual side of the player character: the rigged, skinned human
 * ("Animated Human" by Quaternius, CC0) with a speed-driven idle → walk → run blend,
 * a jump clip while airborne, footstep events, and a fade used for the car transition.
 */
export class CharacterModel {
  readonly root = new Group();
  private readonly mixer: AnimationMixer;
  private readonly idle: AnimationAction;
  private readonly walk: AnimationAction;
  private readonly run: AnimationAction;
  private readonly jump: AnimationAction;
  private readonly materials: Material[] = [];
  private readonly meshes: Mesh[] = [];
  /** Shared phase of the walk/run cycle (0..1) so the two clips stay in step while blending. */
  private phase = 0;
  private walkW = 0;
  private runW = 0;
  private airW = 0;
  private opacity = 1;
  /** Called with 0..1 intensity when a foot plants. */
  onFootstep: ((intensity: number) => void) | null = null;
  /** Procedural pose weights layered over the clips (0..1 each; see Poses.ts). */
  readonly overlay: Record<PoseName, number> = { lowReady: 0, aim: 0, holsterReach: 0, reload: 0, handsUp: 0, phone: 0, crouch: 0 };
  /** Aim pitch (rad, + = up) and recoil kick (0..1) for the aim pose. */
  aimPitch = 0;
  recoil = 0;
  /** Gun in the right hand (else in the hip holster). */
  gunInHand = false;
  /** Sidearm mesh (visible while the character is). */
  readonly gun = new Group();
  private readonly muzzle: Mesh;
  private gunSlide: Group | null = null;
  /** Seconds since the last shot (set from the weapon's fixed-step clock) and whether the slide is locked back (empty). */
  sinceShot = 99;
  slideLocked = false;
  /** First-person sights view: the body is drawn only into the shadow map, the hand gun is hidden. */
  private firstPerson = false;
  private muzzleTime = 0;
  private readonly bones: BoneMap;
  private readonly model: Object3D;
  private readonly frameQ = new Quaternion();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly qTmp = new Quaternion();
  private readonly gunBasis = new Matrix4();

  constructor(scene: Scene, asset: LoadedCharacter) {
    this.root.name = 'player-character';
    const model = asset.scene;
    model.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      // The capsule keeps the character next to the camera; skinned bounds are bind-pose only.
      m.frustumCulled = false;
      const mat = m.material as MeshStandardMaterial;
      this.materials.push(mat);
      const depth = new MeshDepthMaterial();
      m.customDepthMaterial = depth;
      this.materials.push(depth);
      this.meshes.push(m);
    });
    this.root.add(model);
    scene.add(this.root);
    this.model = model;
    this.bones = new BoneMap(model);
    this.muzzle = this.buildGun();

    this.mixer = new AnimationMixer(model);
    const clip = (name: string): AnimationClip => {
      const c = asset.clips.find((x) => x.name === name);
      if (!c) throw new Error(`Character animation missing: ${name}`);
      return c;
    };
    this.idle = this.mixer.clipAction(clip('Idle'));
    this.walk = this.mixer.clipAction(clip('Walk'));
    this.run = this.mixer.clipAction(clip('Run'));
    this.jump = this.mixer.clipAction(clip('Jump'));
    for (const a of [this.idle, this.walk, this.run]) {
      a.setLoop(LoopRepeat, Infinity);
      a.play();
    }
    // Walk and run are driven by the shared phase, not by the mixer clock.
    this.walk.timeScale = 0;
    this.run.timeScale = 0;
    this.jump.setLoop(LoopOnce, 1);
    this.jump.clampWhenFinished = true;
    this.jump.play();
    this.jump.setEffectiveWeight(0);
    this.applyWeights();
    this.mixer.update(0);
  }

  /** Restart the jump clip (from the take-off, skipping its wind-up). */
  startJump(): void {
    this.jump.reset();
    this.jump.time = 0.22;
    this.jump.play();
  }

  /**
   * Advance animation. `speed` = horizontal speed (m/s), `turnSpeed` = rad/s of facing change,
   * `airborne` = not on the ground.
   */
  update(dt: number, speed: number, turnSpeed: number, airborne: boolean): void {
    // Turning on the spot steps the feet a little (no dedicated turn clip in the asset).
    const effective = Math.max(speed, Math.min(1.2, turnSpeed * 0.25));
    const walkRef = CHARACTER.walkSpeed;
    const runRef = CHARACTER.runSpeed;
    let walkT: number;
    let runT: number;
    if (effective <= walkRef) {
      walkT = Math.min(1, effective / (walkRef * 0.6));
      runT = 0;
    } else {
      runT = Math.min(1, (effective - walkRef) / (runRef - walkRef));
      walkT = 1 - runT;
    }
    this.walkW = smooth(this.walkW, walkT, 10, dt);
    this.runW = smooth(this.runW, runT, 10, dt);
    this.airW = smooth(this.airW, airborne ? 1 : 0, airborne ? 12 : 9, dt);

    // Cycle rate: blend of the two clips' cadence at the current speed.
    const walkRate = (Math.max(effective, 0.5) / WALK_CLIP_SPEED) / this.walk.getClip().duration;
    const runRate = (Math.max(effective, 2.5) / RUN_CLIP_SPEED) / this.run.getClip().duration;
    const moving = this.walkW + this.runW;
    const rate = moving > 1e-3 ? (walkRate * this.walkW + runRate * this.runW) / moving : walkRate;
    const prev = this.phase;
    if (moving > 0.05 && !airborne) this.phase = (this.phase + rate * dt) % 1;
    this.walk.time = this.phase * this.walk.getClip().duration;
    this.run.time = this.phase * this.run.getClip().duration;

    // Footsteps at foot-plant phases.
    if (this.onFootstep && !airborne && moving > 0.3 && this.phase !== prev) {
      const steps = this.runW > this.walkW ? RUN_STEPS : WALK_STEPS;
      for (const s of steps) {
        const crossed = prev <= this.phase ? prev < s && this.phase >= s : prev < s || this.phase >= s;
        if (crossed) this.onFootstep(Math.min(1, 0.35 + effective / runRef));
      }
    }
    this.applyWeights();
    this.mixer.update(dt);
    this.applyOverlay(dt);
  }

  /** Sidearm (bundled CC0 pistol model with a moving slide) + additive muzzle flash; model forward = +Z. */
  private buildGun(): Mesh {
    const pistol = createPistol(true);
    this.materials.push(...pistol.materials);
    this.gunSlide = pistol.slide;
    this.gun.add(pistol.root);
    const flashMat = new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.materials.push(flashMat);
    const flash = new Mesh(new PlaneGeometry(0.16, 0.16), flashMat);
    const cross = new Mesh(new PlaneGeometry(0.16, 0.16), flashMat);
    cross.rotation.y = Math.PI / 2;
    const tip = new Mesh(new PlaneGeometry(0.09, 0.09), flashMat);
    tip.rotation.x = Math.PI / 2;
    flash.add(cross, tip);
    flash.rotation.x = 0;
    flash.position.set(0, PISTOL_POINTS.muzzleY, PISTOL_POINTS.muzzleZ + 0.06);
    flash.visible = false;
    this.gun.add(flash);
    this.gun.name = 'sidearm';
    this.gun.visible = false;
    this.root.add(this.gun);
    return flash;
  }

  /** Show the muzzle flash for a few frames. */
  flash(): void {
    this.muzzleTime = 0.05;
    this.muzzle.rotation.z = Math.random() * Math.PI;
    this.muzzle.scale.setScalar(0.8 + Math.random() * 0.5);
  }

  /** World position and velocity of a casing leaving the ejection port of the hand gun. */
  ejection(pos: Vector3, vel: Vector3): void {
    pos.set(PISTOL_POINTS.ejectX, PISTOL_POINTS.ejectY, PISTOL_POINTS.ejectZ);
    this.gun.localToWorld(pos);
    this.gun.getWorldQuaternion(this.qTmp);
    vel.set(-1.6 - Math.random() * 0.6, 1.3 + Math.random() * 0.5, -0.4).applyQuaternion(this.qTmp);
  }

  /** World position of the muzzle (effects). */
  muzzleWorld(out: Vector3): Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  /** Layer the procedural poses over the clip pose, then place the gun in the hand or the holster. */
  private applyOverlay(dt: number): void {
    const o = this.overlay;
    this.model.position.y = -CROUCH_DROP * o.crouch;
    this.root.updateMatrixWorld(true);
    this.root.getWorldQuaternion(this.frameQ);
    applyTargets(this.bones, POSES.crouch, this.frameQ, o.crouch);
    applyTargets(this.bones, POSES.holsterReach, this.frameQ, o.holsterReach);
    applyTargets(this.bones, POSES.lowReady, this.frameQ, o.lowReady);
    applyTargets(this.bones, POSES.aim, this.frameQ, o.aim, this.aimPitch + this.recoil * 0.22);
    applyTargets(this.bones, POSES.reload, this.frameQ, o.reload);
    applyTargets(this.bones, POSES.handsUp, this.frameQ, o.handsUp);
    applyTargets(this.bones, POSES.phone, this.frameQ, o.phone);
    this.muzzleTime -= dt;
    if (this.gunSlide) this.gunSlide.position.z = -slideOffset(this.sinceShot, this.slideLocked && this.gunInHand);
    this.muzzle.visible = this.muzzleTime > 0 && this.gunInHand && !this.firstPerson;
    this.placeGun();
  }

  /** Direction from `bone` to `child` in the character root frame (+Z = facing, +Y = up); tests / diagnostics. */
  boneDir(bone: string, child: string): [number, number, number] {
    const b = this.bones.get(bone);
    const c = this.bones.get(child);
    if (!b || !c) return [0, 0, 0];
    const p = b.getWorldPosition(new Vector3());
    const d = c.getWorldPosition(new Vector3()).sub(p).normalize();
    d.applyQuaternion(this.root.getWorldQuaternion(new Quaternion()).invert());
    return [d.x, d.y, d.z];
  }

  private placeGun(): void {
    const hand = this.bones.get('RightHand');
    const fore = this.bones.get('RightForeArm');
    const hips = this.bones.get('Hips');
    if (!hand || !fore || !hips) return;
    if (this.gunInHand) {
      // Barrel along the forearm → hand line, slightly ahead of the palm.
      fore.getWorldPosition(this.v1);
      hand.getWorldPosition(this.v2);
      this.v3.subVectors(this.v2, this.v1).normalize();
      this.v2.addScaledVector(this.v3, 0.07);
      this.root.worldToLocal(this.v2);
      this.gun.position.copy(this.v2);
      this.qTmp.copy(this.frameQ).invert();
      this.v3.applyQuaternion(this.qTmp);
      // Full basis (barrel = +Z along the forearm, grip = −Y towards the ground) so the gun
      // never rolls sideways; root-local up is (0, 1, 0) because the root stays upright.
      const z = this.v3;
      const x = this.v1.set(0, 1, 0).cross(z);
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
      x.normalize();
      const y = this.v2.crossVectors(z, x);
      this.gunBasis.makeBasis(x, y, z);
      this.gun.quaternion.setFromRotationMatrix(this.gunBasis);
    } else {
      // Holster on the right hip, barrel down.
      hips.getWorldPosition(this.v1);
      this.root.worldToLocal(this.v1);
      this.gun.position.set(-0.19, this.v1.y - 0.08, 0.02);
      this.gun.quaternion.setFromAxisAngle(this.v3.set(1, 0, 0), Math.PI / 2);
    }
  }

  private applyWeights(): void {
    const ground = 1 - this.airW;
    const moving = Math.min(1, this.walkW + this.runW);
    this.idle.setEffectiveWeight(ground * (1 - moving));
    this.walk.setEffectiveWeight(ground * this.walkW);
    this.run.setEffectiveWeight(ground * this.runW);
    this.jump.setEffectiveWeight(this.airW);
  }

  /** Reset to the idle pose (spawn, exit vehicle). */
  resetPose(): void {
    this.walkW = 0;
    this.runW = 0;
    this.airW = 0;
    this.phase = 0;
    for (const k of Object.keys(this.overlay) as PoseName[]) this.overlay[k] = 0;
    this.applyWeights();
    this.mixer.update(0);
    this.applyOverlay(0);
  }

  /** 0 = invisible, 1 = opaque. Used for the fade into / out of the car. */
  setOpacity(o: number): void {
    const v = Math.max(0, Math.min(1, o));
    if (v === this.opacity) return;
    this.opacity = v;
    this.root.visible = v > 0.01;
    this.gun.visible = this.gunShown && v > 0.5 && !this.firstPerson;
    for (const m of this.meshes) {
      const mat = m.material as MeshStandardMaterial;
      mat.transparent = v < 0.999;
      mat.opacity = v;
      mat.depthWrite = v > 0.5 && !this.firstPerson;
      m.castShadow = v > 0.5;
    }
  }

  private gunShown = false;
  /** The player carries the sidearm (holstered or in hand). */
  setGunShown(on: boolean): void {
    this.gunShown = on;
    this.gun.visible = on && this.opacity > 0.5 && !this.firstPerson;
  }
  /**
   * First-person sights view: the body stays in the shadow map (the player still casts a shadow) but is
   * not drawn into the colour / depth buffers, so the camera at eye height doesn't see the inside of
   * the head; the third-person gun is hidden (the view model replaces it).
   */
  setFirstPerson(on: boolean): void {
    if (on === this.firstPerson) return;
    this.firstPerson = on;
    for (const m of this.meshes) {
      const mat = m.material as MeshStandardMaterial;
      mat.colorWrite = !on;
      mat.depthWrite = !on && this.opacity > 0.5;
    }
    this.gun.visible = this.gunShown && this.opacity > 0.5 && !on;
  }

  get isFirstPerson(): boolean {
    return this.firstPerson;
  }


  setVisible(v: boolean): void {
    this.setOpacity(v ? 1 : 0);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const mat of this.materials) {
      (mat as MeshStandardMaterial).map?.dispose();
      mat.dispose();
    }
    this.root.removeFromParent();
  }
}
