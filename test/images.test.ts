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
