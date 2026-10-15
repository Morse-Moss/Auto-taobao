import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKeywordReportUrl, KEYWORD_TASK_RE, KEYWORD_ZIP_RE,
  uniqueNewKeywordTask, validateKeywordReportState, validateAudienceReportState, buildAudienceReportUrl,
  AUDIENCE_TASK_RE, AUDIENCE_ZIP_RE, uniqueNewAudienceTask, validateExportRows, buildFeishuFields,
  reusablePromotionTask, confirmSubmittedTask,
} from './promotion-daily-report-core.mjs';
import { dimensionTriggerExpression } from './run-promotion-daily-report.mjs';

test('维度选择器兼容平台更新后的按钮和 role=button 标记', () => {
  const expression = dimensionTriggerExpression();
  assert.match(expression, /textContent\|\|''\)\.trim\(\)==='维度'/u);
  assert.match(expression, /closest\('button,\[role="button"\],\[class\*="trigger"\]/u);
  assert.match(expression, /维度/u);
});

test('维度操作包含条件等待，避免弹层异步渲染竞态', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /for \(let attempt = 0; attempt < 20; attempt \+= 1\)/u);
  assert.match(source, /dimension-checkbox-missing/u);
  assert.match(source, /await sleep\(250\)/u);
});

test('提交入口按业务日确认生成成功任务（㊶ 根修：不再用列表差集判成功）', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /confirmSubmittedTask\(\{ rows, kind: args\.kind, date: args\.date \}\)/u);
  assert.match(source, /submitConfirmTimeoutMs/u);
  // 2026-10-12 改钉：原来这条钉的是 `await navigate(args.proxy, target, LIST_URL);` 紧接基线读取 ——
  // 而那句话在「页签已在列表路由」时是空操作（同 URL ＝ 同文档导航），基线读到的会是旧快照，
  // 复用判据就会漏掉已有同日任务、多做一次重复提交。现在读列表前统一走 `openFreshTaskList`
  //（= 落路由 + 真重载），所以钉法跟着改成「基线读取的前一步是它」。
  assert.match(source, /await openFreshTaskList\(args\.proxy, target\);\s+const beforeRows = await readTaskRows/u);
  // 差集判据已在 10-10/10-11 两轮实测里被证伪（提交成功但一律读不到新任务），不许回流。
  assert.doesNotMatch(source, /uniqueNew(?:Keyword|Audience)Task\(before, after\)/u);
});

test('confirmSubmittedTask：提交成功的判据＝本业务日生成成功任务（多条取最新）', () => {
  const rows = [
    { name: '关键词报表_20261010_180156', rangeStart: '2026-10-09', rangeEnd: '2026-10-09', status: '生成成功' },
    { name: '关键词报表_20261011_072240', rangeStart: '2026-10-10', rangeEnd: '2026-10-10', status: '生成成功' },
    { name: '关键词报表_20261011_073000', rangeStart: '2026-10-10', rangeEnd: '2026-10-10', status: '生成成功' },
  ];
  // 目标业务日 10-10 有两条成功任务 ⇒ 取最新（与 reusable 同口径，业务等价）。
  assert.equal(confirmSubmittedTask({ rows, kind: 'keyword', date: '2026-10-10' }), '关键词报表_20261011_073000');
  // 任务已出现但仍在生成中 ⇒ 不算成功，继续等。
  assert.equal(confirmSubmittedTask({ rows: [{ name: '关键词报表_20261011_072240', rangeStart: '2026-10-10', rangeEnd: '2026-10-10', status: '生成中' }], kind: 'keyword', date: '2026-10-10' }), null);
  // 列表里只有别的业务日的成功任务（10-10 白天那批跑的是业务日 09）⇒ 不命中。
  assert.equal(confirmSubmittedTask({ rows: [rows[0]], kind: 'keyword', date: '2026-10-10' }), null);
  // kind 不同（人群 vs 关键词）⇒ 不命中。
  assert.equal(confirmSubmittedTask({ rows, kind: 'audience', date: '2026-10-10' }), null);
  assert.equal(confirmSubmittedTask({ rows: [], kind: 'keyword', date: '2026-10-10' }), null);
});

test('下载入口以同一 tbody 的操作行定位并轮询显形', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /tr\[mx-stickytable-operation\^="line"\]/u);
  assert.match(source, /for \(let attempt = 0; attempt < 20; attempt \+= 1\)/u);
  assert.match(source, /querySelectorAll\('td,th,span,div'\)/u);
});

test('builds the keyword report URL with requested filters', () => {
  const url = buildKeywordReportUrl('2026-09-30');
  assert.match(url, /#!\/report\/bidword\?/u);
  assert.match(url, /rptType=bidword/u);
  assert.match(url, /queryDomains=/u);
  assert.match(url, /startTime=2026-09-30/u);
  assert.match(url, /effectEqual=30/u);
  assert.match(url, /queryDomains=%5B%22word%22%2C%22date%22%2C%22campaign%22%2C%22adgroup%22%5D/u);
});

test('validates the report page and all dimensions', () => {
  const state = {
    href: buildKeywordReportUrl('2026-09-30'),
    triggers: ['末次点击归因', '30天累计数据', '昨日 2026-09-30', '分天'],
    text: '关键词数据明细',
    dimensions: [{ value: 'keyword', checked: true }, { value: 'time', checked: true }],
  };
  assert.deepEqual(validateKeywordReportState(state, '2026-09-30'), { ok: true, date: '2026-09-30', dimensions: 2 });
});

test('recognizes exactly one newly submitted keyword task', () => {
  const task = '关键词报表_20261001_101530';
  assert.equal(KEYWORD_TASK_RE.test(task), true);
  assert.equal(KEYWORD_ZIP_RE.test(`${task}.zip`), true);
  assert.equal(uniqueNewKeywordTask(['关键词报表_20261001_101500'], [
    '关键词报表_20261001_101500', task,
  ]), task);
  assert.throws(() => uniqueNewKeywordTask([], []), /无法唯一确认/u);
});

test('重跑时只复用同目标日且生成成功的同种任务', () => {
  const rows = [
    { name: '关键词报表_20261010_180156', rangeStart: '2026-10-09', rangeEnd: '2026-10-09', status: '生成成功' },
    { name: '关键词报表_20261010_180245', rangeStart: '2026-10-08', rangeEnd: '2026-10-08', status: '生成成功' },
    { name: '人群报表_20261010_180300', rangeStart: '2026-10-09', rangeEnd: '2026-10-09', status: '生成成功' },
  ];
  assert.equal(reusablePromotionTask(rows, { kind: 'keyword', date: '2026-10-09' }), '关键词报表_20261010_180156');
  assert.equal(reusablePromotionTask(rows, { kind: 'audience', date: '2026-10-09' }), '人群报表_20261010_180300');
  assert.equal(reusablePromotionTask([{ ...rows[0], status: '生成中' }], { kind: 'keyword', date: '2026-10-09' }), null);
});

test('推广日报入口接入成熟日报的公共任务台账与恢复判据', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8'));
  assert.match(source, /judgeResume/u);
  assert.match(source, /recordSubmitted/u);
  assert.match(source, /writeLedger/u);
  assert.match(source, /promotion-task-ledger\.mjs/u);
  assert.match(source, /--ledger/u);
});

test('builds audience URL and validates both export shapes', () => {
  assert.match(buildAudienceReportUrl('2026-09-30'), /#!\/report\/crowd\?/u);
  assert.match(buildAudienceReportUrl('2026-09-30'), /rptType=crowd/u);
  assert.equal(AUDIENCE_TASK_RE.test('人群报表_20261001_101755'), true);
  assert.equal(AUDIENCE_ZIP_RE.test('人群报表_20261001_101755.zip'), true);
  assert.equal(uniqueNewAudienceTask([], ['人群报表_20261001_101755']), '人群报表_20261001_101755');
  assert.deepEqual(validateExportRows(['日期', '场景ID'], [['2026-09-30', '372']], {
    kind: '人群', expectedColumns: 2, date: '2026-09-30',
  }), { kind: '人群', columns: 2, rows: 1, date: '2026-09-30' });
});

test('validates audience page independently from keyword page', () => {
  const state = {
    href: buildAudienceReportUrl('2026-09-30'),
    triggers: ['30天累计数据', '昨日 2026-09-30', '分天'],
    text: '人群数据明细',
    dimensions: [
      { value: 'promotion', checked: true },
      { value: 'date', checked: true },
      { value: 'campaign', checked: true },
    ],
  };
  assert.equal(validateAudienceReportState(state, '2026-09-30').ok, true);
});

test('maps export fields while leaving lookup fields empty', () => {
  const fields = buildFeishuFields(['日期', '店铺', '展现量', '空列'], ['2026-09-30', '盖文旗舰店', '12', 'x'],
    new Map([['日期', 5], ['店铺', 19], ['展现量', 2], ['空列', 5]]));
  assert.deepEqual(fields, { 日期: Date.UTC(2026, 8, 30) - 8 * 3600 * 1000, 展现量: 12 });
});

test('接受关键词报表历史 75 列和平台新增 77 列', () => {
  const headers = Array.from({ length: 77 }, (_, i) => `列${i}`);
  headers[0] = '日期';
  const rows = [Array.from({ length: 77 }, (_, i) => i === 0 ? '2026-09-30' : '')];
  assert.equal(validateExportRows(headers, rows, { kind: '关键词', expectedColumns: [75, 77], date: '2026-09-30' }).columns, 77);
});

test('允许关键词推广当天无数据，保留表头作为合法空报表', () => {
  const headers = Array.from({ length: 77 }, (_, i) => `列${i}`);
  headers[0] = '日期';
  assert.equal(validateExportRows(headers, [], {
    kind: '关键词', expectedColumns: [75, 77], date: '2026-09-30', allowEmpty: true,
  }).rows, 0);
});

// 2026-10-12 真机事故（1.8.5，07:00 推广轮）：runner 在 167 行调了 `reusablePromotionTask`，
// 而 core 的 import 块里没导这个名字 ⇒ 5 家店全部秒死在 `reusablePromotionTask is not defined`。
// `node --check` 只查语法、查不出「引用了没导入的名字」，所以这条必须由用例钉住：
// 凡是 runner 引用到的 core 导出，就必须出现在它自己那条 core import 的名单里。
test('runner 引用到的每个 core 导出都已导入（防 ReferenceError 只在真机才现形）', async () => {
  const fs = await import('node:fs/promises');
  const core = await import('./promotion-daily-report-core.mjs');
  const source = await fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8');
  const importMatch = source.match(/import\s*\{([^{}]*)\}\s*from\s*'\.\/promotion-daily-report-core\.mjs'/u);
  assert.ok(importMatch, 'runner 必须有一条从 promotion-daily-report-core.mjs 导入的 import');
  const imported = new Set(importMatch[1].split(',').map((name) => name.trim()).filter(Boolean));
  const body = source.replace(importMatch[0], '');
  const missing = Object.keys(core).filter((name) => new RegExp(`\\b${name}\\b`, 'u').test(body) && !imported.has(name));
  assert.deepEqual(missing, [], `runner 用了但没 import 的 core 导出：${missing.join('、')}`);
});

// 2026-10-12 真机误杀（同日三家店）：确认循环原来拿 `navigate(LIST_URL)` 当「刷新列表」，而目标 URL
// 与当前 URL 相同时 navigate 是**同文档导航**、浏览器什么都不做 ⇒ 列表永远停在提交后第一次渲染那
// 一版，晚几秒才生成成功的任务一条都读不到 ⇒ 判「15 分钟内未确认」。那条规矩本项目早就写过
//（`collect-core.createPageReloader` 注释、`date-picker` 09-21 教训），所以这里钉死：刷新只能是真重载。
test('确认循环的刷新必须走真重载，不许拿 navigate 顶（同 URL navigate 是空操作）', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8');
  assert.match(source, /createPageReloader/u, 'runner 必须用上项目已有的真重载器');
  assert.match(source, /const reloadListPage = createPageReloader\(\{ evalOn, delay: sleep/u,
    '重载器必须接本文件的 evalOn 与 sleep（接错等于没重载）');
  assert.match(source, /await sleep\(5000\);\s*\/\/[\s\S]*?await reloadListPage\(args\.proxy, target\);/u,
    '确认循环里 sleep 之后必须是对列表页的真重载');
  // 回归钉：原来那句「同 URL navigate」不许回流。
  assert.doesNotMatch(source, /await sleep\(5000\);\s*\n\s*await navigate\(args\.proxy, target, LIST_URL\);/u,
    '又用 navigate 到同一个 URL 当刷新了 —— 那是空操作，会再次误杀整家店');
});

test('对面认不认：真重载器确实会调 location.reload 并等到页面就绪才回', async () => {
  const { createPageReloader, reloadPageExpression } = await import('./collect-core.mjs');
  assert.match(reloadPageExpression(), /window\.location\.reload\(\)/u);
  const seen = [];
  const reloader = createPageReloader({
    evalOn: async (_proxy, _target, expression) => {
      seen.push(expression);
      return expression.includes('readyState') ? { readyState: 'complete', title: '下载任务管理' } : { reloading: true };
    },
    delay: async () => {},
    log: () => {},
  });
  assert.equal(await reloader('http://127.0.0.1:19043', 'target-1'), true);
  assert.match(seen[0], /window\.location\.reload\(\)/u, '第一步必须是重载');
  assert.ok(seen.some((expression) => expression.includes('readyState')), '重载后必须等就绪，否则会读到空白页');
});

test('读列表前的刷新统一走 openFreshTaskList（navigate + 真重载），三处读取点都不许退回裸 navigate', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile('./skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs', 'utf8');
  assert.match(source, /async function openFreshTaskList\(proxy, target\) \{\s*await navigate\(proxy, target, LIST_URL\);\s*await reloadListPage\(proxy, target\);/u,
    'openFreshTaskList 必须 = 落路由 + 真重载');
  assert.equal([...source.matchAll(/await openFreshTaskList\(/gu)].length, 3,
    '复用基线、提交后确认、取件三处读取点都要走它');
  const bare = [...source.matchAll(/await navigate\((?:args\.)?proxy, target, LIST_URL\);/gu)].length;
  assert.equal(bare, 1, `只允许 openFreshTaskList 内部那一句（同 URL 时 navigate 是空操作）；实际 ${bare} 处`);
});

// ── 失败分类与日期时间戳（2026-10-15）──────────────────────────────────────────
test('promotionFailureClass：只认确定性标记，不猜措辞', async () => {
  const core = await import('./promotion-daily-report-core.mjs');
  assert.equal(core.promotionFailureClass(`${core.PROMOTION_LOGIN_WALL_TOKEN}：阿里妈妈页停在登录墙上（expected one alimama page, got 0）`), 'NEEDS_LOGIN');
  assert.equal(core.promotionFailureClass('expected one alimama page, got 0'), 'STAGE_FAILED');
  assert.equal(core.promotionFailureClass('找不到关键词数据明细维度选择器'), 'STAGE_FAILED');
  assert.equal(core.promotionFailureClass(null), 'STAGE_FAILED');
});

test('promotionDateTimestamp＝buildFeishuFields 的唯一算法来源（写入侧与对账侧不漂移）', async () => {
  const core = await import('./promotion-daily-report-core.mjs');
  // 与 2026-10-14 实际写入值同式：Date.UTC(y, m-1, d) - 8h。
  assert.equal(core.promotionDateTimestamp('2026-10-14'), Date.UTC(2026, 9, 14) - 8 * 3600 * 1000);
  // 写入侧真的走它：对同一日期，buildFeishuFields 产出的「日期」字段＝promotionDateTimestamp。
  const targetFields = new Map([['日期', 5], ['词ID/词包ID', 1]]);
  const fields = core.buildFeishuFields(['日期', '词ID/词包ID'], ['2026-10-14', '123'], targetFields);
  assert.equal(fields['日期'], core.promotionDateTimestamp('2026-10-14'));
});

// 接线守卫（源码级）：导入器对两种报表都必须放行空表（2026-10-15 用户拍板「真实为空就为空」），
// 不许退回 allowEmpty: kind === 'keyword'。扫描目标＝import-promotion-daily-report.mjs 的调用点。
test('导入器空表放行（源码级）：两种报表 allowEmpty 恒 true', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./import-promotion-daily-report.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/validateExportRows\(/gu)];
  assert.equal(calls.length, 1, `导入器只应有 1 个 validateExportRows 调用点（收到 ${calls.length}）`);
  assert.match(src, /allowEmpty: true/u, '调用点必须 allowEmpty: true（空表＝真实业务形态，不填 0）');
  assert.equal(src.includes("allowEmpty: kind === 'keyword'"), false, '不许退回「只放行关键词」的旧口径');
});
