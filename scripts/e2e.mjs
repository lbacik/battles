// Headless end-to-end smoke test against the production build output.
//
// Serves `dist/` over loopback HTTP (no browser required for this placeholder
// check), asserts the build artifact round-trips, and records
// `e2e-report/report.json` plus `e2e-report/trace.log` for the CI artifact
// upload. Run `npm run build` first. The Next.js slice replaces this with the
// browser harness (item 11 of #8); the report layout is already what CI uploads.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const reportDir = path.join(root, 'e2e-report');

const trace = [];
function log(line) {
  trace.push(`${new Date().toISOString()} ${line}`);
}

function serve(dist) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  return http.createServer((req, res) => {
    log(`${req.method} ${req.url}`);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(dist, pathname.replace(/^\//, '') || 'build-info.json');
    if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

mkdirSync(reportDir, { recursive: true });

let expected;
try {
  expected = readFileSync(path.join(distDir, 'build-info.json'), 'utf8');
} catch {
  const checks = [{ name: 'production build artifact exists', pass: false, error: 'dist/build-info.json is missing' }];
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({ pass: false, checks }, null, 2)}\n`);
  writeFileSync(path.join(reportDir, 'trace.log'), `${new Date().toISOString()} dist/build-info.json is missing\n`);
  console.error('test:e2e: dist/build-info.json is missing; run `npm run build` first.');
  process.exit(1);
}
const checks = [];
const server = serve(distDir);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
log(`listening on ${base}`);
try {
  const res = await fetch(`${base}/build-info.json`);
  const body = await res.text();
  const ok = res.status === 200 && body === expected;
  checks.push({ name: 'GET /build-info.json returns the build artifact', pass: ok, status: res.status });
  log(`GET /build-info.json -> ${res.status} pass=${ok}`);

  const missing = await fetch(`${base}/does-not-exist.json`);
  await missing.text();
  const ok404 = missing.status === 404;
  checks.push({ name: 'GET /does-not-exist.json returns 404', pass: ok404, status: missing.status });
  log(`GET /does-not-exist.json -> ${missing.status} pass=${ok404}`);
} catch (error) {
  checks.push({ name: 'server reachable over loopback', pass: false, error: String(error) });
  log(`fetch failed: ${String(error)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const pass = checks.length > 0 && checks.every((check) => check.pass);
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({ pass, checks }, null, 2)}\n`);
writeFileSync(path.join(reportDir, 'trace.log'), `${trace.join('\n')}\n`);
if (pass) {
  console.log(`test:e2e: PASS (${checks.length} checks, report in e2e-report/)`);
} else {
  console.error('test:e2e: FAIL (see e2e-report/)');
}
process.exit(pass ? 0 : 1);
