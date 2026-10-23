import { Matrix4, Quaternion, Vector3, type Bone, type SkinnedMesh } from 'three';

/**
 * Exact pose blending for the instanced crowd.
 *
 * The crowd's baked texture stores final skinning matrices, and mixing two of those linearly makes
 * limbs fold in towards the body mid-transition (an arm swung forward in one clip and back in the other
 * averages to a short, crumpled arm). This class keeps each baked frame's *local* bone transforms
 * (position, rotation, scale) as well, so a blend can be solved the way an animation mixer does it:
 * slerp every joint's local rotation, lerp position and scale, then walk the hierarchy. The result is
 * written as skinning matrices in exactly the baked texture layout (four texels — matrix columns — per
 * bone), so the shader treats it like any other pose row.
 */
export class CrowdPose {
  readonly boneCount: number;
  /** Per baked row, per bone: position xyz, quaternion xyzw, scale xyz (10 floats). */
  private readonly local: Float32Array;
  /** Parent bone index, or -1 for a root bone (one whose parent is not part of the skeleton). */
  private readonly parent: Int16Array;
  /** Bone indices with every parent before its children. */
  private readonly order: Int16Array;
  /** Per baked row, per root bone: the matrix above it (mesh-space head · parent world), 16 floats. */
  private readonly rootPre: Float32Array;
  private readonly rootSlot: Int16Array;
  private readonly rootCount: number;
  /** Per bone: boneInverse · bindMatrix (constant). */
  private readonly post: Matrix4[];
  private readonly global: Matrix4[];
  private readonly rows: number;
  private readonly m = new Matrix4();
  private readonly pre = new Matrix4();
  private readonly preB = new Matrix4();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();
  private readonly qa = [0, 0, 0, 1];
  private readonly qb = [0, 0, 0, 1];
  private readonly qo = [0, 0, 0, 1];

  constructor(mesh: SkinnedMesh, rows: number) {
    const bones = mesh.skeleton.bones;
    this.boneCount = bones.length;
    this.rows = rows;
    const index = new Map<Bone, number>(bones.map((b, j) => [b, j]));
    this.parent = new Int16Array(bones.map((b) => (b.parent && index.has(b.parent as Bone) ? index.get(b.parent as Bone)! : -1)));
    const order: number[] = [];
    const placed = new Uint8Array(bones.length);
    while (order.length < bones.length) {
      const before = order.length;
      for (let j = 0; j < bones.length; j++) {
        const pj = this.parent[j];
        if (!placed[j] && (pj < 0 || placed[pj])) {
          placed[j] = 1;
          order.push(j);
        }
      }
      if (order.length === before) throw new Error('Character skeleton has a cycle');
    }
    this.order = new Int16Array(order);
    this.rootSlot = new Int16Array(bones.length).fill(-1);
    let roots = 0;
    for (let j = 0; j < bones.length; j++) if (this.parent[j] < 0) this.rootSlot[j] = roots++;
    this.rootCount = roots;
    this.local = new Float32Array(rows * bones.length * 10);
    this.rootPre = new Float32Array(rows * roots * 16);
    this.post = mesh.skeleton.boneInverses.map((inv) => new Matrix4().multiplyMatrices(inv, mesh.bindMatrix));
    this.global = bones.map(() => new Matrix4());
  }

  /**
   * Record baked row `row` from the posed skeleton. `head` is meshWorld · bindMatrixInverse, as used
   * for the baked skinning matrices; world matrices must be up to date.
   */
  capture(row: number, mesh: SkinnedMesh, head: Matrix4): void {
    const bones = mesh.skeleton.bones;
    for (let j = 0; j < bones.length; j++) {
      const b = bones[j];
      const o = (row * this.boneCount + j) * 10;
      const L = this.local;
      L[o] = b.position.x;
      L[o + 1] = b.position.y;
      L[o + 2] = b.position.z;
      L[o + 3] = b.quaternion.x;
      L[o + 4] = b.quaternion.y;
      L[o + 5] = b.quaternion.z;
      L[o + 6] = b.quaternion.w;
      L[o + 7] = b.scale.x;
      L[o + 8] = b.scale.y;
      L[o + 9] = b.scale.z;
      const r = this.rootSlot[j];
      if (r >= 0) {
        this.m.copy(head);
        if (b.parent) this.m.multiply(b.parent.matrixWorld);
        this.m.toArray(this.rootPre, (row * this.rootCount + r) * 16);
      }
    }
  }

  /**
   * Solve the blend of baked rows `rowA` and `rowB` (weight `w` on B) and write its skinning matrices
   * to `out` at float offset `offset` (boneCount × 16 floats, the texture row layout).
   */
  blend(rowA: number, rowB: number, w: number, out: Float32Array, offset: number): void {
    if (rowA < 0 || rowB < 0 || rowA >= this.rows || rowB >= this.rows) throw new RangeError('Pose row out of range');
    const L = this.local;
    const u = 1 - w;
    for (let n = 0; n < this.order.length; n++) {
      const j = this.order[n];
      const a = (rowA * this.boneCount + j) * 10;
      const b = (rowB * this.boneCount + j) * 10;
      this.p.set(L[a] * u + L[b] * w, L[a + 1] * u + L[b + 1] * w, L[a + 2] * u + L[b + 2] * w);
      this.qa[0] = L[a + 3];
      this.qa[1] = L[a + 4];
      this.qa[2] = L[a + 5];
      this.qa[3] = L[a + 6];
      this.qb[0] = L[b + 3];
      this.qb[1] = L[b + 4];
      this.qb[2] = L[b + 5];
      this.qb[3] = L[b + 6];
      Quaternion.slerpFlat(this.qo, 0, this.qa, 0, this.qb, 0, w);
      this.q.set(this.qo[0], this.qo[1], this.qo[2], this.qo[3]);
      this.s.set(L[a + 7] * u + L[b + 7] * w, L[a + 8] * u + L[b + 8] * w, L[a + 9] * u + L[b + 9] * w);
      this.m.compose(this.p, this.q, this.s);
      const g = this.global[j];
      const pj = this.parent[j];
      if (pj >= 0) {
        g.multiplyMatrices(this.global[pj], this.m);
      } else {
        const r = this.rootSlot[j];
        this.pre.fromArray(this.rootPre, (rowA * this.rootCount + r) * 16);
        this.preB.fromArray(this.rootPre, (rowB * this.rootCount + r) * 16);
        const e = this.pre.elements;
        const f = this.preB.elements;
        for (let k = 0; k < 16; k++) e[k] = e[k] * u + f[k] * w;
        g.multiplyMatrices(this.pre, this.m);
      }
    }
    for (let j = 0; j < this.boneCount; j++) {
      this.m.multiplyMatrices(this.global[j], this.post[j]);
      this.m.toArray(out, offset + j * 16);
    }
  }
}
