// Lint for the production tree.
//
// `prototype/` is a throwaway experiment and is excluded from every check.
// JavaScript files must parse under `node --check`; TypeScript sources are
// syntax-checked through the installed `typescript` compiler so the app tree
// (`app/`, `lib/`, `e2e/`, scripts) is covered alongside the framework-free
// domain package in `domain/`.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = new Set(['.git', 'node_modules', 'prototype', 'dist', 'out', '.next', 'e2e-report']);
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    if (rel.split(path.sep).some((part) => EXCLUDED.has(part))) continue;
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = collect(root).sort();
const jsFiles = files.filter((file) => JS_EXTENSIONS.has(path.extname(file)));
// Generated declaration files (e.g. Next.js `next-env.d.ts`) carry no
// lintable syntax of their own.
const tsFiles = files.filter(
  (file) => TS_EXTENSIONS.has(path.extname(file)) && !file.endsWith('.d.ts'),
);

let failed = 0;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  const rel = path.relative(root, file);
  if (result.status !== 0) {
    failed += 1;
    console.error(`lint: ${rel} failed node --check:`);
    console.error(String(result.stderr || result.stdout || '').trim());
  }
}

if (tsFiles.length > 0) {
  let typescript;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(root, 'package.json'));
    typescript = require('typescript');
  } catch {
    console.error('lint: TypeScript sources exist but `typescript` is not installed.');
    process.exit(1);
  }
  for (const file of tsFiles) {
    const rel = path.relative(root, file);
    const source = typescript.sys.readFile(file);
    const compilerOptions = rel.endsWith('.tsx') ? { jsx: typescript.JsxEmit.Preserve } : {};
    const transpiled = typescript.transpileModule(source ?? '', {
      compilerOptions,
      reportDiagnostics: true,
      fileName: file,
    });
    const errors = (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      failed += 1;
      console.error(`lint: ${rel} has syntax errors:`);
      for (const diagnostic of errors) {
        console.error(`  ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
      }
    }
  }
}

if (failed > 0) {
  console.error(`lint: ${failed} file(s) failed.`);
  process.exit(1);
}
console.log(
  `lint: ${jsFiles.length} JavaScript and ${tsFiles.length} TypeScript file(s) parsed cleanly (prototype/ excluded).`,
);
