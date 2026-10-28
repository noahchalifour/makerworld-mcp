import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSearchPath, parseSearchResults, searchModels, formatSearchResults, SEARCH_PATH } from '../src/search.js';

const raw = readFileSync(new URL('./fixtures/search-benchy.json', import.meta.url), 'utf8');
const body = JSON.parse(raw);
const json = (status: number, b: string) => new Response(b, { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) => new Response('<title>Just a moment...</title>', { status, headers: { 'content-type': 'text/html' } });

describe('buildSearchPath', () => {
  it('encodes keyword, limit and the real orderBy values', () => {
    const p = buildSearchPath({ query: 'benchy boat & co', limit: 5, sort: 'newest' });
    expect(p.startsWith(SEARCH_PATH + '?')).toBe(true);
    const q = new URLSearchParams(p.split('?')[1]);
    expect(q.get('keyword')).toBe('benchy boat & co');
    expect(q.get('limit')).toBe('5');
    expect(q.get('orderBy')).toBe('newUploads');
    expect(new URLSearchParams(buildSearchPath({ query: 'x', limit: 1, sort: 'downloads' }).split('?')[1]).get('orderBy')).toBe('downloadCount');
  });
});

describe('parseSearchResults', () => {
  it('maps real search hits', () => {
    const hits = parseSearchResults(body);
    expect(hits).toHaveLength(5);
    for (const h of hits) {
      expect(Number.isInteger(h.id)).toBe(true);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.url).toMatch(/^https:\/\/makerworld\.com\/en\/models\/\d+/);
    }
    expect(hits[0].id).toBe(body.hits[0].id);
  });
  it('returns [] for an empty result and throws on garbage', () => {
    expect(parseSearchResults({ total: 0, hits: [] })).toEqual([]);
    expect(() => parseSearchResults({ nope: 1 })).toThrow();
  });
  it('skips NSFW hits', () => {
    expect(parseSearchResults({ hits: [{ id: 1, title: 'a', nsfw: true }, { id: 2, title: 'b' }] }).map((h) => h.id)).toEqual([2]);
  });
});

describe('searchModels', () => {
  it('uses plain HTTP against api.bambulab.com and trims to limit', async () => {
    const fetch = vi.fn(async () => json(200, raw));
    const hits = await searchModels({ query: 'benchy', limit: 2, sort: 'relevance' }, { fetch });
    expect(hits).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith('https://api.bambulab.com/v1/search-service/select/design2?')).toBe(true);
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/Chrome/);
  });
  it('retries once on 429 then gives RATE_LIMITED', async () => {
    const ok = vi.fn().mockResolvedValueOnce(html(429)).mockResolvedValueOnce(json(200, raw));
    expect(await searchModels({ query: 'x', limit: 1, sort: 'relevance' }, { fetch: ok, retryDelayMs: 0 })).toHaveLength(1);
    await expect(searchModels({ query: 'x', limit: 1, sort: 'relevance' }, { fetch: async () => html(429), retryDelayMs: 0 }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('falls back to the browser on a Cloudflare 403', async () => {
    const browser = { browserFetchJson: vi.fn(async () => ({ status: 200, body })) };
    const hits = await searchModels({ query: 'benchy', limit: 3, sort: 'popular' }, { fetch: async () => html(403), browser });
    expect(hits).toHaveLength(3);
    expect(browser.browserFetchJson.mock.calls[0][0]).toContain('orderBy=hotScore');
  });
  it('maps login errors', async () => {
    const fetch = async () => json(403, '{"code":1,"error":"Please log in"}');
    await expect(searchModels({ query: 'x', limit: 1, sort: 'relevance' }, { fetch })).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });
});

describe('formatSearchResults', () => {
  it('lists ids, titles and urls, or says nothing found', () => {
    const t = formatSearchResults('benchy', parseSearchResults(body).slice(0, 1));
    expect(t).toMatch(/^Found \d+ result/);
    expect(t).toContain('https://makerworld.com/en/models/');
    expect(formatSearchResults('zzz', [])).toBe('No MakerWorld models found for "zzz".');
  });
});
