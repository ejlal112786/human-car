import {
  AnimationMixer,
  CanvasTexture,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  NearestFilter,
  Quaternion,
  RGBADepthPacking,
  RGBAFormat,
  Vector3,
  BufferGeometry,
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  type AnimationClip,
  type Material,
  MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { LoadedCharacter } from '../character/CharacterModel';
import { ROAD } from '../config';
import { BoneMap, POSES, applyTargets, type PoseName } from '../character/Poses';
import { CrowdPose } from './CrowdPose';
import { PED_VARIANT_COUNT, PedMode, type Pedestrian } from './PedestrianSystem';

/** Ground speeds of the in-place clips (same measurements as the player model). */
const WALK_CLIP_SPEED = 1.4;
const RUN_CLIP_SPEED = 3.7;
const SIDEWALK_Y = ROAD.surfaceY + ROAD.sidewalkHeight;
const CURB = ROAD.halfWidth + ROAD.curbWidth;
/** Beyond this distance pedestrians are hidden (they are tiny and fogged anyway). */
const VISIBLE_DIST = 125;
/** Within this distance the body casts a shadow. */
const NEAR_DIST = 38;
/** Bake rate of the animation texture (frames per second of clip time). */
export const BAKE_FPS = 30;
/** Clips used by the crowd, in bake order. */
export const CLIPS = ['Idle', 'Walk', 'Run', 'Jump', 'HandsUp', 'Phone'] as const;
type ClipName = (typeof CLIPS)[number];
/** Held poses generated from the idle clip plus a procedural arm layer (the asset has no such clips). */
const POSE_CLIPS: Partial<Record<ClipName, PoseName>> = { HandsUp: 'handsUp', Phone: 'phone' };
/** Knocked down: the body is laid flat over this time (s), non-graphic. */
const FALL_TIME = 0.45;
/**
 * Mid-transition poses (idle ↔ walk ↔ run) of people within this distance are solved exactly on the CPU
 * (see CrowdPose); farther away the GPU mixes the two baked poses, whose limb shortening is sub-pixel there.
 */
const EXACT_BLEND_DIST = 60;
/** Exactly blended poses per frame (rows of the dynamic pose texture). */
const EXACT_BLEND_SLOTS = 24;
/** Stumble plays the jump clip from this point (skips the crouch). */
const STUMBLE_START = 0.15;

/** Palette colours in the asset texture → outfit variants (shirt, trousers, hair, skin). */
const SRC = { shirt: [198, 47, 43], pants: [44, 58, 87], hair: [74, 47, 27], skin: [255, 209, 159] } as const;
type RGB = readonly [number, number, number];
const OUTFITS: ReadonlyArray<{ shirt: RGB; pants: RGB; hair: RGB; skin: RGB }> = [
  { shirt: [40, 72, 140], pants: [168, 148, 108], hair: [30, 25, 22], skin: [241, 194, 150] },
  { shirt: [58, 138, 88], pants: [40, 40, 48], hair: [110, 70, 40], skin: [198, 140, 100] },
  { shirt: [228, 188, 62], pants: [44, 58, 87], hair: [208, 168, 92], skin: [255, 215, 172] },
  { shirt: [222, 222, 216], pants: [30, 30, 34], hair: [28, 24, 22], skin: [140, 96, 66] },
  { shirt: [118, 70, 150], pants: [108, 108, 118], hair: [60, 40, 28], skin: [226, 176, 132] },
  { shirt: [224, 120, 52], pants: [36, 46, 82], hair: [150, 150, 150], skin: [255, 206, 162] },
  // Woman: softer blouse and dark trousers; simple skirt accessory is layered over the shared rig.
  { shirt: [188, 102, 146], pants: [48, 53, 78], hair: [38, 28, 24], skin: [227, 176, 137] },
  // Shorter teen skater in a vivid hoodie, with a board carried at their side.
  { shirt: [64, 190, 206], pants: [37, 42, 66], hair: [45, 33, 25], skin: [238, 192, 151] },
  // Motorbike rider in a dark jacket with a bright helmet.
  { shirt: [46, 55, 63], pants: [32, 34, 39], hair: [92, 40, 30], skin: [204, 145, 106] },
  // Shopkeeper with a light apron.
  { shirt: [194, 127, 75], pants: [64, 59, 51], hair: [42, 29, 20], skin: [232, 183, 142] },
  // Roadside mechanic in high-visibility workwear.
  { shirt: [220, 178, 34], pants: [45, 53, 65], hair: [38, 30, 26], skin: [198, 143, 111] },
  // Delivery courier with a bright pack and helmet.
  { shirt: [190, 61, 48], pants: [39, 44, 50], hair: [70, 45, 30], skin: [225, 175, 133] },
];

/**
 * One texture with every outfit: the palette texture recoloured once per outfit (exact palette swatches,
 * so skin and clothes stay separate) and stacked vertically. Instances pick their band by UV offset.
 * The source uses nearest filtering, so neighbouring bands never bleed into each other.
 */
function outfitAtlas(src: Texture): CanvasTexture | null {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  if (!img || !img.width || typeof document === 'undefined') return null;
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h * OUTFITS.length;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  for (let k = 0; k < OUTFITS.length; k++) {
    // Band k must be sampled at v in [k/N, (k+1)/N]; with flipY the image is uploaded bottom-up.
    const y = (src.flipY ? OUTFITS.length - 1 - k : k) * h;
    ctx.drawImage(img, 0, y);
    const data = ctx.getImageData(0, y, w, h);
    const px = data.data;
    const o = OUTFITS[k];
    const pairs: Array<[RGB, RGB]> = [
      [SRC.shirt, o.shirt],
      [SRC.pants, o.pants],
      [SRC.hair, o.hair],
      [SRC.skin, o.skin],
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
    ctx.putImageData(data, 0, y);
  }
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

interface ClipBake {
  /** First texture row of the clip. */
  row: number;
  frames: number;
  duration: number;
}

/**
 * Bake every clip into a float texture of skinning matrices: one row per frame, four texels (columns
 * of a mat4) per bone. Each matrix maps a bind-pose vertex straight to the model's root space, i.e.
 * meshWorld · bindMatrixInverse · boneWorld · boneInverse · bindMatrix — exactly what three's own
 * skinning does — so the instance matrix only has to place, turn and scale the person.
 */
export function bakeAnimations(asset: LoadedCharacter): { texture: DataTexture; clips: Record<ClipName, ClipBake>; mesh: SkinnedMesh; pose: CrowdPose; exactRow0: number } {
  const model = cloneSkinned(asset.scene) as Group;
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.set(1, 1, 1);
  let mesh: SkinnedMesh | null = null;
  model.traverse((o: Object3D) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && !mesh) mesh = m;
  });
  if (!mesh) throw new Error('Character model has no skinned mesh');
  const skinned = mesh as SkinnedMesh;
  const bones = skinned.skeleton.bones;
  const inverses = skinned.skeleton.boneInverses;
  const mixer = new AnimationMixer(model);
  const clipOf = (name: string): AnimationClip => {
    const c = asset.clips.find((x) => x.name === name);
    if (!c) throw new Error(`Character animation missing: ${name}`);
    return c;
  };
  const info = {} as Record<ClipName, ClipBake>;
  let rows = 0;
  for (const name of CLIPS) {
    const c = clipOf(POSE_CLIPS[name] ? 'Idle' : name);
    const frames = POSE_CLIPS[name] ? 2 : Math.max(2, Math.round(c.duration * BAKE_FPS));
    info[name] = { row: rows, frames, duration: POSE_CLIPS[name] ? 1 : c.duration };
    rows += frames;
  }
  const boneMap = new BoneMap(model);
  const ident = new Quaternion();
  const width = bones.length * 4;
  // The last EXACT_BLEND_SLOTS rows are rewritten every frame with exactly blended poses.
  const data = new Float32Array(width * (rows + EXACT_BLEND_SLOTS) * 4);
  const pose = new CrowdPose(skinned, rows);
  const head = new Matrix4();
  const m = new Matrix4();
  for (const name of CLIPS) {
    const b = info[name];
    const poseName = POSE_CLIPS[name];
    const action = mixer.clipAction(clipOf(poseName ? 'Idle' : name));
    action.play();
    for (let f = 0; f < b.frames; f++) {
      // Loops wrap (frame `frames` == frame 0); the one-shot jump ends exactly on its last key.
      const t = poseName ? 0 : name === 'Jump' ? (f / (b.frames - 1)) * b.duration : (f / b.frames) * b.duration;
      action.time = Math.min(t, b.duration - 1e-4);
      mixer.update(0);
      model.updateMatrixWorld(true);
      if (poseName) applyTargets(boneMap, POSES[poseName], ident, 1);
      head.copy(skinned.matrixWorld).multiply(skinned.bindMatrixInverse);
      pose.capture(b.row + f, skinned, head);
      for (let j = 0; j < bones.length; j++) {
        m.multiplyMatrices(bones[j].matrixWorld, inverses[j]).premultiply(head).multiply(skinned.bindMatrix);
        m.toArray(data, ((b.row + f) * width + j * 4) * 4);
      }
    }
    action.stop();
  }
  mixer.uncacheRoot(model);
  const texture = new DataTexture(data, width, rows + EXACT_BLEND_SLOTS, RGBAFormat, FloatType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, clips: info, mesh: skinned, pose, exactRow0: rows };
}

/**
 * Vertex-shader patch shared by the colour and shadow materials: blend two pose rows of the animation
 * texture (aCrowd.x / aCrowd.y with weight aCrowd.z) and offset the UVs into the outfit band aCrowd.w.
 */
function patchCrowdShader(shader: WebGLProgramParametersWithUniforms, anim: DataTexture, variants: number): void {
  shader.uniforms.crowdAnim = { value: anim };
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <skinning_pars_vertex>',
      `uniform highp sampler2D crowdAnim;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aCrowd;
mat4 crowdBone(int row, float bone) {
  int x = int(bone) * 4;
  return mat4(texelFetch(crowdAnim, ivec2(x, row), 0), texelFetch(crowdAnim, ivec2(x + 1, row), 0),
              texelFetch(crowdAnim, ivec2(x + 2, row), 0), texelFetch(crowdAnim, ivec2(x + 3, row), 0));
}
mat4 crowdPose(float row) {
  int r = int(row);
  return skinWeight.x * crowdBone(r, skinIndex.x) + skinWeight.y * crowdBone(r, skinIndex.y)
       + skinWeight.z * crowdBone(r, skinIndex.z) + skinWeight.w * crowdBone(r, skinIndex.w);
}`,
    )
    .replace(
      '#include <skinbase_vertex>',
      'mat4 crowdM = aCrowd.z < 0.004 ? crowdPose(aCrowd.x) : aCrowd.z > 0.996 ? crowdPose(aCrowd.y) : crowdPose(aCrowd.x) * (1.0 - aCrowd.z) + crowdPose(aCrowd.y) * aCrowd.z;',
    )
    .replace('#include <skinnormal_vertex>', 'objectNormal = (crowdM * vec4(objectNormal, 0.0)).xyz;')
    .replace('#include <skinning_vertex>', 'transformed = (crowdM * vec4(transformed, 1.0)).xyz;')
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.y = (vMapUv.y + aCrowd.w) / ${variants.toFixed(1)};\n#endif`);
}

interface PedAnim {
  phase: number;
  walkW: number;
  runW: number;
  idleT: number;
  /** Seconds since the stumble began (< 0 when not stumbling). */
  jumpT: number;
}

/**
 * Draws the pedestrian crowd as GPU-instanced skinned meshes: the four animation clips are baked into
 * a bone-matrix texture and every outfit lives in one texture atlas, so the whole crowd costs two draw
 * calls (near people that cast shadows, and the rest) plus the near group's shadow pass — instead of
 * one skinned mesh and animation mixer per person. Anyone beyond ~125 m is skipped.
 */
export class PedestrianRenderer {
  readonly group = new Group();
  private readonly anims: PedAnim[] = [];
  private readonly near: InstancedMesh;
  private readonly far: InstancedMesh;
  private readonly nearData: Float32Array;
  private readonly farData: Float32Array;
  private readonly skirt: InstancedMesh;
  private readonly helmet: InstancedMesh;
  private readonly board: InstancedMesh;
  private readonly ponytail: InstancedMesh;
  private readonly apron: InstancedMesh;
  private readonly hiVis: InstancedMesh;
  private readonly backpack: InstancedMesh;
  private readonly materials: Material[] = [];
  private readonly textures: Texture[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly clips: Record<ClipName, ClipBake>;
  private readonly pose: CrowdPose;
  private readonly anim: DataTexture;
  /** First texture row of the exactly blended poses. */
  readonly exactRow0: number;
  /** The whole animation texture has reached the GPU (from then on only changed rows are uploaded). */
  private animUploaded = false;
  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scl = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly side = new Vector3(1, 0, 0);
  private readonly tilt = new Quaternion();

  /** Number of pedestrians drawn last frame (for tests / budgets). */
  visibleCount = 0;

  constructor(asset: LoadedCharacter, capacity: number) {
    this.group.name = 'pedestrians';
    const bake = bakeAnimations(asset);
    this.clips = bake.clips;
    this.pose = bake.pose;
    this.anim = bake.texture;
    this.exactRow0 = bake.exactRow0;
    this.anim.onUpdate = () => {
      this.animUploaded = true;
    };
    this.textures.push(bake.texture);

    const base = bake.mesh.material as MeshStandardMaterial;
    const mat = base.clone();
    const atlas = base.map ? outfitAtlas(base.map) : null;
    if (atlas) {
      mat.map = atlas;
      this.textures.push(atlas);
    }
    const variants = atlas ? OUTFITS.length : 1;
    mat.onBeforeCompile = (shader) => patchCrowdShader(shader, bake.texture, variants);
    mat.customProgramCacheKey = () => `crowd-${variants}`;
    const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    depth.onBeforeCompile = (shader) => patchCrowdShader(shader, bake.texture, variants);
    depth.customProgramCacheKey = () => 'crowd-depth';
    this.materials.push(mat, depth);

    const make = (castShadow: boolean): [InstancedMesh, Float32Array] => {
      const src = bake.mesh.geometry;
      const geo = new BufferGeometry();
      for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.attributes[name]);
      geo.setIndex(src.index);
      const data = new Float32Array(capacity * 4);
      const attr = new InstancedBufferAttribute(data, 4);
      attr.setUsage(DynamicDrawUsage);
      geo.setAttribute('aCrowd', attr);
      this.geometries.push(geo);
      const mesh = new InstancedMesh(geo, mat, capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      // The crowd spans the city; per-instance bounds would have to be recomputed every frame.
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = castShadow ? 'pedestrians-near' : 'pedestrians-far';
      this.group.add(mesh);
      return [mesh, data];
    };
    [this.near, this.nearData] = make(true);
    [this.far, this.farData] = make(false);
    const accessory = (geo: BufferGeometry, color: number, name: string): InstancedMesh => {
      this.geometries.push(geo);
      const material = new MeshStandardMaterial({ color, roughness: 0.78 });
      this.materials.push(material);
      const mesh = new InstancedMesh(geo, material, capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = name;
      this.group.add(mesh);
      return mesh;
    };
    this.skirt = accessory(new CylinderGeometry(0.2, 0.29, 0.32, 9), 0x49364f, 'crowd-woman-skirt');
    this.helmet = accessory(new SphereGeometry(0.19, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.56), 0xf1b92e, 'crowd-rider-helmet');
    this.board = accessory(new BoxGeometry(0.82, 0.075, 0.25), 0x22c6db, 'crowd-skateboard');
    this.ponytail = accessory(new CylinderGeometry(0.065, 0.09, 0.32, 8), 0x29201c, 'crowd-woman-hair');
    this.apron = accessory(new BoxGeometry(0.39, 0.47, 0.045), 0xf0e3c7, 'crowd-shop-apron');
    this.hiVis = accessory(new BoxGeometry(0.43, 0.6, 0.18), 0xffc928, 'crowd-mechanic-workwear');
    this.backpack = accessory(new BoxGeometry(0.34, 0.4, 0.2), 0xe3482f, 'crowd-courier-pack');

    for (let k = 0; k < capacity; k++) {
      this.anims.push({ phase: (k * 0.29) % 1, walkW: 0, runW: 0, idleT: (k * 0.37) % this.clips.Idle.duration, jumpT: -1 });
    }
  }

  /** Texture row of `clip` at time `t` (loops wrap, the jump holds its last frame). */
  private row(clip: ClipName, t: number): number {
    const b = this.clips[clip];
    if (clip === 'Jump') return b.row + Math.min(b.frames - 1, Math.max(0, Math.round((t / b.duration) * (b.frames - 1))));
    const f = Math.floor(((t / b.duration) % 1) * b.frames + 0.5) % b.frames;
    return b.row + f;
  }

  update(peds: readonly Pedestrian[], alpha: number, dt: number, camX: number, camZ: number): void {
    let nNear = 0;
    let nFar = 0;
    let nExact = 0;
    let nSkirt = 0;
    let nHelmet = 0;
    let nBoard = 0;
    let nPonytail = 0;
    let nApron = 0;
    let nHiVis = 0;
    let nBackpack = 0;
    const rowFloats = this.pose.boneCount * 16;
    for (let k = 0; k < this.anims.length; k++) {
      const p = peds[k];
      const a = this.anims[k];
      if (!p || p.mode === PedMode.Off) {
        a.jumpT = -1;
        continue;
      }
      // Animation state advances for everyone (cheap scalars), so people never pop when they reappear.
      const stumble = p.mode === PedMode.Stumble;
      a.jumpT = stumble ? (a.jumpT < 0 ? STUMBLE_START : a.jumpT + dt) : -1;
      const speed = p.mode === PedMode.Wait || p.mode === PedMode.Pause ? 0 : p.speed;
      const walkT = speed <= 2.0 ? Math.min(1, speed / 0.8) : Math.max(0, 1 - (speed - 2.0) / 1.2);
      const runT = speed <= 2.0 ? 0 : Math.min(1, (speed - 2.0) / 1.2);
      const r = 1 - Math.exp(-10 * dt);
      a.walkW += (walkT - a.walkW) * r;
      a.runW += (runT - a.runW) * r;
      const walkRate = Math.max(speed, 0.5) / WALK_CLIP_SPEED / this.clips.Walk.duration;
      const runRate = Math.max(speed, 2.5) / RUN_CLIP_SPEED / this.clips.Run.duration;
      const moving = a.walkW + a.runW;
      const rate = moving > 1e-3 ? (walkRate * a.walkW + runRate * a.runW) / moving : walkRate;
      if (moving > 0.05) a.phase = (a.phase + rate * dt) % 1;
      a.idleT = (a.idleT + dt) % this.clips.Idle.duration;

      const x = p.prevX + (p.x - p.prevX) * alpha;
      const z = p.prevZ + (p.z - p.prevZ) * alpha;
      const dist = Math.hypot(x - camX, z - camZ);
      if (dist > VISIBLE_DIST) continue;

      // Two strongest of idle / walk / run (or the jump while stumbling), blended on the GPU.
      let rowA: number;
      let rowB: number;
      let wB: number;
      const posed = p.mode === PedMode.Surrender ? 'HandsUp' : p.mode === PedMode.Phone ? 'Phone' : null;
      if (posed) {
        rowA = rowB = this.row(posed, 0);
        wB = 0;
      } else if (p.mode === PedMode.Down) {
        rowA = rowB = this.row('Idle', 0);
        wB = 0;
      } else if (a.jumpT >= 0) {
        rowA = rowB = this.row('Jump', a.jumpT);
        wB = 0;
      } else {
        const m = Math.min(1, moving);
        const wIdle = 1 - m;
        const wWalk = moving > 1e-3 ? (a.walkW / moving) * m : 0;
        const wRun = moving > 1e-3 ? (a.runW / moving) * m : 0;
        const walkRow = this.row('Walk', a.phase * this.clips.Walk.duration);
        const runRow = this.row('Run', a.phase * this.clips.Run.duration);
        const idleRow = this.row('Idle', a.idleT);
        if (wIdle <= Math.min(wWalk, wRun)) {
          rowA = walkRow;
          rowB = runRow;
          wB = wRun / Math.max(1e-6, wWalk + wRun);
        } else if (wRun <= wWalk) {
          rowA = idleRow;
          rowB = walkRow;
          wB = wWalk / Math.max(1e-6, wIdle + wWalk);
        } else {
          rowA = idleRow;
          rowB = runRow;
          wB = wRun / Math.max(1e-6, wIdle + wRun);
        }
      }

      // Mid-transition and close enough to see the limbs: solve the blend exactly (no folding limbs).
      if (wB > 0.004 && wB < 0.996 && rowA !== rowB && dist < EXACT_BLEND_DIST && nExact < EXACT_BLEND_SLOTS) {
        const row = this.exactRow0 + nExact++;
        this.pose.blend(rowA, rowB, wB, this.anim.image.data as Float32Array, row * rowFloats);
        rowA = rowB = row;
        wB = 0;
      }

      // Kerb step: sidewalk height, road height on the crossing.
      const al = Math.abs(p.lat);
      const y = al >= CURB ? SIDEWALK_Y : al <= CURB - 0.15 ? ROAD.surfaceY : ROAD.surfaceY + ((al - (CURB - 0.15)) / 0.15) * ROAD.sidewalkHeight;
      const dy = Math.atan2(Math.sin(p.yaw - p.prevYaw), Math.cos(p.yaw - p.prevYaw));
      this.pos.set(x, y, z);
      this.quat.setFromAxisAngle(this.up, p.prevYaw + dy * alpha);
      if (p.mode === PedMode.Down) {
        // Laid flat on the back (rotation about the body's own side axis), lifted so nothing sinks into the ground.
        const k = Math.min(1, Math.max(0, (p.downT ?? 0) / FALL_TIME));
        this.tilt.setFromAxisAngle(this.side, -k * Math.PI * 0.5);
        this.quat.multiply(this.tilt);
        this.pos.y += k * 0.16;
      }
      const archetype = p.variant % PED_VARIANT_COUNT;
      if (archetype === 6) this.scl.set(p.scale * 0.94, p.scale, p.scale * 0.94);
      else if (archetype === 7) this.scl.set(p.scale * 0.88, p.scale * 0.82, p.scale * 0.9);
      else if (archetype === 8 || archetype === 10) this.scl.set(p.scale * 1.04, p.scale, p.scale * 1.04);
      else this.scl.setScalar(p.scale);
      this.mat.compose(this.pos, this.quat, this.scl);
      const near = dist < NEAR_DIST;
      const mesh = near ? this.near : this.far;
      const data = near ? this.nearData : this.farData;
      const slot = near ? nNear++ : nFar++;
      mesh.setMatrixAt(slot, this.mat);
      data[slot * 4] = rowA;
      data[slot * 4 + 1] = rowB;
      data[slot * 4 + 2] = wB;
      data[slot * 4 + 3] = OUTFITS.length ? p.variant % OUTFITS.length : 0;
      if (archetype === 6) {
        this.pos.set(x, y + 0.72 * p.scale, z);
        this.scl.setScalar(p.scale);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.skirt.setMatrixAt(nSkirt++, this.mat);
        const yaw = p.prevYaw + dy * alpha;
        this.pos.set(x - Math.sin(yaw) * 0.16 * p.scale, y + 1.47 * p.scale, z - Math.cos(yaw) * 0.16 * p.scale);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.ponytail.setMatrixAt(nPonytail++, this.mat);
      } else if (archetype === 7) {
        const yaw = p.prevYaw + dy * alpha;
        this.pos.set(x + Math.cos(yaw) * 0.42 * p.scale, y + 0.1 * p.scale, z - Math.sin(yaw) * 0.42 * p.scale);
        this.quat.setFromAxisAngle(this.up, yaw);
        this.scl.setScalar(p.scale);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.board.setMatrixAt(nBoard++, this.mat);
      } else if (archetype === 8 || archetype === 11) {
        this.pos.set(x, y + 1.63 * p.scale, z);
        this.scl.setScalar(p.scale * (archetype === 11 ? 0.92 : 1.08));
        this.mat.compose(this.pos, this.quat, this.scl);
        this.helmet.setMatrixAt(nHelmet++, this.mat);
        if (archetype === 11) {
          const yaw = p.prevYaw + dy * alpha;
          this.pos.set(x - Math.sin(yaw) * 0.18 * p.scale, y + 1.0 * p.scale, z - Math.cos(yaw) * 0.18 * p.scale);
          this.scl.setScalar(p.scale);
          this.mat.compose(this.pos, this.quat, this.scl);
          this.backpack.setMatrixAt(nBackpack++, this.mat);
        }
      } else if (archetype === 9) {
        const yaw = p.prevYaw + dy * alpha;
        this.pos.set(x + Math.sin(yaw) * 0.16 * p.scale, y + 1.02 * p.scale, z + Math.cos(yaw) * 0.16 * p.scale);
        this.scl.setScalar(p.scale);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.apron.setMatrixAt(nApron++, this.mat);
      } else if (archetype === 10) {
        this.pos.set(x, y + 0.99 * p.scale, z);
        this.scl.setScalar(p.scale);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.hiVis.setMatrixAt(nHiVis++, this.mat);
      }
    }
    this.commit(this.near, nNear);
    this.commit(this.far, nFar);
    for (const [mesh, count] of [[this.skirt, nSkirt], [this.helmet, nHelmet], [this.board, nBoard], [this.ponytail, nPonytail], [this.apron, nApron], [this.hiVis, nHiVis], [this.backpack, nBackpack]] as const) {
      mesh.count = count;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    this.visibleCount = nNear + nFar;
    if (nExact > 0) {
      // Upload just the rewritten rows (three uploads each update range as one texture row). The list is
      // rebuilt every update — three only clears it when it uploads, and some updates are never rendered —
      // and is never used before the first, full upload, which ranges would cut down to these rows.
      if (this.animUploaded) {
        this.anim.clearUpdateRanges();
        for (let k = 0; k < nExact; k++) this.anim.addUpdateRange((this.exactRow0 + k) * rowFloats, rowFloats);
      }
      this.anim.needsUpdate = true;
    }
  }

  private commit(mesh: InstancedMesh, n: number): void {
    mesh.count = n;
    mesh.visible = n > 0;
    if (n === 0) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    const attr = mesh.geometry.getAttribute('aCrowd') as InstancedBufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * 4);
    attr.needsUpdate = true;
  }

  /**
   * After a WebGL context restore the animation texture is uploaded again from scratch: drop any queued
   * row ranges first, or that upload would contain only those rows.
   */
  onContextRestored(): void {
    this.animUploaded = false;
    this.anim.clearUpdateRanges();
    this.anim.needsUpdate = true;
  }

  hideAll(): void {
    this.commit(this.near, 0);
    this.commit(this.far, 0);
    this.visibleCount = 0;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
    this.near.dispose();
    this.far.dispose();
    this.group.removeFromParent();
  }
}
