# MakerWorld endpoints (probed 2026-10-28)

## Search
- Method + path: `GET https://api.bambulab.com/v1/search-service/select/design2`. This host serves plain HTTP with a browser User-Agent and no login. The same path on `makerworld.com` is behind a Cloudflare challenge (403 even from headed Chrome), so it is kept only as a browser fallback.
- Query params: `keyword`, `limit`, `offset`, `orderBy`, `designType=0`.
- Sort values (`orderBy`): relevance=`score`, popular=`hotScore`, newest=`newUploads`, downloads=`downloadCount`. (`createTime`, `newest`, `latest`... are silently ignored and behave like `score`; `likeCount` also works.)
- Response: `{ total, hits: [...] }`. Per hit: `id`, `title`, `slug`, `cover`, `designCreator.name`, `likeCount`, `downloadCount`, `printCount`, `createTime`, `license`, `tags`.
- Rate limiting: Cloudflare returns HTTP 429 (HTML, `cf-mitigated: challenge`) after a burst of requests; waiting ~30-60 s clears it.

## Download (verified live 2026-10-28 with a logged-in profile)
- Both endpoints are on makerworld.com (behind Cloudflare) and need the login cookies, so they are called from inside Chrome.
- 3MF: `GET /api/v1/design-service/instance/{profileId}/f3mf?type=download` returns `{"name":"A Grounded Ascent.3mf","url":"https://makerworld.bblmw.com/...3mf?at=..&exp=..&key=..&uid=..","highCompression":""}`. The signed URL expires after about 5 minutes. Result: a valid 3MF zip (23 MB for design 1400000).
- STL/CAD zip: `GET /api/v1/design-service/design/{id}/model?modelType=all&type=download` (captured by clicking "Download All" on the site) returns `{"name":"","url":"https://makerworld.bblmw.com/.../mszipfile/.../all.zip?..."}`. Without `modelType=all` it returns 404.
- Anonymous calls: 403 `{"code":1,"error":"Please log in to download models."}`. A captcha requirement shows up as `code: 1` with `captchaId`, or HTTP 418.
- `test/fixtures/download-3mf.json` is a constructed body in this shape with the signature redacted.

## Cloudflare behaviour
- Headless Chrome (`--headless`, Playwright or plain) is rejected on makerworld.com. A real, non-headless Chrome window with a logged-in profile passes, even when placed off-screen (`--window-position=-32000,-32000`), which is what the server uses.
- Chrome launched by Playwright (automation flags) makes the captcha loop; Google sign-in also fails in any Chrome with `--remote-debugging-port`, so `login` opens a completely plain Chrome.
- A fresh profile that never logged in still gets challenged on API paths.
