// `escalation-plan.mjs` 的离线判据（2026-09-29 加）。
//
// 这份派单是「脚本层 → 会话层」的唯一接口：它判错的代价是**两种都很难看** ——
//   · 该派 agent 却没派 ⇒ 用户要的「脚本解决不了就转 agent」永远不触发（能力像没建）；
//   · 不该派 agent 却派了 ⇒ 每次一个「只有登录能解」的失败也去叫 agent 白忙一轮。
// 所以每一条都要能离线断言，且默认（没有失败/没有修复记录）行为必须与从前一致。
import test from 'node:test';
import { isWaitingOperatorAccountStatus, WAITING_OPERATOR_ACCOUNT } from './daily-report-shop-gates.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AGENT_PREFERRED_CAUSES, buildEscalationPlan, mergeSummaries, parseArgs, resolveSummarySources,
} from './escalation-plan.mjs';

const shopRecord = (over = {}) => ({ status: 'failed', ...over });

/** 在系统临时目录造一棵小树（`files` 的键是相对路径）⇒ 用来测「找文件」这件事本身。 */
function mkTmpTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'escalation-plan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}
function rmTmpTree(root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ } }

test('没有任何失败 ⇒ 不派 agent（默认行为：不需要救的时候一个字不多）', () => {
  const plan = buildEscalationPlan({ summary: { date: '2026-09-28', shops: { A: { status: 'ok' } } } });
  assert.equal(plan.needsAgent, false);
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.failedCount, 0);
  assert.match(plan.handoff, /不需要/u);
});

test('空 summary / 不给 summary ⇒ 不派，也不抛（读不到就不猜）', () => {
  for (const input of [{}, { summary: {} }, { summary: null }]) {
    const plan = buildEscalationPlan(input);
    assert.equal(plan.needsAgent, false);
    assert.deepEqual(plan.targets, []);
  }
});

test('脚本自修没救回来（autoRepair.gaveUp 非空）⇒ 派 agent', () => {
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { 科塔淘宝: shopRecord({
      failedStage: 'promotion-fetch',
      autoRepair: { gaveUp: '候选动作已全部试过' },
      repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'RELOAD_PAGE' }], path: 'evidence/x/97.json' },
    }) } },
  });
  assert.equal(plan.needsAgent, true);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].shop, '科塔淘宝');
  assert.ok(plan.targets[0].reasons.some((r) => /没救回来/u.test(r)));
  assert.deepEqual(plan.targets[0].candidates, ['RELOAD_PAGE']);
});

test('「有非空候选、但这一轮没试过」⇒ 也派 agent（现场还没被救过）', () => {
  // 09-28 真证据就是这一档：--auto-repair 未开，三家 STAGE_FAILED 都有候选却没人去试。
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { 里可林淘宝: shopRecord({
      failedStage: 'promotion-fetch',
      repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'REAPPLY_DATES' }, { action: 'RELOAD_PAGE' }] },
    }) } },
  });
  assert.equal(plan.needsAgent, true);
  assert.deepEqual(plan.targets[0].candidates, ['REAPPLY_DATES', 'RELOAD_PAGE']);
  assert.ok(plan.targets[0].reasons.some((r) => /没有自动修复记录/u.test(r)));
});

test('候选为空 + 成因在 agent 可办范围内（STAGE_FAILED）⇒ 派（让 agent 看怎么救）', () => {
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { 科塔淘宝: shopRecord({
      failedStage: 'sycm-date',
      repairRequest: { cause: 'STAGE_FAILED', candidates: [] },
    }) } },
  });
  assert.equal(plan.needsAgent, true);
  assert.ok(plan.targets[0].reasons.some((r) => /没有登记修法/u.test(r)));
});

test('**NEEDS_LOGIN 不派 agent**（那一类要的是登录，不是页面动作）', () => {
  // 这是安全方向的关键一条：登录类失败即使有成因记录，也不该让 agent 去点页面。
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { 网林天猫: shopRecord({
      failedStage: 'alimama-date',
      repairRequest: { cause: 'NEEDS_LOGIN', candidates: [{ action: 'RELOAD_PAGE' }] },
    }) } },
  });
  assert.equal(plan.needsAgent, false, 'NEEDS_LOGIN 有候选也不派 agent');
  assert.deepEqual(plan.targets, []);
});

test('SHOP_FUNC_NO_PERMISSION / DUPLICATE_TARGET 不派 agent（不是页面的问题）', () => {
  for (const cause of ['SHOP_FUNC_NO_PERMISSION', 'DUPLICATE_TARGET']) {
    const plan = buildEscalationPlan({
      summary: { date: '2026-09-28', shops: { A: shopRecord({
        failedStage: 'push', repairRequest: { cause, candidates: [] },
      }) } },
    });
    assert.equal(plan.needsAgent, false, `${cause} 不该派 agent`);
  }
});

test('AGENT_PREFERRED_CAUSES 的每一项都是「repair-shop-stage 的四个动作能对症」的成因', () => {
  // 钉住这个集合的语义：它是「agent 能干」的范围，不是「所有失败」。
  assert.deepEqual([...AGENT_PREFERRED_CAUSES], ['STAGE_FAILED', 'PAGE_OBSTRUCTED', 'SHOP_BLOCKED']);
});

test('派单带上现场路径与 execHint（会话侧照着就能干，不用再去别处找）', () => {
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { 科塔淘宝: shopRecord({
      failedStage: 'promotion-fetch',
      repairRequest: {
        cause: 'STAGE_FAILED', candidates: [{ action: 'RELOAD_PAGE' }],
        path: 'evidence/batches-2026-09-28/b1/科塔淘宝/97-repair-request.json',
        statePath: 'evidence/batches-2026-09-28/b1/科塔淘宝/98-failure-state.json',
        screenshotPath: 'evidence/batches-2026-09-28/b1/科塔淘宝/98-failure-page.png',
        execHint: 'node .../repair-shop-stage.mjs --shop 科塔淘宝 --proxy http://127.0.0.1:19044 ...',
      },
    }) } },
  });
  const t = plan.targets[0];
  assert.equal(t.repairRequestPath, 'evidence/batches-2026-09-28/b1/科塔淘宝/97-repair-request.json');
  assert.equal(t.statePath, 'evidence/batches-2026-09-28/b1/科塔淘宝/98-failure-state.json');
  assert.equal(t.screenshotPath, 'evidence/batches-2026-09-28/b1/科塔淘宝/98-failure-page.png');
  assert.match(t.execHint, /repair-shop-stage\.mjs/u);
  // 证据目录从 statePath 推出来（不是猜的）。
  assert.match(t.logDir, /科塔淘宝$/u);
});

test('派单是 JSON 可序列化的（会话侧要能直接解析）', () => {
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: { A: shopRecord({
      failedStage: 'push', repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'RELOAD_PAGE' }] },
    }) } },
  });
  const round = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(round, plan);
});

test('多家失败时每家的理由独立（不许把一家的情况复制到另一家）', () => {
  const plan = buildEscalationPlan({
    summary: { date: '2026-09-28', shops: {
      甲店: shopRecord({ failedStage: 'promotion-fetch', autoRepair: { gaveUp: '候选动作已全部试过' },
        repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'RELOAD_PAGE' }] } }),
      乙店: shopRecord({ failedStage: 'promotion-fetch',
        repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'REAPPLY_DATES' }] } }),
    } },
  });
  assert.equal(plan.targets.length, 2);
  const 甲 = plan.targets.find((t) => t.shop === '甲店');
  const 乙 = plan.targets.find((t) => t.shop === '乙店');
  assert.ok(甲.reasons.some((r) => /没救回来/u.test(r)));
  assert.equal(乙.reasons.some((r) => /没救回来/u.test(r)), false, '乙店没有被 autoRepair 试过，不该带这句');
  assert.ok(乙.reasons.some((r) => /没有自动修复记录/u.test(r)));
});

// ── 生产形态：`--batches 5` ⇒ 结论落在 `batches-<日>/b<n>/summary.json`，不在 multi-shop ──
// 这一段是**能力能不能在真跑里触发**的关键：只认 `multi-shop-<日>/summary.json` 的写法，
// 在生产里每次都会判「读不到结论」⇒ 派单永远为空 ⇒ 「转 agent」等于没建。

test('分批形态：resolveSummarySources 找得到 batches-<日>/b*/summary.json（按批号排）', () => {
  const root = mkTmpTree({
    'evidence/batches-2026-09-28/b1/summary.json': JSON.stringify({ date: '2026-09-28', shops: { 甲店: { status: 'failed' } } }),
    'evidence/batches-2026-09-28/b2/summary.json': JSON.stringify({ date: '2026-09-28', shops: { 乙店: { status: 'failed' } } }),
    'evidence/batches-2026-09-28/batches.log': 'not a summary',
  });
  try {
    const found = resolveSummarySources('2026-09-28', { root });
    assert.equal(found.error, undefined);
    assert.equal(found.files.length, 2);
    assert.match(found.files[0], /b1[\\/]summary\.json$/u);
    assert.match(found.files[1], /b2[\\/]summary\.json$/u);
  } finally { rmTmpTree(root); }
});

test('分批形态：一份都找不到 ⇒ 给 error（不猜、不抛）', () => {
  const root = mkTmpTree({ 'evidence/batches-2026-09-28/b1/README.md': 'x' });
  try {
    const found = resolveSummarySources('2026-09-28', { root });
    assert.ok(found.error, '应当报找不到，而不是返回空数组让人误以为「没有失败」');
    assert.match(found.error, /2026-09-28/u);
  } finally { rmTmpTree(root); }
});

test('不分批形态：multi-shop-<日>/summary.json 仍认得（旧路径不回归）', () => {
  const root = mkTmpTree({
    'evidence/multi-shop-2026-09-20/summary.json': JSON.stringify({ date: '2026-09-20', shops: { 甲店: { status: 'failed' } } }),
  });
  try {
    const found = resolveSummarySources('2026-09-20', { root });
    assert.equal(found.error, undefined);
    assert.equal(found.files.length, 1);
    assert.match(found.files[0], /multi-shop-2026-09-20[\\/]summary\.json$/u);
  } finally { rmTmpTree(root); }
});

test('mergeSummaries：两批的 shops 取并集，同店后者覆盖前者', () => {
  const merged = mergeSummaries([
    { date: '2026-09-28', shops: { 甲店: { status: 'ok' }, 乙店: { status: 'failed', failedStage: 'sycm-date' } } },
    { date: '2026-09-28', shops: { 乙店: { status: 'ok' }, 丙店: { status: 'failed' } } },
  ]);
  assert.equal(merged.date, '2026-09-28');
  assert.deepEqual(Object.keys(merged.shops).sort(), ['丙店', '乙店', '甲店'].sort());
  assert.equal(merged.shops.乙店.status, 'ok', '同一家店出现在两批 ⇒ 后一批的状态为准');
});

test('合并后的 summary 直接喂 buildEscalationPlan：跨批的失败一起算', () => {
  const merged = mergeSummaries([
    { date: '2026-09-28', shops: { 甲店: shopRecord({ failedStage: 'promotion-fetch',
      repairRequest: { cause: 'STAGE_FAILED', candidates: [{ action: 'RELOAD_PAGE' }] } }) } },
    { date: '2026-09-28', shops: { 乙店: { status: 'ok' } } },
  ]);
  const plan = buildEscalationPlan({ summary: merged });
  assert.equal(plan.needsAgent, true);
  assert.deepEqual(plan.targets.map((t) => t.shop), ['甲店']);
});

test('账号等待店铺不进入修复 agent 派单', () => {
  // ⚠️ 2026-10-05 起 `WAITING_OPERATOR_ACCOUNT_SHOPS` 已被用户清空 ⇒
  // `waitingOperatorAccountRecord('里可林淘宝')` 现在返回 null，用它当样本造不出等待记录。
  // 所以这里直接照 `waitingOperatorAccountRecord` 的**契约**手写那条记录 ——
  // 它守的是派单侧的过滤判据（`escalation-plan.mjs:193` 那句 `!isWaitingOperatorAccountStatus(record)`），
  // 不该依赖「名单里恰好有谁」。
  const waiting = {
    shop: '某等待中的店',
    status: 'waiting',
    state: WAITING_OPERATOR_ACCOUNT,
    resumable: true,
    failedStage: 'shop-report',
    reason: '生意参谋日报需要运营账号处理，开发侧暂缓该店日报流程。',
    owner: '运营',
    stages: [],
    source: {},
  };
  // 前置自证：这份样本必须真的被闸门认成等待，否则这条用例会变成永真的空检查。
  assert.equal(isWaitingOperatorAccountStatus(waiting), true,
    '手写的等待记录没被闸门认出来 —— 样本构造错了，这条用例的结论不可信');
  const plan = buildEscalationPlan({ summary: {
    date: '2026-10-05',
    shops: { 某等待中的店: waiting },
  }});
  assert.equal(plan.failedCount, 0);
  assert.equal(plan.needsAgent, false);
  assert.deepEqual(plan.targets, []);
});

// ---------------------------------------------------------------------------
// `--date` 的字面量（2026-10-06）
//
// 此前这里只收 `YYYY-MM-DD`，而定时任务 prompt 里写的是 `--date yesterday`
// ⇒ 那条命令每次都落进「`--date` 要 YYYY-MM-DD」⇒ 读不到结论 ⇒ **第 ② 层降级
//（唤醒修复 agent）静默空转**。同一处已复现 4 次，所以把它当判据钉住。
// ---------------------------------------------------------------------------
const NOW = new Date('2026-10-06T03:00:00Z'); // 上海 11:00 ⇒ 昨日＝2026-10-05

test('parseArgs：定时任务那句 `--date yesterday` 必须被接受（第 ② 层降级的入口）', () => {
  const args = parseArgs(['--date', 'yesterday', '--json'], NOW);
  assert.equal(args.error, undefined, `被拒了 ⇒ 派单永远读不到结论：${args.error}`);
  assert.equal(args.date, '2026-10-05');
  assert.equal(args.dateInput, 'yesterday', '原始取值要留着：日志里要能看出它被解析成了哪天');
  assert.equal(args.json, true);
});

test('parseArgs：显式日期原样通过；非法取值给 error（不抛、也不静默落成今天）', () => {
  assert.equal(parseArgs(['--date', '2026-09-28'], NOW).date, '2026-09-28');
  for (const bad of ['today', 'yestoday', '2026-9-1', '前天']) {
    const args = parseArgs(['--date', bad], NOW);
    assert.ok(args.error, `${bad} 不该被接受 —— 静默落成别的日子比报错贵得多`);
    assert.match(args.error, /YYYY-MM-DD/u, '报错要写清允许的写法');
    assert.match(args.error, /yesterday/u, '报错要顺手告诉人定时任务用的是哪个字面量');
  }
});

test('parseArgs：缺日期且缺 --summary ⇒ error；`--summary` 那一档不凭空造日期', () => {
  assert.match(parseArgs([], NOW).error, /--date 或 --summary/u);
  const bySummary = parseArgs(['--summary', 'x.json'], NOW);
  assert.equal(bySummary.error, undefined);
  assert.equal(bySummary.date, null, '给 --summary 时不该自己编一个日期（结论文件里自带日期）');
});

test('接线（源码级）：日期口径**复用**链那一份，且不是 import 驱动（成环是禁止项）', () => {
  const source = readFileSync(new URL('./escalation-plan.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/skills\/sycm-alimama-daily-report\/scripts\/date-picker\.mjs'/u,
    '没复用叶子里的 resolveTargetDate ⇒ 「昨天是哪天」出现第二份实现，两份迟早漂开');
  assert.match(source, /args\.date = resolveTargetDate\(args\.dateInput, now\);/u,
    'import 了却没接在解析路径上 ＝ 一条永远绿的判据');
  // ⚠️ 判据只这一条：**不许出现「从驱动 import」的语句**。驱动（run-multi-shop-day.mjs）
  // import 了本模块，反向再 import 就成环；而成环之后两边都加不进新东西。
  // 注释里提到它的名字是应该的（要写清为什么不能那么做），所以只扫 import 语句。
  assert.equal(/^import[^\n]*run-multi-shop-day/mu.test(source), false,
    '本模块出现了从驱动 import 的语句 ⇒ 成环');
});
