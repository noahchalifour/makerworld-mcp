# MakerWorld endpoints (probed 2026-10-28)

## Search
- Method + path: `GET https://api.bambulab.com/v1/search-service/select/design2`. This host serves plain HTTP with a browser User-Agent and no login. The same path on `makerworld.com` is behind a Cloudflare challenge (403 even from headed Chrome), so it is kept only as a browser fallback.
- Query params: `keyword`, `limit`, `offset`, `orderBy`, `designType=0`.
- Sort values (`orderBy`): relevance=`score`, popular=`hotScore`, newest=`newUploads`, downloads=`downloadCount`. (`createTime`, `newest`, `latest`... are silently ignored and behave like `score`; `likeCount` also works.)
- Response: `{ total, hits: [...] }`. Per hit: `id`, `title`, `slug`, `cover`, `designCreator.name`, `likeCount`, `downloadCount`, `printCount`, `createTime`, `license`, `tags`.
- Rate limiting: Cloudflare returns HTTP 429 (HTML, `cf-mitigated: challenge`) after a burst of requests; waiting ~30-60 s clears it.

## Download (NOT verified live: needs a logged-in session)
- 3MF `/api/v1/design-service/instance/{profileId}/f3mf?type=download` returns JSON with the signed URL in `url` (confirmed by the Makerworld Enhancements userscript, which sends `X-BBL-Client-*` headers). A captcha requirement shows up as `code: 1` with `captchaId`, or HTTP 418.
- STL `/api/v1/design-service/design/{id}/model?type=download`: anonymous call returns 403 `{"code":1,"error":"Please log in to download models."}`. Signed URL field assumed to be `url` as well.
- `test/fixtures/download-3mf.json` is a constructed body in the documented shape, not a captured response.

## Cloudflare behaviour
- Headless Chrome (including `channel: 'chrome'`) is stuck on "Just a moment..." for `makerworld.com`.
- Headed Chrome loads the site on a fresh profile, but in-page `fetch` to challenged API paths still returns the challenge page.
