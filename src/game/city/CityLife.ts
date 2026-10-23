import type { Scene } from 'three';
import type { LoadedCharacter } from '../character/CharacterModel';
import { PedestrianRenderer } from '../pedestrians/PedestrianRenderer';
import { PedestrianSystem, type PedEvent, type PedThreat } from '../pedestrians/PedestrianSystem';
import { pedestrianObstacles } from '../pedestrians/obstacles';
import { KIND_HALF } from '../traffic/TrafficModels';
import type { Environment } from '../Environment';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { QualityLevel } from '../Settings';
import { buildCityGraph } from '../traffic/cityGraph';
import type { LaneGraph } from '../traffic/LaneGraph';
import { TrafficRenderer } from '../traffic/TrafficModels';
import { TrafficSignals } from '../traffic/TrafficSignals';
import { TrafficSystem, createAgent, type TrafficAgent, type TrafficEvent } from '../traffic/TrafficSystem';
import type { Vehicle } from '../Vehicle';
import { CROSSINGS } from '../world/Crossings';
import { CyclistSystem } from './CyclistSystem';

/** Ambient traffic per quality preset (cars kept around the player). */
export const TRAFFIC_DENSITY: Record<QualityLevel, number> = { ultra: 18, high: 18, medium: 14, low: 9 };
const TRAFFIC_CAPACITY = [13, 5];
/** Pedestrians per quality preset. */
export const PED_DENSITY: Record<QualityLevel, number> = { ultra: 36, high: 32, medium: 22, low: 12 };
const PED_CAPACITY = 36;

/** Agent ids reported in traffic events. */
export const AGENT_PLAYER_CAR = 1;
export const AGENT_CHARACTER = 2;
export const AGENT_OPPONENT = 10;
/** Other simulated vehicles the city reacts to: race rivals / police, the player's idle car, world cars. */
const MAX_OTHER_CARS = 8;

/** What the game tells the city each fixed step. */
export interface CityActors {
  player: Vehicle;
  /** Player is driving (otherwise on foot at `footX/footZ`). */
  inCar: boolean;
  footX: number;
  footZ: number;
  footVX: number;
  footVZ: number;
  /** Other dynamic vehicles (rivals / police, the player's car while not driven, parked world cars). */
  opponents: readonly Vehicle[];
}

/**
 * Owns the living-city systems (signals, traffic; later pedestrians and police) and decides
 * which of them run in the current game mode. Game only forwards actors and reads events.
 */
export class CityLife {
  readonly signals = new TrafficSignals(CROSSINGS.length);
  readonly graph: LaneGraph;
  readonly traffic: TrafficSystem;
  private readonly trafficRenderer: TrafficRenderer;
  private readonly agents: TrafficAgent[] = [];
  private readonly agentPool: TrafficAgent[] = [];
  readonly peds: PedestrianSystem;
  private readonly pedRenderer: PedestrianRenderer;
  private readonly cyclists: CyclistSystem | null;
  private readonly threats: PedThreat[] = [];
  private readonly threatPool: PedThreat[] = [];
  private readonly propBuf: number[] = [];
  private tick = 0;
  private trafficWanted = false;
  private density = TRAFFIC_DENSITY.high;
  /** Fixed traffic density of the running mission (undefined in free roam). */
  private missionDensity: number | undefined;

  constructor(
    physics: PhysicsWorld,
    scene: Scene,
    private readonly env: Environment,
    character: LoadedCharacter,
  ) {
    this.graph = buildCityGraph(env.track, env.props.positions);
    this.trafficRenderer = new TrafficRenderer(TRAFFIC_CAPACITY);
    if (env.quaterniusCars.length) this.trafficRenderer.useQuaternius(env.quaterniusCars);
    scene.add(this.trafficRenderer.group);
    this.traffic = new TrafficSystem(physics, this.graph, this.signals, this.trafficRenderer, TRAFFIC_CAPACITY);
    this.traffic.setDensity(this.density);
    this.agentPool.push(createAgent(AGENT_PLAYER_CAR, false), createAgent(AGENT_CHARACTER, true));
    for (let k = 0; k < MAX_OTHER_CARS; k++) this.agentPool.push(createAgent(AGENT_OPPONENT + k, false));

    this.peds = new PedestrianSystem(env.track, this.signals, pedestrianObstacles(env.track, env.props.positions), PED_CAPACITY);
    this.peds.setDensity(PED_DENSITY.high);
    this.pedRenderer = new PedestrianRenderer(character, PED_CAPACITY);
    scene.add(this.pedRenderer.group);
    this.cyclists = env.quaterniusBicycle ? new CyclistSystem(env.track, env.quaterniusBicycle) : null;
    if (this.cyclists) scene.add(this.cyclists.group);
    for (let k = 0; k < 18; k++) this.threatPool.push({ x: 0, z: 0, vx: 0, vz: 0, yaw: 0, halfLen: 2.2, halfWidth: 0.95, person: false });
  }

  get pedEvents(): PedEvent[] {
    return this.peds.events;
  }

  get trafficEvents(): TrafficEvent[] {
    return this.traffic.events;
  }

  setQuality(q: QualityLevel): void {
    this.density = TRAFFIC_DENSITY[q];
    if (this.missionDensity === undefined) this.traffic.setDensity(this.density);
    this.peds.setDensity(PED_DENSITY[q]);
  }

  /**
   * Configure for a game mode. Traffic only runs in the open city (free roam), where it cannot
   * interfere with timed mission layouts (traffic missions switch it on). `avoid` = points to keep clear
   * when populating; `dir` = 1 restricts traffic to the driving direction of the track (races), 0 = both.
   */
  configure(traffic: boolean, focusX: number, focusZ: number, avoid: ReadonlyArray<readonly [number, number]>, dir: 0 | 1 = 0, holdSignals = false, density?: number): void {
    this.trafficWanted = traffic;
    if (this.cyclists) this.cyclists.group.visible = traffic;
    // Missions pass a fixed density (fair, quality-independent difficulty); free roam follows the quality preset.
    this.missionDensity = density;
    this.traffic.setDensity(density ?? this.density);
    this.signals.reset();
    this.signals.setHeld(holdSignals);
    this.traffic.setDirection(dir);
    this.traffic.setEnabled(traffic, focusX, focusZ, avoid);
    if (!traffic) this.trafficRenderer.commit();
    this.refreshPropObstacles();
    this.peds.setEnabled(traffic, focusX, focusZ);
    if (!traffic) this.pedRenderer.hideAll();
  }

  get trafficOn(): boolean {
    return this.trafficWanted;
  }

  private refreshPropObstacles(): void {
    this.propBuf.length = 0;
    this.env.props.obstacles(this.propBuf);
    this.peds.setDynamicObstacles(this.propBuf);
  }

  private vehicleThreat(k: number, x: number, z: number, vx: number, vz: number, yaw: number, hl: number, hw: number): void {
    const t = this.threatPool[k];
    t.x = x;
    t.z = z;
    t.vx = vx;
    t.vz = vz;
    t.yaw = yaw;
    t.halfLen = hl;
    t.halfWidth = hw;
    t.person = false;
    this.threats.push(t);
  }

  private fillThreats(a: CityActors): void {
    this.threats.length = 0;
    let k = 0;
    const carYaw = (v: Vehicle): number => {
      const r = v.physics.body.rotation();
      return Math.atan2(-2 * (r.x * r.z - r.w * r.y), 1 - 2 * (r.y * r.y + r.z * r.z));
    };
    const p = a.player.physicsPosition;
    const lv = a.player.physics.body.linvel();
    this.vehicleThreat(k++, p.x, p.z, lv.x, lv.z, carYaw(a.player), 2.25, 0.95);
    if (!a.inCar) {
      const t = this.threatPool[k++];
      t.x = a.footX;
      t.z = a.footZ;
      t.vx = a.footVX;
      t.vz = a.footVZ;
      t.person = true;
      this.threats.push(t);
    }
    for (const o of a.opponents) {
      if (!o.isActive || k >= this.threatPool.length) continue;
      const op = o.physicsPosition;
      const ov = o.physics.body.linvel();
      this.vehicleThreat(k++, op.x, op.z, ov.x, ov.z, carYaw(o), 2.25, 0.95);
    }
    // Knocked traffic cars can end up on the sidewalk.
    for (const c of this.traffic.cars) {
      if (c.mode !== 2 || k >= this.threatPool.length) continue;
      const v = c.body.linvel();
      const h = KIND_HALF[c.kind];
      this.vehicleThreat(k++, c.x, c.z, v.x, v.z, c.yaw, h.x, h.z);
    }
  }

  private fillAgents(a: CityActors): void {
    this.agents.length = 0;
    const pc = this.agentPool[0];
    const p = a.player.physicsPosition;
    const v = a.player.physics.body.linvel();
    pc.x = p.x;
    pc.z = p.z;
    pc.vx = v.x;
    pc.vz = v.z;
    this.agents.push(pc);
    if (!a.inCar) {
      const ch = this.agentPool[1];
      ch.x = a.footX;
      ch.z = a.footZ;
      ch.vx = a.footVX;
      ch.vz = a.footVZ;
      this.agents.push(ch);
    }
    for (let k = 0; k < a.opponents.length && k < MAX_OTHER_CARS; k++) {
      const o = a.opponents[k];
      if (!o.isActive) continue;
      const ag = this.agentPool[2 + k];
      const op = o.physicsPosition;
      const ov = o.physics.body.linvel();
      ag.x = op.x;
      ag.z = op.z;
      ag.vx = ov.x;
      ag.vz = ov.z;
      this.agents.push(ag);
    }
  }

  /** One fixed step, before the physics world steps. */
  fixedUpdate(dt: number, a: CityActors): void {
    this.signals.update(dt);
    if (!this.trafficWanted) return;
    if (this.cyclists) this.cyclists.fixedUpdate(dt, this.traffic.cars);
    this.fillAgents(a);
    if (this.cyclists) this.agents.push(...this.cyclists.agents);
    const fx = a.inCar ? a.player.physicsPosition.x : a.footX;
    const fz = a.inCar ? a.player.physicsPosition.z : a.footZ;
    this.peds.roadAgents(this.agents);
    this.traffic.fixedUpdate(dt, fx, fz, this.agents);
    if (++this.tick % 60 === 0) this.refreshPropObstacles();
    this.fillThreats(a);
    this.peds.fixedUpdate(dt, fx, fz, this.threats);
  }

  render(alpha: number, dt: number, camX: number, camZ: number): void {
    this.env.crossings.update(this.signals);
    if (this.trafficWanted) {
      this.traffic.render(alpha);
      this.pedRenderer.update(this.peds.peds, alpha, dt, camX, camZ);
      this.cyclists?.render(camX, camZ);
    }
  }

  /** Scene groups (tests toggle these to measure rendering cost). */
  get groups(): { traffic: import('three').Object3D; peds: import('three').Object3D } {
    return { traffic: this.trafficRenderer.group, peds: this.pedRenderer.group };
  }

  get pedestriansVisible(): number {
    return this.pedRenderer.visibleCount;
  }

  /** Re-upload GPU data that cannot be restored incrementally after a WebGL context restore. */
  onContextRestored(): void {
    this.pedRenderer.onContextRestored();
  }

  /** First animation-texture row holding exactly blended crowd poses. */
  get pedestrianExactRow0(): number {
    return this.pedRenderer.exactRow0;
  }

  dispose(): void {
    this.traffic.dispose();
    this.trafficRenderer.dispose();
    this.pedRenderer.dispose();
    this.cyclists?.dispose();
  }
}
