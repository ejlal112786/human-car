import { ENGINE } from '../game/config';

import type { MissionHud } from '../game/missions/MissionManager';

export interface HudState {
  speedKmh: number;
  rpm: number;
  gear: string;
  handbrake: boolean;
  reversing: boolean;
  shifting: boolean;
  street: string;
  fps: number;
}

export type HudMode = 'foot' | 'drive';

const HINTS: Record<HudMode, string> = {
  foot: 'WASD move · Shift run · Space jump · C crouch · E use · 1 gun · Q aim · Z fire · T torch · Esc pause',
  drive: 'W/S accelerate · brake/reverse · A/D steer · Space handbrake · E exit · R reset · V camera · Esc pause',
};

/** The same hints for a game controller (shown while the controller is the device in use). */
const PAD_HINTS: Record<HudMode, string> = {
  foot: 'Left stick move · L3 run · A jump · B crouch · Y use · LB gun · right stick look · Start pause',
  drive: 'RT gas · LT brake/reverse · left stick steer · A handbrake · Y exit · X reset · RB camera · Start pause',
};
const PAD_ARMED_HINT = 'LT aim · RT fire · X reload · LB holster · B crouch · Start pause';

/** On foot with the weapon out (replaces the foot hint). */
const ARMED_HINT = 'Q toggle / hold right mouse to aim · Z / left click fire · R reload · 1 holster · C crouch · Esc pause';

/** Dial range and red zone follow the current car (see HUD.setEngine). */
let DIAL_MAX_RPM = 8000;
let REDLINE_RPM: number = ENGINE.redlineRpm;
const START_DEG = 135;
const SWEEP_DEG = 270;
const CX = 100;
const CY = 100;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arcPath(r: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(r, fromDeg);
  const [x1, y1] = polar(r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function rpmToDeg(rpm: number): number {
  return START_DEG + (Math.min(rpm, DIAL_MAX_RPM) / DIAL_MAX_RPM) * SWEEP_DEG;
}

function buildTachSvg(): string {
  const ticks: string[] = [];
  for (let rpm = 0; rpm <= DIAL_MAX_RPM; rpm += 500) {
    const major = rpm % 1000 === 0;
    const deg = rpmToDeg(rpm);
    const [x0, y0] = polar(major ? 70 : 74, deg);
    const [x1, y1] = polar(80, deg);
    const red = rpm >= REDLINE_RPM - 400;
    ticks.push(
      `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="tick ${major ? 'major' : ''} ${red ? 'red' : ''}"/>`,
    );
    if (major) {
      const [lx, ly] = polar(59, deg);
      ticks.push(`<text x="${lx.toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" class="tick-label ${red ? 'red' : ''}">${rpm / 1000}</text>`);
    }
  }
  const redFrom = rpmToDeg(REDLINE_RPM);
  const end = START_DEG + SWEEP_DEG;
  return `
  <svg class="tach" viewBox="0 0 200 200" aria-hidden="true">
    <circle cx="100" cy="100" r="96" class="tach-bg"/>
    <path d="${arcPath(88, START_DEG, end)}" class="tach-track"/>
    <path d="${arcPath(88, redFrom, end)}" class="tach-red"/>
    <path d="${arcPath(88, START_DEG, end)}" class="tach-fill" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/>
    ${ticks.join('')}
    <g class="needle" transform="rotate(${START_DEG} 100 100)">
      <line x1="100" y1="100" x2="178" y2="100"/>
    </g>
    <circle cx="100" cy="100" r="5" class="needle-hub"/>
  </svg>`;
}

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-2.5h6L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>';
const ICON_MAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 9 2.5 3 4.6v17l6-2.1 6 2 6-2.1v-17zM10 5l4 1.3v12.8L10 17.7zM5 6l3-1v12.7l-3 1.1zm14 12-3 1.1V6.3l3-1.1z"/></svg>';
const ICON_SOUND =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>';
const ICON_RESET =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>';

/**
 * In-game HUD: speed / rpm cluster (driving only), minimap, street name, mission panel
 * (objective, timer, checkpoints, penalties, position, distance), context prompt,
 * countdown and toasts. DOM writes only happen when a displayed value changes.
 */
export class HUD {
  readonly root: HTMLDivElement;
  readonly minimapCanvas: HTMLCanvasElement;
  private readonly speedEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly rpmEl: HTMLElement;
  private fillEl: SVGPathElement;
  private needleEl: SVGGElement;
  private readonly streetEl: HTMLElement;
  private readonly hbEl: HTMLElement;
  private readonly revEl: HTMLElement;
  private readonly shiftEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly popEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly missionEl: HTMLElement;
  private readonly mTitle: HTMLElement;
  private readonly mObjective: HTMLElement;
  private readonly mTimer: HTMLElement;
  private readonly mInfo: HTMLElement;
  private readonly mDist: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly abort = new AbortController();
  private toastTimer = 0;
  private popTimer = 0;
  private countTimer = 0;
  private mode: HudMode | null = null;
  private armed = false;
  private last = { speed: -1, gear: '', rpm: -1, street: '', hb: false, rev: false, shift: false, fps: -1, redline: false };
  private lastMission = { title: '', objective: '', timer: '', warn: false, info: '', dist: '', visible: false };
  private lastPrompt = '';

  /** Controller hints and prompt keys instead of the keyboard ones. */
  private pad = false;

  constructor(
    parent: HTMLElement,
    handlers: { onPause: () => void; onReset: () => void; onMute: () => void; onMap: () => void; onContinue?: () => void; onCamera?: () => void },
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <div class="hud-top-left">
        <button type="button" class="hud-btn" data-action="pause" aria-label="Pause" title="Pause (Esc)">${ICON_PAUSE}<span class="key">ESC</span></button>
        <button type="button" class="hud-btn drive-only" data-action="reset" aria-label="Reset car" title="Reset car (R)">${ICON_RESET}<span class="key">R</span></button>
        <button type="button" class="hud-btn drive-only" data-action="camera" aria-label="Switch camera: chase or in car" title="Camera view (V)">${ICON_CAMERA}<span class="key">V</span></button>
        <button type="button" class="hud-btn" data-action="mute" aria-label="Sound on or off" title="Sound on/off (M)">${ICON_SOUND}<span class="key">M</span></button>
        <button type="button" class="hud-btn" data-action="map" aria-label="City map" title="City map (N)">${ICON_MAP}<span class="key">N</span></button>
        <div class="fps hidden" aria-hidden="true"></div>
      </div>
      <div class="mission hidden" aria-live="polite">
        <div class="m-title"></div>
        <div class="m-timer"></div>
        <div class="m-objective"></div>
        <div class="m-info"></div>
        <div class="m-dist"></div>
      </div>
      <div class="hud-top-right">
        <button type="button" class="minimap-wrap" data-action="map" aria-label="Open the city map"><canvas class="minimap" width="200" height="200"></canvas><div class="minimap-n">N</div></button>
        <div class="nav-pill hidden" aria-live="polite"><span class="nav-arrow">▲</span><span class="nav-label"></span><span class="nav-dist"></span></div>
        <div class="location"><span class="loc-label">Location</span><span class="loc-name">—</span><span class="loc-weather hidden"></span></div>
        <div class="wanted hidden" aria-live="polite"><span class="wanted-stars"></span><span class="wanted-state"></span></div>
        <div class="detect hidden" aria-live="polite"><span class="d-label">Unseen</span><span class="d-bar"><i></i></span></div>
        <div class="weapon-hud hidden"><span class="w-name">Pistol</span><span class="w-ammo"><b>12</b><i>/ 48</i></span><span class="w-state"></span></div>
      </div>
      <div class="crosshair hidden" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>
      <div class="banner hidden" role="status" aria-live="assertive"><div class="b-title"></div><div class="b-sub"></div></div>
      <div class="fade" aria-hidden="true"></div>
      <div class="arrest-card hidden" role="dialog" aria-label="Arrest summary">
        <div class="ac-title">Arrested</div>
        <dl class="ac-rows"></dl>
        <div class="ac-note"></div>
        <button type="button" class="ac-continue" data-action="continue">Continue <span class="key">E</span></button>
      </div>
      <div class="hud-bottom-left">
        <div class="tyres drive-only" role="img" aria-label="Tyre temperature and tread">
          <span class="ty" data-w="0"><i></i></span><span class="ty" data-w="1"><i></i></span>
          <span class="ty" data-w="2"><i></i></span><span class="ty" data-w="3"><i></i></span>
        </div>
        <div class="indicators drive-only">
          <span class="ind ind-hb">HANDBRAKE</span>
          <span class="ind ind-rev">REVERSE</span>
          <span class="ind ind-shift">SHIFT</span>
          <span class="ind ind-dmg hidden">DAMAGE <b>0%</b></span>
        </div>
        <div class="controls-hint"></div>
      </div>
      <div class="cluster drive-only">
        ${buildTachSvg()}
        <div class="cluster-center">
          <div class="speed">0</div>
          <div class="unit">km/h</div>
          <div class="gear-box"><span class="gear">N</span></div>
          <div class="rpm-readout"><span class="rpm">900</span> rpm</div>
        </div>
      </div>
      <div class="prompt hidden"></div>
      <div class="countdown hidden" aria-live="assertive"></div>
      <div class="pop" role="status"></div>
      <div class="toast" role="status" aria-live="polite"></div>
    `;
    parent.appendChild(this.root);
    const q = <T extends Element>(sel: string): T => {
      const el = this.root.querySelector<T>(sel);
      if (!el) throw new Error(`HUD element missing: ${sel}`);
      return el;
    };
    this.minimapCanvas = q<HTMLCanvasElement>('.minimap');
    this.speedEl = q('.speed');
    this.gearEl = q('.gear');
    this.rpmEl = q('.rpm');
    this.fillEl = q<SVGPathElement>('.tach-fill');
    this.needleEl = q<SVGGElement>('.needle');
    this.streetEl = q('.loc-name');
    this.hbEl = q('.ind-hb');
    this.revEl = q('.ind-rev');
    this.shiftEl = q('.ind-shift');
    this.fpsEl = q('.fps');
    this.toastEl = q('.toast');
    this.popEl = q('.pop');
    this.hintEl = q('.controls-hint');
    this.promptEl = q('.prompt');
    this.countEl = q('.countdown');
    this.missionEl = q('.mission');
    this.mTitle = q('.m-title');
    this.mObjective = q('.m-objective');
    this.mTimer = q('.m-timer');
    this.mInfo = q('.m-info');
    this.mDist = q('.m-dist');
    this.muteBtn = q<HTMLButtonElement>('[data-action="mute"]');

    this.root.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
        if (!btn) return;
        btn.blur();
        if (btn.dataset.action === 'pause') handlers.onPause();
        else if (btn.dataset.action === 'reset') handlers.onReset();
        else if (btn.dataset.action === 'mute') handlers.onMute();
        else if (btn.dataset.action === 'map') handlers.onMap();
        else if (btn.dataset.action === 'camera') handlers.onCamera?.();
        else if (btn.dataset.action === 'continue') handlers.onContinue?.();
      },
      { signal: this.abort.signal },
    );
    this.setMode('foot');
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** On foot hides the driving cluster, indicators and reset button. */
  setMode(mode: HudMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.updateHint();
  }

  private updateHint(): void {
    if (!this.mode) return;
    const armed = this.mode === 'foot' && this.armed;
    const t = this.pad ? (armed ? PAD_ARMED_HINT : PAD_HINTS[this.mode]) : armed ? ARMED_HINT : HINTS[this.mode];
    if (this.hintEl.textContent !== t) this.hintEl.textContent = t;
  }

  /** Show controller hints / prompt keys (the controller is the device in use) or the keyboard ones. */
  setPadMode(on: boolean): void {
    if (on === this.pad) return;
    this.pad = on;
    this.updateHint();
    const p = this.lastPrompt;
    if (p) {
      const i = p.indexOf('|');
      this.lastPrompt = '';
      this.setPrompt(p.slice(i + 1), p.slice(0, i));
    }
  }

  get padMode(): boolean {
    return this.pad;
  }

  setHints(show: boolean): void {
    this.hintEl.classList.toggle('hidden', !show);
  }

  setShowFps(show: boolean): void {
    this.fpsEl.classList.toggle('hidden', !show);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.innerHTML = `${muted ? ICON_MUTED : ICON_SOUND}<span class="key">M</span>`;
    this.muteBtn.classList.toggle('off', muted);
    this.muteBtn.setAttribute('aria-pressed', String(muted));
  }

  /** Context prompt ("E  Enter car"); null hides it. */
  setPrompt(text: string | null, key = 'E'): void {
    const v = text === null ? '' : `${key}|${text}`;
    const shown = this.pad && key === 'E' ? 'Y' : key;
    if (v === this.lastPrompt) return;
    this.lastPrompt = v;
    this.promptEl.classList.toggle('hidden', text === null);
    if (text !== null) this.promptEl.innerHTML = `<kbd>${shown}</kbd><span></span>`;
    const span = this.promptEl.querySelector('span');
    if (span && text !== null) span.textContent = text;
  }

  /** Big centred countdown text ("3", "2", "1", "GO!"). */
  showCountdown(text: string, ms = 900): void {
    this.countEl.textContent = text;
    this.countEl.classList.remove('hidden', 'beat');
    void this.countEl.offsetWidth; // restart the CSS animation
    this.countEl.classList.add('beat');
    window.clearTimeout(this.countTimer);
    this.countTimer = window.setTimeout(() => this.countEl.classList.add('hidden'), ms);
  }

  clearCountdown(): void {
    window.clearTimeout(this.countTimer);
    this.countEl.classList.add('hidden');
  }

  /** Mission panel; null hides it. `distance` in metres (null hides the line). */
  setMission(m: MissionHud | null, distance: number | null): void {
    const L = this.lastMission;
    const visible = m !== null;
    if (visible !== L.visible) {
      L.visible = visible;
      this.missionEl.classList.toggle('hidden', !visible);
    }
    if (!m) return;
    if (m.title !== L.title) this.mTitle.textContent = L.title = m.title;
    if (m.objective !== L.objective) {
      L.objective = m.objective;
      this.mObjective.textContent = m.objective;
      this.mObjective.classList.toggle('hidden', !m.objective);
    }
    const timer = m.timer ?? '';
    if (timer !== L.timer) {
      L.timer = timer;
      this.mTimer.textContent = timer;
      this.mTimer.classList.toggle('hidden', !timer);
    }
    if (m.timerWarning !== L.warn) {
      L.warn = m.timerWarning;
      this.mTimer.classList.toggle('warn', m.timerWarning);
    }
    const info = m.info.join('  ·  ');
    if (info !== L.info) {
      L.info = info;
      this.mInfo.textContent = info;
      this.mInfo.classList.toggle('hidden', !info);
    }
    const dist = distance === null ? '' : distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance / 5) * 5} m`;
    if (dist !== L.dist) {
      L.dist = dist;
      this.mDist.textContent = dist;
      this.mDist.classList.toggle('hidden', !dist);
    }
  }

  private dmgLast = -1;
  /** Damage indicator in the drive cluster (0..1; hidden when practically undamaged). */
  private weaponLast = '';
  /** Weapon readout under the wanted meter (null = hidden: holstered, driving, missions). */
  setWeapon(w: { mag: number; reserve: number; state: string } | null): void {
    const key = w ? `${w.mag}|${w.reserve}|${w.state}` : '';
    if (key === this.weaponLast) return;
    this.weaponLast = key;
    if (this.armed !== !!w) {
      this.armed = !!w;
      this.updateHint();
    }
    const el = this.root.querySelector<HTMLElement>('.weapon-hud');
    if (!el) return;
    el.classList.toggle('hidden', !w);
    if (!w) return;
    (el.querySelector('.w-ammo b') as HTMLElement).textContent = String(w.mag);
    (el.querySelector('.w-ammo i') as HTMLElement).textContent = `/ ${w.reserve}`;
    el.classList.toggle('empty', w.mag === 0);
    (el.querySelector('.w-state') as HTMLElement).textContent = w.state === 'reloading' ? 'Reloading' : w.mag === 0 && w.reserve === 0 ? 'No ammo' : w.mag === 0 ? 'Reload (R)' : '';
  }

  private crossLast = -1;
  /** Centre crosshair; `gap` = spread in px (negative = hidden). */
  setCrosshair(gap: number, onTarget = false): void {
    const g = Math.round(gap) + (onTarget ? 1000 : 0);
    if (g === this.crossLast) return;
    this.crossLast = g;
    const el = this.root.querySelector<HTMLElement>('.crosshair');
    if (!el) return;
    el.classList.toggle('hidden', gap < 0);
    el.classList.toggle('on-target', onTarget);
    el.style.setProperty('--gap', `${Math.max(3, gap)}px`);
  }

  private bannerLast = '';
  /** Large centre banner (arrest, escape objectives). null = hidden. */
  setBanner(title: string | null, sub = '', kind: 'bad' | 'good' | 'info' = 'info'): void {
    const key = title === null ? '' : `${title}|${sub}|${kind}`;
    if (key === this.bannerLast) return;
    this.bannerLast = key;
    const el = this.root.querySelector<HTMLElement>('.banner');
    if (!el) return;
    el.classList.toggle('hidden', title === null);
    el.dataset.kind = kind;
    (el.querySelector('.b-title') as HTMLElement).textContent = title ?? '';
    (el.querySelector('.b-sub') as HTMLElement).textContent = sub;
  }

  private tyreKey = '';
  /**
   * Tyre widget (FL, FR, RL, RR): colour = temperature (blue cold, green in the grip window, orange hot,
   * red overheated), bar = tread left. Updated only when a rounded value changes.
   */
  setTyres(temps: ArrayLike<number>, wear: ArrayLike<number>, windowLow: number, windowHigh: number): void {
    let key = '';
    for (let i = 0; i < 4; i++) key += `${Math.round(temps[i] / 3)},${Math.round(wear[i] * 50)};`;
    if (key === this.tyreKey) return;
    this.tyreKey = key;
    const box = this.root.querySelector<HTMLElement>('.tyres');
    if (!box) return;
    const cells = box.querySelectorAll<HTMLElement>('.ty');
    const names = ['front left', 'front right', 'rear left', 'rear right'];
    const label: string[] = [];
    cells.forEach((el, i) => {
      const t = temps[i];
      const state = t < windowLow ? 'cold' : t <= windowHigh ? 'ok' : t <= windowHigh + 20 ? 'hot' : 'over';
      el.dataset.state = state;
      const left = Math.max(0, 1 - wear[i]);
      (el.firstElementChild as HTMLElement).style.height = `${Math.round(left * 100)}%`;
      label.push(`${names[i]} ${Math.round(t)} °C, ${Math.round(left * 100)} % tread`);
    });
    box.setAttribute('aria-label', `Tyres: ${label.join('; ')}`);
    box.title = label.join('\n');
  }

  private weatherText = '';
  /** Weather line under the location (null hides it). */
  setWeather(text: string | null): void {
    if ((text ?? '') === this.weatherText) return;
    this.weatherText = text ?? '';
    const el = this.root.querySelector<HTMLElement>('.loc-weather');
    if (!el) return;
    el.textContent = this.weatherText;
    el.classList.toggle('hidden', !text);
  }

  setDamage(level: number): void {
    const pct = Math.round(level * 100);
    if (pct === this.dmgLast) return;
    this.dmgLast = pct;
    const el = this.root.querySelector<HTMLElement>('.ind-dmg');
    if (!el) return;
    el.classList.toggle('hidden', pct < 3);
    el.classList.toggle('severe', pct >= 50);
    (el.querySelector('b') as HTMLElement).textContent = `${pct}%`;
  }

  private wantedLast = '';
  /** Wanted meter under the minimap: stars and pursuit state (hidden when clear). */
  setWanted(stars: number, state: 'clear' | 'pursuit' | 'search' | 'busted'): void {
    const key = `${stars}|${state}`;
    if (key === this.wantedLast) return;
    this.wantedLast = key;
    const el = this.root.querySelector<HTMLElement>('.wanted');
    if (!el) return;
    const show = stars > 0 || state === 'busted';
    el.classList.toggle('hidden', !show);
    el.dataset.state = state;
    (el.querySelector('.wanted-stars') as HTMLElement).textContent = '★'.repeat(Math.min(3, stars)) + '☆'.repeat(Math.max(0, 3 - stars));
    (el.querySelector('.wanted-state') as HTMLElement).textContent = state === 'pursuit' ? 'Pursuit' : state === 'search' ? 'Searching' : state === 'busted' ? 'Busted' : '';
  }

  private detectLast = '';
  /** Jail detection meter under the minimap (null = hidden): 0..1 suspicion, `chased` = a guard is after you. */
  setDetect(level: number | null, chased = false): void {
    const pct = level === null ? -1 : Math.round(Math.max(0, Math.min(1, level)) * 20) * 5;
    const key = `${pct}|${chased}`;
    if (key === this.detectLast) return;
    this.detectLast = key;
    const el = this.root.querySelector<HTMLElement>('.detect');
    if (!el) return;
    el.classList.toggle('hidden', level === null);
    if (level === null) return;
    el.dataset.state = chased ? 'chased' : pct >= 50 ? 'alert' : pct > 0 ? 'suspicious' : 'hidden';
    (el.querySelector('.d-label') as HTMLElement).textContent = chased ? 'Spotted!' : pct >= 50 ? 'Suspicious' : pct > 0 ? 'Noticed' : 'Unseen';
    (el.querySelector('.d-bar i') as HTMLElement).style.width = `${chased ? 100 : pct}%`;
  }

  private fadeLast = -1;
  /** Full-screen fade to black (0 = clear, 1 = black): arrest transfer, jail capture. */
  setFade(a: number): void {
    const v = Math.round(Math.max(0, Math.min(1, a)) * 50) / 50;
    if (v === this.fadeLast) return;
    this.fadeLast = v;
    const el = this.root.querySelector<HTMLElement>('.fade');
    if (el) el.style.opacity = String(v);
  }

  /** Arrest summary card (null hides it). Rows are label → value pairs. */
  setArrestCard(card: { title: string; rows: Array<[string, string]>; note: string; canContinue: boolean } | null): void {
    const el = this.root.querySelector<HTMLElement>('.arrest-card');
    if (!el) return;
    el.classList.toggle('hidden', !card);
    if (!card) return;
    (el.querySelector('.ac-title') as HTMLElement).textContent = card.title;
    const dl = el.querySelector('.ac-rows') as HTMLElement;
    dl.textContent = '';
    for (const [k, v] of card.rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    (el.querySelector('.ac-note') as HTMLElement).textContent = card.note;
    (el.querySelector('.ac-continue') as HTMLButtonElement).disabled = !card.canContinue;
  }

  get arrestCardVisible(): boolean {
    return !this.root.querySelector('.arrest-card')?.classList.contains('hidden');
  }

  /** Minimap + location card (hidden in jail, where the city map means nothing). */
  setMapVisible(v: boolean): void {
    this.root.querySelector('.minimap-wrap')?.classList.toggle('hidden', !v);
    this.root.querySelector('.location')?.classList.toggle('hidden', !v);
  }

  private navLast = '';
  /** Navigation pill under the minimap: destination, road distance, turn-around hint. null = hidden. */
  setNav(label: string | null, meters = 0, turnAround = false): void {
    const dist = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(meters / 10) * 10)} m`;
    const key = label === null ? '' : `${label}|${dist}|${turnAround}`;
    if (key === this.navLast) return;
    this.navLast = key;
    const el = this.root.querySelector<HTMLElement>('.nav-pill');
    if (!el) return;
    el.classList.toggle('hidden', label === null);
    if (label === null) return;
    el.classList.toggle('turn', turnAround);
    (el.querySelector('.nav-arrow') as HTMLElement).textContent = turnAround ? '↶' : '▲';
    (el.querySelector('.nav-label') as HTMLElement).textContent = turnAround ? `Turn around · ${label}` : label;
    (el.querySelector('.nav-dist') as HTMLElement).textContent = dist;
  }

  /** Rescale the tachometer for the current car's redline / limiter. */
  setEngine(redlineRpm: number, limiterRpm: number): void {
    const max = Math.max(8000, Math.ceil((limiterRpm + 300) / 1000) * 1000);
    if (max === DIAL_MAX_RPM && redlineRpm === REDLINE_RPM) return;
    DIAL_MAX_RPM = max;
    REDLINE_RPM = redlineRpm;
    const old = this.root.querySelector('.tach');
    if (!old) return;
    const tpl = document.createElement('div');
    tpl.innerHTML = buildTachSvg().trim();
    const fresh = tpl.firstElementChild;
    if (!fresh) return;
    old.replaceWith(fresh);
    this.fillEl = fresh.querySelector('.tach-fill') as SVGPathElement;
    this.needleEl = fresh.querySelector('.needle') as SVGGElement;
    this.last.rpm = -1;
  }

  update(s: HudState): void {
    const l = this.last;
    const speed = Math.round(s.speedKmh);
    if (speed !== l.speed) {
      l.speed = speed;
      this.speedEl.textContent = String(speed);
    }
    if (s.gear !== l.gear) {
      l.gear = s.gear;
      this.gearEl.textContent = s.gear;
      this.gearEl.classList.toggle('rev', s.gear === 'R');
    }
    const rpm = Math.round(s.rpm / 50) * 50;
    if (rpm !== l.rpm) {
      l.rpm = rpm;
      this.rpmEl.textContent = String(rpm);
      const pct = (Math.min(rpm, DIAL_MAX_RPM) / DIAL_MAX_RPM) * 100;
      this.fillEl.setAttribute('stroke-dashoffset', (100 - pct).toFixed(2));
      this.needleEl.setAttribute('transform', `rotate(${rpmToDeg(rpm).toFixed(2)} 100 100)`);
      const red = rpm >= REDLINE_RPM - 300;
      if (red !== l.redline) {
        l.redline = red;
        this.root.querySelector('.cluster')?.classList.toggle('redline', red);
      }
    }
    if (s.street !== l.street) {
      l.street = s.street;
      this.streetEl.textContent = s.street;
    }
    if (s.handbrake !== l.hb) {
      l.hb = s.handbrake;
      this.hbEl.classList.toggle('on', s.handbrake);
    }
    if (s.reversing !== l.rev) {
      l.rev = s.reversing;
      this.revEl.classList.toggle('on', s.reversing);
    }
    if (s.shifting !== l.shift) {
      l.shift = s.shifting;
      this.shiftEl.classList.toggle('on', s.shifting);
    }
    const fps = Math.round(s.fps);
    if (fps !== l.fps) {
      l.fps = fps;
      this.fpsEl.textContent = `${fps} FPS`;
    }
  }

  /** Street name only (on foot). */
  setStreet(name: string): void {
    if (name !== this.last.street) {
      this.last.street = name;
      this.streetEl.textContent = name;
    }
  }

  toast(message: string, ms = 1600): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  /** Short centred pop-up (checkpoint, penalty). `kind` styles it. */
  pop(message: string, kind: 'good' | 'bad' = 'good', ms = 1100): void {
    this.popEl.textContent = message;
    this.popEl.className = `pop show ${kind}`;
    window.clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => this.popEl.classList.remove('show'), ms);
  }

  /** Hide transient messages (state changes). */
  clearTransient(): void {
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.popTimer);
    this.toastEl.classList.remove('show');
    this.popEl.classList.remove('show');
    this.clearCountdown();
    this.setPrompt(null);
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.popTimer);
    window.clearTimeout(this.countTimer);
    this.abort.abort();
    this.root.remove();
  }
}
