/**
 * Dev probe: how often (steady state) a pedestrian is between animation clips, i.e. would use the exact
 * pose blend — the renderer's weight filter applied to the real pedestrian AI (+ traffic), 4 min.
 *   npx tsx scripts/tune/blend-share.ts
 */
import { FIXED_DT } from '../../src/game/config';
import { PhysicsWorld } from '../../src/game/PhysicsWorld';
import { PedMode, PedestrianSystem } from '../../src/game/pedestrians/PedestrianSystem';
import { pedestrianObstacles } from '../../src/game/pedestrians/obstacles';
import { buildCityGraph } from '../../src/game/traffic/cityGraph';
import { TrafficSignals } from '../../src/game/traffic/TrafficSignals';
import { TrafficSystem, type TrafficAgent } from '../../src/game/traffic/TrafficSystem';
import { CROSSINGS } from '../../src/game/world/Crossings';
import { DynamicProps } from '../../src/game/world/Props';
import { Track } from '../../src/game/world/Track';

const physics = await PhysicsWorld.create();
physics.addGround(800);
const track = new Track(2);
const props = new DynamicProps(physics, track);
const signals = new TrafficSignals(CROSSINGS.length);
const traffic = new TrafficSystem(physics, buildCityGraph(track, props.positions), signals, null, [13, 5]);
traffic.setDensity(18);
const peds = new PedestrianSystem(track, signals, pedestrianObstacles(track, props.positions), 24);
peds.setDensity(24);
const flat: number[] = [];
props.obstacles(flat);
peds.setDynamicObstacles(flat);
const agents: TrafficAgent[] = [];
const W = peds.peds.map(() => ({ walk: 0, run: 0 }));
let samples = 0;
let between = 0;
let slowSteady = 0;
const fx = track.px[228] + track.rx(228) * 9.5, fz = track.pz[228] + track.rz(228) * 9.5;
traffic.setEnabled(true, fx, fz, []);
peds.setEnabled(true, fx, fz);
const frameDt = 1 / 60;
for (let t = 0; t < 240; t += FIXED_DT) {
  signals.update(FIXED_DT);
  agents.length = 0;
  peds.roadAgents(agents);
  traffic.fixedUpdate(FIXED_DT, fx, fz, agents);
  peds.fixedUpdate(FIXED_DT, fx, fz, []);
  physics.step();
  // Renderer filter (same constants as PedestrianRenderer.update), sampled each step after 20 s warm-up.
  peds.peds.forEach((p, k) => {
    if (p.mode === PedMode.Off) return;
    const speed = p.mode === PedMode.Wait || p.mode === PedMode.Pause ? 0 : p.speed;
    const walkT = speed <= 2.0 ? Math.min(1, speed / 0.8) : Math.max(0, 1 - (speed - 2.0) / 1.2);
    const runT = speed <= 2.0 ? 0 : Math.min(1, (speed - 2.0) / 1.2);
    const r = 1 - Math.exp(-10 * frameDt * (FIXED_DT / frameDt));
    W[k].walk += (walkT - W[k].walk) * r;
    W[k].run += (runT - W[k].run) * r;
    if (t < 20 || p.mode === PedMode.Stumble) return;
    const moving = W[k].walk + W[k].run;
    const m = Math.min(1, moving);
    const wIdle = 1 - m, wWalk = moving > 1e-3 ? (W[k].walk / moving) * m : 0, wRun = moving > 1e-3 ? (W[k].run / moving) * m : 0;
    const wB = wIdle <= Math.min(wWalk, wRun) ? wRun / Math.max(1e-6, wWalk + wRun) : wRun <= wWalk ? wWalk / Math.max(1e-6, wIdle + wWalk) : wRun / Math.max(1e-6, wIdle + wRun);
    samples++;
    if (wB > 0.004 && wB < 0.996) {
      between++;
      if (Math.abs(walkT - W[k].walk) < 0.01 && Math.abs(runT - W[k].run) < 0.01) slowSteady++;
    }
  });
}
console.log(`pedestrian-steps sampled: ${samples}`);
console.log(`between clips: ${((between / samples) * 100).toFixed(1)}% of the time (${((slowSteady / samples) * 100).toFixed(1)}% steadily, e.g. slow walking; the rest transitions)`);
console.log(`=> on average ${((between / samples) * 24).toFixed(1)} of 24 pedestrians use the exact blend at any moment`);
