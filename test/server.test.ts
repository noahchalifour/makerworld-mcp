import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, type Deps } from '../src/server.js';
import { parseDesign } from '../src/parse.js';
import { MakerWorldError } from '../src/errors.js';

const design = parseDesign(JSON.parse(readFileSync(new URL('./fixtures/design-1400000.json', import.meta.url), 'utf8')));
const img = (url: string) => ({ url, data: '/9j/AA==', mimeType: 'image/jpeg' as const });

function stubDeps(over: Partial<Deps> = {}): Deps {
  return {
    getDesign: vi.fn(async () => design),
    search: vi.fn(async () => [{ id: 1, title: 'Benchy', url: 'https://makerworld.com/en/models/1-benchy', coverUrl: 'https://c/1.jpg', creator: 'me', likes: 2, downloads: 3 }]),
    download: vi.fn(async () => ({ path: '/tmp/makerworld/x.3mf', bytes: 42, profileId: 1451665, profileTitle: 'p' })),
    loadImages: vi.fn(async (urls: string[]) => ({ images: urls.slice(0, 1).map(img), failed: urls.slice(1) })),
    ...over,
  };
}

async function connect(deps: Deps) {
  const client = new Client({ name: 't', version: '0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), createServer(deps).connect(s)]);
  return client;
}

describe('MCP tools', () => {
  it('lists the four tools', async () => {
    const client = await connect(stubDeps());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['download_model', 'get_model', 'get_model_images', 'search_models']);
  });

  it('get_model accepts a URL and returns formatted text', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'get_model', arguments: { model: 'https://makerworld.com/en/models/1400000-x' } });
    expect(deps.getDesign).toHaveBeenCalledWith(1400000);
    expect((r.content as any[])[0].text).toContain('Honkai');
  });

  it('get_model_images returns image blocks and lists failures', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'get_model_images', arguments: { model: '1400000', max: 2 } });
    const content = r.content as any[];
    expect(deps.loadImages).toHaveBeenCalledWith(design.pictureUrls.slice(0, 2));
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(content.some((b) => b.type === 'text' && b.text.includes('Images not loaded'))).toBe(true);
  });

  it('get_model_images uses profile pictures when profileId is given', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    await client.callTool({ name: 'get_model_images', arguments: { model: '1400000', profileId: 1451665 } });
    expect(deps.loadImages).toHaveBeenCalledWith(design.profiles[0].pictureUrls);
  });

  it('search_models passes defaults and can include thumbnails', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    const r = await client.callTool({ name: 'search_models', arguments: { query: 'benchy', includeThumbnails: true } });
    expect(deps.search).toHaveBeenCalledWith({ query: 'benchy', limit: 10, sort: 'relevance' });
    expect(deps.loadImages).toHaveBeenCalledWith(['https://c/1.jpg']);
    expect((r.content as any[]).some((b) => b.type === 'image')).toBe(true);
  });

  it('download_model reports the saved path', async () => {
    const deps = stubDeps();
    const client = await connect(deps);
    // '1400000#x' is not a valid ref: INVALID_INPUT must come back as a tool error, not a crash
    const bad = await client.callTool({ name: 'download_model', arguments: { model: '1400000#x' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as any[])[0].text).toMatch(/^INVALID_INPUT/);
    const ok = await client.callTool({ name: 'download_model', arguments: { model: '1400000', destDir: '/d' } });
    expect(deps.download).toHaveBeenCalledWith({ ref: { id: 1400000 }, profileId: undefined, format: '3mf', destDir: '/d' });
    expect((ok.content as any[])[0].text).toContain('/tmp/makerworld/x.3mf');
  });

  it('maps MakerWorldError to isError with the code', async () => {
    const client = await connect(stubDeps({ getDesign: async () => { throw new MakerWorldError('NOT_LOGGED_IN', 'Run login'); } }));
    const r = await client.callTool({ name: 'get_model', arguments: { model: '1' } });
    expect(r.isError).toBe(true);
    expect((r.content as any[])[0].text).toBe('NOT_LOGGED_IN: Run login');
  });
});
