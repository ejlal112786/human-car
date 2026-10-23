/**
 * Resource / allocation audit for City Racer (real Chromium + WebGL).
 * Like browser-qa.mjs it needs the automated-test hook (window.__cityRacer), so run it against
 * the dev server (http://localhost:5173/) or the QA build (npm run build:qa && npm run preview:qa,
 * http://localhost:4174/). Release builds have no hook.
 *
 *   npm run test:resources -- http://localhost:5173/
 *
 * What it checks:
 *  1. GPU resources stay flat. After one warm-up cycle, four more cycles of the Obstacle
 *     Course mission (walk to the car, get in, drive into the slalom cones + handbrake skids,
 *     reset (R), get out and walk, get back in, pause, quality low -> medium -> high via the
 *     pause-menu Settings, restart the mission) must leave renderer.info geometries, textures
 *     and shader programs exactly unchanged.
 *  2. JS heap stays flat. The heap after forced GC may grow by at most 3 MB over those cycles.
 *  3. Physics step budget. Each fixed step may allocate at most 16 kB (the stock Rapier
 *     World.step() allocated ~137 kB per step in this city; see PhysicsWorld.step).
 *     Step time is reported but not asserted because it depends on the machine.
 *  4. No shadow-pass program churn. During steady-state driving at High quality, three.js must
 *     not rebuild material parameters (WebGLPrograms.getParameters) at all. Instanced
 *     shadow casters have their own depth materials (see world/Props.ts).
 *
 * Software-rendered browsers (SwiftShader) give valid allocation and leak numbers, but their
 * timings say nothing about GPU performance.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5173/';
const results = []; const errors = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('.screen-title [data-action="play"]:not([disabled])', { timeout: 120000 });
if (!(await page.evaluate(() => typeof window.__cityRacer?.qaAdvance === 'function'))) {
  console.error('FAIL  window.__cityRacer test hook missing: use the dev server or the QA build.');
  await browser.close(); process.exit(1);
}

const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
const hook = (fn, arg) => page.evaluate(fn, arg);
const adv = (s) => hook((x) => window.__cityRacer.qaAdvance(x), s);
const snap = () => hook(() => window.__cityRacer.snapshot());
const info = () => hook(() => window.__cityRacer.renderInfo());
const frames = (n) => hook((k) => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const heapAfterGC = async () => { for (let i = 0; i < 3; i++) await hook(() => window.gc?.()); return hook(() => performance.memory?.usedJSHeapSize ?? 0); };
// Obstacle Course: car parked at track sample 701, 3.5 m right of the centre line.
const CAR = { i: 701, off: 3.5 };
const toDoor = () => hook(([i, off]) => window.__cityRacer.debugTeleportCharacter(i, off), [CAR.i, CAR.off - 2.3]);
async function getIn() {
  // Park the car back at its mission start (it may have been driven / reset), then walk up to it.
  await hook(([i, off]) => window.__cityRacer.debugTeleport(i, off), [CAR.i, CAR.off]); await adv(0.3);
  await toDoor(); await adv(0.1);
  await page.keyboard.press('KeyE'); await adv(1.4);
  const s = await snap();
  if (s.state !== 'driving') throw new Error(`expected driving, got ${s.state}`);
}

await hook(() => window.__cityRacer.setProgress({ unlocked: 5, best: {}, paint: 'red' }));
await hook(() => window.__cityRacer.startLevel(2));
await adv(0.3);
await getIn();

async function cycle() {
  // Drive into the slalom (cones get knocked → pooled physics bodies move), then lock the
  // rear wheels so skid-mark geometry and tyre smoke get written.
  await page.keyboard.down('KeyW'); await adv(2.5);
  await page.keyboard.down('Space'); await adv(1.0);
  await page.keyboard.up('Space'); await page.keyboard.up('KeyW');
  await frames(2);
  await page.keyboard.press('KeyR'); await adv(0.6); await frames(2);
  // Get out, walk a few steps (footsteps, animation mixer), get back in.
  await page.keyboard.press('KeyE'); await adv(0.8);
  if ((await snap()).state !== 'onFoot') throw new Error('expected onFoot after exit');
  await page.keyboard.down('KeyW'); await adv(1.0); await page.keyboard.up('KeyW');
  await getIn();
  // Every quality preset is rendered at least once (pause → Settings), then the mission restarts.
  await page.keyboard.press('Escape'); await page.waitForSelector('.screen-pause:not(.hidden)');
  await page.click('.screen-pause [data-action="settings"]');
  for (const q of ['low', 'medium', 'high']) { await page.click(`.screen-settings button[data-seg="quality"][data-value="${q}"]`); await frames(2); }
  await page.click('.screen-settings [data-action="back"]');
  await page.click('.screen-pause [data-action="restart"]');
  await adv(0.3); await frames(3);
  const s = await snap();
  if (s.state !== 'onFoot' || s.mission.obstaclesDisplaced !== 0) throw new Error(`expected a fresh mission on foot, got ${s.state} displaced=${s.mission.obstaclesDisplaced}`);
  await getIn();
}

// 1 + 2: GPU resources and heap across cycles
await cycle();
const base = await info(); const heap0 = await heapAfterGC();
for (let i = 0; i < 4; i++) await cycle();
const after = await info(); const heap1 = await heapAfterGC();
const fmt = (o) => `geo ${o.geometries} tex ${o.textures} prog ${o.programs}`;
check('GPU geometries/textures/programs unchanged after 4 restart/reset/quality cycles',
  base.geometries === after.geometries && base.textures === after.textures && base.programs === after.programs,
  `${fmt(base)} -> ${fmt(after)}`);
const growth = (heap1 - heap0) / 1048576;
check('JS heap after GC grows < 3 MB over 4 cycles', heap0 > 0 && growth < 3, `${(heap0 / 1048576).toFixed(1)} MB -> ${(heap1 / 1048576).toFixed(1)} MB (${growth >= 0 ? '+' : ''}${growth.toFixed(2)} MB)`);

// 3: physics step budget (600 fixed steps per qaAdvance(10))
await page.keyboard.down('KeyW'); await adv(1);
const times = [];
for (let i = 0; i < 3; i++) times.push(await hook(() => { const t = performance.now(); window.__cityRacer.qaAdvance(10); return performance.now() - t; }));
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
const steps0 = (await snap()).physicsSteps;
await adv(10);
const steps = (await snap()).physicsSteps - steps0;
const { profile: stepProfile } = await cdp.send('HeapProfiler.stopSampling');
await page.keyboard.up('KeyW');
let stepBytes = 0; (function walk(n) { stepBytes += n.selfSize; n.children.forEach(walk); })(stepProfile.head);
const counts = (await snap()).physicsCounts;
const bytesPerStep = Math.round(stepBytes / Math.max(1, steps));
check('physics step allocates < 16 kB per fixed step', steps >= 590 && bytesPerStep < 16384,
  `${bytesPerStep} B/step over ${steps} steps; ${(Math.min(...times) / 600 * 1000).toFixed(0)} µs/step incl. vehicle + game logic (not asserted); ${counts?.bodies} bodies / ${counts?.colliders} colliders`);

// 4: no material parameter rebuilds during steady-state rendering
await page.keyboard.press('KeyR'); await adv(0.5);
await frames(10);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await frames(20);
const { profile: frameProfile } = await cdp.send('HeapProfiler.stopSampling');
let frameBytes = 0; let paramBytes = 0;
(function walk(n, inParams) {
  const here = inParams || /getParameters/.test(n.callFrame.functionName);
  frameBytes += n.selfSize; if (here) paramBytes += n.selfSize;
  n.children.forEach(c => walk(c, here));
})(frameProfile.head, false);
check('no per-frame shader parameter rebuilds (shadow pass) at High quality', paramBytes === 0,
  `getParameters ${paramBytes} B over 20 frames; total ${(frameBytes / 20 / 1024).toFixed(0)} kB/frame (mostly three.js uniform upload)`);

// 5: draw-call budget (merged car models; instanced city). Worst case = Street Race with 3 rivals.
const calls = {};
for (const [name, lv] of [['free roam', -1], ['street race', 4]]) {
  await hook((l) => window.__cityRacer.startLevel(l), lv);
  await adv(0.2);
  await hook(() => window.__cityRacer.snapCamera());
  calls[name] = (await info()).calls;
}
check('draw calls within budget (free roam <= 200, 4-car race <= 250)', calls['free roam'] <= 200 && calls['street race'] <= 250, JSON.stringify(calls));
check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'none');
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} resource checks passed`);
process.exit(failed ? 1 : 0);
