#!/usr/bin/env node
// Compatibility entrypoint. Weekly tables are the only supported storage.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const script = resolve(fileURLToPath(new URL('./create-weekly-history-tables.mjs', import.meta.url)));
const args = process.argv.slice(2);
if (!args.includes('--start-date') || !args.includes('--end-date')) {
  console.error('Use create-weekly-history-tables.mjs with --start-date and --end-date; fixed historical tables are retired.');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
