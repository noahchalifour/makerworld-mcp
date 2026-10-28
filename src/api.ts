import { MakerWorldError } from './errors.js';
import { parseDesign, type Design } from './parse.js';

export const API_BASE = 'https://makerworld.com';
/** Same service, but not behind the Cloudflare challenge that blocks Node's fetch on makerworld.com. */
export const API_HOST = 'https://api.bambulab.com/v1';
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface BrowserJson { browserFetchJson(path: string): Promise<{ status: number; body: unknown }> }

export function mapApiError(status: number, body: unknown): MakerWorldError | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = typeof b.error === 'string' ? b.error : '';
  if (/log ?in/i.test(msg)) return new MakerWorldError('NOT_LOGGED_IN', 'MakerWorld requires login for this. Run `npx makerworld-mcp login`, sign in, then close the window.');
  if (status >= 200 && status < 300) return null;
  if (status === 404) return new MakerWorldError('MODEL_NOT_FOUND', 'Model not found. Check the id or URL.');
  if (status === 429) return new MakerWorldError('RATE_LIMITED', 'MakerWorld is rate limiting requests. Try again later.');
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new MakerWorldError('UPSTREAM_ERROR', `MakerWorld returned HTTP ${status}: ${text.slice(0, 200)}`);
}

export async function getDesign(
  id: number,
  deps: { fetch?: FetchLike; browser?: BrowserJson; retryDelayMs?: number } = {},
): Promise<Design> {
  const path = `/api/v1/design-service/design/${id}`;
  const url = `${API_HOST}/design-service/design/${id}`;
  const doFetch = deps.fetch ?? fetch;
  const delay = deps.retryDelayMs ?? 2000;

  let res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, delay));
    res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  }

  const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
  if (res.status === 403 && isHtml) {
    if (!deps.browser) throw new MakerWorldError('CLOUDFLARE_BLOCKED', 'Blocked by Cloudflare and no browser available.');
    const { status, body } = await deps.browser.browserFetchJson(path);
    const err = mapApiError(status, body);
    if (err) throw err;
    return parseDesign(body);
  }

  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  const err = mapApiError(res.status, body);
  if (err) throw err;
  return parseDesign(body);
}
