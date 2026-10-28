// One-off discovery of MakerWorld endpoints through a visible browser (see docs/notes/endpoints.md).
// Usage: npm run probe   (log in to MakerWorld in the window when prompted)
import { chromium } from 'playwright';
import { defaultProfileDir } from '../src/browser.js';

const ctx = await chromium.launchPersistentContext(defaultProfileDir(), { headless: false, channel: 'chrome' })
  .catch(() => chromium.launchPersistentContext(defaultProfileDir(), { headless: false }));
const page = ctx.pages()[0] ?? (await ctx.newPage());

page.on('response', async (r) => {
  if (!r.url().includes('/api/v1/')) return;
  console.log(r.request().method(), r.status(), r.url().slice(0, 160));
});

await page.goto('https://makerworld.com/en/search/models?keyword=benchy', { waitUntil: 'domcontentloaded' });
console.log('Solve any Cloudflare check / log in in the window. Waiting 60s...');
await page.waitForTimeout(60_000);

for (const path of [
  '/api/v1/design-service/instance/1451665/f3mf?type=download',
  '/api/v1/design-service/design/1400000/model?type=download',
]) {
  const out = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, text: (await r.text()).slice(0, 1500) };
  }, path);
  console.log('\n=== DOWNLOAD', path, out.status, '\n', out.text);
}
await ctx.close();
