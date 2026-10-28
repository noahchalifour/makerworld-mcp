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
