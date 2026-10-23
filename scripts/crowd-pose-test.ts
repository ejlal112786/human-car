/**
 * Crowd pose blending (headless, real character asset): the instanced crowd's exact mid-transition poses
 * (CrowdPose) must reproduce the baked frames, match three's AnimationMixer blend of the same two clips
 * on every vertex, and clearly beat the plain linear mix of baked skinning matrices (which folds limbs).
 *   npx tsx scripts/crowd-pose-test.ts
 */
import { AnimationMixer, Matrix4, type BufferAttribute, Vector3, Vector4, type AnimationClip, type Group, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bakeAnimations, BAKE_FPS } from '../src/game/pedestrians/PedestrianRenderer';

let failures = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

// ---- Load the bundled GLB without its textures (no image decoding in Node).
const fs: { readFileSync(p: URL): Uint8Array } = await import('node:' + 'fs');
const raw = fs.readFileSync(new URL('../src/assets/character.glb', import.meta.url));
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(raw.subarray(20, 20 + jsonLen)));
delete json.images;
delete json.textures;
delete json.samplers;
for (const m of json.materials ?? []) {
  if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture;
  delete m.normalTexture;
  delete m.emissiveTexture;
}
const js0 = new TextEncoder().encode(JSON.stringify(json));
const jsLen = Math.ceil(js0.length / 4) * 4;
const bin = raw.subarray(20 + jsonLen);
const glb = new Uint8Array(20 + jsLen + bin.length);
const gv = new DataView(glb.buffer);
gv.setUint32(0, 0x46546c67, true);
gv.setUint32(4, 2, true);
gv.setUint32(8, glb.length, true);
gv.setUint32(12, jsLen, true);
gv.setUint32(16, 0x4e4f534a, true);
glb.fill(0x20, 20, 20 + jsLen);
glb.set(js0, 20);
glb.set(bin, 20 + jsLen);
const gltf = await new Promise<{ scene: Group; animations: AnimationClip[] }>((res, rej) =>
  new GLTFLoader().parse(glb.buffer, '', (g) => res(g as unknown as { scene: Group; animations: AnimationClip[] }), rej),
);
const asset = { scene: gltf.scene, clips: gltf.animations };

// ---- The renderer's own bake (same code path as the game).
const bake = bakeAnimations(asset);
const { pose, clips } = bake;
const tex = bake.texture.image.data as Float32Array;
const width = pose.boneCount * 4;
const rowFloats = pose.boneCount * 16;

// Reference skeleton: a separate instance of the asset driven by an AnimationMixer.
const model: Object3D = gltf.scene;
let found: SkinnedMesh | null = null;
model.traverse((o) => {
  if ((o as SkinnedMesh).isSkinnedMesh && !found) found = o as SkinnedMesh;
});
const sk = found as unknown as SkinnedMesh;
const bones = sk.skeleton.bones;
const mixer = new AnimationMixer(model);
const clipOf = (n: string) => gltf.animations.find((c) => c.name === n)!;
const head = new Matrix4();
const refPose = (a: string, ta: number, b: string, tb: number, w: number): Matrix4[] => {
  mixer.stopAllAction();
  const A = mixer.clipAction(clipOf(a));
  const B = mixer.clipAction(clipOf(b));
  A.reset().play();
  A.setEffectiveWeight(1 - w);
  A.time = ta;
  if (B !== A) {
    B.reset().play();
    B.setEffectiveWeight(w);
    B.time = tb;
  }
  mixer.update(0);
  model.updateMatrixWorld(true);
  head.copy(sk.matrixWorld).multiply(sk.bindMatrixInverse);
  return bones.map((bn, j) => new Matrix4().multiplyMatrices(bn.matrixWorld, sk.skeleton.boneInverses[j]).premultiply(head).multiply(sk.bindMatrix));
};
const fromRow = (data: Float32Array, off: number) => bones.map((_, j) => new Matrix4().fromArray(data, off + j * 16));
const lerpMats = (A: Matrix4[], B: Matrix4[], w: number) =>
  A.map((m, j) => {
    const r = new Matrix4();
    for (let e = 0; e < 16; e++) r.elements[e] = m.elements[e] * (1 - w) + B[j].elements[e] * w;
    return r;
  });

// Linear blend skinning of the real mesh.
const g = sk.geometry;
const P = g.getAttribute('position') as BufferAttribute;
const SI = g.getAttribute('skinIndex') as BufferAttribute;
const SW = g.getAttribute('skinWeight') as BufferAttribute;
const v = new Vector3();
const t3 = new Vector3();
const si = new Vector4();
const sw = new Vector4();
const skin = (mats: Matrix4[], i: number, o: Vector3) => {
  v.fromBufferAttribute(P, i);
  si.fromBufferAttribute(SI, i);
  sw.fromBufferAttribute(SW, i);
  o.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const wt = sw.getComponent(k);
    if (wt) o.addScaledVector(t3.copy(v).applyMatrix4(mats[si.getComponent(k)]), wt);
  }
  return o;
};
const va = new Vector3();
const vb = new Vector3();
const maxErr = (A: Matrix4[], B: Matrix4[]) => {
  let mx = 0;
  for (let i = 0; i < P.count; i++) mx = Math.max(mx, skin(A, i, va).distanceTo(skin(B, i, vb)));
  return mx;
};
let minY = Infinity;
let maxY = -Infinity;
const rest = fromRow(tex, clips.Idle.row * width * 4);
for (let i = 0; i < P.count; i++) {
  skin(rest, i, va);
  minY = Math.min(minY, va.y);
  maxY = Math.max(maxY, va.y);
}
const height = maxY - minY;
console.log(`character: ${P.count} vertices, ${pose.boneCount} bones, ${height.toFixed(2)} m tall; ${Object.values(clips).reduce((n, c) => n + c.frames, 0)} baked rows at ${BAKE_FPS} fps`);

// ---- 1. Unblended solve == baked texture, for every row.
const out = new Float32Array(rowFloats);
let worstRow = 0;
let worstAt = '';
for (const [name, c] of Object.entries(clips)) {
  for (let f = 0; f < c.frames; f += name === 'Idle' ? 7 : 1) {
    const r = c.row + f;
    pose.blend(r, r, 0, out, 0);
    const e = maxErr(fromRow(out, 0), fromRow(tex, r * width * 4));
    if (e > worstRow) {
      worstRow = e;
      worstAt = `${name} frame ${f}`;
    }
  }
}
check('unblended solve reproduces the baked poses', worstRow < 1e-4, `worst ${(worstRow * 1000).toFixed(4)} mm at ${worstAt || '—'}`);

// ---- 2/3. Blends the crowd uses: exact vs AnimationMixer, and the old linear mix for comparison.
const timeOf = (name: 'Idle' | 'Walk' | 'Run', f: number) => (f / clips[name].frames) * clips[name].duration;
const pairs: Array<['Idle' | 'Walk' | 'Run', 'Idle' | 'Walk' | 'Run']> = [
  ['Walk', 'Run'],
  ['Idle', 'Walk'],
  ['Idle', 'Run'],
];
for (const [a, b] of pairs) {
  let exact = 0;
  let linear = 0;
  for (let s = 0; s < 16; s++) {
    // Same phase in both clips (the crowd keeps walk / run in step); the idle runs on its own clock.
    const fa = Math.floor((s / 16) * clips[a].frames) + (a === 'Idle' ? 37 * s : 0);
    const fb = Math.floor((s / 16) * clips[b].frames);
    const ra = clips[a].row + (fa % clips[a].frames);
    const rb = clips[b].row + (fb % clips[b].frames);
    for (const w of [0.25, 0.5, 0.75]) {
      const ref = refPose(a, timeOf(a, fa % clips[a].frames), b, timeOf(b, fb % clips[b].frames), w);
      pose.blend(ra, rb, w, out, 0);
      exact = Math.max(exact, maxErr(fromRow(out, 0), ref));
      linear = Math.max(linear, maxErr(lerpMats(fromRow(tex, ra * width * 4), fromRow(tex, rb * width * 4), w), ref));
    }
  }
  const pct = (x: number) => `${((x / height) * 100).toFixed(2)}%`;
  check(`${a} ↔ ${b}: exact blend matches the animation mixer on every vertex`, exact / height < 0.005, `worst ${(exact * 1000).toFixed(1)} mm = ${pct(exact)} of height`);
  check(`${a} ↔ ${b}: exact blend fixes the folding of the linear mix`, linear > 5 * exact, `linear mix worst ${(linear * 1000).toFixed(0)} mm = ${pct(linear)} of height`);
}

// ---- Cost: a full frame of exact blends (all 24 slots) on this machine's CPU.
{
  const slots = new Float32Array(24 * rowFloats);
  const frame = () => {
    for (let k = 0; k < 24; k++) pose.blend(clips.Walk.row + (k % clips.Walk.frames), clips.Run.row + (k % clips.Run.frames), 0.3 + k * 0.01, slots, k * rowFloats);
  };
  for (let i = 0; i < 50; i++) frame();
  const n = 400;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) frame();
  const ms = (performance.now() - t0) / n;
  check('a full frame of exact blends (24 people) costs < 2 ms of CPU', ms < 2, `${ms.toFixed(3)} ms per frame, ${((ms / 24) * 1000).toFixed(1)} µs per person`);
}

// ---- Guard rails.
let threw = false;
try {
  pose.blend(-1, 0, 0.5, out, 0);
} catch {
  threw = true;
}
check('out-of-range pose rows are rejected', threw);

console.log(`\n${passes} passed, ${failures} failed`);
console.log(failures ? 'CROWD POSE CHECKS FAILED' : 'ALL CROWD POSE CHECKS PASSED');
if (failures) throw new Error('crowd pose checks failed');
