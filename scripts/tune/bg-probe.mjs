// Background / hidden-page audio probe: measures the real audio output (analyser tapped on the node that
// feeds the speakers) in each app state, before and after the page reports itself hidden.
// usage: node scripts/tune/bg-probe.mjs [URL]
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:4174/';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.addInitScript(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) window.__outNode = this;
    return orig.call(this, dest, ...rest);
  };
  // Fake page visibility (headless pages are always visible).
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  window.__setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(h ? 'blur' : 'focus'));
  };
});
p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('console:', m.text()));
await p.goto(URL, { timeout: 180000 });
await p.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });

const level = () =>
  p.evaluate(async () => {
    const out = window.__outNode;
    if (!out) return { ctx: 'none' };
    const ctx = out.context;
    if (!window.__an) {
      window.__an = ctx.createAnalyser();
      window.__an.fftSize = 2048;
      out.connect(window.__an);
    }
    // Sample a few buffers over ~0.4 s of wall time.
    let peak = 0;
    const buf = new Float32Array(2048);
    for (let k = 0; k < 4; k++) {
      await new Promise((r) => setTimeout(r, 100));
      window.__an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      peak = Math.max(peak, Math.sqrt(s / buf.length));
    }
    return { ctx: ctx.state, rms: +peak.toFixed(5), t: +ctx.currentTime.toFixed(2) };
  });
const state = () => p.evaluate(() => window.__cityRacer.snapshot().state);
const report = async (label) => console.log(label.padEnd(34), (await state()).padEnd(10), JSON.stringify(await level()));
const hide = async (label) => {
  await p.evaluate(() => window.__setHidden(true));
  await p.waitForTimeout(1500);
  await report(`${label} + hidden`);
  await p.evaluate(() => window.__setHidden(false));
  await p.waitForTimeout(800);
  await report(`${label} + visible again`);
};

await report('title (no gesture yet)');
await p.click('.screen-title [data-action="free"]', { timeout: 90000 });
await p.waitForFunction(() => ['onFoot', 'driving'].includes(window.__cityRacer.snapshot().state), null, { timeout: 120000 });
await p.waitForTimeout(1500);
await report('free roam');
await hide('free roam');
// hide() pauses gameplay: resume, then quit to the title via the pause menu.
await p.keyboard.press('Escape');
await p.waitForTimeout(500);
if ((await state()) !== 'paused') {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
}
await report('pause menu');
await p.click('.screen-pause [data-action="quit"], .screen:not(.hidden) [data-action="quit"]', { timeout: 90000 });
await p.waitForFunction(() => window.__cityRacer.snapshot().state === 'menu', null, { timeout: 120000 });
await p.waitForTimeout(1500);
await report('title after a run');
await hide('title after a run');
await p.click('.screen-title button.primary', { timeout: 90000 });
await p.waitForFunction(() => window.__cityRacer.snapshot().state !== 'menu', null, { timeout: 120000 });
await p.waitForTimeout(1500);
await report('briefing');
await hide('briefing');
await b.close();
