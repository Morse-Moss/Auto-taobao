import test from 'node:test';
import assert from 'node:assert/strict';
import { INQUIRY_HEADERS, parseInquiryRows, planInquiryImport } from './inquiry-core.mjs';

test('drops report summaries and maps all item rows', () => {
  const rows = [[], [], [], [], [], INQUIRY_HEADERS, ['商品A','1','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'], ['平均值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计']];
  const parsed = parseInquiryRows(rows, '2026-09-23', '盖文淘宝');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].row[2], '1');
  const plan = planInquiryImport({ rows: parsed, existing: [] });
  assert.equal(plan.records[0].名称, '商品A'); assert.equal(plan.records[0].咨询人数, 2); assert.equal(plan.records[0].最终付款人数, '延迟统计');
});

// 下面三条是 2026-09-27 补的回归钉子。起因：五家店询单全部导入失败、报「缺少 12 列标准表头」。
// 根因不是平台改版 —— 仓库里 2026-09-23 存档的原始导出（契约就是照它写的）真实列名同样**不带「延」**；
// 契约里那个「延」是当初读到乱码、靠形状兜底匹配留下的痕迹。
// 旧用例把 INQUIRY_HEADERS 自己当夹具，于是「契约与真实文件是否一致」这件事从未被验过。
const EXPORT_HEADERS_2026 = ['商品名称','商品编号','咨询人数','询单人数','当日询单人数','询单转化率','当日询单转化率','当日付款人数','当日付款金额','最终付款人数','最终付款金额','最终付款件数'];

test('认真实导出里不带「延」的三个列名（真实文件的形状：2 行横幅 + 3 空行 + 表头 + 数据 + 平均值/汇总值）', () => {
  const rows = [
    ['下载数据最多5000条，超出部分会被截断！','','','','','','','','','','',''],
    ['收藏网址：d.alibaba.com，让数据帮您生意参谋！点此进入>>','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    EXPORT_HEADERS_2026,
    ['商品A','123','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
    ['平均值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
    ['汇总值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
  ];
  const parsed = parseInquiryRows(rows, '2026-09-26', '里可林淘宝');
  assert.equal(parsed.length, 1, '平均值/汇总值要被排除，只留商品行');
  assert.equal(parsed[0].row[2], '123');
  const plan = planInquiryImport({ rows: parsed, existing: [] });
  assert.equal(plan.records[0].最终付款人数, '延迟统计', '无「延」的源列名必须落到同一个目标字段');
});

test('乱码表头仍走形状兜底（xlrd 路径上中文 BIFF 标签会变乱码）', () => {
  const rows = [[], [], [], [], [], ['���','���','���','���','���','���','���','���','���','���','���','���'], ['商品A','1','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计']];
  const parsed = parseInquiryRows(rows, '2026-09-26', '里可林淘宝');
  assert.equal(parsed.length, 1);
});

test('列名与形状都认不出时，报错必须带上实际表头（别再让人重新解一遍文件）', () => {
  const rows = [[], [], [], [], [], ['商品名称','商品编号','访客数','浏览量','','','','','','','','']];
  assert.throws(() => parseInquiryRows(rows, '2026-09-26', '里可林淘宝'), /缺少 12 列标准表头[\s\S]*访客数/u);
});

// ---------------------------------------------------------------------------
// 2026-10-09 补：入口查找的回归钉子
// ---------------------------------------------------------------------------
// 起因（真机，`evidence/product-data-job-2026-10-08/2026-10-08-20261009020403152-b8207a10/`）：
// 网林天猫询单报「找不到商品咨询分析入口（轮询 30s 仍未出现）」，整轮退 1。
// 事后只读复读（`evidence/inquiry-entry-probe-2026-10-09/`）证明**入口一直都在**：
// 页面渲染完时「商品分析」命中 1 个、「商品咨询分析」0 个；点一下「商品分析」后子入口立刻出现。
// 原版的写法是「进轮询前只点一次父菜单」，那一下若点空（页面还没渲染完）就再也没有第二次机会。
// 所以要钉两件事：① 决策本身（纯函数）；② 采集脚本确实把决策接进了**循环体**（不是循环之前）。
import fs from 'node:fs';
import path from 'node:path';
import { planEntryPollStep } from './inquiry-core.mjs';

test('入口轮询决策：子入口在=结束；父菜单在=重点父菜单（原版缺的就是这一下）；都读不到=只等，不盲点', () => {
  assert.equal(planEntryPollStep({ hasInquiry: true, hasParent: true }), 'done');
  assert.equal(planEntryPollStep({ hasInquiry: true, hasParent: false }), 'done');
  assert.equal(planEntryPollStep({ hasInquiry: false, hasParent: true }), 'click-parent');
  assert.equal(planEntryPollStep({ hasInquiry: false, hasParent: false }), 'wait');
  assert.equal(planEntryPollStep(), 'wait', '读数缺失（例如被截断）时按最保守处理：什么都不点');
});

const COLLECT_SOURCE = fs.readFileSync(path.join(import.meta.dirname, 'collect-inquiry-report.mjs'), 'utf8').replaceAll('\r\n', '\n');

test('采集脚本把决策接进了轮询循环体（每一轮重判）；退回「进循环前只判一次」的旧写法会立刻变红', () => {
  const loopBody = COLLECT_SOURCE.match(/while \(!entered && Date\.now\(\) < inquiryDeadline\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.ok(loopBody.length > 0, '找不到轮询循环体 —— 结构变了就更新这条判据，别让它静默失效');
  assert.ok(loopBody.includes('planEntryPollStep(entryState)'), '循环体里必须每一轮重判');
  assert.ok(loopBody.includes("step === 'click-parent'"), '「父菜单在、子入口不在」必须点父菜单 —— 这就是 2026-10-09 丢掉的那一下');
  assert.ok(COLLECT_SOURCE.includes("from './inquiry-core.mjs'"), '决策只有一处实现，不许在脚本里再抄一份');
});

test('入口找不到时「先落现场、再抛错」，顺序不能反', () => {
  const failBlock = COLLECT_SOURCE.match(/if \(!entered\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.ok(failBlock.length > 0, '找不到失败分支 —— 结构变了就更新这条判据');
  const snapshotAt = failBlock.indexOf('writeFailureSnapshot');
  const throwAt = failBlock.indexOf('throw new Error');
  assert.ok(snapshotAt >= 0, '失败路径必须留现场：这条支路以前只留一句符号，判因只能靠人肉复现');
  assert.ok(throwAt > snapshotAt, '快照要写在 throw 之前 —— 顺序反了就等于没有现场');
  assert.ok(/failure\.json/u.test(COLLECT_SOURCE), '快照落在 <out>.failure.json（--out 旁），上层链的证据目录才会自动带上它');
});
