// Placeholder production build.
//
// The production application (Next.js editor slice) does not exist yet, so
// there is nothing to bundle. This script enforces the build-time invariant
// the CI relies on — the running Node.js major version matches `.nvmrc` and
// the `engines` field — and emits `dist/build-info.json`, the artifact that
// `test:e2e` runs against. The Next.js slice replaces this placeholder with
// the real build.
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

mkdirSync(path.join(root, 'dist'), { recursive: true });
const info = {
  artifact: 'battles-placeholder-build',
  node: process.versions.node,
  builtAt: new Date().toISOString(),
  revision: process.env.GITHUB_SHA ?? 'local',
};
writeFileSync(path.join(root, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build: placeholder artifact written (node ${process.versions.node}).`);
