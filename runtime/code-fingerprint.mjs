import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * 代码版本指纹（2026-10-12 加，HEAD-VS-WORKTREE 事故的止血第 3 件）。
 *
 * 为什么需要它：本项目所有链都跑**工作区**（不是 git HEAD），而工作区可能压着
 * 未提交改动 —— 「这一轮跑的到底是哪版代码」此前只能靠进程创建时间倒推。
 * 从现在起每份 run-receipt 记录三个事实：
 *   gitHead     起跑那一刻的 HEAD 提交号（40 hex；拿不到＝null）
 *   dirtyCount  `git status --porcelain` 的行数（含未跟踪；拿不到＝null）
 *   dirtySha256 上述 porcelain 输出（排序后）的 sha256 —— 同一指纹＝同一份工作区快照
 *
 * 采集失败（不在 git 仓、git 不可用）一律返回 null 字段，**绝不抛错**：
 * 指纹是证据增强，不是门禁；它不许有能力把整条链拖死。
 *
 * 本模块**只做采集**，不做解读；解读（两个指纹是否一致）留给人与后续对账脚本。
 */

const GIT_HEAD_RE = /^[0-9a-f]{40}$/u;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 采集当前工作区的代码版本指纹。
 * @param {{cwd?: string}} [options] 缺省 process.cwd()。
 * @returns {{gitHead: string|null, dirtyCount: number|null, dirtySha256: string|null}}
 *   任一字段拿不到就是 null；三字段独立失败（HEAD 可得而 porcelain 不可得时不同时抹掉）。
 */
export function collectCodeFingerprint({ cwd = process.cwd() } = {}) {
  let gitHead = null;
  try {
    const head = git(['rev-parse', 'HEAD'], cwd).trim();
    if (GIT_HEAD_RE.test(head)) gitHead = head;
  } catch { /* 不在 git 仓库 / git 不可用 —— 留 null */ }
  let dirtyCount = null;
  let dirtySha256 = null;
  try {
    const porcelain = git(['status', '--porcelain'], cwd);
    const lines = porcelain.split('\n').filter((line) => line.trim() !== '');
    dirtyCount = lines.length;
    dirtySha256 = crypto.createHash('sha256')
      .update([...lines].sort().join('\n'))
      .digest('hex');
  } catch { /* 同上 —— 留 null */ }
  return { gitHead, dirtyCount, dirtySha256 };
}

/** 指纹形状判据（run-receipt-v1 的校验与这里共用同一条口径，两处各写就会漂）。 */
export function isValidCodeFingerprintShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.gitHead !== null && !(typeof value.gitHead === 'string' && GIT_HEAD_RE.test(value.gitHead))) return false;
  if (value.dirtyCount !== null && !(Number.isInteger(value.dirtyCount) && value.dirtyCount >= 0)) return false;
  if (value.dirtySha256 !== null && !(typeof value.dirtySha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.dirtySha256))) return false;
  return true;
}
