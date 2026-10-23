import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  type Material,
  type Texture,
} from 'three';
import { POI_COLORS, poiGlyph } from '../../ui/Minimap';
import type { Poi } from './Navigation';

/** Pavement height (top of the kerb) so rings sit on the sidewalk. */
const PAVEMENT_Y = 0.16;

/**
 * Free-roam world markers for points of interest: a glowing ground ring and a floating icon
 * (same colour / glyph as the maps). One ring + icon per POI (a dozen tiny objects) — no per-frame allocation.
 */
export class PoiMarkers {
  readonly group = new Group();
  private readonly rings = new Map<string, Mesh>();
  private readonly owned: Array<Material | Texture | RingGeometry> = [];
  private t = 0;

  constructor(pois: readonly Poi[]) {
    this.group.name = 'poi-markers';
    const ringGeo = new RingGeometry(2.1, 2.6, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.owned.push(ringGeo);
    for (const p of pois) {
      const color = new Color(POI_COLORS[p.kind]);
      const ringMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
      const ring = new Mesh(ringGeo, ringMat);
      ring.position.set(p.x, PAVEMENT_Y + 0.02, p.z);
      ring.renderOrder = 2;
      this.group.add(ring);
      this.rings.set(p.id, ring);
      const tex = iconTexture(POI_COLORS[p.kind], poiGlyph(p));
      const spr = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      spr.position.set(p.x, 3.1, p.z);
      spr.scale.set(1.3, 1.3, 1);
      spr.name = `poi-${p.id}`;
      this.group.add(spr);
      this.owned.push(ringMat, tex, spr.material);
    }
    this.group.visible = false;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Gentle pulse; the selected destination pulses harder. */
  update(dt: number, destId: string | null): void {
    if (!this.group.visible) return;
    this.t += dt;
    for (const [id, ring] of this.rings) {
      const sel = id === destId;
      const k = 1 + Math.sin(this.t * (sel ? 5 : 2)) * (sel ? 0.12 : 0.04);
      ring.scale.set(k, 1, k);
      (ring.material as MeshBasicMaterial).opacity = sel ? 0.95 : 0.6;
    }
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.group.removeFromParent();
  }
}

function iconTexture(color: string, glyph: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = color;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 32, 27, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#10141a';
    g.font = '700 30px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, 32, 34);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
