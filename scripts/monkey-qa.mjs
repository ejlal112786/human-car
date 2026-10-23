/**
 * Monkey test (headless Chromium, software WebGL, QA build): a seeded random player that clicks any
 * visible button and presses / holds game keys, checking invariants after every action:
 *   - no page errors, console errors or warnings; the crash screen never appears
 *   - car and character positions stay finite and above the ground
 *   - the game state is consistent with what is on screen (menus vs HUD, car vs on foot)
 *   - saved progress and settings stay valid JSON
 * With --touch it plays as a phone: emulated touch screen (size picked by the seed), every interaction is
 * real multitouch (CDP touch events: taps, joystick drags, several pedals held at once, camera swipes),
 * and it also checks that no touch input stays stuck once every finger is lifted and that the touch
 * layout matches the game state.
 * Usage: node scripts/monkey-qa.mjs [URL] [--seed=N] [--steps=N] [--touch]
 */
import { chromium } from 'playwright';

const URL = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'http://localhost:4174/';
const arg = (k, d) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] ?? d) || d;
const SEED = arg('seed', 1);
const STEPS = arg('steps', 200);
const TOUCH = process.argv.includes('--touch');

let s = SEED >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const PHONES = [
  { width: 844, height: 390 },
  { width: 740, height: 360 },
  { width: 390, height: 844 },
];
const VIEW = TOUCH ? PHONES[(SEED - 1 + PHONES.length * 100) % PHONES.length] : { width: 960, height: 540 };
const context = await browser.newContext(TOUCH ? { viewport: VIEW, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: VIEW });
const page = await context.newPage();
const cdp = TOUCH ? await context.newCDPSession(page) : null;
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => window.__cityRacer.qaFreeze(true));

const failures = [];
const log = [];
const statesSeen = new Map();
const screensSeen = new Map();
const actionsSeen = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const held = new Set();

// Active touch points (id → {x, y}); every dispatch lists the full set, like a real device.
const touches = new Map();
const points = () => [...touches.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }));
const tStart = async (id, x, y) => {
  touches.set(id, { x, y });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points() });
};
const tMove = async (id, x, y) => {
  touches.set(id, { x, y });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points() });
};
const tEnd = async (id) => {
  const p = touches.get(id);
  if (!p) return;
  touches.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }] });
};
let nextId = 1;
/** A press at a point: a finger tap in touch mode, a mouse click otherwise. */
async function tapAt(x, y) {
  if (!TOUCH) return page.mouse.click(x, y);
  const id = nextId++;
  await tStart(id, x, y);
  await page.waitForTimeout(50);
  await tEnd(id);
}

async function release() {
  for (const k of held) await page.keyboard.up(k);
  held.clear();
  for (const id of [...touches.keys()]) await tEnd(id);
}

/** Centre of the first visible element matching a selector, or null. */
const centerOf = (sel) =>
  H((q) => {
    const e = [...document.querySelectorAll(q)].find((x) => x.getBoundingClientRect().width > 2 && !x.closest('.hidden'));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);

/** Visible, enabled buttons anywhere on the page (menus, HUD, overlays). */
async function buttons() {
  return H(() => {
    const out = [];
    document.querySelectorAll('button').forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const st = getComputedStyle(b);
      if (b.disabled || r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.pointerEvents === 'none' || b.closest('.hidden')) return;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return;
      // Skip buttons covered by an overlay (a player could not press them either).
      const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      if (!top || (top !== b && !b.contains(top))) return;
      b.dataset.monkey = String(i);
      out.push({ id: String(i), x: r.left + r.width / 2, y: r.top + r.height / 2, label: (b.dataset.action ?? '') + ':' + (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) });
    });
    return out;
  });
}

async function invariants(step, action) {
  const st = await H(() => {
    const h = window.__cityRacer;
    const sn = h.snapshot();
    const crash = !!document.querySelector('.error-screen:not(.hidden), [data-screen="error"]:not(.hidden)') || /stopped unexpectedly/i.test(document.body.innerText);
    let saveOk = true;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('city-racer')) continue;
      try { JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { saveOk = false; }
    }
    const screen = document.querySelector('.screen:not(.hidden)')?.dataset.screen ?? null;
    return { sn, crash, saveOk, screen };
  });
  const { sn } = st;
  bump(statesSeen, sn.state);
  if (st.screen) bump(screensSeen, st.screen);
  const fin = (o) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));
  const bad = [];
  if (st.crash) bad.push('crash screen shown');
  if (!st.saveOk) bad.push('saved data is not valid JSON');
  if (!fin(sn.position) || !fin(sn.character)) bad.push(`non-finite position ${JSON.stringify(sn.position)} / ${JSON.stringify(sn.character)}`);
  if (sn.position.y < -3) bad.push(`car below the ground (y ${sn.position.y.toFixed(2)})`);
  if (sn.state === 'onFoot' && sn.character.y < -3) bad.push(`character below the ground (y ${sn.character.y.toFixed(2)})`);
  if (sn.state === 'driving' && sn.character.visible) bad.push('driving but the character is visible');
  if (sn.state === 'onFoot' && !sn.character.visible) bad.push('on foot but the character is hidden');
  if ((sn.state === 'driving' || sn.state === 'onFoot') && st.screen) bad.push(`playing with menu screen "${st.screen}" open`);
  if (sn.state === 'menu' && sn.hudVisible) bad.push('menu state with the HUD visible');
  if (TOUCH) {
    const t = sn.touch;
    // Getting in / out keeps the on-foot layout (no flicker during the short transition).
    const want = sn.state === 'driving' ? 'drive' : ['onFoot', 'entering', 'exiting'].includes(sn.state) ? 'foot' : null;
    if (want && !(t.visible && t.layout === want)) bad.push(`touch layout ${t.visible ? t.layout : 'hidden'} while ${sn.state}`);
    if (!want && t.visible) bad.push(`touch controls visible in state ${sn.state}`);
    if (touches.size === 0) {
      const stuck = Object.entries(t.holds ?? {}).filter(([, n]) => n > 0).map(([k]) => k);
      if (stuck.length || t.joyX !== 0 || t.joyY !== 0) bad.push(`touch input stuck with no finger down: holds [${stuck}] joy ${t.joyX},${t.joyY}`);
    }
  }
  if (errors.length) bad.push(...errors.splice(0));
  if (bad.length) failures.push({ step, action, state: sn.state, screen: st.screen, bad });
  return st;
}

const KEYS_DRIVE = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space'];
for (let step = 0; step < STEPS; step++) {
  const sn = await H(() => window.__cityRacer.snapshot());
  const playing = sn.state === 'driving' || sn.state === 'onFoot';
  let action;
  const r = rand();
  if (!playing || r < 0.18) {
    const bs = await buttons();
    if (bs.length && rand() < 0.85) {
      // Prefer navigation buttons (data-action) so option-heavy screens like Settings don't trap the walk.
      const nav = bs.filter((x) => !x.label.startsWith(':'));
      const b = nav.length && rand() < 0.7 ? pick(nav) : pick(bs);
      action = `click ${b.label}`;
      await release();
      // A real mouse click at the button centre (Playwright's "stable" wait needs page animation frames,
      // which software GL starves after long sessions; the button was already checked to be on top).
      await tapAt(b.x, b.y);
    } else if (TOUCH) {
      // No keyboard on a phone: tap somewhere random instead (empty space, the map, the HUD…).
      const x = Math.round(rand() * (VIEW.width - 1));
      const y = Math.round(rand() * (VIEW.height - 1));
      action = `tap ${x},${y}`;
      await release();
      await tapAt(x, y);
    } else {
      const k = pick(['Escape', 'Enter', 'KeyP', 'KeyM', 'KeyN']);
      action = `press ${k}`;
      await release();
      await page.keyboard.press(k);
    }
    await H(() => window.__cityRacer.qaAdvance(0.2));
  } else if (sn.state === 'onFoot' && r < 0.4) {
    // Coverage helper: walk up to the car's driver door (QA teleport), then try to get in.
    action = 'qa: to the car door + E';
    await release();
    await H(() => {
      const h = window.__cityRacer;
      const p = h.snapshot().position;
      let best = 0, bd = Infinity;
      for (let i = 0; i < 984; i++) { const t = h.trackPoint(i, 0); const d = (t.x - p.x) ** 2 + (t.z - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
      h.debugTeleportCharacter(best, h.snapshot().laneOffset - 2.3);
    });
    await H(() => window.__cityRacer.qaAdvance(0.2));
    if (TOUCH) {
      const c = await centerOf('.tc-interact');
      if (c) await tapAt(c.x, c.y);
      else action += ' (no interact button)';
    } else await page.keyboard.press('KeyE');
    await H(() => window.__cityRacer.qaAdvance(1.5));
  } else if (TOUCH && r < 0.32) {
    // Tap one of the on-screen buttons (touch controls, pause, map…).
    const bs = await buttons();
    const b = bs.length ? pick(bs) : null;
    action = b ? `tap ${b.label || '(icon)'}` : 'tap nothing';
    await release();
    if (b) await tapAt(b.x, b.y);
    await H(() => window.__cityRacer.qaAdvance(0.3));
  } else if (TOUCH) {
    // Several fingers at once: joystick or pedals, sometimes plus a camera swipe, held while the game runs.
    await release();
    const parts = [];
    const fingers = [];
    if (sn.state === 'onFoot') {
      const z = await centerOf('.tc-stick-zone');
      if (z) {
        const a = rand() * Math.PI * 2;
        const m = 20 + rand() * 70;
        fingers.push({ id: nextId++, x: z.x, y: z.y, mx: z.x + Math.cos(a) * m, my: z.y + Math.sin(a) * m });
        parts.push(`stick ${Math.round((a * 180) / Math.PI)}°`);
      }
      if (rand() < 0.25) {
        const j = await centerOf('.tc-jump');
        if (j) { fingers.push({ id: nextId++, x: j.x, y: j.y }); parts.push('jump'); }
      }
    } else {
      for (const k of ['gas', 'brake', 'left', 'right', 'handbrake']) {
        if (rand() < (k === 'gas' ? 0.65 : 0.3)) {
          const c = await centerOf(`[data-tc="${k}"]`);
          if (c) { fingers.push({ id: nextId++, x: c.x + (rand() - 0.5) * c.w * 0.5, y: c.y + (rand() - 0.5) * c.h * 0.5 }); parts.push(k); }
        }
      }
    }
    if (rand() < 0.3) {
      // Camera swipe on the upper middle of the screen (away from controls and HUD corners).
      const x = VIEW.width * (0.4 + rand() * 0.2), y = VIEW.height * 0.35;
      fingers.push({ id: nextId++, x, y, mx: x + (rand() - 0.5) * 160, my: y + (rand() - 0.5) * 40 });
      parts.push('swipe');
    }
    for (const f of fingers) await tStart(f.id, f.x, f.y);
    for (const f of fingers) if (f.mx !== undefined) { await tMove(f.id, (f.x + f.mx) / 2, (f.y + f.my) / 2); await tMove(f.id, f.mx, f.my); }
    const secs = Math.round((0.3 + rand() * 2.5) * 10) / 10;
    action = `hold ${parts.join('+') || 'nothing'} ${secs}s`;
    for (let t = 0; t < secs; t += 0.5) await H((x) => window.__cityRacer.qaAdvance(x), Math.min(0.5, secs - t));
    // Fingers lift in random order (sometimes one at a time with the game running in between).
    for (const f of fingers.sort(() => rand() - 0.5)) {
      await tEnd(f.id);
      if (rand() < 0.3) await H(() => window.__cityRacer.qaAdvance(0.1));
    }
    await H(() => window.__cityRacer.qaAdvance(1 / 60));
  } else if (r < 0.32) {
    const k = pick(['KeyE', 'KeyE', 'KeyR', 'Escape', 'KeyM', 'KeyN', 'Space']);
    action = `press ${k}`;
    await page.keyboard.press(k);
    await H(() => window.__cityRacer.qaAdvance(0.3));
  } else {
    // Change the held key set, then let the simulation run.
    await release();
    const want = KEYS_DRIVE.filter(() => rand() < 0.35);
    if (rand() < 0.6 && !want.includes('KeyW') && !want.includes('KeyS')) want.push('KeyW');
    for (const k of want) {
      await page.keyboard.down(k);
      held.add(k);
    }
    const secs = Math.round((0.3 + rand() * 2.5) * 10) / 10;
    action = `hold ${want.join('+') || 'nothing'} ${secs}s`;
    for (let t = 0; t < secs; t += 0.5) await H((x) => window.__cityRacer.qaAdvance(x), Math.min(0.5, secs - t));
  }
  bump(actionsSeen, action.split(' ')[0] + (action.startsWith('click') ? ` ${action.split(' ')[1].split(':')[0]}` : ''));
  const st = await invariants(step, action);
  log.push(`${String(step).padStart(3)} ${(action.includes("failed") ? action : action.padEnd(48).slice(0, 48))} → ${st.sn.state}${st.screen ? `/${st.screen}` : ''}${st.sn.state === 'driving' ? ` ${st.sn.speedKmh.toFixed(0)} km/h` : ''}`);
}
await release();

console.log(log.join('\n'));
console.log(`\nseed ${SEED}, ${STEPS} steps, ${TOUCH ? `touch ${VIEW.width}×${VIEW.height}` : `mouse+keyboard ${VIEW.width}×${VIEW.height}`}`);
console.log('states:', JSON.stringify(Object.fromEntries(statesSeen)));
console.log('screens:', JSON.stringify(Object.fromEntries(screensSeen)));
console.log('actions:', JSON.stringify(Object.fromEntries([...actionsSeen].sort((a, b) => b[1] - a[1]))));
for (const f of failures) console.log(`FAIL  step ${f.step} [${f.action}] state ${f.state}/${f.screen}: ${f.bad.join(' | ')}`);
console.log(failures.length === 0 ? '\nMONKEY QA PASSED' : `\n${failures.length} STEP(S) FAILED`);
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
