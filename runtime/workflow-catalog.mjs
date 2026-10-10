// 工作流登记表（spec §4「工作流登记契约」的落地）。
//
// 这一层**只保存字符串和确定性配置**：不 import `skills/` 下的业务代码、
// 也不 import `runtime/` 下其它业务模块（node 内置模块可用）。入口脚本一律以
// 「仓库根相对路径字符串」登记，由调度器按字符串启动 —— 目的是止住
// `runtime -> skills` 的反向依赖继续扩大（spec §4.1 的原话）。
//
// 为什么入口必须是字符串而不是 import：一旦 catalog import 了业务入口，
// 「读一下登记表」就会连带把整条业务链的副作用模块全加载进来；
// 而登记表的使用方（调度器 / run-batches 启动自检）恰恰需要在**起任何浏览器之前**
// 就能回答「这个 workflow 登记过没有、入口在哪」。
//
// 与执行器「不说两套话」：daily-report / promotion-daily 的 entry.batch 必须与
// `runtime/batch-plan.mjs` 的 `BATCH_FILES.chain` / `buildBatchSteps` 现用链文件**逐字一致**
// —— 由 `workflow-catalog.test.mjs` 从 batch-plan 实际推导并钉住，两边谁改了另一边当场红。
//
// ⚠️ 周报入口选择的说明：`scripts/run-weekly-workflow.mjs` 与 `runtime/weekly-workflow-core.mjs`
// 目前**未被 git 跟踪**（并行开发线未提交的产物，随时可能改名/消失），所以这里登记
// **已被跟踪**的 `runtime/run-weekly-collection.mjs`（本周竞品采集驱动）。引用它没有
// 上述风险；等并行线合入并提交后，若入口切换，改这里的字符串即可（测试会守住文件存在性）。

/**
 * 登记项的公共骨架（spec §4.2）。四条主流程在这一版里除
 * entry / label / resources / defaultBatchSize 的占位说明外完全同构：
 * version 一律 '1.0.0'，dateInput 一律 'yesterday'，手动默认 dry-run、
 * 调度只许显式 apply，生产写入必须走 explicit-apply。
 */
const COMMON_FIELDS = Object.freeze({
  version: '1.0.0',
  planner: 'batch-v1',
  dateInput: 'yesterday',
  mode: Object.freeze({ manualDefault: 'dry-run', schedulerAllowed: Object.freeze(['apply']) }),
  shopSource: 'runtime/browser-ports.mjs',
  commitPolicy: 'explicit-apply',
  receiptSchema: 'run-receipt-v1',
  evidencePolicy: 'run-root-v1',
  notificationPolicy: 'shared-notify-v1',
});

/** 与 `runtime/batch-plan.mjs` 的 `BATCH_FILES.chain` 逐字一致（测试钉住，别单方面改）。 */
const DAILY_REPORT_CHAIN = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
/** 与 `runtime/batch-plan.mjs` 的 `buildBatchSteps(workflow='promotion-daily')` 现用链文件逐字一致（测试钉住）。 */
const PROMOTION_SALES1_CHAIN = 'skills/sycm-alimama-daily-report/scripts/run-promotion-sales1.mjs';

function entry(id, label, batch, single, defaultBatchSize, resources, note) {
  return Object.freeze({
    id,
    version: COMMON_FIELDS.version,
    label,
    entry: Object.freeze({ batch, single }),
    planner: COMMON_FIELDS.planner,
    defaultBatchSize,
    dateInput: COMMON_FIELDS.dateInput,
    mode: COMMON_FIELDS.mode,
    resources: Object.freeze([...resources]),
    shopSource: COMMON_FIELDS.shopSource,
    commitPolicy: COMMON_FIELDS.commitPolicy,
    receiptSchema: COMMON_FIELDS.receiptSchema,
    evidencePolicy: COMMON_FIELDS.evidencePolicy,
    notificationPolicy: COMMON_FIELDS.notificationPolicy,
    ...(note ? { note } : {}),
  });
}

/**
 * 四条主流程的登记表。键即 workflow id；结构只读（递归 freeze），
 * 使用方拿到的任何一个子对象都改不动 —— 防止「跑批中途有人往登记表里塞私货」。
 */
export const WORKFLOW_CATALOG = Object.freeze({
  // 日报：entry.batch 必须等于 batch-plan 的 BATCH_FILES.chain（run-batches 的 chain 步现用值）；
  // run-multi-shop-day.mjs 本身支持 `--shops`，所以单店也是同一个文件。
  'daily-report': entry(
    'daily-report',
    '日报',
    DAILY_REPORT_CHAIN,
    DAILY_REPORT_CHAIN,
    5,
    ['merchant-browser', 'shop-browser', 'feishu'],
  ),

  // 推广日报：entry.batch 与 batch-plan 的 buildBatchSteps（promotion-daily 分支）现用链文件逐字一致；
  // 单店走 run-promotion-daily-report.mjs。
  'promotion-daily': entry(
    'promotion-daily',
    '推广日报',
    PROMOTION_SALES1_CHAIN,
    'skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs',
    5,
    ['merchant-browser', 'shop-browser', 'feishu'],
  ),

  // 商品日报：run-product-data-job.mjs 的 parseArgs 支持 `--shops`（单店/点名子集），
  // 所以 batch 与 single 是同一个文件 —— 单店就是「--shops 只给一家」的批次形态。
  'product-daily': entry(
    'product-daily',
    '商品日报',
    'scripts/run-product-data-job.mjs',
    'scripts/run-product-data-job.mjs',
    5,
    ['merchant-browser', 'shop-browser', 'feishu'],
  ),

  // 周报：入口选**已被 git 跟踪**的 runtime/run-weekly-collection.mjs（见文件头 docblock 的风险说明）。
  // 该驱动按 `--ranges` 分段（每段 4 页）、自己不碰浏览器，**不按 --shops 切批**，
  // 所以 batch / single 指同一个文件、两者不构成两种形态。
  //
  // defaultBatchSize = 5 是**占位值**：spec §4.2 的表格里周报默认批次写「按流程」，
  // 但 §4.3 又要求 defaultBatchSize 必须是正整数 —— 两者矛盾（已按任务要求记为「规格内冲突」），
  // 先按正整数占位登记，等业务负责人拍板后改成真实值或引入「按流程」的显式语义。
  //
  // resources 未逐项核实：驱动自身只用 feishu 通知（notify-feishu.mjs），采集段经
  // run-collection-host 起的浏览器走代理；按任务指示先登记 ['merchant-browser','feishu'] 并在此注明未核实。
  'weekly-report': entry(
    'weekly-report',
    '周报',
    'runtime/run-weekly-collection.mjs',
    'runtime/run-weekly-collection.mjs',
    5,
    ['merchant-browser', 'feishu'],
    'defaultBatchSize=5 为占位值（spec 表格写「按流程」、§4.3 要求正整数，规格内冲突待业务负责人确认）；resources 未逐项核实',
  ),
});

/**
 * 取一条登记项。**未登记的 id 当场抛错，绝不回退到 daily-report**：
 * 回退的表现是「跑完了，但跑的是另一条流程」—— 一个不会报错的错跑，
 * 比「立刻失败」危险得多（spec §4.3 明写不得回退到日报默认入口）。
 *
 * @param {string} id
 * @returns {Readonly<object>} 登记项（递归 freeze 的只读结构）
 */
export function getWorkflow(id) {
  if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(WORKFLOW_CATALOG, id)) {
    return WORKFLOW_CATALOG[id];
  }
  throw new Error(
    `未登记的工作流：${JSON.stringify(id)}（已登记：${listWorkflowIds().join('、')}）`
    + ' —— 拒绝回退到任何默认入口，请先在 runtime/workflow-catalog.mjs 登记',
  );
}

/** 全部已登记的 workflow id（登记顺序）。 */
export function listWorkflowIds() {
  return Object.keys(WORKFLOW_CATALOG);
}

/**
 * 统一入口的模式解析（spec §5.1，**纯函数**）。
 *
 * 规则（优先级从高到低）：
 *   1. 显式 `--mode` 赢；
 *   2. `--commit` ⇒ 等价 `--mode apply`（兼容期），返回 `convertedFromCommit: true`
 *      让调用方**打印一行转换提示**（不打印的话，「--commit 还能用」这件事就没人知道是借来的）；
 *   3. `--mode dry-run` 与 `--commit` **同给且矛盾** ⇒ 抛错（调用方应退 2）——
 *      静默选边会让「我以为在排练、实际写了飞书」（或反过来）两种假结论都成立；
 *   4. 都没给 ⇒ `entry.mode.manualDefault`（本轮四条流程均为 dry-run）。
 *
 * 注意：`--mode apply` + `--commit` **不矛盾**（两者语义一致），mode 赢、且不算转换。
 *
 * @param {{modeArg?:string|null, commitFlag?:boolean, entry?:object}} o
 * @returns {{mode:'dry-run'|'apply', convertedFromCommit:boolean}}
 */
export function resolveRunMode({ modeArg = null, commitFlag = false, entry = null } = {}) {
  if (modeArg !== null && modeArg !== undefined) {
    if (modeArg !== 'dry-run' && modeArg !== 'apply') {
      throw new Error(`--mode 只能是 dry-run|apply，收到 ${JSON.stringify(modeArg)}`);
    }
    if (commitFlag && modeArg === 'dry-run') {
      throw new Error('--mode dry-run 与 --commit 矛盾（一个要排练、一个要写入）—— 去掉其中一个再跑');
    }
    return { mode: modeArg, convertedFromCommit: false };
  }
  if (commitFlag) return { mode: 'apply', convertedFromCommit: true };
  const fallback = entry?.mode?.manualDefault;
  if (fallback !== 'dry-run' && fallback !== 'apply') {
    throw new Error(`登记项的 mode.manualDefault 非法：${JSON.stringify(fallback)}`);
  }
  return { mode: fallback, convertedFromCommit: false };
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const MANUAL_MODES = new Set(['dry-run', 'apply']);

/**
 * 结构自检（spec §4.3 的判据做成可复用函数）：
 * 供 `workflow-catalog.test.mjs` 与 run-batches **启动时**自检用 ——
 * 启动时发现登记表本身不合法，比起跑到一半才暴露，代价小一个量级。
 *
 * 纯结构校验，不碰文件系统；文件存在性由调用方注入 `exists(path)`
 * （传 `null` / 不传则跳过该项 —— 本模块坚持零 I/O 依赖）。
 *
 * @param {(path:string)=>boolean} [exists] 入口文件存在性判定（如 fs.existsSync，相对仓库根）
 * @returns {string[]} 错误清单；空数组＝登记表合法
 */
export function validateCatalogEntries(exists = null) {
  const errors = [];
  const seen = new Set();
  for (const id of listWorkflowIds()) {
    const item = WORKFLOW_CATALOG[id];
    const where = `[${id}]`;
    if (seen.has(id)) errors.push(`${where} id 重复`); // Object 键本就唯一，这条是防未来改成数组
    seen.add(id);
    if (item.id !== id) errors.push(`${where} id 字段（${item.id}）与登记键不一致`);
    if (typeof item.label !== 'string' || !item.label) errors.push(`${where} label 缺失`);
    if (typeof item.version !== 'string' || !SEMVER_RE.test(item.version)) {
      errors.push(`${where} version 不符合 semver 形式：${JSON.stringify(item.version)}`);
    }
    for (const kind of ['batch', 'single']) {
      const file = item.entry?.[kind];
      if (typeof file !== 'string' || !file.endsWith('.mjs')) {
        errors.push(`${where} entry.${kind} 不是 .mjs 路径字符串：${JSON.stringify(file)}`);
      } else if (exists && !exists(file)) {
        errors.push(`${where} entry.${kind} 文件不存在：${file}`);
      }
    }
    if (!Number.isInteger(item.defaultBatchSize) || item.defaultBatchSize < 1) {
      errors.push(`${where} defaultBatchSize 必须是 ≥1 的整数：${JSON.stringify(item.defaultBatchSize)}`);
    }
    if (!MANUAL_MODES.has(item.mode?.manualDefault)) {
      errors.push(`${where} mode.manualDefault 只能是 dry-run/apply：${JSON.stringify(item.mode?.manualDefault)}`);
    }
    // 生产写入只能显式 apply：两个条件缺一不可 ——
    // commitPolicy 不是 explicit-apply 意味着有隐式提交路径；schedulerAllowed 含 dry-run
    // 之外的宽松项（或没把 apply 列为唯一允许值）意味着调度可能带着非 apply 语义写生产。
    if (item.commitPolicy !== 'explicit-apply') {
      errors.push(`${where} commitPolicy 必须是 explicit-apply：${JSON.stringify(item.commitPolicy)}`);
    }
    const allowed = Array.isArray(item.mode?.schedulerAllowed) ? item.mode.schedulerAllowed : [];
    if (allowed.length !== 1 || allowed[0] !== 'apply') {
      errors.push(`${where} mode.schedulerAllowed 必须恰为 ['apply']：${JSON.stringify(allowed)}`);
    }
    if (!Array.isArray(item.resources) || item.resources.length === 0
      || item.resources.some((r) => typeof r !== 'string' || !r)) {
      errors.push(`${where} resources 必须是非空字符串数组：${JSON.stringify(item.resources)}`);
    }
    for (const field of ['planner', 'dateInput', 'shopSource', 'receiptSchema', 'evidencePolicy', 'notificationPolicy']) {
      if (typeof item[field] !== 'string' || !item[field]) errors.push(`${where} ${field} 缺失`);
    }
  }
  return errors;
}
