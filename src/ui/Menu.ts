import { CHAPTERS, FREE_ROAM, KIND_LABEL, LEVELS, PAINTS, type LevelDef } from '../game/missions/Levels';
import { formatTime, type RacerStanding } from '../game/missions/MissionManager';
import type { MapProjection } from './CityMap';
import { isMissionUnlocked, missionLockReason, missionStars, ownsPart, totalStars, type CompletionResult, type Progress } from '../game/missions/Progress';
import { buyBlock, paintAvailable, partBlock, upgradeBlock } from '../game/vehicles/Garage';
import {
  GARAGE_ORDER,
  MAX_UPGRADE,
  PARTS,
  PART_SLOTS,
  PART_SLOT_NAME,
  UPGRADE_INFO,
  UPGRADE_KINDS,
  VEHICLES,
  factoryLook,
  noUpgrades,
  partPrice,
  upgradePrice,
  vehicleById,
  vehicleStats,
  type PartSlot,
  type SetupKey,
  type UpgradeKind,
  SETUP_INFO,
  SETUP_KEYS,
  SETUP_STEPS,
} from '../game/vehicles/VehicleCatalog';
import type { QualityLevel, Settings } from '../game/Settings';
import { CAREER, careerEvent, careerStars, careerStatus, type CareerResult } from '../game/career/Career';

export type GarageAction =
  | { type: 'buy' | 'select'; car: string }
  | { type: 'repair' }
  | { type: 'tyres' }
  | { type: 'upgrade'; car: string; upgrade: UpgradeKind }
  | { type: 'paint'; car: string; paint: string }
  | { type: 'part'; car: string; slot: PartSlot; part: string }
  | { type: 'setup'; car: string; key: SetupKey; delta: 1 | -1 }
  | { type: 'setupReset'; car: string };

/** Padlock (inline SVG: no emoji-font dependency). */
const LOCK_ICON = '<span class="lock" role="img" aria-label="Locked"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span>';
const fmtCr = (n: number): string => `${Math.round(n).toLocaleString('en-US')} cr`;

export type ScreenName = 'title' | 'levels' | 'career' | 'garage' | 'settings' | 'credits' | 'briefing' | 'pause' | 'complete' | 'failed' | 'map';

/** City map screen contents (built by the game; the menu only lays it out). */
export interface MapModel {
  subtitle: string;
  /** Selectable destinations (null = none, e.g. during a mission). */
  destinations: Array<{ id: string; kind: string; label: string; detail: string; meters: number; locked: string | null; x: number; z: number }> | null;
  destId: string | null;
  draw: (canvas: HTMLCanvasElement) => MapProjection;
}

export interface MenuHandlers {
  /** Start (briefing → play) a level by index. */
  onStartLevel: (index: number) => void;
  /** Start a career event by id (briefing → play). */
  onStartCareer: (id: string) => void;
  onFreeRoam: () => void;
  onResume: () => void;
  onRestart: () => void;
  onQuit: () => void;
  onNextLevel: () => void;
  /** Garage purchase / selection / upgrade / paint for a car. */
  onGarage: (action: GarageAction) => void;
  /** Car being browsed in the garage (shown on the showcase stage). */
  onGarageView: (carId: string) => void;
  /** City map: choose (id) or clear (null) the navigation destination. */
  onMapSelect: (poiId: string | null) => void;
  /** A setting changed (already applied to the object passed to `setSettings`). */
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** Any button press (UI click sound, audio unlock). */
  onUiGesture: () => void;
  /** Screen changed (game uses it for the garage camera etc.). */
  onScreen?: (screen: ScreenName | null) => void;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const stars = (n: number, of = 3): string =>
  `<span class="stars" aria-label="${n} of ${of} stars">${'<i class="on">★</i>'.repeat(n)}${'<i>★</i>'.repeat(of - n)}</span>`;
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

const KEYBOARD_HELP = `
  <div class="help-cols">
    <div>
      <h4>On foot</h4>
      <div class="controls-grid">
        <kbd>W A S D</kbd><span>Move (camera-relative)</span>
        <kbd>Shift</kbd><span>Run</span>
        <kbd>Space</kbd><span>Jump</span>
        <kbd>C / Ctrl</kbd><span>Crouch / stand</span>
        <kbd>E</kbd><span>Get in a car (when close)</span>
        <kbd>Mouse</kbd><span>Drag to look · wheel to zoom</span>
      </div>
    </div>
    <div>
      <h4>Weapon (free roam)</h4>
      <div class="controls-grid">
        <kbd>1</kbd><span>Draw / holster the pistol</span>
        <kbd>Right mouse</kbd><span>Aim down the sights (hold) · also looks around</span>
        <kbd>Left mouse</kbd><span>Fire (while the pistol is out)</span>
        <kbd>R</kbd><span>Reload</span>
        <kbd>Aim at a car</kbd><span>The driver stops and gets out</span>
      </div>
    </div>
    <div>
      <h4>Driving</h4>
      <div class="controls-grid">
        <kbd>W / ↑</kbd><span>Accelerate</span>
        <kbd>S / ↓</kbd><span>Brake · reverse when stopped</span>
        <kbd>A D / ← →</kbd><span>Steer · bikes lean into your steering input</span>
        <kbd>Space</kbd><span>Handbrake
        <kbd>E</kbd><span>Get out (when slow)</span>
        <kbd>R</kbd><span>Reset car to the road</span>
        <kbd>V</kbd><span>Chase camera / in-car view</span>
        <kbd>Mouse</kbd><span>Drag to look around (also in the car)</span>
      </div>
    </div>
    <div>
      <h4>Anytime</h4>
      <div class="controls-grid">
        <kbd>Esc / P</kbd><span>Pause</span>
        <kbd>M</kbd><span>Sound on / off</span>
      </div>
    </div>
    <div>
      <h4>Controller</h4>
      <div class="controls-grid">
        <kbd>Left stick</kbd><span>Move · steer</span>
        <kbd>RT / LT</kbd><span>Accelerate / brake, reverse · with the pistol out: fire / aim</span>
        <kbd>A</kbd><span>Jump · handbrake</span>
        <kbd>Y</kbd><span>Get in / out · use</span>
        <kbd>X</kbd><span>Reset car · reload</span>
        <kbd>B</kbd><span>Crouch</span>
        <kbd>LB / RB</kbd><span>Pistol / camera view</span>
        <kbd>L3 · right stick</kbd><span>Run · look</span>
        <kbd>View · Menu</kbd><span>City map · pause</span>
        <kbd>Menus</kbd><span>D-pad / left stick move, A select, B back</span>
      </div>
    </div>
    <div>
      <h4>Touch</h4>
      <p class="help-text">On foot: drag anywhere on the left half to move, drag on the right to look. Driving: steering arrows on the left, pedals and handbrake on the right. The round button enters and exits the car. In free roam the Gun button draws the pistol; then Aim toggles aiming, hold Fire to shoot, and Reload and Crouch sit beside them.</p>
    </div>
  </div>`;

/** All menu screens (title, levels, garage, settings, credits, briefing, pause, results). */
export class Menu {
  private readonly root: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private readonly abort = new AbortController();
  private current: ScreenName | null = null;
  private settingsReturn: ScreenName = 'title';
  private ready = false;
  private progress: Progress | null = null;
  private settings: Settings | null = null;
  private effectiveQuality: QualityLevel = 'high';
  private briefingIndex = 0;
  /** Career event shown on the briefing screen (null = a mission briefing). */
  private briefingCareer: string | null = null;
  /** Car shown in the garage (may not be owned yet). */
  private garageCar = '';
  /** Garage opened from the city (Done returns to the game instead of the title). */
  private garageInGame = false;
  private mapModel: MapModel | null = null;
  /** Repair offer for the car being driven (0 = undamaged) and its damage level. */
  private repair = { price: 0, level: 0 };
  private tyres = { price: 0, wear: 0 };
  private loadingText = 'Loading…';

  constructor(
    parent: HTMLElement,
    private readonly h: MenuHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menus';
    const names: ScreenName[] = ['title', 'levels', 'career', 'garage', 'settings', 'credits', 'briefing', 'pause', 'complete', 'failed', 'map'];
    for (const n of names) {
      const el = document.createElement('div');
      el.className = `overlay screen screen-${n} hidden`;
      el.setAttribute('role', 'dialog');
      el.dataset.screen = n;
      this.root.appendChild(el);
      this.screens.set(n, el);
    }
    this.notice = document.createElement('div');
    this.notice.className = 'overlay notice-screen hidden';
    this.notice.setAttribute('role', 'alertdialog');
    this.notice.innerHTML = `<div class="panel compact"><div class="boot-spinner"></div><h2 class="notice-title"></h2><p class="notice-text"></p></div>`;
    parent.append(this.root, this.notice);

    this.root.addEventListener('click', this.onClick, { signal: this.abort.signal });
    window.addEventListener('resize', () => this.current === 'map' && this.drawMap(), { signal: this.abort.signal });
    this.root.addEventListener('input', this.onInput, { signal: this.abort.signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Enter' && this.current === 'title' && this.ready && !e.repeat) {
          const primary = this.screens.get('title')?.querySelector<HTMLButtonElement>('button.primary:not([disabled])');
          if (primary) {
            e.preventDefault();
            primary.click();
          }
        }
        // Escape = Back on the front-end screens. In-game screens (pause, map, city garage,
        // settings opened from pause, results) keep their own Escape handling in Game.
        const c = this.current;
        const frontEnd = c === 'levels' || c === 'career' || c === 'credits' || c === 'briefing' || (c === 'garage' && !this.garageInGame) || (c === 'settings' && this.settingsReturn !== 'pause');
        if (e.code === 'Escape' && !e.repeat && frontEnd) {
          e.preventDefault();
          this.h.onUiGesture();
          this.back();
        }
      },
      { signal: this.abort.signal },
    );
    this.renderTitle();
  }

  get screen(): ScreenName | null {
    return this.current;
  }

  // ------------------------------------------------------------------ data

  setProgress(p: Progress): void {
    this.progress = p;
    if (this.current === 'title') this.renderTitle();
    if (this.current === 'levels') this.renderLevels();
    if (this.current === 'career') this.renderCareer();
    if (this.current === 'garage') this.renderGarage();
  }

  /** Name of the connected game controller ('' = none); shown in Settings. */
  private controllerName = '';

  setController(name: string): void {
    this.controllerName = name;
    if (this.current === 'settings') this.syncSettings();
  }

  setSettings(s: Settings, effective: QualityLevel): void {
    this.settings = s;
    this.effectiveQuality = effective;
    if (this.current === 'settings') this.syncSettings();
  }

  setLoading(text: string): void {
    this.loadingText = text;
    if (!this.ready) this.renderTitle();
  }

  setReady(): void {
    this.ready = true;
    this.renderTitle();
  }

  // ------------------------------------------------------------------ navigation

  show(name: ScreenName): void {
    if (name === 'title') this.renderTitle();
    else if (name === 'levels') this.renderLevels();
    else if (name === 'career') this.renderCareer();
    else if (name === 'garage') {
      if (this.current !== 'garage') this.garageCar = this.progress?.car ?? VEHICLES[0].id;
      this.renderGarage();
      this.h.onGarageView(this.garageCar);
    } else if (name === 'settings') this.renderSettings();
    else if (name === 'credits') this.renderCredits();
    for (const [n, el] of this.screens) el.classList.toggle('hidden', n !== name);
    this.current = name;
    this.h.onScreen?.(name);
    // Keyboard users land on the first button.
    const first = this.screens.get(name)?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus({ preventScroll: true });
  }

  hideAll(): void {
    for (const el of this.screens.values()) el.classList.add('hidden');
    this.current = null;
    this.h.onScreen?.(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  showBriefing(index: number): void {
    this.briefingIndex = index;
    this.briefingCareer = null;
    const lv = LEVELS[index];
    const best = this.progress?.best[lv.id];
    const el = this.screens.get('briefing');
    if (!el) return;
    const goals = lv.objectives.map((o) => `<li>${esc(o)}</li>`).join('');
    const tips = lv.tips.map((o) => `<li>${esc(o)}</li>`).join('');
    const limit = lv.timeLimit ? `<div class="kv"><span>Time limit</span><b>${formatTime(lv.timeLimit)}</b></div>` : '';
    const st = lv.drift
      ? `<div class="kv"><span>Pass / ★★ / ★★★</span><b>${fmtCr(lv.drift.target)} / ${fmtCr(lv.drift.stars[1])} / ${fmtCr(lv.drift.stars[0])} pts</b></div>`
      : lv.race?.byPosition
        ? '<div class="kv"><span>Stars</span><b>1st ★★★ · 2nd ★★ · 3rd ★</b></div>'
        : lv.stars
          ? `<div class="kv"><span>★★★ / ★★</span><b>${formatTime(lv.stars[0])} / ${formatTime(lv.stars[1])}</b></div>`
          : '';
    const bestRow = best ? `<div class="kv"><span>Your best</span><b>${best.score !== undefined ? `${fmtCr(best.score)} pts` : formatTime(best.time)} ${stars(best.stars)}</b></div>` : '';
    el.innerHTML = `
      <div class="panel">
        <div class="eyebrow">Mission ${lv.number} · ${esc(KIND_LABEL[lv.kind])}</div>
        <h2>${esc(lv.title)}</h2>
        <p class="lead">${esc(lv.summary)}</p>
        <div class="brief-grid">
          <div><h4>Objectives</h4><ol class="goals">${goals}</ol></div>
          <div><h4>Tips</h4><ul class="tips">${tips}</ul></div>
        </div>
        <div class="kv-list">${limit}${st}${bestRow}</div>
        <div class="btn-row">
          <button type="button" class="btn primary" data-action="start">Start mission</button>
          <button type="button" class="btn" data-action="levels">Back</button>
        </div>
      </div>`;
    this.show('briefing');
  }

  showPause(title: string, objective: string): void {
    const el = this.screens.get('pause');
    if (!el) return;
    el.innerHTML = `
      <div class="panel compact">
        <div class="eyebrow">${esc(title)}</div>
        <h2>Paused</h2>
        ${objective ? `<p class="lead">${esc(objective)}</p>` : ''}
        <div class="btn-col">
          <button type="button" class="btn primary" data-action="resume">Resume</button>
          <button type="button" class="btn" data-action="restart">Restart</button>
          <button type="button" class="btn" data-action="settings">Settings</button>
          <button type="button" class="btn" data-action="quit">Quit to menu</button>
        </div>
      </div>`;
    this.show('pause');
  }

  showComplete(
    levelIndex: number,
    time: number,
    result: CompletionResult,
    penalties: number,
    standings: RacerStanding[] | null,
    details: Array<[string, string]> = [],
    score: number | null = null,
  ): void {
    const lv = LEVELS[levelIndex];
    const el = this.screens.get('complete');
    if (!el) return;
    const p = this.progress;
    const hasNext = levelIndex + 1 < LEVELS.length && !!p && isMissionUnlocked(p, levelIndex + 1);
    const rewards: string[] = [];
    if (result.unlockedLevel !== null) {
      const why = p ? missionLockReason(p, result.unlockedLevel) : null;
      const nl = LEVELS[result.unlockedLevel];
      rewards.push(why ? `Next: Mission ${nl.number} — ${esc(nl.title)} (${esc(why.toLowerCase())})` : `Unlocked: Mission ${nl.number} — ${esc(nl.title)}`);
    }
    for (const pt of result.unlockedPaints) rewards.push(`New paint in the garage: ${esc(pt)}`);
    if (score !== null) {
      if (result.newBest && result.previousScore !== null) rewards.push(`New best score (previous ${fmtCr(result.previousScore)})`);
      else if (result.newBest) rewards.push('Best score recorded');
    } else if (result.newBest && result.previousBest !== null) rewards.push(`New best time (previous ${formatTime(result.previousBest)})`);
    else if (result.newBest) rewards.push('Best time recorded');
    const table = this.standingsTable(standings, 'DNF');
    el.innerHTML = `
      <div class="panel compact result good">
        <div class="eyebrow">Mission ${lv.number} complete</div>
        <h2>${esc(lv.title)}</h2>
        <div class="big-stars">${stars(result.stars)}</div>
        <div class="kv-list">
          <div class="kv"><span>Time</span><b>${formatTime(time)}</b></div>
          ${details.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
          ${result.credits > 0 ? `<div class="kv credits-earned"><span>Credits earned</span><b>+${fmtCr(result.credits)}</b></div>` : ''}
          ${penalties > 0 ? `<div class="kv"><span>Penalties included</span><b>+${penalties}s</b></div>` : ''}
          ${lv.drift ? `<div class="kv"><span>★★★ target</span><b>${fmtCr(lv.drift.stars[0])} pts</b></div>` : lv.stars && !lv.race?.byPosition ? `<div class="kv"><span>★★★ target</span><b>${formatTime(lv.stars[0])}</b></div>` : ''}
        </div>
        ${table}
        ${rewards.length ? `<ul class="rewards">${rewards.map((r) => `<li>${r}</li>`).join('')}</ul>` : ''}
        <div class="btn-row">
          ${hasNext ? '<button type="button" class="btn primary" data-action="next">Next mission</button>' : ''}
          <button type="button" class="btn ${hasNext ? '' : 'primary'}" data-action="restart">Replay</button>
          <button type="button" class="btn" data-action="quit">Menu</button>
        </div>
      </div>`;
    this.show('complete');
  }

  showFailed(levelIndex: number, reason: string, standings: RacerStanding[] | null): void {
    const lv = LEVELS[levelIndex];
    const el = this.screens.get('failed');
    if (!el) return;
    const table = this.standingsTable(standings, '—');
    el.innerHTML = `
      <div class="panel compact result bad">
        <div class="eyebrow">Mission ${lv.number} failed</div>
        <h2>${esc(lv.title)}</h2>
        <p class="lead">${esc(reason)}</p>
        ${table}
        <div class="btn-row">
          <button type="button" class="btn primary" data-action="restart">Retry</button>
          <button type="button" class="btn" data-action="quit">Menu</button>
        </div>
      </div>`;
    this.show('failed');
  }

  /** Selected car's most-worn tyre (0..1) and the price of a new set (row shown above 5 % wear). */
  setTyres(price: number, wear: number): void {
    if (price === this.tyres.price && Math.abs(wear - this.tyres.wear) < 0.005) return;
    this.tyres = { price, wear };
    if (this.current === 'garage') this.renderGarage();
  }

  setRepair(price: number, level: number): void {
    this.repair = { price, level };
    if (this.current === 'garage') this.renderGarage();
  }

  /** Open the garage; `inGame` = visited in the city (Done resumes play). */
  showGarage(inGame: boolean): void {
    this.garageInGame = inGame;
    this.show('garage');
  }

  showMap(model: MapModel): void {
    const el = this.screens.get('map');
    if (!el) return;
    this.mapModel = model;
    const fmtM = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
    const list = model.destinations
      ? model.destinations
          .map(
            (d) => `<button type="button" class="map-dest kind-${d.kind} ${d.id === model.destId ? 'selected' : ''}" data-action="mapdest" data-poi="${d.id}" aria-pressed="${d.id === model.destId}">
              <span class="md-dot"></span><span class="md-text"><b>${esc(d.label)}</b><small>${esc(d.locked ?? d.detail)}</small></span><span class="md-dist">${fmtM(d.meters)}</span>
            </button>`,
          )
          .join('')
      : '';
    el.innerHTML = `
      <div class="panel map-panel">
        <div class="map-head"><h2>City map</h2><p class="lead">${esc(model.subtitle)}</p></div>
        <div class="map-body ${model.destinations ? '' : 'no-list'}">
          <div class="map-view"><canvas class="city-map" aria-label="City map"></canvas><div class="map-pins"></div></div>
          ${model.destinations ? `<div class="map-list">${list}</div>` : ''}
        </div>
        <div class="btn-row">
          ${model.destId ? '<button type="button" class="btn" data-action="mapclear">Clear route</button>' : ''}
          <button type="button" class="btn primary" data-action="back">Back to the game</button>
        </div>
      </div>`;
    for (const [n, e] of this.screens) e.classList.toggle('hidden', n !== 'map');
    this.current = 'map';
    this.h.onScreen?.('map');
    this.drawMap();
    el.querySelector<HTMLElement>('.btn.primary')?.focus({ preventScroll: true });
  }

  /** (Re)draw the map canvas and place the tappable pins over the drawn icons. */
  private drawMap(): void {
    const el = this.screens.get('map');
    const m = this.mapModel;
    const canvas = el?.querySelector<HTMLCanvasElement>('canvas.city-map');
    const pins = el?.querySelector<HTMLElement>('.map-pins');
    if (!el || !m || !canvas || !pins) return;
    const project = m.draw(canvas);
    pins.innerHTML = (m.destinations ?? [])
      .map((d) => {
        const [x, y] = project(d.x, d.z);
        return `<button type="button" class="map-pin" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px" data-action="mapdest" data-poi="${d.id}" aria-label="${esc(d.label)}" title="${esc(d.label)} — ${esc(d.detail)}"></button>`;
      })
      .join('');
  }

  showNotice(title: string, text: string): void {
    const t = this.notice.querySelector('.notice-title');
    const p = this.notice.querySelector('.notice-text');
    if (t) t.textContent = title;
    if (p) p.textContent = text;
    this.notice.classList.remove('hidden');
  }

  hideNotice(): void {
    this.notice.classList.add('hidden');
  }

  // ------------------------------------------------------------------ renderers

  private continueIndex(): number {
    const p = this.progress;
    if (!p) return 0;
    // First playable level without a result, else the last playable one.
    let last = 0;
    for (let k = 0; k < LEVELS.length; k++) {
      if (!isMissionUnlocked(p, k)) continue;
      if (!p.best[LEVELS[k].id]) return k;
      last = k;
    }
    return last;
  }

  private renderTitle(): void {
    const el = this.screens.get('title');
    if (!el) return;
    const p = this.progress;
    const started = !!p && (p.unlocked > 1 || Object.keys(p.best).length > 0);
    const ci = this.continueIndex();
    const dis = this.ready ? '' : 'disabled';
    const primary = started
      ? `<button type="button" class="btn primary big" data-action="continue" ${dis}>Continue<small>Mission ${ci + 1} · ${esc(LEVELS[ci].title)}</small></button>`
      : `<button type="button" class="btn primary big" data-action="play" ${dis}>${this.ready ? 'Play' : 'Loading…'}</button>`;
    const starCount = p ? totalStars(p) : 0;
    el.innerHTML = `
      <div class="title-wrap">
        <div class="brand"><span class="brand-mark"></span>CITY<span>RACER</span></div>
        <p class="tagline">Street missions · Time trials · Racing</p>
        <div class="btn-col menu-main">
          ${primary}
          <button type="button" class="btn" data-action="levels" ${dis}>Missions</button>
          <button type="button" class="btn" data-action="career" ${dis}>Career</button>
          <button type="button" class="btn" data-action="free" ${dis}>Free Roam</button>
          <button type="button" class="btn" data-action="garage" ${dis}>Garage</button>
          <button type="button" class="btn" data-action="settings">Settings</button>
          <button type="button" class="btn" data-action="credits">Credits</button>
        </div>
        <p class="status" aria-live="polite">${this.ready ? (started ? `${starCount} ★ earned` : 'Press Enter or tap Play') : esc(this.loadingText)}</p>
      </div>`;
  }

  private renderLevels(): void {
    const el = this.screens.get('levels');
    if (!el) return;
    const p = this.progress;
    const card = (lv: LevelDef, k: number): string => {
      const why = p ? missionLockReason(p, k) : 'Locked';
      const locked = why !== null;
      const best = p?.best[lv.id];
      const bestText = best ? (best.score !== undefined ? `${fmtCr(best.score)} pts` : formatTime(best.time)) : '';
      return `
        <button type="button" class="level-card ${locked ? 'locked' : ''}" data-action="level" data-index="${k}" ${locked ? 'disabled aria-disabled="true"' : ''}>
          <span class="lc-num">${lv.number}</span>
          <span class="lc-body">
            <span class="lc-title">${esc(lv.title)} <span class="lc-kind">${esc(KIND_LABEL[lv.kind])}</span></span>
            <span class="lc-sum">${locked ? esc(why ?? '') : esc(lv.summary)}</span>
          </span>
          <span class="lc-meta">${locked ? LOCK_ICON : best ? `${stars(best.stars)}<span class="lc-best">${bestText}</span>` : '<span class="lc-new">New</span>'}</span>
        </button>`;
    };
    const sections = CHAPTERS.map((ch, n) => {
      const to = CHAPTERS[n + 1]?.from ?? LEVELS.length;
      const cards = LEVELS.slice(ch.from, to)
        .map((lv, j) => card(lv, ch.from + j))
        .join('');
      return `<h3 class="tier-head">${esc(ch.name)}</h3><div class="level-list">${cards}</div>`;
    }).join('');
    const total = p ? missionStars(p) : 0;
    el.innerHTML = `
      <div class="panel wide">
        <h2>Missions</h2>
        <div class="career-summary"><span>Campaign</span><span>${total} / ${LEVELS.length * 3} ★</span></div>
        <div class="career-list">${sections}</div>
        <div class="btn-row"><button type="button" class="btn" data-action="back">Back</button></div>
      </div>`;
  }

  private renderCareer(): void {
    const el = this.screens.get('career');
    const p = this.progress;
    if (!el || !p) return;
    const status = careerStatus(p);
    const tiers = [...new Set(CAREER.map((e) => e.tier))];
    const kindLabel = (k: string): string => (k === 'race' ? 'Race' : k === 'timetrial' ? 'Time trial' : 'Sprint');
    const sections = tiers
      .map((tier) => {
        const cards = status
          .filter((s) => s.event.tier === tier)
          .map((s) => {
            const lv = s.event.level;
            const meta = !s.unlocked
              ? LOCK_ICON
              : s.best
                ? `${stars(s.best.stars)}<span class="lc-best">${formatTime(s.best.time)}</span>`
                : '<span class="lc-new">New</span>';
            return `
          <button type="button" class="level-card career-card ${s.unlocked ? '' : 'locked'}" data-action="cbrief" data-event="${s.event.id}" ${s.unlocked ? '' : 'disabled aria-disabled="true"'}>
            <span class="lc-num">${lv.number}</span>
            <span class="lc-body">
              <span class="lc-title">${esc(lv.title)} <span class="lc-kind">${kindLabel(lv.kind)}</span></span>
              <span class="lc-sum">${s.unlocked ? esc(lv.summary) : esc(s.lockReason ?? '')}</span>
              <span class="lc-reward">Reward ${fmtCr(s.event.reward)} · ${esc(s.event.advice)}</span>
            </span>
            <span class="lc-meta">${meta}</span>
          </button>`;
          })
          .join('');
        return `<h3 class="tier-head">${esc(tier)}</h3><div class="level-list">${cards}</div>`;
      })
      .join('');
    el.innerHTML = `
      <div class="panel wide">
        <h2>Career</h2>
        <p class="lead career-summary"><span>${careerStars(p)} / ${CAREER.length * 3} career ★</span><span>${fmtCr(p.credits)}</span></p>
        <div class="career-list">${sections}</div>
        <div class="btn-row"><button type="button" class="btn" data-action="back">Back</button></div>
      </div>`;
  }

  /** Briefing for a career event (same screen as missions; Start launches the event). */
  showCareerBriefing(id: string): void {
    const ev = careerEvent(id);
    const el = this.screens.get('briefing');
    if (!ev || !el) return;
    this.briefingCareer = id;
    const lv = ev.level;
    const best = this.progress?.career[id];
    const goals = lv.objectives.map((o) => `<li>${esc(o)}</li>`).join('');
    const tips = lv.tips.map((o) => `<li>${esc(o)}</li>`).join('');
    const rows: string[] = [];
    if (lv.timeLimit) rows.push(`<div class="kv"><span>Time limit</span><b>${formatTime(lv.timeLimit)}</b></div>`);
    if (lv.stars) rows.push(`<div class="kv"><span>★★★ / ★★</span><b>${formatTime(lv.stars[0])} / ${formatTime(lv.stars[1])}</b></div>`);
    if (lv.race) rows.push(`<div class="kv"><span>Rivals</span><b>${lv.race.opponents.map((o) => `${esc(o.name)} (${esc(vehicleById(o.car ?? 'kestrel').name)})`).join(', ')}</b></div>`);
    rows.push(`<div class="kv credits-earned"><span>Reward</span><b>${fmtCr(ev.reward)}</b></div>`);
    rows.push(`<div class="kv"><span>Recommended</span><b>${esc(ev.advice)}</b></div>`);
    if (best) rows.push(`<div class="kv"><span>Your best</span><b>${formatTime(best.time)} ${stars(best.stars)}</b></div>`);
    el.innerHTML = `
      <div class="panel">
        <div class="eyebrow">Career · ${esc(ev.tier)} · Event ${lv.number}</div>
        <h2>${esc(lv.title)}</h2>
        <p class="lead">${esc(lv.summary)}</p>
        <div class="brief-grid">
          <div><h4>Objectives</h4><ol class="goals">${goals}</ol></div>
          <div><h4>Tips</h4><ul class="tips">${tips}</ul></div>
        </div>
        <div class="kv-list">${rows.join('')}</div>
        <div class="btn-row">
          <button type="button" class="btn primary" data-action="cstart">Start event</button>
          <button type="button" class="btn" data-action="career">Back</button>
        </div>
      </div>`;
    this.show('briefing');
  }

  private standingsTable(standings: RacerStanding[] | null, dnf: string): string {
    return standings
      ? `<table class="standings"><tbody>${standings
          .map((s, k) => `<tr class="${s.player ? 'me' : ''}"><td>${k + 1}</td><td>${esc(s.name)}</td><td>${s.finished ? formatTime(s.time) : s.disqualified ? 'DSQ' : dnf}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
  }

  /** Career event result. `next` = id of the next event if it is now open. */
  showCareerComplete(id: string, time: number, result: CareerResult, penalties: number, standings: RacerStanding[] | null, next: string | null): void {
    const ev = careerEvent(id);
    const el = this.screens.get('complete');
    if (!ev || !el) return;
    const lv = ev.level;
    const rewards: string[] = [];
    for (const t of result.unlockedEvents) rewards.push(`Unlocked: ${esc(t)}`);
    for (const p of result.unlockedPaints) rewards.push(`New paint in the garage: ${esc(p)}`);
    if (result.newBest && result.previousBest !== null) rewards.push(`New best time (previous ${formatTime(result.previousBest)})`);
    const nextEv = next ? careerEvent(next) : null;
    if (!nextEv && ev.id !== CAREER[CAREER.length - 1].id) {
      const st = this.progress ? careerStatus(this.progress).find((s) => s.event.after === ev.id) : null;
      if (st?.lockReason) rewards.push(`Next: ${esc(st.event.level.title)} — ${esc(st.lockReason)}`);
    }
    if (ev.id === CAREER[CAREER.length - 1].id) rewards.push('Career complete: you rule the streets!');
    el.innerHTML = `
      <div class="panel compact result good">
        <div class="eyebrow">Career · ${esc(ev.tier)} · Event ${lv.number} complete</div>
        <h2>${esc(lv.title)}</h2>
        <div class="big-stars">${stars(result.stars)}</div>
        <div class="kv-list">
          <div class="kv"><span>Time</span><b>${formatTime(time)}</b></div>
          ${result.credits > 0 ? `<div class="kv credits-earned"><span>Credits earned</span><b>+${fmtCr(result.credits)}</b></div>` : ''}
          ${penalties > 0 ? `<div class="kv"><span>Penalties included</span><b>+${penalties}s</b></div>` : ''}
          ${lv.stars ? `<div class="kv"><span>★★★ target</span><b>${formatTime(lv.stars[0])}</b></div>` : ''}
        </div>
        ${this.standingsTable(standings, 'DNF')}
        ${rewards.length ? `<ul class="rewards">${rewards.map((r) => `<li>${r}</li>`).join('')}</ul>` : ''}
        <div class="btn-row">
          ${nextEv ? '<button type="button" class="btn primary" data-action="next">Next event</button>' : ''}
          <button type="button" class="btn ${nextEv ? '' : 'primary'}" data-action="restart">Replay</button>
          <button type="button" class="btn" data-action="career">Career</button>
        </div>
      </div>`;
    this.show('complete');
  }

  showCareerFailed(id: string, reason: string, standings: RacerStanding[] | null): void {
    const ev = careerEvent(id);
    const el = this.screens.get('failed');
    if (!ev || !el) return;
    el.innerHTML = `
      <div class="panel compact result bad">
        <div class="eyebrow">Career · ${esc(ev.tier)} · Event ${ev.level.number} failed</div>
        <h2>${esc(ev.level.title)}</h2>
        <p class="lead">${esc(reason)}</p>
        ${this.standingsTable(standings, '—')}
        <div class="btn-row">
          <button type="button" class="btn primary" data-action="restart">Retry</button>
          <button type="button" class="btn" data-action="career">Career</button>
        </div>
      </div>`;
    this.show('failed');
  }

  private renderGarage(): void {
    const el = this.screens.get('garage');
    const p = this.progress;
    if (!el || !p) return;
    const def = vehicleById(this.garageCar);
    const owned = p.owned.includes(def.id);
    const driving = p.car === def.id;
    const up = owned ? p.cars[def.id].upgrades : noUpgrades();
    const st = vehicleStats(def, up);
    const total = totalStars(p);

    const cards = GARAGE_ORDER.map((id) => {
      const v = vehicleById(id);
      const own = p.owned.includes(v.id);
      const block = buyBlock(p, v.id);
      const status = p.car === v.id ? 'Driving' : own ? 'Owned' : block === 'stars' ? `${v.requiresStars} ★ needed` : v.price === 0 ? 'Free' : fmtCr(v.price);
      const cls = [v.id === def.id ? 'selected' : '', !own && block === 'stars' ? 'locked' : '', p.car === v.id ? 'driving' : ''].join(' ');
      return `<button type="button" class="car-card ${cls}" data-action="gview" data-car="${v.id}" aria-pressed="${v.id === def.id}">
          <span class="cc-name">${esc(v.name)}</span><span class="cc-kind">${esc(v.kind)}</span><span class="cc-status">${esc(status)}</span>
        </button>`;
    }).join('');

    const bar = (label: string, k: number, title = ''): string =>
      `<div class="stat-bar"${title ? ` title="${esc(title)}"` : ''}><span>${label}</span><i><b style="width:${Math.round(Math.max(0.04, Math.min(1, k)) * 100)}%"></b></i></div>`;
    const stats = `
      <div class="car-figures">
        <div><b>${st.powerKw}</b><span>kW</span></div>
        <div><b>${st.massKg.toLocaleString('en-US')}</b><span>kg</span></div>
        <div><b>${st.topSpeedKmh}</b><span>km/h</span></div>
        <div><b>${esc(st.drivetrain.split(' ')[0])}</b><span>${esc(st.drivetrain.split(' ')[1] ?? 'drive')}</span></div>
        <div><b>${st.frontWeight}/${100 - st.frontWeight}</b><span>F/R</span></div>
        <div><b>${st.clearanceCm}</b><span>cm clear</span></div>
      </div>
      ${bar('Acceleration', (st.accel - 3) / 11.5)}
      ${bar('Top speed', (st.topSpeedKmh - 180) / 150)}
      ${bar('Grip', (st.grip - 0.8) / 2.1)}
      ${bar('Braking', st.braking / 0.46)}
      ${bar('Steering', (st.steering - 0.8) / 1.9)}
      ${bar('Suspension', Math.log(st.stiffness / 10) / Math.log(11), 'Short bar = soft and comfortable, long bar = stiff and flat')}`;

    let action = '';
    if (driving) action = `<button type="button" class="btn primary" disabled>Currently driving</button>`;
    else if (owned) action = `<button type="button" class="btn primary" data-action="gselect" data-car="${def.id}">${def.style === 'motorcycle' ? 'Ride this bike' : 'Drive this car'}</button>`;
    else {
      const b = buyBlock(p, def.id);
      if (b === null) action = `<button type="button" class="btn primary" data-action="gbuy" data-car="${def.id}">Buy · ${fmtCr(def.price)}</button>`;
      else if (b === 'stars') action = `<button type="button" class="btn" disabled>Needs ${def.requiresStars} ★ · you have ${total}</button>`;
      else action = `<button type="button" class="btn" disabled>${fmtCr(def.price - p.credits)} short</button>`;
    }
    const unlockLine = owned
      ? ''
      : `<p class="unlock-line">${def.price === 0 ? 'Free' : `Price ${fmtCr(def.price)}`}${def.requiresStars ? ` · unlocks at ${def.requiresStars} ★ (you have ${total})` : ''}</p>`;

    const upgrades = owned
      ? `<h3>Upgrades</h3><div class="upgrades">${UPGRADE_KINDS.map((k) => {
          const lvl = up[k];
          const b = upgradeBlock(p, def.id, k);
          const price = upgradePrice(def, k, lvl);
          const pips = Array.from({ length: MAX_UPGRADE }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
          const btn =
            b === 'max'
              ? `<button type="button" class="btn small" disabled>Maxed</button>`
              : `<button type="button" class="btn small ${b === null ? 'primary' : ''}" data-action="gupgrade" data-car="${def.id}" data-upgrade="${k}" ${b === null ? '' : 'disabled'}>${fmtCr(price ?? 0)}</button>`;
          return `<div class="upgrade-row"><div class="up-text"><b>${UPGRADE_INFO[k].name}</b><small>${esc(UPGRADE_INFO[k].effect)}</small></div><span class="pips" aria-label="Level ${lvl} of ${MAX_UPGRADE}">${pips}</span>${btn}</div>`;
        }).join('')}</div>`
      : '';

    const setup = owned ? p.cars[def.id].setup : null;
    const setupHtml = setup
      ? `<h3>Setup <span class="h3-note">free · used everywhere you drive this car</span></h3><div class="upgrades setup">${SETUP_KEYS.map((k) => {
          const s = setup[k];
          const info = SETUP_INFO[k];
          const pips = Array.from({ length: SETUP_STEPS * 2 + 1 }, (_, i) => `<i class="${i - SETUP_STEPS === s ? 'on' : ''}${i === SETUP_STEPS ? ' mid' : ''}"></i>`).join('');
          const hint = s < 0 ? info.low : s > 0 ? info.high : 'Factory setting';
          return `<div class="setup-row" title="${esc(info.low)} / ${esc(info.high)}"><div class="up-text"><b>${info.name}</b><small data-setup-value="${k}">${esc(info.value(s, def))} · ${esc(hint)}</small></div><span class="setup-ctl"><button type="button" class="btn small" data-action="gsetup" data-car="${def.id}" data-key="${k}" data-delta="-1" aria-label="${info.name} lower" ${s <= -SETUP_STEPS ? 'disabled' : ''}>−</button><span class="pips setup-pips" aria-label="${info.name}: step ${s}">${pips}</span><button type="button" class="btn small" data-action="gsetup" data-car="${def.id}" data-key="${k}" data-delta="1" aria-label="${info.name} higher" ${s >= SETUP_STEPS ? 'disabled' : ''}>+</button></span></div>`;
        }).join('')}<div class="btn-row"><button type="button" class="btn small" data-action="gsetupreset" data-car="${def.id}" ${SETUP_KEYS.every((k) => setup[k] === 0) ? 'disabled' : ''}>Factory setup</button></div></div>`
      : '';

    const look = owned ? p.cars[def.id].look : factoryLook(def);
    const parts = owned && def.style !== 'motorcycle'
      ? `<h3>Parts <span class="h3-note">Looks only · no effect on handling</span></h3>${PART_SLOTS.map((slot) => {
          const opts = PARTS.filter((x) => x.slot === slot)
            .map((x) => {
              const fitted = look[slot] === x.id;
              const have = ownsPart(p.cars[def.id], def.id, slot, x.id);
              const b = partBlock(p, def.id, slot, x.id);
              const price = partPrice(def, slot, x.id);
              const status = fitted ? 'Fitted' : have ? (price === 0 && x.price > 0 ? 'Factory' : 'Owned') : fmtCr(price);
              return `<button type="button" class="part ${fitted ? 'selected' : ''}" data-action="gpart" data-car="${def.id}" data-slot="${slot}" data-part="${x.id}" aria-pressed="${fitted}" ${fitted || b !== null ? 'disabled' : ''}>
                  <span class="pt-name">${esc(x.name)}</span><span class="pt-status">${esc(status)}</span></button>`;
            })
            .join('');
          return `<div class="part-row"><span class="part-slot">${PART_SLOT_NAME[slot]}</span><div class="part-opts">${opts}</div></div>`;
        }).join('')}`
      : '';

    const paint = owned ? p.cars[def.id].paint : def.defaultPaint;
    const swatches = owned
      ? `<h3>Paint</h3><div class="swatches">${PAINTS.map((c) => {
          const ok = paintAvailable(p, def.id, c.id);
          const sel = paint === c.id;
          return `<button type="button" class="swatch ${sel ? 'selected' : ''} ${ok ? '' : 'locked'}" data-action="paint" data-car="${def.id}" data-paint="${c.id}" ${ok ? '' : 'disabled'} aria-pressed="${sel}" title="${esc(c.name)}">
              <span class="chip" style="background:${hex(c.color)}"></span>
              <span class="sw-name">${esc(c.name)}</span>
              <span class="sw-req">${ok ? (sel ? 'Selected' : 'Available') : `${c.stars} ★ needed`}</span>
            </button>`;
        }).join('')}</div>`
      : '';

    const rp = this.repair;
    const repairRow =
      rp.price > 0
        ? `<div class="repair-row"><div class="up-text"><b>Your car is damaged · ${Math.round(rp.level * 100)}%</b><small>Body work, lamps and engine restored</small></div>
            <button type="button" class="btn small ${p.credits >= rp.price ? 'primary' : ''}" data-action="grepair" ${p.credits >= rp.price ? '' : 'disabled'}>${p.credits >= rp.price ? `Repair · ${fmtCr(rp.price)}` : `Repair ${fmtCr(rp.price)} · ${fmtCr(rp.price - p.credits)} short`}</button></div>`
        : '';
    const ty = this.tyres;
    const tyreRow =
      ty.price > 0 && ty.wear >= 0.05
        ? `<div class="repair-row tyre-row"><div class="up-text"><b>Tyres ${Math.round(ty.wear * 100)}% worn</b><small>${ty.wear >= 0.2 ? 'Worn tread: less grip, much less in the wet, aquaplanes sooner' : 'Plenty of tread left; worn tyres lose grip in the wet first'}</small></div>
            <button type="button" class="btn small ${p.credits >= ty.price && ty.wear >= 0.2 ? 'primary' : ''}" data-action="gtyres" ${p.credits >= ty.price ? '' : 'disabled'}>${p.credits >= ty.price ? `New tyres · ${fmtCr(ty.price)}` : `New tyres ${fmtCr(ty.price)} · ${fmtCr(ty.price - p.credits)} short`}</button></div>`
        : '';
    el.innerHTML = `
      <div class="panel garage-panel">
        ${repairRow}
        ${tyreRow}
        <div class="garage-head"><h2>Garage</h2><div class="wallet"><span>${fmtCr(p.credits)}</span><span>${total} ★</span></div></div>
        <div class="car-cards">${cards}</div>
        <div class="car-detail">
          <div class="eyebrow">${esc(def.kind)}</div>
          <h3 class="car-title">${esc(def.name)}</h3>
          <p class="lead">${esc(def.description)}</p>
          ${stats}
          ${unlockLine}
          <div class="btn-row">${action}</div>
          <p class="orbit-hint">Drag to rotate the preview · scroll or pinch to zoom</p>
        </div>
        ${upgrades}
        ${setupHtml}
        ${parts}
        ${swatches}
        <div class="btn-row"><button type="button" class="btn" data-action="back">Done</button></div>
      </div>`;
  }

  private renderCredits(): void {
    const el = this.screens.get('credits');
    if (!el) return;
    el.innerHTML = `
      <div class="panel compact">
        <h2>Credits</h2>
        <div class="credits">
          <p><b>Character model &amp; animations</b><br>“Animated Human” by Quaternius — CC0 1.0 (public domain)</p>
          <p><b>3D engine</b><br>three.js — MIT License</p>
          <p><b>Physics</b><br>Rapier (dimforge) — Apache License 2.0</p>
          <p><b>City, car, sound and effects</b><br>Generated procedurally in code for this game</p>
        </div>
        <div class="btn-row"><button type="button" class="btn primary" data-action="back">Back</button></div>
      </div>`;
  }

  private renderSettings(): void {
    const el = this.screens.get('settings');
    if (!el) return;
    const slider = (key: keyof Settings, label: string, min: number, max: number, step: number): string => `
      <label class="settings-row">
        <span class="settings-label">${label}</span>
        <input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}">
        <output data-out="${key}"></output>
      </label>`;
    const seg = (key: keyof Settings, label: string, opts: Array<[string, string]>): string => `
      <div class="settings-row">
        <span class="settings-label">${label}</span>
        <div class="seg" role="radiogroup" aria-label="${label}">
          ${opts.map(([v, t]) => `<button type="button" role="radio" data-seg="${key}" data-value="${v}">${t}</button>`).join('')}
        </div>
      </div>`;
    el.innerHTML = `
      <div class="panel wide settings-panel">
        <h2>Settings</h2>
        <div class="settings-cols">
          <section>
            <h4>Audio</h4>
            ${slider('volume', 'Master volume', 0, 1, 0.05)}
            ${seg('muted', 'Sound', [
              ['false', 'On'],
              ['true', 'Off'],
            ])}
            <h4>Graphics</h4>
            ${seg('quality', 'Quality', [
              ['auto', 'Auto'],
              ['ultra', 'Ultra'],
              ['high', 'High'],
              ['medium', 'Medium'],
              ['low', 'Low'],
            ])}
            <p class="settings-note quality-current"></p>
            <h4>Display</h4>
            ${slider('hudScale', 'HUD size', 0.8, 1.3, 0.05)}
            ${seg('showHints', 'Control hints', [
              ['true', 'Show'],
              ['false', 'Hide'],
            ])}
            ${seg('showFps', 'FPS counter', [
              ['true', 'Show'],
              ['false', 'Hide'],
            ])}
            <h4>Controller</h4>
            ${seg('vibration', 'Vibration', [
              ['true', 'On'],
              ['false', 'Off'],
            ])}
            <p class="settings-note controller-status"></p>
            <h4>World</h4>
            ${seg('weather', 'Weather', [
              ['dynamic', 'Changing'],
              ['clear', 'Clear'],
              ['cloudy', 'Overcast'],
              ['rain', 'Rain'],
              ['storm', 'Storm'],
              ['fog', 'Fog'],
            ])}
            <p class="settings-note">Free roam only — missions and races are always run on a dry road. Wet roads, grass and puddles cost grip; fog shortens how far you and the police can see.</p>
          </section>
          <section>
            <h4>Controls</h4>
            ${slider('cameraSensitivity', 'Camera sensitivity', 0.3, 2, 0.05)}
            ${slider('mouseSensitivity', 'Mouse sensitivity', 0.3, 2, 0.05)}
            ${slider('touchSensitivity', 'Touch sensitivity', 0.3, 2, 0.05)}
            ${seg('touchControls', 'Touch controls', [
              ['auto', 'Auto'],
              ['on', 'On'],
              ['off', 'Off'],
            ])}
            ${seg('aimView', 'Aim view', [
              ['sights', 'Down sights'],
              ['shoulder', 'Over shoulder'],
            ])}
            ${seg('carView', 'Car camera', [
              ['chase', 'Chase'],
              ['cockpit', 'In car'],
            ])}
            ${seg('cameraMotion', 'Camera motion', [
              ['full', 'Full'],
              ['reduced', 'Reduced'],
              ['off', 'Off'],
            ])}
            <p class="settings-note">In the car the view leans with braking, cornering and bumps and picks up engine vibration; Reduced or Off if motion bothers you.</p>
            <h4>Driving &amp; accessibility</h4>
            ${seg('drivingFeel', 'Driving feel', [
              ['arcade', 'Arcade'],
              ['balanced', 'Balanced'],
              ['realistic', 'Realistic'],
            ])}
            <p class="settings-note">Realistic keeps the vehicle response and road grip least assisted; Arcade favors forgiving control. Visual quality is separate.</p>
            ${seg('escapeSupport', 'Prison escape guidance', [
              ['standard', 'Standard'],
              ['guided', 'Guided'],
            ])}
            <p class="settings-note">Guided shows clearer next-step clues and gives a little more time for hands-on escape tasks. Guards and consequences remain active.</p>
            <h4>Racing</h4>
            ${seg('aiDifficulty', 'Rival skill', [
              ['easy', 'Easy'],
              ['normal', 'Normal'],
              ['hard', 'Hard'],
            ])}
            ${seg('rubberBand', 'Catch-up rivals', [
              ['false', 'Off'],
              ['true', 'On'],
            ])}
            <p class="settings-note">Applies from the next race start. Catch-up: rivals far ahead drive a little more carefully, rivals far behind a little harder — their cars are never changed.</p>
          </section>
        </div>
        <details class="help">
          <summary>Control reference</summary>
          ${KEYBOARD_HELP}
        </details>
        <div class="btn-row"><button type="button" class="btn primary" data-action="back">Done</button></div>
      </div>`;
    this.syncSettings();
  }

  private syncSettings(): void {
    const s = this.settings;
    const el = this.screens.get('settings');
    if (!s || !el) return;
    el.querySelectorAll<HTMLInputElement>('input[data-setting]').forEach((inp) => {
      const k = inp.dataset.setting as keyof Settings;
      const v = s[k] as number;
      if (document.activeElement !== inp) inp.value = String(v);
      const out = el.querySelector(`output[data-out="${k}"]`);
      if (out) out.textContent = k === 'volume' ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}×`;
    });
    el.querySelectorAll<HTMLButtonElement>('button[data-seg]').forEach((b) => {
      const k = b.dataset.seg as keyof Settings;
      const on = String(s[k]) === b.dataset.value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    const note = el.querySelector('.quality-current');
    if (note) note.textContent = s.quality === 'auto' ? `Auto is using ${this.effectiveQuality}` : '';
    const pad = el.querySelector('.controller-status');
    if (pad) {
      pad.textContent = this.controllerName
        ? `Connected: ${this.controllerName.slice(0, 60)}`
        : 'No controller detected — connect one and press any button. Rumble needs a browser that supports it (Chrome, Edge).';
    }
  }

  // ------------------------------------------------------------------ events

  private back(): void {
    if (this.current === 'map' || (this.current === 'garage' && this.garageInGame)) {
      this.garageInGame = false;
      this.h.onResume();
      return;
    }
    if (this.current === 'settings') {
      if (this.settingsReturn === 'pause') {
        const el = this.screens.get('pause');
        if (el && el.innerHTML) {
          for (const [n, e] of this.screens) e.classList.toggle('hidden', n !== 'pause');
          this.current = 'pause';
          this.h.onScreen?.('pause');
          return;
        }
      }
      this.show('title');
      return;
    }
    if (this.current === 'briefing') this.show(this.briefingCareer ? 'career' : 'levels');
    else this.show('title');
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const segBtn = target.closest<HTMLButtonElement>('button[data-seg]');
    if (segBtn) {
      this.h.onUiGesture();
      const k = segBtn.dataset.seg as keyof Settings;
      const raw = segBtn.dataset.value ?? '';
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      this.h.onSetting(k, value as Settings[typeof k]);
      this.syncSettings();
      return;
    }
    const btn = target.closest<HTMLButtonElement>('button[data-action]');
    if (!btn || btn.disabled) return;
    this.h.onUiGesture();
    const a = btn.dataset.action;
    switch (a) {
      case 'play':
        this.showBriefing(0);
        break;
      case 'continue':
        this.showBriefing(this.continueIndex());
        break;
      case 'levels':
        this.show('levels');
        break;
      case 'level':
        this.showBriefing(Number(btn.dataset.index ?? 0));
        break;
      case 'start':
        this.h.onStartLevel(this.briefingIndex);
        break;
      case 'career':
        this.show('career');
        break;
      case 'cbrief':
        if (btn.dataset.event) this.showCareerBriefing(btn.dataset.event);
        break;
      case 'cstart':
        if (this.briefingCareer) this.h.onStartCareer(this.briefingCareer);
        break;
      case 'free':
        this.h.onFreeRoam();
        break;
      case 'garage':
        this.showGarage(false);
        break;
      case 'mapdest':
        if (btn.dataset.poi) this.h.onMapSelect(btn.dataset.poi);
        break;
      case 'mapclear':
        this.h.onMapSelect(null);
        break;
      case 'paint':
        if (btn.dataset.paint && btn.dataset.car) this.h.onGarage({ type: 'paint', car: btn.dataset.car, paint: btn.dataset.paint });
        this.renderGarage();
        break;
      case 'gview':
        if (btn.dataset.car) {
          this.garageCar = btn.dataset.car;
          this.renderGarage();
          this.h.onGarageView(this.garageCar);
          this.screens.get('garage')?.querySelector<HTMLElement>(`[data-car="${this.garageCar}"]`)?.focus({ preventScroll: true });
        }
        break;
      case 'gbuy':
      case 'gselect':
        if (btn.dataset.car) this.h.onGarage({ type: a === 'gbuy' ? 'buy' : 'select', car: btn.dataset.car });
        this.renderGarage();
        this.h.onGarageView(this.garageCar);
        break;
      case 'grepair':
        this.h.onGarage({ type: 'repair' });
        this.renderGarage();
        break;
      case 'gtyres':
        this.h.onGarage({ type: 'tyres' });
        this.renderGarage();
        break;
      case 'gpart':
        if (btn.dataset.car && btn.dataset.slot && btn.dataset.part)
          this.h.onGarage({ type: 'part', car: btn.dataset.car, slot: btn.dataset.slot as PartSlot, part: btn.dataset.part });
        this.renderGarage();
        this.h.onGarageView(this.garageCar);
        this.screens.get('garage')?.querySelector<HTMLElement>(`[data-action="gpart"][data-slot="${btn.dataset.slot}"]:not([disabled])`)?.focus({ preventScroll: true });
        break;
      case 'gsetup':
        if (btn.dataset.car && btn.dataset.key) {
          this.h.onGarage({ type: 'setup', car: btn.dataset.car, key: btn.dataset.key as SetupKey, delta: btn.dataset.delta === '1' ? 1 : -1 });
          this.renderGarage();
          this.screens.get('garage')?.querySelector<HTMLElement>(`[data-action="gsetup"][data-key="${btn.dataset.key}"][data-delta="${btn.dataset.delta}"]:not([disabled])`)?.focus({ preventScroll: true });
        }
        break;
      case 'gsetupreset':
        if (btn.dataset.car) this.h.onGarage({ type: 'setupReset', car: btn.dataset.car });
        this.renderGarage();
        break;
      case 'gupgrade':
        if (btn.dataset.car && btn.dataset.upgrade) this.h.onGarage({ type: 'upgrade', car: btn.dataset.car, upgrade: btn.dataset.upgrade as UpgradeKind });
        this.renderGarage();
        break;
      case 'settings':
        this.settingsReturn = this.current === 'pause' ? 'pause' : 'title';
        this.show('settings');
        break;
      case 'credits':
        this.show('credits');
        break;
      case 'back':
        this.back();
        break;
      case 'resume':
        this.h.onResume();
        break;
      case 'restart':
        this.h.onRestart();
        break;
      case 'quit':
        this.h.onQuit();
        break;
      case 'next':
        this.h.onNextLevel();
        break;
    }
  };

  private onInput = (e: Event): void => {
    const inp = e.target as HTMLInputElement;
    const k = inp.dataset?.setting as keyof Settings | undefined;
    if (!k) return;
    this.h.onSetting(k, Number(inp.value) as Settings[typeof k]);
    this.syncSettings();
  };

  /** Level shown on the briefing screen (tests / next-level flow). */
  get briefingLevel(): LevelDef {
    if (this.briefingCareer) return careerEvent(this.briefingCareer)?.level ?? FREE_ROAM;
    return LEVELS[this.briefingIndex] ?? FREE_ROAM;
  }

  /** Career event id of the briefing on screen (null for a mission briefing). */
  get briefingCareerId(): string | null {
    return this.briefingCareer;
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
    this.notice.remove();
  }
}

/** Replace the UI with a readable error message (WebGL missing, init failure…). */
export function showFatalError(
  parent: HTMLElement,
  title: string,
  detail: string,
  hintText = 'Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled, then reload the page.',
): void {
  const el = document.createElement('div');
  el.className = 'overlay error-screen';
  const panel = document.createElement('div');
  panel.className = 'panel compact';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'error-detail';
  p.textContent = detail;
  const hint = document.createElement('p');
  hint.className = 'error-hint';
  hint.textContent = hintText;
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => window.location.reload());
  panel.append(h, p, hint, btn);
  el.append(panel);
  parent.append(el);
}
