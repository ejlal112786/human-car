import type RAPIER from '@dimforge/rapier3d-compat';
import { CircleGeometry, Color, DoubleSide, Mesh, MeshBasicMaterial, Vector3, type Group } from 'three';
import { CharacterController } from '../character/CharacterController';
import type { CharacterModel } from '../character/CharacterModel';
import type { PhysicsWorld } from '../PhysicsWorld';
import type { JailSave } from '../missions/Progress';
import {
  CAMERAS,
  CAMERA_FOV,
  CAMERA_RANGE,
  EXITS,
  GUARDS,
  INTERACTS,
  JAIL_ORIGIN,
  JailLayout,
  SPAWNS,
  zoneAt,
  type DoorId,
  type InteractId,
  type ZoneId,
} from './JailLayout';

/**
 * The jail escape: real guards (character controllers walking patrol routes on a room graph, with
 * line-of-sight vision against the jail's colliders), sweeping security cameras, doors, interactions and
 * checkpoints. Pure game logic + its own visuals; the Game feeds it the player state each fixed step and
 * reacts to its events (caught → respawn at the checkpoint, escaped / bail → back to the city).
 *
 * Escape options:
 *  - vent behind the bunk (unscrew, 3 s) → crawl duct → maintenance room (checkpoint), then
 *    · pry the drain hatch (4 s) → crawl tunnel under the wall (maintenance route), or
 *    · cut the power at the breaker → cameras off, electric yard gate open for POWER_TIME (disable security);
 *  - the keycard on the office desk opens the security door → sally port → front gate (key route);
 *  - the fire alarm (corridor) pulls every guard to it and opens the yard gate for evacuation (distraction);
 *  - yard time (ask the guard at the cell door): corridor / common room / yard are allowed for YARD_TIME;
 *  - bail by phone (credits).
 * Seen in a restricted area (or doing something suspicious) a guard grows suspicious, then gives chase;
 * caught = back to the last checkpoint (keycard kept, power / alarm reset).
 */

export const GUARD_RANGE = 13;
export const GUARD_RANGE_CROUCHED = 7;
export const GUARD_FOV = (110 * Math.PI) / 180;
/** Seconds of clear sight (at close range) before a guard gives chase. */
export const SUSPICION_TIME = 0.7;
/** Caught when a chasing guard gets this close (m). */
export const CATCH_DIST = 1.3;
/** Chase input magnitude (× run speed 5.4 → ~4.6 m/s, a bit slower than a sprinting player). */
const CHASE_MAG = 0.85;
const LOSE_TIME = 6;
const SEARCH_TIME = 5;
const CAMERA_TIME = 1.0;
export const YARD_TIME = 100;
export const POWER_TIME = 150;
export const EMERGENCY_TIME = 110;
export const ALARM_GATE_TIME = 50;
const POWER_INVESTIGATE = 15;
const YARD_COOLDOWN = 25;

const TASK_TIME: Partial<Record<InteractId, number>> = { vent: 3, hatch: 4, emergency: 0.65, breaker: 0.9, keycard: 0.5, alarm: 0.4 };

/** Sight lines filter out group 2 (the cell bars, see BAR_GROUPS in JailLayout). */
const SIGHT_GROUPS = (0x0001 << 16) | 0xfffd;

export type EscapeRoute = 'front' | 'yard' | 'tunnel';

export type JailEvent =
  | { type: 'caught'; checkpoint: number }
  | { type: 'escaped'; route: EscapeRoute }
  | { type: 'bail' }
  | { type: 'checkpoint'; n: number }
  | { type: 'item'; id: string }
  | { type: 'toast'; text: string }
  | { type: 'spotted' };

export interface JailPlayer {
  /** World feet position. */
  x: number;
  y: number;
  z: number;
  crouched: boolean;
  speed: number;
}

export interface JailContext {
  credits: number;
  bail: number;
}

type GuardState = 'patrol' | 'chase' | 'search' | 'investigate' | 'return' | 'escort';

interface Guard {
  readonly id: number;
  readonly ctrl: CharacterController;
  readonly model: CharacterModel | null;
  readonly fan: Mesh | null;
  state: GuardState;
  t: number;
  wp: number;
  waitT: number;
  sus: number;
  /** Last known player position (local). */
  lx: number;
  lz: number;
  unseen: number;
  path: number[];
  pathGoal: number;
  pathT: number;
  sideT: number;
  sideDir: number;
  slowT: number;
  look: number | null;
  stunT: number;
}

// Room graph (local). Guards walk node to node when they have no straight line to their target.
const NODES: ReadonlyArray<[string, number, number]> = [
  ['cN', -35, -19.5], ['cCell', -35.6, -16], ['cOff', -35, -12], ['cMid', -35, -6], ['cCom', -35, 0], ['cStaff', -35, 3], ['cS', -35, 6.2],
  ['cellIn', -40.6, -16],
  ['oDoor', -30.4, -12], ['oDesk', -21.5, -12], ['oNW', -29, -19.5], ['oNE', -21, -20],
  ['mDoor', -39.6, 3], ['mMid', -42, 2.5], ['mBreak', -44.6, 5], ['mHatch', -45, 6.4], ['mDuct', -45, -1],
  ['kW', -30, 0], ['kMid', -18, -5.5], ['kMid2', -18, 5.5], ['kE', -6, 0],
  ['yDoor', -1.5, 0], ['y1', 4, -16], ['y2', 28, -16], ['y3', 33, 0], ['y4', 28, 16], ['y5', 4, 16], ['y6', 2, 0], ['yC', 18, 0],
  ['sDoor', -35, 9.8], ['sMid', -28, 15], ['sGate', -20, 19.5], ['sE', -6, 12],
];
const EDGES: ReadonlyArray<[string, string, DoorId?]> = [
  ['cN', 'cCell'], ['cCell', 'cOff'], ['cOff', 'cMid'], ['cMid', 'cCom'], ['cCom', 'cStaff'], ['cStaff', 'cS'],
  ['cCell', 'cellIn', 'cell'],
  ['cOff', 'oDoor'], ['oDoor', 'oDesk'], ['oDoor', 'oNW'], ['oNW', 'oNE'], ['oNE', 'oDesk'],
  ['cStaff', 'mDoor', 'staff'], ['mDoor', 'mMid'], ['mMid', 'mBreak'], ['mMid', 'mHatch'], ['mMid', 'mDuct'], ['mBreak', 'mHatch'],
  ['cCom', 'kW'], ['kW', 'kMid'], ['kW', 'kMid2'], ['kMid', 'kE'], ['kMid2', 'kE'], ['kE', 'yDoor'],
  ['yDoor', 'y6'], ['y6', 'y1'], ['y6', 'y5'], ['y6', 'yC'], ['yC', 'y1'], ['yC', 'y2'], ['yC', 'y3'], ['yC', 'y4'], ['yC', 'y5'],
  ['y1', 'y2'], ['y2', 'y3'], ['y3', 'y4'], ['y4', 'y5'],
  ['cS', 'sDoor', 'security'], ['sDoor', 'sMid'], ['sMid', 'sGate'], ['sMid', 'sE'], ['sE', 'sGate'],
];
const NODE_INDEX = new Map(NODES.map(([n], i) => [n, i]));
const ADJ: Array<Array<{ to: number; door?: DoorId; len: number }>> = NODES.map(() => []);
for (const [a, b, door] of EDGES) {
  const i = NODE_INDEX.get(a)!;
  const j = NODE_INDEX.get(b)!;
  const len = Math.hypot(NODES[i][1] - NODES[j][1], NODES[i][2] - NODES[j][2]);
  ADJ[i].push({ to: j, door, len });
  ADJ[j].push({ to: i, door, len });
}
/** Doors guards can unlock as they pass (and where they stand to do it). */
const GUARD_DOORS: ReadonlyArray<{ id: DoorId; x: number; z: number }> = [
  { id: 'staff', x: -38, z: 3 },
  { id: 'security', x: -35, z: 8 },
  { id: 'cell', x: -38, z: -16 },
];

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class JailEscape {
  readonly layout: JailLayout;
  readonly guards: Guard[] = [];
  readonly events: JailEvent[] = [];
  active = false;
  /** Accessibility assist: clearer route guidance and a modestly wider interaction window. */
  guidedSupport = false;
  setGuidedSupport(enabled: boolean): void { this.guidedSupport = enabled; }
  /** Test-only (set by the QA hook): guards stand still and see nothing. Cleared on every enter(). */
  guardsHeld = false;
  checkpoint = 0;
  readonly items = new Set<string>();
  /** Power cut remaining (s), 0 = power on. */
  powerT = 0;
  securityT = 0;
  /** Fire alarm remaining (s). */
  alarmT = 0;
  yardT = 0;
  yardCool = 0;
  lockdown = false;
  /** Interaction in progress (hold still). */
  task: { id: InteractId; t: number; need: number; x: number; z: number } | null = null;
  /** HUD: strongest suspicion (0..1) and whether a guard is chasing. */
  detect = 0;
  chased = false;
  /** Counters (tests / report). */
  catches = 0;
  readonly camSus: number[] = CAMERAS.map(() => 0);
  private readonly camCool: number[] = CAMERAS.map(() => 0);
  private time = 0;
  private freezeT = 0;
  private readonly doorBase = new Map<DoorId, boolean>();
  private readonly doorHold = new Map<DoorId, number>();
  private readonly ray: RAPIER.Ray;
  private readonly fanMats: MeshBasicMaterial[] = [];
  private readonly fanGeo: CircleGeometry | null = null;
  private readonly v = new Vector3();
  private readonly idle = new Color(0xffd34a);
  private readonly hot = new Color(0xff2a1a);
  private zone: ZoneId | null = null;

  /**
   * `makeGuard` builds a guard model (null = headless: physics only). `scene` receives the jail
   * geometry (null = headless).
   */
  constructor(
    private readonly physics: PhysicsWorld,
    makeGuard: (() => CharacterModel) | null,
    scene: Group | { add(o: unknown): unknown } | null,
  ) {
    this.layout = new JailLayout(physics);
    this.ray = new physics.R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    if (scene) (scene as Group).add(this.layout.group);
    this.layout.group.visible = false;
    if (makeGuard) this.fanGeo = new CircleGeometry(GUARD_RANGE, 22, -GUARD_FOV / 2, GUARD_FOV);
    for (let k = 0; k < GUARDS.length; k++) {
      const ctrl = new CharacterController(physics);
      ctrl.setEnabled(false);
      let model: CharacterModel | null = null;
      let fan: Mesh | null = null;
      if (makeGuard && this.fanGeo) {
        model = makeGuard();
        model.root.name = 'jail-guard';
        model.setGunShown(false);
        model.setVisible(false);
        (scene as Group | null)?.add(model.root);
        const mat = new MeshBasicMaterial({ color: 0xffd34a, transparent: true, opacity: 0.13, depthWrite: false, side: DoubleSide });
        this.fanMats.push(mat);
        fan = new Mesh(this.fanGeo, mat);
        fan.renderOrder = 2;
        fan.visible = false;
        (scene as Group | null)?.add(fan);
      }
      this.guards.push({
        id: k, ctrl, model, fan, state: 'patrol', t: 0, wp: 0, waitT: 0, sus: 0, lx: 0, lz: 0, unseen: 0,
        path: [], pathGoal: -1, pathT: 0, sideT: 0, sideDir: 1, slowT: 0, look: null, stunT: 0,
      });
    }
  }

  guardOnRay(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, range: number): boolean {
    if (!this.active) return false;
    for (const g of this.guards) {
      if (g.stunT > 0) continue;
      const dx = g.ctrl.position.x - origin.x;
      const dy = g.ctrl.position.y + 1.0 - origin.y;
      const dz = g.ctrl.position.z - origin.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (along <= 0 || along >= range) continue;
      const px = dx - dir.x * along;
      const py = dy - dir.y * along;
      const pz = dz - dir.z * along;
      if (px * px + py * py + pz * pz <= 0.7 * 0.7) return true;
    }
    return false;
  }

  hitGuardRay(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, range: number): boolean {
    if (!this.active) return false;
    let hit: Guard | null = null;
    let best = range;
    for (const g of this.guards) {
      if (g.stunT > 0) continue;
      const dx = g.ctrl.position.x - origin.x;
      const dy = g.ctrl.position.y + 1.0 - origin.y;
      const dz = g.ctrl.position.z - origin.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (along <= 0 || along >= best) continue;
      const px = dx - dir.x * along;
      const py = dy - dir.y * along;
      const pz = dz - dir.z * along;
      if (px * px + py * py + pz * pz <= 0.52 * 0.52) { hit = g; best = along; }
    }
    if (!hit) return false;
    hit.stunT = 12;
    hit.state = 'return';
    hit.sus = 0;
    hit.path = [];
    hit.model?.resetPose();
    this.events.push({ type: 'toast', text: 'Guard stopped briefly — keep moving!' });
    return true;
  }

  /** World position of the spawn for checkpoint `n`. */
  spawnFor(n: number): { x: number; y: number; z: number; yaw: number } {
    const s = n >= 1 ? SPAWNS.maintenance : SPAWNS.cell;
    return { x: JAIL_ORIGIN.x + s.x, y: 0.02, z: JAIL_ORIGIN.z + s.z, yaw: s.yaw };
  }

  /** Enter the jail from a save (arrest or a reload while jailed). Returns the spawn. */
  enter(save: JailSave): { x: number; y: number; z: number; yaw: number } {
    this.active = true;
    this.layout.group.visible = true;
    this.items.clear();
    for (const i of save.items) this.items.add(i);
    this.checkpoint = Math.max(0, Math.min(1, save.checkpoint));
    this.catches = 0;
    this.guardsHeld = false;
    this.reset();
    return this.spawnFor(this.checkpoint);
  }

  /** Leave (escaped / bail / quit): guards off, geometry hidden. Colliders stay (outside the city). */
  exit(): void {
    this.active = false;
    this.layout.group.visible = false;
    this.task = null;
    this.events.length = 0;
    for (const g of this.guards) {
      g.ctrl.setEnabled(false);
      g.model?.setVisible(false);
      if (g.fan) g.fan.visible = false;
    }
  }

  save(bail: number): JailSave {
    return { checkpoint: this.checkpoint, bail, items: [...this.items] };
  }

  /** World back to the checkpoint state (also after a capture). */
  private reset(): void {
    this.powerT = 0;
    this.securityT = 0;
    this.alarmT = 0;
    this.yardT = 0;
    this.yardCool = 0;
    this.lockdown = false;
    this.task = null;
    this.detect = 0;
    this.chased = false;
    this.freezeT = 0;
    this.camSus.fill(0);
    this.camCool.fill(0);
    this.doorHold.clear();
    // Getting to the maintenance room means the vent is open.
    this.doorBase.set('cell', false);
    this.doorBase.set('vent', this.checkpoint >= 1);
    this.doorBase.set('staff', false);
    this.doorBase.set('security', false);
    this.doorBase.set('yardGate', false);
    this.doorBase.set('hatch', false);
    this.applyDoors();
    this.layout.keycardMesh.visible = !this.items.has('keycard');
    for (const g of this.guards) {
      const r = GUARDS[g.id].route[0];
      g.ctrl.setEnabled(true);
      g.ctrl.teleport(this.v.set(JAIL_ORIGIN.x + r.x, 0.02, JAIL_ORIGIN.z + r.z), 0);
      g.state = 'patrol';
      g.t = 0;
      g.wp = 0;
      g.waitT = r.wait;
      g.sus = 0;
      g.unseen = 0;
      g.path = [];
      g.pathGoal = -1;
      g.look = null;
      g.stunT = 0;
      g.model?.resetPose();
      g.model?.setVisible(true);
      if (g.fan) g.fan.visible = true;
    }
  }

  private applyDoors(): void {
    for (const id of ['cell', 'vent', 'staff', 'security', 'yardGate', 'hatch'] as DoorId[]) {
      const emergencyRelease = (this.powerT > 0 && (id === 'cell' || id === 'staff' || id === 'security' || id === 'yardGate' || id === 'hatch')) || (this.securityT > 0 && (id === 'cell' || id === 'staff'));
      const open = (this.doorBase.get(id) ?? false) || (this.doorHold.get(id) ?? 0) > 0 || emergencyRelease;
      this.layout.setDoor(id, open);
    }
  }

  // ------------------------------------------------------------------ queries

  /** Open state of every door (tests / QA). */
  doors(): Record<DoorId, boolean> {
    const l = this.layout;
    return { cell: l.isOpen('cell'), vent: l.isOpen('vent'), staff: l.isOpen('staff'), security: l.isOpen('security'), yardGate: l.isOpen('yardGate'), hatch: l.isOpen('hatch') };
  }

  private local(p: { x: number; z: number }): { x: number; z: number } {
    return { x: p.x - JAIL_ORIGIN.x, z: p.z - JAIL_ORIGIN.z };
  }

  zoneOf(p: { x: number; z: number }): ZoneId | null {
    const l = this.local(p);
    return zoneAt(l.x, l.z);
  }

  /** Is the player somewhere (or doing something) a guard / camera reacts to? */
  illegal(zone: ZoneId | null, acting: boolean): boolean {
    if (!zone || zone === 'outside') return false;
    if (acting) return true;
    if (zone === 'cell') return false;
    const free = zone === 'corridor' || zone === 'common' || zone === 'yard';
    if (free && (this.yardT > 0 || this.alarmT > 0)) return false;
    return true;
  }

  /** Clear line between two world points (fixed colliders; bars and characters don't block). */
  private clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, seeBars = true): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    this.ray.origin = { x: ax, y: ay, z: az };
    this.ray.dir = { x: dx / d, y: dy / d, z: dz / d };
    const F = this.physics.R.QueryFilterFlags;
    const hit = this.physics.world.castRay(this.ray, d - 0.05, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_KINEMATIC | F.EXCLUDE_SENSORS, seeBars ? SIGHT_GROUPS : undefined);
    return !hit;
  }

  private canSee(g: Guard, p: JailPlayer): boolean {
    const gx = g.ctrl.position.x;
    const gz = g.ctrl.position.z;
    const dx = p.x - gx;
    const dz = p.z - gz;
    const d = Math.hypot(dx, dz);
    const range = p.crouched ? GUARD_RANGE_CROUCHED : GUARD_RANGE;
    if (d > range) return false;
    // Very close: noticed whatever the facing.
    if (d > 1.8 && g.state !== 'chase') {
      const fwd = g.ctrl.yaw;
      if (Math.abs(wrap(Math.atan2(dx, dz) - fwd)) > GUARD_FOV / 2) return false;
    }
    return this.clear(gx, g.ctrl.position.y + 1.6, gz, p.x, p.y + (p.crouched ? 0.6 : 1.1), p.z);
  }

  /** Current sweep yaw of camera k. */
  cameraYaw(k: number): number {
    const c = CAMERAS[k];
    return c.yaw + Math.sin((this.time / c.period) * Math.PI * 2) * c.sweep;
  }

  private cameraSees(k: number, p: JailPlayer): boolean {
    const c = CAMERAS[k];
    const cx = JAIL_ORIGIN.x + c.x;
    const cz = JAIL_ORIGIN.z + c.z;
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d = Math.hypot(dx, dz);
    if (d > CAMERA_RANGE || d < 0.5) return false;
    if (Math.abs(wrap(Math.atan2(dx, dz) - this.cameraYaw(k))) > CAMERA_FOV / 2) return false;
    return this.clear(cx, c.y - 0.2, cz, p.x, p.y + (p.crouched ? 0.6 : 1.1), p.z);
  }

  // ------------------------------------------------------------------ interactions

  private nearInteract(p: JailPlayer): InteractId | null {
    const l = this.local(p);
    let best: InteractId | null = null;
    let bd = Infinity;
    for (const it of INTERACTS) {
      const d = Math.hypot(l.x - it.x, l.z - it.z);
      if (d <= it.r && d < bd && this.available(it.id, l.x)) {
        best = it.id;
        bd = d;
      }
    }
    return best;
  }

  private available(id: InteractId, lx: number): boolean {
    switch (id) {
      case 'cellDoor':
        return lx < -38 && !this.layout.isOpen('cell');
      case 'vent':
        return lx > -44 && !this.layout.isOpen('vent');
      case 'phone':
        return true;
      case 'staffDoor':
        return !this.layout.isOpen('staff');
      case 'keycard':
        return !this.items.has('keycard');
      case 'securityDoor':
        return !this.layout.isOpen('security');
      case 'emergency':
        return this.securityT <= 0 && this.powerT <= 0;
      case 'breaker':
        return this.powerT <= 0;
      case 'hatch':
        return !this.layout.isOpen('hatch');
      case 'alarm':
        return this.alarmT <= 0;
    }
  }

  /** Prompt for the player's position: text + short touch label, or null. */
  prompt(p: JailPlayer, ctx: JailContext): { text: string; touch: string } | null {
    if (!this.active || this.freezeT > 0) return null;
    if (this.task) {
      const pct = Math.round((this.task.t / this.task.need) * 100);
      const what: Partial<Record<InteractId, string>> = { vent: 'Unscrewing the vent', hatch: 'Prying the hatch', emergency: 'Cutting the camera circuit', breaker: 'Tripping the maintenance breaker', keycard: 'Taking the keycard', alarm: 'Pulling the alarm' };
      return { text: `${what[this.task.id] ?? 'Working'}… ${pct}% (hold still)`, touch: `${pct}%` };
    }
    const id = this.nearInteract(p);
    if (!id) return null;
    const l = this.local(p);
    switch (id) {
      case 'cellDoor':
        if (this.yardCool > 0) return { text: `Guard: "Not now." (${Math.ceil(this.yardCool)} s)`, touch: 'Wait' };
        return { text: 'Call the guard for yard time', touch: 'Call' };
      case 'vent':
        return { text: 'Unscrew the vent cover', touch: 'Vent' };
      case 'phone':
        return ctx.credits >= ctx.bail
          ? { text: `Call your lawyer: post bail (${ctx.bail.toLocaleString('en-US')} cr)`, touch: 'Bail' }
          : { text: `Bail is ${ctx.bail.toLocaleString('en-US')} cr: not enough credits`, touch: 'Bail' };
      case 'staffDoor':
        if (l.x < -38) return { text: 'Open the staff door', touch: 'Open' };
        return this.items.has('keycard') ? { text: 'Swipe the keycard: staff door', touch: 'Card' } : { text: 'Staff door: locked', touch: 'Locked' };
      case 'keycard':
        return { text: 'Take the keycard', touch: 'Take' };
      case 'securityDoor':
        return this.items.has('keycard') ? { text: 'Swipe the keycard: security door', touch: 'Card' } : { text: 'Security door: keycard required', touch: 'Locked' };
      case 'emergency':
        return { text: `Cell emergency cutoff: cameras off, cell/staff route open (${EMERGENCY_TIME} s) — reach the maintenance breaker`, touch: 'Cut cameras' };
      case 'breaker':
        return { text: 'Maintenance breaker: cameras and security locks off, yard gate open (150 s)', touch: 'Power' };
      case 'hatch':
        return { text: 'Pry open the drain hatch', touch: 'Hatch' };
      case 'alarm':
        return { text: 'Pull the fire alarm', touch: 'Alarm' };
    }
  }

  /** Interact button. Returns true when something happened (the Game skips its own handling). */
  interact(p: JailPlayer, ctx: JailContext): boolean {
    if (!this.active || this.freezeT > 0 || this.task) return this.active;
    const id = this.nearInteract(p);
    if (!id) return false;
    const l = this.local(p);
    if (id === 'phone') {
      if (ctx.credits >= ctx.bail) this.events.push({ type: 'bail' });
      else this.events.push({ type: 'toast', text: `Bail is ${ctx.bail.toLocaleString('en-US')} cr` });
      return true;
    }
    if (id === 'cellDoor') {
      if (this.yardCool > 0 || this.lockdown) return true;
      const g = this.guards[0];
      g.state = 'escort';
      g.t = 0;
      g.path = [];
      this.yardCool = YARD_COOLDOWN + YARD_TIME;
      this.events.push({ type: 'toast', text: 'The guard is coming to open your cell' });
      return true;
    }
    if (id === 'staffDoor') {
      if (l.x < -38 || this.items.has('keycard')) this.doorBase.set('staff', true);
      return true;
    }
    if (id === 'securityDoor') {
      if (this.items.has('keycard')) this.doorBase.set('security', true);
      return true;
    }
    const baseNeed = TASK_TIME[id] ?? 0;
    const need = this.guidedSupport ? baseNeed * 0.72 : baseNeed;
    this.task = { id, t: 0, need, x: l.x, z: l.z };
    return true;
  }

  private finishTask(id: InteractId): void {
    switch (id) {
      case 'vent':
        this.doorBase.set('vent', true);
        break;
      case 'hatch':
        this.doorBase.set('hatch', true);
        break;
      case 'keycard':
        this.items.add('keycard');
        this.layout.keycardMesh.visible = false;
        this.events.push({ type: 'item', id: 'keycard' });
        this.events.push({ type: 'toast', text: 'Keycard: opens the staff and security doors' });
        break;
      case 'emergency':
        this.securityT = EMERGENCY_TIME;
        this.events.push({ type: 'toast', text: `Emergency circuit cut: cameras off and staff route open for ${EMERGENCY_TIME} seconds. Reach the maintenance breaker.` });
        break;
      case 'breaker':
        this.powerT = POWER_TIME;
        this.securityT = 0;
        this.events.push({ type: 'toast', text: 'Maintenance power cut: security locks and yard gate open for 150 seconds' });
        break;
      case 'alarm':
        this.alarmT = ALARM_GATE_TIME;
        this.events.push({ type: 'toast', text: 'Fire alarm! Guards respond, yard gate opens' });
        for (const g of this.guards) this.investigate(g, CAMERAS[0].x, CAMERAS[0].z + 2);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ simulation

  fixedUpdate(dt: number, p: JailPlayer): void {
    if (!this.active) return;
    this.time += dt;
    for (const g of this.guards) {
      g.ctrl.prevPosition.copy(g.ctrl.position);
      g.ctrl.prevYaw = g.ctrl.yaw;
    }
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      for (const g of this.guards) g.ctrl.step(dt, 0, 0, false, false);
      return;
    }
    const l = this.local(p);
    const zone = zoneAt(l.x, l.z);
    if (zone !== this.zone) {
      this.zone = zone;
      if (zone === 'maintenance' && this.checkpoint < 1) {
        this.checkpoint = 1;
        this.events.push({ type: 'checkpoint', n: 1 });
      }
    }

    // Exits.
    for (const e of EXITS) {
      if (l.x >= e.x0 && l.x <= e.x1 && l.z >= e.z0 && l.z <= e.z1) {
        this.events.push({ type: 'escaped', route: e.id });
        this.active = false;
        return;
      }
    }

    // Task progress (hold still near the spot).
    if (this.task) {
      if (Math.hypot(l.x - this.task.x, l.z - this.task.z) > 0.6) this.task = null;
      else {
        this.task.t += dt;
        if (this.task.t >= this.task.need) {
          const id = this.task.id;
          this.task = null;
          this.finishTask(id);
        }
      }
    }
    const acting = this.task !== null;

    // Timers.
    if (this.powerT > 0) {
      const before = this.powerT;
      this.powerT = Math.max(0, this.powerT - dt);
      if (before > POWER_TIME - POWER_INVESTIGATE && this.powerT <= POWER_TIME - POWER_INVESTIGATE) {
        const g = this.guards[0];
        if (g.state !== 'chase') this.investigate(g, -44.6, 5);
      }
      if (this.powerT === 0) this.events.push({ type: 'toast', text: 'Power restored' });
    }
    if (this.securityT > 0) {
      this.securityT = Math.max(0, this.securityT - dt);
      if (this.securityT === 0) this.events.push({ type: 'toast', text: 'Emergency circuit reset: cameras and staff locks are back on' });
    }
    if (this.alarmT > 0) this.alarmT = Math.max(0, this.alarmT - dt);
    if (this.yardCool > 0) this.yardCool = Math.max(0, this.yardCool - dt);
    if (this.yardT > 0) {
      this.yardT = Math.max(0, this.yardT - dt);
      if (this.yardT === 0) {
        if (zone !== 'cell') {
          this.lockdown = true;
          this.events.push({ type: 'toast', text: 'Yard time is over: lockdown' });
        }
      }
    }
    // Back in the cell after yard time: the door is locked again.
    if (this.yardT === 0 && this.doorBase.get('cell') && zone === 'cell' && l.x < -39) {
      this.doorBase.set('cell', false);
      if (this.lockdown) this.events.push({ type: 'toast', text: 'Back in your cell' });
      this.lockdown = false;
    }

    // Doors: base state (+ electric yard gate) and guards passing through.
    this.doorBase.set('yardGate', this.powerT > 0 || this.alarmT > 0);
    for (const [id, t] of this.doorHold) this.doorHold.set(id, Math.max(0, t - dt));
    for (const g of this.guards) {
      if (g.path.length < 2) continue;
      const a = g.path[0];
      const b = g.path[1];
      const e = ADJ[a].find((x) => x.to === b);
      if (!e?.door) continue;
      const d = GUARD_DOORS.find((x) => x.id === e.door);
      if (d && Math.hypot(g.ctrl.position.x - (JAIL_ORIGIN.x + d.x), g.ctrl.position.z - (JAIL_ORIGIN.z + d.z)) < 2.6) this.doorHold.set(d.id, 1.2);
    }
    // Don't close a door on somebody standing in it.
    for (const d of GUARD_DOORS) {
      if ((this.doorHold.get(d.id) ?? 0) > 0 || this.doorBase.get(d.id)) continue;
      if (!this.layout.isOpen(d.id)) continue;
      const wx = JAIL_ORIGIN.x + d.x;
      const wz = JAIL_ORIGIN.z + d.z;
      let blocked = Math.hypot(p.x - wx, p.z - wz) < 0.9;
      for (const g of this.guards) if (Math.hypot(g.ctrl.position.x - wx, g.ctrl.position.z - wz) < 0.9) blocked = true;
      if (blocked) this.doorHold.set(d.id, 0.3);
    }
    this.applyDoors();

    // Cameras.
    const bad = this.illegal(zone, acting);
    for (let k = 0; k < CAMERAS.length; k++) {
      if (this.camCool[k] > 0) this.camCool[k] -= dt;
      const sees = this.powerT <= 0 && this.securityT <= 0 && bad && this.cameraSees(k, p);
      this.camSus[k] = sees ? Math.min(1, this.camSus[k] + dt / (CAMERA_TIME * (this.guidedSupport ? 1.65 : 1))) : Math.max(0, this.camSus[k] - dt * 0.5);
      if (this.camSus[k] >= 1 && this.camCool[k] <= 0) {
        this.camCool[k] = 6;
        this.camSus[k] = 0.6;
        this.events.push({ type: 'toast', text: 'A security camera spotted you' });
        this.events.push({ type: 'spotted' });
        // The two nearest guards come to look.
        const order = [...this.guards].sort((a, b) => Math.hypot(a.ctrl.position.x - p.x, a.ctrl.position.z - p.z) - Math.hypot(b.ctrl.position.x - p.x, b.ctrl.position.z - p.z));
        for (const g of order.slice(0, 2)) if (g.state !== 'chase') this.investigate(g, l.x, l.z);
      }
    }

    // Guards.
    let detect = 0;
    let chased = false;
    for (const g of this.guards) {
      if (g.stunT > 0) {
        g.stunT = Math.max(0, g.stunT - dt);
        g.ctrl.step(dt, 0, 0, false, false);
        continue;
      }
      if (this.guardsHeld) continue;
      g.t += dt;
      const sees = this.canSee(g, p);
      if (sees) {
        g.lx = l.x;
        g.lz = l.z;
      }
      if (g.state !== 'chase') {
        if (sees && bad) {
          const d = Math.hypot(p.x - g.ctrl.position.x, p.z - g.ctrl.position.z);
          const rate = (1 / SUSPICION_TIME) * (d < 5 ? 1.6 : d < 9 ? 1 : 0.6) * (this.guidedSupport ? 0.78 : 1);
          g.sus = Math.min(1, g.sus + rate * dt);
          g.look = Math.atan2(p.x - g.ctrl.position.x, p.z - g.ctrl.position.z);
          if (g.sus >= 1) {
            g.state = 'chase';
            g.t = 0;
            g.unseen = 0;
            g.path = [];
            this.events.push({ type: 'spotted' });
          }
        } else {
          g.sus = Math.max(0, g.sus - dt * 0.35);
          if (g.sus === 0) g.look = null;
        }
      }
      if (g.state === 'chase') {
        chased = true;
        g.sus = 1;
        if (sees) g.unseen = 0;
        else g.unseen += dt;
        // The player went back to the cell (not acting) → the guard lets it go.
        const safe = !bad;
        if (g.unseen > LOSE_TIME || safe) {
          g.state = safe ? 'return' : 'search';
          g.t = 0;
          g.waitT = SEARCH_TIME;
          g.path = [];
          g.sus = safe ? 0 : 0.6;
        } else if (Math.hypot(p.x - g.ctrl.position.x, p.z - g.ctrl.position.z) < CATCH_DIST && Math.abs(p.y - g.ctrl.position.y) < 1) {
          this.caught();
          return;
        }
      }
      detect = Math.max(detect, g.sus);
      this.stepGuard(g, dt, p, sees);
    }
    for (const s of this.camSus) detect = Math.max(detect, s * 0.9);
    this.detect = detect;
    this.chased = chased;
  }

  private investigate(g: Guard, lx: number, lz: number): void {
    g.state = 'investigate';
    g.t = 0;
    g.lx = lx;
    g.lz = lz;
    g.path = [];
    g.waitT = 4;
  }

  private caught(): void {
    this.catches++;
    this.events.push({ type: 'caught', checkpoint: this.checkpoint });
    this.reset();
    this.freezeT = 1.0;
  }

  private stepGuard(g: Guard, dt: number, p: JailPlayer, sees: boolean): void {
    const def = GUARDS[g.id];
    let tx = g.ctrl.position.x;
    let tz = g.ctrl.position.z;
    let run = false;
    let mag = 0.62;
    let stop = 0.35;
    switch (g.state) {
      case 'patrol': {
        const w = def.route[g.wp];
        tx = JAIL_ORIGIN.x + w.x;
        tz = JAIL_ORIGIN.z + w.z;
        if (Math.hypot(tx - g.ctrl.position.x, tz - g.ctrl.position.z) < 0.6) {
          g.waitT -= dt;
          if (g.waitT <= 0) {
            g.wp = (g.wp + 1) % def.route.length;
            g.waitT = def.route[g.wp].wait;
            g.path = [];
          }
        }
        break;
      }
      case 'chase':
        if (sees) {
          tx = p.x;
          tz = p.z;
        } else {
          tx = JAIL_ORIGIN.x + g.lx;
          tz = JAIL_ORIGIN.z + g.lz;
        }
        run = true;
        mag = CHASE_MAG;
        stop = 0.2;
        break;
      case 'search':
      case 'investigate': {
        tx = JAIL_ORIGIN.x + g.lx;
        tz = JAIL_ORIGIN.z + g.lz;
        run = g.state === 'investigate' && g.t < 8;
        mag = run ? 0.7 : 0.6;
        stop = 1.2;
        const reached = Math.hypot(tx - g.ctrl.position.x, tz - g.ctrl.position.z) < 2.2;
        if (reached || g.t > 25) {
          g.waitT -= dt;
          g.look = g.ctrl.yaw + Math.sin(g.t * 1.3) * 0.8;
          if (g.waitT <= 0 || g.t > 30) {
            g.state = 'return';
            g.t = 0;
            g.path = [];
            g.look = null;
          }
        }
        break;
      }
      case 'return': {
        const w = def.route[g.wp];
        tx = JAIL_ORIGIN.x + w.x;
        tz = JAIL_ORIGIN.z + w.z;
        if (Math.hypot(tx - g.ctrl.position.x, tz - g.ctrl.position.z) < 0.8) {
          g.state = 'patrol';
          g.t = 0;
          g.path = [];
        }
        break;
      }
      case 'escort': {
        // Walk to the cell door, open it, start yard time.
        tx = JAIL_ORIGIN.x - 36.4;
        tz = JAIL_ORIGIN.z - 16;
        if (Math.hypot(tx - g.ctrl.position.x, tz - g.ctrl.position.z) < 0.7 || g.t > 25) {
          g.look = -Math.PI / 2;
          if (!this.doorBase.get('cell')) {
            this.doorBase.set('cell', true);
            this.yardT = YARD_TIME;
            this.events.push({ type: 'toast', text: `Yard time: corridor, common room and yard for ${YARD_TIME} s` });
          }
          if (g.t > 2 || this.doorBase.get('cell')) {
            g.state = 'return';
            g.t = 0;
            g.path = [];
            g.look = null;
          }
        }
        break;
      }
    }
    this.moveGuard(g, tx, tz, run, mag, stop, dt);
  }

  private nearestNode(x: number, z: number): number {
    const order = NODES.map((n, i) => ({ i, d: Math.hypot(JAIL_ORIGIN.x + n[1] - x, JAIL_ORIGIN.z + n[2] - z) })).sort((a, b) => a.d - b.d);
    for (const o of order.slice(0, 5)) {
      const n = NODES[o.i];
      if (this.clear(x, 1, z, JAIL_ORIGIN.x + n[1], 1, JAIL_ORIGIN.z + n[2], false)) return o.i;
    }
    return order[0].i;
  }

  /** Dijkstra over the room graph. */
  private route(a: number, b: number): number[] {
    const n = NODES.length;
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === b) break;
      done[u] = true;
      for (const e of ADJ[u]) {
        const nd = dist[u] + e.len;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
        }
      }
    }
    if (dist[b] === Infinity) return [];
    const out: number[] = [];
    for (let u = b; u >= 0; u = prev[u]) out.unshift(u);
    return out;
  }

  private moveGuard(g: Guard, tx: number, tz: number, run: boolean, mag: number, stop: number, dt: number): void {
    const c = g.ctrl;
    let gx = tx;
    let gz = tz;
    const direct = Math.hypot(tx - c.position.x, tz - c.position.z) < 1.2 || this.clear(c.position.x, 1, c.position.z, tx, 1, tz, false);
    if (direct) g.path = [];
    else {
      g.pathT -= dt;
      if (!g.path.length || g.pathT <= 0) {
        const goal = this.nearestNode(tx, tz);
        g.path = this.route(this.nearestNode(c.position.x, c.position.z), goal);
        g.pathGoal = goal;
        g.pathT = 1.5;
      }
      while (g.path.length) {
        const n = NODES[g.path[0]];
        const nx = JAIL_ORIGIN.x + n[1];
        const nz = JAIL_ORIGIN.z + n[2];
        if (Math.hypot(nx - c.position.x, nz - c.position.z) < 0.7 && g.path.length > 1) g.path.shift();
        else {
          gx = nx;
          gz = nz;
          break;
        }
      }
      stop = Math.min(stop, 0.3);
    }
    let dx = gx - c.position.x;
    let dz = gz - c.position.z;
    const d = Math.hypot(dx, dz);
    let mx = 0;
    let mz = 0;
    if (d > stop) {
      dx /= d;
      dz /= d;
      const m = Math.min(mag, (d - stop) / 0.8 + 0.2);
      if (g.sideT > 0) {
        g.sideT -= dt;
        mx = (dx * 0.4 - dz * g.sideDir) * m;
        mz = (dz * 0.4 + dx * g.sideDir) * m;
      } else {
        mx = dx * m;
        mz = dz * m;
      }
      if (c.actualSpeed < 0.3 && g.t > 0.6) g.slowT += dt;
      else g.slowT = Math.max(0, g.slowT - dt);
      if (g.slowT > 0.6) {
        g.slowT = 0;
        g.sideT = 0.7;
        g.sideDir = -g.sideDir;
      }
    }
    c.faceYaw = mx === 0 && mz === 0 && g.look !== null ? g.look : g.sus > 0.05 && g.state !== 'chase' && g.look !== null ? g.look : null;
    if (g.sus > 0.05 && g.state !== 'chase') {
      // Suspicious: stop and stare.
      mx *= 0.15;
      mz *= 0.15;
    }
    c.step(dt, mx, mz, run, false);
  }

  // ------------------------------------------------------------------ rendering

  render(alpha: number, dt: number): void {
    if (!this.active && !this.layout.group.visible) return;
    for (let k = 0; k < CAMERAS.length; k++) {
      const on = this.powerT <= 0 && this.securityT <= 0;
      this.layout.aimSecurityCamera(k, this.cameraYaw(k), on);
      this.layout.setFanColor(k, this.camSus[k]);
    }
    const flash = this.alarmT > 0 && Math.floor(this.time * 4) % 2 === 0;
    this.layout.alarmLight.color.setHex(flash ? 0xff2020 : 0x701010);
    this.layout.breakerLever.rotation.z = this.powerT > 0 ? 1.2 : 0;
    this.layout.emergencyLever.rotation.z = this.securityT > 0 ? -1.1 : 0;
    this.layout.setPower(this.powerT <= 0 && this.securityT <= 0);
    for (let i = 0; i < this.guards.length; i++) {
      const g = this.guards[i];
      const m = g.model;
      if (!m) continue;
      const c = g.ctrl;
      m.root.position.lerpVectors(c.prevPosition, c.position, alpha);
      const yaw = c.prevYaw + wrap(c.yaw - c.prevYaw) * alpha;
      m.root.rotation.set(0, yaw, 0);
      m.overlay.lowReady = g.state === 'chase' ? 0 : 0.25;
      m.update(dt, c.actualSpeed, c.turnSpeed, false);
      if (g.fan) {
        g.fan.position.set(m.root.position.x, 0.04, m.root.position.z);
        g.fan.rotation.set(-Math.PI / 2, yaw - Math.PI / 2, 0, 'YXZ');
        this.fanMats[i].color.copy(this.idle).lerp(this.hot, g.sus);
        this.fanMats[i].opacity = 0.1 + g.sus * 0.15;
      }
    }
  }

  /** Objective lines for the HUD. */
  objectives(ctx: JailContext): { title: string; lines: string[] } {
    const lines: string[] = [];
    if (this.chased) lines.push(this.guidedSupport ? 'A guard is searching for you: break line of sight, then move to cover' : 'A guard is after you: break line of sight');
    if (this.lockdown) lines.push('Lockdown: get back to your cell or get out');
    if (this.yardT > 0) lines.push(`Yard time ${Math.ceil(this.yardT)} s (corridor, common room, yard)`);
    if (this.securityT > 0) lines.push(`Camera circuit down ${Math.ceil(this.securityT)} s: cell and staff route open — reach the maintenance breaker`);
    if (this.powerT > 0) lines.push(`Maintenance power ${Math.ceil(this.powerT)} s: security route and yard gate open, cameras off`);
    if (this.alarmT > 0) lines.push(`Fire alarm ${Math.ceil(this.alarmT)} s: yard gate open`);
    if (this.items.has('keycard')) lines.push('Keycard: security door → front gate');
    if (this.checkpoint >= 1 && !this.items.has('keycard')) lines.push('Maintenance: cut the power or pry the drain hatch');
    if (this.checkpoint === 0 && lines.length === 0) {
      lines.push(`Route: cut cameras at the cell panel (${EMERGENCY_TIME} s), reach the maintenance breaker, then run for the yard gate.`);
      lines.push('Use E at panels. 1 draws the sidearm; Q/right mouse aims; Z/left click fires. T toggles the torch.');
      lines.push(this.guidedSupport ? 'Alternative: vent behind your bunk → maintenance hatch or breaker; you can also use the office keycard.' : 'Alternative: vent behind your bunk, yard time, or the office keycard.');
    }
    lines.push('Controls: 1/touch Gun · Q or right mouse aim · Z or left click fire · R reload · T torch');
    lines.push(`Bail by phone: ${ctx.bail.toLocaleString('en-US')} cr`);
    return { title: 'Escape the county jail', lines };
  }

  dispose(): void {
    for (const g of this.guards) {
      g.ctrl.dispose();
      g.model?.root.removeFromParent();
      g.model?.dispose();
      g.fan?.removeFromParent();
    }
    this.fanGeo?.dispose();
    for (const m of this.fanMats) m.dispose();
    this.layout.dispose();
  }
}
