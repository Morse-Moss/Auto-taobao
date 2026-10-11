// 统一 summary schema 守卫测试（三链对齐 P1 迁移第 1 步，2026-10-11 建）。
//
// 与 runtime/version-consistency.test.mjs 同层、同跑法：仓库根 `node --test runtime/unified-summary-schema.test.mjs`。
// 被测物：runtime/unified-summary-schema.mjs（纯函数校验器，口径见
// docs/ops/UNIFIED-SUMMARY-SCHEMA-DRAFT-2026-10-11.md 第三节，七项拍板全按推荐）。
//
// 三类样本（草案 5.1）：
//   a. 真实历史样本：从 evidence/ 摘录、**固化成本文件内的字面量**（测试运行时禁止读 evidence/——
//      evidence 是会被人翻动的运行产物，守卫的输入必须钉死）。
//      · 日报链：2026-10-11 白天这轮的 b2（startedAt=2026-10-11T03:40:11Z、finishedAt=03:49:57Z，
//        业务日 2026-10-10；同目录 b1 的 summary.json 经查同样是今天这轮——startedAt=03:54:55Z——
//        其中盖文淘宝是「自修救回」形态（status:'ok' + 保留 repairRequest/autoRepair），已按
//        2026-10-11 拍板的 rescued 豁免单独成夹具（见下方「rescued 救回店」用例）。
//        b2 全是 ok 店，为把「失败店 / waiting 店」的现状形状也钉进迁移仪表，补两条真实形状记录：
//        失败店＝evidence/multi-shop-2026-10-09/summary.json 的盖文淘宝（最近一份带失败店的日报
//        summary，startedAt=2026-10-10T08:51:28Z）；waiting 店＝runtime/daily-report-shop-gates.mjs
//        的 waitingOperatorAccountRecord 形状（2026-10-05 该名单已清空，evidence 里已无真实
//        waiting 样本，形状按源码逐字构造，店名取历史上在册的里可林淘宝）。
//        **第 2 步（2026-10-11）起，本日报夹具已换成「并写后形状」**：顶层补 version/workflow、
//        逐店补 shop/evidence、失败店补 failureClass/noActionRequired——手工按
//        run-multi-shop-day.mjs 的 applyUnifiedSummaryFields 并写逻辑改的**离线等价形状**，
//        不是真产物；真产物验证在 2026-10-12 11:30 定时轮，产物落盘后与本校验器核对。
//      · 推广链：2026-10-10 23:02 那轮（07:00 事故轮的补跑，8 家全败）逐店记录，摘自
//        evidence/promotion-batches-2026-10-10/batches.log——那一轮跑在 P0-3 合入**之前**，
//        只往 stdout 打 JSON、没落 summary.json；本夹具＝该轮真实记录 + P0-3
//        buildPromotionSummary 的包装形状（失败店补 repairRequest:{candidates:[]}）。
//        evidence/ 下目前尚无 P0-3 之后的真实 summary.json 产物；第 3 步并写后用真产物替换。
//   b. 三链最小合法夹具：每链一份手写最小 summary，validateSummary 必须全绿——
//      「三条链都能通过同一份 schema」的直接证据。
//   c. 反例夹具：违反 3.4 七条不变量的样本逐条点名红（不变量 7 是豁免性条款，无可红的
//      「违反」形态——waiting 记录缺 error/failureClass/repairRequest 是**合法**的——
//      用绿样本把豁免钉住，突变验证短路豁免时该用例变红）。
//
// 「迁移仪表」：样本 a 的欠字段断言就是仪表盘。**日报链已于第 2 步（2026-10-11）清零**
// （夹具换成并写后形状，断言改全绿）；推广链仍是第 3 步的仪表——14 条欠字段断言原样保留，
// 第 3 步并写落地后把新产物形状并进夹具、清单清零才算完成。
// 断言用 {path, rule} 投影做精确等式：多一条=误伤现状合法形态，少一条=守卫没咬住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSummary, UNIFIED_SUMMARY_VERSION, WORKFLOWS, STATUS,
} from './unified-summary-schema.mjs';

const projection = (errors) => errors.map(({ path, rule }) => ({ path, rule }));

// ─────────────────────────────────────────────────────────────────────────────
// 样本 a-1：日报链真实样本（字面量固化；来源见文件头）。
// 第 2 步（2026-10-11）起为「并写后形状」：在 2026-10-11 这轮的真实记录之上，按
// applyUnifiedSummaryFields 的并写逻辑补统一字段（version/workflow/shop/evidence/
// failureClass/noActionRequired）——离线等价形状，真产物验证在 2026-10-12 11:30 轮。
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_REPORT_REAL_SAMPLE = {
  version: 'unified-summary-v1',
  workflow: 'daily-report',
  date: '2026-10-10',
  mode: 'commit',
  startedAt: '2026-10-11T03:40:11.993Z',
  round: {
    healthCheckDaily: {
      status: 0,
      logPath: 'evidence\\batches-2026-10-10\\b2\\00-health-check-daily.txt',
      ok: true,
      blocking: [],
      blockingDetails: [],
      normalize: '本来就在位（生意参谋工作页=1  飞书底单页=1）',
      normalizeChanged: false,
      roundCause: null,
      missingPages: [],
    },
  },
  shops: {
    // ok 店：evidence/batches-2026-10-10/b2/summary.json 网林淘宝原样（stages 裁剪到 2 条，
    // stage 对象字段形状保真）＋ 并写补的 shop/evidence。
    网林淘宝: {
      shop: '网林淘宝',
      status: 'ok',
      evidence: 'evidence\\batches-2026-10-10\\b2\\网林淘宝',
      stages: [
        {
          stage: 'health-check', status: 0, skipped: false,
          logPath: 'evidence\\batches-2026-10-10\\b2\\网林淘宝\\01-health-check.txt',
          argv: [], blockingDetails: [], blockingCodes: [],
          pageNormalize: '本来就在位（生意参谋工作页=1  阿里妈妈报表页=1）',
        },
        {
          stage: 'push', status: 0, skipped: false,
          logPath: 'evidence\\batches-2026-10-10\\b2\\网林淘宝\\07-push.txt',
          argv: ['--date', '2026-10-10', '--proxy', 'http://127.0.0.1:19023', '--shop-key', '网林淘宝',
            '--commit', '--shop-xlsx', 'C:\\Users\\Administrator\\Downloads\\日报_20261011_1442937a949c530fdf7741076d82c6d7.xlsx',
            '--promotion-zip', 'C:\\Users\\Administrator\\Downloads\\营销场景报表_20261011_114029.zip'],
          blockingDetails: null, blockingCodes: null, pageNormalize: null,
        },
      ],
      source: {
        shopXlsx: 'C:\\Users\\Administrator\\Downloads\\日报_20261011_1442937a949c530fdf7741076d82c6d7.xlsx',
        shopReportManifest: 'D:\\Retire\\sycm-automation\\evidence\\batches-2026-10-10\\b2\\网林淘宝\\shop-report-manifest.json',
        promotionZip: 'C:\\Users\\Administrator\\Downloads\\营销场景报表_20261011_114029.zip',
        promotionManifest: 'D:\\Retire\\sycm-automation\\evidence\\batches-2026-10-10\\b2\\网林淘宝\\promotion-report-manifest.json',
      },
    },
    // ok 店：b2 里可林天猫原样（同上裁剪）＋ 并写补的 shop/evidence。
    里可林天猫: {
      shop: '里可林天猫',
      status: 'ok',
      evidence: 'evidence\\batches-2026-10-10\\b2\\里可林天猫',
      stages: [
        {
          stage: 'health-check', status: 0, skipped: false,
          logPath: 'evidence\\batches-2026-10-10\\b2\\里可林天猫\\01-health-check.txt',
          argv: [], blockingDetails: [], blockingCodes: [],
          pageNormalize: '本来就在位（生意参谋工作页=1  阿里妈妈报表页=1）',
        },
        {
          stage: 'push', status: 0, skipped: false,
          logPath: 'evidence\\batches-2026-10-10\\b2\\里可林天猫\\07-push.txt',
          argv: ['--date', '2026-10-10', '--proxy', 'http://127.0.0.1:19023', '--shop-key', '里可林天猫',
            '--commit', '--shop-xlsx', 'C:\\Users\\Administrator\\Downloads\\日报_20261011_ea518aea3e2d36f77a19921be585653d.xlsx',
            '--promotion-zip', 'C:\\Users\\Administrator\\Downloads\\营销场景报表_20261011_114406.zip'],
          blockingDetails: null, blockingCodes: null, pageNormalize: null,
        },
      ],
      source: {
        shopXlsx: 'C:\\Users\\Administrator\\Downloads\\日报_20261011_ea518aea3e2d36f77a19921be585653d.xlsx',
        shopReportManifest: 'D:\\Retire\\sycm-automation\\evidence\\batches-2026-10-10\\b2\\里可林天猫\\shop-report-manifest.json',
        promotionZip: 'C:\\Users\\Administrator\\Downloads\\营销场景报表_20261011_114406.zip',
        promotionManifest: 'D:\\Retire\\sycm-automation\\evidence\\batches-2026-10-10\\b2\\里可林天猫\\promotion-report-manifest.json',
      },
    },
    // waiting 店：waitingOperatorAccountRecord 形状（runtime/daily-report-shop-gates.mjs:33-47 逐字）
    // ＋ 并写在汇总处补的 evidence（shop 它本来就带——日报链只有 waiting 记录带）。
    里可林淘宝: {
      status: 'waiting',
      state: 'WAITING_OPERATOR_ACCOUNT',
      resumable: true,
      failedStage: 'shop-report',
      reason: '生意参谋日报需要运营账号处理，开发侧暂缓该店日报流程。',
      owner: '运营',
      resumeWhen: '运营更换并确认可用账号后，从日报店铺状态登记移除该店铺。',
      stages: [],
      source: {},
      shop: '里可林淘宝',
      evidence: 'evidence\\batches-2026-10-10\\b2\\里可林淘宝',
    },
    // 失败店：evidence/multi-shop-2026-10-09/summary.json 盖文淘宝原样
    // （perception 裁掉巨型 DOM 转储 state 字段，其余字段形状保真；repairRequest 逐字照录）
    // ＋ 并写补的 shop/evidence/failureClass/noActionRequired。failureClass='STAGE_FAILED'
    // ＝ shopFailureCause 对这份记录现算的结果（其 failureOutput 里没有 OVERLAY/BLOCKED
    // 标记，2026-10-10 之前 date-picker 还不写 BLOCKED_BY_OVERLAY_TOKEN）。
    盖文淘宝: {
      shop: '盖文淘宝',
      status: 'failed',
      evidence: 'evidence\\multi-shop-2026-10-09\\盖文淘宝',
      failureClass: 'STAGE_FAILED',
      noActionRequired: false,
      stages: [
        {
          stage: 'health-check', status: 0, skipped: false,
          logPath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\01-health-check.txt',
          argv: [], blockingDetails: [], blockingCodes: [],
          pageNormalize: '本来就在位（生意参谋工作页=1  阿里妈妈报表页=1）',
        },
        {
          stage: 'sycm-date', status: 1, skipped: false,
          logPath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\04-sycm-date.txt',
          argv: ['--site', 'sycm', '--date', '2026-10-09', '--proxy', 'http://127.0.0.1:19043'],
          blockingDetails: null, blockingCodes: null, pageNormalize: null,
        },
      ],
      source: {},
      failedStage: 'sycm-date',
      failureOutput: '\nError: sycm tab 询单到付款: 定位重试 16 次仍失败（每次间隔 1200ms）；'
        + 'lastError=proxy http://127.0.0.1:19043/eval?target=63554880F8B0FE0D1E5E8BB61B7B536F '
        + 'failed: HTTP 400 Error: sycm tab 询单到付款: point (492,277) is covered by '
        + 'SPAN.goods-subIndex-text     at aim (<anonymous>:27:13) \n'
        + '    at locateWithRetry (file:///D:/Retire/sycm-automation/skills/sycm-alimama-daily-report/scripts/date-picker.mjs:489:9)\n'
        + '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)\n'
        + '    at async runApplyDate (file:///D:/Retire/sycm-automation/skills/sycm-alimama-daily-report/scripts/date-picker.mjs:786:17)\n'
        + '    at async applyDate (file:///D:/Retire/sycm-automation/skills/sycm-alimama-daily-report/scripts/date-picker.mjs:611:12)\n',
      blockingDetails: null,
      error: '阶段 sycm-date 失败（exit 1）',
      perception: {
        ok: true,
        files: {
          stateJson: 'D:\\Retire\\sycm-automation\\evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-state.json',
          stateText: 'D:\\Retire\\sycm-automation\\evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-state.txt',
          screenshot: 'D:\\Retire\\sycm-automation\\evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-page.png',
        },
        errors: [],
        shopKey: '盖文淘宝',
        stage: 'sycm-date',
      },
      repairRequest: {
        at: '2026-10-10T08:51:52.990Z',
        shopKey: '盖文淘宝',
        stage: 'sycm-date',
        cause: 'STAGE_FAILED',
        error: '阶段 sycm-date 失败（exit 1）',
        statePath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-state.json',
        stateTextPath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-state.txt',
        screenshotPath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\98-failure-page.png',
        stateSummary: {
          url: 'https://one.alimama.com/index.html#!/report/download-list',
          title: '下载任务管理_万相台无界版',
          viewport: { w: 1506, h: 642, dpr: 1.25, scrollY: 0 },
          overlayCount: 0,
        },
        candidates: [
          {
            action: 'REAPPLY_DATES',
            mutating: true,
            why: '页面上的日期筛选可能已经不在目标日（重载/人动过之后常见）；重新落位再试。',
          },
          {
            action: 'RELOAD_PAGE',
            mutating: true,
            why: '这一份渲染上元素不理会点击（本项目实测过的形态）；真重载换个新现场再试。',
          },
        ],
        planNote: null,
        stageHint: 'sycm',
        noActionRequired: false,
        retryStage: 'sycm-date',
        execHint: 'node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 盖文淘宝 '
          + '--proxy http://127.0.0.1:19043 --stage sycm-date --cause STAGE_FAILED '
          + '--action <候选动作> --log-dir evidence\\multi-shop-2026-10-09\\盖文淘宝',
        instancePrecondition: {
          why: '这一批跑完可能已经把这家店的浏览器放掉了（--batches 每批都释放，失败的那家也在名单里）。'
            + '代理连不上时任何页面修复动作都执行不到，而 --proxy 是唯一的实例选择器 —— 不先确认就可能对着别的一台做事。',
          checkCommand: 'curl -s -m 5 http://127.0.0.1:19043/targets',
          startCommand: 'node scripts/start-all-hold.mjs --only 盖文淘宝',
          note: '先跑 checkCommand：有输出（一个 JSON 数组）就是还在，直接执行 execHint；'
            + '连不上就先跑 startCommand 把它拉起来（后台托住），确认再执行 execHint。',
        },
        path: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\97-repair-request.json',
      },
      recovery: {
        at: '2026-10-10T08:51:52.992Z',
        proxyPort: 19043,
        leftAt: {
          tabs: 3,
          slots: [{ page: '生意参谋工作页', count: 1 }, { page: '阿里妈妈报表页', count: 1 }],
          foreign: ['file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E7%9B%96%E6%96%87%E6%B7%98%E5%AE%9D&port=19033'],
        },
        action: 'none',
        after: {
          tabs: 3,
          slots: [{ page: '生意参谋工作页', count: 1 }, { page: '阿里妈妈报表页', count: 1 }],
          foreign: ['file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E7%9B%96%E6%96%87%E6%B7%98%E5%AE%9D&port=19033'],
        },
        restored: true,
        detail: '回位后 生意参谋工作页 恰好一个',
        error: null,
        logPath: 'evidence\\multi-shop-2026-10-09\\盖文淘宝\\99-recovery.txt',
      },
    },
  },
  finishedAt: '2026-10-11T03:49:57.640Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// 样本 a-1b：日报链 rescued 救回店（evidence/batches-2026-10-10/b1/summary.json 盖文淘宝，
// 2026-10-11 04:04 这轮的真实记录裁剪固化：stages/source 裁空、repairRequest 保留真实形状
// （candidates 裁到 2 条原样）、autoRepair 两轮原样）。并写前它按 INV2 字面口径红；
// 2026-10-11 拍板 rescued 豁免后全绿。attempted:true 是第 2 步并写补的字段
// （applyUnifiedSummaryFields 对存在的 autoRepair 物化），这里按并写后形状固化。
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_REPORT_RESCUED_SAMPLE = {
  version: 'unified-summary-v1',
  workflow: 'daily-report',
  date: '2026-10-10',
  mode: 'commit',
  startedAt: '2026-10-11T03:54:55.000Z',
  round: null,
  shops: {
    盖文淘宝: {
      shop: '盖文淘宝',
      status: 'ok',
      evidence: 'evidence\\batches-2026-10-10\\b1\\盖文淘宝',
      failureOutput: '\nError: sycm tab 询单到付款: 定位重试 16 次仍失败（每次间隔 1200ms）；'
        + 'lastError=proxy http://127.0.0.1:19043/eval?target=5229137FE13273B15EB73EDDA4B19B27 '
        + 'failed: HTTP 400 Error: sycm tab 询单到付款: point (492,277) is covered by '
        + 'SPAN.goods-subIndex-text [BLOCKED_BY_OVERLAY 遮挡层=DIV.ant\n',
      blockingDetails: null,
      repairRequest: {
        at: '2026-10-11T04:04:03.315Z',
        shopKey: '盖文淘宝',
        stage: 'sycm-date',
        cause: 'PAGE_OBSTRUCTED',
        error: '阶段 sycm-date 失败（exit 1）',
        statePath: 'evidence\\batches-2026-10-10\\b1\\盖文淘宝\\98-failure-state.json',
        stateTextPath: 'evidence\\batches-2026-10-10\\b1\\盖文淘宝\\98-failure-state.txt',
        screenshotPath: 'evidence\\batches-2026-10-10\\b1\\盖文淘宝\\98-failure-page.png',
        stateSummary: {
          url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
          title: '生意参谋 - 零售电商大数据产品平台',
          viewport: { w: 1506, h: 642, dpr: 1.25, scrollY: 0 },
          overlayCount: 2,
        },
        candidates: [
          {
            action: 'DISMISS_OVERLAYS',
            mutating: true,
            why: '平台的全屏弹窗可能正盖住整页、让控件点不到；关掉它再重试。',
          },
          {
            action: 'RELOAD_PAGE',
            mutating: true,
            why: '这一份渲染上元素不理会点击（本项目实测过的形态）；真重载换个新现场再试。',
          },
        ],
        planNote: null,
        stageHint: 'sycm',
        noActionRequired: false,
        retryStage: 'sycm-date',
      },
      autoRepair: {
        enabled: true,
        cause: 'PAGE_OBSTRUCTED',
        stage: 'sycm-date',
        maxRounds: 2,
        rounds: [
          {
            round: 1,
            action: 'DISMISS_OVERLAYS',
            applied: false,
            retry: { attempted: false, why: '修复动作没落地，不重试阶段（避免原样再来一遍）' },
            detail: '试过 1 种关法都没关掉',
            error: null,
          },
          {
            round: 2,
            action: 'RELOAD_PAGE',
            applied: true,
            retry: { attempted: true, stage: 'sycm-date', status: 0 },
            detail: '页面已重载并就绪',
            error: null,
          },
        ],
        rescued: true,
        gaveUp: null,
        error: null,
        attempted: true,
      },
      rescuedFrom: 'sycm-date',
      rescuedBy: 'RELOAD_PAGE',
      rescueResume: {
        from: 'sycm-date',
        ran: ['shop-report', 'promotion-fetch', 'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback'],
      },
    },
  },
  finishedAt: '2026-10-11T04:09:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// 样本 a-2：推广链样本（2026-10-10 23:02 轮真实记录 + P0-3 包装形状；来源见文件头）
// ─────────────────────────────────────────────────────────────────────────────
const PROMOTION_REAL_SAMPLE = {
  version: 'promotion-sales1-summary-v1',
  date: '2026-10-10',
  shops: {
    // 失败店：真实记录原样（status 初值即 'failed'——fail-closed 默认；P0-3 给失败店补 repairRequest:{candidates:[]}）。
    里可林淘宝: {
      batch: 1,
      shop: '里可林淘宝',
      status: 'failed',
      stages: [],
      error: '采集失败：关键词报表提交任务无法唯一确认: {"before":["关键词报表_20261010_185450",'
        + '"关键词报表_20261010_180928","关键词报表_20261010_180156","关键词报表_20261009_225312",'
        + '"关键词报表_20261009_183418"],"after":["关键词报表_20261010_185450","关键词报表_20261010_180928",'
        + '"关键词报表_20261010_180156","关键词报表_20261009_225312","关键词报表_20261009_183418"],"added":[]}\n',
      repairRequest: { candidates: [] },
    },
    网林天猫: {
      batch: 1,
      shop: '网林天猫',
      status: 'failed',
      stages: [],
      error: '采集失败：关键词报表提交任务无法唯一确认: {"before":["关键词报表_20261010_181020",'
        + '"关键词报表_20261010_180245"],"after":["关键词报表_20261010_181020","关键词报表_20261010_180245"],"added":[]}\n',
      repairRequest: { candidates: [] },
    },
    盖文淘宝: {
      batch: 1,
      shop: '盖文淘宝',
      status: 'failed',
      stages: [],
      error: '采集失败：关键词报表提交任务无法唯一确认: {"before":["关键词报表_20261010_181112",'
        + '"关键词报表_20261010_180334"],"after":["关键词报表_20261010_181112","关键词报表_20261010_180334"],"added":[]}\n',
      repairRequest: { candidates: [] },
    },
    // 第二批的网林家居：跑完了 keyword-submit 才败在人群报表——stages 非空的真实形态。
    网林家居: {
      batch: 1,
      shop: '网林家居',
      status: 'failed',
      stages: ['keyword-submit'],
      error: '采集失败：人群报表提交任务无法唯一确认: {"before":["人群报表_20261010_195500"],'
        + '"after":["人群报表_20261010_195500"],"added":[]}\n',
      repairRequest: { candidates: [] },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 样本 b：三链最小合法夹具（手写；validateSummary 必须全绿）
// ─────────────────────────────────────────────────────────────────────────────

// 日报链：ok 店 / 失败店（空菜单 candidates）/ waiting 店 / pending 初值，四种形态齐。
const DAILY_REPORT_MINIMAL = {
  version: 'unified-summary-v1',
  workflow: 'daily-report',
  date: '2026-10-11',
  mode: 'commit',
  startedAt: '2026-10-11T03:40:00.000Z',
  finishedAt: '2026-10-11T03:50:00.000Z',
  round: null,
  shops: {
    网林天猫: {
      shop: '网林天猫',
      status: 'ok',
      evidence: 'evidence/multi-shop-2026-10-11/网林天猫',
      stages: [],
      source: {},
    },
    盖文淘宝: {
      shop: '盖文淘宝',
      status: 'failed',
      evidence: 'evidence/multi-shop-2026-10-11/盖文淘宝',
      error: '阶段 sycm-date 失败（exit 1）',
      failedStage: 'sycm-date',
      failureClass: 'PAGE_OBSTRUCTED',
      noActionRequired: false,
      repairRequest: { candidates: [] },
      autoRepair: null,
      stages: [],
      source: {},
    },
    里可林淘宝: {
      shop: '里可林淘宝',
      status: 'waiting',
      evidence: 'evidence/multi-shop-2026-10-11/里可林淘宝',
      state: 'WAITING_OPERATOR_ACCOUNT',
      resumable: true,
      failedStage: 'shop-report',
      reason: '生意参谋日报需要运营账号处理，开发侧暂缓该店日报流程。',
      owner: '运营',
      resumeWhen: '运营更换并确认可用账号后，从日报店铺状态登记移除该店铺。',
      stages: [],
      source: {},
    },
    // pending 初值原样（run-multi-shop-day.mjs:2047 的 {status:'pending', stages:[], source:{}}，
    // 无 shop/evidence/失败字段）——必须不红（中断轮落下的 mid-run summary 是真实产物）。
    网林淘宝: {
      status: 'pending',
      stages: [],
      source: {},
    },
  },
};

// 推广链：ok 店（走完全部五阶段）/ 失败店（空菜单）。stages 是字符串数组（链内扩展，schema 不约束内部形状）。
const PROMOTION_MINIMAL = {
  version: 'unified-summary-v1',
  workflow: 'promotion-daily',
  date: '2026-10-11',
  shops: {
    里可林淘宝: {
      batch: 1,
      shop: '里可林淘宝',
      status: 'ok',
      evidence: 'evidence/promotion-sales1-2026-10-11/里可林淘宝',
      stages: ['keyword-submit', 'audience-submit', 'keyword-fetch', 'audience-fetch', 'import'],
    },
    网林天猫: {
      batch: 1,
      shop: '网林天猫',
      status: 'failed',
      evidence: 'evidence/promotion-sales1-2026-10-11/网林天猫',
      error: '采集失败：关键词报表提交任务无法唯一确认',
      stages: [],
      failureClass: 'STAGE_FAILED',
      noActionRequired: false,
      repairRequest: { candidates: [] },
      autoRepair: null,
    },
  },
};

// 商品链：草案 2.3——商品链现状不落 summary（第 4 步才新增生成），按 collection.json /
// run-receipt 的真实形状手工构造等价 summary：stoppedAt 粗档映射 status；失败店
// repairRequest={candidates:[], cause:...}（最小请求单）；autoRepair:null；noActionRequired
// 记录顶层；evidence 指 runId 目录下的店目录（runId 形状取自 evidence/product-data-job-2026-10-10）。
const PRODUCT_MINIMAL = {
  version: 'unified-summary-v1',
  workflow: 'product-daily',
  date: '2026-10-11',
  shops: {
    科塔淘宝: {
      shop: '科塔淘宝',
      status: 'ok',
      evidence: 'evidence/product-data-job-2026-10-11/2026-10-11-20261011071500000-9f3ab21c/科塔淘宝',
      stoppedAt: null,
      productFile: 'C:\\Users\\Administrator\\Downloads\\【生意参谋平台】商品_全部_2026-10-11_2026-10-11.xls',
      inquiryFile: 'D:\\Retire\\sycm-automation\\evidence\\product-data-job-2026-10-11\\2026-10-11-20261011071500000-9f3ab21c\\科塔淘宝\\inquiry.xls',
    },
    网林天猫: {
      shop: '网林天猫',
      status: 'failed',
      evidence: 'evidence/product-data-job-2026-10-11/2026-10-11-20261011071500000-9f3ab21c/网林天猫',
      error: 'login: 共用商家浏览器停在登录页',
      stoppedAt: 'login',
      failureClass: 'NEEDS_LOGIN',
      noActionRequired: false,
      repairRequest: { candidates: [], cause: 'NEEDS_LOGIN' },
      autoRepair: null,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 样本 a：真实样本的欠字段清单断言（迁移仪表）
// ─────────────────────────────────────────────────────────────────────────────

test('真实样本·日报链：并写后形状全绿（第 2 步迁移仪表已清零，2026-10-11）', () => {
  const { ok, errors } = validateSummary(DAILY_REPORT_REAL_SAMPLE);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

test('rescued 豁免·救回店夹具全绿（b1 盖文淘宝真实形状＋并写补的 attempted；2026-10-11 拍板）', () => {
  // 救回店＝status:'ok' 且 autoRepair.rescued===true，保留 repairRequest/autoRepair 作审计痕迹。
  // 豁免只放开 INV2 对这两个字段的存在性检查；INV4（autoRepair 形状含 attempted）、
  // candidates 必须数组，照跑且必须过。
  const { ok, errors } = validateSummary(DAILY_REPORT_RESCUED_SAMPLE);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

test('rescued 豁免·反例：ok 店带 repairRequest 但 autoRepair.rescued 不为 true ⇒ INV2 照红', () => {
  // 不是救回的成功店带失败痕迹（没开 --auto-repair、或修过但没救回且 status 已翻 ok 的
  // 非法形态）不在豁免面上——豁免面按现状真实留档划，只认 rescued===true。
  const summary = counterBase({
    甲店: {
      shop: '甲店', status: 'ok', evidence: 'evidence/x/甲店',
      repairRequest: { candidates: [] }, // 带 repairRequest 但没有 autoRepair ⇒ 不豁免
    },
    乙店: {
      shop: '乙店', status: 'ok', evidence: 'evidence/x/乙店',
      repairRequest: { candidates: [] },
      autoRepair: { gaveUp: null, attempted: true, rescued: false }, // rescued 不为 true ⇒ 不豁免
    },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'shops.甲店.repairRequest', rule: 'INV2' },
    { path: 'shops.乙店.repairRequest', rule: 'INV2' },
    { path: 'shops.乙店.autoRepair', rule: 'INV2' },
  ]);
});

test('真实样本·推广链：欠字段清单恰好等于下列 14 条（迁移仪表：第 3 步并写后重跑本用例，清单清零才算完成）', () => {
  const { ok, errors } = validateSummary(PROMOTION_REAL_SAMPLE);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'version', rule: 'INV6' }, // 现值 promotion-sales1-summary-v1 是并写期前的旧串，第 3 步换 unified-summary-v1
    { path: 'workflow', rule: 'FIELD' }, // 缺 workflow
    // 四家失败店形状一致（shop/batch 已带、status 初值即 failed、repairRequest:{candidates:[]} 是 P0-3 形态），
    // 各欠 evidence / failureClass / noActionRequired：
    { path: 'shops.里可林淘宝.evidence', rule: 'FIELD' },
    { path: 'shops.里可林淘宝.failureClass', rule: 'INV3' },
    { path: 'shops.里可林淘宝.noActionRequired', rule: 'FIELD' },
    { path: 'shops.网林天猫.evidence', rule: 'FIELD' },
    { path: 'shops.网林天猫.failureClass', rule: 'INV3' },
    { path: 'shops.网林天猫.noActionRequired', rule: 'FIELD' },
    { path: 'shops.盖文淘宝.evidence', rule: 'FIELD' },
    { path: 'shops.盖文淘宝.failureClass', rule: 'INV3' },
    { path: 'shops.盖文淘宝.noActionRequired', rule: 'FIELD' },
    { path: 'shops.网林家居.evidence', rule: 'FIELD' },
    { path: 'shops.网林家居.failureClass', rule: 'INV3' },
    { path: 'shops.网林家居.noActionRequired', rule: 'FIELD' },
  ]);
  // 空菜单 candidates 是契约形态（unfixableShopsOf 的第二判据），不得报错；error 为字符串不得报错。
  for (const { message } of errors) {
    assert.ok(typeof message === 'string' && message.length > 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 样本 b：三链最小合法夹具全绿
// ─────────────────────────────────────────────────────────────────────────────

test('最小合法夹具·日报链：ok/失败(空菜单)/waiting/pending 初值四形态全绿', () => {
  const { ok, errors } = validateSummary(DAILY_REPORT_MINIMAL);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

test('最小合法夹具·推广链：ok/失败(空菜单)全绿', () => {
  const { ok, errors } = validateSummary(PROMOTION_MINIMAL);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

test('最小合法夹具·商品链（按草案 2.3 手工构造）：ok/失败(带 cause 的最小请求单)全绿', () => {
  const { ok, errors } = validateSummary(PRODUCT_MINIMAL);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 样本 c：反例夹具——违反 3.4 七条不变量逐条点名红
// ─────────────────────────────────────────────────────────────────────────────

/** 反例夹具的干净底座：除被测的不变量外，其余全部合法。 */
function counterBase(shops) {
  return { version: 'unified-summary-v1', workflow: 'daily-report', date: '2026-10-11', shops };
}

test('不变量1：shops 键与 record.shop 不一致（含缺 shop、空 shop）', () => {
  const summary = counterBase({
    甲店: { shop: '乙店', status: 'ok', evidence: 'evidence/x/甲店' },
    丙店: { status: 'ok', evidence: 'evidence/x/丙店' },
    丁店: { shop: '  ', status: 'ok', evidence: 'evidence/x/丁店' },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'shops.甲店.shop', rule: 'INV1' }, // 键≠record.shop
    { path: 'shops.丙店.shop', rule: 'INV1' }, // 缺 shop
    { path: 'shops.丁店.shop', rule: 'INV1' }, // 空 shop
  ]);
});

test('不变量2：ok 店带失败信号（error/failureClass/repairRequest/autoRepair）', () => {
  const summary = counterBase({
    甲店: {
      shop: '甲店',
      status: 'ok',
      evidence: 'evidence/x/甲店',
      error: '其实失败了',
      failureClass: 'STAGE_FAILED',
      repairRequest: { candidates: [] },
      autoRepair: { gaveUp: null, attempted: false },
    },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'shops.甲店.error', rule: 'INV2' },
    { path: 'shops.甲店.failureClass', rule: 'INV2' },
    { path: 'shops.甲店.repairRequest', rule: 'INV2' },
    { path: 'shops.甲店.autoRepair', rule: 'INV2' },
  ]);
});

test('不变量3：failed 店缺 failureClass / 缺 repairRequest / candidates 非数组', () => {
  const summary = counterBase({
    甲店: { shop: '甲店', status: 'failed', evidence: 'evidence/x/甲店', error: 'boom', noActionRequired: false },
    乙店: {
      shop: '乙店', status: 'failed', evidence: 'evidence/x/乙店', error: 'boom',
      failureClass: 'STAGE_FAILED', noActionRequired: false,
      repairRequest: { candidates: '菜单不是数组' },
    },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'shops.甲店.failureClass', rule: 'INV3' },
    { path: 'shops.甲店.repairRequest', rule: 'INV3' },
    { path: 'shops.乙店.repairRequest.candidates', rule: 'INV3' },
  ]);
});

test('不变量4：autoRepair 形状（{} 空对象 / 非对象 / gaveUp 与 attempted 类型）', () => {
  const summary = counterBase({
    甲店: {
      shop: '甲店', status: 'failed', evidence: 'evidence/x/甲店', error: 'boom',
      failureClass: 'STAGE_FAILED', noActionRequired: false, repairRequest: { candidates: [] },
      autoRepair: {}, // 没跑过修复就是 null，不许 {}——gaveUp 判据会把「没跑」读成「跑过」
    },
    乙店: {
      shop: '乙店', status: 'failed', evidence: 'evidence/x/乙店', error: 'boom',
      failureClass: 'STAGE_FAILED', noActionRequired: false, repairRequest: { candidates: [] },
      autoRepair: '跑过一次',
    },
    丙店: {
      shop: '丙店', status: 'failed', evidence: 'evidence/x/丙店', error: 'boom',
      failureClass: 'STAGE_FAILED', noActionRequired: false, repairRequest: { candidates: [] },
      autoRepair: { gaveUp: 5, attempted: '是' },
    },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'shops.甲店.autoRepair.gaveUp', rule: 'INV4' },
    { path: 'shops.甲店.autoRepair.attempted', rule: 'INV4' },
    { path: 'shops.乙店.autoRepair', rule: 'INV4' },
    { path: 'shops.丙店.autoRepair.gaveUp', rule: 'INV4' },
    { path: 'shops.丙店.autoRepair.attempted', rule: 'INV4' },
  ]);
});

test('不变量5：noActionRequired=true 出现在 ok 店', () => {
  const summary = counterBase({
    甲店: { shop: '甲店', status: 'ok', evidence: 'evidence/x/甲店', noActionRequired: true },
  });
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [{ path: 'shops.甲店.noActionRequired', rule: 'INV5' }]);
});

test('不变量6：version/workflow 不在登记词表内', () => {
  const summary = {
    version: 'promotion-sales1-summary-v1',
    workflow: 'weekly-post',
    date: '2026-10-11',
    shops: {},
  };
  const { ok, errors } = validateSummary(summary);
  assert.equal(ok, false);
  assert.deepEqual(projection(errors), [
    { path: 'version', rule: 'INV6' },
    { path: 'workflow', rule: 'INV6' },
  ]);
});

test('不变量7：waiting 记录缺 error/failureClass/repairRequest 不红（豁免钉住；短路豁免时本用例变红）', () => {
  const summary = counterBase({
    甲店: {
      shop: '甲店',
      status: 'waiting',
      evidence: 'evidence/x/甲店',
      state: 'WAITING_OPERATOR_ACCOUNT',
      resumable: true,
      failedStage: 'shop-report',
      reason: '生意参谋日报需要运营账号处理，开发侧暂缓该店日报流程。',
      owner: '运营',
      resumeWhen: '运营更换并确认可用账号后，从日报店铺状态登记移除该店铺。',
      stages: [],
      source: {},
    },
  });
  const { ok, errors } = validateSummary(summary);
  assert.deepEqual({ ok, errors }, { ok: true, errors: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// fail-closed：坏输入返回结构化错误，绝不抛异常
// ─────────────────────────────────────────────────────────────────────────────

test('fail-closed：输入不是对象（null / 字符串 / 数组 / 数字）⇒ 结构化错误而不是抛异常', () => {
  for (const bad of [null, undefined, 'summary', 42, [], () => {}]) {
    let result;
    assert.doesNotThrow(() => { result = validateSummary(bad); }, `输入 ${JSON.stringify(bad ?? null)} 不得抛异常`);
    assert.equal(result.ok, false);
    assert.deepEqual(projection(result.errors), [{ path: '', rule: 'FIELD' }]);
    assert.ok(result.errors[0].message.length > 0);
  }
});

test('fail-closed：缺 shops / shops 非对象 ⇒ 顶层字段错误逐条点名，shops 错误单独定位', () => {
  const missing = validateSummary({});
  assert.equal(missing.ok, false);
  assert.deepEqual(projection(missing.errors), [
    { path: 'version', rule: 'FIELD' },
    { path: 'workflow', rule: 'FIELD' },
    { path: 'date', rule: 'FIELD' },
    { path: 'shops', rule: 'FIELD' },
  ]);

  const notObject = validateSummary({
    version: 'unified-summary-v1', workflow: 'daily-report', date: '2026-10-11', shops: [],
  });
  assert.equal(notObject.ok, false);
  assert.deepEqual(projection(notObject.errors), [{ path: 'shops', rule: 'FIELD' }]);

  const badRecord = validateSummary({
    version: 'unified-summary-v1', workflow: 'daily-report', date: '2026-10-11',
    shops: { 甲店: '不是对象' },
  });
  assert.equal(badRecord.ok, false);
  assert.deepEqual(projection(badRecord.errors), [{ path: 'shops.甲店', rule: 'FIELD' }]);
});

test('词表常量：版本串 / workflow / status 枚举与拍板口径逐字一致', () => {
  assert.equal(UNIFIED_SUMMARY_VERSION, 'unified-summary-v1'); // 拍板 6.4-A：三链同串
  assert.deepEqual([...WORKFLOWS], ['daily-report', 'promotion-daily', 'product-daily']);
  assert.deepEqual([...STATUS], ['ok', 'failed', 'pending', 'waiting']); // 拍板 6.2-A：四值
});
