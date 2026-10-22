// Format check for the production tree (dependency-free).
//
// `prototype/` is a throwaway and is excluded, as is the generated
// `package-lock.json`. Every other text file must have no trailing whitespace
// and must end with exactly one newline. When the Next.js slice picks a
// formatter (item 13 of #8), this script will delegate to it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = new Set(['.git', 'node_modules', 'prototype', 'dist', 'e2e-report']);
const EXCLUDED_FILES = new Set(['package-lock.json']);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    if (rel.split(path.sep).some((part) => EXCLUDED.has(part))) continue;
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (!EXCLUDED_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of collect(root).sort()) {
  const rel = path.relative(root, file);
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue; // binary
  const text = buffer.toString('utf8');
  if (text.length === 0) continue;
  text.split('\n').forEach((line, index) => {
    if (/[ \t]+$/.test(line)) violations.push(`${rel}:${index + 1}: trailing whitespace`);
  });
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    violations.push(`${rel}: must end with exactly one newline`);
  }
}

if (violations.length > 0) {
  console.error('format:check: violations found:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('format:check: all covered files are formatted (prototype/ excluded).');
