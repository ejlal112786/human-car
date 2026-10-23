/**
 * Tyre temperature and wear per wheel (no rendering; fixed step).
 *
 * Heat comes from sliding (slip speed × load) and from the carcass flexing while rolling; the tyre cools
 * towards the air temperature, faster with speed and on a wet road. Grip follows a temperature window:
 * cold tyres grip a little less, the window (35–105 °C) is full grip, overheated tyres lose grip quickly.
 * Wear grows with sliding (much faster when overheated) and a little with distance; worn tyres grip slightly
 * less in the dry, clearly less in the wet, and aquaplane at a lower speed.
 */
export const TYRE = {
  /** °C/s per (m/s slip × kN load). */
  slipHeat: 0.55,
  /** °C/s per m/s of rolling (carcass flex); scaled by tyre pressure. */
  rollHeat: 0.02,
  /** Cooling per second per °C above ambient: base + per m/s of speed, + extra on a wet road. */
  coolBase: 0.004,
  coolSpeed: 0.0008,
  coolWet: 0.02,
  maxTemp: 160,
  /** Full-grip window (°C). */
  windowLow: 35,
  windowHigh: 105,
  /** Grip lost 30 °C below the window floor / 40 °C above the window (quadratic in between). */
  coldLoss: 0.08,
  hotLoss: 0.15,
  /** Wear per (m/s slip × kN load × s), and per metre rolled. */
  slipWear: 5.8e-5,
  distanceWear: 2e-7,
  /** Dry grip lost when fully worn (none until dryWearFree: tread depth hardly matters in the dry); extra wet grip lost when fully worn on a soaked road. */
  dryWearFree: 0.2,
  wornDryLoss: 0.06,
  wornWetLoss: 0.3,
  /** Aquaplaning onset (m/s) for new tyres at factory pressure; − per unit of wear; + per pressure step. */
  aquaOnset: 22,
  aquaWear: 7,
  aquaPressure: 1.5,
} as const;

export class TyreModel {
  readonly temp = new Float32Array(4);
  readonly wear = new Float32Array(4);

  constructor(ambient = 20) {
    this.reset(ambient);
  }

  /** Tyres at the temperature of a car that has just been driven to the spot (wear kept). */
  reset(ambient: number): void {
    this.temp.fill(ambient + 18);
  }

  /** New tyres. */
  renew(ambient: number): void {
    this.wear.fill(0);
    this.reset(ambient);
  }

  /**
   * One wheel, one step. slipSpeed = sliding speed of the contact patch (m/s), load in N, speed of the car
   * (m/s), wet 0..1, pressureStep = garage setup step (−2 … +2; low pressure flexes and heats more).
   */
  step(i: number, dt: number, slipSpeed: number, load: number, speed: number, ambient: number, wet: number, pressureStep: number): void {
    const kN = Math.max(0, load) / 1000;
    const slip = Math.max(0, slipSpeed);
    let t = this.temp[i];
    const heat = TYRE.slipHeat * slip * kN + TYRE.rollHeat * Math.abs(speed) * (1 - 0.15 * pressureStep);
    const cool = (t - ambient) * (TYRE.coolBase + TYRE.coolSpeed * Math.abs(speed) + TYRE.coolWet * wet);
    t += (heat - cool) * dt;
    this.temp[i] = Math.max(ambient - 5, Math.min(TYRE.maxTemp, t));
    const over = t > 110 ? 1 + (t - 110) / 20 : 1;
    this.wear[i] = Math.min(1, this.wear[i] + (TYRE.slipWear * slip * kN * over + TYRE.distanceWear * Math.abs(speed)) * dt);
  }

  /** Grip factor from temperature alone. */
  tempGrip(i: number): number {
    const t = this.temp[i];
    if (t < TYRE.windowLow) {
      const k = Math.min(1, (TYRE.windowLow - t) / 30);
      return 1 - TYRE.coldLoss * k * k;
    }
    if (t > TYRE.windowHigh) {
      const k = Math.min(1, (t - TYRE.windowHigh) / 40);
      return 1 - TYRE.hotLoss * k * k;
    }
    return 1;
  }

  /** Grip factor of wheel i (temperature × wear, the wear penalty growing with the road's wetness). */
  grip(i: number, wet: number): number {
    const w = this.wear[i];
    const dry = Math.max(0, (w - TYRE.dryWearFree) / (1 - TYRE.dryWearFree));
    return this.tempGrip(i) * (1 - TYRE.wornDryLoss * dry) * (1 - TYRE.wornWetLoss * w * wet);
  }

  /** Speed (m/s) above which this wheel starts to aquaplane in standing water. */
  aquaplaneOnset(i: number, pressureStep: number): number {
    return TYRE.aquaOnset - TYRE.aquaWear * this.wear[i] + TYRE.aquaPressure * pressureStep;
  }

  get avgWear(): number {
    return (this.wear[0] + this.wear[1] + this.wear[2] + this.wear[3]) / 4;
  }
}
