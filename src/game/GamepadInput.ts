import type { ControlSource, ControlState, InputAction } from './InputManager';

/**
 * Game controller support through the browser Gamepad API (standard mapping: Xbox / PlayStation layouts and
 * most USB / Bluetooth pads).
 *
 * In game:  left stick move / steer · RT throttle · LT brake / reverse · A jump / handbrake · Y enter / exit ·
 *           X reset car / reload · B crouch · LB weapon · RB camera view · L3 run · right stick look ·
 *           View / Back map · Menu / Start pause · D-pad down skip.
 * With the weapon drawn: LT aims and RT fires.
 * In menus: D-pad or left stick moves the focus, A presses, B goes back (same as Escape), Start resumes.
 *
 * The state is re-read from the browser every frame, so a controller that disconnects (or a window that loses
 * focus) can never leave an input held. Rumble uses `vibrationActuator` where the browser supports it.
 */

const STICK_DEAD = 0.16;
const TRIGGER_DEAD = 0.05;
/** Right-stick look speed at full deflection (drag pixels per second). */
const LOOK_X = 950;
const LOOK_Y = 650;

export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

/** What the controller should do right now (supplied by the game every frame). */
export interface PadContext {
  /** Gameplay has the input (otherwise a menu / overlay is open and the pad navigates it). */
  capturing: boolean;
  /** Weapon drawn on foot: triggers aim and fire. */
  armed: boolean;
}

interface Haptics {
  effects?: readonly string[];
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
  reset?: () => Promise<unknown>;
}

/** Radial dead zone with the rest of the range rescaled to 0..1. */
function deadzone(x: number, y: number, out: { x: number; y: number }): void {
  const m = Math.hypot(x, y);
  if (m < STICK_DEAD) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const k = Math.min(1, (m - STICK_DEAD) / (1 - STICK_DEAD)) / m;
  out.x = x * k;
  out.y = y * k;
}

type Dir = 'up' | 'down' | 'left' | 'right';

/** Visible, enabled, focusable controls of the current screen. */
function focusables(): HTMLElement[] {
  const list = document.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex]:not([tabindex="-1"])');
  const out: HTMLElement[] = [];
  for (const el of list) {
    if ((el as HTMLButtonElement).disabled || el.closest('[inert], [aria-hidden="true"], .hidden, .hud, .touch-controls')) continue;
    if (el.getClientRects().length === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
    out.push(el);
  }
  return out;
}

export class GamepadInput implements ControlSource {
  /** Settings → Controller vibration. */
  vibration = true;
  /** Timestamp (performance.now) of the last real input from a controller. */
  lastInput = -1e9;
  private index = -1;
  private padId = '';
  private readonly prev: boolean[] = new Array(17).fill(false);
  private readonly s = { moveX: 0, moveY: 0, steer: 0, throttle: 0, brake: 0, handbrake: false, run: false, aim: false, fire: false };
  private readonly ls = { x: 0, y: 0 };
  private readonly rs = { x: 0, y: 0 };
  private navDir: Dir | null = null;
  private navTimer = 0;
  private readonly abort = new AbortController();
  /** Counters for automated tests (read-only). */
  readonly diag = { rumbles: 0, triggerRumbles: 0, strong: 0, weak: 0, nav: 0, presses: 0 };

  constructor(
    private readonly emit: (a: InputAction) => void,
    private readonly look: (dx: number, dy: number) => void,
    private readonly onConnectChange: () => void,
  ) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('gamepadconnected', () => this.onConnectChange(), opts);
    window.addEventListener(
      'gamepaddisconnected',
      (e) => {
        if ((e as GamepadEvent).gamepad.index === this.index) {
          this.index = -1;
          this.zero();
        }
        this.onConnectChange();
      },
      opts,
    );
    // Mouse / touch use hides the controller focus ring again.
    window.addEventListener('pointerdown', () => document.body.classList.remove('pad-nav'), opts);
  }

  /** The controller in use (the last one that sent input), if still connected. */
  private current(): Gamepad | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    if (this.index >= 0) {
      const p = pads[this.index];
      if (p && p.connected) return p;
      this.index = -1;
    }
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5)) {
        this.index = p.index;
        this.padId = p.id;
        return p;
      }
    }
    return null;
  }

  /** Name of a connected controller ('' if none). */
  get connectedName(): string {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    if (this.index >= 0 && pads[this.index]?.connected) return this.padId || pads[this.index]?.id || 'Controller';
    for (const p of pads) if (p && p.connected) return p.id || 'Controller';
    return '';
  }

  get active(): boolean {
    return this.index >= 0;
  }

  private zero(): void {
    const s = this.s;
    s.moveX = s.moveY = s.steer = s.throttle = s.brake = 0;
    s.handbrake = s.run = s.aim = s.fire = false;
    this.prev.fill(false);
    this.navDir = null;
  }

  /** Read the controller (every frame, also while paused so menus can be navigated). */
  poll(dt: number, ctx: PadContext): void {
    const pad = this.current();
    if (!pad) {
      if (this.s.throttle || this.s.brake || this.s.steer || this.s.moveX || this.s.moveY || this.s.handbrake) this.zero();
      this.look(0, 0);
      return;
    }
    const b = pad.buttons;
    const down = (i: number): boolean => !!b[i]?.pressed;
    const value = (i: number): number => {
      const v = b[i]?.value ?? 0;
      return v > TRIGGER_DEAD ? (v - TRIGGER_DEAD) / (1 - TRIGGER_DEAD) : 0;
    };
    const pressed = (i: number): boolean => down(i) && !this.prev[i];
    deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.ls);
    deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.rs);
    const lt = value(PAD.LT);
    const rt = value(PAD.RT);
    let any = this.ls.x !== 0 || this.ls.y !== 0 || this.rs.x !== 0 || this.rs.y !== 0 || lt > 0 || rt > 0;
    for (let i = 0; i < 17; i++) if (down(i)) any = true;
    if (any) this.lastInput = performance.now();

    const s = this.s;
    if (!ctx.capturing) {
      s.moveX = s.moveY = s.steer = s.throttle = s.brake = 0;
      s.handbrake = s.run = s.aim = s.fire = false;
      this.look(0, 0);
      this.navigate(dt, pad, pressed);
    } else {
      this.navDir = null;
      s.moveX = this.ls.x;
      s.moveY = -this.ls.y;
      // Slightly progressive steering: fine corrections near the centre, full lock at the end of travel.
      const x = this.ls.x;
      s.steer = Math.sign(x) * (0.55 * Math.abs(x) + 0.45 * x * x);
      s.throttle = ctx.armed ? 0 : rt;
      s.brake = ctx.armed ? 0 : lt;
      s.aim = ctx.armed && lt > 0.3;
      s.fire = ctx.armed && rt > 0.5;
      s.handbrake = down(PAD.A);
      s.run = down(PAD.LS);
      this.look(this.rs.x * LOOK_X * dt, this.rs.y * LOOK_Y * dt);
      const act = (i: number, a: InputAction): void => {
        if (pressed(i)) {
          this.diag.presses++;
          this.emit(a);
        }
      };
      act(PAD.A, 'jump');
      act(PAD.Y, 'interact');
      act(PAD.X, 'reset');
      act(PAD.B, 'crouch');
      act(PAD.LB, 'weapon');
      act(PAD.RB, 'camera');
      act(PAD.BACK, 'map');
      act(PAD.DOWN, 'skip');
    }
    if (pressed(PAD.START)) {
      this.diag.presses++;
      this.emit('pause');
    }
    for (let i = 0; i < 17; i++) this.prev[i] = down(i);
  }

  /** Menus: move the focus between visible controls, press with A, go back with B (as Escape does). */
  private navigate(dt: number, pad: Gamepad, pressed: (i: number) => boolean): void {
    const b = pad.buttons;
    let dir: Dir | null = null;
    if (b[PAD.UP]?.pressed || this.ls.y < -0.6) dir = 'up';
    else if (b[PAD.DOWN]?.pressed || this.ls.y > 0.6) dir = 'down';
    else if (b[PAD.LEFT]?.pressed || this.ls.x < -0.6) dir = 'left';
    else if (b[PAD.RIGHT]?.pressed || this.ls.x > 0.6) dir = 'right';
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navTimer = 0.38;
      if (dir) this.move(dir);
    } else if (dir) {
      this.navTimer -= dt;
      if (this.navTimer <= 0) {
        this.navTimer = 0.12;
        this.move(dir);
      }
    }
    if (pressed(PAD.A)) {
      this.diag.presses++;
      const el = document.activeElement as HTMLElement | null;
      const list = focusables();
      if (el && list.includes(el)) {
        if (!(el instanceof HTMLInputElement && el.type === 'range')) el.click();
      } else this.focus(list.find((e) => e.classList.contains('primary')) ?? list[0] ?? null);
    }
    if (pressed(PAD.B)) {
      this.diag.presses++;
      // Exactly what the Escape key does on this screen (Back in the front end, resume from pause, close the map).
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
    }
  }

  private focus(el: HTMLElement | null): void {
    if (!el) return;
    document.body.classList.add('pad-nav');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.diag.nav++;
  }

  private move(dir: Dir): void {
    const list = focusables();
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !list.includes(cur)) {
      this.focus(list.find((e) => e.classList.contains('primary')) ?? list[0] ?? null);
      return;
    }
    // Sliders take left / right as value steps.
    if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'left') cur.stepDown();
      else cur.stepUp();
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      cur.dispatchEvent(new Event('change', { bubbles: true }));
      this.diag.nav++;
      return;
    }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy = r0.top + r0.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along < 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
  }

  contribute(out: ControlState): void {
    const s = this.s;
    out.moveX += s.moveX;
    out.moveY += s.moveY;
    out.steer += s.steer;
    out.throttle = Math.max(out.throttle, s.throttle);
    out.brake = Math.max(out.brake, s.brake);
    out.handbrake = out.handbrake || s.handbrake;
    out.run = out.run || s.run;
    out.aim = out.aim || s.aim;
    out.fire = out.fire || s.fire;
  }

  /** Release everything (blur, pause, mode change); held buttons count again from the next poll. */
  clear(): void {
    this.zero();
    // Treat buttons that are still down as already handled, so releasing focus does not fire actions.
    const pad = this.index >= 0 ? navigator.getGamepads?.()[this.index] : null;
    if (pad) for (let i = 0; i < 17; i++) this.prev[i] = !!pad.buttons[i]?.pressed;
  }

  private haptics(): Haptics | null {
    if (!this.vibration || this.index < 0) return null;
    const pad = navigator.getGamepads?.()[this.index] as (Gamepad & { vibrationActuator?: Haptics }) | null | undefined;
    const h = pad?.vibrationActuator;
    return h && typeof h.playEffect === 'function' ? h : null;
  }

  /** Two-motor rumble: strong (low-frequency) and weak (high-frequency) motors 0..1 for `ms` milliseconds. */
  rumble(strong: number, weak: number, ms: number): void {
    const h = this.haptics();
    if (!h?.playEffect) return;
    const st = Math.max(0, Math.min(1, strong));
    const wk = Math.max(0, Math.min(1, weak));
    this.diag.rumbles++;
    this.diag.strong = st;
    this.diag.weak = wk;
    h.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: st, weakMagnitude: wk }).catch(() => undefined);
  }

  /** Trigger motors (Xbox-style impulse triggers, only where the browser exposes them). */
  triggerRumble(left: number, right: number, ms: number): void {
    const h = this.haptics();
    if (!h?.playEffect || !h.effects?.includes('trigger-rumble')) return;
    this.diag.triggerRumbles++;
    h.playEffect('trigger-rumble', {
      startDelay: 0,
      duration: ms,
      strongMagnitude: 0,
      weakMagnitude: 0,
      leftTrigger: Math.max(0, Math.min(1, left)),
      rightTrigger: Math.max(0, Math.min(1, right)),
    }).catch(() => undefined);
  }

  /** Stop any rumble (pause, leaving the car, vibration switched off). */
  stopRumble(): void {
    const pad = this.index >= 0 ? (navigator.getGamepads?.()[this.index] as (Gamepad & { vibrationActuator?: Haptics }) | null) : null;
    pad?.vibrationActuator?.reset?.().catch(() => undefined);
  }

  dispose(): void {
    this.stopRumble();
    this.abort.abort();
  }
}
