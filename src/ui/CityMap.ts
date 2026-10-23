import { ROAD } from '../game/config';
import type { Poi } from '../game/navigation/Navigation';
import type { Footprint } from '../game/world/CityBuilder';
import type { Track } from '../game/world/Track';
import { POI_COLORS, ROUTE_COLOR, buildMapPaths, poiGlyph } from './Minimap';

export interface CityMapState {
  /** Player position and forward direction (world XZ). */
  x: number;
  z: number;
  fx: number;
  fz: number;
  onFoot: boolean;
  /** Parked car (when on foot), or null. */
  car: { x: number; z: number } | null;
  pois: readonly Poi[];
  destId: string | null;
  route: Float32Array;
  routeCount: number;
  /** Mission objective (missions only). */
  objective: { x: number; z: number } | null;
}

/** World → canvas CSS-pixel projection of the last draw. */
export type MapProjection = (x: number, z: number) => [number, number];

/**
 * Whole-city map, north-up, fitted to its canvas. Shares road/building outlines with the minimap.
 * Drawn on demand (when the map screen opens or the viewport changes), never per frame.
 */
export class CityMap {
  private readonly road: Path2D;
  private readonly buildings: Path2D;
  private readonly minX: number;
  private readonly maxX: number;
  private readonly minZ: number;
  private readonly maxZ: number;

  constructor(track: Track, footprints: readonly Footprint[]) {
    const p = buildMapPaths(track, footprints);
    this.road = p.road;
    this.buildings = p.buildings;
    const b = track.bounds();
    const pad = 40;
    this.minX = b.minX - pad;
    this.maxX = b.maxX + pad;
    this.minZ = b.minZ - pad;
    this.maxZ = b.maxZ + pad;
  }

  draw(canvas: HTMLCanvasElement, st: CityMapState): MapProjection {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    const spanX = this.maxX - this.minX;
    const spanZ = this.maxZ - this.minZ;
    // North-up: world −Z is up on screen, +X to the right.
    const scale = Math.min(w / spanX, h / spanZ);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanZ * scale) / 2;
    const project: MapProjection = (x, z) => [ox + (x - this.minX) * scale, oy + (z - this.minZ) * scale];
    if (!ctx) return project;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14, 18, 24, 0.92)';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.translate(-this.minX, -this.minZ);
    ctx.fillStyle = 'rgba(120, 132, 148, 0.5)';
    ctx.fill(this.buildings);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(40, 46, 56, 0.95)';
    ctx.lineWidth = ROAD.halfWidth * 2 + 10;
    ctx.stroke(this.road);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.9)';
    ctx.lineWidth = ROAD.halfWidth * 2;
    ctx.stroke(this.road);
    if (st.routeCount > 1) {
      ctx.strokeStyle = ROUTE_COLOR;
      ctx.lineWidth = Math.max(5, 4 / scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(st.route[0], st.route[1]);
      for (let k = 1; k < st.routeCount; k++) ctx.lineTo(st.route[k * 2], st.route[k * 2 + 1]);
      ctx.stroke();
    }
    ctx.restore();

    // Screen-space markers (constant size).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 11px system-ui, sans-serif';
    for (const p of st.pois) {
      const [sx, sy] = project(p.x, p.z);
      const sel = p.id === st.destId;
      ctx.fillStyle = POI_COLORS[p.kind];
      ctx.strokeStyle = sel ? ROUTE_COLOR : 'rgba(0,0,0,0.65)';
      ctx.lineWidth = sel ? 3 : 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#10141a';
      ctx.fillText(poiGlyph(p), sx, sy + 0.5);
    }
    if (st.objective) {
      const [sx, sy] = project(st.objective.x, st.objective.z);
      ctx.fillStyle = ROUTE_COLOR;
      ctx.strokeStyle = '#0b1a12';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (st.car) {
      const [sx, sy] = project(st.car.x, st.car.z);
      ctx.fillStyle = '#ff3b30';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Player arrow (pointing along its heading).
    const [px, py] = project(st.x, st.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(st.fz, st.fx) + Math.PI / 2);
    ctx.fillStyle = st.onFoot ? '#ffd54a' : '#ff3b30';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return project;
  }
}
