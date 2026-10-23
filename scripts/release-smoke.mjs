/**
 * Release smoke test for the PRODUCTION build in dist/ (the folder you upload to Vercel).
 *
 * The release build has no test hook, so this plays the game like a player would:
 * real Chromium + WebGL, real key presses and clicks, assertions on the visible DOM only.
 * The on-screen mission timer is used as the simulation clock (software-rendered browsers
 * run at a few FPS, so wall-clock sleeps would be meaningless).
 *
 *   npm run build
 *   npm run test:release                            # serves dist/ under a nested sub-path itself
 *   npm run test:release -- http://localhost:4173/  # additionally checks a running `npm run preview`
 *
 * Setup (Playwright is intentionally NOT a project dependency):
 *   npm i --no-save playwright && npx playwright install --with-deps chromium
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const DIST = resolve(process.env.DIST || 'dist'); // DIST=<folder> to test another copy (e.g. an extracted zip)
const SUBPATH = '/nested/sub-path/city-racer/';
const PORT = Number(process.env.SMOKE_PORT || 8099);
const SHOTS = process.env.SHOTS || 'qa-shots/release';
const extraUrls = process.argv.slice(2);
mkdirSync(SHOTS, { recursive: true });

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(1);
}

// --- Minimal static host that serves dist/ ONLY under SUBPATH (anything else is a 404 and is
// recorded, so a root-absolute asset URL would be caught).
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
const outside = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(SUBPATH)) {
    if (path !== '/favicon.ico') outside.push(path);
    res.writeHead(404).end('not found');
    return;
  }
  let file = normalize(join(DIST, path.slice(SUBPATH.length)));
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const shot = async (page, name) => {
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 90000 });
  } catch (e) {
    console.log(`(screenshot ${name} skipped: ${e.message.split('\n')[0]})`);
  }
};

async function openGame(url, label, viewport = { width: 800, height: 450 }) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  const requests = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    requests.push(r.url());
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  const t0 = Date.now();
  // `?qa` is appended on purpose: it used to enable the test hook and must now do nothing.
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}qa=1`, { waitUntil: 'load' });
  await page.waitForSelector('.screen-title [data-action="play"]:not([disabled])', { timeout: 120000 });
  check(`[${label}] loads; PLAY becomes available`, true, `${((Date.now() - t0) / 1000).toFixed(1)}s, ${requests.length} requests`);
  const hook = await page.evaluate(() => {
    const suspicious = [];
    for (const k of Object.getOwnPropertyNames(window)) {
      if (/racer|^__qa|qaadvance|teleport/i.test(k)) suspicious.push(k);
      try {
        const v = window[k];
        if (v && typeof v === 'object' && ['qaAdvance', 'qaFreeze', 'debugTeleport', 'debugFlip', 'snapshot', 'startLevel', 'setProgress'].some((m) => typeof v[m] === 'function')) suspicious.push(`${k}(controls)`);
      } catch {
        /* cross-origin or throwing getter */
      }
    }
    return { cityRacer: typeof window.__cityRacer, suspicious };
  });
  check(`[${label}] no test hook / teleport / time controls exposed (even with ?qa)`, hook.cityRacer === 'undefined' && hook.suspicious.length === 0, `__cityRacer=${hook.cityRacer} suspicious=[${hook.suspicious.join(', ')}]`);
  return { page, problems, requests };
}

/** Everything the player can see, read from the DOM. */
const ui = (page) =>
  page.evaluate(() => {
    const vis = (sel) => {
      const e = document.querySelector(sel);
      return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none';
    };
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
    const timer = txt('.m-timer');
    const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(timer);
    return {
      screen: document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null,
      hud: vis('.hud'),
      driving: vis('.hud .cluster'),
      speed: Number(txt('.speed')),
      gear: txt('.gear'),
      rpm: Number(txt('.rpm')),
      street: txt('.loc-name'),
      hb: !!document.querySelector('.ind-hb.on'),
      muted: !!document.querySelector('.hud-btn[data-action="mute"].off'),
      prompt: vis('.prompt') ? txt('.prompt span') : null,
      objective: txt('.m-objective'),
      title: txt('.m-title'),
      clock: m ? Number(m[1]) * 60 + Number(m[2]) : null,
      toast: txt('.toast'),
    };
  });
async function waitUi(page, pred, timeoutMs) {
  const t0 = Date.now();
  let h = await ui(page);
  while (!pred(h) && Date.now() - t0 < timeoutMs) {
    await sleep(200);
    h = await ui(page);
  }
  return { h, ok: pred(h), secs: (Date.now() - t0) / 1000 };
}
/**
 * Hold keys for `sim` seconds of game time, measured with the mission clock on the HUD.
 * Missions with a time limit count down, the others count up: elapsed time is |clock - start|.
 */
async function holdSim(page, keys, sim, wallMax = 240000) {
  const start = (await ui(page)).clock;
  for (const k of keys) await page.keyboard.down(k);
  const r = await waitUi(page, (x) => x.clock !== null && start !== null && Math.abs(x.clock - start) >= sim, wallMax);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  return r;
}
/** Mission 1 from the title: Play → briefing → Start → on foot. */
async function startMission1(page) {
  await page.click('.screen-title [data-action="play"]');
  await page.waitForSelector('.screen-briefing:not(.hidden) [data-action="start"]', { timeout: 20000 });
  await page.click('.screen-briefing [data-action="start"]');
  // Wait for the mission itself (panel filled, clock running), not just for the menus to close:
  // under software rendering the loading/fade frames in between can take a few seconds.
  return waitUi(page, (x) => x.hud && x.screen === null && x.title !== '' && x.clock !== null, 30000);
}
/**
 * Walk from the Mission 1 start to the parked car using real keys: forward along the pavement
 * (the car is ~16 m ahead, its passenger door 2.4 m towards the road), then sidestep left until
 * the "Get in" prompt appears.
 */
async function walkToCar(page) {
  await holdSim(page, ['KeyW'], 7.9);
  await page.keyboard.down('KeyA');
  const r = await waitUi(page, (x) => x.prompt !== null && /get in/i.test(x.prompt), 120000);
  await page.keyboard.up('KeyA');
  return r;
}

// ---------------------------------------------------------------- full test, served under a sub-path
{
  const label = `sub-path ${SUBPATH}`;
  const { page, problems, requests } = await openGame(`http://127.0.0.1:${PORT}${SUBPATH}`, label);
  let h = await ui(page);
  const title = await page.locator('.screen-title').innerText();
  check('title menu shown, HUD hidden', h.screen === 'title' && !h.hud, `screen=${h.screen} hud=${h.hud}`);
  check('title has Play, Missions, Free Roam, Garage, Settings, Credits', ['PLAY', 'MISSIONS', 'FREE ROAM', 'GARAGE', 'SETTINGS', 'CREDITS'].every((w) => title.toUpperCase().includes(w)), title.replace(/\n+/g, ' | '));
  const dev = await page.evaluate(() => /phase\s*\d|prototype|placeholder|debug|lorem|todo|qa build/i.exec(document.body.innerText)?.[0] ?? null);
  check('no development / phase / debug wording visible', dev === null, dev ?? 'none');
  await shot(page, '01-title');

  // Every menu screen opens and returns.
  for (const [action, screen] of [['levels', 'levels'], ['garage', 'garage'], ['settings', 'settings'], ['credits', 'credits']]) {
    await page.click(`.screen-title [data-action="${action}"]`);
    const a = (await ui(page)).screen;
    await page.click(`.screen-${screen} [data-action="back"]`);
    const b = (await ui(page)).screen;
    check(`${action} screen opens and Back returns`, a === screen && b === 'title', `${a} → ${b}`);
  }

  h = (await startMission1(page)).h;
  const clockAtStart = h.clock;
  check('Play → briefing → Start begins Mission 1 on foot', h.hud && !h.driving && /find your ride/i.test(h.title), `title="${h.title}" objective="${h.objective}" driving=${h.driving}`);
  check('mission clock runs on the HUD', h.clock !== null, `timer=${h.clock}`);
  await shot(page, '02-on-foot');

  // Walk to the car with real keys and get in.
  let r = await walkToCar(page);
  check('walking to the parked car shows the "Get in" prompt', r.ok, `prompt=${r.h.prompt} after ${r.secs.toFixed(1)}s wall-clock`);
  await page.keyboard.press('KeyE');
  r = await waitUi(page, (x) => x.driving, 60000);
  check('E gets in: driving HUD (speedometer) appears', r.ok && /park/i.test(r.h.objective), `objective="${r.h.objective}"`);
  await sleep(500);

  // Throttle (W): HUD speed, gear and rpm respond to the real simulation
  await page.keyboard.down('KeyW');
  r = await waitUi(page, (x) => x.speed >= 15, 90000);
  check('W accelerates (HUD speed rises, forward gear, rpm above idle)', r.ok && /^[1-6]$/.test(r.h.gear) && r.h.rpm > 1000, `speed=${r.h.speed}km/h gear=${r.h.gear} rpm=${r.h.rpm} after ${r.secs.toFixed(1)}s wall-clock`);
  check('HUD shows a street name', r.h.street.length > 2 && r.h.street !== '—', r.h.street);
  await shot(page, '03-driving');

  // Getting out at speed is refused.
  await page.keyboard.press('KeyE');
  await sleep(300);
  h = await ui(page);
  check('cannot get out while moving fast', h.driving, `driving=${h.driving} toast="${h.toast}"`);

  // Handbrake indicator while Space is held
  await page.keyboard.down('Space');
  r = await waitUi(page, (x) => x.hb, 10000);
  check('Space engages the handbrake (HUD indicator)', r.ok, `indicator=${r.h.hb}`);
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');

  // Brake (S) then reverse
  const vBefore = (await ui(page)).speed;
  await page.keyboard.down('KeyS');
  r = await waitUi(page, (x) => x.speed <= Math.max(0, vBefore - 8) || x.gear === 'R', 60000);
  check('S brakes', r.ok, `from ${vBefore} to ${r.h.speed}km/h`);
  r = await waitUi(page, (x) => x.gear === 'R' && x.speed >= 3, 120000);
  check('holding S at a standstill engages reverse', r.ok, `gear=${r.h.gear} speed=${r.h.speed}km/h after ${r.secs.toFixed(1)}s`);
  await page.keyboard.up('KeyS');

  // Pause / resume with Escape; HUD values must freeze while paused
  await page.keyboard.down('KeyW');
  await waitUi(page, (x) => x.gear !== 'R' && x.speed >= 8, 90000);
  await page.keyboard.press('Escape');
  await sleep(500);
  const p1 = await ui(page);
  await sleep(2500);
  const p2 = await ui(page);
  check('Escape pauses (pause menu shown, speed and clock frozen)', p1.screen === 'pause' && p1.speed === p2.speed && p1.clock === p2.clock, `screen=${p1.screen} speed ${p1.speed}->${p2.speed} clock ${p1.clock}->${p2.clock}`);
  await shot(page, '04-paused');
  await page.keyboard.press('Escape');
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyW'); // pause releases held keys; press again
  r = await waitUi(page, (x) => x.screen === null && x.clock !== p2.clock, 30000);
  check('Escape resumes and the simulation continues', r.ok, `screen=${r.h.screen} clock=${r.h.clock}`);
  await page.keyboard.up('KeyW');

  // HUD pause button + Resume button
  await page.click('.hud-btn[data-action="pause"]');
  await sleep(300);
  const q1 = await ui(page);
  await page.click('.screen-pause [data-action="resume"]');
  await sleep(300);
  const q2 = await ui(page);
  check('HUD pause button and Resume button work', q1.screen === 'pause' && q2.screen === null, `${q1.screen} -> ${q2.screen}`);

  // Reset (R) while moving
  await page.keyboard.down('KeyW');
  r = await waitUi(page, (x) => x.speed >= 10, 90000);
  await page.keyboard.up('KeyW');
  const beforeReset = r.h.speed;
  await page.keyboard.press('KeyR');
  r = await waitUi(page, (x) => x.speed === 0, 15000);
  check('R resets the car (speed back to 0)', beforeReset >= 10 && r.ok, `${beforeReset} -> ${r.h.speed}km/h gear=${r.h.gear}`);

  // Get out once stopped, then back in.
  await page.keyboard.down('Space');
  await waitUi(page, (x) => x.speed === 0, 20000);
  await page.keyboard.up('Space');
  await page.keyboard.press('KeyE');
  r = await waitUi(page, (x) => !x.driving && x.prompt !== null, 60000);
  check('E at a standstill gets out (on-foot HUD, "Get in" prompt next to the car)', r.ok, `driving=${r.h.driving} prompt=${r.h.prompt}`);
  await shot(page, '05-got-out');
  await page.keyboard.press('KeyE');
  r = await waitUi(page, (x) => x.driving, 60000);
  check('…and E gets back in', r.ok, `driving=${r.h.driving}`);

  // Sound toggle
  const m0 = (await ui(page)).muted;
  await page.keyboard.press('KeyM');
  await sleep(300);
  const m1 = (await ui(page)).muted;
  await page.keyboard.press('KeyM');
  await sleep(300);
  const m2 = (await ui(page)).muted;
  check('M toggles sound (HUD button state)', m1 === !m0 && m2 === m0, `${m0} -> ${m1} -> ${m2}`);

  // Restart from the pause menu: back on foot, clock reset
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.click('.screen-pause [data-action="restart"]');
  // The old state (no screen, on foot, old clock) is visible until the restart fade completes, so wait for the reset clock.
  r = await waitUi(page, (x) => x.screen === null && !x.driving && x.clock !== null && clockAtStart !== null && Math.abs(x.clock - clockAtStart) < 3, 30000);
  check('Restart (pause menu) restarts the mission on foot', r.ok, `driving=${r.h.driving} clock=${r.h.clock} after ${r.secs.toFixed(1)}s`);

  // Quit to the title
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.click('.screen-pause [data-action="quit"]');
  r = await waitUi(page, (x) => x.screen === 'title' && !x.hud, 15000);
  check('Quit returns to the title menu', r.ok, `screen=${r.h.screen} hud=${r.h.hud}`);

  // Resize
  await page.setViewportSize({ width: 1280, height: 720 });
  await sleep(1500);
  const c = await page.evaluate(() => {
    const e = document.querySelector('canvas.game-canvas').getBoundingClientRect();
    return { w: e.width, h: e.height, sy: window.scrollY };
  });
  check('canvas follows window resize; no page scroll', Math.abs(c.w - 1280) < 2 && Math.abs(c.h - 720) < 2 && c.sy === 0, `${c.w}x${c.h} scrollY=${c.sy}`);

  const base = `http://127.0.0.1:${PORT}${SUBPATH}`;
  const foreign = requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
  check('every request stayed under the sub-path (relative asset URLs, no third-party hosts)', foreign.length === 0 && outside.length === 0, `${requests.length} requests; outside=[${outside.concat(foreign).join(', ')}]`);
  check('character model (.glb) loaded from the bundle', requests.some((u) => /\/assets\/character-[\w-]+\.glb$/.test(u)), requests.filter((u) => u.endsWith('.glb')).join(', ') || 'none');
  check('no console errors, page errors, failed or 4xx/5xx requests', problems.length === 0, problems.slice(0, 5).join(' | ') || 'none');
  await page.close();
}

// ---------------------------------------------------------------- touch-only phone (emulated)
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}${SUBPATH}`, { waitUntil: 'load' });
  await page.waitForSelector('.screen-title [data-action="play"]:not([disabled])', { timeout: 120000 });
  await page.tap('.screen-title [data-action="play"]');
  await page.waitForSelector('.screen-briefing:not(.hidden) [data-action="start"]', { timeout: 20000 });
  await page.tap('.screen-briefing [data-action="start"]');
  const t = await page.waitForFunction(
    () => {
      const tc = document.querySelector('.touch-controls');
      return tc && !tc.classList.contains('hidden') ? { layout: tc.dataset.layout, stick: !!tc.querySelector('.tc-stick-zone'), run: !!tc.querySelector('.tc-run') } : null;
    },
    null,
    { timeout: 30000 },
  );
  const tv = await t.jsonValue();
  await shot(page, '06-phone-on-foot');
  check('touch-only phone: on-foot touch controls (joystick + run) shown after Start', tv.layout === 'foot' && tv.stick && tv.run && problems.length === 0, `${JSON.stringify(tv)} errors=${problems.length}`);
  await ctx.close();
}

// ---------------------------------------------------------------- resilience: focus loss, GPU context loss, crash guard
{
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  const glWarnings = []; // Chrome reports WebGL call errors (e.g. touching objects of a lost context) as warnings
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning' && /WebGL/i.test(m.text())) glWarnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  await page.goto(`http://127.0.0.1:${PORT}${SUBPATH}`, { waitUntil: 'load' });
  await page.waitForSelector('.screen-title [data-action="play"]:not([disabled])', { timeout: 120000 });
  await startMission1(page);

  // Window loses focus (alt-tab) -> auto-pause
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  let r = await waitUi(page, (x) => x.screen === 'pause', 10000);
  check('window blur auto-pauses the game', r.ok, `screen=${r.h.screen}`);
  await page.click('.screen-pause [data-action="resume"]');
  await waitUi(page, (x) => x.screen === null, 10000);

  // Tab hidden -> auto-pause
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  r = await waitUi(page, (x) => x.screen === 'pause', 10000);
  check('hidden tab (visibilitychange) auto-pauses the game', r.ok, `screen=${r.h.screen}`);
  await page.click('.screen-pause [data-action="resume"]');
  await waitUi(page, (x) => x.screen === null, 10000);

  // WebGL context loss and restore (WEBGL_lose_context is a standard browser extension)
  const noticeVisible = () => page.evaluate(() => !document.querySelector('.notice-screen').classList.contains('hidden'));
  await page.evaluate(() => {
    const gl = document.querySelector('canvas.game-canvas').getContext('webgl2');
    window.__smokeLoseCtx = gl.getExtension('WEBGL_lose_context');
    window.__smokeLoseCtx.loseContext();
  });
  let lost = false;
  for (let k = 0; k < 60 && !lost; k++) {
    await sleep(250);
    lost = await noticeVisible();
  }
  const lostUi = await ui(page);
  const lostTitle = await page.evaluate(() => document.querySelector('.notice-title').textContent);
  check('WebGL context loss: game pauses and shows a "restoring" notice', lost && lostUi.screen === 'pause', `notice=${lost} title="${lostTitle}" screen=${lostUi.screen}`);
  await page.keyboard.press('Escape');
  await sleep(500);
  const stillPaused = (await ui(page)).screen === 'pause';
  check('cannot resume while the context is lost', stillPaused && (await noticeVisible()), `paused=${stillPaused}`);
  await page.evaluate(() => window.__smokeLoseCtx.restoreContext());
  let restored = false;
  for (let k = 0; k < 120 && !restored; k++) {
    await sleep(250);
    restored = !(await noticeVisible());
  }
  r = await waitUi(page, (x) => x.screen === 'pause', 5000);
  check('context restore: notice closes, pause menu is back', restored && r.ok, `noticeHidden=${restored} screen=${r.h.screen}`);
  await page.click('.screen-pause [data-action="resume"]');
  const c0 = (await ui(page)).clock;
  r = await holdSim(page, ['KeyW'], 1.0, 90000);
  await sleep(1000);
  // Sample the rendered frame inside a rAF callback queued after the game's own (no preserveDrawingBuffer).
  const pix = await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => {
          const c = document.querySelector('canvas.game-canvas');
          const o = document.createElement('canvas');
          o.width = 64;
          o.height = 36;
          const g = o.getContext('2d');
          g.drawImage(c, 0, 0, 64, 36);
          const d = g.getImageData(0, 0, 64, 36).data;
          let min = 255;
          let max = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
            if (l < min) min = l;
            if (l > max) max = l;
          }
          done({ min, max });
        }),
      ),
  );
  await shot(page, '07-context-restored');
  check('after restore the game runs and renders again', r.ok && pix.max - pix.min > 60, `clock ${c0}→${r.h.clock}; luminance range=${pix.min.toFixed(0)}..${pix.max.toFixed(0)}`);
  check('no WebGL errors across context loss and restore (no stale GPU objects touched)', glWarnings.length === 0, glWarnings.slice(0, 2).join(' | ') || 'none');
  check('no page errors during focus/context tests', errors.filter((e) => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | ') || 'none');

  // Crash guard: make every WebGL draw call throw, as an unexpected runtime error would
  errors.length = 0;
  await page.evaluate(() => {
    const boom = () => {
      throw new Error('injected render failure (smoke test)');
    };
    WebGL2RenderingContext.prototype.drawElements = boom;
    WebGL2RenderingContext.prototype.drawArrays = boom;
    WebGL2RenderingContext.prototype.drawElementsInstanced = boom;
    WebGL2RenderingContext.prototype.drawArraysInstanced = boom;
  });
  let crash = null;
  for (let k = 0; k < 120 && !crash; k++) {
    await sleep(250);
    crash = await page.evaluate(() => {
      const e = document.querySelector('.error-screen');
      return e ? { title: e.querySelector('h2').textContent, detail: e.querySelector('.error-detail').textContent, reload: !!e.querySelector('button') } : null;
    });
  }
  const e1 = errors.length;
  await sleep(4000);
  const e2 = errors.length;
  const leftovers = await page.evaluate(() => ({ canvas: !!document.querySelector('canvas.game-canvas'), hud: !!document.querySelector('.hud') }));
  await shot(page, '08-crash-screen');
  check('runtime error in the game loop shows an error screen with Reload', !!crash && crash.title === 'The game stopped unexpectedly' && crash.detail.includes('injected render failure') && crash.reload, crash ? `"${crash.title}" / "${crash.detail}"` : 'no error screen');
  check('crash stops the loop (error logged once, no per-frame spam) and releases the game', e1 >= 1 && e1 <= 2 && e2 === e1 && !leftovers.canvas && !leftovers.hud, `console errors: ${e1} then ${e2}; canvas=${leftovers.canvas} hud=${leftovers.hud}`);
  await page.close();
}

// ---------------------------------------------------------------- optional: running preview server(s)
for (const url of extraUrls) {
  const { page, problems } = await openGame(url, url);
  const r = await startMission1(page);
  const r2 = await holdSim(page, ['KeyW'], 1.0, 90000);
  check(`[${url}] Play → Start → walking (mission clock running)`, r.ok && r2.ok, `clock=${r2.h.clock}`);
  check(`[${url}] no console errors, page errors or failed requests`, problems.length === 0, problems.slice(0, 5).join(' | ') || 'none');
  await page.close();
}

await browser.close();
server.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} release smoke checks passed`);
process.exit(failed ? 1 : 0);
