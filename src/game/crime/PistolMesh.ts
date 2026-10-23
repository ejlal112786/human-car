import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material } from 'three';
import { PISTOL_FRAME, PISTOL_POINTS, PISTOL_SLIDE, type PistolMaterial, type PistolPart } from './pistolModel';

/** Distance (m) the slide travels back when a round is fired. */
export const SLIDE_TRAVEL = 0.028;

const COLORS: Record<PistolMaterial, { color: number; roughness: number; metalness: number }> = {
  // Polymer frame / grip, steel parts, lighter steel slide (colours from the pack's MTL, in sRGB).
  // Real pistols are dark: black polymer frame, blackened / dark-grey steel (the slide a touch lighter).
  Black: { color: 0x151618, roughness: 0.8, metalness: 0.0 },
  Metal: { color: 0x26282b, roughness: 0.45, metalness: 0.35 },
  LightMetal: { color: 0x34343a, roughness: 0.42, metalness: 0.35 },
};

/** Geometries are shared by every pistol instance (built once). */
let shared: { frame: Map<PistolMaterial, BufferGeometry>; slide: Map<PistolMaterial, BufferGeometry> } | null = null;

function buildPart(part: PistolPart): Map<PistolMaterial, BufferGeometry> {
  const out = new Map<PistolMaterial, BufferGeometry>();
  for (const [mat, pos] of Object.entries(part) as Array<[PistolMaterial, readonly number[]]>) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos as number[], 3));
    // Non-indexed triangles → flat face normals (the low-poly faceted look of the pack).
    g.computeVertexNormals();
    g.computeBoundingSphere();
    out.set(mat, g);
  }
  return out;
}

export interface PistolInstance {
  /** Root: origin at the top of the grip, +Z = barrel, +Y = up. */
  readonly root: Group;
  /** Slide + sights: moves along −Z when firing (position.z = −travel). */
  readonly slide: Group;
  readonly materials: Material[];
}

/** A pistol made from the bundled CC0 model (frame + moving slide). */
export function createPistol(castShadow: boolean): PistolInstance {
  if (!shared) shared = { frame: buildPart(PISTOL_FRAME), slide: buildPart(PISTOL_SLIDE) };
  const materials = new Map<PistolMaterial, MeshStandardMaterial>();
  const mat = (m: PistolMaterial): MeshStandardMaterial => {
    let x = materials.get(m);
    if (!x) {
      x = new MeshStandardMaterial(COLORS[m]);
      x.name = `pistol-${m}`;
      materials.set(m, x);
    }
    return x;
  };
  const root = new Group();
  root.name = 'pistol';
  const slide = new Group();
  slide.name = 'pistol-slide';
  for (const [m, g] of shared.frame) {
    const mesh = new Mesh(g, mat(m));
    mesh.castShadow = castShadow;
    root.add(mesh);
  }
  for (const [m, g] of shared.slide) {
    const mesh = new Mesh(g, mat(m));
    mesh.castShadow = castShadow;
    slide.add(mesh);
  }
  // Three-dot sights (white dots on the rear posts and the front blade), as on most service pistols.
  const dot = new MeshBasicMaterial({ color: 0xf2f2e8 });
  const dotGeo = new BoxGeometry(0.0022, 0.0022, 0.0006);
  const P = PISTOL_POINTS;
  for (const [x, y, z] of [
    // On the rear faces (measured from the model: rear posts' back face z −0.0129, centres x ±0.0043;
    // front blade back face z 0.1165).
    [0.0043, P.sightY - 0.0024, -0.0133],
    [-0.0043, P.sightY - 0.0024, -0.0133],
    [0, P.sightY - 0.0018, 0.1161],
  ]) {
    const m = new Mesh(dotGeo, dot);
    m.position.set(x, y, z);
    slide.add(m);
  }
  root.add(slide);
  return { root, slide, materials: [...materials.values(), dot] };
}

/**
 * Slide offset (m, ≥ 0 = back) at `t` seconds after a shot: snaps back within 25 ms and returns by
 * 90 ms (real pistols cycle in well under a tenth of a second). Locked back when the magazine is empty.
 */
export function slideOffset(sinceShot: number, empty: boolean): number {
  if (empty) return SLIDE_TRAVEL;
  if (sinceShot < 0 || sinceShot > 0.09) return 0;
  if (sinceShot < 0.025) return SLIDE_TRAVEL * (sinceShot / 0.025);
  return SLIDE_TRAVEL * (1 - (sinceShot - 0.025) / 0.065);
}

export { PISTOL_POINTS };
