import { WEATHER_MODES, type WeatherMode } from './world/Weather';
/** Player preferences (graphics, audio, controls, interface), persisted in localStorage. */

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';
export type QualityMode = 'auto' | QualityLevel;

export interface QualityPreset {
  /** Upper bound for the renderer pixel ratio. */
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Tyre smoke / dust particles. */
  particles: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  ultra: { pixelRatio: 2, shadows: true, shadowMapSize: 4096, particles: true },
  high: { pixelRatio: 1.75, shadows: true, shadowMapSize: 2048, particles: true },
  medium: { pixelRatio: 1.25, shadows: true, shadowMapSize: 1024, particles: true },
  low: { pixelRatio: 1.0, shadows: false, shadowMapSize: 1024, particles: false },
};

export const QUALITY_ORDER: readonly QualityLevel[] = ['ultra', 'high', 'medium', 'low'];

export interface Settings {
  quality: QualityMode;
  muted: boolean;
  /** Master volume 0..1 (scales every sound). */
  volume: number;
  /** Camera orbit speed multiplier for every input device (0.3..2). */
  cameraSensitivity: number;
  /** Extra multiplier for mouse drags (0.3..2). */
  mouseSensitivity: number;
  /** Multiplier for touch look and the on-foot joystick response (0.3..2). */
  touchSensitivity: number;
  /** HUD and touch-control size multiplier (0.8..1.3). */
  hudScale: number;
  showFps: boolean;
  /** Show the short control hint line on the HUD. */
  showHints: boolean;
  /** Touch controls: 'auto' shows them on touch devices / after the first touch. */
  touchControls: 'auto' | 'on' | 'off';
  /** Driving response preset: realism keeps assists restrained, arcade increases stability. */
  drivingFeel: DrivingFeel;
  /** Prison escape guidance: fair hints and wider timing windows without removing consequences. */
  escapeSupport: EscapeSupport;
  /** Rival driving skill preset (races). */
  aiDifficulty: AiDifficulty;
  /** Rubber band: rivals adapt their driving to the gap to the player (off by default). */
  rubberBand: boolean;
  /** Holding Aim: look down the pistol sights (first person) or over the shoulder (third person). */
  aimView: AimView;
  /** Free-roam weather: changing ('dynamic') or fixed. Missions are always dry. */
  weather: WeatherMode;
  /** Driving view: chase camera or in-car (cockpit). V / controller RB / HUD button switch it too. */
  carView: CarView;
  /** Camera motion in the car: g-force head movement, bumps, vibration and collision shake. */
  cameraMotion: CameraMotion;
  /** Controller vibration (rumble). */
  vibration: boolean;
}

export type CarView = 'chase' | 'cockpit';
export type CameraMotion = 'full' | 'reduced' | 'off';
/** Camera motion multiplier per setting. */
export const CAMERA_MOTION_SCALE: Record<CameraMotion, number> = { full: 1, reduced: 0.45, off: 0 };

export type AimView = 'sights' | 'shoulder';

export type DrivingFeel = 'arcade' | 'balanced' | 'realistic';
export type EscapeSupport = 'standard' | 'guided';

export type AiDifficulty = 'easy' | 'normal' | 'hard';
/** Rival skill multiplier per difficulty preset (the level's rival skill × this, capped at 1). */
export const AI_SKILL_SCALE: Record<AiDifficulty, number> = { easy: 0.94, normal: 1, hard: 1.04 };

export const SETTINGS_KEY = 'city-racer.settings.v1';
const STORAGE_KEY = SETTINGS_KEY;
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  quality: 'auto',
  muted: false,
  volume: 0.8,
  cameraSensitivity: 1,
  mouseSensitivity: 1,
  touchSensitivity: 1,
  hudScale: 1,
  showFps: false,
  showHints: true,
  touchControls: 'auto',
  drivingFeel: 'balanced',
  escapeSupport: 'standard',
  aiDifficulty: 'normal',
  rubberBand: false,
  aimView: 'sights',
  weather: 'dynamic',
  carView: 'chase',
  cameraMotion: 'full',
  vibration: true,
};

function isMode(v: unknown): v is QualityMode {
  return v === 'auto' || v === 'ultra' || v === 'high' || v === 'medium' || v === 'low';
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Validate an untrusted (stored) object into complete settings. */
export function sanitizeSettings(parsed: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = DEFAULT_SETTINGS;
  const tc = parsed.touchControls;
  return {
    quality: isMode(parsed.quality) ? parsed.quality : d.quality,
    muted: typeof parsed.muted === 'boolean' ? parsed.muted : d.muted,
    volume: num(parsed.volume, 0, 1, d.volume),
    cameraSensitivity: num(parsed.cameraSensitivity, 0.3, 2, d.cameraSensitivity),
    mouseSensitivity: num(parsed.mouseSensitivity, 0.3, 2, d.mouseSensitivity),
    touchSensitivity: num(parsed.touchSensitivity, 0.3, 2, d.touchSensitivity),
    hudScale: num(parsed.hudScale, 0.8, 1.3, d.hudScale),
    showFps: typeof parsed.showFps === 'boolean' ? parsed.showFps : d.showFps,
    showHints: typeof parsed.showHints === 'boolean' ? parsed.showHints : d.showHints,
    touchControls: tc === 'on' || tc === 'off' || tc === 'auto' ? tc : d.touchControls,
    drivingFeel: parsed.drivingFeel === 'arcade' || parsed.drivingFeel === 'realistic' || parsed.drivingFeel === 'balanced' ? parsed.drivingFeel : d.drivingFeel,
    escapeSupport: parsed.escapeSupport === 'guided' || parsed.escapeSupport === 'standard' ? parsed.escapeSupport : d.escapeSupport,
    aiDifficulty: parsed.aiDifficulty === 'easy' || parsed.aiDifficulty === 'hard' || parsed.aiDifficulty === 'normal' ? parsed.aiDifficulty : d.aiDifficulty,
    rubberBand: typeof parsed.rubberBand === 'boolean' ? parsed.rubberBand : d.rubberBand,
    aimView: parsed.aimView === 'sights' || parsed.aimView === 'shoulder' ? parsed.aimView : d.aimView,
    weather: (WEATHER_MODES as readonly unknown[]).includes(parsed.weather) ? (parsed.weather as WeatherMode) : d.weather,
    carView: parsed.carView === 'chase' || parsed.carView === 'cockpit' ? parsed.carView : d.carView,
    cameraMotion: parsed.cameraMotion === 'full' || parsed.cameraMotion === 'reduced' || parsed.cameraMotion === 'off' ? parsed.cameraMotion : d.cameraMotion,
    vibration: typeof parsed.vibration === 'boolean' ? parsed.vibration : d.vibration,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>);
  } catch {
    // Storage blocked (privacy mode) or corrupt — fall back silently.
    return { ...DEFAULT_SETTINGS };
  }
}

/** Settings as stored right now (another tab may have changed them); null if missing, corrupt or blocked. */
export function readStoredSettings(): Settings | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return sanitizeSettings(parsed as Partial<Record<keyof Settings, unknown>>);
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings simply won't persist */
  }
}

/**
 * Lowers the graphics level when the measured frame rate stays below a threshold.
 * Only ever steps down (never oscillates), and waits after each change so the
 * shader recompile hitch is not mistaken for sustained low performance.
 */
export class AdaptiveQuality {
  private frames = 0;
  private time = 0;
  private cooldown = 3;

  constructor(
    private readonly threshold = 42,
    private readonly window = 2.5,
  ) {}

  reset(cooldown = 3): void {
    this.frames = 0;
    this.time = 0;
    this.cooldown = cooldown;
  }

  /** Feed one rendered frame; returns true when quality should drop one level. */
  sample(dt: number): boolean {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return false;
    }
    this.frames++;
    this.time += dt;
    if (this.time < this.window) return false;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (fps < this.threshold) {
      this.cooldown = 4;
      return true;
    }
    return false;
  }
}
