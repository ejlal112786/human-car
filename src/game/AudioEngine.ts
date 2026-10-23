import { ENGINE } from './config';

/** Number of cylinders used to derive the engine firing frequency (V8). */
const CYLINDERS = 8;

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

/**
 * Fully procedural audio built on the Web Audio API (no sound files):
 * engine (pitch from RPM, timbre from throttle), tyre squeal (from slip),
 * wind (from speed), gear-shift dips, collision thumps, footsteps, doors,
 * engine start and UI / mission cues, plus city ambience: a distant-traffic bed, the nearest
 * passing car (distance falloff + Doppler) and the ticking of pedestrian crossing signals.
 * The master volume setting scales the final output gain.
 * Audio can only start after a user gesture, so call {@link start} from a click/key handler.
 * Every method is a safe no-op when Web Audio is unavailable.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineOscC: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private skidGain: GainNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineBus: GainNode | null = null;
  /** Short dip on every gear change (ramped, so it never clicks). */
  private shiftGain: GainNode | null = null;
  // City ambience: distant-traffic bed + one "nearest passing car" voice (no per-car nodes).
  private bedGain: GainNode | null = null;
  private passGain: GainNode | null = null;
  private passFilter: BiquadFilterNode | null = null;
  private passOsc: OscillatorNode | null = null;
  private beepNext = 0;
  /** Counters / levels for automated tests (read-only diagnostics). */
  readonly diag = { shifts: 0, upshifts: 0, beeps: 0, bed: 0, pass: 0, rain: 0, spray: 0, boost: 0, turbo: 0, whine: 0, blowoffs: 0, cabin: false };
  private turboOsc: OscillatorNode | null = null;
  private turboFilter: BiquadFilterNode | null = null;
  private turboGain: GainNode | null = null;
  private whooshGain: GainNode | null = null;
  private whineOsc: OscillatorNode | null = null;
  private whineGain: GainNode | null = null;
  /** Turbo boost 0..1 (spools up with lag under load, vents when the throttle closes). */
  private boost = 0;
  /** Throttle was open (> 55 %) since the last lift: closing it below 15 % vents the turbo, however gradual the lift. */
  private liftArmed = false;
  private lastBlowoff = -1;
  /** Game time (s) accumulated from `update` frame times; the blow-off cooldown runs on it, like the spool. */
  private gameTime = 0;
  /** Listener sits in the cabin (cockpit view): engine and wind more muffled, the cabin boom a bit louder. */
  private cabin = false;
  private rainGain: GainNode | null = null;
  private rainLow: BiquadFilterNode | null = null;
  private sprayGain: GainNode | null = null;
  /** Road wetness 0..1: wet tyres squeal much less. */
  private wet = 0;
  private muted = false;
  private paused = false;
  /** Page hidden (background tab, locked phone, app switch): silent and suspended in every game state. */
  private hidden = false;
  private volume = 0.8;
  private engineOn = false;
  private lastImpact = 0;
  private lastStep = 0;

  get state(): string {
    return this.ctx ? this.ctx.state : 'uninitialised';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Create (once) and resume the audio graph. Must be called from a user gesture. */
  start(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.build(new Ctor());
      } catch (err) {
        console.warn('Audio disabled:', err);
        this.ctx = null;
        return;
      }
    }
    this.paused = false;
    this.syncRunning();
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp);

    // Shared white-noise buffer (2 s) for tyres, wind and impacts.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- Engine: two detuned saws + a sub square, soft-clipped and low-passed.
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(6);
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.1;
    // Engine bus: silent while nobody is in the car.
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = this.engineOn ? 1 : 0;
    this.shiftGain = ctx.createGain();
    shaper.connect(this.engineFilter).connect(this.engineGain).connect(this.shiftGain).connect(this.engineBus).connect(this.master);
    const mix = ctx.createGain();
    mix.gain.value = 0.35;
    mix.connect(shaper);
    const osc = (type: OscillatorType, gain: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(mix);
      o.start();
      return o;
    };
    this.engineOscA = osc('sawtooth', 0.6);
    this.engineOscB = osc('sawtooth', 0.45);
    this.engineOscC = osc('square', 0.35);

    // --- Tyre squeal: band-passed noise.
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noise;
    skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1150;
    this.skidFilter.Q.value = 3.5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    skidSrc.start();

    // --- Wind: low-passed noise.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noise;
    windSrc.loop = true;
    windSrc.playbackRate.value = 0.7;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 520;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();

    // --- Rain: high hiss of drops (muffled by the cabin when driving), and tyre spray on a wet road.
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = this.noise;
    rainSrc.loop = true;
    const rainHigh = ctx.createBiquadFilter();
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 1500;
    this.rainLow = ctx.createBiquadFilter();
    this.rainLow.type = 'lowpass';
    this.rainLow.frequency.value = 8000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rainHigh).connect(this.rainLow).connect(this.rainGain).connect(this.master);
    rainSrc.start(0, 1.1);
    const spraySrc = ctx.createBufferSource();
    spraySrc.buffer = this.noise;
    spraySrc.loop = true;
    spraySrc.playbackRate.value = 0.85;
    const sprayFilter = ctx.createBiquadFilter();
    sprayFilter.type = 'bandpass';
    sprayFilter.frequency.value = 1100;
    sprayFilter.Q.value = 0.6;
    this.sprayGain = ctx.createGain();
    this.sprayGain.gain.value = 0;
    spraySrc.connect(sprayFilter).connect(this.sprayGain).connect(this.master);
    spraySrc.start(0, 0.3);

    // --- City bed: slow, deep rumble of distant traffic.
    const bedSrc = ctx.createBufferSource();
    bedSrc.buffer = this.noise;
    bedSrc.loop = true;
    bedSrc.playbackRate.value = 0.23;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 170;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    bedSrc.connect(bedFilter).connect(this.bedGain).connect(this.master);
    bedSrc.start(0, 0.7);

    // --- Nearest passing car: tyre roar (band-passed noise) + a soft engine hum.
    const passSrc = ctx.createBufferSource();
    passSrc.buffer = this.noise;
    passSrc.loop = true;
    passSrc.playbackRate.value = 0.55;
    this.passFilter = ctx.createBiquadFilter();
    this.passFilter.type = 'bandpass';
    this.passFilter.frequency.value = 380;
    this.passFilter.Q.value = 0.9;
    this.passGain = ctx.createGain();
    this.passGain.gain.value = 0;
    passSrc.connect(this.passFilter).connect(this.passGain).connect(this.master);
    passSrc.start(0, 1.3);
    this.passOsc = ctx.createOscillator();
    this.passOsc.type = 'triangle';
    this.passOsc.frequency.value = 62;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.5;
    this.passOsc.connect(humGain).connect(this.passGain);
    this.passOsc.start();

    // --- Forced induction (engine bus: silent with nobody in the car).
    // Turbo: a narrow whistle that rises with boost, plus a soft rush of intake air.
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 2500;
    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.Q.value = 6;
    this.turboFilter.frequency.value = 2500;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboFilter).connect(this.turboGain).connect(this.engineBus);
    this.turboOsc.start();
    const whooshSrc = ctx.createBufferSource();
    whooshSrc.buffer = this.noise;
    whooshSrc.loop = true;
    const whooshFilter = ctx.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.frequency.value = 2300;
    whooshFilter.Q.value = 1.4;
    this.whooshGain = ctx.createGain();
    this.whooshGain.gain.value = 0;
    whooshSrc.connect(whooshFilter).connect(this.whooshGain).connect(this.engineBus);
    whooshSrc.start(0, 0.9);
    // Supercharger: gear-driven, so its whine follows the crank speed with no lag.
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'triangle';
    this.whineOsc.frequency.value = 600;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineOsc.connect(this.whineGain).connect(this.engineBus);
    this.whineOsc.start();
  }

  /**
   * Blow-off valve: the trapped boost vents when the throttle snaps shut — a falling "pssh", with compressor
   * flutter on the stronger turbos. `level` 0..1.
   */
  private blowOff(level: number): void {
    const ctx = this.ready();
    if (!ctx || !this.engineBus || !this.noise || level < 0.05 || !this.engineOn) return;
    const now = ctx.currentTime;
    if (this.lastBlowoff >= 0 && this.gameTime - this.lastBlowoff < 0.45) return;
    this.lastBlowoff = this.gameTime;
    this.diag.blowoffs++;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.1;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.3;
    f.frequency.setValueAtTime(3200, now);
    f.frequency.exponentialRampToValueAtTime(750, now + 0.42);
    const g = ctx.createGain();
    const peak = 0.05 + 0.2 * Math.min(1, level);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    src.connect(f).connect(g).connect(this.engineBus);
    let lfo: OscillatorNode | null = null;
    if (level > 0.55) {
      // Flutter: the compressor wheel stalls against the closed throttle (a fast stutter on the vent).
      lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(26, now);
      lfo.frequency.linearRampToValueAtTime(15, now + 0.4);
      const depth = ctx.createGain();
      depth.gain.value = peak * 0.6;
      lfo.connect(depth).connect(g.gain);
      lfo.start(now);
      lfo.stop(now + 0.5);
    }
    src.start(now, Math.random() * 1.2);
    src.stop(now + 0.55);
  }

  /** In-car listener (cockpit view) or outside (chase camera). */
  setCabin(on: boolean): void {
    this.cabin = on;
    this.diag.cabin = on;
  }

  /**
   * Gear change: the engine note dips for the shift time (throttle lift / clutch) with a soft
   * mechanical clunk. Only audible while the engine is on.
   */
  gearShift(up: boolean, duration = 0.2): void {
    const ctx = this.ctx;
    if (!ctx || !this.shiftGain || !this.engineOn || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const g = this.shiftGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(up ? 0.42 : 0.62, now + 0.035);
    g.linearRampToValueAtTime(1, now + 0.035 + duration);
    this.burst(now + 0.01, 0.05, 'bandpass', up ? 210 : 260, 0.1);
    this.diag.shifts++;
    if (up) this.diag.upshifts++;
    if (up && this.profile.induction === 'turbo' && this.boost > 0.5) {
      this.blowOff(this.boost * this.profile.boost * 0.7);
      this.boost *= 0.35;
    }
  }

  /**
   * City ambience, once per frame (no allocations).
   * @param city 0..1 how busy the surroundings are (bed level)
   * @param carDist distance to the nearest moving traffic car (m)
   * @param carSpeed its speed (m/s)
   * @param closing closing speed towards the listener (m/s, + = approaching) for the Doppler shift
   * @param walkDist distance to the nearest crossing whose signal shows WALK (m)
   */
  ambience(city: number, carDist: number, carSpeed: number, closing: number, walkDist: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.bedGain || !this.passGain || !this.passFilter || !this.passOsc) return;
    const t = ctx.currentTime;
    const bed = Math.max(0, Math.min(1, city)) * 0.16;
    this.bedGain.gain.setTargetAtTime(bed, t, 0.6);
    const near = carDist < 70 ? 1 / (1 + (carDist * carDist) / 60) : 0;
    const pass = near * Math.min(1, 0.25 + carSpeed / 14) * 0.5 * Math.max(0.3, city);
    this.passGain.gain.setTargetAtTime(pass, t, 0.08);
    const doppler = 343 / Math.max(250, Math.min(450, 343 - Math.max(-60, Math.min(60, closing))));
    this.passFilter.frequency.setTargetAtTime((300 + carSpeed * 22) * doppler, t, 0.08);
    this.passOsc.frequency.setTargetAtTime((48 + carSpeed * 3.2) * doppler, t, 0.08);
    this.diag.bed = bed;
    this.diag.pass = pass;
    // Accessible pedestrian signal: a short tick ~3x a second during WALK.
    if (walkDist < 32 && t >= this.beepNext) {
      this.tone(2350, t, 0.03, 'square', 0.03 / (1 + walkDist / 6));
      this.beepNext = t + 0.33;
      this.diag.beeps++;
    }
  }

  private applyMasterGain(): void {
    if (!this.ctx || !this.master) return;
    const target = this.muted || this.paused || this.hidden ? 0 : 0.7 * this.volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
  }

  /** Master volume 0..1 (settings). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
  }

  get masterVolume(): number {
    return this.volume;
  }

  /** Current master gain target (diagnostics / tests). */
  get outputGain(): number {
    return this.master ? this.master.gain.value : 0;
  }

  /** Engine running (someone is in the car) or off (parked). */
  setEngineOn(on: boolean): void {
    if (on === this.engineOn) return;
    this.engineOn = on;
    if (this.ctx && this.engineBus) this.engineBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, on ? 0.25 : 0.12);
  }

  get isEngineOn(): boolean {
    return this.engineOn;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMasterGain();
  }

  /** Fade out and suspend while the game is paused. */
  setPaused(p: boolean): void {
    this.paused = p;
    this.syncRunning();
  }

  /**
   * Page visibility. Menus, briefings and result screens keep the city ambience running while the page is
   * visible, but a hidden page must go quiet in every state (and stay quiet until it is visible again).
   */
  setHidden(h: boolean): void {
    if (this.hidden === h) return;
    this.hidden = h;
    this.syncRunning();
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  /** Fade the master bus and suspend / resume the context to match the paused + hidden flags. */
  private syncRunning(): void {
    if (!this.ctx) return;
    this.applyMasterGain();
    if (this.paused || this.hidden) {
      const ctx = this.ctx;
      window.setTimeout(() => {
        if ((this.paused || this.hidden) && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      }, 200);
    } else {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  /**
   * Per-frame update from the simulation (no allocations).
   * @param rpm engine speed
   * @param throttle applied throttle 0..1
   * @param slip tyre slip 0..1
   * @param speed vehicle speed in m/s
   */
  /** Engine character of the current car (firing order → fundamental, pitch, rasp). */
  private profile: { cylinders: number; pitch: number; growl: number; redline: number; induction: 'none' | 'turbo' | 'super'; boost: number } = {
    cylinders: CYLINDERS,
    pitch: 1,
    growl: 1,
    redline: ENGINE.redlineRpm,
    induction: 'none',
    boost: 0,
  };

  setEngineProfile(cylinders: number, pitch: number, growl: number, redline: number, induction: 'none' | 'turbo' | 'super' = 'none', boost = 1): void {
    this.profile = { cylinders, pitch, growl, redline, induction, boost };
    this.boost = 0;
    this.liftArmed = false;
  }

  /** `dt`: game frame time (s) — turbo spool follows the simulation, so it pauses with the game and is frame-rate independent. */
  update(rpm: number, throttle: number, slip: number, speed: number, dt = 0): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.engineOscA || !this.engineOscB || !this.engineOscC) return;
    const t = ctx.currentTime;
    const pr = this.profile;
    const f = (rpm / 60) * (pr.cylinders / 2) * pr.pitch;
    this.engineOscA.frequency.setTargetAtTime(f, t, 0.025);
    // Growl 1 = reference V8; more growl → wider detune between the two saw voices (beating = rasp).
    this.engineOscB.frequency.setTargetAtTime(f * (1.007 + (pr.growl - 1) * 0.01), t, 0.025);
    this.engineOscC.frequency.setTargetAtTime(f * 0.5, t, 0.025);
    const rpmK = Math.min(1, rpm / pr.redline);
    // Inside the cabin the bulkhead takes the top off the engine note and the body booms a little more.
    const cabinTone = this.cabin ? 0.72 : 1;
    const cabinLevel = this.cabin ? 1.12 : 1;
    this.engineFilter?.frequency.setTargetAtTime((280 + rpmK * 1500 + throttle * 1700) * (1 + (pr.growl - 1) * 0.4) * cabinTone, t, 0.05);
    this.engineGain?.gain.setTargetAtTime((0.07 + throttle * 0.08 + rpmK * 0.05) * (1 + (pr.growl - 1) * 0.25) * cabinLevel, t, 0.06);

    // Forced induction.
    dt = Math.min(0.25, Math.max(0, dt));
    this.gameTime += dt;
    if (pr.induction === 'turbo') {
      // Boost builds with exhaust flow (rpm × load) and lags behind it; it collapses quickly off throttle.
      const target = throttle > 0.25 ? Math.min(1, Math.max(0, (rpm - 0.3 * pr.redline) / (0.45 * pr.redline))) * throttle : 0;
      const rate = target > this.boost ? 1.7 : 5;
      this.boost += (target - this.boost) * (1 - Math.exp(-rate * dt));
      if (throttle > 0.55) this.liftArmed = true;
      else if (throttle < 0.15 && this.liftArmed) {
        this.liftArmed = false;
        if (this.boost > 0.3) {
          this.blowOff(this.boost * pr.boost);
          this.boost *= 0.2;
        }
      }
      const tg = this.boost * this.boost * 0.045 * pr.boost * (this.cabin ? 0.8 : 1);
      const tf = 2100 + this.boost * 3900 + rpmK * 700;
      this.turboOsc?.frequency.setTargetAtTime(tf, t, 0.05);
      this.turboFilter?.frequency.setTargetAtTime(tf, t, 0.05);
      this.turboGain?.gain.setTargetAtTime(tg, t, 0.05);
      this.whooshGain?.gain.setTargetAtTime(this.boost * 0.05 * pr.boost, t, 0.08);
      this.diag.turbo = tg;
    } else {
      this.boost = 0;
      this.turboGain?.gain.setTargetAtTime(0, t, 0.05);
      this.whooshGain?.gain.setTargetAtTime(0, t, 0.05);
      this.diag.turbo = 0;
    }
    if (pr.induction === 'super') {
      // Belt-driven blower spinning ≈ 2.6× crank speed; the whine grows with rpm and load.
      this.whineOsc?.frequency.setTargetAtTime((rpm / 60) * 2.6 * 12, t, 0.02);
      const wg = rpmK * (0.3 + 0.7 * throttle) * 0.03 * pr.boost;
      this.whineGain?.gain.setTargetAtTime(wg, t, 0.05);
      this.diag.whine = wg;
    } else {
      this.whineGain?.gain.setTargetAtTime(0, t, 0.05);
      this.diag.whine = 0;
    }
    this.diag.boost = this.boost;

    const squeal = Math.max(0, Math.min(1, slip)) * Math.min(1, speed / 6) * (1 - 0.7 * this.wet);
    this.skidGain?.gain.setTargetAtTime(squeal * 0.22, t, 0.04);
    this.skidFilter?.frequency.setTargetAtTime(950 + squeal * 450, t, 0.1);
    const wind = Math.min(1, speed / 70);
    this.windGain?.gain.setTargetAtTime(wind * wind * 0.28 * (this.cabin ? 0.6 : 1), t, 0.15);
  }

  /**
   * Weather sound: rain 0..1, road wetness 0..1, the listener's car speed (m/s, 0 on foot) and whether the
   * listener sits in a car (the cabin muffles the rain).
   */
  weather(rain: number, wetness: number, carSpeed: number, inCar: boolean): void {
    this.wet = Math.max(0, Math.min(1, wetness));
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.rainGain || !this.rainLow || !this.sprayGain) return;
    const t = ctx.currentTime;
    const r = Math.max(0, Math.min(1, rain));
    const g = r * (inCar ? 0.1 : 0.16);
    this.rainGain.gain.setTargetAtTime(g, t, 0.8);
    this.rainLow.frequency.setTargetAtTime(inCar ? 2600 : 8000, t, 0.2);
    const spray = this.wet * Math.min(1, carSpeed / 30) * 0.16;
    this.sprayGain.gain.setTargetAtTime(spray, t, 0.15);
    this.diag.rain = g;
    this.diag.spray = spray;
  }

  /** One-shot collision thump; strength is the velocity change in m/s. */
  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - this.lastImpact < 0.12) return;
    this.lastImpact = now;
    const k = Math.min(1, strength / 14);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260 + k * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.25 + k * 0.75, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25 + k * 0.35);
    src.connect(lp).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.7);
  }

  private ready(): AudioContext | null {
    const ctx = this.ctx;
    return ctx && this.master && ctx.state === 'running' ? ctx : null;
  }

  /** Short synth tone (one-shot). */
  private tone(freq: number, at: number, dur: number, type: OscillatorType, gain: number, endFreq?: number): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** Filtered noise burst (one-shot). */
  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, gain: number, rate = 1): void {
    const ctx = this.ready();
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random() * 1.5);
    src.stop(at + dur + 0.05);
  }

  /** Footstep on asphalt; intensity 0..1 (walk ≈ 0.5, run ≈ 1). */
  footstep(intensity: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastStep < 0.12) return;
    this.lastStep = now;
    const k = Math.max(0.2, Math.min(1, intensity));
    this.burst(now, 0.07 + k * 0.03, 'bandpass', 700 + Math.random() * 500, 0.1 + k * 0.12, 0.8 + Math.random() * 0.4);
    this.burst(now, 0.05, 'lowpass', 180, 0.12 * k);
  }

  /** Car door open / close. */
  door(close: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (close) {
      this.burst(now, 0.18, 'lowpass', 240, 0.6, 0.6);
      this.burst(now, 0.05, 'bandpass', 1800, 0.12);
    } else {
      this.burst(now, 0.06, 'bandpass', 2400, 0.14);
      this.burst(now + 0.03, 0.12, 'lowpass', 400, 0.22, 0.8);
    }
  }

  /** Pistol shot: sharp crack + low body thump; quieter with distance (m) for other shooters. */
  gunshot(distance = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    const k = Math.max(0.15, 1 - distance / 120);
    this.burst(now, 0.09, 'highpass', 1400, 0.9 * k, 1.2);
    this.burst(now, 0.22, 'lowpass', 520, 0.85 * k, 0.55);
    this.tone(150, now, 0.12, 'sine', 0.35 * k, 55);
  }

  /** Empty chamber click. */
  dryFire(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.burst(ctx.currentTime, 0.025, 'bandpass', 3200, 0.18);
  }

  /** Magazine out (start) / in + slide (end). */
  reload(end: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.burst(now, 0.04, 'bandpass', end ? 2200 : 1500, 0.2);
    if (end) this.burst(now + 0.12, 0.05, 'bandpass', 2800, 0.22);
  }

  /** Bullet striking a hard surface (distance in m). */
  ricochet(distance: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const k = Math.max(0.1, 1 - distance / 90);
    this.burst(ctx.currentTime, 0.05, 'bandpass', 2600 + Math.random() * 1200, 0.16 * k);
  }

  /** Starter motor whirr followed by the engine catching. */
  engineStart(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let k = 0; k < 4; k++) this.tone(42 + k * 3, now + k * 0.09, 0.08, 'sawtooth', 0.08);
    this.burst(now, 0.45, 'bandpass', 900, 0.05);
    this.tone(55, now + 0.36, 0.5, 'sawtooth', 0.14, 120);
  }

  checkpoint(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.tone(880, now, 0.16, 'sine', 0.22);
    this.tone(1318.5, now + 0.09, 0.28, 'sine', 0.2);
  }

  penalty(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    this.tone(196, now, 0.22, 'square', 0.08);
    this.tone(147, now + 0.12, 0.26, 'square', 0.07);
  }

  /** Race countdown beep (final = the "GO" tone). */
  countdown(final: boolean): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.tone(final ? 1046.5 : 659.3, ctx.currentTime, final ? 0.55 : 0.18, 'triangle', 0.26);
  }

  fanfare(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => this.tone(f, now + k * 0.12, k === 3 ? 0.7 : 0.2, 'triangle', 0.22));
    this.tone(1318.5, now + 0.48, 0.7, 'sine', 0.1);
  }

  failure(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    [392, 329.6, 261.6].forEach((f, k) => this.tone(f, now + k * 0.2, 0.32, 'sawtooth', 0.08));
  }

  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenHigh = false;
  private sirenNext = 0;
  /**
   * Police siren (two-tone wail), 0 = off. Call every frame; `level` should already include the
   * distance falloff. One persistent oscillator, created on first use.
   */
  siren(level: number): void {
    const ctx = this.ready();
    if (!ctx || !this.master) return;
    if (!this.sirenOsc) {
      if (level <= 0) return;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 740;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(lp).connect(g).connect(this.master);
      o.start();
      this.sirenOsc = o;
      this.sirenGain = g;
    }
    const now = ctx.currentTime;
    this.sirenGain!.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.07, now, 0.12);
    if (level > 0 && now >= this.sirenNext) {
      this.sirenHigh = !this.sirenHigh;
      this.sirenOsc.frequency.setTargetAtTime(this.sirenHigh ? 960 : 740, now, 0.04);
      this.sirenNext = now + 0.55;
    }
  }

  /** Car horn of a traffic car `distance` metres away (two detuned square tones, quieter with distance). */
  horn(distance: number): void {
    const ctx = this.ready();
    if (!ctx || distance > 90) return;
    const now = ctx.currentTime;
    const g = 0.09 / (1 + distance / 12);
    this.tone(415, now, 0.42, 'square', g);
    this.tone(523, now, 0.42, 'square', g * 0.8);
  }

  /** Soft UI click. */
  click(): void {
    const ctx = this.ready();
    if (!ctx) return;
    this.tone(1400, ctx.currentTime, 0.05, 'sine', 0.06);
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }
}
