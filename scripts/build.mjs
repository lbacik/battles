// Production build: the Next.js static export of the PÓLIS app.
//
// Emits the client-only static site to `out/` and records build metadata in
// `dist/build-info.json`. The Node.js version must match `.nvmrc` and the
// `engines` field, the same invariant CI relies on.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function majorOf(version) {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? match[1] : null;
}

const nvmRaw = readFileSync(path.join(root, '.nvmrc'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const nvmMajor = majorOf(nvmRaw);
const enginesMajor = majorOf(String(pkg.engines?.node ?? ''));
const runtimeMajor = process.versions.node.split('.')[0];

const problems = [];
if (!nvmMajor) problems.push('.nvmrc does not contain a Node.js major version');
if (!enginesMajor) problems.push('package.json `engines.node` is missing');
if (nvmMajor && enginesMajor && nvmMajor !== enginesMajor) {
  problems.push(`.nvmrc (${nvmMajor}) disagrees with engines.node (${enginesMajor})`);
}
if (nvmMajor && nvmMajor !== runtimeMajor) {
  problems.push(`running Node.js ${process.versions.node} does not match .nvmrc (${nvmRaw.trim()})`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`build: ${problem}`);
  process.exit(1);
}

const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const result = spawnSync(process.execPath, [nextBin, 'build'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('build: `next build` failed.');
  process.exit(result.status ?? 1);
}

mkdirSync(path.join(root, 'dist'), { recursive: true });
const info = {
  artifact: 'polis-static-export',
  directory: 'out',
  node: process.versions.node,
  builtAt: new Date().toISOString(),
  revision: process.env.GITHUB_SHA ?? 'local',
};
writeFileSync(path.join(root, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log('build: static export written to out/.');
