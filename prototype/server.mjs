// Throwaway local UI prototype. No dependencies, persistence, or production build.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
// The tracer imports the moved domain package via `../domain/...`, so the
// server also exposes it (read-only) next to the prototype tree.
const roots = { prototype: path.resolve(root), domain: path.resolve(root, '..', 'domain') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { Location: '/prototype/?variant=A' }); res.end(); return; }
  const segment = url.pathname.split('/')[1];
  const base = roots[segment];
  if (!base) { res.writeHead(404); res.end('Page not found'); return; }
  const relative = url.pathname.replace(/^\/[^/]+\/?/, '') || 'index.html';
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) { res.writeHead(403); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end('Page not found'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Prototype: http://localhost:4173/prototype/?variant=A'));
