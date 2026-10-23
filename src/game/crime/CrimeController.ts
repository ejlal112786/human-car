import { Vector3, type PerspectiveCamera } from 'three';
import type { AudioEngine } from '../AudioEngine';
import type { CameraRig } from '../CameraRig';
import type { CharacterController } from '../character/CharacterController';
import type { CharacterModel } from '../character/CharacterModel';
import type { CityLife } from '../city/CityLife';
import type { ControlState } from '../InputManager';
import type { Particles } from '../Particles';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { PlayerState, PoliceSystem } from '../police/PoliceSystem';
import type { HUD } from '../../ui/HUD';
import type { Vehicle } from '../Vehicle';
import { ENTER_RADIUS, type VehicleInteraction } from '../VehicleInteraction';
import type { AdsView, Casings } from './AdsView';
import { RANGE, Weapon } from './Weapon';
import type { WorldCars } from './WorldCars';

/** What the player can get into from where they stand. */
export interface EnterTarget {
  /** A drivable vehicle (own car, last car, world car) … */
  vehicle: Vehicle | null;
  /** … or an abandoned traffic car (index), converted into a world car on entry. */
  traffic: number;
  distance: number;
  /** Prompt text ("Get in" / "Take car"). */
  label: string;
}

export interface ShotResult {
  kind: 'none' | 'world' | 'ped' | 'traffic' | 'police' | 'officer' | 'vehicle';
  x: number;
  y: number;
  z: number;
  distance: number;
  /** Sights blend when the round was fired (1 = fired from the eye, down the sights). */
  sights: number;
}

/** Radius (m) in which pedestrians hear a shot, and how far aiming at a car / person counts as a threat. */
const SHOT_HEARD = 45;
const AIM_THREAT_RANGE = 22;
/** Continuous aim at a car (s) before its driver gives in. */
const CARJACK_AIM = 0.4;
/** After firing from the hip, the character keeps facing / aiming for this long (s). */
const HIP_HOLD = 0.6;

/**
 * Open-world crime gameplay on top of the existing systems: the sidearm (aim, fire, reload, effects),
 * threats to pedestrians and drivers, and getting into any vehicle. Free roam only; missions switch it off.
 */
export class CrimeController {
  readonly weapon = new Weapon();
  enabled = false;
  /** Last shot (tests / HUD). */
  readonly lastShot: ShotResult = { kind: 'none', x: 0, y: 0, z: 0, distance: 0, sights: 0 };
  /** First-person sights view model and spent-casing effect (set by the game after construction). */
  ads: AdsView | null = null;
  casings: Casings | null = null;
  private readonly ejPos = new Vector3();
  private readonly ejVel = new Vector3();
  shots = 0;
  /** Optional game-mode hook (jail guards) for the already-computed firing ray. */
  onJailShotRay: ((origin: Vector3, direction: Vector3, range: number) => void) | null = null;
  onJailAimRay: ((origin: Vector3, direction: Vector3, range: number) => boolean) | null = null;
  /** What the crosshair rests on while aiming (HUD: red crosshair on people / cars). */
  lastAimKind: ShotResult['kind'] = 'none';
  /** Counters for tests. */
  readonly stats = { carjacks: 0, driversFled: 0, thefts: 0, pedsHit: 0, officersHit: 0, reports: 0 };
  private readonly dir = new Vector3();
  private readonly orig = new Vector3();
  private readonly tmp = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private scanT = 0;
  private alarmT = 0;
  private aimCar = -1;
  private aimHold = 0;
  private hipHold = 0;
  private aimW = 0;
  private crouchW = 0;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly character: CharacterController,
    private readonly model: CharacterModel,
    private readonly camera: PerspectiveCamera,
    private readonly city: CityLife,
    private readonly police: PoliceSystem,
    private readonly worldCars: WorldCars,
    private readonly interaction: VehicleInteraction,
    private readonly audio: AudioEngine,
    private readonly particles: Particles,
    private readonly hud: HUD,
    private readonly rig: CameraRig,
    private readonly player: () => PlayerState,
  ) {}

  /** Switch the crime layer on (free roam) or off (missions, menus): the gun is put away. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.weapon.forceHolster();
    this.model.setGunShown(on);
    this.aimCar = -1;
    this.aimHold = 0;
    this.hipHold = 0;
  }

  /** True while the facing must follow the camera (aiming or just fired). */
  get facingCamera(): boolean {
    return this.weapon.isAiming || this.hipHold > 0;
  }

  /**
   * On-foot fixed step: weapon state, trigger, aim threats. Call before the character controller step.
   * `camFwd` = camera forward on the ground plane.
   */
  stepOnFoot(dt: number, ctrl: ControlState, camFwd: Vector3, allowed: boolean): void {
    const w = this.weapon;
    if (!this.enabled || !allowed) {
      w.setAim(false);
      w.update(dt);
      this.character.aiming = false;
      this.character.faceYaw = null;
      this.blendPoses(dt);
      this.drainEvents();
      return;
    }
    w.setAim(ctrl.aim && w.drawn);
    if (ctrl.fire && w.drawn) {
      if (w.trigger()) this.fire();
      this.hipHold = HIP_HOLD;
    }
    this.hipHold = Math.max(0, this.hipHold - dt);
    w.update(dt);
    this.character.aiming = w.isAiming;
    this.character.faceYaw = this.facingCamera ? Math.atan2(camFwd.x, camFwd.z) : null;
    if (w.isAiming) this.aimScan(dt);
    else {
      this.lastAimKind = 'none';
      this.aimCar = -1;
      this.aimHold = 0;
    }
    this.blendPoses(dt);
    this.drainEvents();
  }

  /** Not on foot (driving, scripts): the gun stays holstered and nothing is aimed. */
  stepOther(dt: number): void {
    this.weapon.setAim(false);
    this.weapon.update(dt);
    this.character.aiming = false;
    this.character.faceYaw = null;
    this.blendPoses(dt);
    this.drainEvents();
  }

  /** Pose blend weights advance with the fixed step (deterministic, independent of the frame rate). */
  private blendPoses(dt: number): void {
    const w = this.weapon;
    const k = 1 - Math.exp(-14 * dt);
    const aimTarget = w.drawn && this.facingCamera && w.state !== 'reloading' ? 1 : 0;
    this.aimW += (aimTarget - this.aimW) * k;
    this.crouchW += ((this.character.crouched ? 1 : 0) - this.crouchW) * k;
  }

  /** Called for every round fired (controller rumble). */
  onShot: (() => void) | null = null;

  private drainEvents(): void {
    const ev = this.weapon.events;
    for (const e of ev) {
      if (e === 'shot') {
        this.audio.gunshot(0);
        this.onShot?.();
      }
      else if (e === 'dry') this.audio.dryFire();
      else if (e === 'reloadStart') this.audio.reload(false);
      else if (e === 'reloadEnd') this.audio.reload(true);
      else if (e === 'draw' || e === 'holster') this.audio.door(false);
    }
    ev.length = 0;
  }

  /** Camera ray through the crosshair, starting just past the character (never hits things behind them). */
  private crosshairRay(spread: number): void {
    this.camera.getWorldDirection(this.dir);
    if (spread > 0) {
      this.right.crossVectors(this.dir, this.tmp.set(0, 1, 0)).normalize();
      this.up.crossVectors(this.right, this.dir).normalize();
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      this.dir.addScaledVector(this.right, Math.cos(a) * r).addScaledVector(this.up, Math.sin(a) * r).normalize();
    }
    const o = this.camera.position;
    if (this.model.isFirstPerson) {
      // Down the sights the eye is behind the gun: the ray starts at the eye (the player's own capsule is
      // excluded from the cast), so it can't start on the far side of a wall the player is pressed against.
      this.orig.copy(o);
      return;
    }
    const c = this.character.position;
    const along = (c.x - o.x) * this.dir.x + (c.y + 1.3 - o.y) * this.dir.y + (c.z - o.z) * this.dir.z;
    this.orig.copy(o).addScaledVector(this.dir, Math.max(0, along) + 0.45);
  }

  /** What the crosshair ray hits first within `range`. */
  private trace(range: number): { kind: ShotResult['kind']; t: number; ped: number; traffic: number; officer: number; nx: number; ny: number; nz: number } {
    const { R, world } = this.physics;
    const ray = new R.Ray({ x: this.orig.x, y: this.orig.y, z: this.orig.z }, { x: this.dir.x, y: this.dir.y, z: this.dir.z });
    const hit = world.castRayAndGetNormal(ray, range, true, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.character.collider);
    let t = hit ? hit.timeOfImpact : range;
    let kind: ShotResult['kind'] = hit ? 'world' : 'none';
    let traffic = -1;
    let officer = -1;
    if (hit) {
      traffic = this.city.traffic.carByCollider(hit.collider.handle);
      officer = this.police.officers ? this.police.officers.byCollider(hit.collider.handle) : -1;
      if (traffic >= 0) kind = 'traffic';
      else if (officer >= 0) kind = 'officer';
      else {
        const body = hit.collider.parent();
        if (body && this.police.units.some((u) => u.vehicle.physics.body.handle === body.handle)) kind = 'police';
        else if (body && body.isDynamic()) kind = 'vehicle';
      }
    }
    const ped = this.city.peds.rayHit(this.orig.x, this.orig.y, this.orig.z, this.dir.x, this.dir.y, this.dir.z, t, this.character.position.y);
    if (ped) {
      t = ped.t;
      kind = 'ped';
    }
    return { kind, t, ped: ped ? ped.k : -1, traffic, officer: kind === 'officer' ? officer : -1, nx: hit?.normal.x ?? 0, ny: hit?.normal.y ?? 1, nz: hit?.normal.z ?? 0 };
  }

  /** A round was fired: hit test, effects, consequences. */
  private fire(): void {
    this.shots++;
    this.crosshairRay(this.weapon.spread);
    const tr = this.trace(RANGE);
    this.onJailShotRay?.(this.orig, this.dir, tr.t);
    const p = this.player();
    const hx = this.orig.x + this.dir.x * tr.t;
    const hy = this.orig.y + this.dir.y * tr.t;
    const hz = this.orig.z + this.dir.z * tr.t;
    const s = this.lastShot;
    s.kind = tr.kind;
    s.x = hx;
    s.y = hy;
    s.z = hz;
    s.distance = tr.t;
    s.sights = this.weapon.sights;
    this.model.flash();
    if (this.casings) {
      if (this.ads && this.ads.visible) this.ads.ejection(this.ejPos, this.ejVel);
      else this.model.ejection(this.ejPos, this.ejVel);
      this.casings.eject(this.ejPos, this.ejVel, this.character.position.y);
    }
    this.rig.shake(0.05);
    if (tr.kind !== 'none' && tr.kind !== 'ped' && tr.kind !== 'officer') {
      const metal = tr.kind !== 'world';
      this.particles.bulletImpact(hx, hy, hz, tr.nx, tr.ny, tr.nz, metal);
      this.audio.ricochet(tr.t);
    }
    // Consequences (stylised: people are knocked down and later get up and run, no injury detail).
    if (tr.kind === 'ped') {
      this.city.peds.knockDown(tr.ped, p.x, p.z);
      this.stats.pedsHit++;
      this.police.offence('assault', p);
    } else if (tr.kind === 'police') {
      this.police.offence('shootPolice', p);
    } else if (tr.kind === 'officer') {
      // Stylised: the officer is knocked down and gets up again (the offence is reported by the police system).
      this.police.officers?.hit(tr.officer);
      this.stats.officersHit++;
    } else if (tr.kind === 'traffic') {
      const r = this.city.traffic.threaten(tr.traffic);
      if (r === 'flee') this.stats.driversFled++;
    }
    this.police.offence('gunfire', p);
    this.city.peds.alarm('shot', p.x, p.z, SHOT_HEARD, p.x, p.z);
  }

  /** While aiming: people in the sights put their hands up, drivers in the sights stop and get out. */
  private aimScan(dt: number): void {
    this.scanT -= dt;
    this.alarmT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.1;
    this.crosshairRay(0);
    const tr = this.trace(AIM_THREAT_RANGE);
    if (this.onJailAimRay?.(this.orig, this.dir, tr.t)) {
      this.lastAimKind = 'police';
      this.aimCar = -1;
      this.aimHold = 0;
      return;
    }
    this.lastAimKind = tr.kind === 'ped' || tr.kind === 'traffic' || tr.kind === 'police' ? tr.kind : tr.kind === 'officer' ? 'police' : 'none';
    const p = this.player();
    if (tr.kind === 'ped') {
      this.city.peds.aimedAt(tr.ped, p.x, p.z);
      if (this.alarmT <= 0) {
        this.alarmT = 0.8;
        const q = this.city.peds.peds[tr.ped];
        this.city.peds.alarm('aim', q.x, q.z, 9, p.x, p.z);
      }
    }
    if (tr.kind === 'traffic') {
      this.aimHold = tr.traffic === this.aimCar ? this.aimHold + 0.1 : 0.1;
      this.aimCar = tr.traffic;
      if (this.aimHold >= CARJACK_AIM) {
        const r = this.city.traffic.threaten(tr.traffic);
        if (r === 'stop') this.hud.pop('The driver is stopping', 'good', 1300);
        else if (r === 'flee') {
          this.stats.driversFled++;
          this.hud.pop('The driver sped off', 'bad', 1300);
        }
        this.aimHold = -1; // once per car
      }
    } else {
      this.aimCar = -1;
      this.aimHold = 0;
    }
  }

  /** A threatened driver got out at (x, z): they appear with their hands up, then run; the victim reports it. */
  onAbandon(x: number, z: number): void {
    const p = this.player();
    this.city.peds.spawnDriver(x, z, p.x, p.z);
    this.stats.carjacks++;
    this.police.offence('carjack', p);
    this.hud.pop('The driver got out', 'good', 1300);
  }

  /** A witness finished a call to the police. */
  onReport(): void {
    this.stats.reports++;
    if (this.police.enabled && this.police.wanted.report()) this.hud.pop('A witness called the police', 'bad', 1600);
  }

  /**
   * Nearest vehicle the player can get into: the current / own car, a world car or an abandoned traffic car.
   * `occupied` reports a stopped traffic car with its driver still inside (prompt hint).
   */
  enterTarget(pos: Vector3, current: Vehicle, own: Vehicle): EnterTarget | { occupied: true } | null {
    let best: EnterTarget | null = null;
    const consider = (v: Vehicle, label: string): void => {
      if (!v.isActive) return;
      const d = this.interaction.nearestDoor(v, pos);
      if (d && (!best || d.distance < best.distance)) best = { vehicle: v, traffic: -1, distance: d.distance, label };
    };
    consider(current, current === own ? 'Get in' : 'Get in');
    if (own !== current) consider(own, 'Get in your car');
    if (this.enabled) {
      for (const c of this.worldCars.cars) if (c.state !== 'free' && c.vehicle !== current) consider(c.vehicle, c.state === 'parked' ? 'Steal car' : 'Get in');
      const cars = this.city.traffic.cars;
      let occupied = false;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.mode === 0) continue;
        const d0 = Math.hypot(c.x - pos.x, c.z - pos.z);
        if (d0 > 6) continue;
        if (c.occupied) {
          if (c.mode === 1 && c.v < 1) occupied = true;
          continue;
        }
        // Door points on both sides (car frame: x forward, z right), like the player's car.
        const fx = Math.cos(c.yaw);
        const fz = -Math.sin(c.yaw);
        for (const side of [-1, 1]) {
          const dx = c.x - fx * 0.25 + Math.sin(c.yaw) * 1.45 * side;
          const dz = c.z - fz * 0.25 + Math.cos(c.yaw) * 1.45 * side;
          const d = Math.hypot(dx - pos.x, dz - pos.z);
          if (d <= ENTER_RADIUS + 0.3 && (!best || d < best.distance)) best = { vehicle: null, traffic: i, distance: d, label: 'Take car' };
        }
      }
      if (!best && occupied) return { occupied: true };
    }
    return best;
  }

  /** Turn an abandoned traffic car into a drivable world car (same pose). */
  takeTraffic(i: number, current: Vehicle, own: Vehicle): Vehicle | null {
    const rel = this.city.traffic.release(i);
    if (!rel) return null;
    const wc = this.worldCars.fromTraffic(rel, current, own);
    return wc ? wc.vehicle : null;
  }

  /** Per frame: procedural poses for the gun / crouch, mouse + touch modes. `onFoot` = the character is controllable. */
  frame(): void {
    const w = this.weapon;
    const o = this.model.overlay;
    const p = w.progress;
    let holster = 0;
    let low = 0;
    let reload = 0;
    let inHand = false;
    if (w.state === 'drawing') {
      holster = Math.sin(Math.min(1, p * 1.6) * Math.PI) * 1;
      inHand = p > 0.4;
      low = Math.max(0, (p - 0.4) / 0.6);
    } else if (w.state === 'holstering') {
      holster = Math.sin(Math.min(1, (1 - p) * 1.6) * Math.PI);
      inHand = p < 0.6;
      low = Math.max(0, 1 - p / 0.6);
    } else if (w.state === 'ready') {
      low = 1;
      inHand = true;
    } else if (w.state === 'reloading') {
      low = 1;
      inHand = true;
      reload = Math.sin(p * Math.PI);
    }
    o.holsterReach = holster;
    o.lowReady = low * (1 - this.aimW);
    o.aim = this.aimW;
    o.reload = reload;
    o.crouch = this.crouchW;
    this.model.gunInHand = inHand;
    this.model.recoil = w.recoil;
    this.model.sinceShot = w.sinceShot;
    this.model.slideLocked = w.mag === 0 && w.state !== 'reloading';
    this.camera.getWorldDirection(this.tmp);
    this.model.aimPitch = Math.max(-0.8, Math.min(0.8, Math.asin(Math.max(-1, Math.min(1, this.tmp.y))) + 0.05));
  }
}
