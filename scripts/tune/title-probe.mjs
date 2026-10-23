import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.goto('http://localhost:4174/', { timeout: 180000 });
await p.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const dom = () => p.evaluate(() => ({
  screens: [...document.querySelectorAll('.screen')].map((e) => `${e.dataset.screen}${e.classList.contains('hidden') ? '' : '*'}`).join(' '),
  titleBtns: [...document.querySelectorAll('.screen-title button')].map((e) => `${e.dataset.action}${e.disabled ? '(dis)' : ''}`).join(' '),
  notice: document.querySelector('.notice-screen')?.className,
  top: (() => { const e = document.elementFromPoint(480, 300); return e ? `${e.tagName}.${e.className}` : null; })(),
}));
console.log('before', JSON.stringify(await dom()));
const cycle = async (label) => {
  await p.evaluate(() => { window.__l = document.querySelector('canvas.game-canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__l.loseContext(); });
  await p.waitForFunction(() => !document.querySelector('.notice-screen').classList.contains('hidden'));
  await p.evaluate(() => window.__l.restoreContext());
  await p.waitForFunction(() => document.querySelector('.notice-screen').classList.contains('hidden'), null, { timeout: 120000 });
  console.log(label, JSON.stringify(await dom()));
};
if (process.argv.includes('--twice')) {
  await p.evaluate(() => window.__cityRacer.qaFreeze(true));
  await cycle('frozen-cycle');
  await p.evaluate(() => window.__cityRacer.qaFreeze(true));
  await p.evaluate(() => window.__cityRacer.qaFreeze(false));
  await p.waitForTimeout(500);
  await cycle('live-cycle');
  await b.close();
  process.exit(0);
}
await p.evaluate(() => { window.__l = document.querySelector('canvas.game-canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__l.loseContext(); });
await p.waitForTimeout(1500);
console.log('lost', JSON.stringify(await dom()));
await p.evaluate(() => window.__l.restoreContext());
await p.waitForTimeout(3000);
console.log('restored', JSON.stringify(await dom()));
await b.close();
