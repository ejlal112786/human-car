import type RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PhysicsWorld } from '../PhysicsWorld';

/**
 * Harbor County Jail: a walled compound outside the city boundary (x ≈ 634…720), reached only by the
 * arrest transfer. Real colliders everywhere (walls, bars, doors, crawl-space ceilings), so walking,
 * crouching through the vent / tunnel and guard sight lines all use the normal physics.
 *
 * Local plan (metres; +x east, +z south; world = local + JAIL_ORIGIN):
 *
 *   z -22 ┌──────┬────────┬──────────────┬───────────┬────────────────────────────┐
 *         │ duct │ cells  │   corridor   │  office   │ storage │                  │
 *         │      │ c0..c4 │              │ (keycard) │         │      yard        │
 *    -8   │      │        │              ├───────────┴─────────┤                  │
 *    -2   ├──────┴────────┤              │    common room      │ door        gate │ x = 40
 *         │  maintenance  │ staff door   │  (fire alarm)       │                  │
 *     8   ├──┬────────────┼── security ──┴─────────────────────┤                  │
 *         │t │            │   sally port          front gate   │                  │
 *    22   └──┴────────────┴───────────────────────┴────┴───────┴──────────────────┘
 *        -46 -44         -38            -32      -18          -4                  40
 */

export const JAIL_ORIGIN = { x: 680, z: 0 } as const;
/** Cell bars + barred cell door: collision membership group 2, so sight lines (filtering group 2 out) see through them. */
export const BAR_GROUPS = (0x0002 << 16) | 0xffff;
const WALL_H = 3.4;
const PERIM_H = 5;
const T = 0.3;
/** Crawl spaces: the ceiling underside (a crouched character is 1.1 m tall). */
export const CRAWL_H = 1.22;

export type DoorId = 'cell' | 'vent' | 'staff' | 'security' | 'yardGate' | 'hatch';

export interface JailDoor {
  id: DoorId;
  open: boolean;
  readonly collider: RAPIER.Collider;
  readonly mesh: Mesh;
  /** Closed / open mesh offset (local). */
  readonly closedPos: [number, number, number];
  readonly openPos: [number, number, number];
}

export type InteractId = 'cellDoor' | 'vent' | 'phone' | 'staffDoor' | 'keycard' | 'securityDoor' | 'emergency' | 'breaker' | 'hatch' | 'alarm';

export interface Interactable {
  id: InteractId;
  x: number;
  z: number;
  r: number;
}

export type ZoneId = 'cell' | 'duct' | 'maintenance' | 'tunnel' | 'corridor' | 'office' | 'common' | 'sally' | 'yard' | 'gateArea' | 'outside';

/** Axis-aligned room rectangles (local), first match wins (more specific first). */
const ZONES: ReadonlyArray<[ZoneId, number, number, number, number]> = [
  ['outside', 40, -40, 80, 40],
  ['outside', -80, 22, 80, 60],
  ['gateArea', 31, -8, 40, 8],
  ['cell', -44, -18, -38, -14],
  ['duct', -46, -22, -44, -2],
  ['maintenance', -46, -2, -38, 8],
  ['tunnel', -46, 8, -44, 22],
  ['corridor', -38, -22, -32, 8],
  ['office', -32, -22, -18, -8],
  ['common', -32, -8, -4, 8],
  ['sally', -38, 8, -4, 22],
  ['yard', -4, -22, 40, 22],
];

export function zoneAt(lx: number, lz: number): ZoneId | null {
  for (const [id, x0, z0, x1, z1] of ZONES) if (lx >= x0 && lx <= x1 && lz >= z0 && lz <= z1) return id;
  return null;
}

/** Spawn points (local feet position + yaw: forward = (sin yaw, cos yaw)). */
export const SPAWNS = {
  cell: { x: -41.6, z: -16, yaw: Math.PI / 2 },
  maintenance: { x: -42.5, z: 1.5, yaw: Math.PI / 2 },
} as const;

/** Exit thresholds (local): reaching one = out. */
export const EXITS: ReadonlyArray<{ id: 'front' | 'yard' | 'tunnel'; x0: number; z0: number; x1: number; z1: number }> = [
  { id: 'front', x0: -22, z0: 21.6, x1: -18, z1: 24 },
  { id: 'yard', x0: 40.2, z0: -2, x1: 43, z1: 2 },
  { id: 'tunnel', x0: -45.8, z0: 21.6, x1: -44.2, z1: 24 },
];

export const INTERACTS: readonly Interactable[] = [
  { id: 'cellDoor', x: -38.7, z: -16, r: 1.3 },
  { id: 'vent', x: -43.3, z: -16, r: 1.2 },
  { id: 'phone', x: -40.5, z: -17.4, r: 1.0 },
  { id: 'staffDoor', x: -38.6, z: 3, r: 1.4 },
  { id: 'keycard', x: -24, z: -15.2, r: 1.5 },
  { id: 'securityDoor', x: -35, z: 7.3, r: 1.4 },
  // Emergency cutoff in the cell means a first-time player can start the escape immediately.
  { id: 'emergency', x: -41.0, z: -14.9, r: 1.35 },
  { id: 'breaker', x: -45.2, z: 5, r: 1.3 },
  { id: 'hatch', x: -45, z: 7.2, r: 1.3 },
  { id: 'alarm', x: -32.6, z: -20.5, r: 1.3 },
];

export interface GuardDef {
  route: ReadonlyArray<{ x: number; z: number; wait: number }>;
}

export const GUARDS: readonly GuardDef[] = [
  // Corridor
  { route: [{ x: -35, z: -19.5, wait: 2.5 }, { x: -35, z: -6, wait: 0.5 }, { x: -35, z: 5.5, wait: 2.5 }, { x: -35, z: -6, wait: 0.5 }] },
  // Office (watches the desk and the door)
  { route: [{ x: -21.5, z: -12, wait: 5 }, { x: -29, z: -19.5, wait: 2.5 }, { x: -21, z: -20, wait: 2 }] },
  // Yard
  { route: [{ x: 4, z: -16, wait: 1 }, { x: 28, z: -16, wait: 1.5 }, { x: 33, z: 0, wait: 3 }, { x: 28, z: 16, wait: 1.5 }, { x: 4, z: 16, wait: 1 }, { x: 2, z: 0, wait: 2 }] },
];

export interface CameraDef {
  x: number;
  y: number;
  z: number;
  /** Facing (rad, forward = (sin, cos)) at the middle of the sweep, sweep half-angle, period (s). */
  yaw: number;
  sweep: number;
  period: number;
}

export const CAMERAS: readonly CameraDef[] = [
  { x: -35, y: 3.1, z: -21.6, yaw: 0, sweep: 0.45, period: 9 },
  { x: -38.6, y: 3.1, z: -1.6, yaw: -0.72, sweep: 0.5, period: 8 },
  { x: 38.6, y: 4.2, z: -8.5, yaw: -0.3, sweep: 0.6, period: 10 },
];

type Box = [number, number, number, number, number, number];

export class JailLayout {
  readonly group = new Group();
  readonly doors = new Map<DoorId, JailDoor>();
  /** Camera heads (rotate with the sweep) and their ground fans. */
  readonly cameraHeads: Group[] = [];
  readonly cameraFans: Mesh[] = [];
  readonly keycardMesh: Mesh;
  readonly breakerLever: Mesh;
  readonly emergencyPanel: Mesh;
  readonly emergencyLever: Mesh;
  private readonly fluorescentMaterial: MeshStandardMaterial;
  readonly alarmLight: MeshBasicMaterial;
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Material[] = [];
  private readonly texs: CanvasTexture[] = [];

  constructor(private readonly physics: PhysicsWorld) {
    this.group.name = 'jail';
    this.group.position.set(JAIL_ORIGIN.x, 0, JAIL_ORIGIN.z);
    const concrete = this.mat(new MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.95 }));
    const perimeter = this.mat(new MeshStandardMaterial({ color: 0x8d8a83, roughness: 1 }));
    const trim = this.mat(new MeshStandardMaterial({ color: 0x3d4652, roughness: 0.7 }));
    const steel = this.mat(new MeshStandardMaterial({ color: 0x59606a, roughness: 0.45, metalness: 0.7 }));
    const floorIn = this.mat(new MeshStandardMaterial({ color: 0x9a978f, roughness: 0.9 }));
    const yardMat = this.mat(new MeshStandardMaterial({ color: 0x6e6f6a, roughness: 1 }));
    const wood = this.mat(new MeshStandardMaterial({ color: 0x7b5a3a, roughness: 0.8 }));
    const bunk = this.mat(new MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.9 }));
    const glass = this.mat(new MeshStandardMaterial({ color: 0x9fb8c8, roughness: 0.2, transparent: true, opacity: 0.35, side: DoubleSide, depthWrite: false }));

    this.fluorescentMaterial = this.mat(new MeshStandardMaterial({ color: 0xe3e6df, emissive: 0xc2d8e8, emissiveIntensity: 1.6, roughness: 0.4 }));

    const concreteBoxes: Box[] = [];
    const perimBoxes: Box[] = [];
    const steelBoxes: Box[] = [];
    const trimBoxes: Box[] = [];
    const wall = (list: Box[], x0: number, z0: number, x1: number, z1: number, h: number, y0 = 0, collide = true): void => {
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const hx = Math.max(T / 2, Math.abs(x1 - x0) / 2);
      const hz = Math.max(T / 2, Math.abs(z1 - z0) / 2);
      const hy = h / 2;
      list.push([cx, y0 + hy, cz, hx, hy, hz]);
      if (collide) this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x + cx, y0 + hy, JAIL_ORIGIN.z + cz, hx, hy, hz));
    };
    /** Wall along x (constant z) or along z (constant x) with door gaps [a, b] along its length. */
    const wallGaps = (list: Box[], fixed: 'x' | 'z', at: number, from: number, to: number, gaps: Array<[number, number]>, h: number): void => {
      let s = from;
      for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
        if (a > s) fixed === 'z' ? wall(list, s, at, a, at, h) : wall(list, at, s, at, a, h);
        // Lintel over doorways in interior walls.
        if (h <= WALL_H) fixed === 'z' ? wall(list, a, at, b, at, h - 2.3, 2.3) : wall(list, at, a, at, b, h - 2.3, 2.3);
        s = b;
      }
      if (to > s) fixed === 'z' ? wall(list, s, at, to, at, h) : wall(list, at, s, at, to, h);
    };

    // --- Perimeter (5 m): gates on the east (yard) and south (front), tunnel hole south-west.
    wallGaps(perimBoxes, 'z', -22, -46.3, 40.3, [], PERIM_H);
    wallGaps(perimBoxes, 'z', 22, -46.3, 40.3, [[-45.7, -44.3], [-22, -18]], PERIM_H);
    wallGaps(perimBoxes, 'x', -46, -22, 22, [], PERIM_H);
    wall(perimBoxes, -45.7, 22, -44.3, 22, PERIM_H - CRAWL_H - 0.3, CRAWL_H + 0.3); // tunnel runs under the wall
    wallGaps(perimBoxes, 'x', 40, -22, 22, [[-2, 2]], PERIM_H);
    // Fences beyond the exits so nobody wanders into the countryside before the exit triggers.
    wall(perimBoxes, -22.2, 22, -22.2, 26, PERIM_H);
    wall(perimBoxes, -17.8, 22, -17.8, 26, PERIM_H);
    wall(perimBoxes, -22.2, 26, -17.8, 26, PERIM_H);
    wall(perimBoxes, 40, -2.2, 44, -2.2, PERIM_H);
    wall(perimBoxes, 40, 2.2, 44, 2.2, PERIM_H);
    wall(perimBoxes, 44, -2.2, 44, 2.2, PERIM_H);
    wall(perimBoxes, -45.9, 22, -45.9, 25, CRAWL_H + 0.3);
    wall(perimBoxes, -44.1, 22, -44.1, 25, CRAWL_H + 0.3);
    wall(perimBoxes, -46, 25, -44, 25, CRAWL_H + 0.3);

    // --- Cell block
    // Back wall of the cells, with the vent opening (1.1 m high) in cell 1.
    wall(concreteBoxes, -44, -22, -44, -16.6, WALL_H);
    wall(concreteBoxes, -44, -15.4, -44, -2, WALL_H);
    wall(concreteBoxes, -44, -16.6, -44, -15.4, WALL_H - 1.12, 1.12);
    for (const z of [-18, -14, -10, -6]) wall(concreteBoxes, -44, z, -38, z, WALL_H);
    wallGaps(concreteBoxes, 'z', -2, -44, -38, [], WALL_H);
    // Cell fronts: barred (solid collider, bar visuals), door gap in cell 1 only.
    for (let k = 0; k < 5; k++) {
      const z0 = -22 + k * 4;
      const gaps: Array<[number, number]> = k === 1 ? [[-16.7, -15.3]] : [];
      let s = z0;
      for (const [a, b] of gaps) {
        const c = this.physics.addStaticBox(JAIL_ORIGIN.x - 38, WALL_H / 2, JAIL_ORIGIN.z + (s + a) / 2, 0.08, WALL_H / 2, (a - s) / 2);
        c.setCollisionGroups(BAR_GROUPS);
        this.colliders.push(c);
        s = b;
      }
      const c = this.physics.addStaticBox(JAIL_ORIGIN.x - 38, WALL_H / 2, JAIL_ORIGIN.z + (s + z0 + 4) / 2, 0.08, WALL_H / 2, (z0 + 4 - s) / 2);
      c.setCollisionGroups(BAR_GROUPS);
      this.colliders.push(c);
      for (let b = 0; b < 16; b++) {
        const z = z0 + 0.15 + b * 0.25;
        if (k === 1 && z > -16.75 && z < -15.25) continue;
        steelBoxes.push([-38, WALL_H / 2, z, 0.03, WALL_H / 2, 0.03]);
      }
      steelBoxes.push([-38, 0.05, z0 + 2, 0.06, 0.05, 2], [-38, WALL_H - 0.05, z0 + 2, 0.06, 0.05, 2], [-38, 1.1, z0 + 2, 0.04, 0.03, 2]);
      // Bunk + toilet in every cell.
      this.box(bunk, -42.9, 0.45, z0 + 1.2, 1.0, 0.12, 0.42);
      this.box(steel, -42.9, 0.2, z0 + 1.2, 0.9, 0.2, 0.05);
      this.box(steel, -43.6, 0.25, z0 + 3.2, 0.22, 0.25, 0.2);
    }
    // Duct: west perimeter, back wall of the cells; low kinematic ceiling (crouch only; the camera sees through).
    this.crawlCeiling(-45.85, -22, -44.15, -2, glass);
    // --- Maintenance room
    wallGaps(concreteBoxes, 'x', -38, -2, 8, [[2.3, 3.7]], WALL_H);
    wallGaps(concreteBoxes, 'z', 8, -46, -38, [[-45.7, -44.3]], WALL_H);
    this.box(trim, -41, 0.6, 7.2, 1.2, 0.6, 0.5); // boiler
    this.box(steel, -39.5, 1.0, -1.4, 1.2, 1.0, 0.35); // shelving
    // --- Tunnel: low ceiling, east wall.
    wall(concreteBoxes, -44.15, 8, -44.15, 22, CRAWL_H + 0.3);
    this.crawlCeiling(-45.85, 8, -44.15, 22, glass);
    // Dead space between the tunnel and the sally port.
    wall(concreteBoxes, -44, 8.2, -38.2, 21.8, WALL_H, 0, true);
    // --- Corridor (east side) / office / common room / sally port
    wallGaps(concreteBoxes, 'x', -32, -22, 8, [[-12.7, -11.3], [-1, 1]], WALL_H);
    wallGaps(concreteBoxes, 'z', 8, -38, -4, [[-35.7, -34.3]], WALL_H);
    wallGaps(concreteBoxes, 'z', -8, -32, -4, [], WALL_H);
    wallGaps(concreteBoxes, 'x', -18, -22, -8, [], WALL_H);
    wallGaps(concreteBoxes, 'x', -4, -22, 22, [[-1.5, 1.5]], WALL_H);
    wallGaps(concreteBoxes, 'x', -38, 8, 22, [], WALL_H);
    // Storage block (closed).
    wall(concreteBoxes, -17.8, -21.8, -4.2, -8.2, WALL_H);
    // Office furniture: desk with the keycard, filing cabinets, monitor bank.
    this.box(wood, -24, 0.38, -15.2, 1.1, 0.04, 0.5);
    for (const [x, z] of [[-24.9, -15.6], [-23.1, -15.6], [-24.9, -14.8], [-23.1, -14.8]]) this.box(trim, x, 0.18, z, 0.04, 0.18, 0.04);
    this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x - 24, 0.4, JAIL_ORIGIN.z - 15.2, 1.1, 0.4, 0.5));
    this.box(trim, -31.4, 0.9, -20, 0.35, 0.9, 1.4);
    this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x - 31.4, 0.9, JAIL_ORIGIN.z - 20, 0.35, 0.9, 1.4));
    this.box(trim, -18.5, 1.3, -18, 0.15, 0.6, 1.6);
    // Common room tables + benches.
    for (const [x, z] of [[-26, -3], [-26, 3], [-16, -3], [-16, 3], [-10, 0]]) {
      this.box(steel, x, 0.72, z, 1.2, 0.04, 0.5);
      this.box(steel, x, 0.36, z, 0.08, 0.36, 0.08);
      this.box(steel, x, 0.42, z - 0.9, 1.2, 0.04, 0.18);
      this.box(steel, x, 0.42, z + 0.9, 1.2, 0.04, 0.18);
      this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x + x, 0.4, JAIL_ORIGIN.z + z, 1.2, 0.4, 1.1));
    }
    // Sally port: guard booth.
    this.box(trim, -12, 1.2, 15, 2, 1.2, 1.6);
    this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x - 12, 1.2, JAIL_ORIGIN.z + 15, 2, 1.2, 1.6));
    // Yard: benches, a hoop, painted lines.
    for (const [x, z] of [[10, -20], [20, -20], [10, 20], [20, 20]]) {
      this.box(wood, x, 0.45, z, 1.5, 0.05, 0.3);
      this.colliders.push(this.physics.addStaticBox(JAIL_ORIGIN.x + x, 0.4, JAIL_ORIGIN.z + z, 1.5, 0.4, 0.3));
    }
    this.box(steel, 24, 1.6, 0, 0.08, 1.6, 0.08);
    this.box(bunk, 23.8, 3.2, 0, 0.05, 0.5, 0.7);

    // Floors.
    this.plane(floorIn, -25, -7, 42, 30, 0.012);
    this.plane(floorIn, -21, 15, 34, 14, 0.012);
    this.plane(floorIn, -45, 15, 2, 14, 0.012);
    this.plane(yardMat, 18, 0, 44, 44, 0.01);
    this.plane(floorIn, -20, 24, 4.4, 4.2, 0.012);
    this.plane(yardMat, 42, 0, 4, 4.4, 0.01);

    // Merge static boxes per material.
    this.merged(concreteBoxes, concrete, true);
    this.merged(perimBoxes, perimeter, true);
    this.merged(steelBoxes, steel, false);
    this.merged(trimBoxes, trim, false);
    // Razor wire on the perimeter.
    this.box(steel, -3, PERIM_H + 0.15, -22, 43.3, 0.15, 0.15);
    this.box(steel, -3, PERIM_H + 0.15, 22, 43.3, 0.15, 0.15);
    this.box(steel, 40, PERIM_H + 0.15, 0, 0.15, 0.15, 22);
    this.box(steel, -46, PERIM_H + 0.15, 0, 0.15, 0.15, 22);

    // --- Doors (collider on = closed).
    const doorMat = this.mat(new MeshStandardMaterial({ color: 0x4a5560, roughness: 0.5, metalness: 0.5 }));
    const gateMat = this.mat(new MeshStandardMaterial({ color: 0x2f353c, roughness: 0.5, metalness: 0.6 }));
    this.door('cell', -38, 1.15, -16, 0.06, 1.15, 0.7, steel, [0, 0, 0], [0, 0, 1.45], true);
    {
      // The cell door is a barred gate (sight lines see through it): the slab mesh carries the bars as one
      // merged child mesh and is itself not drawn.
      const cell = this.doors.get('cell')!;
      const bars: BufferGeometry[] = [];
      for (let k = 0; k < 6; k++) bars.push(new BoxGeometry(0.06, 2.3, 0.06).translate(0, 0, -0.62 + k * 0.248));
      for (const y of [-1.1, 0, 1.1]) bars.push(new BoxGeometry(0.08, 0.08, 1.4).translate(0, y, 0));
      const merged = this.geo(mergeGeometries(bars)!);
      for (const g of bars) g.dispose();
      const barMesh = new Mesh(merged, steel);
      barMesh.castShadow = true;
      cell.mesh.add(barMesh);
      cell.mesh.material = this.mat(new MeshBasicMaterial({ visible: false }));
      cell.mesh.castShadow = false;
    }
    this.doors.get('cell')!.collider.setCollisionGroups(BAR_GROUPS);
    this.door('vent', -43.9, 0.55, -16, 0.08, 0.55, 0.6, this.mat(new MeshStandardMaterial({ color: 0x8a9096, roughness: 0.5, metalness: 0.6 })), [0, 0, 0], [0.45, -0.5, 0], true);
    this.door('staff', -38, 1.15, 3, 0.07, 1.15, 0.7, doorMat, [0, 0, 0], [0, 0, 1.4], true);
    this.door('security', -35, 1.15, 8, 0.7, 1.15, 0.08, doorMat, [0, 0, 0], [1.4, 0, 0], true);
    this.door('yardGate', 40, PERIM_H / 2 - 0.5, 0, 0.12, PERIM_H / 2 - 0.5, 2, gateMat, [0, 0, 0], [0, 0, 4.1], true);
    this.door('hatch', -45, 0.6, 8, 0.7, 0.6, 0.06, this.mat(new MeshStandardMaterial({ color: 0x7c8287, roughness: 0.6, metalness: 0.5 })), [0, 0, 0], [0, -1.25, 0], true);

    // --- Props for the interactions.
    this.keycardMesh = this.box(this.mat(new MeshStandardMaterial({ color: 0x2f7dff, emissive: 0x0d3c9a, roughness: 0.4 })), -24, 0.44, -15.2, 0.09, 0.008, 0.055);
    this.box(trim, -45.85, 1.4, 5, 0.1, 0.5, 0.4); // breaker panel
    this.breakerLever = this.box(this.mat(new MeshStandardMaterial({ color: 0xd2a02a, roughness: 0.5 })), -45.72, 1.55, 5, 0.06, 0.18, 0.04);
    this.emergencyPanel = this.box(this.mat(new MeshStandardMaterial({ color: 0x303741, roughness: 0.6, metalness: 0.4 })), -41.0, 1.38, -14.2, 0.1, 0.48, 0.34);
    this.emergencyLever = this.box(this.mat(new MeshStandardMaterial({ color: 0xe5bd55, emissive: 0x463408, roughness: 0.45 })), -40.87, 1.38, -14.2, 0.035, 0.27, 0.045);
    this.alarmLight = new MeshBasicMaterial({ color: 0x701010 });
    this.mats.push(this.alarmLight);
    this.box(this.alarmLight, -32.15, 1.4, -20.5, 0.06, 0.16, 0.12);
    this.box(trim, -40.5, 1.3, -17.92, 0.12, 0.18, 0.05); // cell phone
    this.sign('FRONT GATE', -20, 3.0, 21.75, 0);
    this.sign('YARD GATE', 39.75, 4.2, 0, -Math.PI / 2);
    this.sign('STAFF ONLY', -37.83, 2.55, 3, Math.PI / 2);
    this.sign('SECURITY', -35, 2.55, 7.83, Math.PI);
    this.sign('INTAKE / CONTROL', -35, 2.75, -21.75, 0);
    this.sign('CELL BLOCK A', -37.82, 2.55, -12, Math.PI / 2);
    this.sign('VISITATION', -20, 2.55, -8.15, 0);
    this.sign('COUNT IN PROGRESS', -35, 2.55, 0.2, Math.PI / 2);

    // Cool, hard-edged fluorescent fittings make the interior read as an institution rather than
    // an empty grey maze. Emissive meshes stay inexpensive and need no extra shadow-casting lights.
    const fluorescent = this.fluorescentMaterial;
    for (const [x, z] of [[-35, -17], [-35, -7], [-35, 2], [-27, -14], [-17, -3], [-17, 6], [-22, 14]] as const) {
      this.box(fluorescent, x, 3.28, z, 1.15, 0.035, 0.2);
    }
    // Painted secure-area stripe and a floor count line at the yard muster point.
    const safetyStripe = this.mat(new MeshStandardMaterial({ color: 0xc49a32, roughness: 0.9 }));
    this.box(safetyStripe, -37.75, 0.018, -4, 0.025, 0.012, 10);
    this.box(safetyStripe, -35, 0.018, 0, 0.7, 0.012, 0.025);

    // --- Cameras: head + translucent coverage fan on the floor.
    const camBody = this.mat(new MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 }));
    for (const c of CAMERAS) {
      const head = new Group();
      head.position.set(c.x, c.y, c.z);
      const m = new Mesh(this.geo(new BoxGeometry(0.18, 0.16, 0.42)), camBody);
      m.position.z = 0.15;
      head.add(m);
      const lens = new Mesh(this.geo(new CylinderGeometry(0.06, 0.06, 0.04, 10)), this.mat(new MeshBasicMaterial({ color: 0x111111 })));
      lens.rotation.x = Math.PI / 2;
      lens.position.z = 0.37;
      head.add(lens);
      this.group.add(head);
      this.cameraHeads.push(head);
      const fan = new Mesh(this.geo(new CircleGeometry(CAMERA_RANGE * 0.92, 20, -CAMERA_FOV / 2, CAMERA_FOV)), this.mat(new MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide })));
      fan.position.set(c.x, 0.03, c.z);
      fan.renderOrder = 2;
      this.group.add(fan);
      this.cameraFans.push(fan);
    }
  }

  // ------------------------------------------------------------------ building helpers

  private mat<M extends Material>(m: M): M {
    this.mats.push(m);
    return m;
  }

  private geo<G extends BufferGeometry>(g: G): G {
    this.geos.push(g);
    return g;
  }

  private box(mat: Material, x: number, y: number, z: number, hx: number, hy: number, hz: number): Mesh {
    const m = new Mesh(this.geo(new BoxGeometry(hx * 2, hy * 2, hz * 2)), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  private plane(mat: Material, x: number, z: number, w: number, d: number, y: number): void {
    const g = this.geo(new PlaneGeometry(w, d));
    g.rotateX(-Math.PI / 2);
    const m = new Mesh(g, mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    this.group.add(m);
  }

  private merged(boxes: Box[], mat: Material, shadows: boolean): void {
    if (!boxes.length) return;
    const parts = boxes.map(([x, y, z, hx, hy, hz]) => new BoxGeometry(hx * 2, hy * 2, hz * 2).translate(x, y, z));
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!g) return;
    this.geos.push(g);
    const m = new Mesh(g, mat);
    m.castShadow = shadows;
    m.receiveShadow = true;
    this.group.add(m);
  }

  /** Low crawl-space ceiling: kinematic collider (blocks standing up; camera rays skip it), see-through visual. */
  private crawlCeiling(x0: number, z0: number, x1: number, z1: number, mat: Material): void {
    const { R, world } = this.physics;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(JAIL_ORIGIN.x + cx, CRAWL_H + 0.15, JAIL_ORIGIN.z + cz));
    this.bodies.push(body);
    this.colliders.push(world.createCollider(R.ColliderDesc.cuboid(Math.abs(x1 - x0) / 2, 0.15, Math.abs(z1 - z0) / 2), body));
    const g = this.geo(new PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0)));
    g.rotateX(-Math.PI / 2);
    const m = new Mesh(g, mat);
    m.position.set(cx, CRAWL_H + 0.3, cz);
    m.renderOrder = 3;
    this.group.add(m);
  }

  private door(id: DoorId, x: number, y: number, z: number, hx: number, hy: number, hz: number, mat: Material, closed: [number, number, number], open: [number, number, number], solid: boolean): void {
    const collider = this.physics.addStaticBox(JAIL_ORIGIN.x + x, y, JAIL_ORIGIN.z + z, hx, hy, hz);
    this.colliders.push(collider);
    const mesh = this.box(mat, x, y, z, hx, hy, hz);
    this.doors.set(id, { id, open: !solid, collider, mesh, closedPos: [x + closed[0], y + closed[1], z + closed[2]], openPos: [x + open[0], y + open[1], z + open[2]] });
  }

  private sign(text: string, x: number, y: number, z: number, yaw: number): void {
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#1d2733';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#f2d14b';
    ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    this.texs.push(t);
    const m = new Mesh(this.geo(new PlaneGeometry(1.6, 0.4)), this.mat(new MeshBasicMaterial({ map: t })));
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    this.group.add(m);
  }

  // ------------------------------------------------------------------ runtime

  setPower(on: boolean): void {
    this.fluorescentMaterial.emissiveIntensity = on ? 1.7 : 0.015;
    this.fluorescentMaterial.color.set(on ? 0xfff0c5 : 0x5b5a57);
  }

  setDoor(id: DoorId, open: boolean): void {
    const d = this.doors.get(id);
    if (!d || d.open === open) return;
    d.open = open;
    d.collider.setEnabled(!open);
    const p = open ? d.openPos : d.closedPos;
    d.mesh.position.set(p[0], p[1], p[2]);
  }

  isOpen(id: DoorId): boolean {
    return this.doors.get(id)?.open ?? false;
  }

  aimSecurityCamera(k: number, yaw: number, on: boolean): void {
    const h = this.cameraHeads[k];
    const f = this.cameraFans[k];
    if (!h || !f) return;
    h.rotation.set(0.5, yaw, 0, 'YXZ');
    // Fan lies flat: CircleGeometry spans its angles around +X in the XY plane; turn it onto the floor facing `yaw`.
    f.rotation.set(-Math.PI / 2, yaw - Math.PI / 2, 0, 'YXZ');
    f.visible = on;
    // A powered-down camera droops.
    if (!on) h.rotation.x = 1.1;
  }

  setFanColor(k: number, alert: number): void {
    const f = this.cameraFans[k];
    if (!f) return;
    (f.material as MeshBasicMaterial).color.copy(FAN_IDLE).lerp(FAN_ALERT, Math.min(1, alert));
  }

  dispose(): void {
    const { world } = this.physics;
    for (const c of this.colliders) {
      const b = c.parent();
      if (b && !this.bodies.includes(b)) world.removeRigidBody(b);
    }
    for (const b of this.bodies) world.removeRigidBody(b);
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}

export const CAMERA_RANGE = 15;
export const CAMERA_FOV = (52 * Math.PI) / 180;
const FAN_IDLE = new Color(0xff9f30);
const FAN_ALERT = new Color(0xff2020);
