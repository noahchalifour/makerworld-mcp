# makerworld-mcp

MCP server for [MakerWorld](https://makerworld.com): search models, read details, view images, and download 3MF/STL files.

## Setup

```bash
npm install && npm run build

node dist/index.js login          # one time, only needed for downloads: log in to MakerWorld, then close the window
```

## Client config

```json
{ "mcpServers": { "makerworld": { "command": "node", "args": ["/absolute/path/to/makerworld-mcp/dist/index.js"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `search_models` | Search by keyword (`limit`, `sort`: relevance / popular / newest / downloads, `includeThumbnails`) |
| `get_model` | Details, license, stats, print profiles (printer, time, filament) |
| `get_model_images` | Model or profile pictures as images (resized to at most 1568px) |
| `download_model` | Save a profile 3MF (default) or the STL zip to disk |

`model` accepts an id (`1400000`) or a URL (`https://makerworld.com/en/models/1400000-...#profileId-1451665`).

## Configuration

| Env var | Default |
|---|---|
| `MAKERWORLD_DOWNLOAD_DIR` | `/tmp/makerworld` (a per-call `destDir` overrides it) |
| `MAKERWORLD_PROFILE_DIR` | `~/.makerworld-mcp/profile` |
| `MAKERWORLD_HEADLESS` | `true`; set `false` to run the browser visibly |
| `MAKERWORLD_CHROME_PATH` | auto-detected Google Chrome / Chromium |

## How it works

Search, model details and images use plain HTTP against `api.bambulab.com` (the same service that backs makerworld.com), so they need no login and no browser.

Downloads need a MakerWorld login. They go through Google Chrome using the saved profile (`login` command). The server starts a normal Chrome process and only attaches to it over CDP, because Cloudflare's captcha loops forever in Chrome launched with Playwright's automation flags, because the download endpoints live on makerworld.com behind Cloudflare and your session cookies. MakerWorld has no official API, so endpoints may change. `npm run smoke` runs a live check. Endpoint notes are in `docs/notes/endpoints.md`.

## Limitations

- If downloads return `CLOUDFLARE_BLOCKED`, run `login` again (it opens a completely plain Chrome window with no debugging port, so Google sign-in works), solve the check, log in, and close Chrome. `MAKERWORLD_HEADLESS` (default `true`) only controls whether Chrome's window is hidden off-screen; it is never truly headless because Cloudflare rejects that. Close any other Chrome using the same profile first.
- Cloudflare rate limits bursts of requests (HTTP 429). The server retries once, then returns `RATE_LIMITED`.
- NSFW search hits are filtered out.

## Errors

| Code | Meaning / fix |
|---|---|
| `NOT_LOGGED_IN` | Run `node dist/index.js login` |
| `CLOUDFLARE_BLOCKED` | Run `login` again, or set `MAKERWORLD_HEADLESS=false` |
| `BROWSER_UNAVAILABLE` | Install Google Chrome or set `MAKERWORLD_CHROME_PATH` |
| `MODEL_NOT_FOUND`, `PROFILE_NOT_FOUND` | Check the id/URL; the message lists valid profile ids |
| `RATE_LIMITED` | Wait a minute and retry |
| `INVALID_INPUT` | `model` must be an id or a makerworld.com model URL |
| `UPSTREAM_ERROR` | Unexpected response from MakerWorld |

## Development

```bash
npm test         # unit tests (fixtures, no network)
npm run build
npm run smoke    # live check against MakerWorld
```
