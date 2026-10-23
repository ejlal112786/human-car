/**
 * Browser check (QA build) of the arrest → impound → jail → escape loop in the running game, driven with
 * real key presses (E / C / W / Enter) and the real police, officers, jail physics and save:
 *   1. busted on foot: officers close in, hands up, cuffed, walked to the police car, summary card, Continue
 *   2. penalty + impound saved, garage / unlocks / other cars untouched; no re-trigger while jailed
 *   3. reload mid-sentence → back in jail
 *   4. tunnel escape (vent → duct → checkpoint → drain hatch → tunnel) → back in the city, searched for
 *   5. impound office: pay the fee → car released
 *   6. busted in the car: forced out, card Continue button (mouse)
 *   7. recapture during the escape → back in the cell; bail from the cell phone
 *   8. breaking the impounded car out (wanted); missions lend a stock car while the own car is impounded
 *   9. (separate) key route: yard time → office keycard → security door → front gate; power-cut route:
 *      breaker → staff door → common room → yard → open gate; garage refuses a stolen car
 * Usage: node scripts/arrest-qa.mjs [url] [--only=arrest,reload,escape,impound,car,recapture,breakout,routes,garage]
 *   (sections build on each other: arrest, then escape before car / recapture)   (default http://localhost:4174/, `npm run preview:qa`)
 * ARREST_SHOTS=dir saves screenshots.
 */
import { chromium } from 'playwright';

const URL = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4174/';
const SHOTS = process.env.ARREST_SHOTS ?? '';
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });

const H = (f, a) => page.evaluate(f, a);
const adv = (s) => H((x) => window.__cityRacer.qaAdvance(x), s);
const pi = () => H(() => window.__cityRacer.policeInfo());
const ci = () => H(() => window.__cityRacer.crimeInfo());
const ai = () => H(() => window.__cityRacer.arrestInfo());
const ji = () => H(() => window.__cityRacer.jailInfo());
const prog = () => H(() => JSON.parse(JSON.stringify(window.__cityRacer.garageInfo().progress)));
const nav = () => H(() => window.__cityRacer.navInfo());
const shot = async (name) => {
  if (!SHOTS) return;
  await H(() => window.__cityRacer.qaFreeze(true));
  await adv(0);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 }).catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
  await H(() => window.__cityRacer.qaFreeze(false));
};
const place = (x, z, yaw = 0) => H(([a, b, c]) => window.__cityRacer.qaPlaceCharacter(a, b, c), [x, z, yaw]);
const aimAt = (x, y, z) => H(([a, b, c]) => window.__cityRacer.qaAimAt(a, b, c), [x, y, z]);
const toast = () => H(() => [...document.querySelectorAll('.toast, .pop')].map((e) => e.textContent).join(' | '));
const key = async (code) => {
  await page.keyboard.press(code);
  await adv(0.05);
};
const ONLY = (process.argv.find((x) => x.startsWith('--only=')) ?? '').slice(7);
const want = (name) => !ONLY || ONLY.split(',').includes(name);

let JO = { x: 680, z: 0 };
const lpos = async () => {
  const c = (await ci()).character;
  return { x: c.x - JO.x, z: c.z - JO.z };
};
/** Walk (jail-local target) with W, the camera turned towards the target; returns the final distance.
 *  Stops as soon as the player is out of the jail (escaped: the target no longer means anything). */
async function walkTo(lx, lz, max = 30, tol = 0.4, run = false) {
  let t = 0;
  let d = Infinity;
  if (run) await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      const l = await lpos();
      d = Math.hypot(lx - l.x, lz - l.z);
      if (d < tol || t > max) break;
      if (!(await H(() => window.__cityRacer.jailInfo()?.jailed))) break;
      await aimAt(JO.x + lx, 1.0, JO.z + lz);
      const step = Math.min(0.25, Math.max(0.05, d / (run ? 9 : 3)));
      await adv(step);
      t += step;
    }
  } finally {
    await page.keyboard.up('KeyW');
    if (run) await page.keyboard.up('ShiftLeft');
  }
  await adv(0.1);
  return d;
}
/** Free roam: let the arrest play out (no input), returning the phases seen in order. */
async function runArrest(onPhase) {
  const seen = [];
  let a = null;
  for (let k = 0; k < 160; k++) {
    a = await ai();
    if (seen[seen.length - 1] !== a.phase) {
      seen.push(a.phase);
      if (onPhase) await onPhase(a.phase, a);
    }
    if (a.phase === 'transfer' || (seen.length > 1 && a.phase === 'idle')) break;
    await adv(0.25);
  }
  return { seen, a };
}

const START = { version: 2, campaign: 2, unlocked: 15, best: {}, credits: 60000, owned: ['kestrel', 'pip'], car: 'pip' };
await H((p) => window.__cityRacer.setProgress(p), START);
const base = await prog();
check('test save: two cars owned, pip selected', base.owned.includes('pip') && base.owned.includes('kestrel') && base.car === 'pip', `${base.owned} / ${base.car}`);
await H(() => window.__cityRacer.startLevel(-1));
await adv(3);
await page.mouse.move(480, 270);

// --- 1. Busted on foot
if (want('arrest')) {
  console.log('--- busted on foot');
  let p = await pi();
  const c0 = await ci();
  check('free roam, on foot next to the own car, no record', c0.state === 'onFoot' && p.enabled && p.stars === 0 && (await ai()).phase === 'idle');
  await H(([i]) => window.__cityRacer.policePlace(0, i + 3, 1, 5.25), [p.playerIdx]);
  await adv(0.3);
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  let busted = false;
  for (let k = 0; k < 80 && !busted; k++) {
    await adv(0.25);
    busted = (await ai()).phase !== 'idle';
  }
  check('standing still next to an officer → busted, arrest starts', busted);
  const pre = await prog();
  const r = await runArrest(async (ph, a) => {
    if (ph === 'surrender') {
      check('surrender: an officer from the arresting unit is on foot with the sidearm', a.officers.length >= 1 && a.officers.some((o) => o.mode !== 'off'), JSON.stringify(a.officers.map((o) => o.mode)));
      await adv(0.6);
      const b = await ai();
      check('player raises the hands (pose blend)', b.handsW > 0.9, `handsW ${b.handsW.toFixed(2)}`);
      const o = b.officers[0];
      if (o) await aimAt(o.x, 1.2, o.z);
      await shot('a1-surrender');
    }
    if (ph === 'cuffed') {
      const c = (await ci()).character;
      const near = Math.min(...a.officers.map((o) => Math.hypot(o.x - c.x, o.z - c.z)));
      check('cuffed only once an officer is within arm\'s length', near < 2.4, `${near.toFixed(2)} m`);
    }
    if (ph === 'escort') {
      const c1 = (await ci()).character;
      await adv(1.5);
      const c2 = (await ci()).character;
      const b = await ai();
      const d1 = Math.hypot(b.door.x - c1.x, b.door.z - c1.z);
      const d2 = Math.hypot(b.door.x - c2.x, b.door.z - c2.z);
      check('escort: the player walks (physics) towards the police car door', d2 < d1 - 0.5 || d2 < 1.0, `${d1.toFixed(2)} → ${d2.toFixed(2)} m`);
      await shot('a2-escort');
    }
  });
  check('phase order surrender → cuffed → escort → transfer', r.seen.join(',') === 'surrender,cuffed,escort,transfer', r.seen.join(','));
  await adv(0.6);
  let a = await ai();
  check('transfer: arrest card shown, screen fades', a.card && a.fade > 0.5, `card ${a.card} fade ${a.fade.toFixed(2)}`);
  const cardText = await H(() => document.querySelector('.arrest-card')?.textContent ?? '');
  check('card lists the fine, the impounded car and the bail', /Fine/.test(cardText) && /Impounded/.test(cardText) && /Pip/i.test(cardText) && /Bail/.test(cardText), cardText.slice(0, 160));
  await shot('a3-card');
  await key('Enter');
  await adv(0.5);
  a = await ai();
  const j = await ji();
  JO = j.origin;
  check('Continue (Enter) → jail, in the cell; arrest finished', j.jailed && j.zone === 'cell' && a.phase === 'idle' && !a.card, `${j.zone} ${a.phase}`);
  await adv(0.6);
  await shot('a4-cell');
  const s = a.summary ?? r.a.summary;
  const pr = await prog();
  console.log(`summary ${JSON.stringify(s)}`);
  check('own car (pip) impounded with the fee, sentence saved, one arrest', pr.impound.pip === s.vehicle.fee && s.vehicle.kind === 'own' && pr.jail && pr.jail.bail === s.bail && pr.arrests === (base.arrests ?? 0) + 1, JSON.stringify({ imp: pr.impound, jail: pr.jail, arrests: pr.arrests }));
  check('fine taken once, saved at the start of the arrest', pre.credits === base.credits - s.fine && pr.credits === pre.credits, `${base.credits} → ${pre.credits} → ${pr.credits} (fine ${s.fine})`);
  check('garage intact: same owned cars, same selected car, upgrades and unlocks unchanged', JSON.stringify(pr.owned) === JSON.stringify(base.owned) && pr.car === base.car && JSON.stringify(pr.cars) === JSON.stringify(base.cars) && pr.unlocked === base.unlocked && pr.campaign === base.campaign);
  p = await pi();
  check('jail: police off, wanted cleared, weapon disabled, no map / nav', !p.enabled && p.stars === 0 && !(await ci()).enabled && (await H(() => document.querySelector('.minimap-wrap')?.classList.contains('hidden'))));
  const again = await H(() => window.__cityRacer.policeOffence('hitPolice'));
  await adv(1);
  check('no re-trigger in jail: offences ignored, no second arrest', (await pi()).stars === 0 && (await ai()).phase === 'idle' && (await prog()).arrests === pr.arrests, `offence accepted ${again}`);
  const hud = await H(() => ({ title: document.querySelector('.mission-title, .mission h2, .mission .title')?.textContent ?? '', all: document.querySelector('.hud')?.textContent ?? '' }));
  check('jail objectives on the HUD', /jail|escape|cell|vent/i.test(hud.all), hud.title);
}

// --- 2. Reload mid-sentence
if (want('arrest') && want('reload')) {
  console.log('--- reload during the sentence');
  await page.reload({ timeout: 180000 });
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(2);
  const j = await ji();
  check('page reload + free roam → back in the jail cell (sentence persists)', !!j && j.jailed && j.zone === 'cell');
  check('impound record survives the reload', (await prog()).impound.pip > 0);
  await page.mouse.move(480, 270);
}

// --- 3. Tunnel escape
if (want('arrest') && want('escape')) {
  console.log('--- tunnel escape (real input)');
  await H(() => window.__cityRacer.qaJailGuardsAway());
  await place(JO.x - 42, JO.z - 16, -Math.PI / 2);
  await adv(0.3);
  await walkTo(-43.0, -16, 6, 0.35);
  let n = await nav();
  check('prompt at the vent', /vent/i.test(n.prompt ?? ''), n.prompt);
  await key('KeyE');
  await adv(4);
  let j = await ji();
  check('E + hold still → vent unscrewed (timed task)', j.doors.vent, JSON.stringify(j.doors));
  await walkTo(-45, -16, 3);
  check('standing: can\'t get into the duct', (await lpos()).x > -44.3, `x ${(await lpos()).x.toFixed(2)}`);
  await key('KeyC');
  check('C → crouch', (await ci()).crouched);
  const dDuct = await walkTo(-45, -16, 12);
  await walkTo(-45, -3, 40);
  j = await ji();
  check('crouched: through the vent into the duct', j.zone === 'duct' || dDuct < 0.5, `zone ${j.zone}`);
  await shot('a5-duct');
  await walkTo(-45, -0.5, 10);
  await walkTo(-42.5, 1.5, 10);
  j = await ji();
  check('maintenance room → checkpoint 1 (saved)', j.checkpoint === 1 && (await prog()).jail?.checkpoint === 1, `cp ${j.checkpoint}`);
  await key('KeyC');
  check('stand up again', !(await ci()).crouched);
  await walkTo(-45, 6.9, 15);
  n = await nav();
  check('drain hatch prompt', /hatch/i.test(n.prompt ?? ''), n.prompt);
  await key('KeyE');
  await adv(4.5);
  j = await ji();
  check('hatch pried open', j.doors.hatch);
  await key('KeyC');
  await walkTo(-45, 12, 15);
  await shot('a6-tunnel');
  await walkTo(-45, 23.5, 30);
  await adv(0.5);
  j = await ji();
  const p = await pi();
  const c = await ci();
  const pr = await prog();
  check('tunnel → escaped: back in the city on foot', !j.jailed && c.state === 'onFoot' && c.enabled && Math.abs(c.character.x) < 600, `jailed ${j.jailed} x ${c.character.x.toFixed(0)}`);
  check('sentence cleared; escapee is searched for (wanted)', pr.jail === null && p.enabled && p.stars >= 1, `${p.stars}★ ${p.state}`);
  check('escaping does not release the impounded car', pr.impound.pip > 0);
  check('out of the crawl tunnel: standing again in the city (not stuck crouched)', !c.crouched, `crouched ${c.crouched}`);
  check('map back', !(await H(() => document.querySelector('.minimap-wrap')?.classList.contains('hidden'))));
  await adv(0.5);
  await shot('a7-released');
}

// --- 4. Impound office
if (want('arrest') && want('impound')) {
  console.log('--- impound lot');
  const c = await ci();
  const n = await nav();
  const lot = n.pois.find((x) => x.kind === 'impound');
  check('impound POI on the map', !!lot);
  const dCar = Math.hypot(c.own.x - lot.x, c.own.z - lot.z);
  check('own car (impounded) stands at the impound lot', dCar < 40, `${dCar.toFixed(1)} m from the office`);
  const pr0 = await prog();
  await H(() => window.__cityRacer.policeInfo()); // no-op
  await place(lot.x, lot.z, 0);
  await adv(0.4);
  const n2 = await nav();
  check('office prompt shows the release fee', /Pay .* release your/i.test(n2.prompt ?? ''), n2.prompt);
  await aimAt(c.own.x, 1, c.own.z);
  await shot('a8-impound');
  await key('KeyE');
  await adv(0.3);
  const pr = await prog();
  check('pay → impound cleared, fee deducted once', !pr.impound.pip && pr.credits === pr0.credits - pr0.impound.pip, `${pr0.credits} → ${pr.credits} (fee ${pr0.impound.pip})`);
  await key('KeyE');
  await adv(0.3);
  check('paying again does nothing', (await prog()).credits === pr.credits);
}

// --- 5. Busted in a stolen car
if (want('arrest') && want('car')) {
  console.log('--- busted in a stolen car');
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(3);
  let c = await ci();
  const me = c.character;
  const parked = c.worldCars.filter((w) => w.state === 'parked' && w.active).sort((u, v) => Math.hypot(u.x - me.x, u.z - me.z) - Math.hypot(v.x - me.x, v.z - me.z))[0];
  check('a parked world car nearby', !!parked);
  if (parked) {
    // Beside the driver's side (car forward = (cos yaw, −sin yaw), lateral = (sin yaw, cos yaw)).
    for (const side of [1, -1]) {
      await place(parked.x + Math.sin(parked.yaw) * 1.9 * side, parked.z + Math.cos(parked.yaw) * 1.9 * side, 0);
      await adv(0.3);
      if (/Steal|Enter|Get in/i.test((await nav()).prompt ?? '')) break;
    }
    console.log(`prompt at the parked car: ${(await nav()).prompt}`);
  }
  for (let k = 0; k < 3 && (await ci()).state !== 'driving'; k++) {
    await key('KeyE');
    await adv(2.5);
  }
  c = await ci();
  check('driving a stolen parked car', c.state === 'driving' && !c.driven.own && c.driven.world, `${c.state} own ${c.driven.own}`);
  let p = await pi();
  await H(([i]) => window.__cityRacer.policePlace(0, i + 3, 1, 5.25), [p.playerIdx]);
  await adv(0.3);
  await H(() => window.__cityRacer.policeOffence('hitPolice'));
  let a = null;
  for (let k = 0; k < 80; k++) {
    await adv(0.25);
    a = await ai();
    if (a.phase !== 'idle') break;
  }
  check('stopped next to the unit in the car → busted', a.phase === 'surrender', a.phase);
  check('prompt: get out of the car', /Get out/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  let exited = false;
  for (let k = 0; k < 30 && !exited; k++) {
    await adv(0.25);
    exited = (await ci()).state !== 'driving';
  }
  check('not getting out → forced out after a few seconds', exited);
  const r = await runArrest();
  check('then cuffed, escorted, transfer', r.seen.includes('cuffed') && r.seen.includes('escort') && r.a.phase === 'transfer', r.seen.join(','));
  await adv(0.6);
  const btn = await H(() => { const e = document.querySelector('.arrest-card button'); return !!e && e.offsetParent !== null; });
  check('card has a visible Continue button', btn);
  if (btn) await page.click('.arrest-card button', { timeout: 20000 }).catch((e) => console.log(`(click failed: ${e.message.split('\n')[0]})`));
  await adv(0.6);
  a = await ai();
  const j = await ji();
  check('Continue button (mouse) → jail', j.jailed && a.phase === 'idle', `${j.zone}`);
  const sum = r.a.summary;
  check('summary: stolen car returned, own car not impounded', sum?.vehicle.kind === 'stolen' && !(await prog()).impound.pip, JSON.stringify(sum?.vehicle));
  check('the stolen car is released back to the world pool (none held)', (await ci()).worldCars.every((w) => w.state !== 'taken' && w.state !== 'driven'));
  const o = await pi();
  check('arrest officers cleared', o.officers.every((x) => x.mode === 'off'));
}

// --- 6. Recapture + bail
if (want('arrest') && want('recapture')) {
  console.log('--- recapture, bail');
  let j = await ji();
  if (!j.jailed) {
    console.log('(not jailed: section skipped)');
  } else {
    await place(JO.x - 35, JO.z - 11, 0);
    await adv(0.2);
    let caught = false;
    let chased = false;
    let maxDetect = 0;
    let chaseShot = false;
    for (let k = 0; k < 120 && !caught; k++) {
      await adv(0.25);
      j = await ji();
      maxDetect = Math.max(maxDetect, j.detect);
      chased = chased || j.chased;
      caught = j.catches > 0;
      if (chased && k % 8 === 0 && !chaseShot) {
        const g = j.guards.find((x) => x.state === 'chase');
        if (g) {
          await aimAt(JO.x + g.x, 1.3, JO.z + g.z);
          await shot('a9-guard-chase');
          chaseShot = true;
        }
      }
    }
    const det = await H(() => document.querySelector('.detect')?.className ?? '');
    check('out of the cell in the corridor: a guard grows suspicious, gives chase', chased && maxDetect >= 1, `detect ${maxDetect.toFixed(2)} ${det}`);
    check('caught → back in the cell, still jailed', caught && j.jailed && j.zone === 'cell', `${j.zone} catches ${j.catches}`);
    check('guards back to patrol after the catch', j.guards.every((g) => g.state !== 'chase'));
    const n0 = await nav();
    check('short freeze after the catch: no interaction prompt', n0.prompt === null || !/bail/i.test(n0.prompt), n0.prompt);
    await adv(1.5);
    await place(JO.x - 40.5, JO.z - 16.9, Math.PI);
    await adv(0.3);
    const n = await nav();
    check('cell phone: bail prompt', /bail/i.test(n.prompt ?? ''), n.prompt);
    const pr0 = await prog();
    await key('KeyE');
    await adv(1);
    const pr = await prog();
    j = await ji();
    const p = await pi();
    check('bail posted → out, no wanted level, bail deducted', !j.jailed && pr.jail === null && p.stars === 0 && pr.credits === pr0.credits - pr0.jail.bail, `${pr0.credits} → ${pr.credits}`);
  }
}

// --- 7. Loaner + break-out
if (want('arrest') && want('breakout')) {
  console.log('--- loaner, break the car out');
  await H((p) => window.__cityRacer.setProgress(p), { ...(await prog()), impound: { pip: 700 }, jail: null });
  await H(() => window.__cityRacer.startLevel(0));
  await adv(2);
  let c = await ci();
  check('mission with the own car impounded → stock loaner (kestrel), impound kept', c.own.vehicleId === 'kestrel' && (await prog()).impound.pip === 700 && (await prog()).car === 'pip', c.own.vehicleId);
  await H(() => window.__cityRacer.startLevel(-1));
  await adv(2);
  c = await ci();
  const lot = (await nav()).pois.find((x) => x.kind === 'impound');
  check('back in free roam: the own pip is at the impound lot', c.own.vehicleId === 'pip' && Math.hypot(c.own.x - lot.x, c.own.z - lot.z) < 40);
  let prompt = null;
  for (const side of [1, -1]) {
    await place(c.own.x + side * 2.0, c.own.z, 0);
    await adv(0.3);
    prompt = (await nav()).prompt;
    if (/Break/i.test(prompt ?? '')) break;
    await place(c.own.x, c.own.z + side * 2.0, 0);
    await adv(0.3);
    prompt = (await nav()).prompt;
    if (/Break/i.test(prompt ?? '')) break;
  }
  check('at the impounded car: break-out prompt with the risk', /Break your car out/i.test(prompt ?? ''), prompt);
  await key('KeyE');
  await adv(2.5);
  c = await ci();
  const p = await pi();
  const pr = await prog();
  check('enter → driving the own car, impound record cleared, wanted ≥2★', c.state === 'driving' && c.driven.own && !pr.impound.pip && p.stars >= 2, `${c.state} ${p.stars}★`);
  await shot('a10-breakout');
}

// --- 8. The other escape routes, walked for real (each from a fresh sentence)
const sentence = async (checkpoint) => {
  await H(([p, cp]) => {
    const g = window.__cityRacer;
    g.setProgress({ ...p, jail: { checkpoint: cp, bail: 1000, items: [] } });
    g.startLevel(-1);
  }, [await prog(), checkpoint]);
  await adv(1.5);
  const j = await ji();
  JO = j.origin;
  return j;
};
if (want('routes')) {
  console.log('--- key route: yard time, keycard, security door, front gate');
  let j = await sentence(0);
  check('sentence → in the cell', j.jailed && j.zone === 'cell');
  await walkTo(-39.2, -16, 8);
  check('cell door: yard time prompt', /yard/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  await key('KeyE');
  let t = 0;
  for (; t < 40 && !(await ji()).doors.cell; t += 0.5) await adv(0.5);
  j = await ji();
  check('the corridor guard walks over and opens the cell for yard time', j.doors.cell && j.yard > 0, `${t.toFixed(1)} s, yard ${j.yard.toFixed(0)} s`);
  // From here the guards are parked (held) so the walk itself is tested: real doors / walls / furniture.
  await H(() => window.__cityRacer.qaJailGuardsAway());
  for (const [x, z] of [[-36.2, -16], [-35, -12.2], [-31, -12], [-27, -13.5], [-24, -14.2]]) await walkTo(x, z, 25);
  check('walked out of the cell, along the corridor, into the office', (await ji()).zone === 'office', (await ji()).zone);
  check('keycard prompt at the desk', /keycard/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  await key('KeyE');
  await adv(1);
  j = await ji();
  check('keycard taken (saved)', j.items.includes('keycard') && (await prog()).jail?.items.includes('keycard'));
  for (const [x, z] of [[-27, -13.5], [-31, -12], [-35, -12], [-35, 6.6]]) await walkTo(x, z, 30);
  check('security door: swipe prompt', /Swipe/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  await key('KeyE');
  await adv(0.4);
  check('security door opens with the card', (await ji()).doors.security);
  for (const [x, z] of [[-35, 10], [-26, 15], [-20, 20], [-20, 23.5]]) await walkTo(x, z, 30);
  await adv(0.5);
  j = await ji();
  let p = await pi();
  check('sally port → front gate → escaped, back in the city with a wanted level', !j.jailed && (await prog()).jail === null && p.stars >= 1, `jailed ${j.jailed} ${p.stars}★`);

  console.log('--- power-cut route: breaker, staff door, common room, yard gate');
  j = await sentence(1);
  check('checkpoint 1 sentence → maintenance room', j.jailed && j.zone === 'maintenance', j.zone);
  await H(() => window.__cityRacer.qaJailGuardsAway());
  await walkTo(-44.4, 5, 10);
  check('breaker prompt', /power/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  await key('KeyE');
  await adv(3);
  j = await ji();
  check('power cut: cameras off, electric yard gate open', j.power > 0 && j.doors.yardGate, `power ${j.power.toFixed(0)} s`);
  await walkTo(-39.3, 3, 10);
  check('staff door prompt (inside)', /staff door/i.test((await nav()).prompt ?? ''), (await nav()).prompt);
  await key('KeyE');
  await adv(0.4);
  check('staff door opens from the maintenance side', (await ji()).doors.staff);
  const t0 = (await ji()).power;
  for (const [x, z] of [[-36, 3], [-34, 0], [-29, 0], [-21, 0], [-14, -5], [-7, -1], [-2, 0], [20, 0], [38, 0], [42.5, 0]]) await walkTo(x, z, 30, 0.8, true);
  await adv(0.5);
  j = await ji();
  p = await pi();
  check('ran through the common room and the yard, out of the open gate → escaped', !j.jailed && (await prog()).jail === null && p.stars >= 1, `jailed ${j.jailed}, power left at the start of the run ${t0.toFixed(0)} s`);
}

// --- 9. Garage refuses a stolen car
if (want('garage')) {
  console.log('--- garage and a stolen car');
  await H((p) => { const g = window.__cityRacer; g.setProgress({ ...p, jail: null, impound: {} }); g.startLevel(-1); }, await prog());
  await adv(3);
  let c = await ci();
  const me = c.character;
  const parked = c.worldCars.filter((w) => w.state === 'parked' && w.active).sort((u, v) => Math.hypot(u.x - me.x, u.z - me.z) - Math.hypot(v.x - me.x, v.z - me.z))[0];
  for (const side of [1, -1]) {
    if (!parked) break;
    await place(parked.x + Math.sin(parked.yaw) * 1.9 * side, parked.z + Math.cos(parked.yaw) * 1.9 * side, 0);
    await adv(0.3);
    if (/Steal/i.test((await nav()).prompt ?? '')) break;
  }
  for (let k = 0; k < 3 && (await ci()).state !== 'driving'; k++) {
    await key('KeyE');
    await adv(2.5);
  }
  c = await ci();
  check('driving a stolen car', c.state === 'driving' && !c.driven.own, c.state);
  const own0 = c.own;
  const gp = (await nav()).pois.find((x) => x.kind === 'garage');
  await H(([i]) => window.__cityRacer.debugTeleport(i, 5.25), [gp.i]);
  await adv(0.6);
  const n = await nav();
  check('at the garage in the stolen car: garage prompt', n.poiPrompt === 'garage' || /garage/i.test(n.prompt ?? ''), `${n.poiPrompt} / ${n.prompt}`);
  await key('KeyE');
  await adv(0.3);
  c = await ci();
  const scr = await H(() => window.__cityRacer.snapshot().screen);
  const tt = await toast();
  check('the garage refuses the stolen car (no garage screen, still driving it, message)', scr !== 'garage' && c.state === 'driving' && !c.driven.own && /own car/i.test(tt), `screen ${scr}; ${tt}`);
  check('the owned car was not moved or changed', Math.hypot(c.own.x - own0.x, c.own.z - own0.z) < 0.5 && c.own.vehicleId === own0.vehicleId);
}

console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `  ${consoleErrors.slice(0, 5).join(' | ')}` : ''}`);
check('no console errors', consoleErrors.length === 0);
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
