/**
 * Headless save-data and garage-rules test (mock localStorage). Usage: npm run test:progress
 */
declare const process: { exit(code: number): never };
const store = new Map<string, string>();
let throwOnSet = false;
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { if (throwOnSet) throw new Error('QuotaExceeded'); store.set(k, v); },
    removeItem: (k: string) => store.delete(k),
  },
};
const P = await import('../src/game/missions/Progress');
const G = await import('../src/game/vehicles/Garage');
const C = await import('../src/game/vehicles/VehicleCatalog');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// Missing data
store.clear();
let p = P.loadProgress();
check('no save: fresh progress with the starter car', P.lastLoadSource === 'default' && p.car === 'kestrel' && p.owned.join() === 'kestrel' && p.credits === 0 && p.unlocked === 1);

// Corrupted main, valid backup
store.clear();
const good = P.defaultProgress();
good.credits = 4321;
good.unlocked = 3;
P.saveProgress(good);
store.set(P.PROGRESS_KEY, '{"version":2,"credits":12'); // truncated write
p = P.loadProgress();
check('corrupted main save: recovered from the backup copy', P.lastLoadSource === 'backup' && p.credits === 4321 && p.unlocked === 3, `${P.lastLoadSource} ${p.credits}`);
check('...and the main save is repaired', JSON.parse(store.get(P.PROGRESS_KEY)!).credits === 4321);

// Both corrupted, v1 present → migration
store.clear();
store.set(P.PROGRESS_KEY, 'not json');
store.set(P.PROGRESS_BACKUP_KEY, '[1,2,3]');
store.set(P.PROGRESS_V1_KEY, JSON.stringify({ unlocked: 4, best: { 'find-your-ride': { time: 40, stars: 3 } }, paint: 'blue' }));
p = P.loadProgress();
// Old 5-mission saves: 4 open (old #1-#4) map to the 15-mission order, where old #4 is mission 6.
check('v1 save migrates (missions, stars, paint kept)', P.lastLoadSource === 'v1' && p.unlocked === 6 && P.totalStars(p) === 3 && p.paint === 'blue' && p.cars.kestrel.paint === 'blue', `${P.lastLoadSource} unlocked ${p.unlocked} stars ${P.totalStars(p)} paint ${p.paint}`);
check('...and is written as v2', JSON.parse(store.get(P.PROGRESS_KEY)!).version === 2);

// Garbage values are clamped / dropped
const g = P.sanitizeProgress({ version: 2, unlocked: 99, credits: -50, earned: 'x', car: 'tank', owned: ['tank', 'vortex', 'vortex', 7], cars: { vortex: { paint: 'plaid', upgrades: { engine: 9, tyres: -2, brakes: 1.7 } } }, best: { nope: { time: 1, stars: 3 }, 'find-your-ride': { time: -5, stars: 2 } }, career: { 'ev-1': { time: 50, stars: 7, position: 0 }, '<script>': { time: 1, stars: 1 } } });
check('new-layout save: unlocked count clamped to the 15 missions', P.sanitizeProgress({ version: 2, campaign: 2, unlocked: 99 }).unlocked === 15);
check('garbage: unknown cars dropped, duplicates removed, starter always owned', g.owned.join() === 'kestrel,vortex', g.owned.join());
// (no campaign marker = an old 5-mission save: "all open" maps to mission 9 of the new order)
check('garbage: numbers clamped (credits, levels, upgrades, stars)', g.credits === 0 && g.unlocked === 9 && g.cars.vortex.upgrades.engine === 3 && g.cars.vortex.upgrades.tyres === 0 && g.cars.vortex.upgrades.brakes === 1 && g.career['ev-1'].stars === 3 && g.career['ev-1'].position === 1, JSON.stringify(g.cars.vortex.upgrades));
check('garbage: invalid paint / car / ids / times rejected', g.cars.vortex.paint === 'orange' && g.car === 'kestrel' && !('nope' in g.best) && !('find-your-ride' in g.best) && !('<script>' in g.career));
check('non-object saves give a fresh start', P.sanitizeProgress(null).car === 'kestrel' && P.sanitizeProgress('x').credits === 0 && P.sanitizeProgress([1]).unlocked === 1);

// Storage failure never throws
throwOnSet = true;
let threw = false;
try { P.saveProgress(p); } catch { threw = true; }
throwOnSet = false;
check('storage full / blocked: saving fails silently', !threw);

// Garage rules
store.clear();
p = P.loadProgress();
check('cannot buy without credits', G.buyBlock(p, 'pip') === 'credits' && !G.buyCar(p, 'pip'));
P.addCredits(p, 50000);
check('star requirement blocks the Brute V8 (6 stars) even with credits', G.buyBlock(p, 'brute') === 'stars' && !G.buyCar(p, 'brute'));
check('buying the Pip GTi: credits deducted, car owned and selected', G.buyCar(p, 'pip') && p.credits === 50000 - 3000 && p.owned.includes('pip') && p.car === 'pip' && p.paint === 'white');
check('cannot buy a car twice', G.buyBlock(p, 'pip') === 'owned' && !G.buyCar(p, 'pip'));
check('switching cars restores each car\'s own paint', G.selectCar(p, 'kestrel') && p.paint === 'red' && G.selectCar(p, 'pip') && (p.paint as string) === 'white');
check('cannot select a car you do not own', !G.selectCar(p, 'vortex') && p.car === 'pip');
const before = p.credits;
const price1 = C.upgradePrice(C.vehicleById('pip'), 'engine', 0)!;
check('engine upgrade costs credits and raises the level', G.buyUpgrade(p, 'pip', 'engine') && p.cars.pip.upgrades.engine === 1 && p.credits === before - price1, `price ${price1}`);
G.buyUpgrade(p, 'pip', 'engine');
G.buyUpgrade(p, 'pip', 'engine');
check('upgrades stop at level 3', p.cars.pip.upgrades.engine === 3 && G.upgradeBlock(p, 'pip', 'engine') === 'max' && !G.buyUpgrade(p, 'pip', 'engine'));
check('cannot upgrade a car you do not own', G.upgradeBlock(p, 'vortex', 'tyres') === 'locked');
check('a car\'s factory paint is always available for it', G.paintAvailable(p, 'pip', 'white') && !G.paintAvailable(p, 'kestrel', 'white'));
check('locked paint (needs stars) is refused; unlocked paint applies to that car only', !G.setCarPaint(p, 'pip', 'gold') && G.setCarPaint(p, 'pip', 'blue') && p.cars.pip.paint === 'blue' && p.cars.kestrel.paint === 'red');
// Suspension upgrade and cosmetic parts
{
  const c0 = p.credits;
  const sp = C.upgradePrice(C.vehicleById('pip'), 'suspension', 0)!;
  check('suspension upgrade is sold like the others', G.buyUpgrade(p, 'pip', 'suspension') && p.cars.pip.upgrades.suspension === 1 && p.credits === c0 - sp, `price ${sp}`);
  check('new car starts on its factory parts', p.cars.pip.look.wheels === 'five' && p.cars.pip.look.spoiler === 'roof' && p.cars.pip.look.kit === 'stock' && p.cars.pip.parts.length === 0, JSON.stringify(p.cars.pip.look));
  const wp = C.partPrice(C.vehicleById('pip'), 'wheels', 'mesh');
  const c1 = p.credits;
  check('buying + fitting a part: price charged once, part owned and fitted', wp > 0 && G.fitPart(p, 'pip', 'wheels', 'mesh') && p.credits === c1 - wp && p.cars.pip.look.wheels === 'mesh' && p.cars.pip.parts.includes('wheels:mesh'), `price ${wp}`);
  const c2 = p.credits;
  check('refitting factory or owned parts is free', G.fitPart(p, 'pip', 'wheels', 'five') && G.fitPart(p, 'pip', 'wheels', 'mesh') && G.fitPart(p, 'pip', 'spoiler', 'none') && p.credits === c2 && p.cars.pip.look.spoiler === 'none');
  check('parts belong to one car (the Kestrel does not own the Pip\'s wheels)', !P.ownsPart(p.cars.kestrel, 'kestrel', 'wheels', 'mesh') && C.partPrice(C.vehicleById('kestrel'), 'wheels', 'mesh') > 0);
  check('parts cannot be fitted to a car you do not own', G.partBlock(p, 'vortex', 'kit', 'street') === 'locked' && !G.fitPart(p, 'vortex', 'kit', 'street'));
  check('unknown part refused', G.partBlock(p, 'pip', 'kit', 'chrome-bumpers') === 'unknown' && !G.fitPart(p, 'pip', 'kit', 'chrome-bumpers'));
  const poor = P.sanitizeProgress({ ...p, credits: 10 });
  check('part blocked without enough credits', G.partBlock(poor, 'pip', 'kit', 'street') === 'credits' && !G.fitPart(poor, 'pip', 'kit', 'street') && poor.cars.pip.look.kit === 'stock');
}
const reloaded = P.loadProgress();
check(
  'everything persists across a reload',
  reloaded.car === 'pip' && reloaded.cars.pip.upgrades.engine === 3 && reloaded.cars.pip.upgrades.suspension === 1 && reloaded.cars.pip.paint === 'blue' && reloaded.credits === p.credits &&
    reloaded.cars.pip.look.wheels === 'mesh' && reloaded.cars.pip.look.spoiler === 'none' && reloaded.cars.pip.parts.join() === 'wheels:mesh',
  JSON.stringify(reloaded.cars.pip),
);
{
  // Corrupt garage entries: unknown / unbought parts, bad looks, missing suspension level (older saves).
  const bad = P.sanitizeProgress({
    version: 2,
    campaign: 2,
    owned: ['kestrel', 'atlas'],
    cars: {
      kestrel: { paint: 'red', upgrades: { engine: 2, tyres: 1, brakes: 0 }, parts: ['wheels:dish', 'wheels:dish', 'kit:gold', 7, 'spoiler:wing'], look: { wheels: 'dish', spoiler: 'gt', kit: 'nope' } },
      atlas: { paint: 'blue', upgrades: { suspension: 9 }, parts: 'x', look: 'y' },
    },
  });
  check('older save without a suspension level loads with suspension 0', bad.cars.kestrel.upgrades.suspension === 0 && bad.cars.kestrel.upgrades.engine === 2);
  check('suspension level clamped to 3', bad.cars.atlas.upgrades.suspension === 3);
  check('bought parts de-duplicated; unknown parts and factory parts dropped from the list', bad.cars.kestrel.parts.join() === 'wheels:dish', bad.cars.kestrel.parts.join());
  check('fitted parts must be owned: unbought GT wing and unknown kit fall back to the factory fit', bad.cars.kestrel.look.wheels === 'dish' && bad.cars.kestrel.look.spoiler === 'wing' && bad.cars.kestrel.look.kit === 'stock', JSON.stringify(bad.cars.kestrel.look));
  check('garbage parts / look fields give the factory fit', bad.cars.atlas.parts.length === 0 && JSON.stringify(bad.cars.atlas.look) === JSON.stringify(C.factoryLook(C.vehicleById('atlas'))));
  const missing = P.sanitizeProgress({ version: 2, owned: ['kestrel'], cars: {} });
  check('missing car entry gets a complete default garage record', missing.cars.kestrel.parts.length === 0 && missing.cars.kestrel.look.spoiler === 'wing' && missing.cars.kestrel.upgrades.suspension === 0);
}
{
  // Eight cars: free default, star-gated prices, every car buyable in the end.
  const free = C.VEHICLES.filter((v) => v.price === 0);
  check('exactly one free default vehicle (the Kestrel GT)', free.length === 1 && free[0].id === C.DEFAULT_VEHICLE && C.DEFAULT_VEHICLE === 'kestrel');
  check('garage lists every catalog vehicle once', C.GARAGE_ORDER.length === C.VEHICLES.length && new Set(C.GARAGE_ORDER).size === C.VEHICLES.length && C.GARAGE_ORDER.every((id) => C.vehicleById(id).id === id));
  const rich = P.sanitizeProgress({ version: 2, campaign: 2, credits: 999999 });
  const blocked = C.VEHICLES.filter((v) => v.requiresStars > 0).every((v) => G.buyBlock(rich, v.id) === 'stars');
  check('star-gated cars are blocked with 0 stars even when rich', blocked);
  const best: Record<string, { time: number; stars: number }> = {};
  for (const l of (await import('../src/game/missions/Levels')).LEVELS) best[l.id] = { time: 60, stars: 3 };
  const champ = P.sanitizeProgress({ version: 2, campaign: 2, credits: 999999, best });
  const maxStars = P.totalStars(champ);
  check('every car can be unlocked with campaign stars alone', C.VEHICLES.every((v) => v.requiresStars <= maxStars), `max campaign stars ${maxStars}, highest requirement ${Math.max(...C.VEHICLES.map((v) => v.requiresStars))}`);
  check('all catalog vehicles can be bought once unlocked', C.VEHICLES.filter((v) => v.price > 0).every((v) => G.buyCar(champ, v.id)) && champ.owned.length === C.VEHICLES.length);
}

// Rewards
const q = P.defaultProgress();
const r1 = P.recordCompletion(q, 0, 50, 2);
const r2 = P.recordCompletion(q, 0, 45, 3);
const r3 = P.recordCompletion(q, 0, 44, 3);
check('first clear pays in full (+ star bonus), replays pay less, new stars add a bonus', r1.credits === P.rewardFor(500, 2, true, 2) && r2.credits === P.rewardFor(500, 3, false, 1) && r3.credits === P.rewardFor(500, 3, false, 0) && r1.credits > r2.credits && r2.credits > r3.credits, `${r1.credits} / ${r2.credits} / ${r3.credits}`);
check('credits accumulate and are saved', q.credits === r1.credits + r2.credits + r3.credits && JSON.parse(store.get(P.PROGRESS_KEY)!).credits === q.credits);

// Two tabs: a tab re-reads the stored save before changing progress (readStoredProgress + adoptProgress).
{
  store.clear();
  const tabA = P.loadProgress();
  const tabB = P.loadProgress();
  P.addCredits(tabA, 10000);
  P.saveProgress(tabA); // tab A earns credits
  const fresh = P.readStoredProgress();
  check('readStoredProgress returns what another tab saved', !!fresh && fresh.credits === tabA.credits, `${fresh?.credits}`);
  const shared = tabB; // the menu holds this same object
  const changed = P.adoptProgress(tabB, fresh!);
  check('adoptProgress updates the stale copy in place (shared reference kept)', changed && shared === tabB && tabB.credits === tabA.credits && tabB.owned.join() === 'kestrel');
  check('adoptProgress is a no-op when nothing changed', P.adoptProgress(tabB, P.readStoredProgress()!) === false);
  store.set(P.PROGRESS_KEY, '{"version":2,"credits":'); // torn / corrupted write from another tab
  check('a corrupted stored save is never adopted', P.readStoredProgress() === null);
  store.set(P.PROGRESS_KEY, JSON.stringify({ version: 1, credits: 5 }));
  check('a wrong-version stored save is never adopted', P.readStoredProgress() === null);
  store.delete(P.PROGRESS_KEY);
  check('a missing stored save is never adopted', P.readStoredProgress() === null);
}

{
  console.log('\n--- settings: race options');
  const S = await import('../src/game/Settings');
  const d = S.sanitizeSettings({});
  check('race options default to normal rivals and no rubber band', d.aiDifficulty === 'normal' && d.rubberBand === false, `${d.aiDifficulty} / ${d.rubberBand}`);
  const bad = S.sanitizeSettings({ aiDifficulty: 'insane', rubberBand: 'yes' } as never);
  check('   invalid stored values fall back to the defaults', bad.aiDifficulty === 'normal' && bad.rubberBand === false);
  const ok = S.sanitizeSettings({ aiDifficulty: 'hard', rubberBand: true });
  check('   valid values are kept', ok.aiDifficulty === 'hard' && ok.rubberBand === true);
  store.set(S.SETTINGS_KEY, JSON.stringify({ volume: 0.5, quality: 'low' }));
  const old = S.loadSettings();
  check('   a settings save from before the race options loads with them at their defaults', old.volume === 0.5 && old.quality === 'low' && old.aiDifficulty === 'normal' && old.rubberBand === false);
  check('   difficulty scales: easy < normal < hard', S.AI_SKILL_SCALE.easy < S.AI_SKILL_SCALE.normal && S.AI_SKILL_SCALE.normal < S.AI_SKILL_SCALE.hard && S.AI_SKILL_SCALE.normal === 1);
  check('driving feel and guided escape settings sanitize, persist-compatible defaults stay safe', d.drivingFeel === 'balanced' && d.escapeSupport === 'standard' && S.sanitizeSettings({ drivingFeel: 'realistic', escapeSupport: 'guided' }).drivingFeel === 'realistic' && S.sanitizeSettings({ drivingFeel: 'bogus', escapeSupport: 'bogus' } as never).escapeSupport === 'standard');
  check('Ultra graphics level is valid and has a higher shadow-map target than High', S.sanitizeSettings({ quality: 'ultra' }).quality === 'ultra' && S.QUALITY_PRESETS.ultra.shadowMapSize > S.QUALITY_PRESETS.high.shadowMapSize);
}

{
  console.log('\n--- tyre wear and weather settings (Stage 3)');
  const old = P.sanitizeProgress({ version: 2, campaign: 2, owned: ['kestrel'], cars: { kestrel: { paint: 'red' } } });
  check('a save from before tyre wear loads with new tyres', old.cars.kestrel.tyreWear.join() === '0,0,0,0');
  const bad = P.sanitizeProgress({ version: 2, campaign: 2, owned: ['kestrel'], cars: { kestrel: { tyreWear: [0.5, 'x', 2, null] } } });
  check('   corrupt tyre wear falls back to new tyres', bad.cars.kestrel.tyreWear.join() === '0,0,0,0', bad.cars.kestrel.tyreWear.join());
  const clamp = P.sanitizeProgress({ version: 2, campaign: 2, owned: ['kestrel'], cars: { kestrel: { tyreWear: [0.3, -1, 7, 0.1] } } });
  check('   tyre wear is clamped to 0..1', clamp.cars.kestrel.tyreWear.join() === '0.3,0,1,0.1', clamp.cars.kestrel.tyreWear.join());
  const p = P.sanitizeProgress({ version: 2, campaign: 2, credits: 5000, owned: ['kestrel'], cars: { kestrel: { tyreWear: [0.02, 0.02, 0.03, 0.04] } } });
  check('   new tyres are refused while the set is barely worn (< 5 %)', !P.fitNewTyres(p, 'kestrel') && p.credits === 5000);
  p.cars.kestrel.tyreWear = [0.1, 0.1, 0.4, 0.35];
  const price = P.tyrePrice(p, 'kestrel');
  check('   worn tyres: replaced for the price, wear back to 0', P.fitNewTyres(p, 'kestrel') && p.credits === 5000 - price && p.cars.kestrel.tyreWear.join() === '0,0,0,0', `price ${price}`);
  check('   a car you do not own gets no tyres', !P.fitNewTyres(p, 'apex'));
  const poor = P.sanitizeProgress({ version: 2, campaign: 2, credits: 10, owned: ['kestrel'], cars: { kestrel: { tyreWear: [0.5, 0.5, 0.5, 0.5] } } });
  check('   not enough credits: nothing changes', !P.fitNewTyres(poor, 'kestrel') && poor.credits === 10 && poor.cars.kestrel.tyreWear[0] === 0.5);
  const S = await import('../src/game/Settings');
  check('weather setting defaults to changing weather; invalid values fall back', S.sanitizeSettings({}).weather === 'dynamic' && S.sanitizeSettings({ weather: 'snow' } as never).weather === 'dynamic' && S.sanitizeSettings({ weather: 'fog' } as never).weather === 'fog');
}

console.log(failures === 0 ? '\nALL PROGRESS CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
