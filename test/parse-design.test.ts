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
