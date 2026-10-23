# MakerWorld MCP Server — Design

Date: 2026-10-23
Status: Approved in brainstorming, pending spec review

## Goal

An MCP server that lets an AI assistant search MakerWorld (Bambu Lab's model-sharing site), inspect models, **view their images**, and **download model files** to local disk.

Out of scope: account features (uploads, stats, points, comments), printing, write actions (like, collect, comment).

## Constraints discovered (probe on 2026-10-23)

MakerWorld has no official public API. Plain HTTP from a Node/curl client:

| Endpoint | Result |
|---|---|
| `GET https://makerworld.com/api/v1/design-service/design/{id}` | 200 JSON — title, summary (HTML), tags, stats, license, creator, `instances` (print profiles), `designExtension.design_pictures`, `defaultInstanceId` |
| Images on `https://makerworld.bblmw.com/...` | 200, fetchable directly |
| Search (`/api/v1/search-service/...`), site HTML | 403 Cloudflare "Just a moment..." challenge |
| `GET /api/v1/design-service/design/{id}/model?type=download` | 403 `{"code":1,"error":"Please log in to download models."}` |
| `GET /api/v1/design-service/instance/{instanceId}/f3mf?type=download` | 403 Cloudflare challenge |

Consequence: details and images use plain HTTP. Search and download require a real, logged-in browser session.

## Decisions

- **Hybrid transport.** Plain `fetch` is the default. A Playwright-driven persistent Chrome profile is used only for search and download, and as a fallback when plain HTTP hits a Cloudflare 403. Chosen over browser-only (slow, heavy for the common path) and cookie pasting (`cf_clearance` expires and is bound to the browser fingerprint, so it breaks often).
- **TypeScript/Node** with `@modelcontextprotocol/sdk` over stdio, `zod` for input schemas, `playwright` for the browser, `sharp` for image resizing, `vitest` for tests.
- **Downloads** go to `/tmp/makerworld` by default. Override precedence: per-call `destDir` > env `MAKERWORLD_DOWNLOAD_DIR` > default.
- **Images** are returned as MCP image content (base64) so the assistant can see them. They are downscaled with `sharp` to at most 1568px on the longest side and re-encoded as JPEG (quality 85) to stay well under client size limits.

## Architecture

```
MCP client ──stdio──► makerworld-mcp
                        src/index.ts    entry: `serve` (default) | `login`
                        src/server.ts   registers tools with the MCP SDK
                        src/api.ts      plain-HTTP client for makerworld.com/api/v1
                        src/browser.ts  lazy Playwright persistent context
                        src/images.ts   fetch + resize images → MCP image content
                        src/parse.ts    pure functions: model/instance parsing,
                                        id-from-URL, HTML→text
                        src/download.ts resolve profile, get signed URL, stream to disk
                        src/errors.ts   typed errors (codes below)
```

Each module has one job. `parse.ts` is pure and fully unit-testable from saved JSON fixtures. `browser.ts` is the only module that touches Playwright.

### Browser lifecycle (`browser.ts`)

- Persistent Chrome profile at `~/.makerworld-mcp/profile` (override: env `MAKERWORLD_PROFILE_DIR`). Uses the installed Chrome via `channel: "chrome"`, falling back to Playwright's bundled Chromium.
- Started lazily on the first call that needs it, runs headless, and is reused across calls. It closes after 10 minutes idle and on process exit.
- `browserFetchJson(path)` navigates one page to `https://makerworld.com/` (waiting until the Cloudflare challenge clears, timeout 20s), then runs `fetch(path, {credentials: "include"})` inside the page and returns the parsed JSON plus HTTP status.
- `makerworld-mcp login` launches the same profile **headed**, opens the MakerWorld login page, and waits until the user closes the window. This is a one-time setup for login and for any manual Cloudflare solve.

## Tools

| Tool | Input | Output |
|---|---|---|
| `search_models` | `query: string`, `limit?: 1–50 (default 10)`, `sort?: "relevance" \| "popular" \| "newest" \| "downloads"`, `includeThumbnails?: boolean (default false)` | Text list: id, title, creator, likes, downloads, model URL, cover URL. If `includeThumbnails`, up to 6 cover images as image content. |
| `get_model` | `model: string` (numeric id or a makerworld.com URL) | Text: title, URL, creator, description (HTML→text, truncated to 4,000 chars), tags, categories, license, stats (likes, downloads, prints, collections), and profiles (id, title, printer/plate info if present, filament materials and weight, predicted print time, default flag). |
| `get_model_images` | `model: string`, `profileId?: number`, `max?: 1–10 (default 4)` | Image content for each picture (resized), each preceded by a text line with its original URL. Without `profileId`: the design pictures. With it: that profile's pictures. |
| `download_model` | `model: string`, `profileId?: number`, `format?: "3mf" \| "stl" (default "3mf")`, `destDir?: string` | Text: absolute saved path, size in bytes, profile used. |

`model` accepts `1400000`, `https://makerworld.com/en/models/1400000-some-slug`, or the same URL with `#profileId-1451665`. A profile id in the URL is used when `profileId` is not given.

## Data flow

**get_model / get_model_images.** `api.getDesign(id)` → plain `fetch` with a desktop Chrome User-Agent. On a 403 HTML response (Cloudflare), retry once through `browserFetchJson`. A 404 becomes `MODEL_NOT_FOUND`. Image URLs are fetched directly from the CDN; each image is resized independently.

**search_models.** Always goes through `browserFetchJson`. The exact search endpoint and query parameters are **not yet confirmed**. The first implementation task is a probe that captures the request MakerWorld's own search page makes (via Playwright request logging) and records it in `docs/notes/search-endpoint.md`. If no stable JSON endpoint exists, the fallback is to read result cards from the rendered `/en/search/models?keyword=...` page.

**download_model.**
1. Resolve the design via `getDesign`. Pick the profile: `profileId` > the profile in the URL > `defaultInstanceId` > the first instance. An unknown `profileId` raises `PROFILE_NOT_FOUND`, listing the valid ids.
2. Through `browserFetchJson`, request the signed URL. For `3mf`: `/api/v1/design-service/instance/{profileId}/f3mf?type=download`. For `stl`: `/api/v1/design-service/design/{id}/model?type=download`. The exact response field holding the URL is confirmed in the same probe task as search.
3. Stream the signed URL to disk with plain `fetch` (signed CDN URLs need no cookies; fall back to a browser download if it returns 403). Write to a `.part` file, then rename. Filename: `{id}-{slug}-{profileId}.3mf` or `{id}-{slug}.zip`. Create `destDir` if missing.

## Error handling

All errors are returned as MCP tool errors (`isError: true`) with a code and an actionable message:

| Code | When | Message guidance |
|---|---|---|
| `MODEL_NOT_FOUND` | 404 from the design endpoint | Check the id or URL |
| `PROFILE_NOT_FOUND` | `profileId` not among the instances | Lists the valid profile ids |
| `NOT_LOGGED_IN` | API returns code 1 / "Please log in" | Run `npx makerworld-mcp login` |
| `CLOUDFLARE_BLOCKED` | Challenge not cleared within 20s | Run `npx makerworld-mcp login` and solve it in the window |
| `BROWSER_UNAVAILABLE` | Neither Chrome nor bundled Chromium can launch | Run `npx playwright install chromium` |
| `RATE_LIMITED` | 429 after one retry with 2s backoff | Try again later |
| `UPSTREAM_ERROR` | Any other non-2xx or unparseable response | Includes the status and first 200 chars of the body |

Image fetch or resize failures never fail the call. The image is skipped and its URL is listed under "Images not loaded".

## Testing

- **Unit (vitest, run in CI):** `parse.ts` against JSON fixtures saved from real responses (design 1400000 and 22424); model id/profile extraction from URLs; HTML→text; filename building; destDir precedence; `images.ts` resize on a generated large image (output ≤1568px, JPEG).
- **Integration, mocked:** tool handlers with `api` and `browser` stubbed, covering each error code's mapping.
- **Live smoke (`npm run smoke`, manual, never in CI):** `get_model` and `get_model_images` over plain HTTP. Search and download run only if a logged-in profile exists; otherwise they are reported as skipped.

## Configuration summary

| Env var | Default |
|---|---|
| `MAKERWORLD_DOWNLOAD_DIR` | `/tmp/makerworld` |
| `MAKERWORLD_PROFILE_DIR` | `~/.makerworld-mcp/profile` |
| `MAKERWORLD_HEADLESS` | `true` (set `false` to watch the browser) |

Client config example:

```json
{ "mcpServers": { "makerworld": { "command": "npx", "args": ["-y", "makerworld-mcp"] } } }
```

## Risks

- Internal endpoints can change without notice. All endpoint paths live in `api.ts` and `download.ts`, and the smoke test detects breakage.
- Cloudflare may tighten headless detection. Mitigation: `MAKERWORLD_HEADLESS=false`, and the use of real installed Chrome.
- Downloading through your account is subject to MakerWorld's terms of service; the server only performs actions you request, one at a time.
