import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  BufferGeometry,
  Float32BufferAttribute,
  type Material,
  type Texture,
} from 'three';
import { ownShadowDepth } from '../world/Props';
import type { Track } from '../world/Track';
import type { GateSpec, ZoneSpec } from './Levels';

const MAX_GATES = 16;
const NEXT_COLOR = new Color(0x34e89e);
const LATER_COLOR = new Color(0x8fa3b8);

function chevronTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#1b2430';
    g.fillRect(0, 0, 256, 6);
    g.fillRect(0, 58, 256, 6);
    g.lineWidth = 9;
    g.strokeStyle = '#1b2430';
    for (let x = 18; x < 256; x += 44) {
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x + 16, 32);
      g.lineTo(x, 48);
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  return t;
}

function checkerTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y) % 2 ? '#111111' : '#ffffff';
        g.fillRect(x * 16, y * 16, 16, 16);
      }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * 3D mission markers: checkpoint gates (next gate highlighted, the one after dimmed,
 * passed gates hidden), the parking-bay outline, a light beacon on the current target
 * and a marker above the car while the player is on foot.
 */
export class MissionVisuals {
  readonly group = new Group();
  private readonly posts: InstancedMesh;
  private readonly banners: InstancedMesh;
  private readonly finish: Mesh;
  private readonly zoneGroup = new Group();
  private readonly zoneLines: Mesh[] = [];
  private readonly zoneArrow: Mesh;
  private readonly zoneFill: Mesh;
  private readonly zoneLineMat: MeshBasicMaterial;
  private readonly zoneFillMat: MeshBasicMaterial;
  private readonly beacon: Mesh;
  private readonly carMarker: Mesh;
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Material[] = [];
  private readonly textures: Texture[] = [];
  private gates: Array<{ x: number; z: number; yaw: number; halfWidth: number; full: boolean; finish: boolean }> = [];
  private readonly m4 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private time = 0;
  private zoneInside = false;

  constructor(private readonly track: Track) {
    this.group.name = 'mission-visuals';
    const postGeo = this.geo(new CylinderGeometry(0.16, 0.2, 5, 10).translate(0, 2.5, 0));
    const postMat = this.mat(new MeshStandardMaterial({ color: 0x2b3440, roughness: 0.5, metalness: 0.6 }));
    this.posts = new InstancedMesh(postGeo, postMat, MAX_GATES * 2);
    this.posts.count = 0;
    this.posts.castShadow = true;
    this.posts.frustumCulled = false;
    ownShadowDepth(this.posts, this.mats);

    // Banner: unit-wide box, scaled across the road per gate; tinted per instance.
    const bannerGeo = this.geo(new BoxGeometry(0.14, 0.9, 1));
    const chevrons = this.tex(chevronTexture());
    const bannerMat = this.mat(new MeshBasicMaterial({ map: chevrons, transparent: true, opacity: 0.92, side: DoubleSide }));
    this.banners = new InstancedMesh(bannerGeo, bannerMat, MAX_GATES);
    this.banners.count = 0;
    this.banners.frustumCulled = false;
    for (let k = 0; k < MAX_GATES; k++) this.banners.setColorAt(k, LATER_COLOR);

    const finishMat = this.mat(new MeshBasicMaterial({ map: this.tex(checkerTexture()), side: DoubleSide }));
    this.finish = new Mesh(bannerGeo, finishMat);
    this.finish.visible = false;

    // Parking bay: four painted lines and a translucent fill.
    const plane = this.geo(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.zoneLineMat = this.mat(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
    this.zoneFillMat = this.mat(new MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.18, depthWrite: false }));
    for (let k = 0; k < 4; k++) {
      const l = new Mesh(plane, this.zoneLineMat);
      l.renderOrder = 2;
      this.zoneLines.push(l);
      this.zoneGroup.add(l);
    }
    this.zoneFill = new Mesh(plane, this.zoneFillMat);
    this.zoneFill.renderOrder = 1;
    this.zoneGroup.add(this.zoneFill);
    // Heading arrow for directional bays: flat chevron in the XZ plane pointing along local +X.
    const arrow = this.geo(new BufferGeometry());
    arrow.setAttribute(
      'position',
      new Float32BufferAttribute([1.2, 0, 0, -0.2, 0, -0.75, -0.2, 0, 0.75, -0.2, 0, -0.32, -1.1, 0, -0.32, -1.1, 0, 0.32, -0.2, 0, -0.32, -1.1, 0, 0.32, -0.2, 0, 0.32], 3),
    );
    this.zoneArrow = new Mesh(arrow, this.zoneLineMat);
    this.zoneArrow.position.y = 0.004;
    this.zoneArrow.renderOrder = 2;
    this.zoneArrow.visible = false;
    this.zoneGroup.add(this.zoneArrow);
    this.zoneGroup.visible = false;

    const beamGeo = this.geo(new CylinderGeometry(0.9, 0.9, 70, 20, 1, true).translate(0, 35, 0));
    const beamMat = this.mat(
      new MeshBasicMaterial({ color: 0x34e89e, transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    );
    this.beacon = new Mesh(beamGeo, beamMat);
    this.beacon.visible = false;
    this.beacon.frustumCulled = false;

    const markerGeo = this.geo(new ConeGeometry(0.42, 0.8, 4).rotateX(Math.PI));
    const markerMat = this.mat(new MeshBasicMaterial({ color: 0x34e89e }));
    this.carMarker = new Mesh(markerGeo, markerMat);
    this.carMarker.visible = false;

    this.group.add(this.posts, this.banners, this.finish, this.zoneGroup, this.beacon, this.carMarker);
  }

  private geo<T extends BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }
  private mat<T extends Material>(m: T): T {
    this.mats.push(m);
    return m;
  }
  private tex<T extends Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }

  private sample(i: number): number {
    const c = this.track.count;
    return ((Math.round(i) % c) + c) % c;
  }

  /** Set up gates and the parking zone for a level. */
  /**
   * Show a level's gates and its (first) zone. `finishOnLast` marks the last gate as the finish line
   * (default: when there is no zone after it).
   */
  load(gates: readonly GateSpec[], zone: ZoneSpec | undefined, finishOnLast = !zone): void {
    const t = this.track;
    this.gates = gates.slice(0, MAX_GATES).map((g, idx) => {
      const k = this.sample(g.i);
      return {
        x: t.px[k] + t.rx(k) * g.off,
        z: t.pz[k] + t.rz(k) * g.off,
        yaw: Math.atan2(-t.tz[k], t.tx[k]),
        halfWidth: g.halfWidth,
        full: g.halfWidth > 6,
        finish: idx === gates.length - 1 && finishOnLast,
      };
    });
    this.setZone(zone ?? null);
    this.setProgress(0);
  }

  /** Show the marked bay of `zone` (null hides it). */
  setZone(zone: ZoneSpec | null): void {
    const t = this.track;
    this.zoneGroup.visible = !!zone;
    if (zone) {
      const k = this.sample(zone.i);
      const yaw = Math.atan2(-t.tz[k], t.tx[k]);
      this.zoneGroup.position.set(t.px[k] + t.rx(k) * zone.off, 0.035, t.pz[k] + t.rz(k) * zone.off);
      this.zoneGroup.rotation.set(0, yaw, 0);
      const L = zone.length;
      const W = zone.width;
      const w = 0.16;
      // local X = along the road, local Z = across
      const lines: Array<[number, number, number, number]> = [
        [0, -W / 2, L, w],
        [0, W / 2, L, w],
        [-L / 2, 0, w, W],
        [L / 2, 0, w, W],
      ];
      lines.forEach(([x, z, sx, sz], n) => {
        this.zoneLines[n].position.set(x, 0.002, z);
        this.zoneLines[n].scale.set(sx, 1, sz);
      });
      this.zoneFill.scale.set(L, 1, W);
      // Facing arrow: required heading for directional bays.
      this.zoneArrow.visible = !!zone.facing;
      this.zoneArrow.rotation.set(0, zone.facing === -1 ? Math.PI : 0, 0);
    }
    this.setZoneInside(false);
  }

  /** Highlight gate `next` (and dim the one after it); everything else is hidden. */
  setProgress(next: number): void {
    let posts = 0;
    let banners = 0;
    this.finish.visible = false;
    for (let idx = next; idx < Math.min(this.gates.length, next + 2); idx++) {
      const g = this.gates[idx];
      const isNext = idx === next;
      this.q.setFromAxisAngle(this.up, g.yaw);
      // Road frame: tangent = (cos yaw, -sin yaw), right = (sin yaw, cos yaw).
      const rX = Math.sin(g.yaw);
      const rZ = Math.cos(g.yaw);
      const bannerY = g.full ? 4.55 : 2.7;
      if (g.full) {
        for (const side of [-1, 1]) {
          this.v.set(g.x + rX * side * (g.halfWidth + 0.25), 0, g.z + rZ * side * (g.halfWidth + 0.25));
          this.s.set(1, 1, 1);
          this.m4.compose(this.v, this.q, this.s);
          this.posts.setMatrixAt(posts++, this.m4);
        }
      }
      this.v.set(g.x, bannerY, g.z);
      this.s.set(1, g.full ? 1 : 0.7, g.halfWidth * 2 + (g.full ? 0.5 : 0));
      this.m4.compose(this.v, this.q, this.s);
      if (g.finish) {
        this.finish.visible = true;
        this.finish.position.copy(this.v);
        this.finish.quaternion.copy(this.q);
        this.finish.scale.copy(this.s);
      } else {
        this.banners.setMatrixAt(banners, this.m4);
        this.banners.setColorAt(banners, isNext ? NEXT_COLOR : LATER_COLOR);
        banners++;
      }
    }
    this.posts.count = posts;
    this.banners.count = banners;
    this.posts.instanceMatrix.needsUpdate = true;
    this.banners.instanceMatrix.needsUpdate = true;
    if (this.banners.instanceColor) this.banners.instanceColor.needsUpdate = true;
  }

  setZoneInside(inside: boolean): void {
    if (inside === this.zoneInside && this.zoneFillMat.color.getHex() !== 0) return;
    this.zoneInside = inside;
    this.zoneFillMat.color.set(inside ? 0x34e89e : 0xffd54a);
    this.zoneFillMat.opacity = inside ? 0.32 : 0.18;
    this.zoneLineMat.color.set(inside ? 0x34e89e : 0xffffff);
  }

  /** Light beacon at a target (null hides it). */
  setBeacon(x: number | null, z = 0, color = 0x34e89e): void {
    if (x === null) {
      this.beacon.visible = false;
      return;
    }
    this.beacon.visible = true;
    this.beacon.position.set(x, 0, z);
    (this.beacon.material as MeshBasicMaterial).color.setHex(color);
  }

  /** Floating marker above the car while on foot (null hides it). */
  setCarMarker(pos: Vector3 | null): void {
    if (!pos) {
      this.carMarker.visible = false;
      return;
    }
    this.carMarker.visible = true;
    this.carMarker.position.set(pos.x, pos.y + 1.9 + Math.sin(this.time * 3) * 0.12, pos.z);
    this.carMarker.rotation.y = this.time * 1.6;
  }

  update(dt: number): void {
    this.time += dt;
    const pulse = 0.18 + 0.08 * Math.sin(this.time * 4);
    (this.beacon.material as MeshBasicMaterial).opacity = pulse;
  }

  hideAll(): void {
    this.gates = [];
    this.setProgress(0);
    this.zoneGroup.visible = false;
    this.beacon.visible = false;
    this.carMarker.visible = false;
  }

  dispose(): void {
    this.posts.dispose();
    this.banners.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
  }
}
