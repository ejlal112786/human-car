/**
 * Vehicle damage (pure logic, no rendering). Four body zones and four lamps.
 *
 * Input is a collision measured by the physics: the horizontal velocity change of the car body in
 * one hit (m/s) and the direction of the hit in the car's frame. Taps below DAMAGE_THRESHOLD
 * (≈ 11 km/h of velocity change — kerb bumps, cones, nudging traffic) do nothing; above it the
 * damage grows with the excess, so a 30 km/h wall hit dents and an 80 km/h one wrecks the nose.
 */

export const DAMAGE_THRESHOLD = 3.0;
/** Excess velocity change (m/s) that fully crushes a zone in one hit. */
const FULL_EXCESS = 20;
/** A zone must be at least this damaged before its lamps can break… */
const LAMP_ZONE = 0.22;
/** …or a single hit must be at least this hard (m/s). */
const LAMP_DV = 8;

export type Zone = 'front' | 'rear' | 'left' | 'right';
export const ZONES: readonly Zone[] = ['front', 'rear', 'left', 'right'];
export type Lamp = 'headL' | 'headR' | 'tailL' | 'tailR';
export const LAMPS: readonly Lamp[] = ['headL', 'headR', 'tailL', 'tailR'];

export interface DamageState {
  zones: Record<Zone, number>;
  lamps: Record<Lamp, boolean>;
  /** Number of damaging hits (statistics / tests). */
  hits: number;
}

export interface HitResult {
  severity: number;
  zone: Zone;
  brokeLamps: Lamp[];
}

export function createDamage(): DamageState {
  return { zones: { front: 0, rear: 0, left: 0, right: 0 }, lamps: { headL: false, headR: false, tailL: false, tailR: false }, hits: 0 };
}

export function repairDamage(d: DamageState): void {
  for (const z of ZONES) d.zones[z] = 0;
  for (const l of LAMPS) d.lamps[l] = false;
  d.hits = 0;
}

/**
 * Apply one collision. `hitFwd`, `hitRight` = direction FROM the car centre TO the contact, in the
 * car frame (+fwd = nose, +right = right side). Returns null for harmless taps.
 */
export function applyHit(d: DamageState, dv: number, hitFwd: number, hitRight: number): HitResult | null {
  if (!(dv > DAMAGE_THRESHOLD)) return null;
  const len = Math.hypot(hitFwd, hitRight);
  const hf = len > 1e-6 ? hitFwd / len : 1;
  const hr = len > 1e-6 ? hitRight / len : 0;
  const sev = Math.min(1, (dv - DAMAGE_THRESHOLD) / FULL_EXCESS);
  // Share the damage between the zones facing the contact (squared cosines sum to 1).
  const w: Record<Zone, number> = {
    front: hf > 0 ? hf * hf : 0,
    rear: hf < 0 ? hf * hf : 0,
    right: hr > 0 ? hr * hr : 0,
    left: hr < 0 ? hr * hr : 0,
  };
  let zone: Zone = 'front';
  for (const z of ZONES) {
    d.zones[z] = Math.min(1, d.zones[z] + sev * w[z] * 1.15);
    if (w[z] > w[zone]) zone = z;
  }
  d.hits++;
  // Lamps: a hard hit on the corner, or a hit on an already dented end.
  const broke: Lamp[] = [];
  const breakLamp = (l: Lamp): void => {
    if (!d.lamps[l]) {
      d.lamps[l] = true;
      broke.push(l);
    }
  };
  for (const end of ['front', 'rear'] as const) {
    if (w[end] < 0.25) continue;
    if (!(dv >= LAMP_DV || d.zones[end] >= LAMP_ZONE)) continue;
    const [l, r] = end === 'front' ? (['headL', 'headR'] as const) : (['tailL', 'tailR'] as const);
    // Off-centre hits take out the near lamp; square hits (or very hard ones) both.
    if (hr > 0.2) breakLamp(r);
    else if (hr < -0.2) breakLamp(l);
    else if (dv >= LAMP_DV * 1.25 || d.zones[end] >= 0.5) {
      breakLamp(l);
      breakLamp(r);
    } else breakLamp(dv % 2 < 1 ? l : r);
  }
  return { severity: sev, zone, brokeLamps: broke };
}

/** Overall condition 0 (pristine) … 1 (wrecked): worst zone dominates. */
export function damageLevel(d: DamageState): number {
  let max = 0;
  let sum = 0;
  for (const z of ZONES) {
    max = Math.max(max, d.zones[z]);
    sum += d.zones[z];
  }
  return Math.min(1, max * 0.7 + (sum / 4) * 0.3);
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface DamageEffects {
  /** Engine power factor (crushed nose = damaged radiator / engine). */
  powerScale: number;
  smoke: number;
  flickerHead: boolean;
  /** Bent suspension / alignment: constant front-wheel angle in rad, + = pulls left (side that was hit). */
  steerPull: number;
  /** Steering lock factor: a crushed nose limits how far the front wheels turn. */
  steerLockScale: number;
  /** Aerodynamic drag factor from torn / bent body panels (lower top speed). */
  dragScale: number;
}

/** Mechanical effect of the damage on the car (visual damage is separate, in CarModel). */
export function damageEffects(d: DamageState): DamageEffects {
  const f = d.zones.front;
  return {
    steerPull: 0.012 * (smooth(0.15, 1, d.zones.left) - smooth(0.15, 1, d.zones.right)),
    steerLockScale: 1 - 0.3 * smooth(0.3, 1, f),
    dragScale: 1 + 0.35 * smooth(0.25, 1, damageLevel(d)),
    powerScale: 1 - 0.25 * smooth(0.35, 1, f),
    smoke: smooth(0.45, 0.9, f),
    flickerHead: f > 0.12 && f < LAMP_ZONE * 2 && (!d.lamps.headL || !d.lamps.headR),
  };
}

/** Repair price in credits (body work + lamps), rounded to 50. 0 when undamaged. */
export function repairCost(d: DamageState, costScale = 1): number {
  let body = 0;
  for (const z of ZONES) body += d.zones[z];
  const lamps = LAMPS.filter((l) => d.lamps[l]).length;
  const raw = (body * 900 + lamps * 120) * costScale;
  return raw <= 0 ? 0 : Math.max(50, Math.round(raw / 50) * 50);
}

export function isDamaged(d: DamageState): boolean {
  return ZONES.some((z) => d.zones[z] > 0.001) || LAMPS.some((l) => d.lamps[l]);
}

/**
 * Merges the few physics steps of one crash into a single hit: keeps the strongest velocity change
 * seen within `window` seconds, then releases it. Keeps damage independent of the step rate.
 */
export class HitAccumulator {
  private dv = 0;
  private f = 0;
  private r = 0;
  private t = -1;
  constructor(private readonly window = 0.12) {}

  add(dv: number, hitFwd: number, hitRight: number): void {
    if (dv <= 0) return;
    if (this.t < 0) this.t = this.window;
    if (dv > this.dv) {
      this.dv = dv;
      this.f = hitFwd;
      this.r = hitRight;
    }
  }

  /** Advance; returns the merged hit when its window closes. */
  tick(dt: number): { dv: number; hitFwd: number; hitRight: number } | null {
    if (this.t < 0) return null;
    this.t -= dt;
    if (this.t > 0) return null;
    const out = { dv: this.dv, hitFwd: this.f, hitRight: this.r };
    this.dv = 0;
    this.t = -1;
    return out;
  }

  clear(): void {
    this.dv = 0;
    this.t = -1;
  }
}
