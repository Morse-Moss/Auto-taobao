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
import { planEntryPollStep, isInquiryPage, INQUIRY_PAGE_MARKERS, alignExportUrlDate } from './inquiry-core.mjs';

test('入口轮询决策：到报表=结束；子项可见=点子项；父菜单在=点父菜单；都读不到=只等', () => {
  assert.equal(planEntryPollStep({ pageMarker: true }), 'done', '询单人数在＝报表已加载');
  assert.equal(planEntryPollStep({ downloadBtn: 1 }), 'done', '导出按钮在＝报表已加载');
  // 2026-10-23：父菜单展开后「商品咨询分析」文案就在了，但报表没加载 ⇒ 必须再点一下子项。
  assert.equal(planEntryPollStep({ hasInquiry: true, hasParent: true }), 'click-entry');
  assert.equal(planEntryPollStep({ hasInquiry: true, hasParent: false }), 'click-entry');
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
  assert.ok(loopBody.includes("step === 'click-entry'"), '「子项文案在、报表没加载」必须点子项 —— 2026-10-23 8/8 家就是卡在这一步没点');
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

// ---------------------------------------------------------------------------
// 2026-10-22 补：判据「测的是什么」的回归钉子
// ---------------------------------------------------------------------------
// 起因（真机，`evidence/product-data-job-2026-10-21/2026-10-21-20261022021253864-e1dbdbf9/`）：
// 盖文天猫、里可林天猫询单双双报「找不到商品咨询分析入口（轮询 30s 仍未出现）」，
// 而里可林天猫的失败截图证明**页面已经进了「商品咨询分析」标签、数据也渲染出来了**
// （统计时间 2026-10-21、三个 Tab 都在、下载按钮在、商品表格 4+ 行）——
// 整页 `innerText` 里却一次「商品咨询分析」都搜不到，`hasInquiry=false`。
// 原判据把「某个 Tab 的文案今天在不在」当成了「我在不在询单页」，平台一改文案就静默失效，
// 而失败文案仍然把人指向「入口没渲染」。
//
// 现在只认结构特征。下面这条用例的读数**逐字取自那次现场**（hasInquiry=false 但统计时间在）。
const REGRESSION_READING_2026_10_22 = Object.freeze({
  shop: '里可林旗舰店',
  hasParent: true,
  hasInquiry: false,
  exactInquiry: 0,
  pageMarker: true,
  statDate: '2026-10-21',
  url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
  readyState: 'complete',
});

test('2026-10-22 现场：已进询单页但正文搜不到「商品咨询分析」⇒ 必须判「已在页」', () => {
  assert.equal(isInquiryPage(REGRESSION_READING_2026_10_22), true,
    '这条就是那次假红的原样读数 —— 判负说明又把「Tab 文案」当成了「到没到页」');
});

test('「到没到页」与「要不要点父菜单」是两件事，绝不共用一条判据', () => {
  // 同一次读数：入口决策说「点父菜单」（子入口文案确实没看到），到页判定说「已经在页」。
  // 两者同时成立不矛盾 —— 硬把 isInquiryPage 接回 planEntryPollStep 就会在页内空转到超时。
  assert.equal(isInquiryPage(REGRESSION_READING_2026_10_22), true);
  // 父菜单展开、子项文案在、但报表还没加载 ⇒ 决策必须继续点（不是 done）
  const expandedOnly = { hasParent: true, hasInquiry: true, pageMarker: false, downloadBtn: 0 };
  assert.equal(isInquiryPage(expandedOnly), false, '文案在 ≠ 报表在');
  assert.equal(planEntryPollStep(expandedOnly), 'click-entry', '这时必须点开子项，否则导出按钮永远不出现');
});

test('结构特征任一命中即算在页；一个都没有才算没到', () => {
  assert.equal(isInquiryPage({ pageMarker: true }), true, '询单人数在就算在页');
  assert.equal(isInquiryPage({ downloadBtn: 1 }), true, '导出按钮在场＝报表工具条已渲染，比文案硬');
  assert.equal(isInquiryPage({ hasInquiry: true }), false,
    '左侧「商品咨询分析」文案在 ≠ 报表在（父菜单一展开它就在，2026-10-23 实测）');
  assert.equal(isInquiryPage({ hasParent: true, hasInquiry: false, pageMarker: false }), false,
    '父菜单在、但没有任何报表特征是「真的没到页」');
  assert.equal(isInquiryPage(), false, '读数缺失按最保守处理');
});

test('导出地址的日期必须对齐到目标日（补跑别的日期时不能照抄页面上那一天）', () => {
  const fromPage = '/csp/api/cst/item/shop/list/export.json?dateType=day&endDate=20261022&dateRange=1d&orderBy=cstCnt&startDate=20261022&order=desc&itemId=&excludeDates=';
  const aligned = alignExportUrlDate(fromPage, '2026-10-21');
  assert.match(aligned, /startDate=20261021/u, '起始日没对齐 ⇒ 导出的是页面那天的数据，写进飞书就是错日');
  assert.match(aligned, /endDate=20261021/u);
  assert.match(aligned, /orderBy=cstCnt/u, '其余参数必须原样保留（排序/维度变了行就对不上了）');
  // 没有日期参数就原样返回，不猜、不拼。
  const noDate = '/csp/api/x/export.json?dateType=day';
  assert.equal(alignExportUrlDate(noDate, '2026-10-21'), noDate);
  // 绝对地址保持绝对；空值不报错。
  assert.match(alignExportUrlDate('https://sycm.taobao.com/a/export.json?startDate=20261022&endDate=20261022', '2026-10-21'), /^https:\/\/sycm\.taobao\.com\/a\/export\.json\?startDate=20261021/u);
  assert.equal(alignExportUrlDate('', '2026-10-21'), '');
  assert.equal(alignExportUrlDate(fromPage, 'not-a-date'), fromPage);
});

test('2026-10-23 现场：业绩总览页也带「统计时间」⇒ 它绝不能当成「已在询单页」', () => {
  // 真机只读探针（网林淘宝）：总览页 统计时间=在、询单人数=不在、下载按钮 0 个；
  // 点一下「商品分析」后 询单人数=在、下载按钮 1 个、表格 18 行。
  // 旧判据把「统计时间」当结构特征 ⇒ 轮询在总览页就收工、从不点菜单、下载按钮永远不在
  // ⇒ 导出地址恒为空，8/8 家全报「页面状态不满足：{"link":""}」。
  const overview = { hasParent: true, hasInquiry: false, pageMarker: false, statDate: '2026-10-22', downloadBtn: 0 };
  assert.equal(isInquiryPage(overview), false, '总览页判成在页＝这一轮必然白跑');
  assert.equal(isInquiryPage({ statDate: '2026-10-22' }), false, 'statDate 只用来读日期，不参与到页判定');
  assert.equal(isInquiryPage({ statDate: '统计时间 2026-10-22' }), false, '整段文本同样不算');
  assert.equal(planEntryPollStep(overview), 'click-parent', '总览页上必须允许点父菜单进子页');
});

// 2026-10-23 重写。上一版断的是「源文件里有 ${PAGE_MARKER_EXPR} 这串字」——
// 而双引号字符串里那段字**正因为不插值才会原样存在** ⇒ 它把 bug 当成了合规证据
// （1.12.14 上线后询单 8/8 全灭，报 `SyntaxError: Unexpected token '{'`，这些用例全绿）。
// 现在改成钉「展开后真正发给页面的那段 JS」：必须能解析、必须带上词表、必须用对正文变量名。
const MARKER_EXPR_OF = (varName) => INQUIRY_PAGE_MARKERS.map((marker) => `${varName}.includes(${JSON.stringify(marker)})`).join('||');

function literalOf(name) {
  const matched = COLLECT_SOURCE.match(new RegExp(`const ${name}\\s*=(\\s*\`[^\`]*\`|\\s*"[^"]*"|\\s*'[^']*');`, 'u'));
  assert.ok(matched, `找不到 ${name} 的定义 —— 结构变了就要连这份守卫一起改`);
  return matched[1].trim();
}

test('页面侧的结构词表真的展开进了表达式（不是只在源文件里出现过）', () => {
  // 2026-10-23 第二现场：上一版这里只查「词表里每一项在源文件里出现过」——
  // 单向 includes 查不出**多出来的**那一项。脚本里那会儿还留着 `['统计时间','询单人数']`，
  // 而 `统计时间` 每个业绩页都有 ⇒ 入口闸门在总览页就判真、轮询循环一次没进、8/8 家全灭。
  // 现在改成整串比对展开后的表达式：多一项、少一项、顺序变了，全都立刻变红。
  const evalLiteral = (name) => new Function(`return ${literalOf(name)}`)();
  const bindings = {
    PAGE_MARKER_EXPR: MARKER_EXPR_OF('t'),
    PAGE_MARKER_EXPR_TEXT: MARKER_EXPR_OF('text'),
    INQUIRY_PARENT: evalLiteral('INQUIRY_PARENT'),
    INQUIRY_ENTRY: evalLiteral('INQUIRY_ENTRY'),
  };
  const names = Object.keys(bindings);
  // 两段页面表达式的正文变量名不同（入口那段是 `t`、页面读取那段是 `text`）
  for (const [name, varName] of [['READ_ENTRY_STATE', 't'], ['READ_PAGE_STATE', 'text']]) {
    const raw = literalOf(name);
    assert.equal(raw[0], '`',
      `${name} 必须用反引号模板：双引号里 \${...} 不会插值，页面会收到字面量并回 400（2026-10-23 询单 8/8 全灭的直接原因）`);
    const expanded = new Function(...names, `return ${raw}`)(...names.map((key) => bindings[key]));
    assert.doesNotMatch(expanded, /\$\{/u, `${name} 里还留着没展开的 \${...} —— 页面侧必然 SyntaxError`);
    assert.ok(expanded.includes(MARKER_EXPR_OF(varName)),
      `${name} 的词表必须与 INQUIRY_PAGE_MARKERS 逐项一致（正文变量名是 ${varName}，写死 t. 会 ReferenceError）`);
    assert.doesNotThrow(() => new Function(`return ${expanded}`), `${name} 展开后必须是一段能解析的 JS`);
  }
});

test('页面侧词表只有一个来源：从 inquiry-core 导入，不许在采集脚本里再抄一份', () => {
  // 「同一份词表活在两处」正是这次 8/8 全灭的成因：core 改了、脚本那份没改，而守卫又只单向查。
  assert.match(COLLECT_SOURCE, /\bINQUIRY_PAGE_MARKERS\b/u, '采集脚本必须导入 INQUIRY_PAGE_MARKERS');
  assert.match(COLLECT_SOURCE, /from '\.\/inquiry-core\.mjs'/u);
  assert.doesNotMatch(COLLECT_SOURCE, /const PAGE_MARKERS\s*=\s*\[/u,
    '不许再写一份词表字面量 —— 改一处忘另一处会静默失效（2026-10-23 实测）');
});

test('脚本自己算出来的那段词表表达式，必须与 INQUIRY_PAGE_MARKERS 完全一致', () => {
  // 上一条只查「有没有本地字面量」。`INQUIRY_PAGE_MARKERS.concat(['统计时间'])` 这种写法能绕过它，
  // 而上面那条整串比对又是**把标准词表当参数注入**去求值字面量的 ⇒ 同样测不到脚本自身算出来的那份。
  // 这一条真去执行脚本里 `markersExprOf` 的定义体，把 INQUIRY_PAGE_MARKERS 绑成标准值，看它算出什么。
  const body = COLLECT_SOURCE.match(/const markersExprOf = \(varName\) =>([\s\S]*?);\n/u)?.[1];
  assert.ok(body, '找不到 markersExprOf 的定义 —— 结构变了就连这条判据一起改');
  let computed;
  try {
    const build = new Function('INQUIRY_PAGE_MARKERS', `return (varName) =>${body}`)(INQUIRY_PAGE_MARKERS);
    computed = build('t');
  } catch (error) {
    assert.fail(`脚本里的词表没走 INQUIRY_PAGE_MARKERS（求值就抛了：${error?.message}）—— `
      + '这就是 2026-10-23 8/8 全灭的成因：本地那份多带了「统计时间」，总览页就被判成已在询单页');
  }
  assert.equal(computed, MARKER_EXPR_OF('t'),
    '脚本算出来的词表与 INQUIRY_PAGE_MARKERS 不一致 —— 多一项就会在总览页提前放行（实测 8/8 全灭）');
});

test('两处「在询单页」判定都修了（只修入口那处会换个地方再红一次）', () => {
  // READ_PAGE_STATE 里的 `hasInquiry:text.includes('商品咨询分析')` 是同一病根的第二个出口：
  // 入口放行后立刻在「页面状态不满足」上再红一次，看起来像新毛病。
  assert.doesNotMatch(
    COLLECT_SOURCE,
    /hasInquiry:text\.includes\('商品咨询分析'\)/u,
    'READ_PAGE_STATE 不许退回只认文案的旧写法',
  );
});

test('采集脚本的入口判定真的调用了 isInquiryPage（纯函数对了但没人调用＝没修）', () => {
  // 突变验证暴露过这个洞（2026-10-22 M1）：把调用点改回 `planEntryPollStep(...) !== 'done'`，
  // 纯函数的用例照样全绿 —— 因为那些用例只测纯函数本身，测不到「谁在使用它」。
  // 这一条盯的是调用侧：入口判定必须走 isInquiryPage，且循环体里每轮也用它。
  const callSites = COLLECT_SOURCE.match(/isInquiryPage\(/gu) ?? [];
  assert.ok(callSites.length >= 2, `isInquiryPage 至少要在「进循环前」和「循环体内」各调用一次，实际 ${callSites.length} 次`);
  assert.match(COLLECT_SOURCE, /if \(!isInquiryPage\(entryState\)\) \{/u, '入口闸门必须用 isInquiryPage，不许退回「子入口文案在不在」');
  const loopBody = COLLECT_SOURCE.match(/while \(!entered && Date\.now\(\) < inquiryDeadline\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.ok(loopBody.includes('isInquiryPage(entryState)'), '循环体里每轮都必须重新判「到没到页」');
});
