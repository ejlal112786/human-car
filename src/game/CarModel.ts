import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
  Object3D,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR } from './config';
import type { WheelState } from './VehiclePhysics';
import { FACTORY_LOOK, type CarLook, type CarStyle, type WheelDesign } from './vehicles/VehicleCatalog';
import type { DamageState, Lamp } from './damage/DamageModel';

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Extrudes a side profile across the car's width (Z), then reshapes the
 * width per-vertex so the body gets tumblehome and a rounded nose/tail.
 */
function extrudeProfile(shape: Shape, width: number, bevel: number, widthFn: (x: number, y: number) => number): BufferGeometry {
  const depth = width - bevel * 2;
  let geo: BufferGeometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 4,
    curveSegments: 24,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    pos.setZ(i, pos.getZ(i) * widthFn(x, y));
  }
  geo.computeVertexNormals();
  return geo;
}

function bodyShape(): Shape {
  const s = new Shape();
  const archR = 0.46;
  const fx = CAR.wheelBaseFront;
  const rx = CAR.wheelBaseRear;
  const wy = 0.34;
  s.moveTo(2.1, 0.24);
  s.quadraticCurveTo(2.25, 0.27, 2.23, 0.46);
  s.quadraticCurveTo(2.19, 0.61, 1.9, 0.67);
  s.quadraticCurveTo(1.25, 0.79, 0.78, 0.85);
  s.lineTo(-1.15, 0.89);
  s.quadraticCurveTo(-1.9, 0.92, -2.17, 0.87);
  s.quadraticCurveTo(-2.27, 0.7, -2.22, 0.36);
  s.quadraticCurveTo(-2.2, 0.25, -2.04, 0.24);
  s.lineTo(rx - archR, 0.24);
  s.absarc(rx, wy, archR, Math.PI, 0, true);
  s.lineTo(rx + archR, 0.24);
  s.lineTo(fx - archR, 0.24);
  s.absarc(fx, wy, archR, Math.PI, 0, true);
  s.lineTo(fx + archR, 0.24);
  s.closePath();
  return s;
}

function cabinShape(): Shape {
  const s = new Shape();
  s.moveTo(0.86, 0.82);
  s.quadraticCurveTo(0.38, 1.08, -0.05, 1.19);
  s.quadraticCurveTo(-0.45, 1.245, -0.86, 1.185);
  s.quadraticCurveTo(-1.45, 1.05, -1.88, 0.86);
  s.lineTo(-1.6, 0.8);
  s.lineTo(0.6, 0.78);
  s.closePath();
  return s;
}

function roofShape(): Shape {
  const s = new Shape();
  s.moveTo(0.0, 1.19);
  s.quadraticCurveTo(-0.45, 1.262, -0.9, 1.19);
  s.lineTo(-0.88, 1.13);
  s.quadraticCurveTo(-0.45, 1.2, -0.02, 1.13);
  s.closePath();
  return s;
}

export interface WheelVisual {
  pivot: Group;
  spin: Group;
}

const TMP = new Vector3();
const smooth01 = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Deterministic pseudo-random in [-1, 1] from a position (crumple pattern). */
const crumple = (x: number, y: number, z: number): number => {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
};
/** Dent displacement at model-space point (x, y, z) for the given zone damage (0..1). */
function dent(x: number, y: number, z: number, front: number, rear: number, left: number, right: number, noise: boolean, out: Vector3): Vector3 {
  const n = noise ? crumple(x, y, z) : 0;
  const wf = smooth01(1.0, 2.35, x);
  const wr = smooth01(-1.0, -2.35, x);
  const wR = smooth01(0.45, 0.98, z);
  const wL = smooth01(-0.45, -0.98, z);
  // Side dents are deepest mid-door, fading towards the ends of the car.
  const mid = 1 - smooth01(1.1, 2.2, Math.abs(x));
  out.set(
    -front * 0.42 * wf * (0.8 + 0.2 * n) + rear * 0.34 * wr * (0.8 + 0.2 * n),
    -front * wf * (0.05 + 0.04 * n) - rear * wr * (0.03 + 0.03 * n) + (left * wL + right * wR) * 0.03 * n,
    -right * 0.2 * wR * mid * (0.75 + 0.25 * n) + left * 0.2 * wL * mid * (0.75 + 0.25 * n),
  );
  return out;
}

/** Proportions per body style. The wheel mounts never move (they are the shared physics mounts). */
interface StyleDef {
  shell: [number, number, number];
  cabin: [number, number];
  scoop: boolean;
  intakes: boolean;
  twinExhaust: boolean;
  hoodVents: boolean;
  /** Visual tyre width multiplier. */
  tyreWidth: number;
  roofRails: boolean;
  /** Spare wheel on the tailgate, roof rack, fender flares (off-roader). */
  utility: boolean;
}
const STYLE: Record<CarStyle, StyleDef> = {
  coupe: { shell: [1, 1, 1], cabin: [1, 1], scoop: false, intakes: false, twinExhaust: true, hoodVents: true, tyreWidth: 1, roofRails: false, utility: false },
  hatch: { shell: [0.97, 1.0, 0.97], cabin: [1.14, 1.3], scoop: false, intakes: false, twinExhaust: false, hoodVents: false, tyreWidth: 0.95, roofRails: false, utility: false },
  muscle: { shell: [1.03, 1.0, 1.05], cabin: [0.9, 0.94], scoop: true, intakes: false, twinExhaust: true, hoodVents: true, tyreWidth: 1.08, roofRails: false, utility: false },
  super: { shell: [1.02, 0.86, 1.06], cabin: [0.94, 0.84], scoop: false, intakes: true, twinExhaust: true, hoodVents: true, tyreWidth: 1.1, roofRails: false, utility: false },
  sedan: { shell: [1.05, 1.04, 1.0], cabin: [1.27, 1.12], scoop: false, intakes: false, twinExhaust: false, hoodVents: false, tyreWidth: 0.95, roofRails: false, utility: false },
  suv: { shell: [1.03, 1.26, 1.05], cabin: [1.32, 1.52], scoop: false, intakes: false, twinExhaust: true, hoodVents: false, tyreWidth: 1.1, roofRails: true, utility: false },
  offroad: { shell: [0.97, 1.2, 1.06], cabin: [1.2, 1.58], scoop: true, intakes: false, twinExhaust: false, hoodVents: false, tyreWidth: 1.2, roofRails: false, utility: true },
  race: { shell: [1.05, 0.8, 1.1], cabin: [0.8, 0.76], scoop: false, intakes: true, twinExhaust: true, hoodVents: true, tyreWidth: 1.15, roofRails: false, utility: false },
  motorcycle: { shell: [1, 1, 1], cabin: [1, 1], scoop: false, intakes: false, twinExhaust: false, hoodVents: false, tyreWidth: 0.5, roofRails: false, utility: false },
};

export interface CarModelOptions {
  /** Cosmetic parts (default: the style's factory fit). */
  look?: CarLook;
  /** Physics wheel radius (default CAR.wheelRadius). */
  wheelRadius?: number;
  /** Chassis ride height of this car (default CAR.rideHeight); the body is lifted by the difference. */
  rideHeight?: number;
}
/** Wheel-arch centre height: shell height scaling pivots here so arches stay over the wheels. */
const ARCH_Y = 0.34;

/** Procedural car (eight body styles, with wheel / spoiler / body-kit options). Model space: +X forward, +Y up, +Z right, ground at y = 0. */
export class CarModel {
  readonly root = new Group();
  readonly wheels: WheelVisual[] = [];
  private readonly geometries: BufferGeometry[] = [];
  // ---- damage
  private bodyMesh: Mesh | null = null;
  private bodyBase: Float32Array | null = null;
  /** Merged detail parts: one mesh per material (lamps per side), with each original part's vertex range + anchor for damage. */
  private readonly parts: Array<{ mesh: Mesh; base: Float32Array; ranges: Array<{ start: number; end: number; x: number; y: number; z: number }> }> = [];
  private readonly lampMeshes: Record<Lamp, Array<{ mesh: Mesh; mat: Material }>> = { headL: [], headR: [], tailL: [], tailR: [] };
  private brokenMat: MeshStandardMaterial | null = null;
  private headMatL: MeshStandardMaterial | null = null;
  private headMatR: MeshStandardMaterial | null = null;
  private damageKey = '';
  private readonly materials: Material[] = [];
  private readonly tailMat: MeshStandardMaterial;
  private readonly reverseMat: MeshStandardMaterial;
  private brakeOn = false;
  private reverseOn = false;
  private readonly paintMat: MeshPhysicalMaterial;
  private bikeGroup: Group | null = null;
  private readonly bikeWheelSpin: Group[] = [];

  /** Body (everything except the wheels), scaled per style. */
  readonly shell = new Group();
  readonly style: CarStyle;

  readonly look: CarLook;
  private readonly wheelRadius: number;
  private readonly rideHeight: number;

  constructor(paintColor = 0x8c0a10, style: CarStyle = 'coupe', opts: CarModelOptions = {}) {
    this.root.name = 'car-model';
    this.style = style;
    const look = (this.look = opts.look ?? FACTORY_LOOK[style]);
    this.wheelRadius = opts.wheelRadius ?? CAR.wheelRadius;
    this.rideHeight = opts.rideHeight ?? CAR.rideHeight;
    const st = STYLE[style];
    this.shell.name = 'car-shell';
    this.shell.scale.set(st.shell[0], st.shell[1], st.shell[2]);
    // Height scaling pivots on the arch centre; a taller-riding car lifts the whole body with its chassis.
    this.shell.position.y = ARCH_Y * (1 - st.shell[1]) + (this.rideHeight - CAR.rideHeight);
    this.root.add(this.shell);
    // Cabin + roof pivot at the base of the rear screen.
    const cabinPivot = new Group();
    cabinPivot.position.set(-0.6, 0.8, 0);
    cabinPivot.scale.set(st.cabin[0], st.cabin[1], 1);
    const cabinInner = new Group();
    cabinInner.position.set(0.6, -0.8, 0);
    cabinPivot.add(cabinInner);
    this.shell.add(cabinPivot);
    const paint = this.mat(
      new MeshPhysicalMaterial({ color: paintColor, metalness: 0.3, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 0.7 }),
    );
    this.paintMat = paint;
    const glass = this.mat(
      new MeshPhysicalMaterial({ color: 0x0a1016, metalness: 0.3, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
    );
    const trim = this.mat(new MeshStandardMaterial({ color: 0x121314, roughness: 0.55, metalness: 0.2 }));
    const carbon = this.mat(new MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.35, metalness: 0.4 }));
    const chrome = this.mat(new MeshStandardMaterial({ color: 0xd9dde0, roughness: 0.18, metalness: 1 }));
    const headMat = this.mat(new MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f1ff, emissiveIntensity: 1.6, roughness: 0.15 }));
    // One headlight material per side so a damaged lamp can flicker on its own.
    const headMatL = (this.headMatL = this.mat(headMat.clone()));
    const headMatR = (this.headMatR = this.mat(headMat.clone()));
    this.brokenMat = this.mat(new MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.9, metalness: 0.1 }));
    this.tailMat = this.mat(new MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1010, emissiveIntensity: 0.7, roughness: 0.25 }));
    this.reverseMat = this.mat(new MeshStandardMaterial({ color: 0xbfbfbf, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 }));
    const plate = this.mat(new MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.6 }));

    // --- Body
    const bodyGeo = this.geo(
      extrudeProfile(bodyShape(), 1.94, 0.08, (x, y) => {
        let f = 1;
        f *= 1 - 0.075 * smoothstep(0.62, 0.95, y);
        f *= 1 - 0.035 * smoothstep(0.42, 0.2, y);
        f *= 1 - 0.11 * smoothstep(1.45, 2.32, x) - 0.07 * smoothstep(1.55, 2.32, -x);
        return f;
      }),
    );
    const body = new Mesh(bodyGeo, paint);
    this.bodyMesh = body;
    body.castShadow = true;
    body.receiveShadow = true;
    this.shell.add(body);

    const cabinGeo = this.geo(
      extrudeProfile(cabinShape(), 1.5, 0.07, (x, y) => {
        let f = 1 - 0.23 * smoothstep(0.88, 1.22, y);
        f *= 1 - 0.06 * smoothstep(0.3, 0.86, x) - 0.08 * smoothstep(-1.2, -1.88, x);
        return f;
      }),
    );
    const cabin = new Mesh(cabinGeo, glass);
    cabin.castShadow = true;
    cabinInner.add(cabin);

    const roofGeo = this.geo(extrudeProfile(roofShape(), 1.2, 0.03, () => 1));
    const roof = new Mesh(roofGeo, paint);
    roof.castShadow = true;
    cabinInner.add(roof);

    // --- Details
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: Material, rz = 0, ry = 0): Mesh => {
      const g = this.geo(new BoxGeometry(w, h, d));
      const mesh = new Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.rotation.set(0, ry, rz);
      this.shell.add(mesh);
      return mesh;
    };
    // front splitter, grille, plates
    box(0.34, 0.035, 1.72, 2.08, 0.19, 0, carbon);
    box(0.08, 0.15, 1.06, 2.27, 0.37, 0, trim);
    box(0.02, 0.11, 0.44, 2.315, 0.3, 0, plate);
    for (const side of [-1, 1]) {
      box(0.08, 0.12, 0.26, 2.23, 0.34, side * 0.7, trim); // side intakes
      // headlights lying on the sloped nose (+ DRL strip); z < 0 is the car's left
      const hm = side < 0 ? headMatL : headMatR;
      const head = side < 0 ? this.lampMeshes.headL : this.lampMeshes.headR;
      head.push({ mesh: box(0.3, 0.035, 0.4, 2.135, 0.6, side * 0.6, hm, -0.66, side * 0.12), mat: hm });
      head.push({ mesh: box(0.18, 0.02, 0.36, 2.08, 0.655, side * 0.58, hm, -0.5, side * 0.1), mat: hm });
      // taillight clusters
      (side < 0 ? this.lampMeshes.tailL : this.lampMeshes.tailR).push({ mesh: box(0.06, 0.09, 0.36, -2.305, 0.76, side * 0.6, this.tailMat, 0, -side * 0.08), mat: this.tailMat });
      // reverse lights
      box(0.05, 0.05, 0.14, -2.31, 0.6, side * 0.36, this.reverseMat);
      // side skirts
      box(2.05, 0.08, 0.05, 0.02, 0.24, side * 0.95, carbon);
      // mirrors (stalk + housing)
      box(0.1, 0.04, 0.14, 0.62, 0.93, side * 0.84, trim);
      box(0.2, 0.1, 0.22, 0.6, 0.98, side * 0.97, paint);
      // spoiler uprights
      if (look.spoiler === 'wing') box(0.08, 0.2, 0.04, -1.98, 1.03, side * 0.52, carbon);
      if (look.spoiler === 'gt') box(0.08, 0.32, 0.04, -1.98, 1.09, side * 0.52, carbon);
      // exhaust tips
      if (st.twinExhaust || side > 0) {
        const ex = new Mesh(this.geo(new CylinderGeometry(style === 'muscle' ? 0.07 : 0.055, style === 'muscle' ? 0.07 : 0.055, 0.16, 14)), chrome);
        ex.rotation.z = Math.PI / 2;
        ex.position.set(-2.27, 0.3, st.twinExhaust ? side * 0.46 : 0.5);
        this.shell.add(ex);
      }
      // hood vents (not on the hatch)
      if (st.hoodVents) box(0.34, 0.012, 0.14, 1.32, 0.805, side * 0.35, trim, 0.11);
      // supercar side intakes ahead of the rear wheels
      if (st.intakes) box(0.46, 0.16, 0.04, -0.55, 0.5, side * 0.965, trim, 0, side * 0.1);
    }
    if (st.scoop) {
      box(0.62, 0.09, 0.5, 1.05, 0.86, 0, paint, 0.1);
      box(0.04, 0.06, 0.4, 1.36, 0.87, 0, trim);
    }
    // Cabin-local point -> shell space (the cabin is scaled about the base of the rear screen).
    const cabX = (x: number): number => -0.6 + (x + 0.6) * st.cabin[0];
    const cabY = (y: number): number => 0.8 + (y - 0.8) * st.cabin[1];
    if (look.spoiler === 'lip') box(0.22, 0.05, 1.62, -2.1, 0.93, 0, paint, -0.18);
    if (look.spoiler === 'roof') {
      const sp = box(0.34, 0.04, 1.18, cabX(-0.97), cabY(1.21) + 0.005, 0, paint, 0.1);
      sp.castShadow = true;
    }
    if (st.roofRails) {
      for (const side of [-1, 1]) box(Math.abs(cabX(-0.85) - cabX(-0.05)), 0.04, 0.05, (cabX(-0.85) + cabX(-0.05)) / 2, cabY(1.24) + 0.03, side * 0.5, chrome);
    }
    if (st.utility) {
      // roof rack, spare wheel on the tailgate, fender flares over all four arches
      const rx0 = cabX(-0.9);
      const rx1 = cabX(0.0);
      const ry = cabY(1.24) + 0.07;
      for (const side of [-1, 1]) box(rx1 - rx0, 0.04, 0.04, (rx0 + rx1) / 2, ry, side * 0.52, trim);
      for (let k = 0; k <= 4; k++) box(0.04, 0.04, 1.04, rx0 + ((rx1 - rx0) * k) / 4, ry, 0, trim);
      for (const [x, z] of [[CAR.wheelBaseFront, 1], [CAR.wheelBaseFront, -1], [CAR.wheelBaseRear, 1], [CAR.wheelBaseRear, -1]] as const) {
        box(1.04, 0.07, 0.1, x, 0.78, z * 0.96, trim);
      }
    }
    if (look.kit === 'street') {
      // deep splitter with end plates, side skirts, big diffuser with fins
      box(0.46, 0.03, 1.86, 2.1, 0.15, 0, carbon);
      for (const side of [-1, 1]) {
        box(0.3, 0.12, 0.02, 2.06, 0.2, side * 0.93, carbon);
        box(2.2, 0.12, 0.08, 0.02, 0.2, side * 0.99, carbon);
      }
      for (let k = -2; k <= 2; k++) box(0.34, 0.14, 0.02, -2.14, 0.26, k * 0.28, carbon);
    } else if (look.kit === 'rally') {
      // skid plate, mud flaps behind each wheel, light pod on the roof, tow hooks
      box(0.6, 0.03, 1.2, 1.9, 0.2, 0, chrome, 0.12);
      for (const side of [-1, 1]) {
        box(0.02, 0.26, 0.3, CAR.wheelBaseFront - 0.52, 0.26, side * 0.82, trim);
        box(0.02, 0.26, 0.3, CAR.wheelBaseRear - 0.52, 0.26, side * 0.82, trim);
        box(0.1, 0.05, 0.06, 2.3, 0.24, side * 0.42, chrome);
      }
      const ly = cabY(1.24) + (st.utility ? 0.14 : 0.06);
      const lx = cabX(-0.08);
      box(0.1, 0.05, 1.1, lx, ly, 0, trim);
      for (let k = -1.5; k <= 1.5; k++) box(0.06, 0.1, 0.16, lx + 0.06, ly + 0.05, k * 0.26, headMatL);
    }
    // full-width rear light bar, rear plate, diffuser and wing
    box(0.04, 0.035, 1.0, -2.31, 0.79, 0, this.tailMat);
    box(0.02, 0.11, 0.44, -2.33, 0.47, 0, plate);
    box(0.36, 0.12, 1.5, -2.08, 0.27, 0, carbon);
    if (look.spoiler === 'wing' || look.spoiler === 'gt') {
      const gt = look.spoiler === 'gt';
      const wing = gt ? box(0.4, 0.04, 1.82, -2.0, 1.27, 0, carbon) : box(0.32, 0.035, 1.66, -2.0, 1.14, 0, carbon);
      wing.rotation.z = gt ? 0.1 : 0.06;
      wing.castShadow = true;
      if (gt) for (const side of [-1, 1]) box(0.46, 0.18, 0.02, -2.0, 1.25, side * 0.92, carbon);
    }
    if (st.utility) {
      // spare wheel on the tailgate
      const spare = new Mesh(this.geo(new CylinderGeometry(0.36, 0.36, 0.22, 20)), trim);
      spare.rotation.z = Math.PI / 2;
      spare.position.set(-2.36, 0.72, 0);
      spare.castShadow = true;
      this.shell.add(spare);
    }

    this.mergeDetails();

    // --- Wheels
    this.buildWheels(trim, chrome, look.wheels, st.tyreWidth);
    if (style === 'motorcycle') {
      // Keep the common Vehicle interface, but replace the four-wheel car silhouette with a
      // bespoke two-wheel motorcycle mesh and lean the rider/bike assembly into steering.
      this.shell.visible = false;
      for (const w of this.wheels) w.pivot.visible = false;
      this.buildMotorcycle(paint, trim, chrome, headMatL);
    }
  }

  private buildMotorcycle(paint: Material, trim: Material, chrome: Material, headlamp: Material): void {
    const g = (this.bikeGroup = new Group());
    g.name = 'motorcycle-body';
    this.root.add(g);
    const tire = this.mat(new MeshStandardMaterial({ color: 0x111214, roughness: 0.93 }));
    const steel = this.mat(new MeshStandardMaterial({ color: 0x7a8084, metalness: 0.82, roughness: 0.28 }));
    const dark = this.mat(new MeshStandardMaterial({ color: 0x202326, metalness: 0.25, roughness: 0.58 }));
    const createTube = (a: Vector3, b: Vector3, radius: number, material: Material): Mesh => {
      const delta = new Vector3().subVectors(b, a);
      const mesh = new Mesh(this.geo(new CylinderGeometry(radius, radius, delta.length(), 10)), material);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize());
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };
    const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, material: Material, rx = 0): Mesh => {
      const m = new Mesh(this.geo(new BoxGeometry(sx, sy, sz)), material);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true;
      g.add(m);
      return m;
    };
    const radius = this.wheelRadius;
    for (const x of [-1.08, 1.08]) {
      const wheel = new Group();
      wheel.position.set(x, radius, 0);
      const tyre = new Mesh(this.geo(new CylinderGeometry(radius, radius, radius * 0.44, 28)), tire);
      tyre.rotation.x = Math.PI / 2;
      tyre.castShadow = true;
      wheel.add(tyre);
      const rim = new Mesh(this.geo(new CylinderGeometry(radius * 0.64, radius * 0.64, radius * 0.46, 24)), steel);
      rim.rotation.x = Math.PI / 2;
      wheel.add(rim);
      const hub = new Mesh(this.geo(new CylinderGeometry(radius * 0.17, radius * 0.17, radius * 0.53, 12)), dark);
      hub.rotation.x = Math.PI / 2;
      wheel.add(hub);
      for (let k = 0; k < 8; k++) {
        const spoke = new Mesh(this.geo(new BoxGeometry(0.018, 0.27, 0.02)), chrome);
        spoke.position.y = 0.02;
        spoke.rotation.z = k * Math.PI / 4;
        wheel.add(spoke);
      }
      g.add(wheel);
      this.bikeWheelSpin.push(wheel);
    }
    // Twin cradle frame, swing arm, engine, fuel tank and rider seat.
    createTube(new Vector3(-0.8, 0.38, 0), new Vector3(0.1, 0.66, 0), 0.055, steel);
    createTube(new Vector3(0.1, 0.66, 0), new Vector3(0.72, 0.35, 0), 0.05, steel);
    createTube(new Vector3(-0.78, 0.37, 0), new Vector3(0.15, 0.7, 0), 0.045, dark);
    createTube(new Vector3(0.15, 0.7, 0), new Vector3(0.88, 0.34, 0), 0.04, dark);
    createTube(new Vector3(0.55, 0.52, 0), new Vector3(1.0, 0.33, 0), 0.035, steel);
    createTube(new Vector3(0.45, 0.55, -0.02), new Vector3(1.0, 0.33, -0.02), 0.035, steel);
    box(0.52, 0.48, 0.38, -0.05, 0.51, 0, dark);
    box(0.84, 0.3, 0.46, 0.2, 0.88, 0, paint, -0.1);
    box(0.75, 0.12, 0.4, -0.56, 0.91, 0, trim, -0.04);
    box(0.62, 0.09, 0.38, -0.94, 0.89, 0, dark, 0.12);
    // Forks and clip-on handlebar, steering head, compact LED headlight.
    createTube(new Vector3(0.78, 0.42, -0.09), new Vector3(1.13, 1.02, -0.09), 0.035, chrome);
    createTube(new Vector3(0.78, 0.42, 0.09), new Vector3(1.13, 1.02, 0.09), 0.035, chrome);
    createTube(new Vector3(1.0, 1.0, -0.32), new Vector3(1.0, 1.0, 0.32), 0.027, dark);
    box(0.18, 0.15, 0.24, 1.08, 0.94, 0, headlamp);
    // Rear-set foot pegs and low exhaust silencer.
    createTube(new Vector3(-0.56, 0.38, 0.22), new Vector3(-0.12, 0.42, 0.22), 0.035, steel);
    createTube(new Vector3(-0.78, 0.4, -0.18), new Vector3(-0.2, 0.48, -0.18), 0.055, chrome);
    const tail = new Mesh(this.geo(new BoxGeometry(0.08, 0.06, 0.24)), this.tailMat);
    tail.position.set(-1.12, 0.84, 0);
    g.add(tail);
    // Compact low-poly rider silhouette (helmet, jacket, arms and legs) so the bike never looks
    // like an empty prop. This is procedural and uses no additional external assets.
    const rider = new Group();
    rider.name = 'motorcycle-rider';
    g.add(rider);
    const ellipsoid = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material: Material, tilt = 0): Mesh => {
      const m = new Mesh(this.geo(new SphereGeometry(1, 12, 9)), material);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.rotation.z = tilt;
      m.castShadow = true;
      rider.add(m);
      return m;
    };
    const jacket = this.mat(new MeshStandardMaterial({ color: 0x202b33, roughness: 0.8 }));
    const trousers = this.mat(new MeshStandardMaterial({ color: 0x17191c, roughness: 0.9 }));
    const helmet = this.mat(new MeshPhysicalMaterial({ color: 0xe5e9ed, roughness: 0.22, metalness: 0.18, clearcoat: 0.9 }));
    ellipsoid(-0.19, 1.22, 0, 0.24, 0.39, 0.22, jacket, -0.32);
    ellipsoid(0.1, 1.57, 0, 0.19, 0.21, 0.18, helmet);
    ellipsoid(0.25, 1.56, 0.02, 0.12, 0.075, 0.16, dark);
    for (const side of [-1, 1]) {
      createTube(new Vector3(-0.22, 1.36, side * 0.16), new Vector3(0.55, 1.04, side * 0.24), 0.075, jacket);
      createTube(new Vector3(-0.33, 0.99, side * 0.12), new Vector3(-0.1, 0.56, side * 0.15), 0.105, trousers);
      ellipsoid(0.58, 1.03, side * 0.25, 0.075, 0.055, 0.055, dark);
    }
  }

  /** Lean a motorcycle into a turn (0..1 input, positive speed). */
  setBikeLean(steer: number, speed: number): void {
    if (!this.bikeGroup) return;
    const amount = Math.min(0.48, Math.abs(speed) / 20 * 0.48) * Math.max(-1, Math.min(1, steer));
    this.bikeGroup.rotation.x = amount;
  }

  /**
   * Draw-call budget: the ~30 detail boxes become one mesh per material (each lamp group stays
   * separate so a broken lamp can go dark on its own). Each part's vertex range and original
   * position are kept, so damage still shifts every part exactly as before.
   */
  private mergeDetails(): void {
    const lampOf = new Map<Object3D, Lamp>();
    for (const lamp of ['headL', 'headR', 'tailL', 'tailR'] as const) for (const { mesh } of this.lampMeshes[lamp]) lampOf.set(mesh, lamp);
    const groups = new Map<string, Mesh[]>();
    for (const c of this.shell.children) {
      if (c === this.bodyMesh || !(c as Mesh).isMesh) continue;
      const m = c as Mesh;
      const key = `${(m.material as Material).uuid}|${lampOf.get(m) ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    }
    for (const [, list] of groups) {
      const geos: BufferGeometry[] = [];
      const ranges: Array<{ start: number; end: number; x: number; y: number; z: number }> = [];
      let v = 0;
      for (const m of list) {
        m.updateMatrix();
        const g = m.geometry.clone().applyMatrix4(m.matrix);
        const n = g.getAttribute('position').count;
        ranges.push({ start: v * 3, end: (v + n) * 3, x: m.position.x, y: m.position.y, z: m.position.z });
        v += n;
        geos.push(g);
      }
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      this.geo(merged);
      const mesh = new Mesh(merged, list[0].material);
      mesh.name = 'car-detail';
      mesh.castShadow = list.some((m) => m.castShadow);
      for (const m of list) this.shell.remove(m);
      this.shell.add(mesh);
      const lamp = lampOf.get(list[0]);
      if (lamp) this.lampMeshes[lamp] = [{ mesh, mat: list[0].material as Material }];
      this.parts.push({ mesh, base: Float32Array.from(merged.getAttribute('position').array as Float32Array), ranges });
    }
  }

  private buildWheels(trim: Material, chrome: Material, design: WheelDesign, widthK: number): void {
    const r = this.wheelRadius;
    const hw = (CAR.wheelWidth * widthK) / 2;
    const tireMat = this.mat(new MeshStandardMaterial({ color: 0x151515, roughness: 0.88, metalness: 0 }));
    const discMat = this.mat(new MeshStandardMaterial({ color: 0x77797c, roughness: 0.45, metalness: 0.9 }));
    const caliperMat = this.mat(new MeshStandardMaterial({ color: 0xd4a017, roughness: 0.4, metalness: 0.3 }));
    const rimMat =
      design === 'mesh'
        ? this.mat(new MeshStandardMaterial({ color: 0xb9bdc3, roughness: 0.3, metalness: 0.9 }))
        : design === 'turbine'
          ? this.mat(new MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.35, metalness: 0.85 }))
          : design === 'beadlock'
            ? this.mat(new MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.7, metalness: 0.3 }))
            : chrome;
    // Rim size relative to the tyre: off-road tyres have tall sidewalls.
    const rimK = design === 'beadlock' ? 0.6 : 0.7;

    const tireProfile = [
      new Vector2(r * rimK, -hw * 0.9),
      new Vector2(r * 0.9, -hw),
      new Vector2(r * 0.975, -hw * 0.92),
      new Vector2(r, -hw * 0.62),
      new Vector2(r, hw * 0.62),
      new Vector2(r * 0.975, hw * 0.92),
      new Vector2(r * 0.9, hw),
      new Vector2(r * rimK, hw * 0.9),
    ];
    // Lathe axis is Y; rotate so the axle is Z.
    const tireGeo = this.geo(new LatheGeometry(tireProfile, 32).rotateX(Math.PI / 2));
    const barrelGeo = new CylinderGeometry(r * rimK, r * rimK, hw * 1.7, 24, 1, true).rotateX(Math.PI / 2);
    const backGeo = this.geo(new CylinderGeometry(r * (rimK - 0.02), r * (rimK - 0.02), 0.01, 24).rotateX(Math.PI / 2).translate(0, 0, hw * 0.1));
    const hubGeo = new CylinderGeometry(0.06, 0.07, 0.06, 12).rotateX(Math.PI / 2).translate(0, 0, hw * 0.78);
    // Dish wheels set the spokes deep inside a wide outer lip.
    const face = design === 'dish' ? hw * 0.3 : hw * 0.72;
    const lipGeo = new CylinderGeometry(r * (rimK + 0.02), r * (rimK + 0.02), design === 'dish' ? hw * 0.5 : 0.025, 28, 1, true)
      .rotateX(Math.PI / 2)
      .translate(0, 0, design === 'dish' ? hw * 0.6 : hw * 0.82);
    const discGeo = this.geo(new CylinderGeometry(r * (rimK - 0.14), r * (rimK - 0.14), 0.028, 24).rotateX(Math.PI / 2).translate(0, 0, -hw * 0.1));
    const caliperGeo = this.geo(new BoxGeometry(0.17, 0.1, 0.07));
    const spokeLen = r * (rimK - 0.08);
    const spokeOf = (w: number, depth: number, count: number, twist = 0, phase = 0): BufferGeometry[] =>
      Array.from({ length: count }, (_, k) =>
        new BoxGeometry(w, spokeLen, depth)
          .translate(0, spokeLen / 2 + r * 0.05, face)
          .rotateZ(twist)
          .rotateZ(phase + (k / count) * Math.PI * 2),
      );
    let spokes: BufferGeometry[];
    const extra: BufferGeometry[] = [];
    switch (design) {
      case 'mesh':
        // two crossing sets of thin spokes
        spokes = [...spokeOf(0.022, 0.025, 10, 0.32), ...spokeOf(0.022, 0.025, 10, -0.32)];
        break;
      case 'dish':
        spokes = spokeOf(0.08, 0.04, 4);
        break;
      case 'turbine':
        spokes = spokeOf(0.03, 0.03, 14, 0.5);
        break;
      case 'beadlock':
        spokes = spokeOf(0.075, 0.05, 6);
        // bolt ring on the bead
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          extra.push(new CylinderGeometry(0.014, 0.014, 0.03, 6).rotateX(Math.PI / 2).translate(Math.cos(a) * r * (rimK - 0.03), Math.sin(a) * r * (rimK - 0.03), hw * 0.86));
        }
        break;
      default:
        spokes = spokeOf(0.045, 0.035, 5);
    }
    // All rim parts as one geometry, shared by the 4 wheels.
    const rimParts = [barrelGeo, hubGeo, lipGeo, ...spokes, ...extra];
    const rimGeo = this.geo(mergeGeometries(rimParts.map((g) => (g.index ? g.toNonIndexed() : g))) as BufferGeometry);
    for (const g of rimParts) g.dispose();

    for (let i = 0; i < 4; i++) {
      const right = i % 2 === 1;
      const pivot = new Group();
      const spin = new Group();
      const side = new Group();
      if (!right) side.rotation.y = Math.PI; // rim face points outward (-Z) on the left
      pivot.add(spin);
      spin.add(side);
      const tire = new Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      side.add(tire);
      side.add(new Mesh(rimGeo, rimMat));
      side.add(new Mesh(backGeo, trim));
      side.add(new Mesh(discGeo, discMat));
      // Caliper does not spin; sits at the rear-top of the disc.
      const caliper = new Mesh(caliperGeo, caliperMat);
      caliper.position.set(-r * 0.32, r * 0.36, (right ? 1 : -1) * hw * 0.05);
      caliper.rotation.z = 0.7;
      pivot.add(caliper);
      this.root.add(pivot);
      this.wheels.push({ pivot, spin });
    }
  }

  /** Position, steer and spin wheels from the physics state. */
  updateWheels(states: readonly WheelState[]): void {
    if (this.bikeWheelSpin.length) {
      const spin = states.length ? states.reduce((sum, wheel) => sum + wheel.spin, 0) / states.length : 0;
      for (const wheel of this.bikeWheelSpin) wheel.rotation.z = -spin;
      return;
    }
    for (let i = 0; i < 4; i++) {
      const s = states[i];
      const w = this.wheels[i];
      w.pivot.position.set(s.mount.x, this.rideHeight + s.mount.y - s.suspension, s.mount.z);
      w.pivot.rotation.y = s.steer;
      w.spin.rotation.z = -s.spin;
    }
  }

  /**
   * Show collision damage: dents (body vertices pushed in per zone, with deterministic crumple
   * noise), parts in the crushed area moved with it, broken lamps dark. Cheap: only recomputed
   * when the damage actually changes.
   */
  setDamage(d: DamageState): void {
    const z = d.zones;
    const key = `${z.front.toFixed(3)}|${z.rear.toFixed(3)}|${z.left.toFixed(3)}|${z.right.toFixed(3)}|${+d.lamps.headL}${+d.lamps.headR}${+d.lamps.tailL}${+d.lamps.tailR}`;
    if (key === this.damageKey) return;
    this.damageKey = key;
    const body = this.bodyMesh;
    if (body) {
      const pos = body.geometry.getAttribute('position') as BufferAttribute;
      if (!this.bodyBase) this.bodyBase = Float32Array.from(pos.array as Float32Array);
      const base = this.bodyBase;
      const out = pos.array as Float32Array;
      for (let i = 0; i < base.length; i += 3) {
        dent(base[i], base[i + 1], base[i + 2], z.front, z.rear, z.left, z.right, true, TMP);
        out[i] = base[i] + TMP.x;
        out[i + 1] = base[i + 1] + TMP.y;
        out[i + 2] = base[i + 2] + TMP.z;
      }
      pos.needsUpdate = true;
      body.geometry.computeVertexNormals();
      body.geometry.computeBoundingSphere();
    }
    for (const part of this.parts) {
      const pos = part.mesh.geometry.getAttribute('position') as BufferAttribute;
      const out = pos.array as Float32Array;
      const base = part.base;
      for (const r of part.ranges) {
        dent(r.x, r.y, r.z, z.front, z.rear, z.left, z.right, false, TMP);
        for (let i = r.start; i < r.end; i += 3) {
          out[i] = base[i] + TMP.x;
          out[i + 1] = base[i + 1] + TMP.y;
          out[i + 2] = base[i + 2] + TMP.z;
        }
      }
      pos.needsUpdate = true;
      part.mesh.geometry.computeBoundingSphere();
    }
    for (const lamp of ['headL', 'headR', 'tailL', 'tailR'] as const) {
      for (const { mesh, mat } of this.lampMeshes[lamp]) mesh.material = d.lamps[lamp] && this.brokenMat ? this.brokenMat : mat;
    }
  }

  /** Damaged-but-working headlights flicker (call per frame with a running time; on = healthy). */
  flickerHeadlights(t: number, on: boolean): void {
    if (!this.headMatL || !this.headMatR) return;
    const f = on ? 1 : Math.sin(t * 37) * Math.sin(t * 13.3) > 0.25 ? 0.15 : 1;
    this.headMatL.emissiveIntensity = 1.6 * f;
    this.headMatR.emissiveIntensity = 1.6 * (on ? 1 : Math.sin(t * 29) * Math.sin(t * 7.1) > 0.3 ? 0.2 : 1);
  }

  /** Change the body colour (garage). */
  setPaint(color: number): void {
    this.paintMat.color.setHex(color);
  }

  setLights(braking: boolean, reversing: boolean): void {
    if (braking !== this.brakeOn) {
      this.brakeOn = braking;
      this.tailMat.emissiveIntensity = braking ? 3.2 : 0.7;
    }
    if (reversing !== this.reverseOn) {
      this.reverseOn = reversing;
      this.reverseMat.emissiveIntensity = reversing ? 2.2 : 0;
    }
  }

  private geo<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mat<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  /**
   * Model-frame (root) position of a point given in the body's unscaled design frame; with `cabin` the point is in
   * the cabin's own frame (the cabin is scaled per style about the base of the rear screen). Used by the cockpit
   * view to fit its interior to every body style.
   */
  designPoint(x: number, y: number, z: number, cabin: boolean, out: Vector3): Vector3 {
    const st = STYLE[this.style];
    if (cabin) {
      x = -0.6 + (x + 0.6) * st.cabin[0];
      y = 0.8 + (y - 0.8) * st.cabin[1];
    }
    return out.set(x * st.shell[0], this.shell.position.y + y * st.shell[1], z * st.shell[2]);
  }

  /** Body paint material (the cockpit view clips the body top inside the cabin through it). */
  get paintMaterial(): MeshPhysicalMaterial {
    return this.paintMat;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
