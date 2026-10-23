import { CROSSINGS, CROSS_HALF, STOP_BACK } from '../world/Crossings';
import type { Track } from '../world/Track';
import { LaneGraph } from './LaneGraph';

/** Lane graph of the city with its static lane blockers (street props) and signalised crossings. */
export function buildCityGraph(track: Track, propPositions: ReadonlyArray<readonly [number, number]>): LaneGraph {
  const graph = new LaneGraph(
    track,
    propPositions.map(([x, z]) => ({ x, z, radius: 0.45 })),
  );
  CROSSINGS.forEach((c, k) => graph.addCrossing(c, k, CROSS_HALF, STOP_BACK));
  return graph;
}
