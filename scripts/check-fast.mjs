import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const all = process.argv.includes('--all');
const staged = process.argv.includes('--staged');
const changed = all
  ? tracked
  : execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => staged ? line : line.slice(3).split(' -> ').at(-1));
const candidates = all ? tracked : changed;

const javascript = candidates.filter((file) => /\.(?:mjs|cjs|js)$/.test(file));
const python = candidates.filter((file) => file.endsWith('.py'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

console.log(`==> fast syntax check: ${javascript.length} JavaScript file(s)${all ? ' [all tracked]' : staged ? ' [staged]' : ' [changed]'}`);
for (const file of javascript) {
  const status = run(process.execPath, ['--check', file]);
  if (status !== 0) process.exit(status);
}

if (python.length > 0) {
  console.log(`==> fast syntax check: ${python.length} Python file(s)`);
  const status = run('py', ['-3', '-m', 'compileall', '-q', ...python]);
  if (status !== 0) process.exit(status);
}

if (javascript.length === 0 && python.length === 0) console.log('==> fast syntax check: no changed source files');
console.log('==> fast syntax check: PASS');
