import { CanvasTexture, DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, SRGBColorSpace, Vector3, type Object3D } from 'three';
import type { Vehicle } from '../Vehicle';

/**
 * Police markings: white door panels reading POLICE (both sides) and a unit number on the bonnet.
 * The panels are placed on the actual body surface (ray-cast against the car shell), so they follow
 * whichever body the pooled car currently has; rebuild when the car model changes.
 */

let doorTex: CanvasTexture | null = null;
const numberTex = new Map<number, CanvasTexture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  return ctx ? [c, ctx] : null;
}

function texture(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function doorTexture(): CanvasTexture | null {
  if (doorTex) return doorTex;
  const cc = canvas(512, 128);
  if (!cc) return null;
  const [c, ctx] = cc;
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#1d3f9a';
  ctx.fillRect(0, 100, 512, 16);
  ctx.fillStyle = '#c8202a';
  ctx.fillRect(0, 116, 512, 6);
  ctx.fillStyle = '#10204a';
  ctx.font = 'bold 76px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('POLICE', 256, 52);
  doorTex = texture(c);
  return doorTex;
}

function numberTexture(n: number): CanvasTexture | null {
  const have = numberTex.get(n);
  if (have) return have;
  const cc = canvas(256, 128);
  if (!cc) return null;
  const [c, ctx] = cc;
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#10204a';
  ctx.font = 'bold 96px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 68);
  const t = texture(c);
  numberTex.set(n, t);
  return t;
}

const rc = new Raycaster();
const o = new Vector3();
const d = new Vector3();

/** Ray from object-local `from` along object-local `dir` against `target`; hit point in object space or null. */
function cast(obj: Object3D, target: Object3D, from: Vector3, dir: Vector3): Vector3 | null {
  obj.updateMatrixWorld(true);
  o.copy(from);
  obj.localToWorld(o);
  d.copy(dir).transformDirection(obj.matrixWorld);
  rc.set(o, d);
  rc.far = 10;
  const hit = rc.intersectObject(target, true)[0];
  return hit ? obj.worldToLocal(hit.point.clone()) : null;
}

export class PoliceLivery {
  readonly group = new Group();
  /** The car model the markings were fitted to (rebuild when the pooled car changes body). */
  fittedTo: object | null = null;
  private readonly mats: MeshStandardMaterial[] = [];
  private readonly geos: PlaneGeometry[] = [];

  constructor(
    private readonly vehicle: Vehicle,
    private readonly number: number,
  ) {
    this.group.name = 'police-livery';
    vehicle.object.add(this.group);
  }

  /** (Re)fit the markings to the current body. Returns false when no surface was found (headless). */
  fit(): boolean {
    this.clearMeshes();
    const v = this.vehicle;
    this.fittedTo = v.model;
    const door = doorTexture();
    const num = numberTexture(this.number);
    if (!door || !num) return false;
    const shell = v.model.root.getObjectByName('car-shell') ?? v.model.root;
    // Door line: find the body side at mid-length, ~0.55 m above the ground (model ground = −rideHeight in object space).
    const ground = v.model.root.position.y;
    const y = ground + 0.62;
    let side = 0;
    for (const x of [-0.5, 0, 0.5]) {
      const h = cast(v.object, shell, new Vector3(x, y, 3), new Vector3(0, 0, -1));
      if (h) side = Math.max(side, h.z);
    }
    if (side <= 0.3) return false;
    const mk = (tex: CanvasTexture): MeshStandardMaterial => {
      const m = new MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide });
      this.mats.push(m);
      return m;
    };
    const doorGeo = new PlaneGeometry(1.7, 0.42);
    this.geos.push(doorGeo);
    const doorMat = mk(door);
    for (const s of [1, -1]) {
      const m = new Mesh(doorGeo, doorMat);
      m.name = 'police-door';
      m.position.set(-0.05, y, s * (side + 0.012));
      // Plane normal +Z; the −Z side is turned round so the text reads forwards on both sides.
      m.rotation.y = s > 0 ? 0 : Math.PI;
      this.group.add(m);
    }
    // Bonnet number: top of the body ~0.6 m behind the front, read from in front of the car.
    let front = 0;
    const fh = cast(v.object, shell, new Vector3(4, ground + 0.6, 0), new Vector3(-1, 0, 0));
    if (fh) front = fh.x;
    if (front > 0.5) {
      const top = cast(v.object, shell, new Vector3(front - 0.55, ground + 3, 0), new Vector3(0, -1, 0));
      if (top && top.y - ground > 0.5) {
        const g = new PlaneGeometry(0.62, 0.31);
        this.geos.push(g);
        const m = new Mesh(g, mk(num));
        m.name = 'police-number';
        m.position.set(top.x, top.y + 0.012, 0);
        // Lie flat, text reading from the front of the car (+X).
        m.rotation.set(-Math.PI / 2, Math.PI / 2, 0, 'YXZ');
        this.group.add(m);
      }
    }
    return true;
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Door panels currently fitted (tests). */
  get panels(): number {
    return this.group.children.length;
  }

  private clearMeshes(): void {
    this.group.clear();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
  }

  dispose(): void {
    this.clearMeshes();
    this.group.removeFromParent();
  }
}
