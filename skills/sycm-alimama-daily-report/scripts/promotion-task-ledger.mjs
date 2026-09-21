// 推广任务台账：把「本轮为哪个目标日提交了哪一个任务」记成**可跨轮核对的事实**。
//
// 为什么非要有它（根因，2026-09-21 晚查清）：
//   阿里妈妈的任务名是 `营销场景报表_YYYYMMDD_HHMMSS`，里面那个日期是**导出日**（提交那一刻），
//   **不含目标日**。于是「列表里这一条任务对应哪一天」在平台上**读不出来**。
//   老实现拿 `newestTaskName`（时间戳最大 = 刚提交的那条）当代理判据，而这个判据只在
//   「本轮确实提交成功了」时才成立 —— 一旦提交段失败或被跳过，它就会把**残留的旧任务**
//   当成自己的 ⇒ 取回别人那天的报表 ⇒ 静默写错数据（这正是状态契约 §三 #4 点名的两处危害之一）。
//   台账把这件事从「代理判据」换成「观察值」：提交段亲眼看它多出来一条并记下，取件段只取那一条。
//
// 口径（与 docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md §三 #4 一致）：
//   · 同一目标日已有未取任务，且**能在列表里核到** ⇒ `reuse`：跳过提交，直接取件
//     （不再对平台产生第二次副作用；这也正是「提交成功但取件前崩了」的自愈路径）
//   · 台账里记着、但列表里核不到，或同一目标日记着多笔 ⇒ `block`：**核不清就不动**
//   · 台账里没有本目标日的记录 ⇒ `block`：**不猜**「列表里最新那条」，并给出怎么修
//   · 别的目标日还挂着未取任务 ⇒ 只**报**不拦（它不危害本轮，而拦住一条无人值守的链
//     直到人来手改 JSON，是比残留更糟的失败模式）
import path from 'node:path';
import fs from 'node:fs';

import { PROMOTION_TASK_PATTERN, newestTaskName } from './collect-core.mjs';

export const LEDGER_VERSION = 1;

/** 台账里一条记录的形状（只做校验用，不给默认值）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export function emptyLedger() {
  return { version: LEDGER_VERSION, records: [] };
}

/**
 * 台账要按「店 + 目标日」定位。店标识优先用 `--expect-shop`（人认识、跨轮稳定），
 * 退而用 `--proxy`（端口，登记表里的值，同样跨轮稳定）。两个都没有就抛 ——
 * 不知道是谁的台账，写进去就是把两家店的任务混成一笔，比不记更糟。
 */
export function ledgerScope({ expectShop = null, proxy = null } = {}) {
  const shop = expectShop ?? proxy;
  if (!shop || !String(shop).trim()) {
    throw new Error('台账需要一个店铺标识：--expect-shop（推荐）或 --proxy —— 缺了它没法判断这条任务是谁的');
  }
  return String(shop).trim();
}

/**
 * 解析台账正文。**fail-closed**：坏掉的台账一律抛，不当成空台账。
 * 理由：台账的全部价值是「我确定它记了什么」；把「读不懂」当成「没有记录」，
 * 会让下一次提交再产生一条副作用，而我们恰恰不知道第一条是什么。
 */
export function parseLedger(text, { file = null } = {}) {
  const where = file ?? '推广任务台账';
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} 不是合法 JSON（${error.message}）—— 不把它当成空台账，先看一眼这个文件`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${where} 的顶层应当是对象（版本 + 记录数组）`);
  }
  if (data.version !== LEDGER_VERSION) {
    throw new Error(`${where} 的版本是 ${JSON.stringify(data.version)}，本代码只认 ${LEDGER_VERSION} —— 不猜旧格式`);
  }
  if (!Array.isArray(data.records)) throw new Error(`${where} 的 records 应当是数组`);
  for (const [index, record] of data.records.entries()) {
    const at = `第 ${index + 1} 条记录`;
    if (!record || typeof record !== 'object') throw new Error(`${where} 的${at}不是对象`);
    if (!DATE_RE.test(String(record.date ?? ''))) throw new Error(`${where} 的${at} date 不是 YYYY-MM-DD`);
    if (!String(record.shop ?? '').trim()) throw new Error(`${where} 的${at}缺 shop`);
    if (!PROMOTION_TASK_PATTERN.test(String(record.taskName ?? ''))) {
      throw new Error(`${where} 的${at} taskName 不是任务名形状：${JSON.stringify(record.taskName)}`);
    }
  }
  return { version: data.version, records: data.records.map((record) => ({ ...record })) };
}

/** 读台账：文件不存在＝还没记过（这是正常的第一次），文件在读得出内容时坏掉＝抛。 */
export function readLedger(file, { read = (target) => fs.readFileSync(target, 'utf8') } = {}) {
  try {
    return parseLedger(read(file), { file });
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

/**
 * 写台账：先写临时文件再改名。**不是洁癖** —— 半截写入的台账会让下一轮读不出内容，
 * 而按上面的口径「读不出」是抛错的，等于一个半截文件能把这条链停住。
 */
export function writeLedger(file, ledger, {
  writeFile = (target, body) => fs.writeFileSync(target, body, 'utf8'),
  mkdirSync = (target) => fs.mkdirSync(target, { recursive: true }),
  renameSync = (from, to) => fs.renameSync(from, to),
  dirnameOf = (target) => path.dirname(target),
} = {}) {
  mkdirSync(dirnameOf(file));
  const body = `${JSON.stringify(ledger, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  writeFile(tmp, body);
  renameSync(tmp, file);
  return ledger;
}

/** 提交段观察到「列表里多出来一条」时记一笔。返回**新**台账（不改入参）。 */
export function recordSubmitted(ledger, { date, shop, taskName, proxy = null, at } = {}) {
  if (!DATE_RE.test(String(date ?? ''))) throw new Error(`recordSubmitted 需要目标日（YYYY-MM-DD），收到 ${JSON.stringify(date)}`);
  if (!String(shop ?? '').trim()) throw new Error('recordSubmitted 需要店铺标识');
  if (!PROMOTION_TASK_PATTERN.test(String(taskName ?? ''))) {
    throw new Error(`recordSubmitted 的 taskName 不是任务名形状：${JSON.stringify(taskName)}`);
  }
  return { ...ledger, records: [...ledger.records, { date, shop, taskName, proxy, submittedAt: at ?? null, consumedAt: null }] };
}

/**
 * 取件段把任务标成「已取」。**upsert**：用 `--task` 显式指定（没有提交记录）时也要落一笔，
 * 否则台账会假装那天从没提交过，下一轮又会去提交一次。
 */
export function recordConsumed(ledger, { date, shop, taskName, at } = {}) {
  if (!PROMOTION_TASK_PATTERN.test(String(taskName ?? ''))) {
    throw new Error(`recordConsumed 的 taskName 不是任务名形状：${JSON.stringify(taskName)}`);
  }
  const hit = ledger.records.findIndex((record) => record.date === date
    && record.shop === shop && record.taskName === taskName && !record.consumedAt);
  if (hit === -1) {
    return { ...ledger, records: [...ledger.records, { date, shop, taskName, proxy: null, submittedAt: null, consumedAt: at ?? null }] };
  }
  const records = ledger.records.map((record, index) => (index === hit ? { ...record, consumedAt: at ?? null } : record));
  return { ...ledger, records };
}

/** 这一目标日、这家店还没取过的任务。 */
export function pendingFor(ledger, { date, shop } = {}) {
  return ledger.records.filter((record) => record.date === date && record.shop === shop && !record.consumedAt);
}

/** 同一家店、别的目标日还挂着的未取任务（只报不拦，见文件头）。 */
export function staleFor(ledger, { date, shop } = {}) {
  return ledger.records.filter((record) => record.shop === shop && record.date !== date && !record.consumedAt);
}

const asNames = (value) => (Array.isArray(value) ? value : []).filter((name) => PROMOTION_TASK_PATTERN.test(String(name)));

export function describeStale(stale = []) {
  if (!stale.length) return null;
  return `台账里还挂着 ${stale.length} 笔别的目标日的未取任务（${stale.map((record) => `${record.date} ${record.taskName}`).join('、')}）`
    + ' —— 不拦本轮，但要知道它们在平台上没被取走';
}

/**
 * 提交段：先判「这一目标日是不是已经提交过、只是没取」。
 * 返回 `reuse`（跳过提交）/ `submit`（照常提交）/ `block`（核不清，不动）。
 */
export function judgeResume({ ledger, date, shop, list = [] } = {}) {
  if (!DATE_RE.test(String(date ?? ''))) throw new Error(`judgeResume 需要目标日（YYYY-MM-DD），收到 ${JSON.stringify(date)}`);
  const names = asNames(list);
  const pending = pendingFor(ledger, { date, shop });
  const stale = staleFor(ledger, { date, shop });
  if (pending.length > 1) {
    return { action: 'block', taskName: null, stale,
      reason: `台账里 ${date} 这家店记着 ${pending.length} 笔未取任务（${pending.map((record) => record.taskName).join('、')}）`
        + ' ⇒ 分不清哪一笔是本轮该用的，核不清就不提交' };
  }
  if (pending.length === 1) {
    const { taskName } = pending[0];
    if (names.includes(taskName)) {
      return { action: 'reuse', taskName, stale,
        reason: `台账记着 ${date} 已提交过 ${taskName}，且它仍在下载任务列表里（列表 ${names.length} 条）`
          + ' ⇒ 跳过提交，直接取件（不再对平台产生第二次副作用）' };
    }
    return { action: 'block', taskName: null, stale,
      reason: `台账记着 ${date} 已提交 ${taskName}，但它已不在下载任务列表里（列表现有 ${names.length} 条）`
        + ' ⇒ 无法确认平台那边这一笔还在不在，核不清就不提交（先人工看一眼「下载任务管理」）' };
  }
  return { action: 'submit', taskName: null, stale, reason: `台账里没有 ${date} 这家店的未取任务` };
}

/**
 * 提交段：这份「提交成功」是不是**看得见**的。
 * 判据是列表的**差集**，不是「出现了一个新任务」这种模糊说法：
 *   差集恰好 1 条 ⇒ 就是它；0 条 ⇒ 平台没接受（或同名被合并），不能算成功；多条 ⇒ 核不清。
 *
 * ⚠️ 但「一条都没读到」**不是**「没有新增」：两者在差集上完全同形（都是空集）。
 * 提交前明明读到若干条、提交后一条都读不到，说明这一屏**根本不是任务列表**
 * （没导航过去、还没渲染、被弹窗/降级视图顶掉）—— 那是**读数失败**，不是平台的答案。
 * 这个区分是花代价买来的：2026-09-21 排练里 `waitForNewTask` 少了「先导航到列表」这一步，
 * 于是每条读数都是空集，被这条判据说成「平台没接受这次提交」，里可林停在 promotion-submit；
 * 而同一刻平台上那条任务已经生成好了（见 collect-promotion-report 的 waitForNewTask 注释）。
 * ⇒ 读数不成立时必须**单独报出来**，不许混进「平台没接受」里去。
 */
export function judgeSubmitOutcome({ before = [], after = [] } = {}) {
  const beforeNames = asNames(before);
  const afterNames = asNames(after);
  const seen = new Set(beforeNames);
  const added = [...new Set(afterNames)].filter((name) => !seen.has(name));
  if (added.length === 1) return { ok: true, taskName: added[0], added, reason: `列表里恰好多出 1 条：${added[0]}` };
  if (beforeNames.length > 0 && afterNames.length === 0) {
    return { ok: false, taskName: null, added, unreadable: true,
      reason: `提交前读到 ${beforeNames.length} 条任务名、提交后一条都读不到`
        + ' ⇒ 这不是「没有新增」，是这一次读数不成立（这一屏没落在「下载任务管理」上，或列表还没渲染出来）' };
  }
  if (added.length === 0) {
    return { ok: false, taskName: null, added,
      reason: `提交之后列表里没有多出任何任务（提交前 ${beforeNames.length} 条）`
        + (beforeNames.length === 0 ? '（提交前一条都没读到 —— 基线读数本身就可疑）' : '')
        + ' ⇒ 平台可能没接受这次提交，或同名任务被合并；**不能**当成提交成功' };
  }
  return { ok: false, taskName: null, added,
    reason: `一次提交在列表里多出了 ${added.length} 条（${added.join('、')}）⇒ 分不清本轮该取哪一条，核不清`
      + (beforeNames.length === 0 ? '（提交前一条都没读到 —— 基线读数本身就可疑）' : '') };
}

/**
 * 取件段：本轮该取哪一个任务。**这里刻意没有「列表里最新那条」这个回退** ——
 * 任务名只有导出日、没有目标日，猜错就是把别的日子数据写进这一天，而那种错没有便宜的下游检查。
 * 唯一被承认的两条来源：调用方显式 `--task`，或台账里那一笔未取任务**且列表里核得到**。
 */
export function judgeFetchTaskName({ ledger, date, shop, list = [], explicit = null } = {}) {
  if (!DATE_RE.test(String(date ?? ''))) throw new Error(`judgeFetchTaskName 需要目标日（YYYY-MM-DD），收到 ${JSON.stringify(date)}`);
  const names = asNames(list);
  // 这一支的错误信息要给出**看得见的现场**：列表里最新的是哪一条。
  // 它同时也是 newestTaskName 在本仓里唯一的用途 —— 只用来**告诉你现场长什么样**，
  // 不再用来决定「取哪一条」（那件事只有台账与 --task 有资格决定）。
  const newest = newestTaskName(names);
  const hint = newest ? `列表里最新的一条是 ${newest}` : '列表里没有任何任务名形状的条目';
  if (explicit) {
    if (names.includes(explicit)) {
      return { ok: true, taskName: explicit, reason: `--task 显式指定且列表里有它（列表 ${names.length} 条）` };
    }
    return { ok: false, taskName: null,
      reason: `--task 指定的 ${explicit} 不在列表里（现有 ${JSON.stringify(names)}；${hint}）` };
  }
  const pending = pendingFor(ledger, { date, shop });
  if (pending.length === 1) {
    const { taskName } = pending[0];
    if (names.includes(taskName)) {
      return { ok: true, taskName, reason: `台账里 ${date} 的未取任务，且列表里核到了（列表 ${names.length} 条）` };
    }
    return { ok: false, taskName: null,
      reason: `台账里 ${date} 的未取任务是 ${taskName}，但它不在列表里（现有 ${JSON.stringify(names)}）`
        + ' ⇒ 核不清，不取' };
  }
  if (pending.length > 1) {
    return { ok: false, taskName: null,
      reason: `台账里 ${date} 记着 ${pending.length} 笔未取任务（${pending.map((record) => record.taskName).join('、')}）⇒ 分不清该取哪一条` };
  }
  return { ok: false, taskName: null,
    reason: `台账里没有 ${date} 这家店的未取任务 ⇒ 不拿「列表里最新那条」去猜`
      + '（任务名只有导出日、没有目标日，猜错就是把别天的数据写进这一天）。'
      + `${hint}；先跑 --phase submit，或用 --task 显式指定那一条` };
}
