import { ROAD } from '../game/config';
import type { Footprint } from '../game/world/CityBuilder';
import type { Track } from '../game/world/Track';
import type { Poi } from '../game/navigation/Navigation';

/** Map colours per point-of-interest kind (minimap, city map, world markers). */
export const POI_COLORS: Record<Poi['kind'], string> = { mission: '#ffb020', garage: '#b388ff', event: '#ff6f3c', impound: '#4aa3ff' };
export const ROUTE_COLOR = '#34e89e';

/** Short glyph drawn inside a POI icon. */
export function poiGlyph(p: Poi): string {
  return p.kind === 'mission' ? String(p.index + 1) : p.kind === 'garage' ? 'G' : p.kind === 'impound' ? 'P' : 'R';
}

/** Road and building outlines in world coordinates (built once, shared by minimap and city map). */
export function buildMapPaths(track: Track, footprints: readonly Footprint[]): { road: Path2D; buildings: Path2D } {
  const road = new Path2D();
  const buildings = new Path2D();
  for (let i = 0; i < track.count; i++) {
    if (i === 0) road.moveTo(track.px[i], track.pz[i]);
    else road.lineTo(track.px[i], track.pz[i]);
  }
  road.closePath();
  for (const f of footprints) {
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    const hw = f.w / 2;
    const hd = f.d / 2;
    const pts: Array<[number, number]> = [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ];
    pts.forEach(([lx, lz], k) => {
      const x = f.x + lx * c + lz * s;
      const z = f.z - lx * s + lz * c;
      if (k === 0) buildings.moveTo(x, z);
      else buildings.lineTo(x, z);
    });
    buildings.closePath();
  }
  return { road, buildings };
}

const VIEW_RADIUS_M = 230;

/** Extra map markers (mutable, reused every frame — no allocation). */
export interface MapMarkers {
  /** Objective target (clamped to the map edge when far away). */
  hasTarget: boolean;
  targetX: number;
  targetZ: number;
  /** Parked car icon (shown while on foot). */
  showCar: boolean;
  carX: number;
  carZ: number;
  /** Rival cars: x,z pairs. */
  rivals: Float32Array;
  rivalCount: number;
  /** Police units: x,z pairs. */
  police: Float32Array;
  policeCount: number;
  /** Units are chasing: draw them flashing red / blue. */
  policeAlert: boolean;
  policeFlash: boolean;
  /** The player is on foot (round marker instead of the car arrow). */
  onFoot: boolean;
  /** Navigation route (x,z pairs) and its point count (0 = no route). */
  route: Float32Array;
  routeCount: number;
  /** Points of interest to draw (null = none, e.g. during missions). */
  pois: readonly Poi[] | null;
  /** Selected destination (highlighted). */
  destId: string | null;
}

export function createMapMarkers(): MapMarkers {
  return { hasTarget: false, targetX: 0, targetZ: 0, showCar: false, carX: 0, carZ: 0, rivals: new Float32Array(8), rivalCount: 0, police: new Float32Array(6), policeCount: 0, policeAlert: false, policeFlash: false, onFoot: false, route: new Float32Array(1200), routeCount: 0, pois: null, destId: null };
}
const REDRAW_INTERVAL = 1 / 30;

/**
 * Heading-up radar minimap drawn on a 2D canvas.
 * Road and building paths are built once; each redraw just transforms and strokes them.
 */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly road: Path2D;
  private readonly buildings: Path2D;
  private readonly startX: number;
  private readonly startZ: number;
  private readonly size: number;
  private timer = 0;

  constructor(
    canvas: HTMLCanvasElement,
    track: Track,
    footprints: readonly Footprint[],
  ) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = 180;
    canvas.width = Math.round(this.size * dpr);
    canvas.height = Math.round(this.size * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for minimap.');
    this.ctx = ctx;
    ctx.scale(dpr, dpr);

    const paths = buildMapPaths(track, footprints);
    this.road = paths.road;
    this.buildings = paths.buildings;
    this.startX = track.px[0];
    this.startZ = track.pz[0];
  }

  update(dt: number, x: number, z: number, fx: number, fz: number, markers: MapMarkers | null = null, force = false): void {
    this.timer -= dt;
    if (this.timer > 0 && !force) return;
    this.timer = REDRAW_INTERVAL;
    const ctx = this.ctx;
    const S = this.size;
    const half = S / 2;
    const scale = half / VIEW_RADIUS_M;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(14, 18, 24, 0.78)';
    ctx.fillRect(0, 0, S, S);

    ctx.translate(half, half);
    ctx.rotate(-Math.PI / 2 - Math.atan2(fz, fx));
    ctx.scale(scale, scale);
    ctx.translate(-x, -z);

    ctx.fillStyle = 'rgba(120, 132, 148, 0.55)';
    ctx.fill(this.buildings);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(40, 46, 56, 0.95)';
    ctx.lineWidth = ROAD.halfWidth * 2 + 10;
    ctx.stroke(this.road);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.92)';
    ctx.lineWidth = ROAD.halfWidth * 2;
    ctx.stroke(this.road);

    // start line marker
    ctx.fillStyle = '#ffcc33';
    ctx.beginPath();
    ctx.arc(this.startX, this.startZ, 6, 0, Math.PI * 2);
    ctx.fill();
    if (markers && markers.routeCount > 1) {
      ctx.strokeStyle = ROUTE_COLOR;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(markers.route[0], markers.route[1]);
      for (let k = 1; k < markers.routeCount; k++) ctx.lineTo(markers.route[k * 2], markers.route[k * 2 + 1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (markers) {
      for (let k = 0; k < markers.rivalCount; k++) {
        ctx.fillStyle = '#4da3ff';
        ctx.beginPath();
        ctx.arc(markers.rivals[k * 2], markers.rivals[k * 2 + 1], 7, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let k = 0; k < markers.policeCount; k++) {
        ctx.fillStyle = markers.policeAlert ? (markers.policeFlash ? '#ff3030' : '#3d7bff') : '#e8edf5';
        ctx.strokeStyle = '#0b1020';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.rect(markers.police[k * 2] - 7, markers.police[k * 2 + 1] - 7, 14, 14);
        ctx.fill();
        ctx.stroke();
      }
      if (markers.showCar) {
        ctx.fillStyle = '#ff3b30';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(markers.carX, markers.carZ, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Points of interest: upright icons (drawn in screen space so the glyphs never rotate).
    if (markers?.pois) {
      const rot = -Math.PI / 2 - Math.atan2(fz, fx);
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of markers.pois) {
        const dx = p.x - x;
        const dz = p.z - z;
        const sx = (dx * c - dz * sn) * scale;
        const sy = (dx * sn + dz * c) * scale;
        if (Math.hypot(sx, sy) > half - 9) continue;
        ctx.fillStyle = POI_COLORS[p.kind];
        ctx.strokeStyle = p.id === markers.destId ? ROUTE_COLOR : 'rgba(0,0,0,0.6)';
        ctx.lineWidth = p.id === markers.destId ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(half + sx, half + sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#10141a';
        ctx.fillText(poiGlyph(p), half + sx, half + sy + 0.5);
      }
    }

    // Objective marker, clamped to the rim when outside the view.
    if (markers?.hasTarget) {
      const rot = -Math.PI / 2 - Math.atan2(fz, fx);
      const dx = markers.targetX - x;
      const dz = markers.targetZ - z;
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      let sx = (dx * c - dz * sn) * scale;
      let sy = (dx * sn + dz * c) * scale;
      const r = Math.hypot(sx, sy);
      const maxR = half - 10;
      const outside = r > maxR;
      if (outside) {
        sx *= maxR / r;
        sy *= maxR / r;
      }
      ctx.save();
      ctx.translate(half + sx, half + sy);
      ctx.fillStyle = '#34e89e';
      ctx.strokeStyle = '#0b1a12';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (outside) {
        ctx.rotate(Math.atan2(sy, sx));
        ctx.moveTo(8, 0);
        ctx.lineTo(-5, -6);
        ctx.lineTo(-5, 6);
        ctx.closePath();
      } else ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // player arrow (always pointing up)
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = markers?.onFoot ? '#ffd54a' : '#ff3b30';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (markers?.onFoot) {
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      this.ring(ctx, half);
      return;
    }
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    this.ring(ctx, half);
  }

  private ring(ctx: CanvasRenderingContext2D, half: number): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}
