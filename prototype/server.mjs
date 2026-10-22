// Throwaway local UI prototype. No dependencies, persistence, or production build.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/prototype/?variant=A' }); res.end(); return; }
  const relative = url.pathname.replace(/^\/prototype\/?/, '') || 'index.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end('Page not found'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Prototype: http://localhost:4173/prototype/?variant=A'));
