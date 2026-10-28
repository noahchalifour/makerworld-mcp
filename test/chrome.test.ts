import { describe, it, expect } from 'vitest';
import { chromeArgs, findChrome } from '../src/chrome.js';

describe('chromeArgs', () => {
  it('launches a plain Chrome: no automation flags, own profile, CDP on a free port', () => {
    const a = chromeArgs('/p', false);
    expect(a).toContain('--user-data-dir=/p');
    expect(a).toContain('--remote-debugging-port=0');
    expect(a.join(' ')).not.toMatch(/enable-automation|headless|disable-blink/);
  });
  it('omits the debugging port for login', () => {
    expect(chromeArgs('/p', false, undefined, false).join(' ')).not.toMatch(/remote-debugging/);
  });
  it('hides the window off-screen instead of using headless (Cloudflare rejects headless)', () => {
    const a = chromeArgs('/p', true, 'UA/1');
    expect(a.join(' ')).not.toMatch(/headless/);
    expect(a).toContain('--window-position=-32000,-32000');
    expect(a).toContain('--user-agent=UA/1');
  });
});

describe('findChrome', () => {
  it('prefers MAKERWORLD_CHROME_PATH, then well-known locations', () => {
    expect(findChrome({ MAKERWORLD_CHROME_PATH: '/x/chrome' }, (p) => p === '/x/chrome')).toBe('/x/chrome');
    expect(findChrome({}, (p) => p.endsWith('Google Chrome'))).toMatch(/Google Chrome$/);
  });
});
