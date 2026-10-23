import { Quaternion, Vector3, type Object3D } from 'three';

/**
 * Procedural pose layer for the Quaternius human (its asset only ships Idle / Walk / Run / Jump).
 *
 * A pose is a list of "point this bone at that direction" targets in the character's own frame
 * (model faces +Z, up +Y, the character's right hand side is −X). {@link pointBone} rotates a bone so the
 * segment to its child points along the target, whatever the bone's rest orientation is, and the result is
 * blended with the clip pose by a weight. This runs after the animation mixer, so legs keep walking while
 * the arms aim, reload or are raised.
 */
export type PoseName = 'lowReady' | 'aim' | 'holsterReach' | 'reload' | 'handsUp' | 'phone' | 'crouch';

export interface BoneTarget {
  bone: string;
  child: string;
  dir: readonly [number, number, number];
}

const n = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

/** Arm targets. Right arm = −X side. Directions are refined per frame for the aim pitch (see aimTargets). */
export const POSES: Record<PoseName, readonly BoneTarget[]> = {
  lowReady: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.18, -0.9, 0.38) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(0.05, -0.35, 1) },
  ],
  aim: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.12, 0, 1) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(0.06, 0, 1) },
    { bone: 'LeftArm', child: 'LeftForeArm', dir: n(0.32, -0.15, 1) },
    { bone: 'LeftForeArm', child: 'LeftHand', dir: n(-0.75, 0.05, 0.75) },
  ],
  holsterReach: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.32, -0.94, -0.1) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(0.15, -1, 0.15) },
  ],
  reload: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.25, -0.75, 0.6) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(0.45, 0.25, 1) },
    { bone: 'LeftArm', child: 'LeftForeArm', dir: n(0.2, -0.85, 0.45) },
    { bone: 'LeftForeArm', child: 'LeftHand', dir: n(-0.85, 0.1, 0.5) },
  ],
  handsUp: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.75, 0.6, 0.1) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(-0.1, 1, 0.05) },
    { bone: 'LeftArm', child: 'LeftForeArm', dir: n(0.75, 0.6, 0.1) },
    { bone: 'LeftForeArm', child: 'LeftHand', dir: n(0.1, 1, 0.05) },
  ],
  phone: [
    { bone: 'RightArm', child: 'RightForeArm', dir: n(-0.35, -0.75, 0.5) },
    { bone: 'RightForeArm', child: 'RightHand', dir: n(0.45, 0.85, 0.05) },
  ],
  // Knees bent and the body lowered (the model root is lowered by CROUCH_DROP alongside).
  crouch: [
    { bone: 'LeftUpLeg', child: 'LeftLeg', dir: n(0.08, -0.5, 0.86) },
    { bone: 'LeftLeg', child: 'LeftFoot', dir: n(0, -0.62, -0.78) },
    { bone: 'RightUpLeg', child: 'RightLeg', dir: n(-0.08, -0.5, 0.86) },
    { bone: 'RightLeg', child: 'RightFoot', dir: n(0, -0.62, -0.78) },
    { bone: 'Spine', child: 'Spine1', dir: n(0, 0.9, 0.42) },
  ],
};

/** How far the model root is lowered in the full crouch (m). */
export const CROUCH_DROP = 0.42;

const va = new Vector3();
const vb = new Vector3();
const vd = new Vector3();
const qDelta = new Quaternion();
const qWorld = new Quaternion();
const qParent = new Quaternion();
const qBlend = new Quaternion();
const qIdent = new Quaternion();

/**
 * Rotate `bone` so the segment bone → child points along `dirWorld` (unit, world space), blended by `w`.
 * World matrices of the bone's ancestors must be current; the bone's own subtree is updated.
 */
export function pointBone(bone: Object3D, child: Object3D, dirWorld: Vector3, w: number): void {
  if (w <= 0) return;
  bone.getWorldPosition(va);
  child.getWorldPosition(vb);
  vb.sub(va);
  const len = vb.length();
  if (len < 1e-6) return;
  vb.divideScalar(len);
  qDelta.setFromUnitVectors(vb, dirWorld);
  // (slerpQuaternions(a, b) copies `a` into `this` first, so `b` must not be `this`.)
  if (w < 1) qDelta.copy(qBlend.copy(qIdent).slerp(qDelta, w));
  bone.getWorldQuaternion(qWorld);
  qWorld.premultiply(qDelta);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(qParent);
    bone.quaternion.copy(qParent.invert().multiply(qWorld));
  } else bone.quaternion.copy(qWorld);
  bone.updateMatrixWorld(true);
}

/** Bone lookup by name (cached per skeleton root). */
export class BoneMap {
  private readonly map = new Map<string, Object3D>();
  constructor(root: Object3D) {
    root.traverse((o) => {
      if (!this.map.has(o.name)) this.map.set(o.name, o);
    });
  }
  get(name: string): Object3D | undefined {
    return this.map.get(name);
  }
}

/**
 * Apply `targets` (character-frame directions) with weight `w`. `frame` rotates character space into
 * world space (the model root's world quaternion). `pitch` tilts every target up (+) or down (−) about the
 * character's right axis (aiming up / down).
 */
export function applyTargets(bones: BoneMap, targets: readonly BoneTarget[], frame: Quaternion, w: number, pitch = 0): void {
  if (w <= 0.001) return;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  for (const t of targets) {
    const b = bones.get(t.bone);
    const c = bones.get(t.child);
    if (!b || !c) continue;
    // Pitch about the character X axis: forward (+Z) tilts towards +Y for positive pitch.
    const [x, y, z] = t.dir;
    vd.set(x, y * cp + z * sp, z * cp - y * sp).applyQuaternion(frame);
    pointBone(b, c, vd, w);
  }
}
