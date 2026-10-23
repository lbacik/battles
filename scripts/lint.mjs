// Lint for the production tree.
//
// `prototype/` is a throwaway experiment and is excluded from every check.
// The production tree is the framework-free domain package in `domain/`
// (plus these scripts), so this script enforces the dependency-free
// baseline: every covered JavaScript file must parse under `node --check`.
// When the Next.js slice introduces real tooling (item 13 of #8), this
// script will delegate to it.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = new Set(['.git', 'node_modules', 'prototype', 'dist', 'e2e-report']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    if (rel.split(path.sep).some((part) => EXCLUDED.has(part))) continue;
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(root).sort();
if (files.length === 0) {
  console.log('lint: no covered JavaScript files (prototype/ excluded).');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  const rel = path.relative(root, file);
  if (result.status !== 0) {
    failed += 1;
    console.error(`lint: ${rel} failed node --check:`);
    console.error(String(result.stderr || result.stdout || '').trim());
  }
}

if (failed > 0) {
  console.error(`lint: ${failed} file(s) failed.`);
  process.exit(1);
}
console.log(`lint: ${files.length} file(s) parsed cleanly (prototype/ excluded).`);
