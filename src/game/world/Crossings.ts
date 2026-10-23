import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ROAD } from '../config';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { TrafficSignals } from '../traffic/TrafficSignals';
import type { Track } from './Track';

/** Track samples of the signalised pedestrian crossings (straight sections clear of mission layouts). */
export const CROSSINGS: readonly number[] = [70, 228, 352, 470, 606];
/** Crossing half-length along the road, in track samples (~2 m each). */
export const CROSS_HALF = 1;
/** Gap between the crossing edge and the stop line, in samples. */
export const STOP_BACK = 2;
/** Lateral position of the signal poles (on the pavement, just behind the kerb). */
const POLE_LAT = ROAD.halfWidth + ROAD.curbWidth + 0.5;

const LAMP_COLORS = {
  red: new Color(0xff2a14),
  yellow: new Color(0xffb01a),
  green: new Color(0x1cff78),
  off: new Color(0x141414),
  walk: new Color(0xf2f4ff),
  dont: new Color(0xff6a10),
};

export interface PolePlacement {
  x: number;
  z: number;
}

/** XZ positions of every signal pole (used to keep lamps/trees and pedestrians clear of them). */
export function signalPolePositions(track: Track): PolePlacement[] {
  const out: PolePlacement[] = [];
  for (const c of CROSSINGS) {
    for (const dir of [1, -1] as const) {
      const i = (c - dir * (CROSS_HALF + STOP_BACK) + track.count) % track.count;
      const lat = dir * POLE_LAT;
      out.push({ x: track.px[i] + track.rx(i) * lat, z: track.pz[i] + track.rz(i) * lat });
    }
  }
  return out;
}

/**
 * Zebra stripes, stop lines and signal poles for every crossing, plus their colliders.
 * Lamps are one instanced mesh whose colours follow the signal controller.
 */
export class CrossingVisuals {
  readonly group = new Group();
  private readonly lamps: InstancedMesh;
  /** Per lamp: signal index, kind (0 red, 1 yellow, 2 green, 3 pedestrian). */
  private readonly lampSignal: Int16Array;
  private readonly lampKind: Uint8Array;
  private syncedVersion = -1;
  private flashOn = true;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(track: Track, physics: PhysicsWorld | null) {
    this.group.name = 'crossings';
    const hw = ROAD.halfWidth;
    const y = ROAD.surfaceY + 0.006;
    const t = track;
    const quad = (pos: number[], i: number, latA: number, latB: number, alongA: number, alongB: number): void => {
      const px = t.px[i];
      const pz = t.pz[i];
      const rx = t.rx(i);
      const rz = t.rz(i);
      const fx = t.tx[i];
      const fz = t.tz[i];
      const P = (lat: number, along: number): [number, number, number] => [px + rx * lat + fx * along, y, pz + rz * lat + fz * along];
      const a = P(latA, alongA);
      const b = P(latB, alongA);
      const c = P(latB, alongB);
      const d = P(latA, alongB);
      // Two triangles, counter-clockwise seen from above.
      pos.push(...a, ...c, ...b, ...a, ...d, ...c);
    };

    // --- Road paint: zebra bars and stop lines
    const paint: number[] = [];
    const halfLen = CROSS_HALF * t.spacing + 0.6;
    for (const c of CROSSINGS) {
      for (let lat = -hw + 0.7; lat < hw - 0.5; lat += 1.1) quad(paint, c, lat, lat + 0.55, -halfLen, halfLen);
      const back = (CROSS_HALF + STOP_BACK) * t.spacing;
      quad(paint, c, 0.35, hw - 0.45, -back - 0.25, -back + 0.25); // with-track lanes stop before the crossing
      quad(paint, c, -hw + 0.45, -0.35, back - 0.25, back + 0.25); // opposite lanes stop on the other side
    }
    const paintGeo = new BufferGeometry();
    paintGeo.setAttribute('position', new BufferAttribute(new Float32Array(paint), 3));
    paintGeo.computeVertexNormals();
    const paintMat = new MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    const paintMesh = new Mesh(paintGeo, paintMat);
    paintMesh.receiveShadow = true;
    this.group.add(paintMesh);
    this.disposables.push(paintGeo, paintMat);

    // --- Poles, mast arms and signal housings (one merged static mesh)
    const parts: BufferGeometry[] = [];
    const dummy = new Object3D();
    const place = (g: BufferGeometry, x: number, yy: number, z: number, yaw: number): void => {
      dummy.position.set(x, yy, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      parts.push(g.applyMatrix4(dummy.matrix));
    };
    const lampDefs: Array<{ x: number; y: number; z: number; yaw: number; signal: number; kind: number }> = [];
    const sw = ROAD.sidewalkHeight;
    CROSSINGS.forEach((c, s) => {
      for (const dir of [1, -1] as const) {
        const i = (c - dir * (CROSS_HALF + STOP_BACK) + t.count) % t.count;
        const fx = t.tx[i] * dir;
        const fz = t.tz[i] * dir;
        // Housings face oncoming traffic: local +Z = -driving direction.
        const yaw = Math.atan2(-fx, -fz);
        const rx = t.rx(i) * dir;
        const rz = t.rz(i) * dir;
        const P = (lat: number) => [t.px[i] + t.rx(i) * dir * lat, t.pz[i] + t.rz(i) * dir * lat] as const;
        const [bx, bz] = P(POLE_LAT);
        place(new CylinderGeometry(0.09, 0.12, 5.6, 8), bx, sw + 2.8, bz, 0);
        // Mast arm over the lanes towards the centre line.
        const armLen = POLE_LAT - 2.6;
        const [ax, az] = P(POLE_LAT - armLen / 2);
        const arm = new BoxGeometry(0.1, 0.1, armLen);
        place(arm, ax, sw + 5.45, az, Math.atan2(rx, rz));
        const heads: Array<[number, number]> = [
          [POLE_LAT - armLen + 0.4, sw + 4.75], // over the lanes
          [POLE_LAT - 0.05, sw + 2.9], // on the pole
        ];
        for (const [lat, hy] of heads) {
          const [hx, hz] = P(lat);
          place(new BoxGeometry(0.36, 1.02, 0.26), hx, hy, hz, yaw);
          for (let k = 0; k < 3; k++) {
            lampDefs.push({ x: hx - fx * 0.14, y: hy + 0.3 - k * 0.3, z: hz - fz * 0.14, yaw, signal: s, kind: k });
          }
        }
        // Pedestrian head facing across the road, below the car head.
        const [qx, qz] = P(POLE_LAT);
        const across = Math.atan2(-rx, -rz);
        place(new BoxGeometry(0.34, 0.34, 0.2), qx - rx * 0.12, sw + 2.1, qz - rz * 0.12, across);
        lampDefs.push({ x: qx - rx * 0.23, y: sw + 2.1, z: qz - rz * 0.23, yaw: across, signal: s, kind: 3 });
        if (physics) physics.addStaticCylinder(bx, sw + 2.8, bz, 2.8, 0.14);
      }
    });
    const structGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    for (const g of parts) g.dispose();
    const structMat = new MeshStandardMaterial({ color: 0x2c3036, roughness: 0.5, metalness: 0.6 });
    const struct = new Mesh(structGeo, structMat);
    struct.castShadow = true;
    this.group.add(struct);
    this.disposables.push(structGeo, structMat);

    // --- Lamps
    const lampGeo = new CircleGeometry(0.11, 12);
    const lampMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.lamps = new InstancedMesh(lampGeo, lampMat, lampDefs.length);
    this.lamps.instanceMatrix.setUsage(DynamicDrawUsage);
    this.lampSignal = new Int16Array(lampDefs.length);
    this.lampKind = new Uint8Array(lampDefs.length);
    lampDefs.forEach((d, k) => {
      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(0, d.yaw, 0);
      dummy.scale.setScalar(d.kind === 3 ? 1.3 : 1);
      dummy.updateMatrix();
      this.lamps.setMatrixAt(k, dummy.matrix);
      this.lamps.setColorAt(k, LAMP_COLORS.off);
      this.lampSignal[k] = d.signal;
      this.lampKind[k] = d.kind;
    });
    this.lamps.computeBoundingSphere();
    this.group.add(this.lamps);
    this.disposables.push(lampGeo, lampMat);
  }

  /** Re-colour the lamps when the controller changed (or the pedestrian light flashes). */
  update(signals: TrafficSignals): void {
    const flash = Math.floor(signals.time * 2.5) % 2 === 0;
    if (signals.version === this.syncedVersion && flash === this.flashOn) return;
    this.syncedVersion = signals.version;
    this.flashOn = flash;
    for (let k = 0; k < this.lampKind.length; k++) {
      const s = this.lampSignal[k];
      const kind = this.lampKind[k];
      let c = LAMP_COLORS.off;
      if (kind === 3) {
        const p = signals.ped(s);
        c = p === 'walk' ? LAMP_COLORS.walk : p === 'flash' ? (flash ? LAMP_COLORS.dont : LAMP_COLORS.off) : LAMP_COLORS.dont;
      } else {
        const car = signals.car(s);
        if (kind === 0 && car === 'red') c = LAMP_COLORS.red;
        else if (kind === 1 && car === 'yellow') c = LAMP_COLORS.yellow;
        else if (kind === 2 && car === 'green') c = LAMP_COLORS.green;
      }
      this.lamps.setColorAt(k, c);
    }
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.lamps.dispose();
    this.group.removeFromParent();
  }
}
