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
  it('reads the documented 3MF response', () => {
    expect(extractSignedUrl(realBody)).toMatch(/^https:\/\//);
  });
  it('accepts url, data.url and downloadUrl; rejects others', () => {
    expect(extractSignedUrl({ url: 'https://a' })).toBe('https://a');
    expect(extractSignedUrl({ data: { url: 'https://b' } })).toBe('https://b');
    expect(extractSignedUrl({ downloadUrl: 'https://c' })).toBe('https://c');
    expect(() => extractSignedUrl({ nope: 1 })).toThrow(/UPSTREAM|signed/i);
  });
  it('explains a captcha response', () => {
    expect(() => extractSignedUrl({ code: 1, captchaId: 'x' })).toThrow(/captcha/i);
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
  it('removes the partial file and fails on a non-auth HTTP error', async () => {
    const d = deps({ fetch: async () => new Response('x', { status: 500 }) });
    await expect(downloadModel({ ref: { id: 1400000 }, format: '3mf', destDir: dir }, d)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(readdirSync(dir)).toEqual([]);
  });
});
