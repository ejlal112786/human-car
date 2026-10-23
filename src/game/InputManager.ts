import type { DriverInput } from './Drivetrain';

/** One-shot actions (edge-triggered). */
export type InputAction = 'reset' | 'pause' | 'mute' | 'interact' | 'jump' | 'map' | 'weapon' | 'crouch' | 'skip' | 'camera' | 'torch' | 'aimToggle';

/** Continuous control state sampled once per fixed step (keyboard + touch merged). */
export interface ControlState {
  /** On-foot movement, camera-relative: x = right, y = forward. Length <= 1. */
  moveX: number;
  moveY: number;
  run: boolean;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Weapon: aim held (right mouse / touch toggle) and trigger held (left mouse / touch). */
  aim: boolean;
  fire: boolean;
}

export function createControlState(): ControlState {
  return { moveX: 0, moveY: 0, run: false, throttle: 0, brake: 0, steer: 0, handbrake: false, aim: false, fire: false };
}

/** Anything that contributes continuous input (keyboard, touch controls). */
export interface ControlSource {
  /** Merge this source into `out` (sources are combined with max/sum, never overwrite). */
  contribute(out: ControlState): void;
  clear(): void;
}

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyZ',
  'ShiftLeft',
  'ShiftRight',
]);

/**
 * Keyboard state tracker. Uses physical key codes so WASD works on any layout.
 * While capturing, game keys never scroll the page or activate focused buttons.
 * Additional sources (touch controls) are merged in {@link read}.
 */
export class InputManager implements ControlSource {
  /** When false, game keys are ignored (menus open) but Escape still works. */
  capturing = false;
  private readonly down = new Set<string>();
  private readonly abort = new AbortController();
  private readonly sources: ControlSource[] = [this];
  /** Mouse buttons held on the game canvas (0 = left / fire, 2 = right / aim). */
  private readonly mouse = new Set<number>();
  /** Mouse buttons only act while the weapon is out (otherwise they drag the camera as before). */
  mouseWeapon = false;
  private keyboardAim = false;
  /** Timestamp (performance.now) of the last real key press (decides which control hints the HUD shows). */
  lastKeyTime = -1e9;

  constructor(private readonly onAction: (action: InputAction) => void) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.clearAll, opts);
    document.addEventListener('visibilitychange', () => document.hidden && this.clearAll(), opts);
  }

  /** Track mouse buttons pressed on the game canvas (weapon aim / fire). */
  attachMouse(dom: HTMLElement): void {
    const opts = { signal: this.abort.signal };
    // Pointer Events send only one pointerdown / pointerup per pointer: pressing the second button
    // while the first is held (aim + fire) arrives as a pointermove with a new `buttons` mask.
    // So the pressed set is synced from `buttons` (bit 1 = left → 0, bit 2 = right → 2).
    const sync = (e: PointerEvent, mayPress: boolean): void => {
      if (e.pointerType !== 'mouse') return;
      for (const [bit, b] of [[1, 0], [2, 2]] as const) {
        if (e.buttons & bit) {
          if (mayPress && this.capturing) this.mouse.add(b);
        } else this.mouse.delete(b);
      }
    };
    dom.addEventListener('pointerdown', (e) => sync(e, true), opts);
    window.addEventListener('pointermove', (e) => sync(e, e.target === dom), opts);
    window.addEventListener('pointerup', (e) => sync(e, false), opts);
    window.addEventListener('pointercancel', () => this.mouse.clear(), opts);
  }

  addSource(s: ControlSource): void {
    this.sources.push(s);
  }

  /** Forward a one-shot action from another device (touch buttons). */
  emit(a: InputAction): void {
    this.onAction(a);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.isTrusted) this.lastKeyTime = performance.now();
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) this.onAction('pause');
      return;
    }
    if (e.code === 'KeyM') {
      if (!e.repeat) this.onAction('mute');
      return;
    }
    if (!this.capturing) return;
    if (e.code === 'KeyN') {
      e.preventDefault();
      if (!e.repeat) this.onAction('map');
      return;
    }
    if (e.code === 'KeyV') {
      e.preventDefault();
      if (!e.repeat) this.onAction('camera');
      return;
    }
    if (e.code === 'Digit1' || e.code === 'KeyC' || e.code === 'ControlLeft' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat) this.onAction(e.code === 'Digit1' ? 'weapon' : e.code === 'Enter' ? 'skip' : 'crouch');
      return;
    }
    if (e.code === 'KeyQ') {
      e.preventDefault();
      if (!e.repeat) this.keyboardAim = !this.keyboardAim;
      return;
    }
    if (e.code === 'KeyT') {
      e.preventDefault();
      if (!e.repeat) this.onAction('torch');
      return;
    }
    if (e.code === 'KeyR' || e.code === 'KeyE' || e.code === 'KeyF') {
      e.preventDefault();
      if (!e.repeat) this.onAction(e.code === 'KeyR' ? 'reset' : 'interact');
      return;
    }
    if (GAME_KEYS.has(e.code)) {
      e.preventDefault();
      if (e.code === 'Space' && !e.repeat) this.onAction('jump');
      this.down.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.down.delete(e.code) || (this.capturing && GAME_KEYS.has(e.code))) e.preventDefault();
  };

  /** Release every keyboard key. */
  clear(): void {
    this.down.clear();
    this.mouse.clear();
    this.keyboardAim = false;
  }

  /** Release every input of every source (blur, pause, mode change). */
  clearAll = (): void => {
    for (const s of this.sources) s.clear();
  };

  private has(a: string, b: string): boolean {
    return this.down.has(a) || this.down.has(b);
  }

  contribute(out: ControlState): void {
    const up = this.has('KeyW', 'ArrowUp') ? 1 : 0;
    const dn = this.has('KeyS', 'ArrowDown') ? 1 : 0;
    const left = this.has('KeyA', 'ArrowLeft') ? 1 : 0;
    const right = this.has('KeyD', 'ArrowRight') ? 1 : 0;
    out.moveX += right - left;
    out.moveY += up - dn;
    out.run = out.run || this.has('ShiftLeft', 'ShiftRight');
    out.throttle = Math.max(out.throttle, up);
    out.brake = Math.max(out.brake, dn);
    out.steer += right - left;
    out.handbrake = out.handbrake || this.down.has('Space');
    out.aim = out.aim || (this.mouseWeapon && this.mouse.has(2)) || (this.mouseWeapon && this.keyboardAim);
    out.fire = out.fire || this.down.has('KeyZ') || (this.mouseWeapon && this.mouse.has(0));
  }

  /** Fill `out` with the merged state of every source (no allocation). */
  read(out: ControlState): ControlState {
    out.moveX = 0;
    out.moveY = 0;
    out.run = false;
    out.throttle = 0;
    out.brake = 0;
    out.steer = 0;
    out.handbrake = false;
    out.aim = false;
    out.fire = false;
    for (const s of this.sources) s.contribute(out);
    // Diagonals never exceed full speed; opposite inputs cancel.
    const len = Math.hypot(out.moveX, out.moveY);
    if (len > 1) {
      out.moveX /= len;
      out.moveY /= len;
    }
    out.steer = Math.max(-1, Math.min(1, out.steer));
    out.throttle = Math.min(1, out.throttle);
    out.brake = Math.min(1, out.brake);
    return out;
  }

  /** Copy the driving part of the control state into the vehicle's input struct. */
  static toDriver(c: ControlState, out: DriverInput): DriverInput {
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.handbrake = c.handbrake;
    return out;
  }

  dispose(): void {
    this.abort.abort();
    this.down.clear();
  }
}
