// Live check against makerworld.com. Manual only: npm run smoke
import { existsSync } from 'node:fs';
import { getDesign } from '../src/api.js';
import { BrowserSession, defaultProfileDir } from '../src/browser.js';
import { downloadModel } from '../src/download.js';
import { loadImages } from '../src/images.js';
import { formatDesign } from '../src/parse.js';
import { searchModels } from '../src/search.js';

const browser = new BrowserSession();
const step = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`PASS ${name}: ${await fn()}`); } catch (e) { console.log(`FAIL ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

await step('get_model', async () => formatDesign(await getDesign(1400000, { browser })).split('\n')[0]);
await step('images', async () => {
  const d = await getDesign(1400000, { browser });
  const r = await loadImages(d.pictureUrls.slice(0, 2));
  if (!r.images.length) throw new Error(`no images; failed ${r.failed.join(', ')}`);
  return `${r.images.length} image(s), ${r.images[0].data.length} base64 chars`;
});
await step('search', async () => {
  const hits = await searchModels({ query: 'benchy', limit: 3, sort: 'relevance' }, { browser });
  if (!hits.length) throw new Error('no hits');
  return hits.map((h) => `${h.id} ${h.title}`).join(' | ');
});

if (!existsSync(defaultProfileDir())) {
  console.log('SKIP download: no logged-in browser profile. Run `npx makerworld-mcp login` first.');
} else {
  await step('download', async () => {
    const r = await downloadModel({ ref: { id: 1400000 }, format: '3mf' }, { getDesign: (id) => getDesign(id, { browser }), browser });
    return `${r.path} (${r.bytes} bytes)`;
  });
}
await browser.close();
