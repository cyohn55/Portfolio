// Probe the terrain around the deck-island junction: is the unit really boxed in?
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.goto('http://localhost:3000', { waitUntil: 'load' });

await page.waitForSelector('text=QUICK PLAY', { timeout: 20000 });
await page.click('text=QUICK PLAY');
for (const name of ['Bear', 'Bunny', 'Cat']) {
  await page.waitForSelector(`text=${name}`, { timeout: 10000 });
  await page.click(`text=${name}`);
}
await (await page.waitForSelector('button:has-text("Start")', { timeout: 10000 })).click();
await page.waitForFunction(
  () => !!(window.__rtsTerrain && window.__rtsPath?.isReady?.()),
  { timeout: 30000 },
);

const report = await page.evaluate(() => {
  const tv = window.__rtsTerrain;
  const out = [];
  // Scan a strip along the center bridge to find the deck-island gap and any traps.
  for (let z = 12; z >= -12; z -= 0.5) {
    const row = [];
    for (let x = -4; x <= 4; x += 1) {
      const p = { x, y: 0, z };
      const onBridge = tv.isPositionOnBridge ? tv.isPositionOnBridge(p) : tv.bridgeAt(p);
      const overWater = tv.isPositionOverWater(p);
      const canMove = tv.canAnimalMoveTo('Bear', p);
      // Compact code: L=land, W=water, B=bridge, .=N/A
      let code = '?';
      if (canMove) code = onBridge?.onBridge ? 'B' : (overWater ? 'w' : 'L');
      else code = overWater ? 'W' : 'x';
      row.push(code);
    }
    out.push(`z=${z.toFixed(1).padStart(5)} | ${row.join(' ')}`);
  }
  return out.join('\n');
});
console.log('Terrain at center-bridge / island junction (x=-4..+4, z=12..-12):');
console.log('  Codes: L=land  B=bridge(walkable)  W=water(blocked)  w=water but walkable  x=blocked-non-water');
console.log();
console.log(report);

await browser.close();
