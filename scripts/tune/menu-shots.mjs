// Screenshots of menu screens at a few sizes (dev tool): node scripts/tune/menu-shots.mjs [URL] [outDir]
import { chromium } from 'playwright';
const URL = process.argv[2] || 'http://localhost:4174/';
const OUT = process.argv[3] || '/tmp/shots/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(URL, { timeout: 180000 });
await page.waitForFunction(() => !!window.__cityRacer && !document.querySelector('.screen-title button[disabled]'), null, { timeout: 180000 });
const H = (f, a) => page.evaluate(f, a);
await H(() => window.__cityRacer.qaFreeze(true));
const act = (a) => H((x) => document.querySelector(`.screen:not(.hidden) [data-action="${x}"]`).click(), a);
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}${name}.png`, timeout: 150000 }).catch((e) => console.log('skip', name, e.message.split('\n')[0])); };
await act('career'); await page.waitForTimeout(300); await act('cbrief'); await shot('m-career-brief-960');
await page.keyboard.press('Escape'); await page.waitForTimeout(300); await shot('m-career-960');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.setViewportSize({ width: 740, height: 360 }); await page.waitForTimeout(500); await shot('m-title-740');
await act('garage'); await shot('m-garage-740');
await browser.close();
