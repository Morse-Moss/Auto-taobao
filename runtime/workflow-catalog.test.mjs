// workflow-catalog 的登记校验（spec §4.3 全部判据 + 「catalog 与执行器不说两套话」的钉子）。
//
// 必须从仓库根目录跑：`node --test runtime/workflow-catalog.test.mjs`
// —— 入口文件存在性与「源码不 import skills」都按「仓库根相对路径」判，
// 换目录跑会把相对路径判红（假红，不是登记表的问题）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKFLOW_CATALOG, getWorkflow, listWorkflowIds, resolveRunMode, validateCatalogEntries } from './workflow-catalog.mjs';
// 注意：**测试**可以 import 业务模块（被钉的正是执行器现状）；
// 被 import 的限制只作用于 workflow-catalog.mjs 本身。
import { BATCH_FILES, buildBatchSteps } from './batch-plan.mjs';

// 仓库根：本测试文件在 runtime/ 下，根是它的上一级。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const existsFromRoot = (file) => fs.existsSync(path.join(REPO_ROOT, file));

const EXPECTED_SALES1_DAILY_IDS = ['daily-report', 'promotion-daily', 'product-daily'];
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

test('四条主流程均已登记且 id 唯一', () => {
  const ids = listWorkflowIds();
  assert.deepEqual(
    [...ids].sort(),
    ['daily-report', 'product-daily', 'promotion-daily', 'weekly-report'],
    '登记表必须且只能是四条主流程',
  );
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
});

test('version 符合 semver 形式', () => {
  for (const id of listWorkflowIds()) {
    assert.match(
      WORKFLOW_CATALOG[id].version,
      SEMVER_RE,
      `[${id}] version 不符合 semver 形式`,
    );
  }
});

test('所有 entry 文件真实存在（按仓库根相对路径）', () => {
  for (const id of listWorkflowIds()) {
    const { entry } = WORKFLOW_CATALOG[id];
    for (const kind of ['batch', 'single']) {
      assert.ok(
        existsFromRoot(entry[kind]),
        `[${id}] entry.${kind} 指向的文件不存在：${entry[kind]}`,
      );
    }
  }
});

test('defaultBatchSize 为正整数；销售一部三条日报流程为 5', () => {
  for (const id of listWorkflowIds()) {
    const size = WORKFLOW_CATALOG[id].defaultBatchSize;
    assert.ok(Number.isInteger(size) && size >= 1, `[${id}] defaultBatchSize 必须是 ≥1 的整数，收到 ${size}`);
  }
  for (const id of EXPECTED_SALES1_DAILY_IDS) {
    assert.equal(WORKFLOW_CATALOG[id].defaultBatchSize, 5, `[${id}] 销售一部默认批次必须是 5`);
  }
});

test('mode.manualDefault 只能是 dry-run / apply', () => {
  for (const id of listWorkflowIds()) {
    assert.ok(
      ['dry-run', 'apply'].includes(WORKFLOW_CATALOG[id].mode.manualDefault),
      `[${id}] mode.manualDefault 非法：${WORKFLOW_CATALOG[id].mode.manualDefault}`,
    );
  }
});

test('生产写入只能显式 apply：commitPolicy 全部 explicit-apply 且 schedulerAllowed 均为 [\'apply\']', () => {
  for (const id of listWorkflowIds()) {
    const item = WORKFLOW_CATALOG[id];
    assert.equal(item.commitPolicy, 'explicit-apply', `[${id}] commitPolicy 必须是 explicit-apply`);
    assert.deepEqual(
      item.mode.schedulerAllowed,
      ['apply'],
      `[${id}] schedulerAllowed 必须恰为 ['apply']`,
    );
  }
});

test('catalog 源码不 import skills/（也不 import runtime/ 其它业务模块）', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'runtime', 'workflow-catalog.mjs'),
    'utf8',
  );
  // 任何形式的跨目录 import 都算：'../skills'、'../../skills'、'./browser-ports' 之类。
  // 本模块应当零 import（node: 内置也不需要）；这里按 spec §4.3 的原话钉「不得 import 业务入口模块」。
  const importMatches = [...source.matchAll(/import[\s\S]*?from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]);
  for (const specifier of importMatches) {
    // 允许：node 内置；或既非相对路径、也不指向 skills/ 与 runtime/ 业务模块。
    const allowed = specifier.startsWith('node:')
      || (!specifier.startsWith('.') && !/(^|\/)(skills|runtime)\//u.test(specifier));
    assert.ok(allowed, `workflow-catalog.mjs 出现了禁止的 import：${specifier}`);
  }
});

test('getWorkflow：未登记的 id 立即抛错，绝不回退到 daily-report', () => {
  assert.throws(
    () => getWorkflow('nonexistent-xyz'),
    (error) => {
      assert.ok(error instanceof Error);
      const message = String(error.message);
      // 报错里可以列「已登记哪些」，但不得出现「已回退/将使用 daily-report」之类的兜底语义。
      assert.ok(!/回退.*日报|fallback.*daily-report|使用.*daily-report.*入口/u.test(message), `错误信息不得带 daily-report 兜底语义：${message}`);
      assert.match(message, /nonexistent-xyz/u, '错误信息必须点名未登记的 id');
      return true;
    },
  );
  // 对照：合法 id 正常返回且就是登记项本身。
  assert.equal(getWorkflow('daily-report'), WORKFLOW_CATALOG['daily-report']);
});

test('catalog 与执行器不说两套话：entry.batch 与 batch-plan 现用链文件逐字一致', () => {
  // 从 buildBatchSteps 的实际输出推导（而不是抄 BATCH_FILES 的字面）——
  // 目的是钉住「run-batches 真正 spawn 的那个文件」与登记表一致。
  const probeShop = ['探针店'];
  const chainFileOf = (workflow) => buildBatchSteps(
    { index: 1, shops: probeShop },
    { workflow },
  ).find((step) => step.name === 'chain').file;

  assert.equal(
    WORKFLOW_CATALOG['daily-report'].entry.batch,
    chainFileOf('daily-report'),
    'daily-report 的 entry.batch 必须与 buildBatchSteps 现用链文件逐字一致',
  );
  assert.equal(
    WORKFLOW_CATALOG['daily-report'].entry.batch,
    BATCH_FILES.chain,
    'daily-report 的 entry.batch 必须与 BATCH_FILES.chain 逐字一致',
  );
  assert.equal(
    WORKFLOW_CATALOG['promotion-daily'].entry.batch,
    chainFileOf('promotion-daily'),
    'promotion-daily 的 entry.batch 必须与 buildBatchSteps(promotion-daily) 现用链文件逐字一致',
  );
});

test('validateCatalogEntries：注入 fs.existsSync 后零错误（启动自检同款口径）', () => {
  const errors = validateCatalogEntries(existsFromRoot);
  assert.deepEqual(errors, [], `登记表自检发现错误：\n${errors.join('\n')}`);
});

// ---------------------------------------------------------------------------
// resolveRunMode（spec §5.1 统一入口的模式解析，2026-10-10 加）。
//
// 四条规则各钉一条：显式 mode 赢 / --commit 兼容转换（要带回执让调用方打提示行）/
// dry-run + --commit 矛盾当场抛错（调用方退 2）/ 都没给落 manualDefault。
// ---------------------------------------------------------------------------
test('resolveRunMode：显式 --mode 赢（apply 与 dry-run 都不被 --commit 干扰）', () => {
  const entry = WORKFLOW_CATALOG['daily-report'];
  assert.deepEqual(resolveRunMode({ modeArg: 'apply', commitFlag: false, entry }), { mode: 'apply', convertedFromCommit: false });
  // --mode apply 与 --commit 语义一致 ⇒ 不矛盾，mode 赢、不算转换。
  assert.deepEqual(resolveRunMode({ modeArg: 'apply', commitFlag: true, entry }), { mode: 'apply', convertedFromCommit: false });
  assert.deepEqual(resolveRunMode({ modeArg: 'dry-run', commitFlag: false, entry }), { mode: 'dry-run', convertedFromCommit: false });
});

test('resolveRunMode：--commit ⇒ apply 且 convertedFromCommit=true（调用方必须据此打转换提示）', () => {
  const entry = WORKFLOW_CATALOG['promotion-daily'];
  const r = resolveRunMode({ modeArg: null, commitFlag: true, entry });
  assert.equal(r.mode, 'apply');
  assert.equal(r.convertedFromCommit, true, '漏了这个标记 ⇒ 兼容期转换提示一次都不会打出来');
});

test('resolveRunMode：--mode dry-run + --commit 矛盾 ⇒ 抛错（调用方退 2，不许静默选边）', () => {
  const entry = WORKFLOW_CATALOG['daily-report'];
  assert.throws(() => resolveRunMode({ modeArg: 'dry-run', commitFlag: true, entry }), /矛盾/u,
    '静默选边会让「以为在排练、实际写了飞书」这种假结论成立');
  // 非法 mode 值也要当场抛，不能静默当 dry-run。
  assert.throws(() => resolveRunMode({ modeArg: 'commit', commitFlag: false, entry }), /dry-run\|apply/u);
});

test('resolveRunMode：都没给 ⇒ entry.mode.manualDefault（本轮四条均为 dry-run）', () => {
  for (const id of listWorkflowIds()) {
    const r = resolveRunMode({ modeArg: null, commitFlag: false, entry: WORKFLOW_CATALOG[id] });
    assert.deepEqual(r, { mode: 'dry-run', convertedFromCommit: false }, `[${id}] 缺省模式必须是登记项的 manualDefault`);
  }
});

test('WORKFLOW_CATALOG 是只读结构（递归 freeze，写入静默失败）', () => {
  assert.ok(Object.isFrozen(WORKFLOW_CATALOG));
  for (const id of listWorkflowIds()) {
    const item = WORKFLOW_CATALOG[id];
    assert.ok(Object.isFrozen(item), `[${id}] 登记项必须 freeze`);
    assert.ok(Object.isFrozen(item.entry), `[${id}] entry 必须 freeze`);
    assert.ok(Object.isFrozen(item.mode), `[${id}] mode 必须 freeze`);
    // freeze 的表现：改不动（strict 模式下抛 TypeError）。
    assert.throws(() => { item.version = '9.9.9'; }, TypeError);
    assert.equal(item.version, '1.0.0');
  }
});
