import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { CAR } from '../config';
import type { Vehicle } from '../Vehicle';
import { noUpgrades, vehicleById } from '../vehicles/VehicleCatalog';
import { planRoute } from '../navigation/Navigation';
import type { Track } from '../world/Track';
import { RedLightDetector } from '../traffic/RedLight';
import type { TrafficSignals } from '../traffic/TrafficSignals';
import { PoliceUnit, STAR_TOP_SPEED, type PursuitTarget, type RoadObstacle } from './PoliceUnit';
import { MAX_STARS, SIGHT_RANGE, WantedSystem, type Offence } from './Wanted';
import { PoliceLivery } from './Livery';
import type { Officers } from './Officers';

/** Livery of the police cars (the pool is shared with race opponents; missions repaint them). */
export const POLICE_PAINT = 0x161c2c;
/** Respawned / reinforcing units appear this far (m, along the road) behind the player: just out of sight. */
const SPAWN_BEHIND_M = 170;
/** The patrol car is moved ahead of the player when it has been this far away for PATROL_RELOCATE s. */
const PATROL_FAR = 420;
const PATROL_RELOCATE = 25;
/** Speeding: above this speed (m/s ≈ 140 km/h) near a unit. */
export const SPEEDING = 39;
const SPEEDING_RANGE = 60;
const SPEEDING_COOLDOWN = 8;
/** Ramming a unit: closing speed (m/s) of the player towards it, within RAM_RANGE. */
const RAM_SPEED = 3;
const RAM_RANGE = 5.4;
const RAM_COOLDOWN = 2.5;
/** Index of the roadblock unit (a 4th pooled car, when provided); it never chases. */
export const BLOCK_UNIT = MAX_STARS;
/** Roadblocks: from 2 stars, at most one every ROADBLOCK_COOLDOWN s, set up this far ahead along the road (m), out of sight. */
export const ROADBLOCK_STARS = 2;
const ROADBLOCK_COOLDOWN = 40;
const ROADBLOCK_AHEAD = [260, 300, 340, 380] as const;
/** Minimum player speed (m/s) for a roadblock (a car chase, not a standstill). */
const ROADBLOCK_MIN_SPEED = 8;
/** The roadblock is cleared once the player is this far from it, after ROADBLOCK_MIN_LIFE s (never in front of them). */
const ROADBLOCK_CLEAR_DIST = 140;
const ROADBLOCK_MIN_LIFE = 20;
/** Sight checks per unit (s between ray casts). */
const LOS_INTERVAL = 0.2;
/** Search: a unit that reaches the last known position (m) switches to patrolling the area. */
const SEARCH_ARRIVE = 22;
/** Officers get out of a unit stopped within this distance (m) of a player on foot. */
const DEPLOY_RANGE = 34;
const DEPLOY_SPEED = 1.5;

/** Line-of-sight query (fixed world geometry only): true when nothing blocks the segment. */
export type SightQuery = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
export interface PlayerState {
  inCar: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Car forward speed or walking speed (m/s). */
  speed: number;
  /** Road sample nearest the player. */
  idx: number;
}

interface TrafficCarLike {
  mode: number;
  x: number;
  z: number;
  v: number;
}

/**
 * Police: patrol and pursuit in free roam, and the chase of the Police Escape mission. Reuses the pooled race-opponent cars (free roam has no
 * race) as up to three units: one patrols the city; once the player is wanted, one unit per star
 * chases. Offences only count when a unit witnesses them (see WantedSystem).
 */
export class PoliceSystem {
  /** Sight range factor from the weather (1 clear … ~0.3 in thick fog): fog hides the player and roadblocks. */
  sightScale = 1;
  readonly wanted = new WantedSystem();
  readonly units: PoliceUnit[];
  private readonly active: boolean[];
  private readonly bars: Group[] = [];
  private readonly barMats: MeshBasicMaterial[][] = [];
  private enabledFlag = false;
  private patrolFar = 0;
  private speedingCd = 0;
  private ramCd = 0;
  private readonly target: PursuitTarget = { x: 0, z: 0, vx: 0, vz: 0, idx: 0, onFoot: false };
  private readonly obstacles: RoadObstacle[] = [];
  private readonly obstaclePool: RoadObstacle[] = [];
  /** Offences counted since the last drain (HUD toast text). */
  readonly reported: Offence[] = [];
  private readonly redLight = new RedLightDetector();
  /** Chasing units put back on the road in place after getting stuck (tests). */
  recoveries = 0;
  /** Door markings per unit. */
  private readonly liveries: PoliceLivery[] = [];
  /** Officers on foot (optional: the game attaches them; headless tests may not). */
  officers: Officers | null = null;
  /** Line of sight against buildings (optional; without it sight is range-only). */
  sight: SightQuery | null = null;
  private readonly seenBy: boolean[];
  private readonly losT: number[];
  /** Any unit / officer currently sees the player (range + line of sight). */
  seen = false;
  /** Where the player was last seen (search target), and whether each unit has checked it. */
  readonly lastKnown = { x: 0, z: 0, idx: 0, valid: false };
  private readonly searched: boolean[];
  private readonly lkTarget: PursuitTarget = { x: 0, z: 0, vx: 0, vz: 0, idx: 0, onFoot: false };
  /** Roadblock state. */
  private blockCd = 0;
  /** Roadblocks only in free roam (the Police Escape mission keeps its tuned chase). */
  private roadblocksOn = false;
  private blockLife = 0;
  /** Roadblocks set up / officers deployed (tests, stats). */
  roadblocks = 0;
  deployments = 0;
  /** The last roadblock at the moment it was set up: straight distance to the player and what hid it. */
  readonly lastBlock = { dist: 0, hiddenBy: '' as '' | 'range' | 'buildings' };
  /** The roadblock is up (block unit active and parked across the road). */
  get roadblockUp(): boolean {
    return this.units.length > BLOCK_UNIT && this.active[BLOCK_UNIT];
  }

  constructor(
    private readonly track: Track,
    vehicles: readonly Vehicle[],
  ) {
    this.units = vehicles.slice(0, MAX_STARS + 1).map((v) => new PoliceUnit(v, track));
    this.active = this.units.map(() => false);
    this.seenBy = this.units.map(() => false);
    this.losT = this.units.map((_, k) => k * 0.05);
    this.searched = this.units.map(() => false);
    const baseGeo = new BoxGeometry(0.34, 0.07, 1.05);
    const lampGeo = new BoxGeometry(0.26, 0.09, 0.42);
    const baseMat = new MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.5 });
    for (const u of this.units) {
      const g = new Group();
      g.name = 'police-lightbar';
      g.position.set(-0.45, 1.27 - CAR.rideHeight, 0);
      g.add(new Mesh(baseGeo, baseMat));
      const red = new MeshBasicMaterial({ color: 0x3a0606 });
      const blue = new MeshBasicMaterial({ color: 0x06103a });
      const l = new Mesh(lampGeo, red);
      l.position.set(0, 0.07, -0.26);
      const r = new Mesh(lampGeo, blue);
      r.position.set(0, 0.07, 0.26);
      g.add(l, r);
      g.visible = false;
      u.vehicle.object.add(g);
      this.bars.push(g);
      this.barMats.push([red, blue]);
      const liv = new PoliceLivery(u.vehicle, [12, 27, 34, 41][this.liveries.length] ?? 50);
      liv.visible = false;
      this.liveries.push(liv);
    }
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** Free roam on/off. Off parks every unit and clears the wanted level (missions own the pool then). */
  setEnabled(on: boolean, player: PlayerState | null): void {
    if (on === this.enabledFlag) return;
    this.enabledFlag = on;
    this.roadblocksOn = on;
    this.wanted.reset();
    this.wanted.events.length = 0;
    this.reported.length = 0;
    this.redLight.reset();
    this.resetChaseState();
    for (let k = 0; k < this.units.length; k++) {
      this.bars[k].visible = on;
      this.liveries[k].visible = on;
      if (!on) this.deactivate(k);
    }
    if (on && player) {
      // The pool is shared with race rivals: back to stock patrol cars (handling + livery).
      this.units.forEach((u) => {
        u.vehicle.configure(vehicleById('kestrel'), noUpgrades(), POLICE_PAINT);
        u.vehicle.fitNewTyres();
      });
      this.spawnPatrol(player);
    }
  }

  /**
   * Police Escape: switch on with an immediate pursuit at `stars`, the chasing units placed
   * `behindM` metres back along the road (one per star, spaced out). No patrol car is spawned.
   */
  startPursuit(stars: number, behindM: number, player: PlayerState): void {
    if (!this.enabledFlag) {
      this.enabledFlag = true;
      this.roadblocksOn = false;
      this.wanted.reset();
      this.reported.length = 0;
      this.redLight.reset();
      this.resetChaseState();
      this.units.forEach((u, k) => {
        u.vehicle.configure(vehicleById('kestrel'), noUpgrades(), POLICE_PAINT);
        u.vehicle.fitNewTyres();
        this.bars[k].visible = true;
        this.liveries[k].visible = true;
      });
    }
    this.wanted.force(stars);
    const dir = this.playerDir(player);
    const n = Math.min(this.units.length, Math.max(1, stars));
    for (let k = 0; k < this.units.length; k++) {
      if (k >= n) {
        if (this.active[k]) this.deactivate(k);
        continue;
      }
      this.activate(k);
      const back = Math.round((behindM + k * 14) / this.track.spacing);
      this.units[k].place(player.idx - dir * back, dir, k % 2 ? 5.25 : 1.75);
    }
  }

  /** Distance from (x, z) to the nearest active unit. */
  nearestUnit(x: number, z: number): number {
    let best = Infinity;
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k]) continue;
      const p = this.units[k].vehicle.physicsPosition;
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    }
    return best;
  }

  /** Distance to the nearest police presence: an active unit or an officer on foot. */
  nearestPolice(x: number, z: number): number {
    const o = this.officers ? this.officers.nearest(x, z) : Infinity;
    return Math.min(this.nearestUnit(x, z), o);
  }

  isActive(k: number): boolean {
    return this.active[k];
  }

  /** Report an offence (counts only if witnessed, see WantedSystem). */
  offence(o: Offence, player: PlayerState): boolean {
    if (!this.enabledFlag) return false;
    const counted = this.wanted.offence(o, this.nearestPolice(player.x, player.z));
    if (counted) this.reported.push(o);
    return counted;
  }

  /** One fixed step, before world.step(). */
  fixedUpdate(dt: number, player: PlayerState, signals: TrafficSignals, traffic: readonly TrafficCarLike[]): void {
    if (!this.enabledFlag) return;
    this.detectOffences(dt, player, signals);
    const w = this.wanted;
    this.updateSight(dt, player);
    // On foot with officers out, the capture is made by an officer, not by a parked car.
    const offNear = this.officers ? this.officers.nearest(player.x, player.z) : Infinity;
    const carNear = this.nearestUnit(player.x, player.z);
    const nearest = !player.inCar && this.officers && this.officers.outCount > 0 ? offNear : Math.min(carNear, offNear);
    w.update(dt, { nearestUnit: nearest, playerSpeed: player.speed, onFoot: !player.inCar, seen: this.sight || this.officers ? this.seen : undefined });

    // Units wanted: patrol (1) when clear, one per star while wanted (the roadblock unit is managed apart).
    const want = Math.max(1, w.unitsWanted);
    for (let k = 0; k < this.units.length; k++) {
      if (k === BLOCK_UNIT) continue;
      if (k < want && !this.active[k]) this.spawnBehind(k, player);
      else if (k >= want && this.active[k] && (!this.officers || this.officers.countFor(k) === 0) && this.units[k].vehicle.physicsPosition.distanceTo(this.tmpPos(player)) > 110) this.deactivate(k);
    }

    this.fillObstacles(traffic);
    const t = this.target;
    t.x = player.x;
    t.z = player.z;
    t.vx = player.vx;
    t.vz = player.vz;
    t.idx = player.idx;
    t.onFoot = !player.inCar;
    const chasing = w.state === 'pursuit' || w.state === 'search';
    const hold = w.state === 'busted';
    // Last known position: updated while the player is seen; in search the units drive there, then patrol.
    const lk = this.lastKnown;
    if (w.state === 'pursuit' || (this.seen && chasing) || !lk.valid) {
      lk.x = player.x;
      lk.z = player.z;
      lk.idx = player.idx;
      lk.valid = true;
      this.searched.fill(false);
    }
    const lt = this.lkTarget;
    lt.x = lk.x;
    lt.z = lk.z;
    lt.vx = 0;
    lt.vz = 0;
    lt.idx = lk.idx;
    lt.onFoot = t.onFoot;
    this.updateRoadblock(dt, player);
    this.updateOfficers(dt, player, chasing);
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k]) continue;
      const u = this.units[k];
      u.topSpeed = STAR_TOP_SPEED[Math.max(1, Math.min(3, w.stars)) - 1];
      if (k === BLOCK_UNIT) {
        u.fixedUpdate(dt, null, true, this.obstacles);
        continue;
      }
      // Pursuit: chase the player. Search: drive to where they were last seen, then patrol the area.
      let target: PursuitTarget | null = null;
      if (w.state === 'pursuit') target = t;
      else if (w.state === 'search') {
        const q = u.vehicle.physicsPosition;
        if (!this.searched[k] && Math.hypot(q.x - lk.x, q.z - lk.z) < SEARCH_ARRIVE) this.searched[k] = true;
        target = this.searched[k] ? null : lt;
      }
      const busy = this.officers ? this.officers.countFor(k) > 0 : false;
      u.fixedUpdate(dt, target, hold || busy, this.obstacles);
      if (u.needsRespawn) {
        if (chasing) this.recoverChaser(k, player);
        else if (k === 0) this.spawnPatrol(player);
        else this.deactivate(k);
      }
    }
    // Keep the patrol car near the action when nothing is going on.
    if (!chasing && this.active[0]) {
      const d = this.units[0].vehicle.physicsPosition.distanceTo(this.tmpPos(player));
      this.patrolFar = d > PATROL_FAR ? this.patrolFar + dt : 0;
      if (this.patrolFar > PATROL_RELOCATE) this.spawnPatrol(player);
    }
  }

  /** Light bars: flash red/blue while wanted, dark otherwise. */
  frame(time: number): void {
    if (!this.enabledFlag) return;
    const flashing = this.wanted.state === 'pursuit' || this.wanted.state === 'search' || this.wanted.state === 'busted';
    const ph = Math.floor(time * 6) % 2;
    for (let k = 0; k < this.units.length; k++) {
      const liv = this.liveries[k];
      if (this.active[k] && liv.fittedTo !== this.units[k].vehicle.model) liv.fit();
      const [red, blue] = this.barMats[k];
      red.color.setHex(flashing && ph === 0 ? 0xff2020 : 0x3a0606);
      blue.color.setHex(flashing && ph === 1 ? 0x2a60ff : 0x06103a);
    }
  }

  /** Active unit positions for the minimap: [x, z, x, z, …]; returns the count. */
  positions(out: Float32Array): number {
    let n = 0;
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k]) continue;
      const p = this.units[k].vehicle.physicsPosition;
      out[n * 2] = p.x;
      out[n * 2 + 1] = p.z;
      n++;
    }
    return n;
  }

  /** Nearest active unit to (x, z), the roadblock car excluded: its index, or −1 when none is out. */
  unitNear(x: number, z: number): number {
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k] || k === BLOCK_UNIT) continue;
      const p = this.units[k].vehicle.physicsPosition;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) [best, bd] = [k, d];
    }
    return best;
  }

  /** Car of unit k while it is active, else null. */
  unitVehicle(k: number): Vehicle | null {
    return k >= 0 && k < this.units.length && this.active[k] ? this.units[k].vehicle : null;
  }

  /** After world.step(): let the active units read back their physics state. */
  afterStep(): void {
    for (let k = 0; k < this.units.length; k++) if (this.active[k]) this.units[k].vehicle.afterStep();
  }

  /** True while units are chasing (pursuit / search) or holding the player (busted). */
  get alert(): boolean {
    return this.enabledFlag && this.wanted.state !== 'clear';
  }

  render(alpha: number): void {
    for (let k = 0; k < this.units.length; k++) if (this.active[k]) this.units[k].vehicle.render(alpha);
  }

  // ------------------------------------------------------------------ internals

  private readonly pos = { x: 0, y: 0, z: 0 };
  private tmpPos(p: PlayerState): { x: number; y: number; z: number } {
    this.pos.x = p.x;
    this.pos.y = this.units[0].vehicle.physicsPosition.y;
    this.pos.z = p.z;
    return this.pos;
  }

  private detectOffences(dt: number, player: PlayerState, signals: TrafficSignals): void {
    this.speedingCd = Math.max(0, this.speedingCd - dt);
    this.ramCd = Math.max(0, this.ramCd - dt);
    const t = this.track;
    if (!player.inCar) {
      this.redLight.reset();
      return;
    }
    // Red light: crossing a stop line in the direction of travel while the signal shows red.
    if (this.redLight.update(t, signals, player.idx, player.x, player.z, player.speed, true)) this.offence('redLight', player);
    // Speeding past a unit.
    if (player.speed > SPEEDING && this.speedingCd === 0 && this.nearestUnit(player.x, player.z) < SPEEDING_RANGE) {
      this.speedingCd = SPEEDING_COOLDOWN;
      this.offence('speeding', player);
    }
    // Ramming a unit (the player's car moving into it — being rammed by police does not count).
    if (this.ramCd === 0) {
      for (let k = 0; k < this.units.length; k++) {
        if (!this.active[k]) continue;
        const p = this.units[k].vehicle.physicsPosition;
        const dx = p.x - player.x;
        const dz = p.z - player.z;
        const d = Math.hypot(dx, dz);
        if (d > RAM_RANGE || d < 0.01) continue;
        const lv = this.units[k].vehicle.physics.body.linvel();
        const closing = ((player.vx - lv.x) * dx + (player.vz - lv.z) * dz) / d;
        const towards = (player.vx * dx + player.vz * dz) / d;
        if (closing > RAM_SPEED && towards > RAM_SPEED) {
          this.ramCd = RAM_COOLDOWN;
          this.offence('hitPolice', player);
          break;
        }
      }
    }
  }

  private fillObstacles(traffic: readonly TrafficCarLike[]): void {
    this.obstacles.length = 0;
    const get = (i: number): RoadObstacle => {
      while (this.obstaclePool.length <= i) this.obstaclePool.push({ x: 0, z: 0, speed: 0 });
      return this.obstaclePool[i];
    };
    let i = 0;
    for (const c of traffic) {
      if (c.mode === 0) continue;
      const o = get(i++);
      o.x = c.x;
      o.z = c.z;
      o.speed = c.mode === 1 ? c.v : 0;
      this.obstacles.push(o);
    }
    // The other units too, so a chasing unit never shunts the one in front (each unit skips itself).
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k]) continue;
      const vp = this.units[k].vehicle.physics;
      const q = vp.body.translation();
      const o = get(i++);
      o.x = q.x;
      o.z = q.z;
      o.speed = Math.max(0, vp.forwardSpeed);
      this.obstacles.push(o);
    }
  }

  private deactivate(k: number): void {
    this.active[k] = false;
    this.seenBy[k] = false;
    const v = this.units[k].vehicle;
    v.setActive(false);
  }

  private activate(k: number): void {
    this.active[k] = true;
    this.units[k].vehicle.setActive(true);
  }

  /** Player's travel direction along the road (+1 / −1). */
  private playerDir(p: PlayerState): 1 | -1 {
    const t = this.track;
    const along = p.vx * t.tx[p.idx] + p.vz * t.tz[p.idx];
    return along < 0 ? -1 : 1;
  }

  private resetChaseState(): void {
    this.seen = false;
    this.seenBy.fill(false);
    this.searched.fill(false);
    this.lastKnown.valid = false;
    this.blockCd = ROADBLOCK_COOLDOWN * 0.5;
    this.blockLife = 0;
    this.officers?.clear();
  }

  /**
   * Who can see the player: a unit within SIGHT_RANGE with a clear line from its roof to the player
   * (buildings block it; checked every LOS_INTERVAL s per unit), or an officer on foot within 40 m.
   */
  private updateSight(dt: number, p: PlayerState): void {
    let seen = false;
    const py = p.inCar ? 1.2 : 1.5;
    for (let k = 0; k < this.units.length; k++) {
      if (!this.active[k]) continue;
      const q = this.units[k].vehicle.physicsPosition;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d > SIGHT_RANGE * this.sightScale) {
        this.seenBy[k] = false;
        continue;
      }
      this.losT[k] -= dt;
      if (this.losT[k] <= 0 || d < 12) {
        this.losT[k] = LOS_INTERVAL;
        this.seenBy[k] = d < 12 || !this.sight || this.sight(q.x, q.y + 0.9, q.z, p.x, this.groundY(p) + py, p.z);
      }
      if (this.seenBy[k]) seen = true;
    }
    if (!seen && this.officers && this.officers.nearest(p.x, p.z) < 40) seen = true;
    this.seen = seen;
  }

  /** Player feet height estimate (units ride on the same ground). */
  private groundY(_p: PlayerState): number {
    return 0;
  }

  /**
   * Roadblock: from ROADBLOCK_STARS in an active car chase, the 4th unit is parked across the player's lanes
   * 260–380 m ahead along their way — only at a spot nobody can see being set up (beyond sight range or
   * behind buildings) — with an officer standing guard behind it. It is cleared once the player is well past.
   */
  private updateRoadblock(dt: number, p: PlayerState): void {
    if (this.units.length <= BLOCK_UNIT) return;
    const w = this.wanted;
    this.blockCd = Math.max(0, this.blockCd - dt);
    const k = BLOCK_UNIT;
    if (this.active[k]) {
      this.blockLife += dt;
      const q = this.units[k].vehicle.physicsPosition;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d > ROADBLOCK_CLEAR_DIST && (this.blockLife > ROADBLOCK_MIN_LIFE || w.state === 'clear')) {
        this.officers?.recall(k);
        if (!this.officers || this.officers.countFor(k) === 0 || d > ROADBLOCK_CLEAR_DIST + 60) {
          this.officers?.clear();
          this.deactivate(k);
          this.blockCd = ROADBLOCK_COOLDOWN;
        }
      }
      return;
    }
    if (!this.roadblocksOn || w.state !== 'pursuit' || w.stars < ROADBLOCK_STARS || !p.inCar || p.speed < ROADBLOCK_MIN_SPEED || this.blockCd > 0) return;
    const t = this.track;
    const dir = this.playerDir(p);
    for (const m of ROADBLOCK_AHEAD) {
      const i = (((p.idx + dir * Math.round(m / t.spacing)) % t.count) + t.count) % t.count;
      const x = t.px[i] + t.rx(i) * dir * 3.5;
      const z = t.pz[i] + t.rz(i) * dir * 3.5;
      const d = Math.hypot(x - p.x, z - p.z);
      const byRange = d > SIGHT_RANGE * this.sightScale + 10;
      const hidden = byRange || (this.sight !== null && !this.sight(p.x, 1.4, p.z, x, 1.2, z));
      if (!hidden) continue;
      // Not on top of a traffic car or another unit.
      if (this.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < 9)) continue;
      this.activate(k);
      const u = this.units[k];
      u.place(i, dir, 3.5);
      const yaw = Math.atan2(-t.tz[i], t.tx[i]) + Math.PI / 2;
      u.vehicle.reset(this.v3.set(x, 0, z), yaw);
      this.blockLife = 0;
      this.roadblocks++;
      this.lastBlock.dist = d;
      this.lastBlock.hiddenBy = byRange ? 'range' : 'buildings';
      // An officer stands guard behind the car (further along the road, out of the way of a car going through the gap).
      if (this.officers) {
        const gx = x + t.tx[i] * dir * 3.2;
        const gz = z + t.tz[i] * dir * 3.2;
        const side = (gx - x) * Math.sin(yaw) + (gz - z) * Math.cos(yaw) > 0 ? 1 : -1;
        if (this.officers.deploy(k, u.vehicle, side, 'guard', gx, gz)) this.deployments++;
      }
      this.blockCd = ROADBLOCK_COOLDOWN;
      return;
    }
    // No hidden spot this time: try again shortly.
    this.blockCd = 2;
  }

  private readonly v3 = new Vector3();

  /**
   * Officers on foot: a unit stopped near a player on foot lets one officer out (two from 2 stars, pool
   * permitting); everybody goes back to the cars when the player drives away or the pursuit ends.
   */
  private updateOfficers(dt: number, p: PlayerState, chasing: boolean): void {
    const of = this.officers;
    if (!of) return;
    if (chasing && !p.inCar) {
      const perUnit = this.wanted.stars >= 2 ? 2 : 1;
      for (let k = 0; k < this.units.length; k++) {
        if (!this.active[k] || k === BLOCK_UNIT) continue;
        const v = this.units[k].vehicle;
        const q = v.physicsPosition;
        if (Math.hypot(q.x - p.x, q.z - p.z) > DEPLOY_RANGE || Math.abs(v.physics.forwardSpeed) > DEPLOY_SPEED) continue;
        const have = of.countFor(k);
        if (have >= perUnit) continue;
        // First officer on the side facing the player, the second from the other door.
        const r = v.physics.body.rotation();
        const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
        const fz = 2 * (r.x * r.z - r.w * r.y);
        const facing = (p.x - q.x) * -fz + (p.z - q.z) * fx > 0 ? 1 : -1;
        if (of.deploy(k, v, have === 0 ? facing : -facing, 'chase')) this.deployments++;
      }
    }
    const busted = this.wanted.state === 'busted';
    of.fixedUpdate(dt, { px: p.x, py: 0, pz: p.z, onFoot: !p.inCar, chasing: chasing || busted, car: p.inCar ? this.playerCar : null }, (k) => (this.active[k] ? this.units[k].vehicle : null));
    while (of.knocked.length) {
      const why = of.knocked.shift();
      this.offence(why === 'car' ? 'hitPolice' : 'shootPolice', p);
    }
  }

  /** The car the player is driving (officers dodge / are knocked down by it); set by the game. */
  playerCar: Vehicle | null = null;

  /** Livery state of unit k (tests): visible and number of fitted panels. */
  liveryInfo(k: number): { visible: boolean; panels: number } {
    const l = this.liveries[k];
    return { visible: !!l && l.visible && this.active[k], panels: l ? l.panels : 0 };
  }

  /**
   * Recovery of a stuck / flipped / turned-round chasing unit. A recovery never gains ground: a unit
   * further away than the spawn-behind distance (and out of sight) is put back on its own stretch of
   * road, in the lane, facing the way to the player; only a unit that was already closer is brought
   * in behind the player. (Spawning far units behind the player teleported them hundreds of metres
   * closer and made escapes impossible.)
   */
  private recoverChaser(k: number, p: PlayerState): void {
    const u = this.units[k];
    const n = this.track.count;
    const steps = Math.abs(((((u.idx - p.idx) % n) + n + n / 2) % n) - n / 2);
    const roadM = steps * this.track.spacing;
    const q = u.vehicle.physics.body.translation();
    const straight = Math.hypot(q.x - p.x, q.z - p.z);
    if (roadM > SPAWN_BEHIND_M + 20 && straight > SIGHT_RANGE) {
      const dir = planRoute(this.track, u.idx, p.idx).dir;
      u.place(u.idx, dir, 1.75);
      this.recoveries++;
    } else {
      this.spawnBehind(k, p);
    }
  }

  /** Bring unit k in behind the player, just out of sight, heading the player's way. */
  private spawnBehind(k: number, p: PlayerState): void {
    const dir = this.playerDir(p);
    const back = Math.round(SPAWN_BEHIND_M / this.track.spacing) + k * 6;
    this.activate(k);
    this.units[k].place(p.idx - dir * back, dir, 1.75);
  }

  /** Put the patrol car ~300 m ahead of the player, driving towards them in the oncoming lane. */
  private spawnPatrol(p: PlayerState): void {
    const dir = this.playerDir(p);
    const ahead = Math.round(300 / this.track.spacing);
    this.activate(0);
    this.units[0].place(p.idx + dir * ahead, dir === 1 ? -1 : 1, 5.25);
    this.patrolFar = 0;
  }

  /** Sight range is exported for the HUD/QA. */
  static readonly SIGHT = SIGHT_RANGE;
}
