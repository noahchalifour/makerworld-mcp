import { mapApiError, USER_AGENT, type BrowserJson, type FetchLike } from './api.js';
import { MakerWorldError } from './errors.js';

export type SortOrder = 'relevance' | 'popular' | 'newest' | 'downloads';
export interface SearchParams { query: string; limit: number; sort: SortOrder }
export interface SearchHit { id: number; title: string; url: string; coverUrl: string; creator: string; likes: number; downloads: number }

export const SEARCH_PATH = '/api/v1/search-service/select/design2';
export const SEARCH_API_URL = 'https://api.bambulab.com/v1/search-service/select/design2';
const SORT_VALUES: Record<SortOrder, string> = {
  relevance: 'score', popular: 'hotScore', newest: 'newUploads', downloads: 'downloadCount',
};

function searchQuery(p: SearchParams): string {
  return new URLSearchParams({ keyword: p.query, limit: String(p.limit), offset: '0', designType: '0', orderBy: SORT_VALUES[p.sort] }).toString();
}

/** Path + query for the browser fallback on makerworld.com. */
export function buildSearchPath(p: SearchParams): string {
  return `${SEARCH_PATH}?${searchQuery(p)}`;
}

export function parseSearchResults(body: unknown): SearchHit[] {
  const hits = (body as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) throw new MakerWorldError('UPSTREAM_ERROR', `Unexpected search response: ${JSON.stringify(body).slice(0, 200)}`);
  return hits
    .filter((h: any) => typeof h?.id === 'number' && !h.nsfw)
    .map((h: any) => ({
      id: h.id,
      title: String(h.title ?? ''),
      url: `https://makerworld.com/en/models/${h.id}${h.slug ? '-' + h.slug : ''}`,
      coverUrl: String(h.cover ?? h.coverUrl ?? ''),
      creator: String(h.designCreator?.name ?? ''),
      likes: Number(h.likeCount ?? 0),
      downloads: Number(h.downloadCount ?? 0),
    }));
}

/**
 * Searches over plain HTTP against api.bambulab.com (no login, no Cloudflare challenge).
 * Falls back to the browser session if that host answers with a Cloudflare challenge.
 */
export async function searchModels(
  p: SearchParams,
  deps: { fetch?: FetchLike; browser?: BrowserJson; retryDelayMs?: number } = {},
): Promise<SearchHit[]> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${SEARCH_API_URL}?${searchQuery(p)}`;
  const init = { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } };

  let res = await doFetch(url, init);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 2000));
    res = await doFetch(url, init);
  }
  const challenged = (res.status === 403 || res.status === 429) && (res.headers.get('content-type') ?? '').includes('text/html');
  if (challenged && deps.browser && res.status === 403) {
    const { status, body } = await deps.browser.browserFetchJson(buildSearchPath(p));
    const err = mapApiError(status, body);
    if (err) throw err;
    return parseSearchResults(body).slice(0, p.limit);
  }

  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  const err = mapApiError(res.status, body);
  if (err) throw err;
  return parseSearchResults(body).slice(0, p.limit);
}

export function formatSearchResults(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `No MakerWorld models found for "${query}".`;
  const lines = hits.map((h, i) =>
    `${i + 1}. [${h.id}] ${h.title} by ${h.creator || 'unknown'} (likes ${h.likes}, downloads ${h.downloads})\n   ${h.url}\n   cover: ${h.coverUrl}`);
  return `Found ${hits.length} result(s) for "${query}":\n\n${lines.join('\n')}`;
}
