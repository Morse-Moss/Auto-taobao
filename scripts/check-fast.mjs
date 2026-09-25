import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// `stdio` 必须显式写、且 stdin 只能是 `'ignore'`（2026-09-25，同 CHANGELOG 1.7.1）。
// 为什么门禁脚本也要改：宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回 `EBUSY`
// （`errno=-4082`），而不写 stdio 时默认三根都是管道 ⇒ **门禁自己在沙箱会话里根本跑不起来**，
// 报的还是 `spawnSync git EBUSY`（看起来像 git 坏了）。stdout 要接下来解析，所以只改 stdin。
const GIT_STDIO = ['ignore', 'pipe', 'pipe'];
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: GIT_STDIO })
  .split('\0')
  .filter(Boolean);
const all = process.argv.includes('--all');
const staged = process.argv.includes('--staged');
const changed = all
  ? tracked
  : execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8', stdio: GIT_STDIO })
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
