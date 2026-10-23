/**
 * Sidearm state machine (pure logic: no rendering, no physics).
 *
 *   holstered ──toggle──▶ drawing ──(DRAW_TIME)──▶ ready ──toggle──▶ holstering ──(HOLSTER_TIME)──▶ holstered
 *                                                   │  ▲
 *                                         reload /  │  │ (RELOAD_TIME)
 *                                    empty trigger  ▼  │
 *                                                 reloading
 *
 * Firing needs `ready`, a round in the magazine and the cycle time elapsed. Aiming is a flag that only
 * counts while drawn (it tightens the spread and slows the walk). Events are queued for audio / effects.
 */
export type WeaponState = 'holstered' | 'drawing' | 'ready' | 'reloading' | 'holstering';
export type WeaponEvent = 'draw' | 'holster' | 'shot' | 'dry' | 'reloadStart' | 'reloadEnd';

export const MAG_SIZE = 12;
export const START_RESERVE = 48;
export const MAX_RESERVE = 96;
export const DRAW_TIME = 0.45;
export const HOLSTER_TIME = 0.4;
export const RELOAD_TIME = 1.05;
/** Seconds between shots (semi-automatic). */
export const CYCLE_TIME = 0.18;
/** Bullet range (m). */
export const RANGE = 120;
/** Half-angle spread (rad): aimed, from the hip, and added per unit of recoil. */
export const SPREAD_AIM = 0.006;
export const SPREAD_HIP = 0.036;
export const SPREAD_RECOIL = 0.018;
/** Aiming down the sights: tighter than shoulder aim, and recoil opens it less (two-handed sight picture). */
export const SPREAD_ADS = 0.0025;

export class Weapon {
  state: WeaponState = 'holstered';
  /** Seconds in the current state. */
  t = 0;
  mag = MAG_SIZE;
  reserve = START_RESERVE;
  aiming = false;
  /** 0..1 how far the view is into the sights (set by the game from the camera; 0 = shoulder / hip). */
  sights = 0;
  /** 0..1 recoil kick, decays after each shot (animation + spread). */
  recoil = 0;
  private cooldown = 0;
  /** Fixed-step seconds since the last round was fired (slide / flash animation). */
  sinceShot = 99;
  readonly events: WeaponEvent[] = [];

  get drawn(): boolean {
    return this.state === 'ready' || this.state === 'reloading';
  }

  /** True whenever the gun is in the hand (drawn, drawing or being put away). */
  get inHand(): boolean {
    return this.state !== 'holstered';
  }

  get isAiming(): boolean {
    return this.aiming && this.drawn;
  }

  /** 0..1 progress of the current timed action (draw / holster / reload). */
  get progress(): number {
    const d = this.state === 'drawing' ? DRAW_TIME : this.state === 'holstering' ? HOLSTER_TIME : this.state === 'reloading' ? RELOAD_TIME : 1;
    return Math.min(1, this.t / d);
  }

  /** Current spread half-angle (rad). */
  get spread(): number {
    if (!this.isAiming) return SPREAD_HIP + this.recoil * SPREAD_RECOIL;
    const s = Math.max(0, Math.min(1, this.sights));
    return SPREAD_AIM + (SPREAD_ADS - SPREAD_AIM) * s + this.recoil * SPREAD_RECOIL * (1 - 0.4 * s);
  }

  toggle(): void {
    if (this.state === 'holstered') this.go('drawing', 'draw');
    else if (this.state === 'ready' || this.state === 'reloading') this.go('holstering', 'holster');
  }

  /** Put the gun away at once (getting into a car, arrest, cut-scenes). */
  forceHolster(): void {
    this.aiming = false;
    this.sights = 0;
    if (this.state !== 'holstered') this.go('holstered');
  }

  setAim(on: boolean): void {
    this.aiming = on;
  }

  reload(): boolean {
    if (this.state !== 'ready' || this.mag >= MAG_SIZE || this.reserve <= 0) return false;
    this.go('reloading', 'reloadStart');
    return true;
  }

  /** Pull the trigger. Returns true when a round was fired. An empty gun clicks and starts a reload. */
  trigger(): boolean {
    if (this.state !== 'ready' || this.cooldown > 0) return false;
    if (this.mag <= 0) {
      this.events.push('dry');
      this.cooldown = CYCLE_TIME;
      this.reload();
      return false;
    }
    this.mag--;
    this.cooldown = CYCLE_TIME;
    this.recoil = Math.min(1, this.recoil + 0.55);
    this.sinceShot = 0;
    this.events.push('shot');
    return true;
  }

  /** Add ammunition to the reserve (pickups / resupply). Returns the rounds actually added. */
  refill(rounds: number): number {
    const add = Math.max(0, Math.min(rounds, MAX_RESERVE - this.reserve));
    this.reserve += add;
    return add;
  }

  update(dt: number): void {
    this.t += dt;
    this.sinceShot += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 3.2);
    if (this.state === 'drawing' && this.t >= DRAW_TIME) this.go('ready');
    else if (this.state === 'holstering' && this.t >= HOLSTER_TIME) this.go('holstered');
    else if (this.state === 'reloading' && this.t >= RELOAD_TIME) {
      const take = Math.min(MAG_SIZE - this.mag, this.reserve);
      this.mag += take;
      this.reserve -= take;
      this.go('ready', 'reloadEnd');
    }
  }

  /** Back to the starting loadout (new session / after an arrest the gun is confiscated and returned empty-handed). */
  resetLoadout(reserve = START_RESERVE): void {
    this.forceHolster();
    this.mag = MAG_SIZE;
    this.reserve = reserve;
    this.recoil = 0;
    this.cooldown = 0;
    this.events.length = 0;
  }

  private go(s: WeaponState, ev?: WeaponEvent): void {
    this.state = s;
    this.t = 0;
    if (ev) this.events.push(ev);
  }
}
