import { signalPolePositions } from '../world/Crossings';
import { streetFurnitureSites } from '../world/Props';
import type { Track } from '../world/Track';

/**
 * Rule used by the environment to drop streetlight / tree sites that would clash with movable props
 * or signal poles. Shared so pedestrian path planning sees exactly the furniture that is built.
 */
export function furnitureBlocker(track: Track, propPositions: ReadonlyArray<readonly [number, number]>): (x: number, z: number) => boolean {
  const poles = signalPolePositions(track);
  return (x: number, z: number): boolean => {
    for (const [px, pz] of propPositions) if ((px - x) ** 2 + (pz - z) ** 2 < 2.5 * 2.5) return true;
    for (const p of poles) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 3.5 * 3.5) return true;
    return false;
  };
}

/** Fixed sidewalk obstacles as [x, z, radius]: built streetlights, tree trunks and signal poles. */
export function pedestrianObstacles(track: Track, propPositions: ReadonlyArray<readonly [number, number]>): Array<[number, number, number]> {
  const blocked = furnitureBlocker(track, propPositions);
  const sites = streetFurnitureSites(track);
  const out: Array<[number, number, number]> = [];
  for (const [x, z] of sites.lights) if (!blocked(x, z)) out.push([x, z, 0.24]);
  for (const [x, z] of sites.trees) if (!blocked(x, z)) out.push([x, z, 0.2]);
  for (const p of signalPolePositions(track)) out.push([p.x, p.z, 0.2]);
  return out;
}
