// Serve the built policy tool (tool/dist) locally: `npm run serve` → http://localhost:4173 (binds 0.0.0.0; PORT overrides).
// index.html is written for the artifact host, which adds the document skeleton; this server adds the same skeleton.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'tool', 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.woff': 'font/woff' };
const SKELETON = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>';

createServer((req, res) => {
  const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, path === '/' ? 'index.html' : path);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  try {
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith('index.html')) body = SKELETON + body.toString() + '</body></html>';
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found — run `npm run build-tool` first');
  }
}).listen(Number(process.env.PORT ?? 4173), '0.0.0.0', () => console.log(`policy tool on http://0.0.0.0:${process.env.PORT ?? 4173}`));
