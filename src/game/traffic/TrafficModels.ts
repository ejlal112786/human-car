import {
  BoxGeometry,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Body styles of the ambient traffic. Model space: +X forward, +Y up, ground at y = 0. */
export type TrafficKind = 0 | 1;
export const TRAFFIC_KINDS = 2;
/** Collision half extents per kind (x along the car, y, z across). */
export const KIND_HALF: ReadonlyArray<{ x: number; y: number; z: number }> = [
  { x: 2.2, y: 0.7, z: 0.88 },
  { x: 2.45, y: 1.05, z: 0.95 },
];

const tint = (g: BufferGeometry, hex: number): BufferGeometry => {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new Color(hex);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  return geo;
};
const box = (w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry => new BoxGeometry(w, h, d).translate(x, y, z);

function wheels(xF: number, xR: number, track: number, r: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const x of [xF, xR]) for (const z of [-track, track]) out.push(new CylinderGeometry(r, r, 0.26, 12).rotateX(Math.PI / 2).translate(x, r, z));
  return out;
}

/** [paint, dark details (vertex coloured), tail lights] for one kind. */
function buildKind(kind: TrafficKind): [BufferGeometry, BufferGeometry, BufferGeometry] {
  if (kind === 0) {
    // Compact sedan
    const paint = mergeGeometries([
      box(4.3, 0.62, 1.74, 0, 0.62, 0),
      box(1.15, 0.12, 1.66, 1.45, 0.98, 0), // bonnet top
      box(1.9, 0.1, 1.42, -0.35, 1.47, 0), // roof
      box(0.75, 0.16, 1.66, -1.75, 0.98, 0), // boot
    ]);
    const dark = mergeGeometries([
      tint(box(2.15, 0.5, 1.5, -0.3, 1.18, 0), 0x0d1218),
      ...wheels(1.35, -1.35, 0.8, 0.33).map((g) => tint(g, 0x121212)),
      tint(box(0.16, 0.22, 1.76, 2.17, 0.42, 0), 0x1e1f21),
      tint(box(0.16, 0.22, 1.76, -2.17, 0.42, 0), 0x1e1f21),
      tint(box(0.06, 0.12, 0.34, 2.16, 0.74, 0.58), 0xfff3d6),
      tint(box(0.06, 0.12, 0.34, 2.16, 0.74, -0.58), 0xfff3d6),
    ]);
    const tail = mergeGeometries([box(0.06, 0.12, 0.34, -2.17, 0.78, 0.6), box(0.06, 0.12, 0.34, -2.17, 0.78, -0.6)]);
    return [paint, dark, tail];
  }
  // Delivery van
  const paint = mergeGeometries([box(4.8, 1.55, 1.9, -0.1, 1.2, 0), box(0.9, 0.6, 1.86, 2.0, 0.75, 0)]);
  const dark = mergeGeometries([
    tint(box(0.08, 0.62, 1.72, 2.32, 1.5, 0), 0x0d1218),
    tint(box(0.08, 0.45, 1.92, 1.0, 1.55, 0), 0x0d1218),
    ...wheels(1.55, -1.5, 0.86, 0.36).map((g) => tint(g, 0x121212)),
    tint(box(0.16, 0.25, 1.92, 2.45, 0.42, 0), 0x1e1f21),
    tint(box(0.16, 0.25, 1.92, -2.52, 0.45, 0), 0x1e1f21),
    tint(box(0.06, 0.14, 0.34, 2.46, 0.8, 0.62), 0xfff3d6),
    tint(box(0.06, 0.14, 0.34, 2.46, 0.8, -0.62), 0xfff3d6),
  ]);
  const tail = mergeGeometries([box(0.06, 0.3, 0.2, -2.52, 0.95, 0.78), box(0.06, 0.3, 0.2, -2.52, 0.95, -0.78)]);
  return [paint, dark, tail];
}

export const TRAFFIC_PAINTS = [0xd9dcdf, 0x1d2430, 0x8a1418, 0x2f5d8a, 0x6b6e72, 0xc7a23a, 0x2e6b46, 0xe6e1d3, 0x3d2a52, 0xb4561f];
const TAIL_DIM = new Color(0x5a0a06);
const TAIL_BRAKE = new Color(0xff2814);

/**
 * Instanced rendering for the ambient traffic: three draw calls per body style, regardless of how many cars.
 * Slots are allocated per kind; an unused slot is collapsed to zero scale.
 */
export class TrafficRenderer {
  readonly group = new Group();
  private readonly paint: InstancedMesh[] = [];
  private readonly dark: InstancedMesh[] = [];
  private readonly tail: InstancedMesh[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly zero = new Matrix4().makeScale(0, 0, 0);
  private readonly brakeState: Int8Array[] = [];
  private readonly color = new Color();
  private readonly authoredCars: Group[][] = [];

  constructor(readonly capacity: readonly number[]) {
    this.group.name = 'traffic';
    const paintMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.35 });
    const darkMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25 });
    const tailMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.disposables.push(paintMat, darkMat, tailMat);
    for (let k = 0 as TrafficKind; k < TRAFFIC_KINDS; k = (k + 1) as TrafficKind) {
      const [pg, dg, tg] = buildKind(k);
      this.disposables.push(pg, dg, tg);
      const n = Math.max(1, capacity[k]);
      const mk = (g: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, shadow: boolean): InstancedMesh => {
        const im = new InstancedMesh(g, mat, n);
        im.instanceMatrix.setUsage(DynamicDrawUsage);
        im.frustumCulled = false;
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        for (let i = 0; i < n; i++) im.setMatrixAt(i, this.zero);
        this.group.add(im);
        return im;
      };
      const pm = mk(pg, paintMat, true);
      const dm = mk(dg, darkMat, true);
      const tm = mk(tg, tailMat, false);
      for (let i = 0; i < n; i++) {
        pm.setColorAt(i, this.color.setHex(TRAFFIC_PAINTS[(i * 7 + k * 3) % TRAFFIC_PAINTS.length]));
        tm.setColorAt(i, TAIL_DIM);
      }
      this.paint.push(pm);
      this.dark.push(dm);
      this.tail.push(tm);
      this.brakeState.push(new Int8Array(n).fill(-1));
    }
  }

  /** Replace procedural ambient bodies with authored Quaternius CC0 car models. */
  useQuaternius(models: readonly Group[]): void {
    if (!models.length || this.authoredCars.length) return;
    this.paint.forEach((mesh) => { mesh.visible = false; });
    this.dark.forEach((mesh) => { mesh.visible = false; });
    this.tail.forEach((mesh) => { mesh.visible = false; });
    for (let kind = 0; kind < TRAFFIC_KINDS; kind++) {
      const slots: Group[] = [];
      for (let slot = 0; slot < this.capacity[kind]; slot++) {
        const isBus = kind === 1 && slot === 0 && models.length > 3;
        const source = kind === 1 ? models[isBus ? 3 : Math.min(2, models.length - 1)] : models[slot % Math.min(3, models.length)];
        const wrapper = new Group();
        wrapper.name = isBus ? 'Quaternius bus in traffic' : 'Quaternius ambient car';
        const inner = new Group();
        const asset = source.clone(true);
        asset.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(asset);
        const size = new Vector3();
        bounds.getSize(size);
        if (size.x > 0.01 && size.y > 0.01 && size.z > 0.01) {
          const sx = 1.82 / size.x;
          const sy = (kind === 1 ? 1.9 : 1.45) / size.y;
          const sz = (kind === 1 ? 4.8 : 4.35) / size.z;
          inner.scale.set(sx, sy, sz);
          inner.rotation.y = Math.PI / 2; // Quaternius car packs face +Z; traffic bodies face +X.
          inner.position.set(-(bounds.min.z + bounds.max.z) * 0.5 * sz, -bounds.min.y * sy, (bounds.min.x + bounds.max.x) * 0.5 * sx);
        }
        inner.add(asset);
        wrapper.add(inner);
        wrapper.visible = false;
        wrapper.traverse((node) => { if ('isMesh' in node && node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
        this.group.add(wrapper);
        slots.push(wrapper);
      }
      this.authoredCars.push(slots);
    }
  }

  setPaint(kind: TrafficKind, slot: number, hex: number): void {
    this.paint[kind].setColorAt(slot, this.color.setHex(hex));
    if (this.paint[kind].instanceColor) this.paint[kind].instanceColor.needsUpdate = true;
  }

  /** Place slot `slot` of `kind`; quaternion from the body (or yaw-only for lane driving). */
  set(kind: TrafficKind, slot: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, braking: boolean): void {
    this.p.set(x, y, z);
    this.q.set(qx, qy, qz, qw);
    this.m.compose(this.p, this.q, this.s);
    this.paint[kind].setMatrixAt(slot, this.m);
    this.dark[kind].setMatrixAt(slot, this.m);
    this.tail[kind].setMatrixAt(slot, this.m);
    const authored = this.authoredCars[kind]?.[slot];
    if (authored) {
      authored.position.set(x, y, z);
      authored.quaternion.copy(this.q);
      authored.visible = true;
    }
    const b = braking ? 1 : 0;
    if (this.brakeState[kind][slot] !== b) {
      this.brakeState[kind][slot] = b;
      this.tail[kind].setColorAt(slot, braking ? TAIL_BRAKE : TAIL_DIM);
      if (this.tail[kind].instanceColor) this.tail[kind].instanceColor.needsUpdate = true;
    }
  }

  hide(kind: TrafficKind, slot: number): void {
    this.paint[kind].setMatrixAt(slot, this.zero);
    this.dark[kind].setMatrixAt(slot, this.zero);
    this.tail[kind].setMatrixAt(slot, this.zero);
    const authored = this.authoredCars[kind]?.[slot];
    if (authored) authored.visible = false;
  }

  /** Upload the matrices written this frame. */
  commit(): void {
    for (let k = 0; k < TRAFFIC_KINDS; k++) {
      this.paint[k].instanceMatrix.needsUpdate = true;
      this.dark[k].instanceMatrix.needsUpdate = true;
      this.tail[k].instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const im of [...this.paint, ...this.dark, ...this.tail]) im.dispose();
    for (const slots of this.authoredCars) for (const car of slots) car.removeFromParent();
    this.group.removeFromParent();
  }
}
