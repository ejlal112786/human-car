/**
 * Garage setup in the real UI (browser): the −/+ buttons change the value shown, the save and the car's
 * physics; the setup survives a reload; "Factory setup" resets it.
 *   npm run build:qa && npx vite preview --mode qa --outDir dist-qa --port 4174
 *   node scripts/setup-qa.mjs [URL] [shotDir]
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const ready = async () => {
  await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
};
await page.goto(URL, { timeout: 180000 });
await ready();
await page.evaluate(() => window.__cityRacer.setProgress({ version: 2, campaign: 2, unlocked: 15, best: {}, credits: 0 }));
const gi = () => page.evaluate(() => window.__cityRacer.garageInfo());
const openGarage = async () => {
  await page.click('.screen-title [data-action="garage"]', { timeout: 60000 });
  await page.waitForSelector('.screen-garage .setup-row', { timeout: 60000 });
};
const valueText = (k) => page.textContent(`.screen-garage [data-setup-value="${k}"]`);
const press = async (k, d) => {
  await page.click(`.screen-garage [data-action="gsetup"][data-key="${k}"][data-delta="${d}"]`, { timeout: 60000 });
};

await openGarage();
const base = await gi();
check('garage shows the three setup rows with their factory values', (await page.locator('.screen-garage .setup-row').count()) === 3 && /2\.20 bar/.test(await valueText('tyrePressure')) && /100 % rate/.test(await valueText('springs')), `${await valueText('tyrePressure')} | ${await valueText('springs')} | ${await valueText('brakeBias')}`);
check('"Factory setup" is disabled while nothing is changed', await page.isDisabled('.screen-garage [data-action="gsetupreset"]'));

await press('springs', 1);
await press('springs', 1);
let g = await gi();
check('springs + + → 130 % shown, saved and applied to the car', /130 % rate/.test(await valueText('springs')) && g.progress.cars.kestrel.setup.springs === 2 && Math.abs(g.suspensionStiffness / base.suspensionStiffness - 1.3) < 0.01, `${await valueText('springs')}; stiffness ${base.suspensionStiffness.toFixed(1)} → ${g.suspensionStiffness.toFixed(1)}`);
check('the + button stops at the end of the range', await page.isDisabled('.screen-garage [data-action="gsetup"][data-key="springs"][data-delta="1"]'));
await press('tyrePressure', -1);
g = await gi();
check('tyre pressure − → 2.05 bar, more grip and rolling drag on the car', /2\.05 bar/.test(await valueText('tyrePressure')) && g.frictionSlipFront > base.frictionSlipFront && g.rollingResistance > base.rollingResistance, `grip ${base.frictionSlipFront.toFixed(3)} → ${g.frictionSlipFront.toFixed(3)}, rolling ${base.rollingResistance.toFixed(0)} → ${g.rollingResistance.toFixed(0)} N`);
await press('brakeBias', -1);
g = await gi();
const share = (x) => x.brakeImpulseFront / (x.brakeImpulseFront + x.brakeImpulseRear);
check('brake bias − → more rear brake, same total', share(g) < share(base) - 0.05 && Math.abs(g.brakeImpulseFront + g.brakeImpulseRear - base.brakeImpulseFront - base.brakeImpulseRear) < 0.01, `${(share(base) * 100).toFixed(0)} % → ${(share(g) * 100).toFixed(0)} % front; ${await valueText('brakeBias')}`);
if (SHOTS) {
  await page.locator('.screen-garage .upgrades.setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/setup-garage.png`, timeout: 120000 });
}

// Reload: the setup is in the save and is applied to the car again.
await page.reload({ timeout: 180000 });
await ready();
g = await gi();
check('after a reload the setup is still saved and applied', g.progress.cars.kestrel.setup.springs === 2 && g.progress.cars.kestrel.setup.tyrePressure === -1 && Math.abs(g.suspensionStiffness / base.suspensionStiffness - 1.3) < 0.01, JSON.stringify(g.progress.cars.kestrel.setup));
await openGarage();
await page.click('.screen-garage [data-action="gsetupreset"]', { timeout: 60000 });
g = await gi();
check('"Factory setup" resets the values, the save and the car', Object.values(g.progress.cars.kestrel.setup).every((v) => v === 0) && Math.abs(g.suspensionStiffness - base.suspensionStiffness) < 1e-6 && Math.abs(g.frictionSlipFront - base.frictionSlipFront) < 1e-6 && /100 % rate/.test(await valueText('springs')));

// Setup costs nothing.
check('setup changes cost no credits', g.progress.credits === 0, `${g.progress.credits} cr`);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
