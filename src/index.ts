#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { getDesign } from './api.js';
import { BrowserSession, runLogin } from './browser.js';
import { downloadModel } from './download.js';
import { loadImages } from './images.js';
import { searchModels } from './search.js';
import { createServer } from './server.js';

async function serve(): Promise<void> {
  const browser = new BrowserSession();
  const design = (id: number) => getDesign(id, { browser });
  const server = createServer({
    getDesign: design,
    search: (p) => searchModels(p, { browser }),
    download: (req) => downloadModel(req, { getDesign: design, browser }),
    loadImages: (urls) => loadImages(urls),
  });

  const shutdown = async () => { await browser.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport());
  console.error('makerworld-mcp running on stdio');
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'login') await runLogin();
else if (cmd === 'serve') await serve();
else { console.error('Usage: makerworld-mcp [serve|login]'); process.exit(2); }
