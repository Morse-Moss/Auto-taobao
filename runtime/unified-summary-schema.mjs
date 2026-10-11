// 统一 summary schema 校验器（三链对齐 P1 迁移第 1 步，2026-10-11 建）。
//
// 治的病：**三条链各写各的「逐店结论」，九个下游消费方全部长在日报链的私有字段路径上**
// （docs/ops/UNIFIED-SUMMARY-SCHEMA-DRAFT-2026-10-11.md 第二节的现状矩阵）。2026-10-11 07:00
// 推广轮 8 家全败却「照常释放」，直接成因就是推广链不落 summary.json ⇒ 释放判定恒读
// 「无失败」。本文件是绞杀者迁移的第 1 步：先把「统一契约长什么样」钉成一个纯函数，
// 不动任何生产代码；第 2/3/4 步三条链并写新字段，第 5 步消费方逐个切换。
//
// 口径全部来自已拍板的草案（docs/ops/UNIFIED-SUMMARY-SCHEMA-DRAFT-2026-10-11.md，2026-10-11
// 用户确认七项全按推荐）：字段表见其第三节，七条不变量见 3.4，拍板结果见第六节。
//
// 纪律（与 runtime/hold-and-resume-plan.mjs 文件头同款）：
//   · 本文件**零 import**（连 node 内建都不需要）——它是纯函数，自足；
//     不 import 任何 skills/ 下的东西（runtime/arch-boundary.test.mjs 会红），
//     也不 import 任何 runtime 兄弟模块（改 schema 不许牵动别的判据）。
//   · **schema 内不得出现任何业务判据**：分诊表（哪些成因 notifyLevel==='silent'）、
//     修复候选表、店铺名单都不许进来。字段值（如 noActionRequired）的来源在链侧，
//     这里只规定「落在哪个字段、什么形状」。
//   · fail-closed：输入不是对象/缺 shops ⇒ 返回结构化错误，**绝不抛异常**——
//     调用方（未来的写入时校验）拿到的永远是 {ok, errors[]}，红=合并门禁红，
//     不许把「格式问题」升级成「丢整轮结论」（证据优先，见草案 5.2）。
//
// 对草案 3.4 的一处显式扩展（其余逐字实现）：不变量 3 的字面口径是
// 「status !== 'ok'（且 ≠ waiting）⇒ failureClass 必填」，照字面会把 **pending 初值**
// （{status:'pending', stages:[], source:{}}，run-multi-shop-day.mjs 的逐店初值）判红。
// pending 是「还没跑完」不是失败——中断轮落下的 mid-run summary 是真实产物，不该红。
// 因此 pending 与 waiting 同样豁免失败必填项（shop/evidence 也豁免：初值里确实没有）；
// 若带了这些字段，仍按通用形状检查（shop 要与键一致、candidates 要是数组）。
//
// 已知的现状冲突（留给迁移第 2 步定夺，本步如实按草案钉）：日报链「自修救回」的店
// status 已翻 'ok' 但保留 repairRequest/autoRepair 作为审计痕迹（2026-10-11 b1 盖文淘宝）
// ——按不变量 2 的字面口径这是红的。消费方（unfixableShopsOf）先查 status==='ok' 就跳过，
// 所以这些字段对判据无害；但契约上「成功店必须无失败信号」与「保留修复审计痕迹」
// 二者只能留一个，第 2 步并写时必须拍板（清字段，或给不变量 2 加 rescued 豁免）。

/** 统一版本串（拍板 6.4-A：三链同串，守卫靠它分流新旧格式）。 */
export const UNIFIED_SUMMARY_VERSION = 'unified-summary-v1';

/** workflow 登记词表（与 runtime/workflow-catalog.mjs 的 id 同源；不变量 6）。 */
export const WORKFLOWS = Object.freeze(['daily-report', 'promotion-daily', 'product-daily']);

/** 逐店 status 枚举（拍板 6.2-A：四个值全是日报链现存取值，不发明新词）。 */
export const STATUS = Object.freeze(['ok', 'failed', 'pending', 'waiting']);

/** 「失败信号」四件套——不变量 2：ok 店必须缺席或 null。 */
const FAILURE_SIGNAL_FIELDS = Object.freeze(['error', 'failureClass', 'repairRequest', 'autoRepair']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 报错时描述收到的东西，绝不因为描述动作本身再抛一次。 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}`;
}

/**
 * 校验一份 summary 是否符合统一 schema。
 *
 * @returns {{ ok: boolean, errors: Array<{path: string, rule: string, message: string}> }}
 *   - `ok`：errors 为空时才是 true。
 *   - `errors[].path`：定位到具体店具体字段（如 'shops.盖文淘宝.failureClass'）；顶层为 'version' 等。
 *   - `errors[].rule`：'FIELD'（字段表 3.2/3.3 的必填/类型）或 'INV1'…'INV7'（3.4 不变量编号）。
 *   - 任何输入（null / 数组 / 原始值 / 缺 shops）都返回结构化错误，不抛异常。
 */
export function validateSummary(summary) {
  const errors = [];
  const fail = (path, rule, message) => errors.push({ path, rule, message });

  if (!isPlainObject(summary)) {
    fail('', 'FIELD',
      `summary 必须是对象（收到 ${describe(summary)}）——校验器 fail-closed：宁可红，不瞎猜`);
    return { ok: false, errors };
  }

  // ── 顶层必填字段（草案 3.2）：version / workflow / date / shops ──
  // mode / startedAt / finishedAt / round 是可选（推广链现状就不落 mode；round 推广/商品链恒无），
  // 它们与任何消费方判据无关，不校验存在性。
  if (typeof summary.version !== 'string' || !summary.version.trim()) {
    fail('version', 'FIELD', '缺 version（三链同串 unified-summary-v1；守卫靠它分流新旧格式）');
  } else if (summary.version !== UNIFIED_SUMMARY_VERSION) {
    // 不变量 6：version 必须在登记词表内。推广链现值 'promotion-sales1-summary-v1'
    // 是并写期前的旧串，迁移第 3 步换掉——在那之前这里就是红的（迁移仪表的一部分）。
    fail('version', 'INV6',
      `version 不在登记词表内（收到 ${JSON.stringify(summary.version)}，唯一合法值 ${JSON.stringify(UNIFIED_SUMMARY_VERSION)}）`);
  }

  if (typeof summary.workflow !== 'string' || !summary.workflow.trim()) {
    fail('workflow', 'FIELD', '缺 workflow（哪条链写的；驻留续跑 --workflow 与统一回执都要读它）');
  } else if (!WORKFLOWS.includes(summary.workflow)) {
    fail('workflow', 'INV6',
      `workflow 不在登记词表内（收到 ${JSON.stringify(summary.workflow)}，合法值 ${WORKFLOWS.join(' | ')}）`);
  }

  if (typeof summary.date !== 'string' || !summary.date.trim()) {
    fail('date', 'FIELD', '缺 date（业务日）');
  }

  if (!isPlainObject(summary.shops)) {
    fail('shops', 'FIELD', `shops 必须是「店名 → 逐店记录」的对象（收到 ${describe(summary.shops)}）`);
    return { ok: false, errors };
  }

  for (const [key, record] of Object.entries(summary.shops)) {
    validateShopRecord(key, record, fail);
  }
  return { ok: errors.length === 0, errors };
}

function validateShopRecord(key, record, fail) {
  const at = (field) => `shops.${key}.${field}`;
  if (!isPlainObject(record)) {
    fail(`shops.${key}`, 'FIELD', `逐店记录必须是对象（收到 ${describe(record)}）`);
    return;
  }

  const status = record.status;
  if (typeof status !== 'string' || !STATUS.includes(status)) {
    fail(at('status'), 'FIELD',
      `status 必须是枚举值之一（收到 ${JSON.stringify(status ?? null)}，合法值 ${STATUS.join(' | ')}）`);
    // status 是其余一切检查的适用前提，认不出来就到此为止（shop 一致性仍可查）。
    if (record.shop !== undefined) checkShopKeyMatch(key, record.shop, fail);
    return;
  }

  // ── 不变量 1 + evidence（pending 初值豁免：{status:'pending', stages:[], source:{}} 没有 shop/evidence）──
  if (status === 'pending') {
    if (record.shop !== undefined) checkShopKeyMatch(key, record.shop, fail);
  } else {
    if (typeof record.shop !== 'string' || !record.shop.trim()) {
      fail(at('shop'), 'INV1',
        `缺 shop 或非空字符串（不变量 1：map 键与 record.shop 必须一致且非空；键=${JSON.stringify(key)}）`);
    } else {
      checkShopKeyMatch(key, record.shop, fail);
    }
    // evidence 三链统一补（草案 3.3）：成功店与 waiting 店的取证目录也要有指路，
    // agent 到场第一件事靠它（现状全靠人拼路径）。
    if (typeof record.evidence !== 'string' || !record.evidence.trim()) {
      fail(at('evidence'), 'FIELD', '缺 evidence（该店证据目录，相对仓库根）');
    }
  }

  // error 只作人读摘要（判据不建立在措辞上，本仓 .includes 教训），不要求存在，但出现就得是 string|null。
  if (record.error !== undefined && record.error !== null && typeof record.error !== 'string') {
    fail(at('error'), 'FIELD', `error 必须是 string|null（收到 ${describe(record.error)}）`);
  }

  // ── 不变量 2：status==='ok' ⇒ 失败信号四件套必须缺席或 null ──
  if (status === 'ok') {
    for (const field of FAILURE_SIGNAL_FIELDS) {
      if (record[field] !== undefined && record[field] !== null) {
        fail(at(field), 'INV2',
          `status=ok 但带 ${field}（不变量 2：成功店不得带失败信号；自修救回的审计痕迹见本文件头部注记）`);
      }
    }
  }

  // ── 不变量 3：failed ⇒ failureClass 必填 + repairRequest 必带（candidates 允许空）──
  // waiting（不变量 7）与 pending（本文件头注记的扩展）豁免：它们不是失败。
  if (status === 'failed') {
    if (typeof record.failureClass !== 'string' || !record.failureClass.trim()) {
      fail(at('failureClass'), 'INV3',
        'status=failed 缺非空 failureClass（不变量 3：成因代号必须物化在记录上，不许读时现推）');
    }
    if (!isPlainObject(record.repairRequest)) {
      fail(at('repairRequest'), 'INV3',
        'status=failed 缺 repairRequest（不变量 3：哪怕空菜单 {candidates:[]} 也必须有——空菜单正是「需要人看现场」的判据）');
    }
    // 拍板 6.3-A：noActionRequired 提升到记录顶层、与 repairRequest 解耦——失败记录必须显式落它
    // （false=要人管，true=谁都不用动，防「驻留 4 小时等一个不存在的人」，2026-10-05 网林家居案）。
    if (typeof record.noActionRequired !== 'boolean') {
      fail(at('noActionRequired'), 'FIELD',
        'status=failed 缺 noActionRequired:boolean（拍板 6.3-A：记录顶层，值来自分诊表，schema 不复制名单）');
    }
  }

  // repairRequest 只要出现（任何状态，含 ok/waiting），candidates 就必须是数组：
  // 「允许缺」是 waiting 的豁免，「出现了但形状不对」仍是红的——unfixableShopsOf 的第二判据读它。
  if (isPlainObject(record.repairRequest) && !Array.isArray(record.repairRequest.candidates)) {
    fail(`${at('repairRequest')}.candidates`, 'INV3',
      'repairRequest.candidates 必须是数组（空数组=「脚本不知道怎么修，交给人/agent」；非空时元素形状链内自理）');
  }

  // ── 不变量 5 + noActionRequired 类型 ──
  if (record.noActionRequired !== undefined && typeof record.noActionRequired !== 'boolean') {
    fail(at('noActionRequired'), 'FIELD', `noActionRequired 必须是 boolean（收到 ${describe(record.noActionRequired)}）`);
  }
  if (record.noActionRequired === true && status === 'ok') {
    fail(at('noActionRequired'), 'INV5', 'noActionRequired=true 只允许出现在失败记录上（不变量 5：ok 店没有「要不要人管」可言）');
  }

  // ── 不变量 4：autoRepair 形状（没跑过修复就是 null，不许 {}）──
  if (record.autoRepair !== undefined && record.autoRepair !== null) {
    if (!isPlainObject(record.autoRepair)) {
      fail(at('autoRepair'), 'INV4', `autoRepair 必须是对象或 null（收到 ${describe(record.autoRepair)}；没跑过修复就落 null）`);
    } else {
      const { gaveUp, attempted } = record.autoRepair;
      if (typeof gaveUp !== 'string' && gaveUp !== null) {
        // unfixableShopsOf 的判据是 typeof gaveUp === 'string'——undefined/数字会被读成「没跑过」，
        // 所以这里必须是 string|null 二选一，不许缺。
        fail(`${at('autoRepair')}.gaveUp`, 'INV4',
          `autoRepair.gaveUp 必须是 string|null（收到 ${describe(gaveUp)}；非空字符串=脚本自修没救回来）`);
      }
      if (typeof attempted !== 'boolean') {
        // 现状日报链的 autoRepair 没有 attempted——这是欠字段（迁移第 2 步补），
        // 区分「修过没救回来」与「压根没修」靠它。
        fail(`${at('autoRepair')}.attempted`, 'INV4', 'autoRepair.attempted 必须是 boolean（本轮是否真的发起过至少一次修复尝试）');
      }
    }
  }
}

/** 不变量 1 的共性检查：record.shop（存在时）必须与非空 map 键一致。 */
function checkShopKeyMatch(key, shop, fail) {
  if (typeof shop !== 'string' || !shop.trim() || shop !== key) {
    fail(`shops.${key}.shop`, 'INV1',
      `record.shop 与 map 键不一致（不变量 1）：键=${JSON.stringify(key)}，record.shop=${JSON.stringify(shop)}`);
  }
}
