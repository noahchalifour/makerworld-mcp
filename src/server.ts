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
    description: 'Search MakerWorld for 3D-printable models. Returns ids, titles, creators, likes, downloads and URLs.',
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
    description: 'Download a MakerWorld model file to local disk: a print-profile 3MF (default) or the raw STL zip. Requires a logged-in browser profile (run `makerworld-mcp login` once).',
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
