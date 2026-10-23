import { Vector3 } from 'three';
import type { DriverInput } from '../Drivetrain';
import type { Vehicle } from '../Vehicle';
import { noUpgrades, vehicleById } from '../vehicles/VehicleCatalog';
import type { Track } from '../world/Track';
import type { ReleasedCar } from '../traffic/TrafficSystem';

/**
 * Vehicles in the open city that the player does not own: cars parked at the kerb and traffic cars
 * whose driver got out. They are pooled, fully simulated `Vehicle`s (same physics as the player's car),
 * so any of them can be driven. The player's own garage car is NOT in this pool and is never touched.
 *
 *   free      – slot unused (body disabled, hidden)
 *   parked    – placed at a kerbside spot, never driven yet
 *   taken     – the player has driven it (stays where it was left; released when far away)
 */
export type WorldCarState = 'free' | 'parked' | 'taken';

export interface WorldCar {
  vehicle: Vehicle;
  state: WorldCarState;
  /** Where it came from (HUD text, tests). */
  origin: 'parked' | 'traffic';
  /** Catalog model used for its handling and body. */
  defId: string;
  /** Kerbside spot index for parked cars (−1 otherwise). */
  spot: number;
}

const PARKED_INPUT: Readonly<DriverInput> = { throttle: 0, brake: 0, steer: 0, handbrake: true };
/** Traffic body kinds → the closest catalog car (handling + model): saloon, SUV. */
const TRAFFIC_MODEL = ['meridian', 'atlas'] as const;
/** Parked-car paints (muted street colours). */
const PARKED_PAINTS = [0x7d8790, 0x2d3a4f, 0x8a2f2a, 0xd9d4c7, 0x34503a, 0x1d1f22];
/** Spacing of kerbside parking spots along the road (m) and their lateral offset (outer lane edge). */
const SPOT_SPACING = 110;
export const SPOT_OFFSET = 6.0;
/** Parked cars appear between these distances (m) from the player (out of sight), and go beyond RELEASE. */
const SPAWN_MIN = 70;
const SPAWN_MAX = 200;
const RELEASE = 320;
/** Parked cars kept around the player at once. */
const PARKED_TARGET = 2;

export class WorldCars {
  readonly cars: WorldCar[];
  private readonly spots: Array<{ i: number; side: 1 | -1 }> = [];
  private enabled = false;
  private timer = 0;
  private readonly tmp = new Vector3();
  /** Spots that must stay clear (mission markers, crossings), as track indices. */
  private readonly blocked = new Set<number>();

  constructor(
    pool: readonly Vehicle[],
    private readonly track: Track,
    avoidIdx: readonly number[],
  ) {
    this.cars = pool.map((vehicle) => ({ vehicle, state: 'free' as WorldCarState, origin: 'parked' as const, defId: 'meridian', spot: -1 }));
    for (const v of pool) v.setActive(false);
    const n = track.count;
    const step = Math.max(1, Math.round(SPOT_SPACING / track.spacing));
    for (const a of avoidIdx) for (let d = -14; d <= 14; d++) this.blocked.add((((a + d) % n) + n) % n);
    let side: 1 | -1 = 1;
    for (let i = step >> 1; i < n; i += step) {
      if (!this.blocked.has(i)) this.spots.push({ i, side });
      side = side === 1 ? -1 : 1;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Free roam on / off. Off releases every slot. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const c of this.cars) this.release(c);
    this.timer = 0;
  }

  /** Active cars (parked or taken) except `driven`. */
  forEachIdle(driven: Vehicle | null, fn: (v: Vehicle) => void): void {
    for (const c of this.cars) if (c.state !== 'free' && c.vehicle !== driven) fn(c.vehicle);
  }

  byVehicle(v: Vehicle): WorldCar | null {
    return this.cars.find((c) => c.vehicle === v && c.state !== 'free') ?? null;
  }

  /** Parked / taken cars keep their brakes on while nobody drives them (before world.step()). */
  fixedUpdate(dt: number, driven: Vehicle | null): void {
    for (const c of this.cars) if (c.state !== 'free' && c.vehicle !== driven) c.vehicle.fixedUpdate(dt, PARKED_INPUT);
  }

  afterStep(driven: Vehicle | null): void {
    for (const c of this.cars) if (c.state !== 'free' && c.vehicle !== driven) c.vehicle.afterStep();
  }

  render(alpha: number, driven: Vehicle | null): void {
    for (const c of this.cars) if (c.state !== 'free' && c.vehicle !== driven) c.vehicle.render(alpha);
  }

  /**
   * Keep a couple of parked cars at kerbside spots near the player (spawned out of sight) and release
   * world cars that are far away and not the one being driven. Call a few times a second.
   */
  manage(dt: number, px: number, pz: number, driven: Vehicle | null, keep: Vehicle | null): void {
    if (!this.enabled) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    for (const c of this.cars) {
      if (c.state === 'free' || c.vehicle === driven || c.vehicle === keep) continue;
      const p = c.vehicle.physicsPosition;
      if (Math.hypot(p.x - px, p.z - pz) > RELEASE) this.release(c);
    }
    let parked = this.cars.filter((c) => c.state === 'parked').length;
    if (parked >= PARKED_TARGET) return;
    const t = this.track;
    // Nearest free spots in the spawn ring.
    const options = this.spots
      .map((s, k) => ({ k, d: Math.hypot(t.px[s.i] - px, t.pz[s.i] - pz) }))
      .filter((o) => o.d >= SPAWN_MIN && o.d <= SPAWN_MAX && !this.cars.some((c) => c.state !== 'free' && c.spot === o.k))
      .sort((a, b) => a.d - b.d);
    for (const o of options) {
      if (parked >= PARKED_TARGET) break;
      const slot = this.cars.find((c) => c.state === 'free');
      if (!slot) break;
      const s = this.spots[o.k];
      // Nothing (another world car) already standing there.
      const x = t.px[s.i] + t.rx(s.i) * SPOT_OFFSET * s.side;
      const z = t.pz[s.i] + t.rz(s.i) * SPOT_OFFSET * s.side;
      if (this.cars.some((c) => c.state !== 'free' && c.vehicle.physicsPosition.distanceTo(this.tmp.set(x, c.vehicle.physicsPosition.y, z)) < 8)) continue;
      const defs = ['meridian', 'pip', 'atlas', 'ridgeback', 'kestrel'];
      const def = defs[(o.k * 7 + s.i) % defs.length];
      const paint = PARKED_PAINTS[(o.k * 5 + 3) % PARKED_PAINTS.length];
      // Parked in the driving direction of its side of the road.
      const yaw = Math.atan2(-t.tz[s.i] * s.side, t.tx[s.i] * s.side);
      this.place(slot, def, paint, x, z, yaw, 'parked');
      slot.spot = o.k;
      parked++;
    }
  }

  /**
   * A traffic car the player is taking over becomes a drivable world car at the same pose. Uses a free
   * slot, else recycles the farthest idle world car (never `driven` / `keep`). Returns null when impossible.
   */
  fromTraffic(rel: ReleasedCar, driven: Vehicle | null, keep: Vehicle | null): WorldCar | null {
    let slot = this.cars.find((c) => c.state === 'free') ?? null;
    if (!slot) {
      let best = -1;
      let bestD = -1;
      this.cars.forEach((c, k) => {
        if (c.vehicle === driven || c.vehicle === keep) return;
        const p = c.vehicle.physicsPosition;
        const d = Math.hypot(p.x - rel.x, p.z - rel.z);
        if (d > bestD) [best, bestD] = [k, d];
      });
      if (best < 0) return null;
      slot = this.cars[best];
      this.release(slot);
    }
    this.place(slot, TRAFFIC_MODEL[rel.kind], rel.paint, rel.x, rel.z, rel.yaw, 'traffic');
    slot.state = 'taken';
    return slot;
  }

  /** The player got into this world car (it is no longer a fresh parked car). */
  markTaken(v: Vehicle): void {
    const c = this.byVehicle(v);
    if (c) {
      c.state = 'taken';
      c.spot = -1;
    }
  }

  release(c: WorldCar): void {
    if (c.state === 'free') return;
    c.state = 'free';
    c.spot = -1;
    c.vehicle.setActive(false);
    c.vehicle.repair();
    this.tmp.set(0, -80 - this.cars.indexOf(c) * 6, 400);
    c.vehicle.reset(this.tmp, 0);
  }

  private place(c: WorldCar, defId: string, paint: number, x: number, z: number, yaw: number, origin: WorldCar['origin']): void {
    c.vehicle.configure(vehicleById(defId), noUpgrades(), paint);
    c.vehicle.fitNewTyres();
    c.vehicle.repair();
    c.vehicle.setActive(true);
    this.tmp.set(x, 0, z);
    c.vehicle.reset(this.tmp, yaw);
    c.vehicle.skids.clear();
    c.state = 'parked';
    c.origin = origin;
    c.defId = defId;
    c.spot = -1;
  }
}
