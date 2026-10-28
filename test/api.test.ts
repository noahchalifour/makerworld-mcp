import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDesign, mapApiError, type BrowserJson } from '../src/api.js';

const fixture = readFileSync(new URL('./fixtures/design-1400000.json', import.meta.url), 'utf8');
const json = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) => new Response('<html><title>Just a moment...</title></html>', { status, headers: { 'content-type': 'text/html' } });
const noBrowser: BrowserJson = { browserFetchJson: () => { throw new Error('browser should not be used'); } };

describe('getDesign', () => {
  it('fetches and parses over plain HTTP with a browser User-Agent', async () => {
    const fetch = vi.fn(async () => json(200, fixture));
    const d = await getDesign(1400000, { fetch, browser: noBrowser });
    expect(d.title).toContain('Honkai');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.bambulab.com/v1/design-service/design/1400000');
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/Chrome/);
  });
  it('maps 404 to MODEL_NOT_FOUND', async () => {
    const fetch = async () => json(404, '{"code":404,"error":"The server cannot find the requested resource."}');
    await expect(getDesign(1, { fetch, browser: noBrowser })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });
  it('falls back to the browser on a Cloudflare 403', async () => {
    const browser = { browserFetchJson: vi.fn(async () => ({ status: 200, body: JSON.parse(fixture) })) };
    const d = await getDesign(1400000, { fetch: async () => html(403), browser });
    expect(d.id).toBe(1400000);
    expect(browser.browserFetchJson).toHaveBeenCalledWith('/api/v1/design-service/design/1400000');
  });
  it('retries once on 429 then succeeds', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(429, '{}')).mockResolvedValueOnce(json(200, fixture));
    const d = await getDesign(1400000, { fetch, browser: noBrowser, retryDelayMs: 0 });
    expect(d.id).toBe(1400000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('gives RATE_LIMITED after a second 429', async () => {
    const fetch = async () => json(429, '{}');
    await expect(getDesign(1, { fetch, browser: noBrowser, retryDelayMs: 0 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('mapApiError', () => {
  it('maps login errors, 404, 429 and other failures', () => {
    expect(mapApiError(403, { code: 1, error: 'Please log in to download models.' })?.code).toBe('NOT_LOGGED_IN');
    expect(mapApiError(404, {})?.code).toBe('MODEL_NOT_FOUND');
    expect(mapApiError(429, {})?.code).toBe('RATE_LIMITED');
    expect(mapApiError(500, 'boom')?.code).toBe('UPSTREAM_ERROR');
    expect(mapApiError(200, { id: 1 })).toBeNull();
  });
});
