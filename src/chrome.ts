import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { MakerWorldError } from './errors.js';

/**
 * Cloudflare rejects Chrome that Playwright launches (automation flags, navigator.webdriver),
 * so the captcha loops forever. We start an ordinary Chrome process ourselves and only attach
 * to it over CDP afterwards.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const candidates = [
    env.MAKERWORLD_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const found = candidates.find((p): p is string => !!p && exists(p));
  if (found) return found;
  try { const p = chromium.executablePath(); return exists(p) ? p : undefined; } catch { return undefined; }
}

export function chromeArgs(profileDir: string, headless: boolean, userAgent?: string, debug = true): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    ...(debug ? ['--remote-debugging-port=0'] : []),
    '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new', '--window-size=1280,900'] : []),
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    'about:blank',
  ];
}

export interface RunningChrome { proc: ChildProcess; endpoint: string }

export async function startChrome(profileDir: string, headless: boolean, userAgent?: string): Promise<RunningChrome> {
  const exe = findChrome();
  if (!exe) throw new MakerWorldError('BROWSER_UNAVAILABLE', 'Google Chrome was not found. Install Chrome, or set MAKERWORLD_CHROME_PATH.');
  await mkdir(profileDir, { recursive: true });
  const portFile = join(profileDir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const proc = spawn(exe, chromeArgs(profileDir, headless, userAgent), { stdio: 'ignore' });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    if (exited) throw new MakerWorldError('BROWSER_UNAVAILABLE', 'Chrome exited at startup. Is another Chrome already using this profile?');
    try {
      const [port] = (await readFile(portFile, 'utf8')).split('\n');
      if (port) return { proc, endpoint: `http://127.0.0.1:${port}` };
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new MakerWorldError('BROWSER_UNAVAILABLE', 'Chrome did not start in time.');
}

/**
 * Opens a completely plain Chrome (no debugging port, no automation) for logging in.
 * Google sign-in and Cloudflare both reject Chrome that has remote debugging enabled.
 */
export async function openChromeForLogin(profileDir: string): Promise<ChildProcess> {
  const exe = findChrome();
  if (!exe) throw new MakerWorldError('BROWSER_UNAVAILABLE', 'Google Chrome was not found. Install Chrome, or set MAKERWORLD_CHROME_PATH.');
  await mkdir(profileDir, { recursive: true });
  const proc = spawn(exe, [...chromeArgs(profileDir, false, undefined, false).filter((a) => a !== 'about:blank'), 'https://makerworld.com/en'], { stdio: 'ignore' });
  return proc;
}
