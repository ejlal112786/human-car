/**
 * Weather, surfaces and tyre wear in the real game (browser, QA build):
 *   npm run build:qa && npx vite preview --mode qa --outDir dist-qa --port 4174
 *   node scripts/weather-qa.mjs [URL] [shotDir]
 * Settings → Weather changes the free-roam weather; storm / fog show rain, puddles, wet asphalt and fog and
 * shorten police sight; grass under the wheels is detected; missions stay dry; tyre wear is saved, survives a
 * reload and the garage sells a new set.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:4174/';
const SHOTS = process.argv[3] ?? '';
let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
  if (ok) passes++;
  else failures++;
};
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const ready = async () => {
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
};
const wi = () => page.evaluate(() => window.__cityRacer.weatherInfo());
const adv = (s) => page.evaluate((x) => window.__cityRacer.qaAdvance(x), s);
const shot = async (name) => {
  if (!SHOTS) return;
  await page.evaluate(() => window.__cityRacer.qaFreeze(true));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 });
  await page.evaluate(() => window.__cityRacer.qaFreeze(false));
};

await page.goto(URL, { timeout: 180000 });
await ready();
await page.evaluate(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 15, best: {}, credits: 2000 }));

// --- Settings → Weather (title screen)
await page.click('.screen-title [data-action="settings"]', { timeout: 60000 });
await page.waitForSelector('.settings-panel [data-seg="weather"]', { timeout: 60000 });
check('settings show a Weather row with six choices, "Changing" selected by default', (await page.locator('.settings-panel [data-seg="weather"]').count()) === 6 && (await page.getAttribute('.settings-panel [data-seg="weather"][data-value="dynamic"]', 'aria-checked')) === 'true');
await page.click('.settings-panel [data-seg="weather"][data-value="rain"]');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('city-racer.settings.v1') ?? '{}').weather);
let w = await wi();
check('choosing Rain saves the setting and sets the weather', stored === 'rain' && w.mode === 'rain' && w.kind === 'rain', `stored ${stored}, mode ${w.mode}`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/weather-settings.png`, timeout: 120000 });
await page.keyboard.press('Escape');

// --- Free roam in a storm
await page.evaluate(() => window.__cityRacer.startLevel(-1));
await adv(1);
w = await wi();
check('free roam: the cars drive on the weather-aware surface', w.carHasSurface === true);
await page.evaluate(() => window.__cityRacer.qaWeather('storm', true));
await adv(1);
w = await wi();
check('storm: rain and puddles are shown, the asphalt looks wet', w.rainVisible && w.puddlesVisible && w.asphaltRoughness < 0.6, `rain ${w.rainVisible}, puddles ${w.puddlesVisible}, roughness ${w.asphaltRoughness.toFixed(2)}`);
check('storm: fog closes in and police sight shrinks with the visibility', w.fogFar < 800 && w.sightScale < 0.75 && Math.abs(w.sightScale - w.visibility) < 1e-6, `fog far ${w.fogFar.toFixed(0)} m, sight ×${w.sightScale.toFixed(2)}`);
check('storm: the car on a soaked road has less grip than in the dry', w.gripScale.every((g) => g < 0.85) && w.surface.every((s) => s === 'road'), `grip ${w.gripScale.map((g) => g.toFixed(2)).join('/')}, ${w.surface.join('/')}`);
const hudWeather = await page.textContent('.loc-weather');
check('HUD names the weather and the road state', /Heavy rain/.test(hudWeather ?? '') && /(standing water|wet road)/.test(hudWeather ?? ''), hudWeather ?? '');
check('HUD tyre widget shows four tyres with a temperature state', (await page.locator('.tyres .ty[data-state]').count()) === 4);
await shot('weather-storm');

await page.evaluate(() => window.__cityRacer.qaWeather('fog', true));
await adv(1);
w = await wi();
check('fog: thick fog (short fog distance, police see about a third as far)', w.fogFar < 200 && w.sightScale < 0.4 && !w.rainVisible, `fog far ${w.fogFar.toFixed(0)} m, sight ×${w.sightScale.toFixed(2)}`);
await shot('weather-fog');

await page.evaluate(() => window.__cityRacer.qaWeather('clear', true));
await adv(1);
w = await wi();
// Grip on the dry road is the tyres' own (tyres that cooled in the storm's colder air sit just under their window).
check('clear: no rain, dry road, full visibility, asphalt grip back to (almost) full', !w.rainVisible && !w.puddlesVisible && w.wetness === 0 && w.fogFar === 1500 && w.gripScale.every((g) => g > 0.97), `fog far ${w.fogFar}, grip ${w.gripScale.map((g) => g.toFixed(3)).join('/')}, tyres ${w.tyreTemp.map((t) => t.toFixed(0)).join('/')} °C`);

// Grass: park the car beside the pavement.
await page.evaluate(() => window.__cityRacer.debugTeleport(300, 16));
await adv(1.5);
w = await wi();
check('grass beside the road is detected under the wheels (about half the grip)', w.surface.every((s) => s === 'grass') && w.gripScale.every((g) => g < 0.65), `${w.surface.join('/')} grip ${w.gripScale.map((g) => g.toFixed(2)).join('/')}`);

// --- Missions are always dry and clear.
await page.evaluate(() => window.__cityRacer.qaWeather('storm', true));
await page.evaluate(() => window.__cityRacer.startLevel(0));
await adv(1);
w = await wi();
check('missions: dry road and no rain even while free roam has a storm', !w.carHasSurface && !w.rainVisible && !w.puddlesVisible && w.fogFar === 1500 && w.sightScale === 1 && w.label === '', `surface ${w.carHasSurface}, rain ${w.rainVisible}, fog far ${w.fogFar}`);
await page.evaluate(() => window.__cityRacer.startLevel(-1));
await adv(1);
w = await wi();
check('back in free roam the storm is still there', w.kind === 'storm' && w.rainVisible, w.kind);

// --- Tyre wear: saved while driving, survives a reload, garage sells a new set.
await page.evaluate(() => window.__cityRacer.qaTyres(0.4));
await adv(11);
let g = await page.evaluate(() => window.__cityRacer.garageInfo());
const saved = g.progress.cars.kestrel.tyreWear;
check('tyre wear is written to the save while playing (every 10 s)', saved.every((x) => Math.abs(x - 0.4) < 0.02), saved.join('/'));
await page.reload({ timeout: 180000 });
await ready();
w = await wi();
check('after a reload the car has the same worn tyres', w.tyreWear.every((x) => Math.abs(x - 0.4) < 0.02), w.tyreWear.map((x) => x.toFixed(3)).join('/'));
await page.click('.screen-title [data-action="garage"]', { timeout: 60000 });
await page.waitForSelector('.screen-garage [data-action="gtyres"]', { timeout: 60000 });
const rowText = await page.textContent('.screen-garage .tyre-row');
check('garage shows the worn tyres and a price for a new set', /40% worn/.test(rowText ?? '') && /New tyres/.test(rowText ?? ''), (rowText ?? '').replace(/\s+/g, ' ').trim());
if (SHOTS) await page.screenshot({ path: `${SHOTS}/weather-garage-tyres.png`, timeout: 120000 });
const before = (await page.evaluate(() => window.__cityRacer.garageInfo())).progress.credits;
await page.click('.screen-garage [data-action="gtyres"]');
g = await page.evaluate(() => window.__cityRacer.garageInfo());
w = await wi();
check('New tyres: paid, wear back to 0 in the save and on the car, the row disappears', g.progress.credits === before - 400 && g.progress.cars.kestrel.tyreWear.every((x) => x === 0) && w.tyreWear.every((x) => x === 0) && (await page.locator('.screen-garage .tyre-row').count()) === 0, `${before} → ${g.progress.credits} cr`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
