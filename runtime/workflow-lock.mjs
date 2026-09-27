import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve(import.meta.dirname, '.workflow-locks');

function lockPath(name, directory = DEFAULT_DIR) {
  if (!/^[a-z0-9._-]+$/iu.test(name)) throw new Error(`invalid workflow lock name: ${name}`);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${name}.json`);
}

/**
 * 「持锁进程还在不在」——只读探测，不发信号（`signal 0` 只做存在性/权限检查）。
 *
 * 三种回答，**别把它压成布尔**：
 *   true  ＝ 进程在（含 EPERM：进程在，只是没权限给它发信号）
 *   false ＝ 进程肯定不在（ESRCH）
 *   null  ＝ 判断不了（锁里没有合法 pid）⇒ 调用方必须**当成「在」**、fail-closed。
 *
 * 这是「回收过期锁」的正确性根基：**只有拿到 false 才允许回收**。
 * pid 被系统复用给别人也不会误伤 —— 那时要么探测得到 true（照旧 fail-closed，只多报一次冲突），
 * 要么得到 false（说明那个 pid 现在也确实没有活进程）。两种情形都不会
 * 「把还活着的持锁者放进来第二个」。
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

// 导出只为可测（判据要能直接量「死 pid / 活 pid / 判不了」三种回答）。
export { processAlive as isProcessAlive };

function readLockFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 回收过期锁：读旧锁 → 探测持锁进程 → **进程确已不在**才删文件。
 *
 * 为什么必须做（2026-09-27 加）：acquire 用的是 `open(…, 'wx')`，锁文件**只由持锁进程自己删**
 * （`release()` 挂在 `process.once('exit')` 上）。进程被硬杀（任务被杀/断电/宿主重启）时那段不会跑，
 * 锁文件留在盘上，之后**每一次运行都 `workflow lock busy`**：两条日更链会一起哑掉，只能人工去删文件。
 * 无人值守形态下这是单点故障。
 *
 * 返回被回收的旧锁（没回收则 null），让调用方**留痕** —— 静默自愈会让人误以为「本来就没锁」。
 */
function reclaimIfStale(file, isAlive) {
  const existing = readLockFile(file);
  if (!existing) return null;
  if (isAlive(existing.pid) !== false) return null;
  fs.unlinkSync(file);
  return existing;
}

export function acquireWorkflowLock(name, owner, { directory = DEFAULT_DIR, now = new Date(), isAlive = processAlive } = {}) {
  const file = lockPath(name, directory);
  const payload = { version: 1, name, owner, runId: `${process.pid}-${now.getTime()}`, acquiredAt: now.toISOString(), pid: process.pid };
  const take = () => {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    let released = false;
    return { ...payload, file, release() { if (!released) { released = true; try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } } } };
  };
  try {
    return { ...take(), staleReclaimed: false, reclaimedFrom: null };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // 走到这里＝盘上有锁文件。先试回收，再试一次拿锁；还是拿不到才报冲突。
  let reclaimedFrom = null;
  try {
    reclaimedFrom = reclaimIfStale(file, isAlive);
  } catch {
    reclaimedFrom = null;
  }
  if (reclaimedFrom) {
    try {
      return { ...take(), staleReclaimed: true, reclaimedFrom };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const conflict = new Error(`workflow lock busy: ${name}`);
  conflict.code = 'WORKFLOW_LOCK_BUSY';
  conflict.lock = readLockFile(file) ?? { file };
  conflict.staleReclaimed = false;
  throw conflict;
}

export function inspectWorkflowLock(name, options = {}) {
  const file = lockPath(name, options.directory);
  const isAlive = options.isAlive ?? processAlive;
  const payload = readLockFile(file);
  if (!payload) {
    try {
      fs.accessSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { file, locked: false, stale: false };
      throw error;
    }
    // 文件在、内容读不出来（open 与 write 之间被杀）：**判不了就不动它**，stale 报 null，
    // 回收交给人工 —— 宁可多报一次冲突，也不冒「把活着的持锁者放进来第二个」的险。
    return { file, locked: true, stale: null, unreadable: true };
  }
  // 三态必须原样传出去：`alive === false` 才是「确认过期」；判不了要留 null。
  const alive = isAlive(payload.pid);
  const stale = alive === false ? true : alive === null ? null : false;
  return { file, locked: true, stale, ...payload };
}

export const WORKFLOW_LOCK_NAME = 'merchant-automation';
