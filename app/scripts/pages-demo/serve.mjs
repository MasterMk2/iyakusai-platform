// 組み立てた公開デモ（dist/pages）を、GitHub Pages と同じくサブパスの下で手元に配信して確かめる。
//   node scripts/pages-demo/serve.mjs [--port 5207] [--base /iyakusai-platform/] [--root dist/pages]
// 静的なファイルだけを返す（/api/ も含め、ほかのパスは 404）。ループバックでだけ待ち受ける。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ROOT = path.resolve(APP_DIR, arg('root', 'dist/pages'));
const PORT = Number(arg('port', '5207'));
const BASE = arg('base', '/iyakusai-platform/');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith(BASE)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const rel = decodeURIComponent(pathname.slice(BASE.length)) || 'index.html';
  const file = path.resolve(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}${BASE}`));
