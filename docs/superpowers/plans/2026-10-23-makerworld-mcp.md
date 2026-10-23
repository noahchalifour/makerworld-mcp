# MakerWorld MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stdio MCP server that searches MakerWorld, shows model details and images, and downloads model files to local disk.

**Architecture:** Hybrid transport. Plain `fetch` serves model details and CDN images. A lazily started Playwright persistent Chrome profile serves search, downloads, and any request that hits a Cloudflare 403. Pure parsing lives in `parse.ts` and is tested from real JSON fixtures; every network-facing module takes its dependencies as parameters so tests can stub them.

**Tech Stack:** Node 22, TypeScript (ESM, `NodeNext`), `@modelcontextprotocol/server` + `@modelcontextprotocol/client` 2.x (SDK v2), `zod` ^4.2, `playwright`, `sharp`, `vitest`, `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-23-makerworld-mcp-design.md`

## Global Constraints

- Node ≥ 22 (native `fetch`, `Readable.fromWeb`). ESM only (`"type": "module"`, relative imports end in `.js`).
- `zod` range must be `^4.2.0` or newer. SDK v2 does not support zod 3, and zod < 4.2 drops `.describe()` text.
- MCP imports: `McpServer` from `@modelcontextprotocol/server`, `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, `Client` from `@modelcontextprotocol/client`. `InMemoryTransport` (tests only) from `@modelcontextprotocol/server`.
- API base: `https://makerworld.com`. Image CDN: `https://makerworld.bblmw.com`.
- Plain-HTTP User-Agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`.
- Download dir precedence: `destDir` arg > `MAKERWORLD_DOWNLOAD_DIR` > `/tmp/makerworld`.
- Profile dir: `MAKERWORLD_PROFILE_DIR` > `~/.makerworld-mcp/profile`. Headless unless `MAKERWORLD_HEADLESS=false`.
- Images: max 1568px longest side, JPEG quality 85. Browser idle close: 10 minutes. Cloudflare wait: 20 s. Rate-limit retry: one retry after 2 s.
- Error codes (exact strings): `MODEL_NOT_FOUND`, `PROFILE_NOT_FOUND`, `NOT_LOGGED_IN`, `CLOUDFLARE_BLOCKED`, `BROWSER_UNAVAILABLE`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `INVALID_INPUT`.
- Never write to stdout from server code (stdout is the MCP channel). Log with `console.error`.
- Tests never touch the network except the `smoke` script and the Task 5 probe.

## File Map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | Project setup |
| `src/errors.ts` | `MakerWorldError` + `ErrorCode` |
| `src/parse.ts` | Pure: model ref parsing, HTML→text, `Design`/`Profile` types, `parseDesign`, `formatDesign`, `pickProfile`, `buildFilename`, `resolveDownloadDir` |
| `src/api.ts` | `getDesign` over plain HTTP with browser fallback; `BrowserJson` interface; `mapApiError` |
| `src/images.ts` | Fetch + resize images, return MCP-ready base64 |
| `src/browser.ts` | `BrowserSession` (Playwright persistent context), `waitForChallenge`, `runLogin`, `defaultProfileDir` |
| `src/search.ts` | Search path building + result parsing + `searchModels` |
| `src/download.ts` | `extractSignedUrl`, `downloadModel` |
| `src/server.ts` | `createServer(deps)` registering the four tools |
| `src/index.ts` | CLI entry: `serve` (default) or `login` |
| `scripts/probe.ts` | One-off discovery of search + download endpoints |
| `scripts/smoke.ts` | Manual live check |
| `test/fixtures/design-1400000.json`, `design-22424.json` | Real design responses (already saved) |
| `docs/notes/endpoints.md` | Probe findings |

---

### Task 1: Scaffold, errors, model refs, HTML→text

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/errors.ts`, `src/parse.ts`
- Test: `test/parse-ref.test.ts`

**Interfaces:**
- Produces: `class MakerWorldError extends Error { code: ErrorCode }`; `type ErrorCode`; `interface ModelRef { id: number; profileId?: number }`; `parseModelRef(input: string): ModelRef`; `htmlToText(html: string): string`.

- [ ] **Step 1: Create project files**

`package.json`:
```json
{
  "name": "makerworld-mcp",
  "version": "0.1.0",
  "description": "MCP server for searching, viewing and downloading MakerWorld models",
  "type": "module",
  "bin": { "makerworld-mcp": "dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "probe": "tsx scripts/probe.ts",
    "smoke": "tsx scripts/smoke.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.4.0",
    "playwright": "^1.64.0",
    "sharp": "^0.35.0",
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.4.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.23.0",
    "typescript": "^5.9.0",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30000 } });
```

`.gitignore`:
```
node_modules/
dist/
```

Run: `npm install`
Expected: installs without errors. (If `typescript@^5.9` is unavailable, use the latest 5.x; do not use 7.x.)

- [ ] **Step 2: Write the failing test** `test/parse-ref.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseModelRef, htmlToText } from '../src/parse.js';
import { MakerWorldError } from '../src/errors.js';

describe('parseModelRef', () => {
  it('accepts a bare id', () => {
    expect(parseModelRef('1400000')).toEqual({ id: 1400000 });
    expect(parseModelRef(' 22424 ')).toEqual({ id: 22424 });
  });
  it('accepts a model URL with slug and locale', () => {
    expect(parseModelRef('https://makerworld.com/en/models/1400000-honkai-star-rail')).toEqual({ id: 1400000 });
    expect(parseModelRef('https://makerworld.com/models/22424')).toEqual({ id: 22424 });
  });
  it('reads a profile id from the URL hash', () => {
    expect(parseModelRef('https://makerworld.com/en/models/1400000-x#profileId-1451665')).toEqual({ id: 1400000, profileId: 1451665 });
  });
  it('rejects anything else with INVALID_INPUT', () => {
    for (const bad of ['', 'benchy', 'https://example.com/models/1', 'https://makerworld.com/en/u/someone']) {
      expect(() => parseModelRef(bad)).toThrow(MakerWorldError);
      try { parseModelRef(bad); } catch (e) { expect((e as MakerWorldError).code).toBe('INVALID_INPUT'); }
    }
  });
});

describe('htmlToText', () => {
  it('converts paragraphs, breaks, lists and entities', () => {
    const html = '<p>Hi hi,</p><p>&nbsp;</p><p>Line&#39;s <b>bold</b> &amp; more<br>next</p><ul><li>one</li><li>two</li></ul>';
    expect(htmlToText(html)).toBe("Hi hi,\n\nLine's bold & more\nnext\n- one\n- two");
  });
  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/parse-ref.test.ts`
Expected: FAIL, cannot resolve `../src/parse.js`.

- [ ] **Step 4: Implement** `src/errors.ts`

```ts
export type ErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'PROFILE_NOT_FOUND'
  | 'NOT_LOGGED_IN'
  | 'CLOUDFLARE_BLOCKED'
  | 'BROWSER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INVALID_INPUT';

export class MakerWorldError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'MakerWorldError';
  }
}
```

and `src/parse.ts` (this file grows in Task 2):

```ts
import { MakerWorldError } from './errors.js';

export interface ModelRef { id: number; profileId?: number }

export function parseModelRef(input: string): ModelRef {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { id: Number(s) };
  let url: URL;
  try { url = new URL(s); } catch { throw invalid(input); }
  if (!/(^|\.)makerworld\.com$/.test(url.hostname)) throw invalid(input);
  const m = url.pathname.match(/\/models\/(\d+)/);
  if (!m) throw invalid(input);
  const ref: ModelRef = { id: Number(m[1]) };
  const p = url.hash.match(/profileId-(\d+)/);
  if (p) ref.profileId = Number(p[1]);
  return ref;
}

function invalid(input: string): MakerWorldError {
  return new MakerWorldError('INVALID_INPUT', `Not a MakerWorld model id or URL: "${input}". Use a number like 1400000 or https://makerworld.com/en/models/1400000-...`);
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/parse-ref.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test/parse-ref.test.ts test/fixtures
git commit -m "feat: scaffold project, errors, model ref + html parsing"
```

---

### Task 2: Design parsing, formatting, profile selection, filenames

**Files:**
- Modify: `src/parse.ts` (append)
- Test: `test/parse-design.test.ts`

**Interfaces:**
- Consumes: `MakerWorldError`, `htmlToText`, `ModelRef` (Task 1).
- Produces:
  ```ts
  interface Filament { type: string; color: string; grams: number }
  interface Profile { id: number; title: string; isDefault: boolean; printer?: string; nozzle?: number; printSeconds?: number; weightG?: number; filaments: Filament[]; pictureUrls: string[] }
  interface Design { id: number; slug: string; title: string; url: string; coverUrl: string; creator: { uid: number; name: string }; descriptionHtml: string; tags: string[]; categories: string[]; license: string; stats: { likes: number; downloads: number; prints: number; collections: number }; pictureUrls: string[]; defaultProfileId?: number; profiles: Profile[] }
  parseDesign(raw: unknown): Design
  formatDesign(d: Design): string            // description truncated to 4000 chars
  pickProfile(d: Design, requested?: number): Profile
  buildFilename(d: Design, format: '3mf' | 'stl', profileId?: number): string
  resolveDownloadDir(destDir?: string, env?: NodeJS.ProcessEnv): string
  ```

- [ ] **Step 1: Write the failing test** `test/parse-design.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDesign, formatDesign, pickProfile, buildFilename, resolveDownloadDir } from '../src/parse.js';
import { MakerWorldError } from '../src/errors.js';

const load = (id: number) => JSON.parse(readFileSync(new URL(`./fixtures/design-${id}.json`, import.meta.url), 'utf8'));
const big = parseDesign(load(1400000));
const small = parseDesign(load(22424));

describe('parseDesign', () => {
  it('maps core fields', () => {
    expect(big.id).toBe(1400000);
    expect(big.slug).toBe('honkai-star-rail-a-grounded-ascent-hueforge');
    expect(big.url).toBe('https://makerworld.com/en/models/1400000-honkai-star-rail-a-grounded-ascent-hueforge');
    expect(big.creator.name).toBe('Razel');
    expect(big.license).toBe('BY-NC-SA');
    expect(big.tags).toContain('HUEFORGE');
    expect(big.categories).toContain('Hueforge & Lithophane');
    expect(big.stats.likes).toBe(19);
    expect(big.stats.downloads).toBe(23);
    expect(big.pictureUrls).toHaveLength(2);
    expect(big.pictureUrls[0]).toMatch(/^https:\/\/makerworld\.bblmw\.com\//);
  });
  it('maps profiles with printer, time, weight, filaments and pictures', () => {
    expect(big.defaultProfileId).toBe(1451665);
    expect(big.profiles).toHaveLength(1);
    const p = big.profiles[0];
    expect(p.id).toBe(1451665);
    expect(p.title).toBe('0.08mm layer, 1 walls, 100% infill');
    expect(p.printer).toBe('P1S');
    expect(p.nozzle).toBe(0.4);
    expect(p.printSeconds).toBe(14794);
    expect(p.weightG).toBe(43);
    expect(p.filaments[0]).toEqual({ type: 'PLA', color: '#FFFFFF', grams: 5 });
    expect(p.pictureUrls).toHaveLength(1);
  });
  it('handles a design with no profiles and defaultInstanceId 0', () => {
    expect(small.profiles).toEqual([]);
    expect(small.defaultProfileId).toBeUndefined();
  });
  it('throws UPSTREAM_ERROR on non-design input', () => {
    expect(() => parseDesign({ code: 1 })).toThrow(MakerWorldError);
  });
});

describe('formatDesign', () => {
  it('includes title, url, stats, license, tags and profiles', () => {
    const t = formatDesign(big);
    expect(t).toContain('Honkai Star Rail: A Grounded Ascent Hueforge');
    expect(t).toContain(big.url);
    expect(t).toContain('Likes: 19');
    expect(t).toContain('License: BY-NC-SA');
    expect(t).toContain('1451665');
    expect(t).toContain('P1S');
    expect(t).toContain('4h 7m'); // 14794 s
  });
  it('truncates long descriptions to 4000 chars', () => {
    const t = formatDesign({ ...small, descriptionHtml: '<p>' + 'x'.repeat(10000) + '</p>' });
    expect(t).toContain('x'.repeat(4000) + '…');
    expect(t).not.toContain('x'.repeat(4001));
  });
});

describe('pickProfile', () => {
  it('uses requested, then default, then first', () => {
    expect(pickProfile(big, 1451665).id).toBe(1451665);
    expect(pickProfile(big).id).toBe(1451665);
    expect(pickProfile({ ...big, defaultProfileId: undefined }).id).toBe(1451665);
  });
  it('throws PROFILE_NOT_FOUND listing valid ids', () => {
    try { pickProfile(big, 999); throw new Error('no throw'); }
    catch (e) { expect((e as MakerWorldError).code).toBe('PROFILE_NOT_FOUND'); expect((e as Error).message).toContain('1451665'); }
  });
  it('throws PROFILE_NOT_FOUND when the design has no profiles', () => {
    try { pickProfile(small); throw new Error('no throw'); }
    catch (e) { expect((e as MakerWorldError).code).toBe('PROFILE_NOT_FOUND'); expect((e as Error).message).toContain('stl'); }
  });
});

describe('buildFilename / resolveDownloadDir', () => {
  it('builds filenames', () => {
    expect(buildFilename(big, '3mf', 1451665)).toBe('1400000-honkai-star-rail-a-grounded-ascent-hueforge-1451665.3mf');
    expect(buildFilename(small, 'stl')).toBe('22424-magnetic-bit-for-screwdriver-standard-1-4-inch.zip');
  });
  it('resolves download dir with precedence', () => {
    expect(resolveDownloadDir('/x', { MAKERWORLD_DOWNLOAD_DIR: '/y' })).toBe('/x');
    expect(resolveDownloadDir(undefined, { MAKERWORLD_DOWNLOAD_DIR: '/y' })).toBe('/y');
    expect(resolveDownloadDir(undefined, {})).toBe('/tmp/makerworld');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/parse-design.test.ts`
Expected: FAIL, `parseDesign` is not exported.

- [ ] **Step 3: Implement** (append to `src/parse.ts`)

```ts
export interface Filament { type: string; color: string; grams: number }
export interface Profile {
  id: number; title: string; isDefault: boolean;
  printer?: string; nozzle?: number; printSeconds?: number; weightG?: number;
  filaments: Filament[]; pictureUrls: string[];
}
export interface Design {
  id: number; slug: string; title: string; url: string; coverUrl: string;
  creator: { uid: number; name: string };
  descriptionHtml: string; tags: string[]; categories: string[]; license: string;
  stats: { likes: number; downloads: number; prints: number; collections: number };
  pictureUrls: string[]; defaultProfileId?: number; profiles: Profile[];
}

type Json = Record<string, any>;
const urls = (pics: unknown): string[] =>
  Array.isArray(pics) ? pics.map((p: Json) => p?.url).filter((u): u is string => typeof u === 'string' && u.length > 0) : [];

function parseProfile(i: Json): Profile {
  const compat = i.extention?.modelInfo?.compatibility ?? {};
  return {
    id: Number(i.id),
    title: String(i.title ?? ''),
    isDefault: Boolean(i.isDefault),
    printer: compat.devProductName || undefined,
    nozzle: typeof compat.nozzleDiameter === 'number' ? compat.nozzleDiameter : undefined,
    printSeconds: typeof i.prediction === 'number' && i.prediction > 0 ? i.prediction : undefined,
    weightG: typeof i.weight === 'number' && i.weight > 0 ? i.weight : undefined,
    filaments: (Array.isArray(i.instanceFilaments) ? i.instanceFilaments : []).map((f: Json) => ({
      type: String(f.type ?? ''), color: String(f.color ?? ''), grams: Number(f.usedG ?? 0),
    })),
    pictureUrls: urls(i.pictures),
  };
}

export function parseDesign(raw: unknown): Design {
  const d = raw as Json;
  if (!d || typeof d !== 'object' || typeof d.id !== 'number' || typeof d.title !== 'string') {
    throw new MakerWorldError('UPSTREAM_ERROR', `Unexpected design response: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const slug = String(d.slug ?? '');
  return {
    id: d.id, slug, title: d.title,
    url: `https://makerworld.com/en/models/${d.id}${slug ? '-' + slug : ''}`,
    coverUrl: String(d.coverUrl ?? ''),
    creator: { uid: Number(d.designCreator?.uid ?? 0), name: String(d.designCreator?.name ?? '') },
    descriptionHtml: String(d.summary ?? ''),
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    categories: Array.isArray(d.categories) ? d.categories.map((c: Json) => String(c.name)) : [],
    license: String(d.license ?? ''),
    stats: {
      likes: Number(d.likeCount ?? 0), downloads: Number(d.downloadCount ?? 0),
      prints: Number(d.printCount ?? 0), collections: Number(d.collectionCount ?? 0),
    },
    pictureUrls: urls(d.designExtension?.design_pictures),
    defaultProfileId: d.defaultInstanceId ? Number(d.defaultInstanceId) : undefined,
    profiles: (Array.isArray(d.instances) ? d.instances : []).map(parseProfile),
  };
}

const MAX_DESC = 4000;
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function formatDesign(d: Design): string {
  let desc = htmlToText(d.descriptionHtml);
  if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC) + '…';
  const lines = [
    `# ${d.title}`,
    `ID: ${d.id}  URL: ${d.url}`,
    `Creator: ${d.creator.name} (uid ${d.creator.uid})`,
    `License: ${d.license}`,
    `Likes: ${d.stats.likes}  Downloads: ${d.stats.downloads}  Prints: ${d.stats.prints}  Collections: ${d.stats.collections}`,
    `Tags: ${d.tags.join(', ') || '(none)'}`,
    `Categories: ${d.categories.join(', ') || '(none)'}`,
    `Pictures: ${d.pictureUrls.length}`,
    '',
    '## Description',
    desc || '(none)',
    '',
    `## Print profiles (${d.profiles.length})`,
  ];
  if (!d.profiles.length) lines.push('None. Use download_model with format "stl" for the raw model files.');
  for (const p of d.profiles) {
    const bits = [
      p.printer && `printer ${p.printer}${p.nozzle ? ` ${p.nozzle}mm` : ''}`,
      p.printSeconds && `time ${fmtDuration(p.printSeconds)}`,
      p.weightG && `${p.weightG}g`,
      p.filaments.length && `filaments ${p.filaments.map((f) => `${f.type} ${f.color} ${f.grams}g`).join(', ')}`,
      `${p.pictureUrls.length} pictures`,
    ].filter(Boolean);
    const isDefault = p.id === d.defaultProfileId || p.isDefault ? ' [default]' : '';
    lines.push(`- ${p.id}${isDefault}: ${p.title} (${bits.join('; ')})`);
  }
  return lines.join('\n');
}

export function pickProfile(d: Design, requested?: number): Profile {
  if (!d.profiles.length) {
    throw new MakerWorldError('PROFILE_NOT_FOUND', `Model ${d.id} has no print profiles. Use format "stl" to download the raw model files.`);
  }
  const id = requested ?? d.defaultProfileId;
  const found = id === undefined ? undefined : d.profiles.find((p) => p.id === id);
  if (found) return found;
  if (requested !== undefined) {
    throw new MakerWorldError('PROFILE_NOT_FOUND', `Profile ${requested} not found on model ${d.id}. Valid profile ids: ${d.profiles.map((p) => p.id).join(', ')}`);
  }
  return d.profiles[0];
}

export function buildFilename(d: Design, format: '3mf' | 'stl', profileId?: number): string {
  const base = `${d.id}${d.slug ? '-' + d.slug : ''}`;
  return format === '3mf' ? `${base}-${profileId}.3mf` : `${base}.zip`;
}

export function resolveDownloadDir(destDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return destDir || env.MAKERWORLD_DOWNLOAD_DIR || '/tmp/makerworld';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add src/parse.ts test/parse-design.test.ts
git commit -m "feat: parse and format MakerWorld designs and profiles"
```

---

### Task 3: Plain-HTTP API client with browser fallback

**Files:**
- Create: `src/api.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `parseDesign`, `Design` (Task 2), `MakerWorldError`.
- Produces:
  ```ts
  const API_BASE = 'https://makerworld.com'
  const USER_AGENT: string
  type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
  interface BrowserJson { browserFetchJson(path: string): Promise<{ status: number; body: unknown }> }
  mapApiError(status: number, body: unknown): MakerWorldError | null   // null = success
  getDesign(id: number, deps: { fetch?: FetchLike; browser?: BrowserJson; retryDelayMs?: number }): Promise<Design>
  ```

- [ ] **Step 1: Write the failing test** `test/api.test.ts`

```ts
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
    expect(url).toBe('https://makerworld.com/api/v1/design-service/design/1400000');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api.test.ts`
Expected: FAIL, cannot resolve `../src/api.js`.

- [ ] **Step 3: Implement** `src/api.ts`

```ts
import { MakerWorldError } from './errors.js';
import { parseDesign, type Design } from './parse.js';

export const API_BASE = 'https://makerworld.com';
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
  const doFetch = deps.fetch ?? fetch;
  const delay = deps.retryDelayMs ?? 2000;

  let res = await doFetch(API_BASE + path, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, delay));
    res = await doFetch(API_BASE + path, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts test/api.test.ts
git commit -m "feat: plain-HTTP design client with Cloudflare browser fallback"
```

---

### Task 4: Image fetching and resizing

**Files:**
- Create: `src/images.ts`
- Test: `test/images.test.ts`

**Interfaces:**
- Consumes: `FetchLike`, `USER_AGENT` (Task 3).
- Produces:
  ```ts
  interface LoadedImage { url: string; data: string /* base64 */; mimeType: 'image/jpeg' }
  interface LoadedImages { images: LoadedImage[]; failed: string[] }
  resizeToJpeg(input: Buffer): Promise<Buffer>
  loadImages(urls: string[], fetchImpl?: FetchLike): Promise<LoadedImages>   // preserves input order
  ```

- [ ] **Step 1: Write the failing test** `test/images.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeToJpeg, loadImages } from '../src/images.js';

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();

describe('resizeToJpeg', () => {
  it('shrinks large images to at most 1568px and outputs JPEG', async () => {
    const out = await resizeToJpeg(await png(4000, 2000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1568);
    expect(meta.height).toBe(784);
  });
  it('does not enlarge small images', async () => {
    const meta = await sharp(await resizeToJpeg(await png(300, 200))).metadata();
    expect(meta.width).toBe(300);
  });
});

describe('loadImages', () => {
  it('returns base64 JPEGs in order and lists failures', async () => {
    const good = await png(100, 100);
    const fetchImpl = async (url: string) =>
      url.includes('bad') ? new Response('nope', { status: 404 }) : new Response(good, { status: 200 });
    const r = await loadImages(['https://x/a.png', 'https://x/bad.png', 'https://x/c.png'], fetchImpl);
    expect(r.images.map((i) => i.url)).toEqual(['https://x/a.png', 'https://x/c.png']);
    expect(r.images[0].mimeType).toBe('image/jpeg');
    expect(Buffer.from(r.images[0].data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(r.failed).toEqual(['https://x/bad.png']);
  });
  it('treats undecodable bytes as a failure, not a crash', async () => {
    const r = await loadImages(['https://x/junk'], async () => new Response('not an image', { status: 200 }));
    expect(r).toEqual({ images: [], failed: ['https://x/junk'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/images.test.ts`
Expected: FAIL, cannot resolve `../src/images.js`.

- [ ] **Step 3: Implement** `src/images.ts`

```ts
import sharp from 'sharp';
import { USER_AGENT, type FetchLike } from './api.js';

export const MAX_IMAGE_PX = 1568;
export interface LoadedImage { url: string; data: string; mimeType: 'image/jpeg' }
export interface LoadedImages { images: LoadedImage[]; failed: string[] }

export function resizeToJpeg(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: MAX_IMAGE_PX, height: MAX_IMAGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function loadOne(url: string, fetchImpl: FetchLike): Promise<LoadedImage> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = await resizeToJpeg(Buffer.from(await res.arrayBuffer()));
  return { url, data: out.toString('base64'), mimeType: 'image/jpeg' };
}

export async function loadImages(urls: string[], fetchImpl: FetchLike = fetch): Promise<LoadedImages> {
  const settled = await Promise.allSettled(urls.map((u) => loadOne(u, fetchImpl)));
  const images: LoadedImage[] = [];
  const failed: string[] = [];
  settled.forEach((s, i) => (s.status === 'fulfilled' ? images.push(s.value) : failed.push(urls[i])));
  return { images, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/images.ts test/images.test.ts
git commit -m "feat: fetch and resize images for MCP image content"
```

---

### Task 5: Browser session, login, and endpoint probe

This task builds the Playwright module and then uses it to confirm the two unknowns from the spec: the search endpoint and the download response shape. Tasks 6 and 7 depend on the recorded findings.

**Files:**
- Create: `src/browser.ts`, `scripts/probe.ts`, `docs/notes/endpoints.md`
- Test: `test/browser.test.ts`

**Interfaces:**
- Consumes: `BrowserJson`, `API_BASE` (Task 3), `MakerWorldError`.
- Produces:
  ```ts
  defaultProfileDir(env?: NodeJS.ProcessEnv): string
  waitForChallenge(page: Page, timeoutMs?: number): Promise<void>   // throws CLOUDFLARE_BLOCKED
  class BrowserSession implements BrowserJson {
    constructor(opts?: { profileDir?: string; headless?: boolean; idleMs?: number })
    browserFetchJson(path: string): Promise<{ status: number; body: unknown }>
    browserGetBuffer(url: string): Promise<Buffer>   // GET with the profile's cookies
    close(): Promise<void>
  }
  runLogin(profileDir?: string): Promise<void>
  ```

- [ ] **Step 1: Install the bundled Chromium (needed by the test and as a fallback)**

Run: `npx playwright install chromium`
Expected: Chromium downloads, or reports it is already installed.

- [ ] **Step 2: Write the failing test** `test/browser.test.ts`

This test uses a real local Chromium on an in-memory page, with no network.

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/browser.test.ts`
Expected: FAIL, cannot resolve `../src/browser.js`.

- [ ] **Step 4: Implement** `src/browser.ts`

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Write the probe** `scripts/probe.ts`

```ts
// One-off discovery: logs MakerWorld search API traffic and the download endpoint responses.
// Usage: npm run probe  (opens a visible browser; log in if prompted)
import { chromium } from 'playwright';
import { defaultProfileDir } from '../src/browser.js';

const ctx = await chromium.launchPersistentContext(defaultProfileDir(), { headless: false, channel: 'chrome' })
  .catch(() => chromium.launchPersistentContext(defaultProfileDir(), { headless: false }));
const page = ctx.pages()[0] ?? (await ctx.newPage());

page.on('response', async (r) => {
  if (!r.url().includes('/api/v1/search')) return;
  console.log('\n=== SEARCH', r.request().method(), r.url(), r.status());
  console.log((await r.text().catch(() => '')).slice(0, 1500));
});

await page.goto('https://makerworld.com/en/search/models?keyword=benchy', { waitUntil: 'domcontentloaded' });
console.log('If you see a Cloudflare check or are logged out, solve it / log in in the window. Waiting 60s...');
await page.waitForTimeout(60_000);

for (const sort of ['Most Popular', 'Newest', 'Most Downloaded']) {
  console.log(`\n>>> Click the "${sort}" sort option in the window now (15s)`);
  await page.waitForTimeout(15_000);
}

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
```

- [ ] **Step 7: Run the probe (manual, needs a human at the keyboard)**

Run: `npm run probe 2>&1 | tee /tmp/probe.log`
Log in to MakerWorld when the window opens, and click the sort options when prompted.
Expected: at least one `=== SEARCH` block with a JSON body, and two `=== DOWNLOAD` blocks with status 200 JSON bodies containing a URL.

- [ ] **Step 8: Record findings** in `docs/notes/endpoints.md`

Fill in this template from `/tmp/probe.log` (copy values exactly):

```markdown
# MakerWorld endpoints (probed YYYY-MM-DD)

## Search
- Method + path: `GET /api/v1/search-service/...`
- Query params: keyword=..., limit=..., offset=..., sort param name=... values: relevance=..., popular=..., newest=..., downloads=...
- Response: top-level array field name: `...`; per-hit fields for id/title/slug/cover/creator name/likes/downloads: ...

## Download
- 3MF `/api/v1/design-service/instance/{profileId}/f3mf?type=download` → JSON field holding the signed URL: `...`; field holding the file name (if any): `...`
- STL `/api/v1/design-service/design/{id}/model?type=download` → JSON field holding the signed URL: `...`
```

Also save one real search response body as `test/fixtures/search-benchy.json` and one 3MF download response body as `test/fixtures/download-3mf.json` (replace the signed URL's query string with `?sig=redacted`).

If the probe shows **no** JSON search request, stop and report to the human before Task 6: the spec's fallback (reading the rendered search page) then applies and Task 6 must be redesigned.

- [ ] **Step 9: Commit**

```bash
git add src/browser.ts test/browser.test.ts scripts/probe.ts docs/notes/endpoints.md test/fixtures/search-benchy.json test/fixtures/download-3mf.json
git commit -m "feat: Playwright browser session, login, and endpoint probe findings"
```

---

### Task 6: Search

**Files:**
- Create: `src/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `BrowserJson`, `mapApiError` (Task 3); `test/fixtures/search-benchy.json` and `docs/notes/endpoints.md` (Task 5).
- Produces:
  ```ts
  type SortOrder = 'relevance' | 'popular' | 'newest' | 'downloads'
  interface SearchParams { query: string; limit: number; sort: SortOrder }
  interface SearchHit { id: number; title: string; url: string; coverUrl: string; creator: string; likes: number; downloads: number }
  buildSearchPath(p: SearchParams): string
  parseSearchResults(body: unknown): SearchHit[]
  searchModels(p: SearchParams, browser: BrowserJson): Promise<SearchHit[]>
  formatSearchResults(query: string, hits: SearchHit[]): string
  ```

The code below uses the most likely shape: the path `/api/v1/search-service/select/design/nav`, parameters `keyword`/`limit`/`offset`/`orderBy`, and a `hits` array whose items use the same field names as the design endpoint. **Before writing it, compare with `docs/notes/endpoints.md` and change only `SEARCH_PATH`, `SORT_VALUES`, the param names in `buildSearchPath`, and the field reads in `parseSearchResults` to match the probe.** The test expectations below that come from the fixture (`hits.length`, first id) must be read from `test/fixtures/search-benchy.json`.

- [ ] **Step 1: Write the failing test** `test/search.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSearchPath, parseSearchResults, searchModels, formatSearchResults, SEARCH_PATH } from '../src/search.js';

const body = JSON.parse(readFileSync(new URL('./fixtures/search-benchy.json', import.meta.url), 'utf8'));

describe('buildSearchPath', () => {
  it('encodes the keyword, limit and sort', () => {
    const p = buildSearchPath({ query: 'benchy boat & co', limit: 5, sort: 'newest' });
    expect(p.startsWith(SEARCH_PATH + '?')).toBe(true);
    const q = new URLSearchParams(p.split('?')[1]);
    expect([...q.values()]).toContain('benchy boat & co');
    expect([...q.values()]).toContain('5');
  });
});

describe('parseSearchResults', () => {
  it('maps real search hits', () => {
    const hits = parseSearchResults(body);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(Number.isInteger(h.id)).toBe(true);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.url).toMatch(/^https:\/\/makerworld\.com\/en\/models\/\d+/);
    }
  });
  it('returns [] for an empty result', () => {
    expect(parseSearchResults({ total: 0, hits: [] })).toEqual([]);
  });
});

describe('searchModels', () => {
  it('calls the browser, trims to limit, and maps login errors', async () => {
    const browser = { browserFetchJson: vi.fn(async () => ({ status: 200, body })) };
    const hits = await searchModels({ query: 'benchy', limit: 2, sort: 'relevance' }, browser);
    expect(hits.length).toBeLessThanOrEqual(2);
    const denied = { browserFetchJson: async () => ({ status: 403, body: { code: 1, error: 'Please log in' } }) };
    await expect(searchModels({ query: 'x', limit: 1, sort: 'relevance' }, denied)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL, cannot resolve `../src/search.js`.

- [ ] **Step 3: Implement** `src/search.ts` (adjusted to the probe findings as described above)

```ts
import { mapApiError, type BrowserJson } from './api.js';
import { MakerWorldError } from './errors.js';

export type SortOrder = 'relevance' | 'popular' | 'newest' | 'downloads';
export interface SearchParams { query: string; limit: number; sort: SortOrder }
export interface SearchHit { id: number; title: string; url: string; coverUrl: string; creator: string; likes: number; downloads: number }

export const SEARCH_PATH = '/api/v1/search-service/select/design/nav';
const SORT_VALUES: Record<SortOrder, string> = {
  relevance: 'score', popular: 'hotScore', newest: 'createTime', downloads: 'downloadCount',
};

export function buildSearchPath(p: SearchParams): string {
  const q = new URLSearchParams({ keyword: p.query, limit: String(p.limit), offset: '0', orderBy: SORT_VALUES[p.sort] });
  return `${SEARCH_PATH}?${q}`;
}

export function parseSearchResults(body: unknown): SearchHit[] {
  const hits = (body as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) throw new MakerWorldError('UPSTREAM_ERROR', `Unexpected search response: ${JSON.stringify(body).slice(0, 200)}`);
  return hits
    .filter((h: any) => typeof h?.id === 'number')
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

export async function searchModels(p: SearchParams, browser: BrowserJson): Promise<SearchHit[]> {
  const { status, body } = await browser.browserFetchJson(buildSearchPath(p));
  const err = mapApiError(status, body);
  if (err) throw err;
  return parseSearchResults(body).slice(0, p.limit);
}

export function formatSearchResults(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `No MakerWorld models found for "${query}".`;
  const lines = hits.map((h, i) =>
    `${i + 1}. [${h.id}] ${h.title} by ${h.creator || 'unknown'} (likes ${h.likes}, downloads ${h.downloads})\n   ${h.url}\n   cover: ${h.coverUrl}`);
  return `Found ${hits.length} result(s) for "${query}":\n\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts test/search.test.ts
git commit -m "feat: model search through the browser session"
```

---

### Task 7: Download

**Files:**
- Create: `src/download.ts`
- Test: `test/download.test.ts`

**Interfaces:**
- Consumes: `getDesign`-shaped function, `BrowserJson`, `mapApiError`, `FetchLike`, `USER_AGENT` (Task 3); `pickProfile`, `buildFilename`, `resolveDownloadDir`, `ModelRef`, `Design` (Tasks 1–2); `BrowserSession.browserGetBuffer` (Task 5); `test/fixtures/download-3mf.json` and `docs/notes/endpoints.md` (Task 5).
- Produces:
  ```ts
  interface DownloadRequest { ref: ModelRef; profileId?: number; format: '3mf' | 'stl'; destDir?: string }
  interface DownloadResult { path: string; bytes: number; profileId?: number; profileTitle?: string }
  interface DownloadDeps {
    getDesign(id: number): Promise<Design>;
    browser: BrowserJson & { browserGetBuffer(url: string): Promise<Buffer> };
    fetch?: FetchLike;
    env?: NodeJS.ProcessEnv;
  }
  extractSignedUrl(body: unknown): string
  downloadModel(req: DownloadRequest, deps: DownloadDeps): Promise<DownloadResult>
  ```

`extractSignedUrl` checks `url`, then `data.url`, then `downloadUrl`. **Before implementing, confirm against `docs/notes/endpoints.md`; if the probe shows another field, put it first in the list.**

- [ ] **Step 1: Write the failing test** `test/download.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSignedUrl, downloadModel, type DownloadDeps } from '../src/download.js';
import { parseDesign } from '../src/parse.js';

const design = parseDesign(JSON.parse(readFileSync(new URL('./fixtures/design-1400000.json', import.meta.url), 'utf8')));
const realBody = JSON.parse(readFileSync(new URL('./fixtures/download-3mf.json', import.meta.url), 'utf8'));
const payload = Buffer.from('PK\u0003\u0004fake-3mf-bytes');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mw-')); });

function deps(over: Partial<DownloadDeps> = {}): DownloadDeps {
  return {
    getDesign: async () => design,
    browser: {
      browserFetchJson: vi.fn(async () => ({ status: 200, body: { url: 'https://cdn.example/file.3mf?sig=1' } })),
      browserGetBuffer: vi.fn(async () => payload),
    },
    fetch: vi.fn(async () => new Response(payload, { status: 200 })),
    env: {},
    ...over,
  };
}

describe('extractSignedUrl', () => {
  it('reads the real 3MF response', () => {
    expect(extractSignedUrl(realBody)).toMatch(/^https:\/\//);
  });
  it('accepts url, data.url and downloadUrl; rejects others', () => {
    expect(extractSignedUrl({ url: 'https://a' })).toBe('https://a');
    expect(extractSignedUrl({ data: { url: 'https://b' } })).toBe('https://b');
    expect(extractSignedUrl({ downloadUrl: 'https://c' })).toBe('https://c');
    expect(() => extractSignedUrl({ nope: 1 })).toThrow(/UPSTREAM|signed/i);
  });
});

describe('downloadModel', () => {
  it('downloads the default profile 3MF into destDir', async () => {
    const d = deps();
    const r = await downloadModel({ ref: { id: 1400000 }, format: '3mf', destDir: dir }, d);
    expect(r.path).toBe(join(dir, '1400000-honkai-star-rail-a-grounded-ascent-hueforge-1451665.3mf'));
    expect(r.bytes).toBe(payload.length);
    expect(r.profileId).toBe(1451665);
    expect(readFileSync(r.path)).toEqual(payload);
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
    expect(d.browser.browserFetchJson).toHaveBeenCalledWith('/api/v1/design-service/instance/1451665/f3mf?type=download');
  });
  it('uses the STL endpoint for format stl', async () => {
    const d = deps();
    const r = await downloadModel({ ref: { id: 1400000 }, format: 'stl', destDir: dir }, d);
    expect(r.path.endsWith('1400000-honkai-star-rail-a-grounded-ascent-hueforge.zip')).toBe(true);
    expect(d.browser.browserFetchJson).toHaveBeenCalledWith('/api/v1/design-service/design/1400000/model?type=download');
  });
  it('uses MAKERWORLD_DOWNLOAD_DIR when no destDir, creating it', async () => {
    const target = join(dir, 'nested', 'out');
    const r = await downloadModel({ ref: { id: 1400000 }, format: '3mf' }, deps({ env: { MAKERWORLD_DOWNLOAD_DIR: target } }));
    expect(r.path.startsWith(target)).toBe(true);
    expect(existsSync(r.path)).toBe(true);
  });
  it('uses the profile id from the URL ref and rejects an unknown one', async () => {
    await expect(downloadModel({ ref: { id: 1400000, profileId: 5 }, format: '3mf', destDir: dir }, deps()))
      .rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });
  it('maps a login error from the download endpoint', async () => {
    const d = deps();
    d.browser.browserFetchJson = async () => ({ status: 403, body: { code: 1, error: 'Please log in to download models.' } });
    await expect(downloadModel({ ref: { id: 1400000 }, format: '3mf', destDir: dir }, d)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });
  it('falls back to the browser when the signed URL returns 403', async () => {
    const d = deps({ fetch: async () => new Response('denied', { status: 403 }) });
    const r = await downloadModel({ ref: { id: 1400000 }, format: '3mf', destDir: dir }, d);
    expect(d.browser.browserGetBuffer).toHaveBeenCalled();
    expect(readFileSync(r.path)).toEqual(payload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/download.test.ts`
Expected: FAIL, cannot resolve `../src/download.js`.

- [ ] **Step 3: Implement** `src/download.ts`

```ts
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mapApiError, USER_AGENT, type BrowserJson, type FetchLike } from './api.js';
import { MakerWorldError } from './errors.js';
import { buildFilename, pickProfile, resolveDownloadDir, type Design, type ModelRef } from './parse.js';

export interface DownloadRequest { ref: ModelRef; profileId?: number; format: '3mf' | 'stl'; destDir?: string }
export interface DownloadResult { path: string; bytes: number; profileId?: number; profileTitle?: string }
export interface DownloadDeps {
  getDesign(id: number): Promise<Design>;
  browser: BrowserJson & { browserGetBuffer(url: string): Promise<Buffer> };
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export function extractSignedUrl(body: unknown): string {
  const b = (body ?? {}) as Record<string, any>;
  for (const candidate of [b.url, b.data?.url, b.downloadUrl]) {
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
  }
  throw new MakerWorldError('UPSTREAM_ERROR', `No signed download URL in response: ${JSON.stringify(body).slice(0, 200)}`);
}

export async function downloadModel(req: DownloadRequest, deps: DownloadDeps): Promise<DownloadResult> {
  const design = await deps.getDesign(req.ref.id);
  const profile = req.format === '3mf' ? pickProfile(design, req.profileId ?? req.ref.profileId) : undefined;
  const apiPath = profile
    ? `/api/v1/design-service/instance/${profile.id}/f3mf?type=download`
    : `/api/v1/design-service/design/${design.id}/model?type=download`;

  const { status, body } = await deps.browser.browserFetchJson(apiPath);
  const err = mapApiError(status, body);
  if (err) throw err;
  const signedUrl = extractSignedUrl(body);

  const dir = resolve(resolveDownloadDir(req.destDir, deps.env ?? process.env));
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, buildFilename(design, req.format, profile?.id));
  const partPath = finalPath + '.part';

  try {
    const res = await (deps.fetch ?? fetch)(signedUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok && res.body) {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(partPath));
    } else if (res.status === 401 || res.status === 403) {
      await writeFile(partPath, await deps.browser.browserGetBuffer(signedUrl));
    } else {
      throw new MakerWorldError('UPSTREAM_ERROR', `File download failed with HTTP ${res.status}`);
    }
    await rename(partPath, finalPath);
  } catch (e) {
    await rm(partPath, { force: true });
    throw e;
  }

  const { size } = await stat(finalPath);
  return { path: finalPath, bytes: size, profileId: profile?.id, profileTitle: profile?.title };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/download.ts test/download.test.ts
git commit -m "feat: download 3MF and STL files to a configurable directory"
```

---

### Task 8: MCP server and tools

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `parseModelRef`, `formatDesign`, `Design` (Tasks 1–2); `LoadedImages` (Task 4); `SearchParams`, `SearchHit`, `formatSearchResults` (Task 6); `DownloadRequest`, `DownloadResult` (Task 7); `MakerWorldError`.
- Produces:
  ```ts
  interface Deps {
    getDesign(id: number): Promise<Design>;
    search(p: SearchParams): Promise<SearchHit[]>;
    download(req: DownloadRequest): Promise<DownloadResult>;
    loadImages(urls: string[]): Promise<LoadedImages>;
  }
  createServer(deps: Deps): McpServer
  ```
  Tool names: `search_models`, `get_model`, `get_model_images`, `download_model`.

- [ ] **Step 1: Write the failing test** `test/server.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, type Deps } from '../src/server.js';
import { parseDesign } from '../src/parse.js';
import { MakerWorldError } from '../src/errors.js';

const design = parseDesign(JSON.parse(readFileSync(new URL('./fixtures/design-1400000.json', import.meta.url), 'utf8')));
const img = (url: string) => ({ url, data: '/9j/AA==', mimeType: 'image/jpeg' as const });

function stubDeps(over: Partial<Deps> = {}): Deps {
  return {
    getDesign: vi.fn(async () => design),
    search: vi.fn(async () => [{ id: 1, title: 'Benchy', url: 'https://makerworld.com/en/models/1-benchy', coverUrl: 'https://c/1.jpg', creator: 'me', likes: 2, downloads: 3 }]),
    download: vi.fn(async () => ({ path: '/tmp/makerworld/x.3mf', bytes: 42, profileId: 1451665, profileTitle: 'p' })),
    loadImages: vi.fn(async (urls: string[]) => ({ images: urls.slice(0, 1).map(img), failed: urls.slice(1) })),
    ...over,
  };
}

async function connect(deps: Deps) {
  const client = new Client({ name: 't', version: '0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), createServer(deps).connect(s)]);
  return client;
}

describe('MCP tools', () => {
  it('lists the four tools', async () => {
    const client = await connect(stubDeps());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['download_model', 'get_model', 'get_model_images', 'search_models']);
  });

  it('get_model accepts a URL and returns formatted text', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'get_model', arguments: { model: 'https://makerworld.com/en/models/1400000-x' } });
    expect(deps.getDesign).toHaveBeenCalledWith(1400000);
    expect((r.content as any[])[0].text).toContain('Honkai');
  });

  it('get_model_images returns image blocks and lists failures', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'get_model_images', arguments: { model: '1400000', max: 2 } });
    const content = r.content as any[];
    expect(deps.loadImages).toHaveBeenCalledWith(design.pictureUrls.slice(0, 2));
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(content.some((b) => b.type === 'text' && b.text.includes('Images not loaded'))).toBe(true);
  });

  it('get_model_images uses profile pictures when profileId is given', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    await client.callTool({ name: 'get_model_images', arguments: { model: '1400000', profileId: 1451665 } });
    expect(deps.loadImages).toHaveBeenCalledWith(design.profiles[0].pictureUrls);
  });

  it('search_models passes defaults and can include thumbnails', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'search_models', arguments: { query: 'benchy', includeThumbnails: true } });
    expect(deps.search).toHaveBeenCalledWith({ query: 'benchy', limit: 10, sort: 'relevance' });
    expect(deps.loadImages).toHaveBeenCalledWith(['https://c/1.jpg']);
    expect((r.content as any[]).some((b) => b.type === 'image')).toBe(true);
  });

  it('download_model reports the saved path', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    // '1400000#x' is not a valid ref: INVALID_INPUT must come back as a tool error, not a crash
    const bad = await client.callTool({ name: 'download_model', arguments: { model: '1400000#x' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as any[])[0].text).toMatch(/^INVALID_INPUT/);
    const ok = await client.callTool({ name: 'download_model', arguments: { model: '1400000', destDir: '/d' } });
    expect(deps.download).toHaveBeenCalledWith({ ref: { id: 1400000 }, profileId: undefined, format: '3mf', destDir: '/d' });
    expect((ok.content as any[])[0].text).toContain('/tmp/makerworld/x.3mf');
  });

  it('maps MakerWorldError to isError with the code', async () => {
    const client = await connect(stubDeps({ getDesign: async () => { throw new MakerWorldError('NOT_LOGGED_IN', 'Run login'); } }));
    const r = await client.callTool({ name: 'get_model', arguments: { model: '1' } });
    expect(r.isError).toBe(true);
    expect((r.content as any[])[0].text).toBe('NOT_LOGGED_IN: Run login');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL, cannot resolve `../src/server.js`.

- [ ] **Step 3: Implement** `src/server.ts`

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MakerWorldError } from './errors.js';
import { formatDesign, parseModelRef, type Design } from './parse.js';
import type { LoadedImages } from './images.js';
import { formatSearchResults, type SearchHit, type SearchParams } from './search.js';
import type { DownloadRequest, DownloadResult } from './download.js';

export interface Deps {
  getDesign(id: number): Promise<Design>;
  search(p: SearchParams): Promise<SearchHit[]>;
  download(req: DownloadRequest): Promise<DownloadResult>;
  loadImages(urls: string[]): Promise<LoadedImages>;
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Block[]; isError?: boolean };

const MODEL = z.string().describe('MakerWorld model id (e.g. 1400000) or model URL');
const MAX_THUMBNAILS = 6;

async function guard(fn: () => Promise<Block[]>): Promise<Result> {
  try {
    return { content: await fn() };
  } catch (e) {
    const text = e instanceof MakerWorldError ? `${e.code}: ${e.message}` : `UPSTREAM_ERROR: ${(e as Error).message}`;
    if (!(e instanceof MakerWorldError)) console.error(e);
    return { content: [{ type: 'text', text }], isError: true };
  }
}

function imageBlocks({ images, failed }: LoadedImages): Block[] {
  const blocks: Block[] = [];
  for (const i of images) blocks.push({ type: 'text', text: i.url }, { type: 'image', data: i.data, mimeType: i.mimeType });
  if (failed.length) blocks.push({ type: 'text', text: `Images not loaded:\n${failed.join('\n')}` });
  return blocks;
}

export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'makerworld', version: '0.1.0' });

  server.registerTool('search_models', {
    description: 'Search MakerWorld for 3D-printable models. Returns ids, titles, creators, likes, downloads and URLs. Uses a browser session.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search keywords'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      sort: z.enum(['relevance', 'popular', 'newest', 'downloads']).optional().describe('Sort order (default relevance)'),
      includeThumbnails: z.boolean().optional().describe(`Also return up to ${MAX_THUMBNAILS} cover images`),
    }),
    annotations: { readOnlyHint: true },
  }, ({ query, limit, sort, includeThumbnails }) => guard(async () => {
    const hits = await deps.search({ query, limit: limit ?? 10, sort: sort ?? 'relevance' });
    const blocks: Block[] = [{ type: 'text', text: formatSearchResults(query, hits) }];
    if (includeThumbnails && hits.length) {
      blocks.push(...imageBlocks(await deps.loadImages(hits.slice(0, MAX_THUMBNAILS).map((h) => h.coverUrl).filter(Boolean))));
    }
    return blocks;
  }));

  server.registerTool('get_model', {
    description: 'Get details of a MakerWorld model: description, tags, license, stats and print profiles (with printer, time, filament).',
    inputSchema: z.object({ model: MODEL }),
    annotations: { readOnlyHint: true },
  }, ({ model }) => guard(async () => {
    const d = await deps.getDesign(parseModelRef(model).id);
    return [{ type: 'text', text: formatDesign(d) }];
  }));

  server.registerTool('get_model_images', {
    description: 'Show the pictures of a MakerWorld model (or of one print profile) as images.',
    inputSchema: z.object({
      model: MODEL,
      profileId: z.number().int().optional().describe('Print profile id; omit for the model gallery'),
      max: z.number().int().min(1).max(10).optional().describe('Max images (default 4)'),
    }),
    annotations: { readOnlyHint: true },
  }, ({ model, profileId, max }) => guard(async () => {
    const ref = parseModelRef(model);
    const d = await deps.getDesign(ref.id);
    const pid = profileId ?? ref.profileId;
    let urls = d.pictureUrls;
    if (pid !== undefined) {
      const p = d.profiles.find((x) => x.id === pid);
      if (!p) throw new MakerWorldError('PROFILE_NOT_FOUND', `Profile ${pid} not found. Valid profile ids: ${d.profiles.map((x) => x.id).join(', ') || '(none)'}`);
      urls = p.pictureUrls;
    }
    urls = urls.slice(0, max ?? 4);
    if (!urls.length) return [{ type: 'text', text: `No pictures for model ${d.id}.` }];
    return [{ type: 'text', text: `${d.title}: ${urls.length} image(s)` }, ...imageBlocks(await deps.loadImages(urls))];
  }));

  server.registerTool('download_model', {
    description: 'Download a MakerWorld model file to local disk: a print-profile 3MF (default) or the raw STL zip. Requires a logged-in browser profile.',
    inputSchema: z.object({
      model: MODEL,
      profileId: z.number().int().optional().describe('Print profile id for 3MF; default profile if omitted'),
      format: z.enum(['3mf', 'stl']).optional().describe('3mf (default) or stl (zip of raw model files)'),
      destDir: z.string().optional().describe('Directory to save into (default $MAKERWORLD_DOWNLOAD_DIR or /tmp/makerworld)'),
    }),
  }, ({ model, profileId, format, destDir }) => guard(async () => {
    const r = await deps.download({ ref: parseModelRef(model), profileId, format: format ?? '3mf', destDir });
    const profile = r.profileId ? `\nProfile: ${r.profileId}${r.profileTitle ? ` (${r.profileTitle})` : ''}` : '';
    return [{ type: 'text', text: `Saved ${r.path}\nSize: ${r.bytes} bytes${profile}` }];
  }));

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS. If `listTools`/`callTool` fails with a zod/JSON Schema conversion error, check `npm ls zod` shows a single 4.x ≥ 4.2 and that the import is `zod/v4`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: register MakerWorld MCP tools"
```

---

### Task 9: CLI entry, smoke test, README

**Files:**
- Create: `src/index.ts`, `scripts/smoke.ts`, `README.md`

**Interfaces:**
- Consumes: `createServer`, `Deps` (Task 8); `getDesign` (Task 3); `loadImages` (Task 4); `BrowserSession`, `runLogin` (Task 5); `searchModels` (Task 6); `downloadModel` (Task 7).
- Produces: `makerworld-mcp` binary (`serve` default, `login`).

- [ ] **Step 1: Implement** `src/index.ts`

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { getDesign } from './api.js';
import { BrowserSession, runLogin } from './browser.js';
import { downloadModel } from './download.js';
import { loadImages } from './images.js';
import { searchModels } from './search.js';
import { createServer } from './server.js';

async function serve(): Promise<void> {
  const browser = new BrowserSession();
  const design = (id: number) => getDesign(id, { browser });
  const server = createServer({
    getDesign: design,
    search: (p) => searchModels(p, browser),
    download: (req) => downloadModel(req, { getDesign: design, browser }),
    loadImages: (urls) => loadImages(urls),
  });
  const shutdown = async () => { await browser.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await server.connect(new StdioServerTransport());
  console.error('makerworld-mcp running on stdio');
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'login') await runLogin();
else if (cmd === 'serve') await serve();
else { console.error('Usage: makerworld-mcp [serve|login]'); process.exit(2); }
```

- [ ] **Step 2: Build and verify the server starts and lists tools**

Run:
```bash
npm run build && chmod +x dist/index.js
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | { cat; sleep 3; } | node dist/index.js | grep -o '"name":"[a-z_]*"'
```
Expected: the four tool names (`search_models`, `get_model`, `get_model_images`, `download_model`) printed. If the server rejects the protocol version, read the supported version from the error and retry with it.

- [ ] **Step 3: Write** `scripts/smoke.ts`

```ts
// Live check against makerworld.com. Manual only: npm run smoke
import { existsSync } from 'node:fs';
import { getDesign } from '../src/api.js';
import { BrowserSession, defaultProfileDir } from '../src/browser.js';
import { downloadModel } from '../src/download.js';
import { loadImages } from '../src/images.js';
import { formatDesign } from '../src/parse.js';
import { searchModels } from '../src/search.js';

const browser = new BrowserSession();
const step = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`PASS ${name}: ${await fn()}`); } catch (e) { console.log(`FAIL ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

await step('get_model', async () => formatDesign(await getDesign(1400000, { browser })).split('\n')[0]);
await step('images', async () => {
  const d = await getDesign(1400000, { browser });
  const r = await loadImages(d.pictureUrls.slice(0, 2));
  if (!r.images.length) throw new Error(`no images; failed ${r.failed.join(', ')}`);
  return `${r.images.length} image(s), ${r.images[0].data.length} base64 chars`;
});

if (!existsSync(defaultProfileDir())) {
  console.log('SKIP search/download: no browser profile. Run `npx makerworld-mcp login` first.');
} else {
  await step('search', async () => {
    const hits = await searchModels({ query: 'benchy', limit: 3, sort: 'relevance' }, browser);
    return hits.map((h) => `${h.id} ${h.title}`).join(' | ');
  });
  await step('download', async () => {
    const r = await downloadModel({ ref: { id: 1400000 }, format: '3mf' }, { getDesign: (id) => getDesign(id, { browser }), browser });
    return `${r.path} (${r.bytes} bytes)`;
  });
}
await browser.close();
```

- [ ] **Step 4: Run the smoke test**

Run: `npm run smoke`
Expected: `PASS get_model`, `PASS images`, then either `SKIP search/download` or `PASS search` and `PASS download` (if you logged in during Task 5). A `FAIL` on search or download means the Task 5 findings were applied wrongly: fix before committing.

- [ ] **Step 5: Write** `README.md`

````markdown
# makerworld-mcp

MCP server for [MakerWorld](https://makerworld.com): search models, read details, view images, and download 3MF/STL files.

## Setup

```bash
npm install && npm run build
npx playwright install chromium   # only needed if Google Chrome is not installed
node dist/index.js login          # one time: log in to MakerWorld, then close the window
```

## Client config

```json
{ "mcpServers": { "makerworld": { "command": "node", "args": ["/absolute/path/to/makerworld-mcp/dist/index.js"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `search_models` | Search by keyword (`limit`, `sort`, `includeThumbnails`) |
| `get_model` | Details, license, stats, print profiles |
| `get_model_images` | Model or profile pictures as images (resized to ≤1568px) |
| `download_model` | Save a profile 3MF (default) or STL zip |

`model` accepts an id (`1400000`) or a URL (`https://makerworld.com/en/models/1400000-...#profileId-1451665`).

## Configuration

| Env var | Default |
|---|---|
| `MAKERWORLD_DOWNLOAD_DIR` | `/tmp/makerworld` (per-call `destDir` overrides) |
| `MAKERWORLD_PROFILE_DIR` | `~/.makerworld-mcp/profile` |
| `MAKERWORLD_HEADLESS` | `true`; set `false` to watch the browser |

## How it works

Model details and images use plain HTTP. Search and downloads go through a headless Chrome using your saved profile, because MakerWorld protects them with Cloudflare and login. MakerWorld has no official API, so endpoints may change; run `npm run smoke` to check.

## Errors

`NOT_LOGGED_IN` or `CLOUDFLARE_BLOCKED`: run `node dist/index.js login` again. `BROWSER_UNAVAILABLE`: run `npx playwright install chromium`.
````

- [ ] **Step 6: Run the full test suite and build once more**

Run: `npx vitest run && npm run build`
Expected: all tests pass, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts scripts/smoke.ts README.md
git commit -m "feat: CLI entry with login, live smoke test, README"
```
