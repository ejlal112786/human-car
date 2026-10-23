import type { ControlSource, ControlState, InputAction } from '../game/InputManager';

export type TouchLayout = 'none' | 'foot' | 'drive';

type HoldName = 'left' | 'right' | 'gas' | 'brake' | 'handbrake' | 'fire';

const ICON = {
  jump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-7 7h4v6h6v-6h4z"/></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5.3 5.3 0 0 1-4.6-2.6l-1-1.6a2 2 0 0 0-1.7-1L6 8.3V13h2V9.6z"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4 7.5 12l8 8z"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4l8 8-8 8z"/></svg>',
};

/**
 * On-screen touch controls built on Pointer Events.
 * Every control tracks the pointer ids pressing it, so multiple fingers work at once
 * (steer + accelerate, move + jump), and pointerup / pointercancel / lost capture
 * always release exactly the control that finger was holding.
 */
export class TouchControls implements ControlSource {
  readonly root: HTMLDivElement;
  private layout: TouchLayout = 'none';
  private visible = false;
  private readonly holds = new Map<HoldName, Set<number>>();
  private runToggle = false;
  private sensitivity = 1;
  // Floating joystick
  private stickId: number | null = null;
  private stickOX = 0;
  private stickOY = 0;
  private joyX = 0;
  private joyY = 0;
  private readonly stickZone: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly interactBtn: HTMLButtonElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly aimBtn: HTMLButtonElement;
  private readonly crouchBtn: HTMLButtonElement;
  private aimToggle = false;
  private readonly abort = new AbortController();

  constructor(
    parent: HTMLElement,
    private readonly emit: (a: InputAction) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls hidden';
    this.root.innerHTML = `
      <div class="tc-foot">
        <div class="tc-stick-zone" data-zone="stick">
          <div class="tc-stick"><div class="tc-knob"></div></div>
        </div>
        <div class="tc-cluster tc-foot-right">
          <button type="button" class="tc-btn tc-run" data-tc="run" aria-label="Run" aria-pressed="false">${ICON.run}<span>Run</span></button>
          <button type="button" class="tc-btn tc-jump" data-tc="jump" aria-label="Jump">${ICON.jump}<span>Jump</span></button>
        </div>
        <div class="tc-weapon">
          <button type="button" class="tc-btn tc-small tc-gun" data-tc="weapon" aria-label="Draw or holster weapon"><span>Gun</span></button>
          <button type="button" class="tc-btn tc-small tc-crouch" data-tc="crouch" aria-label="Crouch" aria-pressed="false"><span>Crouch</span></button>
          <button type="button" class="tc-btn tc-small tc-reload tc-armed" data-tc="reload" aria-label="Reload"><span>Reload</span></button>
        </div>
        <div class="tc-fire-cluster tc-armed">
          <button type="button" class="tc-btn tc-aim" data-tc="aim" aria-label="Aim" aria-pressed="false"><span>Aim</span></button>
          <button type="button" class="tc-btn tc-fire" data-tc="fire" aria-label="Fire"><span>Fire</span></button>
        </div>
      </div>
      <div class="tc-drive">
        <div class="tc-cluster tc-steer">
          <button type="button" class="tc-btn tc-pad" data-tc="left" aria-label="Steer left">${ICON.left}</button>
          <button type="button" class="tc-btn tc-pad" data-tc="right" aria-label="Steer right">${ICON.right}</button>
        </div>
        <div class="tc-cluster tc-pedals">
          <button type="button" class="tc-btn tc-hb" data-tc="handbrake" aria-label="Handbrake"><span>Handbrake</span></button>
          <button type="button" class="tc-btn tc-brake" data-tc="brake" aria-label="Brake / reverse"><span>Brake</span></button>
          <button type="button" class="tc-btn tc-gas" data-tc="gas" aria-label="Accelerate"><span>Gas</span></button>
        </div>
      </div>
      <button type="button" class="tc-btn tc-interact hidden" data-tc="interact" aria-label="Interact"><span class="tc-interact-label">Enter</span></button>
    `;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string): T => {
      const el = this.root.querySelector<T>(s);
      if (!el) throw new Error(`Touch control missing: ${s}`);
      return el;
    };
    this.stickZone = q('.tc-stick-zone');
    this.stickBase = q('.tc-stick');
    this.stickKnob = q('.tc-knob');
    this.interactBtn = q<HTMLButtonElement>('.tc-interact');
    this.runBtn = q<HTMLButtonElement>('.tc-run');
    for (const n of ['left', 'right', 'gas', 'brake', 'handbrake', 'fire'] as const) this.holds.set(n, new Set());
    this.aimBtn = q<HTMLButtonElement>('.tc-aim');
    this.crouchBtn = q<HTMLButtonElement>('.tc-crouch');

    const opts = { signal: this.abort.signal };
    this.root.addEventListener('pointerdown', this.onDown, opts);
    this.root.addEventListener('pointermove', this.onMove, opts);
    this.root.addEventListener('pointerup', this.onUp, opts);
    this.root.addEventListener('pointercancel', this.onUp, opts);
    this.root.addEventListener('lostpointercapture', this.onUp, opts);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    // Long-press / double-tap gestures must never select text or zoom.
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), { ...opts, passive: false });
  }

  get isVisible(): boolean {
    return this.visible && this.layout !== 'none';
  }

  setSensitivity(s: number): void {
    this.sensitivity = s;
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (!v) this.clear();
    this.apply();
  }

  setLayout(l: TouchLayout): void {
    if (l === this.layout) return;
    this.layout = l;
    this.clear(); // never carry a held control from one layout into the other
    this.apply();
  }

  /** Weapon drawn: show aim / fire / reload (hidden otherwise; the aim toggle is released when hidden). */
  /** The weapon can be used (free roam, on foot): otherwise the Gun / Reload / Aim / Fire buttons are hidden. */
  setWeaponAvailable(on: boolean): void {
    if (this.root.classList.contains('no-weapon') === !on) return;
    this.root.classList.toggle('no-weapon', !on);
    if (!on) this.setArmed(false);
  }

  setArmed(on: boolean): void {
    if (this.root.classList.contains('armed') === on) return;
    this.root.classList.toggle('armed', on);
    if (!on) {
      this.setAim(false);
      this.holds.get('fire')!.clear();
      this.root.querySelector('.tc-fire')?.classList.remove('on');
    }
  }

  /** Reflect the crouch state on its button. */
  setCrouched(on: boolean): void {
    this.crouchBtn.classList.toggle('on', on);
    this.crouchBtn.setAttribute('aria-pressed', String(on));
  }

  private setAim(on: boolean): void {
    this.aimToggle = on;
    this.aimBtn.classList.toggle('on', on);
    this.aimBtn.setAttribute('aria-pressed', String(on));
  }

  /** Show the contextual interact button (Enter / Exit) or hide it (label null). */
  setInteract(label: string | null): void {
    this.interactBtn.classList.toggle('hidden', label === null);
    if (label !== null) {
      const l = this.interactBtn.querySelector('.tc-interact-label');
      if (l && l.textContent !== label) l.textContent = label;
    }
  }

  private apply(): void {
    this.root.classList.toggle('hidden', !this.visible || this.layout === 'none');
    this.root.dataset.layout = this.layout;
  }

  private capture(e: PointerEvent): void {
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic events */
    }
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    const zone = el.closest<HTMLElement>('[data-zone="stick"]');
    if (zone && this.layout === 'foot') {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      const r = this.stickZone.getBoundingClientRect();
      const rad = this.radius();
      // Floating stick: centred under the finger, kept fully inside the zone.
      this.stickOX = Math.min(r.right - rad, Math.max(r.left + rad, e.clientX));
      this.stickOY = Math.min(r.bottom - rad, Math.max(r.top + rad, e.clientY));
      this.stickBase.style.left = `${this.stickOX - r.left}px`;
      this.stickBase.style.top = `${this.stickOY - r.top}px`;
      this.stickZone.classList.add('active');
      this.capture(e);
      this.updateStick(e.clientX, e.clientY);
      return;
    }
    const btn = el.closest<HTMLElement>('[data-tc]');
    if (!btn) return;
    const name = btn.dataset.tc ?? '';
    this.capture(e);
    if (name === 'jump') {
      this.emit('jump');
      this.flash(btn);
    } else if (name === 'interact') {
      this.emit('interact');
      this.flash(btn);
    } else if (name === 'weapon' || name === 'crouch') {
      this.emit(name);
      this.flash(btn);
    } else if (name === 'reload') {
      this.emit('reset');
      this.flash(btn);
    } else if (name === 'aim') {
      this.setAim(!this.aimToggle);
    } else if (name === 'run') {
      this.runToggle = !this.runToggle;
      this.runBtn.classList.toggle('on', this.runToggle);
      this.runBtn.setAttribute('aria-pressed', String(this.runToggle));
    } else {
      const set = this.holds.get(name as HoldName);
      if (set) {
        set.add(e.pointerId);
        btn.classList.add('on');
      }
    }
  };

  private flash(btn: HTMLElement): void {
    btn.classList.add('on');
    window.setTimeout(() => btn.classList.remove('on'), 140);
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      this.updateStick(e.clientX, e.clientY);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      this.releaseStick();
      return;
    }
    for (const [name, set] of this.holds) {
      if (set.delete(e.pointerId) && set.size === 0) this.root.querySelector(`[data-tc="${name}"]`)?.classList.remove('on');
    }
  };

  private radius(): number {
    const scale = parseFloat(getComputedStyle(this.root).getPropertyValue('--hud-scale')) || 1;
    return 58 * scale;
  }

  private updateStick(x: number, y: number): void {
    const rad = this.radius();
    let dx = x - this.stickOX;
    let dy = y - this.stickOY;
    const len = Math.hypot(dx, dy);
    if (len > rad) {
      dx *= rad / len;
      dy *= rad / len;
    }
    this.stickKnob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    // Higher sensitivity reaches full deflection with a shorter thumb movement.
    const reach = rad / Math.max(0.3, this.sensitivity);
    let vx = dx / reach;
    let vy = -dy / reach;
    const m = Math.hypot(vx, vy);
    if (m > 1) {
      vx /= m;
      vy /= m;
    }
    const dead = 0.12;
    const mag = Math.min(1, Math.hypot(vx, vy));
    if (mag < dead) {
      this.joyX = 0;
      this.joyY = 0;
    } else {
      const k = (mag - dead) / (1 - dead) / mag;
      this.joyX = vx * k;
      this.joyY = vy * k;
    }
  }

  private releaseStick(): void {
    this.stickId = null;
    this.joyX = 0;
    this.joyY = 0;
    this.stickKnob.style.transform = 'translate(0px, 0px)';
    // The floating base returns to its resting spot (also keeps it on screen after a rotation).
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    this.stickZone.classList.remove('active');
  }

  contribute(out: ControlState): void {
    if (!this.visible) return;
    if (this.layout === 'foot') {
      out.moveX += this.joyX;
      out.moveY += this.joyY;
      out.run = out.run || this.runToggle;
      out.aim = out.aim || this.aimToggle;
      out.fire = out.fire || this.holds.get('fire')!.size > 0;
    } else if (this.layout === 'drive') {
      const h = this.holds;
      out.steer += (h.get('right')!.size > 0 ? 1 : 0) - (h.get('left')!.size > 0 ? 1 : 0);
      if (h.get('gas')!.size > 0) out.throttle = 1;
      if (h.get('brake')!.size > 0) out.brake = 1;
      if (h.get('handbrake')!.size > 0) out.handbrake = true;
    }
  }

  /** Release everything (pause, blur, layout change). The run toggle is kept off too. */
  clear(): void {
    this.releaseStick();
    for (const set of this.holds.values()) set.clear();
    this.root.querySelectorAll('.tc-btn.on').forEach((b) => b.classList.remove('on'));
    this.runToggle = false;
    this.setAim(false);
    this.runBtn.classList.remove('on');
    this.runBtn.setAttribute('aria-pressed', 'false');
  }

  /** Test/diagnostic view of the current touch state. */
  get debugState(): { joyX: number; joyY: number; holds: Record<string, number>; run: boolean } {
    const holds: Record<string, number> = {};
    for (const [k, v] of this.holds) holds[k] = v.size;
    return { joyX: this.joyX, joyY: this.joyY, holds, run: this.runToggle, aim: this.aimToggle } as { joyX: number; joyY: number; holds: Record<string, number>; run: boolean };
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
  }
}
