/**
 * Headless arrest + jail test: the arrest state machine (pure), then the jail escape with real physics —
 * a character controller walks / crawls through the jail's colliders while real guards (character
 * controllers on their patrol routes) look for it. Usage: npm run test:jail
 */
declare const process: { exit(code: number): never };
import { Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { CharacterController } from '../src/game/character/CharacterController';
import { ArrestSequence, CUFF_TIME, ESCORT_MAX, EXIT_FORCE, SURRENDER_MAX, SURRENDER_MIN, TRANSFER_MAX, TRANSFER_MIN, type ArrestSummary } from '../src/game/police/Arrest';
import { ALARM_GATE_TIME, JailEscape, POWER_TIME, YARD_TIME, type JailEvent, type JailPlayer } from '../src/game/jail/JailEscape';
import { JAIL_ORIGIN } from '../src/game/jail/JailLayout';

const stateOf = (g: { state: string }): string => g.state;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------------------------- arrest FSM
console.log('--- arrest state machine');
{
  const sum: ArrestSummary = { stars: 2, fine: 500, vehicle: { kind: 'own', name: 'Coupe', fee: 1000 }, bail: 1500 };
  const a = new ArrestSequence();
  const steps = (s: number, inp: Partial<{ inCar: boolean; officerDist: number; atDoor: boolean; skip: boolean }>): void => {
    for (let i = 0; i < Math.round(s / FIXED_DT); i++) a.step(FIXED_DT, { inCar: false, officerDist: Infinity, atDoor: false, skip: false, ...inp });
  };
  check('starts idle', a.phase === 'idle' && !a.active);
  check('begin() from idle', a.begin(sum) && a.phase === 'surrender' && a.started === 1);
  check('second begin() while running is refused (no retrigger)', !a.begin(sum) && a.refused === 1 && a.started === 1);
  steps(EXIT_FORCE + 0.05, { inCar: true });
  check('in a car: forced exit after EXIT_FORCE s', a.events.includes('forceExit') && a.phase === 'surrender');
  a.events.length = 0;
  steps(0.5, { inCar: false, officerDist: 5 });
  check('out of the car, officer still far: surrender continues', a.phase === 'surrender');
  steps(FIXED_DT, { officerDist: 1.5 });
  check('officer at arm\'s length, but hands up for less than SURRENDER_MIN: not yet', a.phase === 'surrender');
  steps(SURRENDER_MIN - 0.5, { officerDist: 1.5 });
  check('officer at arm\'s length, hands up SURRENDER_MIN s → cuffed', a.phase === 'cuffed' && a.events.includes('cuffed'));
  steps(CUFF_TIME + 0.05, {});
  check('after the cuffs → escort', a.phase === 'escort');
  steps(1, {});
  steps(FIXED_DT, { atDoor: true });
  check('at the car door → transfer', a.phase === 'transfer');
  steps(TRANSFER_MIN / 2, { skip: true });
  check('skip ignored before TRANSFER_MIN', a.phase === 'transfer');
  steps(TRANSFER_MIN, { skip: true });
  check('skip after TRANSFER_MIN → done', a.phase === 'done');
  steps(5, {});
  check('done is terminal until reset()', a.phase === 'done');
  a.reset();
  check('reset → idle, summary cleared', a.phase === 'idle' && a.summary === null);

  // On foot with an officer already at arm's length: the hands-up still lasts SURRENDER_MIN.
  const d = new ArrestSequence();
  d.begin(sum);
  let tf = 0;
  while (d.phase === 'surrender' && tf < 10) {
    d.step(FIXED_DT, { inCar: false, officerDist: 1.0, atDoor: false, skip: false });
    tf += FIXED_DT;
  }
  check(`officer already close on foot: surrender held ${tf.toFixed(2)} s ≥ SURRENDER_MIN`, d.phase === 'cuffed' && tf >= SURRENDER_MIN - 1e-6 && tf < SURRENDER_MIN + 0.05);

  // Worst cases: every phase times out on its own.
  const b = new ArrestSequence();
  b.begin(sum);
  let t = 0;
  while (b.phase !== 'done' && t < 60) {
    b.step(FIXED_DT, { inCar: true, officerDist: Infinity, atDoor: false, skip: false });
    t += FIXED_DT;
  }
  check(`stuck in the car (can't exit): still ends (${t.toFixed(1)} s)`, b.phase === 'done' && t <= SURRENDER_MAX + TRANSFER_MAX + 0.2);
  const c = new ArrestSequence();
  c.begin(sum);
  t = 0;
  while (c.phase !== 'done' && t < 60) {
    c.step(FIXED_DT, { inCar: false, officerDist: Infinity, atDoor: false, skip: false });
    t += FIXED_DT;
  }
  check(`no officer ever arrives, door never reached: still ends (${t.toFixed(1)} s)`, c.phase === 'done' && t <= SURRENDER_MAX + CUFF_TIME + ESCORT_MAX + TRANSFER_MAX + 0.3);
}

// ---------------------------------------------------------------------------------------------- jail
console.log('--- jail escape (real physics)');
const physics = await PhysicsWorld.create();
physics.addGround(800);
const jail = new JailEscape(physics, null, null);
const player = new CharacterController(physics);
physics.step();
const P = (): JailPlayer => ({ x: player.position.x, y: player.position.y, z: player.position.z, crouched: player.crouched, speed: player.actualSpeed });
const ctx = { credits: 0, bail: 1500 };
const log: JailEvent[] = [];
const L = (): { x: number; z: number } => ({ x: player.position.x - JAIL_ORIGIN.x, z: player.position.z - JAIL_ORIGIN.z });
const v = new Vector3();

function tick(mx = 0, mz = 0, run = false): void {
  player.step(FIXED_DT, mx, mz, run, false);
  jail.fixedUpdate(FIXED_DT, P());
  physics.step();
  for (const e of jail.events) log.push(e);
  jail.events.length = 0;
}
function idle(s: number): void {
  for (let i = 0; i < Math.round(s / FIXED_DT); i++) tick();
}
/** Walk (local coordinates) through `pts`; returns true when the last point was reached. */
function walk(pts: Array<[number, number]>, opts: { run?: boolean; max?: number; until?: () => boolean } = {}): boolean {
  let t = 0;
  for (const [x, z] of pts) {
    for (;;) {
      const l = L();
      const dx = x - l.x;
      const dz = z - l.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) break;
      if (opts.until?.()) return false;
      if (t > (opts.max ?? 60)) return false;
      tick(dx / d, dz / d, opts.run ?? false);
      t += FIXED_DT;
    }
  }
  return true;
}
function place(lx: number, lz: number, yaw = 0): void {
  player.setCrouch(false);
  player.teleport(v.set(JAIL_ORIGIN.x + lx, 0.02, JAIL_ORIGIN.z + lz), yaw);
  physics.step();
}
/** Park the guards far away (in the yard corner, out of everybody's sight) for tests of the geometry. */
function parkGuards(): void {
  for (const g of jail.guards) {
    g.ctrl.teleport(v.set(JAIL_ORIGIN.x + 38, 0.02, JAIL_ORIGIN.z + 20), 0);
    g.state = 'patrol';
    g.sus = 0;
  }
}
function interactHold(): boolean {
  const ok = jail.interact(P(), ctx);
  idle(4.5);
  return ok;
}

{
  const spawn = jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  check('enter: spawn in the cell', Math.abs(spawn.x - (JAIL_ORIGIN.x - 41.6)) < 0.01 && jail.active && jail.zoneOf(spawn) === 'cell');
  player.teleport(v.set(spawn.x, spawn.y, spawn.z), spawn.yaw);
  physics.step();
  idle(0.5);
  check('guards spawned on their routes (3 real controllers)', jail.guards.length === 3 && jail.guards.every((g) => g.ctrl.isEnabled));
  // The cell door is closed: walking east is stopped at the bars.
  parkGuards();
  walk([[-36, -16]], { max: 3 });
  check('closed cell door blocks the way out', L().x < -38.2, `x ${L().x.toFixed(2)}`);
  // The vent is closed: walking into the back wall stops.
  place(-42, -16, -Math.PI / 2);
  walk([[-45, -16]], { max: 3 });
  check('closed vent: the back wall blocks', L().x > -43.9, `x ${L().x.toFixed(2)}`);
  check('prompt at the vent', jail.prompt(P(), ctx)?.text.includes('vent') === true, jail.prompt(P(), ctx)?.text);
  check('unscrewing the vent takes 3 s holding still', interactHold() && jail.doors().vent);
  // Standing: can't get into the 1.2 m duct. Crouched: through it.
  walk([[-45, -16]], { max: 3 });
  check('standing: the vent opening / duct ceiling stops the player', L().x > -44.3, `x ${L().x.toFixed(2)}`);
  check('crouch works', player.setCrouch(true) && player.crouched);
  const inDuct = walk([[-45, -16], [-45, -3]], { max: 40 });
  check('crouched: crawl through the vent and the duct', inDuct && jail.zoneOf(P()) === 'duct', `at ${L().x.toFixed(1)},${L().z.toFixed(1)}`);
  check('can\'t stand up under the duct ceiling', !player.setCrouch(false) && player.crouched);
  log.length = 0;
  walk([[-45, -0.5], [-42.5, 1.5]], { max: 15 });
  check('reached the maintenance room → checkpoint 1', jail.checkpoint === 1 && log.some((e) => e.type === 'checkpoint' && e.n === 1));
  check('stand up again outside the duct', player.setCrouch(false) && !player.crouched);
}

{
  console.log('--- breaker: power cut opens the yard gate, cameras off');
  parkGuards();
  place(-45, 5, -Math.PI / 2);
  check('breaker prompt', jail.prompt(P(), ctx)?.text.includes('Maintenance breaker') === true);
  interactHold();
  check('power cut, yard gate open', jail.powerT > 0 && jail.doors().yardGate, `power ${jail.powerT.toFixed(1)}`);
  // Stand in the maintenance camera's view (restricted room) for 9 s: nothing while the power is off.
  place(-43, 4, 0);
  log.length = 0;
  idle(9);
  check('cameras off during the power cut: 9 s in view, not spotted', !log.some((e) => e.type === 'spotted') && jail.camSus.every((s) => s === 0));
  idle(POWER_TIME);
  check('power comes back on its own; gate shuts', jail.powerT === 0 && !jail.doors().yardGate);
}

{
  console.log('--- maintenance route: drain hatch + tunnel');
  parkGuards();
  place(-45, 7.0, 0);
  interactHold();
  check('hatch pried open (4 s)', jail.doors().hatch);
  log.length = 0;
  walk([[-45, 9]], { max: 4 });
  check('standing: the tunnel ceiling stops the player', L().z < 8.3, `z ${L().z.toFixed(2)}`);
  player.setCrouch(true);
  walk([[-45, 23]], { max: 30 });
  check('crawl the tunnel under the wall → escaped (tunnel)', log.some((e) => e.type === 'escaped' && e.route === 'tunnel') && !jail.active);
}

{
  console.log('--- capture + checkpoint');
  jail.enter({ checkpoint: 1, bail: 1500, items: [] });
  const s = jail.spawnFor(1);
  check('checkpoint 1 save → spawn in the maintenance room, vent open', jail.zoneOf(s) === 'maintenance' && jail.doors().vent && !jail.doors().hatch);
  // Walk into the office in front of the office guard (restricted).
  const g = jail.guards[1];
  g.ctrl.teleport(v.set(JAIL_ORIGIN.x - 21.5, 0.02, JAIL_ORIGIN.z - 12), -Math.PI / 2);
  place(-28, -12, Math.PI / 2);
  log.length = 0;
  let t = 0;
  while (stateOf(g) !== 'chase' && t < 3) {
    tick();
    t += FIXED_DT;
  }
  check(`office guard spots the player in the office and gives chase (${t.toFixed(2)} s)`, stateOf(g) === 'chase' && t > 0.2 && t < 2);
  check('HUD detection at max while chased', jail.detect === 1 && jail.chased);
  t = 0;
  while (!log.some((e) => e.type === 'caught') && t < 10) {
    tick();
    t += FIXED_DT;
  }
  check(`standing still → caught (${t.toFixed(1)} s)`, log.some((e) => e.type === 'caught' && e.checkpoint === 1) && jail.catches === 1);
  check('capture resets the world (guards back on their routes, power on)', jail.powerT === 0 && jail.guards.every((x) => x.state === 'patrol' && x.sus === 0));
  check('still in jail after the capture (respawn, not ejected)', jail.active);
}

{
  console.log('--- guards: legal vs restricted, crouch range, sight through bars, walls block');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  const g = jail.guards[0];
  parkGuards();
  // Player in the cell (legal), guard in front of the bars looking in.
  place(-41, -16, 0);
  g.ctrl.teleport(v.set(JAIL_ORIGIN.x - 35.5, 0.02, JAIL_ORIGIN.z - 16), -Math.PI / 2);
  g.state = 'investigate';
  g.lx = -35.5;
  g.lz = -16;
  g.waitT = 100;
  idle(2);
  check('in the cell, doing nothing: the guard ignores the player', g.sus === 0 && stateOf(g) !== 'chase');
  // Unscrewing the vent in front of the guard: seen through the bars.
  place(-43.3, -16, -Math.PI / 2);
  jail.interact(P(), ctx);
  let t = 0;
  while (stateOf(g) !== 'chase' && t < 3 && jail.task) {
    tick();
    t += FIXED_DT;
  }
  check(`suspicious act seen through the cell bars → chase (${t.toFixed(2)} s)`, stateOf(g) === 'chase', `sus ${g.sus.toFixed(2)}`);
  // The chasing guard opens the cell door and catches the player.
  log.length = 0;
  idle(8);
  check('the guard comes through the cell door and catches the player', log.some((e) => e.type === 'caught'), `guard at ${(g.ctrl.position.x - JAIL_ORIGIN.x).toFixed(1)},${(g.ctrl.position.z - JAIL_ORIGIN.z).toFixed(1)}`);

  // A wall between guard and player: no detection.
  parkGuards();
  place(-28, -15, 0); // office
  g.ctrl.teleport(v.set(JAIL_ORIGIN.x - 35, 0.02, JAIL_ORIGIN.z - 15), Math.PI / 2); // corridor, facing the office wall
  g.state = 'investigate';
  g.lx = -35;
  g.lz = -15;
  g.waitT = 100;
  idle(2);
  check('a wall in between: the guard can\'t see into the office', g.sus === 0 && stateOf(g) !== 'chase');
  // Crouched beyond 7 m in plain view: unseen; standing at the same spot: seen.
  parkGuards();
  place(-20, 3, 0); // common room (restricted outside yard time)
  g.ctrl.teleport(v.set(JAIL_ORIGIN.x - 30, 0.02, JAIL_ORIGIN.z + 3), Math.PI / 2);
  g.state = 'investigate';
  g.lx = -30;
  g.lz = 3;
  g.waitT = 100;
  player.setCrouch(true);
  idle(1.5);
  check('crouched at 10 m: not noticed (crouched sight 7 m)', g.sus === 0, `sus ${g.sus.toFixed(2)}`);
  player.setCrouch(false);
  idle(1.5);
  check('standing at 10 m: noticed', g.sus > 0.5 || stateOf(g) === 'chase', `sus ${g.sus.toFixed(2)} ${g.state}`);
}

{
  console.log('--- yard time + lockdown');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  place(-39, -16, Math.PI / 2);
  check('cell door prompt: yard time', jail.prompt(P(), ctx)?.text.includes('yard') === true);
  jail.interact(P(), ctx);
  const g = jail.guards[0];
  let t = 0;
  while (!jail.doors().cell && t < 30) {
    tick();
    t += FIXED_DT;
  }
  check(`the corridor guard walks over and opens the cell (${t.toFixed(1)} s)`, jail.doors().cell && jail.yardT > YARD_TIME - 1);
  // Walk out into the corridor and the common room in view of the guard: allowed.
  const out = walk([[-36, -16], [-35, -2], [-34, 0], [-20, 0]], { max: 40 });
  check('walk out to the common room during yard time', out && jail.zoneOf(P()) === 'common');
  check('nobody chases during yard time', jail.guards.every((x) => x.state !== 'chase'), jail.guards.map((x) => x.state).join(','));
  idle(jail.yardT + 0.5);
  check('yard time over outside the cell → lockdown', jail.lockdown && jail.yardT === 0);
  // Back to the cell: the door shuts, lockdown over.
  parkGuards();
  walk([[-34, 0], [-35, -2], [-36, -16], [-41, -16]], { max: 40 });
  idle(0.5);
  check('back in the cell → door locked, lockdown cleared', !jail.doors().cell && !jail.lockdown);
  void g;
}

{
  console.log('--- keycard route');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  parkGuards();
  place(-24, -14.2, Math.PI);
  check('keycard prompt at the desk', jail.prompt(P(), ctx)?.text.includes('keycard') === true);
  log.length = 0;
  interactHold();
  check('keycard taken (saved as an item)', jail.items.has('keycard') && log.some((e) => e.type === 'item' && e.id === 'keycard'));
  check('jail save keeps the keycard', jail.save(1500).items.includes('keycard'));
  place(-35, 6.8, 0);
  check('security door prompt with the card', jail.prompt(P(), ctx)?.text.includes('Swipe') === true);
  jail.interact(P(), ctx);
  idle(0.1);
  check('security door opens', jail.doors().security);
  log.length = 0;
  parkGuards();
  walk([[-35, 10], [-26, 15], [-20, 20], [-20, 23]], { max: 40 });
  check('sally port → front gate → escaped (front)', log.some((e) => e.type === 'escaped' && e.route === 'front'));
  // Caught with the card: it is kept.
  jail.enter({ checkpoint: 0, bail: 1500, items: ['keycard'] });
  check('re-entering with the keycard: still carried, desk empty', jail.items.has('keycard'));
}

{
  console.log('--- fire alarm distraction');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  parkGuards();
  place(-32.8, -20.5, Math.PI / 2);
  check('alarm prompt', jail.prompt(P(), ctx)?.text.includes('alarm') === true);
  interactHold();
  check('fire alarm: yard gate open, every guard responds', jail.alarmT > 0 && jail.doors().yardGate && jail.guards.every((g) => g.state === 'investigate'));
  idle(ALARM_GATE_TIME);
  check('alarm over: gate shut', jail.alarmT === 0 && !jail.doors().yardGate);
}

{
  console.log('--- security camera');
  jail.enter({ checkpoint: 1, bail: 1500, items: [] });
  parkGuards();
  // In front of the maintenance camera, standing still, restricted room.
  place(-43, 4, 0);
  log.length = 0;
  idle(9);
  check('the maintenance camera spots the player (alarm)', log.some((e) => e.type === 'spotted'));
  check('guards are sent to look', jail.guards.some((g) => g.state === 'investigate' || stateOf(g) === 'chase'));
}

{
  console.log('--- guided escape support');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  jail.setGuidedSupport(true);
  parkGuards();
  place(-43.3, -16, Math.PI / 2);
  check('guided objectives explain the quick cutoff and alternate route', jail.objectives(ctx).lines.some((line) => line.includes('cell panel')) && jail.objectives(ctx).lines.some((line) => line.includes('office keycard')));
  jail.interact(P(), ctx);
  check('guided task timing is more forgiving but still requires a held interaction', !!jail.task && jail.task.need > 0 && jail.task.need < 3);
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  jail.setGuidedSupport(false);
}

{
  console.log('--- quick cell cutoff + sidearm support');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  parkGuards();
  place(-41.6, -16, Math.PI / 2);
  const emergencyPrompt = jail.prompt(P(), ctx)?.text ?? 'none';
  check('cell spawn is within reach of the emergency power cutoff', emergencyPrompt.toLowerCase().includes('cell emergency cutoff'), emergencyPrompt);
  jail.interact(P(), ctx);
  idle(0.8);
  check('cell cutoff disables cameras and opens only the staff route; yard/security remain locked', jail.securityT > 100 && jail.layout.isOpen('cell') && jail.layout.isOpen('staff') && !jail.layout.isOpen('security') && !jail.layout.isOpen('yardGate'));
  place(-45.2, 5, 0);
  check('maintenance breaker is the next clear objective', jail.prompt(P(), ctx)?.text.includes('Maintenance breaker') ?? false);
  jail.interact(P(), ctx);
  idle(1.1);
  check('maintenance panel opens the security route and yard gate for a second timed window', jail.powerT > 145 && jail.layout.isOpen('security') && jail.layout.isOpen('yardGate'));
  const guard = jail.guards[0];
  const origin = { x: guard.ctrl.position.x, y: guard.ctrl.position.y + 1, z: guard.ctrl.position.z - 5 };
  const rayHit = jail.hitGuardRay(origin, { x: 0, y: 0, z: 1 }, 10);
  check('aim ray can acquire a visible guard', jail.guardOnRay(origin, { x: 0, y: 0, z: 1 }, 10));
  check('sidearm ray temporarily stops a guard non-lethally', rayHit && jail.guards.some((g) => g.stunT > 0));
}

{
  console.log('--- bail');
  jail.enter({ checkpoint: 0, bail: 1500, items: [] });
  place(-40.5, -17.0, Math.PI);
  log.length = 0;
  jail.interact(P(), { credits: 100, bail: 1500 });
  check('bail without the credits: refused (toast only)', !jail.events.some((e) => e.type === 'bail') && jail.events.some((e) => e.type === 'toast'));
  idle(0.05);
  jail.interact(P(), { credits: 5000, bail: 1500 });
  idle(0.05);
  check('bail with the credits: bail event', log.some((e) => e.type === 'bail'));
  jail.exit();
  check('exit: guards disabled', !jail.active && jail.guards.every((g) => !g.ctrl.isEnabled));
}

{
  console.log('--- cleanup');
  const before = physics.counts;
  jail.dispose();
  player.dispose();
  const after = physics.counts;
  check('dispose removes the jail bodies / colliders', before.colliders > 60 && after.colliders <= 1 && after.bodies <= 1, `${before.colliders} → ${after.colliders}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall jail checks passed');
process.exit(failures ? 1 : 0);
