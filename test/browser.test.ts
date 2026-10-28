import { describe, it, expect, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { waitForChallenge, defaultProfileDir } from '../src/browser.js';

let browser: Browser;
afterAll(() => browser?.close());

describe('waitForChallenge', () => {
  it('resolves once the challenge title goes away', async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent('<title>Just a moment...</title><script>setTimeout(()=>document.title="MakerWorld",300)</script>');
    await expect(waitForChallenge(page, 5000)).resolves.toBeUndefined();
  });
  it('throws CLOUDFLARE_BLOCKED when it never clears', async () => {
    const page = await browser.newPage();
    await page.setContent('<title>Just a moment...</title>');
    await expect(waitForChallenge(page, 500)).rejects.toMatchObject({ code: 'CLOUDFLARE_BLOCKED' });
  });
});

describe('defaultProfileDir', () => {
  it('honours MAKERWORLD_PROFILE_DIR, else ~/.makerworld-mcp/profile', () => {
    expect(defaultProfileDir({ MAKERWORLD_PROFILE_DIR: '/p' })).toBe('/p');
    expect(defaultProfileDir({})).toMatch(/\.makerworld-mcp\/profile$/);
  });
});
