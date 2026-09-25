import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// `stdio` 必须显式写、且 stdin 只能是 `'ignore'`（2026-09-25，与 CHANGELOG 1.7.1 同一病根）。
// 宿主沙箱对「给了子进程管道 stdin 的同步 spawn」直接回 `EBUSY`（`errno=-4082`），而 execFileSync 的
// 默认 stdio 三根都是管道 ⇒ 这一处漏写会让 `npm run check:delivery`（AGENTS.md 强制要跑的那一步）
// 直接抛 `spawnSync git EBUSY`，看起来像 git 坏了。1.7.1 修了链上和另外几个门禁脚本，当时漏了这一处。
const GIT_STDIO = ['ignore', 'pipe', 'pipe'];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: GIT_STDIO }).trim();
}

export function evaluateDelivery({ status, mainlineContains, remoteContains, remoteKnown }) {
  if (!mainlineContains) return 'NOT_MERGED';
  if (remoteKnown && !remoteContains) return 'NOT_PUSHED';
  if (status.length > 0) return 'WORKTREE_DIRTY';
  return remoteKnown ? 'DELIVERY_VERIFIED' : 'MAINLINE_VERIFIED_REMOTE_UNKNOWN';
}

function ancestor(commit, ref) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, ref], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const commit = args.find((arg) => arg.startsWith('--commit='))?.slice('--commit='.length) || git(['rev-parse', 'HEAD']);
  const mainline = args.find((arg) => arg.startsWith('--mainline='))?.slice('--mainline='.length) || 'main';
  const remote = args.find((arg) => arg.startsWith('--remote='))?.slice('--remote='.length) || 'origin/main';
  const remoteKnown = (() => {
    try { git(['rev-parse', '--verify', remote]); return true; } catch { return false; }
  })();
  const status = git(['status', '--porcelain=v1']);
  const mainlineContains = ancestor(commit, mainline);
  const remoteContains = remoteKnown && ancestor(commit, remote);
  const verdict = evaluateDelivery({ status, mainlineContains, remoteContains, remoteKnown });

  console.log(`commit=${commit}`);
  console.log(`branch=${git(['branch', '--show-current']) || '(detached)'}`);
  console.log(`mainline=${mainline}`);
  console.log(`mainline_contains_commit=${mainlineContains}`);
  console.log(`remote=${remote}`);
  console.log(`remote_known=${remoteKnown}`);
  console.log(`remote_contains_commit=${remoteContains}`);
  console.log(`worktree_clean=${status.length === 0}`);
  console.log(`worktree_status=${status.length === 0 ? 'clean' : 'dirty (see git status --short)'}`);
  console.log(`verdict=${verdict}`);
  return verdict === 'DELIVERY_VERIFIED' || verdict === 'MAINLINE_VERIFIED_REMOTE_UNKNOWN' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) process.exit(main());
