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

/** 只落 bytes 的一种写法：`exclusive` 决定「新建」还是「就地覆盖」。 */
function writeLockPayload(file, payload, { exclusive }) {
  const fd = fs.openSync(file, exclusive ? 'wx' : 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 「这条锁能不能被回收」—— **只看内容，不看文件是否存在**。
 *
 * 为什么必须改成这样（2026-10-05 事故）：原先判据是「文件在盘上 ⇒ 有人在跑」＋「回收＝unlink」。
 * 可这台机器上 `unlink` 会被宿主**安全删除代理**按「本 turn 删除数超阈值」整批拒掉
 * （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。于是：① `release()` 删不掉、锁留盘上；
 * ② 下一轮的 `reclaimIfStale()` **也是 unlink**、同样被拒，结果连「这条锁是死人的」都判不出来。
 * 文件在不在是**宿主权限**说了算，不是事实 —— 事实是「内容里那位持锁者还在不在」。
 *
 * 三态判据（与 `processAlive` 一致，**别压成布尔**）：
 *   - 内容读不出来（null / 非法 JSON）⇒ **不可回收**。判不了就不动它 —— 与 `inspectWorkflowLock`
 *     的 `unreadable` 同一立场：宁可多报一次冲突，也不冒「把活着的持锁者放进来第二个」的险。
 *   - `releasedAt` 有值 ⇒ 可回收（持锁者**显式**释放过，只是当时删不掉文件）。
 *   - `isAlive(pid) === false` ⇒ 可回收。**只有确证「已不在」才允许**；`true`/`null` 都不许。
 */
function lockIsReclaimable(existing, isAlive) {
  if (!existing || typeof existing !== 'object') return false;
  if (existing.releasedAt) return true;
  return isAlive(existing.pid) === false;
}

/**
 * 回收过期锁：读旧锁 → 判「可不可回收」→ 删；**删不掉不算失败**（退回就地覆盖）。
 *
 * 为什么必须做（2026-09-27 加）：进程被硬杀（任务被杀/断电/宿主重启）时 `release()` 不会跑，
 * 锁文件留在盘上，之后**每一次运行都 `workflow lock busy`**：两条日更链会一起哑掉。
 * 无人值守形态下这是单点故障。
 *
 * 为什么删不掉还能继续（2026-10-05 加）：删除是**一种**清理手段，不是判据。
 * 删不掉时下游的 `take(exclusive: false)` 会就地覆盖，锁照样能易主 —— 那就够了。
 * 把「删不掉」当成回收失败，正是那次把「回收失败」说成「别人在跑」的成因。
 *
 * 返回被回收的旧锁（没回收则 null），让调用方**留痕** —— 静默自愈会让人误以为「本来就没锁」。
 */
function reclaimIfStale(file, isAlive) {
  const existing = readLockFile(file);
  if (!lockIsReclaimable(existing, isAlive)) return null;
  let deleted = false;
  try {
    fs.unlinkSync(file);
    deleted = true;
  } catch (error) {
    if (error.code === 'ENOENT') deleted = true;
    // 其余（EPERM/EACCES/安全删除代理拦截）**不抛**：交给下游覆盖写。
  }
  return { ...existing, deleted };
}

export function acquireWorkflowLock(name, owner, { directory = DEFAULT_DIR, now = new Date(), isAlive = processAlive, onWarn = null } = {}) {
  const file = lockPath(name, directory);
  const payload = { version: 1, name, owner, runId: `${process.pid}-${now.getTime()}`, acquiredAt: now.toISOString(), pid: process.pid };
  const warn = onWarn ?? ((message) => console.error(message));

  /**
   * 拿锁。`exclusive: true` ＝ 新建（首选路径）；`false` ＝ **就地覆盖**。
   *
   * 覆盖写是安全敏感的：它绕过了「文件已存在」这道天然互斥，**只允许在 `lockIsReclaimable`
   * 明确点头之后**调用（见下面的 reclaim 分支）。绝不能用它去抢一位还活着的持锁者的锁。
   */
  const take = (exclusive) => {
    writeLockPayload(file, payload, { exclusive });
    let released = false;
    return {
      ...payload,
      file,
      /**
       * 释放。**永不抛**。
       *
       * 2026-10-05 事故：这个函数挂在 `process.once('exit')` 上，而 `unlinkSync` 被宿主安全删除代理
       * 拒掉（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）⇒ 它抛错 ⇒ 退出处理器里再抛一次，锁还留盘上，
       * 下一轮被自己拦死。删不掉不是失败：持锁者已经结束了，只要**把「我结束了」这件事写下来**，
       * 下一位就能凭内容判断、不必依赖文件有没有被删掉。
       */
      release() {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(file);
          return;
        } catch (error) {
          if (error.code === 'ENOENT') return;
        }
        try {
          writeLockPayload(file, { ...payload, releasedAt: new Date().toISOString(), pid: null }, { exclusive: false });
        } catch (inner) {
          warn(`[workflow-lock] 释放失败（删除与覆盖写都被拒）：${inner.code ?? ''} ${inner.message}；锁文件仍在 ${file}`);
        }
      },
    };
  };

  try {
    return { ...take(true), staleReclaimed: false, reclaimedFrom: null };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // 走到这里＝盘上有锁文件。先判「可不可以回收」，再拿；还是拿不到才报冲突。
  let reclaimedFrom = null;
  let reclaimError = null;
  try {
    reclaimedFrom = reclaimIfStale(file, isAlive);
  } catch (error) {
    // 不再静默吞掉（2026-10-05）：吞掉的后果是「回收失败」被说成「别人在跑」，把人指向反方向。
    reclaimError = error;
  }
  if (reclaimedFrom) {
    try {
      return { ...take(false), staleReclaimed: true, reclaimedFrom };
    } catch (error) {
      if (error.code !== 'EEXIST') reclaimError = reclaimError ?? error;
    }
  }
  const conflict = new Error(`workflow lock busy: ${name}`);
  conflict.code = 'WORKFLOW_LOCK_BUSY';
  conflict.lock = readLockFile(file) ?? { file };
  conflict.staleReclaimed = false;
  if (reclaimError) conflict.reclaimError = `${reclaimError.code ?? ''} ${reclaimError.message}`.trim();
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
  // 显式释放过的锁：文件可能因为**删不掉**还留在盘上，但它已经不是锁了（2026-10-05）。
  // 不认这一支的话，一次「删不掉的释放」会永久显示成「有人在跑」，人就会被引向错误方向。
  if (payload.releasedAt) {
    return { file, locked: false, released: true, stale: false, ...payload };
  }
  // 三态必须原样传出去：`alive === false` 才是「确认过期」；判不了要留 null。
  const alive = isAlive(payload.pid);
  const stale = alive === false ? true : alive === null ? null : false;
  return { file, locked: true, stale, ...payload };
}

export const WORKFLOW_LOCK_NAME = 'merchant-automation';
