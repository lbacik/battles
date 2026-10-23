// Typecheck for the whole tree.
//
// Runs `tsc --noEmit` over the TypeScript sources via `typescript` plus
// `tsconfig.json`; reports when there is nothing to check.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', 'e2e-report']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

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

const files = collect(root);
if (files.length === 0) {
  console.log('typecheck: no TypeScript sources; nothing to check.');
  process.exit(0);
}

const require = createRequire(path.join(root, 'package.json'));
let tsc;
try {
  tsc = require.resolve('typescript/lib/tsc.js');
} catch {
  console.error('typecheck: TypeScript sources exist but `typescript` is not installed.');
  process.exit(1);
}
if (!existsSync(path.join(root, 'tsconfig.json'))) {
  console.error('typecheck: TypeScript sources exist but `tsconfig.json` is missing.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
