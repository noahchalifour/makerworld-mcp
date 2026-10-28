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
  if (b.captchaId || b.code === 1) {
    throw new MakerWorldError('UPSTREAM_ERROR', 'MakerWorld requires a captcha for this download. Complete it once on makerworld.com in the login browser (`makerworld-mcp login`) and retry.');
  }
  throw new MakerWorldError('UPSTREAM_ERROR', `No signed download URL in response: ${JSON.stringify(body).slice(0, 200)}`);
}

export async function downloadModel(req: DownloadRequest, deps: DownloadDeps): Promise<DownloadResult> {
  const design = await deps.getDesign(req.ref.id);
  const profile = req.format === '3mf' ? pickProfile(design, req.profileId ?? req.ref.profileId) : undefined;
  const apiPath = profile
    ? `/api/v1/design-service/instance/${profile.id}/f3mf?type=download`
    : `/api/v1/design-service/design/${design.id}/model?modelType=all&type=download`;

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
