/**
 * Browser check (QA build) of the pistol model + aim-down-sights, with real mouse input:
 *   sights view engages (camera at the eye, FOV zoom, body hidden from the eye camera, first-person pistol
 *   shown, HUD crosshair hidden), the rear and front sights sit on the view axis, spread tightens, shots
 *   are fired from the eye, the slide cycles and locks back on an empty magazine, casings are ejected,
 *   reload drops back to the shoulder view, a wall right in front tucks the gun and stops the shot at the wall,
 *   leaving the sights restores the third-person view, and the "Over shoulder" setting keeps the old aim.
 * Usage: node scripts/ads-qa.mjs [url]   (default http://localhost:4174/, needs the QA preview)
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4174/';
const SHOTS = process.env.ADS_SHOTS ?? '';
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const consoleErrors = [];

async function openGame(settings) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  if (settings) await ctx.addInitScript((s) => localStorage.setItem('city-racer.settings.v1', s), JSON.stringify(settings));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(URL, { timeout: 180000 });
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
  await page.evaluate(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 15, best: {}, credits: 0 }));
  await page.evaluate(() => window.__cityRacer.startLevel(-1));
  await page.evaluate(() => window.__cityRacer.qaAdvance(3));
  await page.mouse.move(480, 270);
  return page;
}

let page = await openGame(null);
const H = (f, a) => page.evaluate(f, a);
const adv = (s) => H((x) => window.__cityRacer.qaAdvance(x), s);
const ci = () => H(() => window.__cityRacer.crimeInfo());
const shot = async (name) => {
  if (!SHOTS) return;
  await H(() => window.__cityRacer.qaFreeze(true));
  await adv(0);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 }).catch((e) => console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`));
  await H(() => window.__cityRacer.qaFreeze(false));
};
const click = async () => {
  await page.mouse.down({ button: 'left' });
  await adv(0.05);
  await page.mouse.up({ button: 'left' });
};

// Open ground: step away from the car so nothing is right in front.
let c = await ci();
await H(([x, z]) => window.__cityRacer.qaPlaceCharacter(x, z, 0), [c.character.x, c.character.z]);
await adv(0.2);
await page.keyboard.press('Digit1');
await adv(0.8);
c = await ci();
check('pistol drawn: ready, third-person gun in the hand, hip crosshair', c.weapon.state === 'ready' && c.pose.gunVisible && c.hud.crosshair && !c.ads.viewModel);
await shot('ads-0-hip');

console.log('--- sights');
await page.mouse.down({ button: 'right' });
await adv(0.6);
c = await ci();
check('sights view: blend ≈ 1, FOV zoomed to ~40°', c.ads.blend > 0.98 && Math.abs(c.ads.fov - 40) < 1.5, `blend ${c.ads.blend.toFixed(3)} fov ${c.ads.fov.toFixed(1)}`);
check('   first-person pistol shown, third-person gun hidden, body not drawn to the eye camera', c.ads.viewModel && c.ads.firstPerson && !c.pose.gunVisible && c.ads.bodyColor === false);
check('   no HUD crosshair (the pistol sights are the reticle)', !c.ads.crosshair);
check('   rear and front sights lie on the view axis (< 3 mm off)', c.ads.rearOff >= 0 && c.ads.rearOff < 0.003 && c.ads.frontOff < 0.003, `rear ${(c.ads.rearOff * 1000).toFixed(2)} mm front ${(c.ads.frontOff * 1000).toFixed(2)} mm`);
check('   spread tighter than shoulder aim (≤ 0.0026 rad)', c.weapon.spread <= 0.0026 && c.weapon.sights > 0.98, c.weapon.spread.toFixed(4));
const cam = c.camera;
const eyeH = cam.y - c.character.y;
check('   camera at eye height next to the character (1.5–1.7 m up, < 0.3 m away)', eyeH > 1.5 && eyeH < 1.7 && Math.hypot(cam.x - c.character.x, cam.z - c.character.z) < 0.3, `h ${eyeH.toFixed(2)} d ${Math.hypot(cam.x - c.character.x, cam.z - c.character.z).toFixed(2)}`);
await shot('ads-1-sights');

console.log('--- firing down the sights');
const shots0 = c.shots;
// Frozen game loop: only qaAdvance moves time, so the 90 ms slide cycle can be sampled.
await H(() => window.__cityRacer.qaFreeze(true));
await page.mouse.down({ button: 'left' });
await H(() => window.__cityRacer.qaAdvance(2 / 60));
c = await ci();
await page.mouse.up({ button: 'left' });
await H(() => window.__cityRacer.qaAdvance(1 / 60));
await H(() => window.__cityRacer.qaFreeze(false));
check('round fired from the eye (shot sights blend 1), slide moving back right after the shot', c.shots === shots0 + 1 && c.lastShot.sights > 0.98 && c.ads.slide > 0.005, `slide ${(c.ads.slide * 1000).toFixed(1)} mm, ${c.lastShot.kind} ${c.lastShot.distance.toFixed(1)} m`);
await shot('ads-2-recoil');
await adv(0.3);
c = await ci();
check('   slide back in battery after the cycle, a casing is on its way / on the ground', c.ads.slide < 0.001 && c.ads.casings >= 1, `slide ${(c.ads.slide * 1000).toFixed(1)} mm casings ${c.ads.casings}`);
check('   the sights settle back on the axis after recoil', c.ads.rearOff < 0.003 && c.ads.frontOff < 0.003, `${(c.ads.rearOff * 1000).toFixed(2)} / ${(c.ads.frontOff * 1000).toFixed(2)} mm`);
// Empty the magazine.
for (let k = 0; k < 14 && (await ci()).weapon.mag > 0; k++) {
  await click();
  await adv(0.3);
}
c = await ci();
check('magazine empty: slide locked back (still in the sights view)', c.weapon.mag === 0 && c.ads.slide > 0.02 && c.ads.viewModel, `mag ${c.weapon.mag} slide ${(c.ads.slide * 1000).toFixed(1)} mm`);
await shot('ads-3-slide-locked');
await page.keyboard.press('KeyR');
await adv(0.4);
c = await ci();
check('reload: drops back to the shoulder view (reload animated in third person)', c.weapon.state === 'reloading' && !c.ads.viewModel && c.ads.blend < 0.4, `blend ${c.ads.blend.toFixed(2)}`);
await adv(1.6);
c = await ci();
check('   after the reload, still holding aim: back in the sights, slide forward', c.weapon.state === 'ready' && c.weapon.mag === 12 && c.ads.viewModel && c.ads.slide < 0.001);
await page.mouse.up({ button: 'right' });
await adv(0.5);
c = await ci();
check('aim released: third-person view, body drawn again, hand gun visible, hip crosshair back', c.ads.blend < 0.02 && !c.ads.viewModel && !c.ads.firstPerson && c.ads.bodyColor === true && c.pose.gunVisible && c.hud.crosshair);

console.log('--- wall in front');
// Nearest building wall: scan 16 directions from the character.
c = await ci();
const wall = await H(([x0, z0]) => {
  let best = null;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    for (let d = 1; d < 45; d += 0.2) {
      const x = x0 + Math.sin(a) * d;
      const z = z0 + Math.cos(a) * d;
      if (window.__cityRacer.buildingAt(x, z)) {
        if (!best || d < best.d) best = { x, z, a, d };
        break;
      }
    }
  }
  return best;
}, [c.character.x, c.character.z]);
check('found a building wall to test against', !!wall, wall ? `${wall.d.toFixed(1)} m` : '');
await H(([x, z, y]) => window.__cityRacer.qaPlaceCharacter(x, z, y), [wall.x - Math.sin(wall.a) * 2.5, wall.z - Math.cos(wall.a) * 2.5, wall.a]);
await adv(0.2);
await H(([x, y, z]) => window.__cityRacer.qaAimAt(x, y, z), [wall.x, 1.55, wall.z]);
await page.mouse.down({ button: 'right' });
await adv(0.5);
// Walk into the wall while aiming (the capsule stops against it).
await page.keyboard.down('KeyW');
await adv(2.5);
await page.keyboard.up('KeyW');
await H(([x, y, z]) => window.__cityRacer.qaAimAt(x, y, z), [wall.x, 1.6, wall.z]);
await adv(0.3);
c = await ci();
check('face against a wall: the pistol is tucked back (never pokes through)', c.ads.tuck > 0.3, `tuck ${c.ads.tuck.toFixed(2)}`);
await shot('ads-4-tuck');
await click();
await adv(0.2);
c = await ci();
check('   a shot hits the wall right in front (the ray starts at the eye, not beyond the wall)', c.lastShot.kind === 'world' && c.lastShot.distance < 0.6, `${c.lastShot.kind} ${c.lastShot.distance.toFixed(2)} m`);
await page.mouse.up({ button: 'right' });
await adv(0.4);

console.log('--- leave the sights when getting into a car');
await page.mouse.down({ button: 'right' });
await adv(0.5);
await page.keyboard.press('Digit1');
await adv(0.8);
c = await ci();
check('holstering while aiming leaves the sights view', c.weapon.state === 'holstered' && !c.ads.viewModel && !c.ads.firstPerson && c.ads.bodyColor === true);
await page.mouse.up({ button: 'right' });
await page.context().close();

console.log('--- "Over shoulder" setting');
page = await openGame({ aimView: 'shoulder' });
await page.keyboard.press('Digit1');
await adv(0.8);
await page.mouse.down({ button: 'right' });
await adv(0.6);
c = await ci();
check('aim view "Over shoulder": aiming keeps the third-person camera, crosshair and hand gun', c.weapon.aiming && c.ads.blend === 0 && !c.ads.viewModel && c.hud.crosshair && c.pose.gunVisible && c.weapon.spread < 0.01);
await shot('ads-5-shoulder');
await page.mouse.up({ button: 'right' });

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
