import { chromium, type BrowserContext, type Page } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MakerWorldError } from './errors.js';
import { API_BASE, type BrowserJson } from './api.js';

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

async function launch(profileDir: string, headless: boolean): Promise<BrowserContext> {
  const opts = { headless, viewport: { width: 1280, height: 900 } };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...opts, channel: 'chrome' });
  } catch (chromeErr) {
    try {
      return await chromium.launchPersistentContext(profileDir, opts);
    } catch {
      throw new MakerWorldError('BROWSER_UNAVAILABLE', `Could not start Chrome or Chromium (${(chromeErr as Error).message.split('\n')[0]}). Run \`npx playwright install chromium\`.`);
    }
  }
}

export class BrowserSession implements BrowserJson {
  private ctx?: BrowserContext;
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
      this.ctx = await launch(this.profileDir, this.headless);
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
    const ctx = this.ctx;
    this.ctx = undefined; this.page = undefined;
    await ctx?.close().catch(() => {});
  }
}

export async function runLogin(profileDir = defaultProfileDir()): Promise<void> {
  const ctx = await launch(profileDir, false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(API_BASE + '/en', { waitUntil: 'domcontentloaded' });
  console.error('Log in to MakerWorld in the browser window (and solve any Cloudflare check), then close the window.');
  await new Promise<void>((resolve) => ctx.on('close', () => resolve()));
  console.error(`Saved session to ${profileDir}`);
}
