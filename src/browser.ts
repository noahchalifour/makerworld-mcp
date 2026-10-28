import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startChrome, type RunningChrome } from './chrome.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MakerWorldError } from './errors.js';
import { API_BASE, USER_AGENT, type BrowserJson } from './api.js';

const CHALLENGE_TITLE = 'Just a moment';
const IDLE_MS = 10 * 60 * 1000;
const CHALLENGE_MS = 20_000;

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAKERWORLD_PROFILE_DIR || join(homedir(), '.makerworld-mcp', 'profile');
}

export async function waitForChallenge(page: Page, timeoutMs = CHALLENGE_MS): Promise<void> {
  try {
    await page.waitForFunction((t) => !document.title.includes(t), CHALLENGE_TITLE, { timeout: timeoutMs });
  } catch {
    throw new MakerWorldError('CLOUDFLARE_BLOCKED', 'Cloudflare challenge did not clear. Run `npx makerworld-mcp login`, solve the check in the window, then close it.');
  }
}

export class BrowserSession implements BrowserJson {
  private ctx?: BrowserContext;
  private browser?: Browser;
  private chrome?: RunningChrome;
  private page?: Page;
  private starting?: Promise<Page>;
  private idle?: NodeJS.Timeout;
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly idleMs: number;

  constructor(opts: { profileDir?: string; headless?: boolean; idleMs?: number } = {}) {
    this.profileDir = opts.profileDir ?? defaultProfileDir();
    this.headless = opts.headless ?? process.env.MAKERWORLD_HEADLESS !== 'false';
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  private async getPage(): Promise<Page> {
    this.touch();
    if (this.page && !this.page.isClosed()) return this.page;
    this.starting ??= (async () => {
      this.chrome = await startChrome(this.profileDir, this.headless, this.headless ? USER_AGENT : undefined);
      this.browser = await chromium.connectOverCDP(this.chrome.endpoint);
      this.ctx = this.browser.contexts()[0] ?? (await this.browser.newContext());
      const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
      await page.goto(API_BASE + '/en', { waitUntil: 'domcontentloaded' });
      await waitForChallenge(page);
      this.page = page;
      return page;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), this.idleMs);
    this.idle.unref();
  }

  async browserFetchJson(path: string, retried = false): Promise<{ status: number; body: unknown }> {
    const page = await this.getPage();
    const { status, text } = await page.evaluate(async (p) => {
      const r = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { status: r.status, text: await r.text() };
    }, path);
    if (text.includes(CHALLENGE_TITLE)) {
      if (retried) throw new MakerWorldError('CLOUDFLARE_BLOCKED', 'Cloudflare challenge keeps reappearing. Run `npx makerworld-mcp login` and solve it in the window.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForChallenge(page);
      return this.browserFetchJson(path, true);
    }
    try { return { status, body: JSON.parse(text) }; } catch { return { status, body: text }; }
  }

  async browserGetBuffer(url: string): Promise<Buffer> {
    await this.getPage();
    const res = await this.ctx!.request.get(url);
    if (!res.ok()) throw new MakerWorldError('UPSTREAM_ERROR', `Download failed with HTTP ${res.status()}`);
    return res.body();
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const { browser, chrome } = this;
    this.ctx = undefined; this.page = undefined; this.browser = undefined; this.chrome = undefined;
    await browser?.close().catch(() => {});
    chrome?.proc.kill();
  }
}

export async function runLogin(profileDir = defaultProfileDir()): Promise<void> {
  const chrome = await startChrome(profileDir, false);
  console.error('Chrome opened. Go to https://makerworld.com, solve any Cloudflare check, log in, then close Chrome.');
  console.error('(This is a normal Chrome window, not an automated one, so the check should pass.)');
  await new Promise<void>((resolve) => chrome.proc.once('exit', () => resolve()));
  console.error(`Saved session to ${profileDir}`);
}
