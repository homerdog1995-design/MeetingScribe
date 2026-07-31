'use strict';

/**
 * scripts/check-syntax.js — this app has no build step (no bundler, no
 * transpiler), so there's nothing that would otherwise catch a syntax error
 * before you open index.html in a browser and see it fail. This walks
 * every .js file under js/ and validates it as an ES module using Node's
 * own parser (`node --check`), without executing any of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.join(__dirname, '..', 'js');

function collectJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const files = collectJsFiles(JS_ROOT);
let failures = 0;

for (const file of files) {
  try {
    // node --check parses without executing; --input-type=module makes it
    // accept import/export syntax the way a browser's <script type="module"> would.
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: fs.readFileSync(file),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`OK    ${path.relative(process.cwd(), file)}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${path.relative(process.cwd(), file)}`);
    console.error(error.stderr?.toString() || error.message);
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed to parse.`);
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} files parsed successfully.`);
}
