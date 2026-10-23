/**
 * Career test (headless, real physics):
 *  1. structure and progression rules (unlock chain, career stars, rewards, saves);
 *  2. every event is drivable: an AI driver in the player's car finishes timed events inside the
 *     limit, and the difficulty rises through the series (required pace, rival pace);
 *  3. early events are winnable in the stock starter car, the final needs a better car.
 * Usage: npm run test:career   (add --tune to print the raw timings only)
 */
declare const process: { exit(code: number): never; argv: string[] };
import { Scene, Vector3 } from 'three';
import { FIXED_DT } from '../src/game/config';
import { PhysicsWorld } from '../src/game/PhysicsWorld';
import { Vehicle } from '../src/game/Vehicle';
import { Track } from '../src/game/world/Track';
import { AiRacer, indexDelta } from '../src/game/missions/RaceAI';
import type { LevelDef, OpponentSpec } from '../src/game/missions/Levels';
import { vehicleById, type UpgradeLevels } from '../src/game/vehicles/VehicleCatalog';
import { CAREER, careerStars, careerStatus, isCareerUnlocked, recordCareer } from '../src/game/career/Career';
import { defaultProgress, sanitizeProgress } from '../src/game/missions/Progress';
import { LEVELS } from '../src/game/missions/Levels';
import { buildPois } from '../src/game/navigation/Navigation';

const TUNE = process.argv.includes('--tune');
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const lv = (n: number): UpgradeLevels => ({ engine: n, tyres: n, brakes: n, suspension: 0 });

const track = new Track(2);
const physics = await PhysicsWorld.create();
physics.addGround(800);
const scene = new Scene();
const car = new Vehicle(physics, scene, new Vector3(0, 0, 0), 0);

/** Distance the race / run covers, in road samples (same rule as MissionManager for races). */
function runLength(level: LevelDef): number {
  const start = level.carStart.i;
  const last = level.gates[level.gates.length - 1].i;
  if (level.race) return track.count + indexDelta(track, start, last);
  const d = indexDelta(track, start, last);
  return d <= 0 ? track.count + d : d;
}

/** Worst lateral distance from the road centre line (m) and recoveries of the last drive(). */
const lastDrive = { maxOff: 0, respawns: 0 };
/** Road half-width is 7 m; a car centre beyond ~6.2 m has wheels on the kerb. */
const ON_ROAD = 6.2;

/** Drive `level` solo with an AI driver in `carId` at `skill`; returns the finish time (s) or Infinity. */
function drive(level: LevelDef, carId: string, up: number, skill: number, startI = level.carStart.i, off = level.carStart.off): number {
  car.configure(vehicleById(carId), lv(up), 0xffffff);
  const spec: OpponentSpec = { name: 'test', paint: 0xffffff, skill, line: 1.75, i: startI, off };
  const ai = new AiRacer(car, spec, track);
  ai.reset();
  const len = runLength(level) + indexDelta(track, level.carStart.i, startI) * -1;
  let t = 0;
  lastDrive.maxOff = 0;
  for (let i = 0; i < Math.round(240 / FIXED_DT); i++) {
    ai.fixedUpdate(FIXED_DT, true, []);
    physics.step();
    car.afterStep();
    t += FIXED_DT;
    ai.afterStep(t, len);
    const p = car.physics.body.translation();
    const k = ai.idx;
    lastDrive.maxOff = Math.max(lastDrive.maxOff, Math.abs((p.x - track.px[k]) * track.rx(k) + (p.z - track.pz[k]) * track.rz(k)));
    lastDrive.respawns = ai.respawns;
    if (ai.finished) return ai.finishTime;
  }
  return Infinity;
}

console.log('--- structure and progression');
{
  check('7 events in 3 tiers', CAREER.length === 7 && new Set(CAREER.map((e) => e.tier)).size === 3);
  check('ids unique and save-safe', new Set(CAREER.map((e) => e.id)).size === CAREER.length && CAREER.every((e) => /^[a-z0-9-]{1,40}$/.test(e.id)));
  check('every event is a playable level type with gates and star times', CAREER.every((e) => ['checkpoints', 'timetrial', 'race'].includes(e.level.kind) && e.level.gates.length >= 4 && !!e.level.stars && e.level.stars[0] < e.level.stars[1]));
  check('rewards and star requirements rise through the series', CAREER.every((e, k) => k === 0 || (e.reward > CAREER[k - 1].reward && e.stars >= CAREER[k - 1].stars)));
  check('each event requires the previous one', CAREER.every((e, k) => (k === 0 ? e.after === null : e.after === CAREER[k - 1].id)));
  check('timed events: star times inside the limit', CAREER.filter((e) => !e.level.race).every((e) => e.level.stars![1] < (e.level.timeLimit ?? 0)));
  const maxStars = CAREER.length * 3;
  check('star requirements are reachable before each event', CAREER.every((e, k) => e.stars <= k * 3), `max ${maxStars}`);

  const p = defaultProgress();
  check('new save: only the first event is open', careerStatus(p).filter((s) => s.unlocked).length === 1 && isCareerUnlocked(p, 'harbor-sprint'));
  check('locked events explain why', careerStatus(p)[1].lockReason === 'Clear Harbor Sprint first');
  const r1 = recordCareer(p, 'harbor-sprint', 40, 1, null)!;
  check('first clear pays the full reward and opens the next event', r1.credits === 600 + 300 && p.credits === 900 && r1.unlockedEvents.includes('Rookie Cup'), `${r1.credits} cr, unlocked ${r1.unlockedEvents.join(', ')}`);
  recordCareer(p, 'rookie-cup', 100, 2, 2);
  check('3 career stars open the Pro tier', careerStars(p) === 3 && isCareerUnlocked(p, 'foundry-attack'));
  recordCareer(p, 'foundry-attack', 65, 1, null);
  check('cleared but short of stars: the next event says how many are needed', !isCareerUnlocked(p, 'pro-duel') && careerStatus(p)[3].lockReason === 'Needs 5 career stars (you have 4)', careerStatus(p)[3].lockReason ?? 'open');
  const before = p.credits;
  const r3 = recordCareer(p, 'harbor-sprint', 30, 3, null)!;
  check('replay with a better result: best time + stars kept, 30 % pay + new-star bonus', p.career['harbor-sprint'].time === 30 && p.career['harbor-sprint'].stars === 3 && r3.newBest && r3.credits === Math.round((600 * 0.3 * 1.5 + 2 * 300) / 10) * 10 && p.credits === before + r3.credits, `${r3.credits} cr`);
  const r4 = recordCareer(p, 'harbor-sprint', 45, 1, null)!;
  check('a worse replay keeps the best result', p.career['harbor-sprint'].time === 30 && p.career['harbor-sprint'].stars === 3 && !r4.newBest);
  check('unknown event / bad time is rejected', recordCareer(p, 'nope', 30, 3, null) === null && recordCareer(p, 'rookie-cup', NaN, 3, 1) === null);
  // Corrupt career data in a save is dropped, the rest survives.
  const raw = JSON.parse(JSON.stringify(p));
  raw.career['rookie-cup'] = { time: 'fast', stars: 9 };
  raw.career['../../hack'] = { time: 10, stars: 3 };
  const clean = sanitizeProgress(raw);
  check('corrupt career entries are dropped on load, valid ones kept', !clean.career['rookie-cup'] && !clean.career['../../hack'] && clean.career['harbor-sprint']?.time === 30);
}

console.log('\n--- city markers');
{
  const t = new Track();
  const pois = buildPois(t, LEVELS, CAREER.map((e) => ({ id: `career-${e.id}`, title: e.level.title, detail: e.tier, i: e.level.playerStart.i, off: Math.sign(e.level.playerStart.off || 1) * 7.9 })));
  let minD = Infinity;
  let pair = '';
  const tooClose: string[] = [];
  for (const a of pois) {
    if (a.kind !== 'event') continue;
    for (const b of pois) {
      if (b === a) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < minD) [minD, pair] = [d, `${a.id} / ${b.id}`];
      if (d < 40 && (b.kind !== 'event' || a.id < b.id)) tooClose.push(`${a.id}/${b.id} ${d.toFixed(0)} m`);
    }
  }
  check('every career event has a city marker, ≥ 40 m from any other marker', pois.filter((p) => p.kind === 'event').length === CAREER.length && minD >= 40, tooClose.length ? `too close: ${tooClose.join(', ')}` : `closest ${minD.toFixed(0)} m: ${pair}`);
  const inZone = (j: number): boolean => { const w = ((j % t.count) + t.count) % t.count; return w > 270 && w < 326; };
  check('no start grid or player start inside the permanent work zone', CAREER.every((e) => !inZone(e.level.playerStart.i) && !(e.level.race?.opponents ?? []).some((o) => inZone(o.i))));
}

console.log('\n--- drivability and difficulty (AI drivers, real physics)');
const rows: string[] = [];
const paces: number[] = [];
const rivalBest: number[] = [];
/**
 * Human margin per race, in career order: the car a player can realistically own by then (stars and
 * credits) must still qualify when this much slower than its ideal AI lap. The final also gets a tight
 * margin in a fully upgraded Kestrel, so the Vortex helps a lot but is not strictly required.
 */
const RACE_MARGIN: Array<Array<{ car: string; up: number; min: number }>> = [
  [{ car: 'kestrel', up: 0, min: 0.12 }],
  [{ car: 'kestrel', up: 1, min: 0.07 }],
  [{ car: 'kestrel', up: 3, min: 0.05 }],
  [{ car: 'vortex', up: 0, min: 0.07 }, { car: 'kestrel', up: 3, min: 0.015 }],
];
let worstRival = { off: 0, respawns: 0, who: '' };
let raceNo = 0;
for (const e of CAREER) {
  const L = e.level;
  const meters = runLength(L) * track.spacing;
  const stock = drive(L, 'kestrel', 0, 0.85);
  const stockFast = drive(L, 'kestrel', 0, 1.0);
  const vortex = drive(L, 'vortex', 3, 1.0);
  let rivals: number[] = [];
  if (L.race)
    rivals = L.race.opponents.map((o) => {
      const r = drive(L, o.car ?? 'kestrel', o.upgrades ?? 0, o.skill, o.i, o.off);
      if (lastDrive.maxOff > worstRival.off || lastDrive.respawns > worstRival.respawns) worstRival = { off: Math.max(worstRival.off, lastDrive.maxOff), respawns: Math.max(worstRival.respawns, lastDrive.respawns), who: `${o.name} (${e.id})` };
      return r;
    });
  rows.push(`${e.id.padEnd(16)} ${L.kind.padEnd(11)} ${(meters / 1000).toFixed(2)} km  limit ${L.timeLimit ?? '-'}  stars ${L.stars}  | AI Kestrel .85 ${stock.toFixed(1)}  1.0 ${stockFast.toFixed(1)}  Vortex L3 1.0 ${vortex.toFixed(1)}${rivals.length ? `  | rivals ${rivals.map((r) => r.toFixed(1)).join(' / ')}` : ''}`);
  if (L.race) {
    const need = L.race.requiredPosition;
    const sorted = [...rivals].sort((a, b) => a - b);
    const beat = sorted[need - 1];
    rivalBest.push(meters / sorted[0]);
    const expected = RACE_MARGIN[raceNo++];
    const margins = expected.map((x) => {
      const ideal = drive(L, x.car, x.up, 1.0);
      return { ...x, ideal, margin: beat / ideal - 1 };
    });
    rows.push(`    ↳ needs ≤ ${beat.toFixed(1)} s: margins ${margins.map((m) => `${m.car} L${m.up} ${(m.margin * 100).toFixed(1)} % (≥ ${(m.min * 100).toFixed(1)} %)`).join(', ')}; Vortex L3 ${((beat / vortex - 1) * 100).toFixed(1)} %, stock ${((beat / stockFast - 1) * 100).toFixed(1)} %`);
    if (!TUNE) {
      check(`${L.title}: all rivals finish`, rivals.every(Number.isFinite), rivals.map((r) => r.toFixed(1)).join(' / '));
      for (const m of margins)
        check(`${L.title}: winnable with a human margin — ${m.car} L${m.up} ≥ ${(m.min * 100).toFixed(1)} % slower than its ideal AI lap still finishes ahead of position ${need}`, m.margin >= m.min, `${m.ideal.toFixed(1)} s vs ${beat.toFixed(1)} s (${(m.margin * 100).toFixed(1)} %)`);
      const [s3, s2] = L.stars!;
      check(`${L.title}: race stars mean something — 2★ only by beating the rival's time, 3★ ≥ 2 % faster, still reachable`, s2 <= beat && s3 <= beat * 0.98 && s3 >= vortex * 1.015, `stars ${s3} / ${s2}, rival ${beat.toFixed(1)}, ideal best car ${vortex.toFixed(1)}`);
    }
  } else {
    paces.push(meters / (L.timeLimit ?? 1));
    if (!TUNE) {
      check(`${L.title}: an average driver in the stock car makes the time limit`, e.tier !== 'Rookie' || stock < (L.timeLimit ?? 0), `${stock.toFixed(1)} s / ${L.timeLimit} s`);
      check(`${L.title}: limit and star times leave human margin over the ideal AI lap (≥ 1.4× / ≥ 1.15×)`, (L.timeLimit ?? 0) >= stockFast * 1.4 && L.stars![0] >= vortex * 1.15, `AI Kestrel ${stockFast.toFixed(1)} s vs limit ${L.timeLimit}; AI Vortex L3 ${vortex.toFixed(1)} s vs 3★ ${L.stars![0]}`);
    }
  }
}
console.log(rows.join('\n'));
if (!TUNE) {
  check('timed events demand an ever higher average speed', paces.every((v, k) => k === 0 || v > paces[k - 1]), paces.map((v) => (v * 3.6).toFixed(0) + ' km/h').join(' → '));
  check('the fastest rival gets faster race by race', rivalBest.every((v, k) => k === 0 || v > rivalBest[k - 1]), rivalBest.map((v) => (v * 3.6).toFixed(0) + ' km/h').join(' → '));
  const champ = CAREER[CAREER.length - 1].level;
  const champStock = drive(champ, 'kestrel', 0, 1.0);
  const champRivals = champ.race!.opponents.map((o) => drive(champ, o.car ?? 'kestrel', o.upgrades ?? 0, o.skill, o.i, o.off));
  // In the stock car the final needs a lap within ~1.5 % of perfect: in practice it calls for upgrades.
  const stockMargin = Math.min(...champRivals) / champStock - 1;
  check('rival AI stays on the road in every career race (no spins, no recoveries)', worstRival.off <= ON_ROAD && worstRival.respawns === 0, `worst ${worstRival.off.toFixed(2)} m from the centre line${worstRival.who ? ` (${worstRival.who})` : ''}, ${worstRival.respawns} recoveries`);
  check('the final is out of reach in the stock starter car (needs a lap within 1.5 % of perfect)', stockMargin <= 0.015, `${champStock.toFixed(1)} s vs best rival ${Math.min(...champRivals).toFixed(1)} s (${(stockMargin * 100).toFixed(1)} %)`);
}

console.log(failures === 0 ? '\nALL CAREER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
