import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SHOP_REPORT_PATTERN, PROMOTION_TASK_PATTERN, PROMOTION_ZIP_PATTERN,
  alimamaIdentityExpression, assertMemberIdentity, assertShopIdentity, checkboxStateExpression,
  dateWithinRange, defaultDownloadsDir, describeEntryMiss, describeHitMiss,
  describeHitPass, downloadEntryExpression, hitCheckExpression, listDownloads, newEntries, newestTaskName,
  parseCollectArgs, pickNewest, restoreCheckboxesExpression, scrollIntoViewExpression,
  sycmShopIdentityExpression, targetRowExpression,
} from './collect-core.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const readScript = (name) => readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');

function fixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'collect-core-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

test('下载目录扫描：只认形状对的文件，大小与 mtime 一起带出来', () => {
  const dir = fixture({
    '日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx': 'x'.repeat(20),
    '日报_20260917_adc987ef8d0897700e42dcf1427605b3 (2).xlsx': 'x'.repeat(24),
    // 2026-09-18 实例：同一轮采集里，「盖文淘宝」那一份落盘叫 `日报2_…`（报表名每店不同）。
    '日报2_20260918_90f3f449b92531c0823d97ec6d6bb86b.xlsx': 'x'.repeat(28),
    '日报_20260916_othername.xlsx': 'x',
    '营销场景报表_20260917_112258.zip': 'zip',
    '~$日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx': 'lock',
    '别的文件.txt': 'x',
  });
  const shops = listDownloads(dir, SHOP_REPORT_PATTERN);
  // 关键：Excel 的锁文件 `~$…` 与不含哈希的旧名都不算候选 —— 它们是「看起来像」的那一类。
  assert.deepEqual(shops.map((entry) => entry.name).sort(),
    ['日报2_20260918_90f3f449b92531c0823d97ec6d6bb86b.xlsx',
      '日报_20260917_adc987ef8d0897700e42dcf1427605b3 (2).xlsx',
      '日报_20260917_adc987ef8d0897700e42dcf1427605b3.xlsx']);
  assert.equal(shops.find((entry) => entry.name.endsWith('(2).xlsx')).size, 24);
  assert.ok(shops.every((entry) => Number.isFinite(entry.mtimeMs)));

  assert.deepEqual(listDownloads(dir, PROMOTION_ZIP_PATTERN).map((entry) => entry.name),
    ['营销场景报表_20260917_112258.zip']);
  assert.equal(SHOP_REPORT_PATTERN.test('日报_20260916_othername.xlsx'), false,
    '哈希段缺失的文件不该被当成店铺报表');
  // 判据太窄的失败方向是「安全但归因跑偏」：下载成功却报「没等到新文件」，
  // 看起来像站点没响应，实际是本地正则不认（2026-09-18 实亏一次）。
  assert.equal(SHOP_REPORT_PATTERN.test('日报2_20260918_90f3f449b92531c0823d97ec6d6bb86b.xlsx'), true,
    '带数字后缀的报表名（日报2）也是本链的产物，不许漏');
  assert.equal(SHOP_REPORT_PATTERN.test('日报2_20260918_90f3f449b92531c0823d97ec6d6bb86b (1).xlsx'), true,
    '数字后缀与 Windows 的重名后缀可以同时出现');
  // 目录不存在要抛出可读错误，不许静默当成「目录里是空的」。
  assert.throws(() => listDownloads(path.join(dir, '__not_here__'), SHOP_REPORT_PATTERN), /cannot read downloads directory/u);
});

test('下载判据取文件系统：新出现的文件才是成功，且多个时取 mtime 最新的', () => {
  const before = ['日报_a.xlsx'];
  const after = ['日报_a.xlsx', '日报_b.xlsx', '日报_b (1).xlsx'];
  assert.deepEqual(newEntries(before, after), ['日报_b.xlsx', '日报_b (1).xlsx']);
  // 一个都没新增 ⇒ 空数组（调用方据此继续等，而不是「反正点了就算成功」）。
  assert.deepEqual(newEntries(before, before), []);
  assert.equal(pickNewest([]), null);

  const picked = pickNewest([
    { name: 'old.zip', mtimeMs: 100, size: 1 },
    { name: 'new.zip', mtimeMs: 300, size: 2 },
    { name: 'mid.zip', mtimeMs: 200, size: 3 },
  ]);
  assert.equal(picked.name, 'new.zip');
});

test('认下载任务：按名字里的时间戳取最新，不按「今天」过滤', () => {
  const names = [
    '营销场景报表_20260917_080428',
    '营销场景报表_20260917_112258',
    '营销场景报表_20260916_150325',
    '别的报表_20260917_235959',
    '营销场景报表_20260917_112258', // 列表里可能有重复
  ];
  assert.equal(newestTaskName(names), '营销场景报表_20260917_112258');
  // 跨零点跑的时候，「任务名里的日期」是导出日、不是目标日 —— 所以默认不按日期收窄。
  assert.equal(newestTaskName(names, { exportDate: '2026-09-16' }), '营销场景报表_20260916_150325');
  assert.equal(newestTaskName(['日报_20260917_abc.xlsx']), null);
  assert.equal(newestTaskName([]), null);
  assert.equal(PROMOTION_TASK_PATTERN.test('营销场景报表_20260917_112258'), true);
  assert.equal(PROMOTION_TASK_PATTERN.test('营销场景报表_20260917_1122'), false);
});

test('统计区间必须含目标日（含不含是这份工作簿能不能用的前提）', () => {
  assert.equal(dateWithinRange(['2026-08-18', '2026-09-16'], '2026-09-16'), true);
  assert.equal(dateWithinRange(['2026-08-18', '2026-09-15'], '2026-09-16'), false);
  assert.equal(dateWithinRange(['2026-09-16', '2026-09-16'], '2026-09-16'), true);
  assert.throws(() => dateWithinRange(null, '2026-09-16'), /invalid range/u);
  assert.throws(() => dateWithinRange(['2026/08/18', '2026-09-16'], '2026-09-16'), /invalid date/u);
  assert.throws(() => dateWithinRange(['2026-08-18', '2026-09-16'], '09-16'), /invalid date/u);
});

test('采集脚本参数：缺日期/未知参数/阶段写错一律抛错，不静默按默认值跑', () => {
  assert.deepEqual(parseCollectArgs(['--date', '2026-09-16']).date, '2026-09-16');
  assert.throws(() => parseCollectArgs([]), /missing or invalid --date/u);
  assert.throws(() => parseCollectArgs(['--date', '2026/09/16']), /missing or invalid --date/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--whatever']), /unknown argument/u);
  assert.throws(() => parseCollectArgs(['--date']), /requires a value/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--timeout-ms', '0']), /positive integer/u);

  // 只有阿里妈妈那支收 --phase，且只收这两个值。
  assert.equal(parseCollectArgs(['--date', '2026-09-16', '--phase', 'fetch'], { phases: ['submit', 'fetch'] }).phase, 'fetch');
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--phase', 'download'], { phases: ['submit', 'fetch'] }),
    /--phase must be one of submit\|fetch/u);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--phase', 'fetch']), /does not take --phase/u);
});

test('下载目录默认值从环境推，不许把某台机器的路径写进仓库', () => {
  assert.equal(defaultDownloadsDir({ USERPROFILE: 'C:\\Users\\someone' }),
    path.join('C:\\Users\\someone', 'Downloads'));
  assert.equal(defaultDownloadsDir({ HOME: '/home/someone' }), path.join('/home/someone', 'Downloads'));
  assert.throws(() => defaultDownloadsDir({}), /USERPROFILE\/HOME/u);
  for (const name of ['collect-shop-report.mjs', 'collect-promotion-report.mjs']) {
    assert.equal(/C:[\\/]Users[\\/]Administrator/u.test(readScript(name)), false,
      `${name} 里写死了本机路径`);
  }
});

// 这一条盯的是 2026-09-17 实亏过一次、随后又被证伪重写的坑。
// 首页模型：文件名行的**下一个 tr** 是这一行的「操作行」（放下载/AI分析/删除），而它默认 display:none。
// 被证伪的模型：「底部还有一条操作栏，是第二条取件路」—— 实测那就是当时恰好激活的那一行的操作行。
// 所以判据必须是「目标任务行的下一行」+「该行已被激活」，而不是「全页第一个可见的下载」。
test('阿里妈妈取件：下载入口只认文件名行的下一个兄弟行，且必须只接受可见元素', () => {
  const core = readScript('collect-core.mjs');
  const entry = downloadEntryExpression('营销场景报表_20260917_123456');
  assert.match(core, /export const TASK_DOWNLOAD_MARK = 'data-collect-task-download'/u,
    '标记属性名要有单一来源，别在两处各写一个字面量');
  assert.match(entry, /nextElementSibling/u, '必须往下一个兄弟行找，而不是在文件名同一行里找');
  assert.match(entry, /data-collect-task-download/u);
  assert.match(entry, /leaves\.find\(isVisible\)/u, '取「下载」时必须只接受可见元素');
  assert.equal(/textContent\.trim\(\) === '下载'\)\[0\]/u.test(entry), false,
    '不许退回「取第一个」—— 实测页面上 8 个「下载」叶子，7 个 rect 全零');
  // 「只认下一行」这条不能靠全页扫描来实现：候选必须取自**该行的操作行**。
  assert.match(entry, /actionTr\.querySelectorAll\('\*'\)/u, '候选必须在「该行的操作行」里找，不是全页找');
  // 全页扫描只允许用来**计数**（visibleDownloads），不允许用来挑入口 —— 后者会点到别的任务行。
  assert.match(entry, /const visibleDownloads = \[\.\.\.document\.querySelectorAll\('\*'\)\]/u);
  assert.equal(/const entry = \[\.\.\.document\.querySelectorAll/u.test(entry), false,
    '不许用全页扫描挑入口');
  // 点击前必须有命中复核。判据本体在 collect-core（下面几条测试盯它），这里只要求脚本用它 ——
  // 前一份是各写一份，两份漂移过一次，2026-09-17 的误判就是这么来的。
  const promo = readScript('collect-promotion-report.mjs');
  assert.match(promo, /hitCheckExpression/u);
  // 成功判据必须落在文件系统上：页面说「生成成功」不算数。
  assert.match(promo, /newEntries\(before, listDownloads/u);
});

// 取件的前提是「先激活目标任务行」。不激活，它的操作行就是 display:none，入口根本不存在；
// 而这一页上「点错」不会报错，只会静默什么都不发生 —— 2026-09-17 的 30 秒空等就是这么来的。
test('阿里妈妈取件：必须先选中目标任务行并回读 checked，才谈得上找入口', () => {
  const promo = readScript('collect-promotion-report.mjs');
  const fetchBody = promo.slice(promo.indexOf('async function phaseFetch'));
  const selectAt = fetchBody.indexOf('targetRowExpression(wanted)');
  const entryAt = fetchBody.indexOf('downloadEntryExpression(wanted)');
  assert.ok(selectAt > 0, 'fetch 段必须先用 targetRowExpression 定位目标任务行');
  assert.ok(entryAt > 0, 'fetch 段必须用 downloadEntryExpression 定位入口');
  assert.ok(selectAt < entryAt, '选行必须早于找入口 —— 顺序反了入口永远不显形');
  assert.match(fetchBody, /selectTargetRow\(args, targetId, wanted, row\)/u, '选行要收成一个可复用的过程');
  // 点了复选框要**回读**：clickPoint 的返回值恒为 clicked:true，它证明不了任何事。
  // 「点之前先确认那一点真的是它」与「点完回读」都在 selectTargetRow 里（2026-09-17 被浮层坑过之后）。
  const selectBody = promo.slice(promo.indexOf('async function selectTargetRow'), promo.indexOf('async function main'));
  assert.ok(selectBody.length > 0, '选行必须收成一个独立过程，否则重试逻辑会散落在主流程里');
  assert.match(selectBody, /checkboxHit === false/u, '被别的东西挡住时不许硬点，要等它自己收起来再量一次');
  assert.match(selectBody, /after\.checked/u, '点完必须回读该行的 checked');
  assert.match(selectBody, /勾选 .* 失败/u, '重试完还是没勾上就必须停下，不许继续往下点');
  // 「量到点」之间页面会动，差一行（41px）就点空 —— 所以点之前当场重新量，且禁止零尺寸坐标。
  assert.match(promo, /拒绝点击可疑坐标/u, '零尺寸矩形算出的 (0,0) 会点到页面左上角，必须挡住');
  assert.match(fetchBody, /滚动后重新定位|滚动后入口不再可定位/u, '滚动会改变显隐状态，滚完必须重新定位');
  // 「那一行找到了」不等于「那一行现在能取件」：还在生成中时点了不落盘，和「点错了」现场长得一样。
  assert.match(fetchBody, /还不是「生成成功」/u, '任务没生成成功就得停，否则只能靠 30 秒超时去猜');
});

// 「量到坐标」不等于「点得到」：2026-09-17 实测有个 z-index 999999 的浮层正压住第一行，
// 中心点命中的是浮层里的 TD，真实点击落在浮层上、复选框纹丝不动，而这一页「点错不报错」。
// 所以表达式必须在点之前就把「那一点是谁」带出来。
test('目标行表达式在沙箱里真的能算遮挡：命中自己=可点，命中别人=报出是谁', () => {
  const TASK = '营销场景报表_20260917_123456';
  const build = ({ blocked }) => {
    const box = {
      tagName: 'INPUT', className: 'ant-checkbox-input', checked: false,
      getBoundingClientRect: () => ({ x: 136, y: 334, width: 14, height: 14 }),
      contains(other) { return other === box; },
    };
    // 挡路物也要有 contains：真实 DOM 元素都有，表达式正是靠它判断「命中的是它自己还是它的祖先」。
    const blocker = {
      tagName: 'TD', className: 'asiYysqquv',
      contains(other) { return other === blocker; },
    };
    // 第三个沙箱：命中的东西连 contains 都没有（在别人家页面里 eval，不能假定原型完整）。
    const bare = { tagName: 'DIV', className: 'no-contains' };
    const tr = { tagName: 'TR', innerText: TASK, children: [], querySelector: (sel) => (sel === 'input[type=checkbox]' ? box : null) };
    const taskLeaf = {
      tagName: 'SPAN', children: [], textContent: TASK, innerText: TASK,
      getBoundingClientRect: () => ({ x: 120, y: 330, width: 180, height: 20 }),
      closest: () => tr,
    };
    return {
      document: {
        querySelectorAll: (sel) => (sel === 'tr' ? [tr] : [taskLeaf]),
        elementFromPoint: () => (blocked === 'bare' ? bare : (blocked ? blocker : box)),
      },
    };
  };
  const run = (blocked) => JSON.parse(new Function('document',
    `return ${targetRowExpression(TASK)};`)(build({ blocked }).document));

  const clear = run(false);
  assert.equal(clear.found, true);
  assert.deepEqual(clear.checkboxCenter, [143, 341]);
  assert.equal(clear.checkboxHit, true, '中心命中的就是它 ⇒ 可以点');
  assert.equal(clear.checkboxHitTag, 'INPUT');

  const covered = run(true);
  assert.equal(covered.checkboxHit, false, '中心命中的是别人 ⇒ 不许点，先等');
  assert.equal(covered.checkboxHitTag, 'TD', '要说清挡路的是谁，否则只能回去手工复现');
  assert.equal(covered.checkboxHitClass, 'asiYysqquv');

  const foreign = run('bare');
  assert.equal(foreign.checkboxHit, false, '命中的东西没有 contains ⇒ 按「不是它」处理，走重试');
  assert.equal(foreign.checkboxHitTag, 'DIV', '没 contains 也要把 tag 带出来，方便复现');
});

// 真的把它跑一次：字符串比对看不见「这个名字在页面里根本不存在」，也看不见分支走错。
test('取件表达式在沙箱里真的能跑：操作行隐藏时报 action-row-hidden，显形时给出可点中心', () => {
  const TASK = '营销场景报表_20260917_123456';
  const zero = { x: 0, y: 0, width: 0, height: 0 };

  const build = ({ actionRowVisible }) => {
    const node = ({ tag, text, rect, children = [] }) => ({
      tagName: tag, children, textContent: text, innerText: text, _attrs: new Set(), _rect: rect,
      ownerTr: null,
      getBoundingClientRect() { return this._rect; },
      setAttribute(name) { this._attrs.add(name); },
      removeAttribute(name) { this._attrs.delete(name); },
      contains(other) { return other === this; },
      closest(sel) { return sel === 'tr' ? this.ownerTr : null; },
      querySelectorAll() { return []; },
    });

    const taskLeaf = node({ tag: 'SPAN', text: TASK, rect: { x: 120, y: 56, width: 180, height: 20 } });
    const sticky = node({ tag: 'DIV', text: '', rect: { x: 1258, y: 286, width: 60, height: 322 } });
    const downloadLeaf = node({ tag: 'SPAN', text: '下载', rect: actionRowVisible ? { x: 149, y: 105, width: 24, height: 12 } : zero });
    const button = node({ tag: 'BUTTON', text: '下载', rect: actionRowVisible ? { x: 136, y: 99, width: 49, height: 24 } : zero, children: [downloadLeaf] });
    downloadLeaf.closest = (sel) => (sel === 'button' ? button : (sel === 'tr' ? actionTr : null));
    const actionTr = node({ tag: 'TR', text: '下载 导入超级表格 AI分析 删除', rect: actionRowVisible ? { x: 112, y: 97, width: 1290, height: 41 } : zero });
    actionTr.querySelectorAll = () => [downloadLeaf];
    const taskTr = node({ tag: 'TR', text: TASK, rect: { x: 112, y: 56, width: 1290, height: 41 }, children: [taskLeaf] });
    taskLeaf.ownerTr = taskTr;
    taskTr.nextElementSibling = actionTr;

    const all = [taskLeaf, downloadLeaf, button, taskTr, actionTr];
    return {
      document: {
        querySelectorAll: (sel) => {
          if (sel === 'tr') return [taskTr, actionTr];
          if (sel === '[data-collect-task-download]') return all.filter((el) => el._attrs.has('data-collect-task-download'));
          return all;
        },
      },
      window: { innerWidth: 1323, innerHeight: 628 },
      getComputedStyle: () => ({ display: actionRowVisible ? 'table-row' : 'none' }),
    };
  };

  const run = (env, task = TASK) => new Function('document', 'window', 'getComputedStyle',
    `return ${downloadEntryExpression(task)};`)(env.document, env.window, env.getComputedStyle);

  // 未激活该行 ⇒ 操作行隐藏 ⇒ 必须报 action-row-hidden，而不是「找不到元素」或者硬着头皮点。
  const hidden = JSON.parse(run(build({ actionRowVisible: false })));
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, 'action-row-hidden');
  assert.equal(hidden.actionRowDisplay, 'none');
  assert.equal(hidden.actionTrIndex, 1, '要说清找的是哪一行');
  assert.match(describeEntryMiss(hidden), /action-row-hidden/u);

  // 激活后 ⇒ 给出按钮（不是里面那个 span）的矩形与中心，并报「全页可见的下载只有 1 个」。
  const visible = JSON.parse(run(build({ actionRowVisible: true })));
  assert.equal(visible.ok, true);
  assert.deepEqual(visible.rect, [136, 99, 49, 24]);
  assert.deepEqual(visible.center, [161, 111]);
  assert.equal(visible.visibleDownloads, 1);
  assert.equal(visible.inViewport, true);

  // 文件名那行认不出来时也要有可读 reason，不许抛异常。
  const missing = JSON.parse(run(build({ actionRowVisible: true }), '不存在的任务_20260101_000000'));
  assert.equal(missing.reason, 'task-row-missing');
});

// 排练要走到「选中目标任务行」这一步（不然操作行不显形，排练就成了「排练通过、真跑失败」），
// 所以排练结束必须把勾选状态恢复原样 —— 排练的语义是只读。
test('勾选集：能记一份、也能恢复成原来那份（排练收尾用）', () => {
  assert.match(checkboxStateExpression(), /checked/u);
  const boxes = [{ checked: true }, { checked: false }, { checked: false }, { checked: true }];
  boxes.forEach((box) => { box.click = () => { box.checked = !box.checked; }; });
  const document = { querySelectorAll: () => boxes };
  const run = (expression) => JSON.parse(new Function('document', `return ${expression};`)(document));

  assert.deepEqual(run(checkboxStateExpression()).checked, [0, 3]);
  assert.equal(run(checkboxStateExpression()).total, 4);

  // 恢复成 [1,3]：第 0 个要取消、第 1 个要勾上 —— 只动这两个。
  const restored = run(restoreCheckboxesExpression([1, 3]));
  assert.equal(restored.changed, 2);
  assert.deepEqual(restored.checked, [1, 3]);
  // 再跑一次：已经是目标状态，就不该再动任何一个。
  assert.equal(run(restoreCheckboxesExpression([1, 3])).changed, 0);
});

// 2026-09-17 实跑时栽在「点击前复核」这一小段上，两个现场形态都不是「按钮不可点」：
//   ① 元素整个落在视口**右边界之外**（实测 innerWidth=1203、元素 x∈[1305,1378]）——
//      只写 block:'center' 时 inline 会取默认的 nearest，元素不会被带回来，
//      中心点 elementFromPoint 直接返回 null ⇒ 误报 not-hit（点击其实是能成功的，走 JS）；
//   ② 中心点被右侧常驻悬浮条（实测 z-index 99999、rect [1258,286,60,322]）盖住 ⇒ 同样误报。
// 所以判据改成「矩形内至少一个视口内且命中自己的采样点」，并把滚动改成两个方向都居中。
test('点击前复核：两个方向都要居中；判据是「矩形内有视口内且命中自己的采样点」', () => {
  const scroll = scrollIntoViewExpression('#x');
  assert.match(scroll, /block: 'center'/u);
  assert.match(scroll, /inline: 'center'/u,
    '必须显式要求水平也居中 —— 只给 block 时，元素在视口右边界外不会被带回来');
  // 反向自证：判据有效 —— 只写 block 的写法必须被判负。
  assert.equal(/inline: 'center'/u.test("el.scrollIntoView({ block: 'center' })"), false);

  const check = hitCheckExpression('#x');
  assert.match(check, /window\.innerWidth/u, '采样必须按视口宽度过滤');
  assert.match(check, /insideSamples/u);
  assert.match(check, /centerIsSelf/u, '中心点要单独记，通过时才能说清凭什么算通过');
  // 同一 selector 可能命中多个元素：这些脚本用 data- 属性标目标，而页面是 hash 路由
  // （navigate 不重载），上一轮标过的元素会留在 DOM 里 ⇒ 必须挑可见的那个，不能取文档序第一个。
  assert.match(check, /matches\.find\(isVisible\)/u, '要在匹配集合里挑可见的，不能取第一个');
  assert.equal(/document\.querySelector\(/u.test(check), false, '不许退回 querySelector 取第一个');
  assert.match(scroll, /matches\.find\(/u, 'scrollIntoView 也要挑可见的那个');
  // 判据不能退回「只看中心点」——那正是今天误判的形态。
  assert.equal(/const hitOk = !!point && \(point === el/u.test(check), false);
});

// 真的把它跑一次：字符串比对看不见「这个名字在页面里根本不存在」，也看不见分支走错。
// 用最小 stub 造出今天现场的两个形态，验证判据给出的结论是同一套。
test('复核表达式在沙箱里真的能跑：视口外判负、中心被盖但边缘命中的判正', () => {
  const makeEl = (rect) => ({
    rect,
    getBoundingClientRect() { return this.rect; },
    contains(node) { return node === this; },
  });
  const run = (expression, { el, elList, pointAt }) => new Function('document', 'window', `return ${expression};`)({
    querySelectorAll: () => elList ?? (el ? [el] : []),
    elementFromPoint: pointAt,
  }, { innerWidth: 1203, innerHeight: 612 });

  // 场景 A：整个在视口右边界外 ⇒ 一个视口内采样点都没有，判负且 reason 点名原因。
  const outside = makeEl({ x: 1305, y: 310, width: 73, height: 32 });
  const miss = JSON.parse(run(hitCheckExpression('#x'), { el: outside, pointAt: () => null }));
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'outside-viewport');
  assert.equal(miss.inViewportSamples, 0);
  assert.deepEqual(miss.viewport, [1203, 612]);
  assert.match(describeHitMiss(miss), /outside-viewport/u);

  // 场景 B：在视口内，但中心那一行右侧被浮层盖住，左侧与上下仍露出来。
  const covered = makeEl({ x: 1100, y: 300, width: 73, height: 32 });
  const overlay = { tagName: 'SPAN', className: 'hwYSvJpgGi', contains: () => false };
  const pointAt = (x, y) => (Math.abs(y - 316) <= 1 && x > 1120 ? overlay : covered);
  const pass = JSON.parse(run(hitCheckExpression('#x'), { el: covered, pointAt }));
  assert.equal(pass.ok, true, '矩形内有能命中的点，就该判通过');
  assert.equal(pass.centerIsSelf, false, '中心点这次确实是被盖住的');
  assert.ok(pass.firstHit, '要给出退让后的命中点');
  assert.equal(pass.blocker?.tag, 'SPAN', '要报出遮挡物是谁');
  assert.match(describeHitPass(pass), /改用采样点/u);

  // 场景 C：中心点就命中的常规情况 —— 措辞要说明是中心命中，别含糊。
  const plain = makeEl({ x: 1100, y: 300, width: 73, height: 32 });
  const plainPass = JSON.parse(run(hitCheckExpression('#x'), { el: plain, pointAt: () => plain }));
  assert.equal(plainPass.ok, true);
  assert.equal(plainPass.centerIsSelf, true);
  assert.match(describeHitPass(plainPass), /中心点命中/u);

  // 元素不存在 / 零尺寸也要有可读的 reason，不许抛异常。
  const missing = JSON.parse(run(hitCheckExpression('#x'), { el: null, pointAt: () => null }));
  assert.equal(missing.reason, 'element-missing');
  const zero = JSON.parse(run(hitCheckExpression('#x'), { el: makeEl({ x: 1, y: 1, width: 0, height: 0 }), pointAt: () => null }));
  assert.equal(zero.reason, 'not-visible');
  assert.ok(zero.rect, 'not-visible 也要带 rect，不然看不出是「零尺寸」还是别的原因');
  assert.equal(zero.hiddenSiblings, 1, '零尺寸元素本身就是那个「隐藏的匹配」');

  // 场景 D：残留标记 —— 同一个 selector 命中两个元素，文档序第一个是上一轮留下的 0 尺寸元素。
  // 必须挑可见的那个；拿残留去复核就会报 not-visible，而真相是「有个旧标记没清干净」。
  const stale = makeEl({ x: 0, y: 0, width: 0, height: 0 });
  const real = makeEl({ x: 1100, y: 300, width: 73, height: 32 });
  const picked = JSON.parse(run(hitCheckExpression('#x'), { elList: [stale, real], pointAt: () => real }));
  assert.equal(picked.ok, true, '要挑可见的那个，不能拿残留元素判 not-visible');
  assert.equal(picked.matches, 2);

  // 多匹配且全都不可见时，not-visible 要报出「有几个隐藏的同名元素」。
  const allHidden = JSON.parse(run(hitCheckExpression('#x'),
    { elList: [makeEl({ x: 0, y: 0, width: 0, height: 0 }), makeEl({ x: 0, y: 0, width: 0, height: 0 })], pointAt: () => null }));
  assert.equal(allHidden.reason, 'not-visible');
  assert.equal(allHidden.hiddenSiblings, 2, '两个匹配都不可见时要说清有几个');
});

// data- 属性标记 + hash 路由 = 标记会残留。动手前都要先清掉上一轮的标记，
// 否则「同一个 selector 命中两个元素」会一直存在，只是被 hitCheck 的挑可见逻辑兜住。
// 注意 `data-collect-task-download` 的清理在 collect-core 里（2026-09-17 把取件定位整段搬了过去，
// 判据只有一份，脚本侧不再各写一份、也就不会再漂移）。
test('动手前先清掉上一轮的 data- 标记（hash 路由不会重载页面）', () => {
  // 取件定位整段搬进了 collect-core（2026-09-17），所以这一条看的是**生成的表达式**，
  // 而不是源文件字面量 —— 源文件里那个属性名现在只是个常量名。
  const core = () => downloadEntryExpression('营销场景报表_20260917_123456');
  const promo = () => readScript('collect-promotion-report.mjs');
  const shop = () => readScript('collect-shop-report.mjs');
  const cases = [
    ['downloadEntryExpression', 'data-collect-task-download', core],
    ['collect-promotion-report.mjs', 'data-collect-alimama-download', promo],
    ['collect-shop-report.mjs', 'data-collect-preview', shop],
    ['collect-shop-report.mjs', 'data-collect-download', shop],
  ];
  for (const [label, attribute, text] of cases) {
    assert.match(text(), new RegExp(`removeAttribute\\('${attribute}'\\)`, 'u'),
      `${label} 动手前要清掉 ${attribute} 的残留`);
  }
});

test('排练开关 --locate-only：定位全走一遍但绝不点击（顺序也要对）', () => {
  assert.equal(parseCollectArgs(['--date', '2026-09-16', '--locate-only'], { flags: ['--locate-only'] }).locateOnly, true);
  assert.throws(() => parseCollectArgs(['--date', '2026-09-16', '--locate-only']), /unknown argument/u);

  const shop = readScript('collect-shop-report.mjs');
  // 判据用「位置关系」，不用「固定字符窗口」——后者一加注释就撑破，而它撑破时看起来像功能坏了。
  const shopLocateAt = shop.indexOf('args.locateOnly');
  const shopReturnAfterLocate = shop.indexOf('return;', shopLocateAt);
  assert.ok(shopLocateAt > 0, '店铺脚本缺 --locate-only 分支');
  assert.ok(shopReturnAfterLocate > shopLocateAt, '--locate-only 分支里必须提前 return');
  const shopClick = shop.indexOf("clickVerified(args, targetId,\n    { selector: '[data-collect-download=\"1\"]'");
  assert.ok(shopClick > 0, '店铺脚本里找不到下载点击处（判据失效了）');
  assert.ok(shopLocateAt < shopClick, '--locate-only 的返回必须出现在点击之前');

  const promo = readScript('collect-promotion-report.mjs');
  // 按阶段切出函数体再判序：同一段选择器字符串在「复核」和「点击」两处都出现，
  // 直接 indexOf 会命中复核那一处，判出错误的先后（第一版就是这么写废的）。
  const submitBody = promo.slice(promo.indexOf('async function phaseSubmit'), promo.indexOf('async function phaseFetch'));
  const fetchBody = promo.slice(promo.indexOf('async function phaseFetch'));
  for (const [label, body, clickCall] of [
    ['submit', submitBody, `await click(args, targetId, '[data-collect-alimama-download="1"]')`],
    // fetch 段走真实鼠标点击（clickPoint）—— 底部操作栏的「下载」用 JS 的 el.click() 不触发下载（实测）。
    ['fetch', fetchBody, 'clickPoint(args, targetId, point)'],
  ]) {
    const locateAt = body.indexOf('args.locateOnly');
    const clickAt = body.indexOf(clickCall);
    assert.ok(locateAt > 0, `阿里妈妈脚本缺 ${label} 的排练分支`);
    assert.ok(clickAt > 0, `阿里妈妈脚本缺 ${label} 的点击处`);
    assert.ok(locateAt < clickAt, `--locate-only 的返回必须早于 ${label} 的点击`);
  }
  // 两个阶段都得有排练分支（只加一个是「以为排练过了」的经典形态）。
  assert.equal(promo.match(/args\.locateOnly/gu).length >= 2, true, 'submit 与 fetch 都要能排练');
  // 「点了但没反应」这一族：fetch 的下载必须用真实鼠标事件，而且落盘后要核对是目标任务那份。
  assert.equal(/await click\(args, targetId, '\[data-collect-task-download/u.test(promo), false,
    'fetch 的「下载」不许退回 JS 点击 —— 实测它返回 clicked:true 却不触发下载');
  assert.match(promo, /落盘的不是目标任务/u, '下来的若是别的任务必须停下，不许拿去写库');
});

test('采集脚本：失败要给非零退出码并说清原因，端口从登记表取', () => {
  for (const name of ['collect-shop-report.mjs', 'collect-promotion-report.mjs']) {
    const source = readScript(name);
    assert.match(source, /process\.exitCode = 1/u, `${name} 失败时必须给非零退出码`);
    assert.match(source, /采集失败：\$\{error\.message\}/u, `${name} 失败时必须打印一句可读的原因`);
    assert.match(source, /PROJECT_PORTS\.dailyReportProxy/u, `${name} 的代理端口必须来自登记表`);
    // 端口字面量不许出现（登记表是唯一来源；runtime/browser-ports.test.mjs 也在扫这一条）。
    assert.equal(/127\.0\.0\.1:\d{4}/u.test(source), false, `${name} 里出现了写死的端口`);
    assert.match(source, /expected one \w+ page/u, `${name} 必须自己确认页面恰好一个`);
  }
});

// ---------------------------------------------------------------------------
// 「这一屏是哪家店」的身份判据（2026-09-18 加）
// ---------------------------------------------------------------------------
// 这一族测试的由来：用户质问「为什么万象台跟生意参谋不一样，绝对不能串数据」。
// 查清的机制是 —— 阿里妈妈页头只显示**会员名 + 会员ID**（从不显示店铺名），
// 生意参谋页头显示**店铺名 + 主店/子店**；两者本来就可以不同名。
// 而当时两个采集脚本**一次身份都没核对过**，两个产物里只有一个带身份
// （生意参谋 xlsx 有「店铺名称」列；阿里妈妈 CSV 一个店铺字段都没有），
// 所以「取错窗口」在推广那一步是静默的：文件照样落盘、数字照样进飞书。
test('身份表达式在沙箱里真的能跑：店铺名去掉「主店」，会员名不会被时间串顶替', () => {
  const el = (innerText) => ({ innerText });
  const run = (expression, env) => JSON.parse(new Function('document', 'location',
    `return ${expression};`)(env.document, { href: 'https://example.invalid/x' }));

  // 生意参谋：外层容器带前缀 ⇒ 不能选它；页头那一块取「最短的那段」，再去掉尾部主店/子店。
  const sycm = run(sycmShopIdentityExpression(), {
    document: {
      querySelectorAll: () => [
        el('生意参谋 盖文全卫定制 主店 惠商 我的 帮助 退出'), // 不以 主店 结尾 ⇒ 不该入选
        el('盖文全卫定制 主店'),
        el('主店'), // 单独的节点标记 ⇒ 不该入选（前面没有店名）
      ],
    },
  });
  assert.equal(sycm.shopName, '盖文全卫定制');
  assert.equal(sycm.nodeType, '主店');
  assert.deepEqual(sycm.candidates, ['盖文全卫定制 主店']);

  // 读不到时必须是 null，不许编一个名字出来（调用方要用 null 判「身份未知」）。
  const none = run(sycmShopIdentityExpression(), { document: { querySelectorAll: () => [] } });
  assert.equal(none.shopName, null);
  assert.equal(none.nodeType, null);

  // 子店也要认（同一个页面结构，只是节点标记不同）。
  const sub = run(sycmShopIdentityExpression(), { document: { querySelectorAll: () => [el('科塔全卫定制 子店')] } });
  assert.equal(sub.shopName, '科塔全卫定制');
  assert.equal(sub.nodeType, '子店');

  // 阿里妈妈：页面上有 00:00/01:00 这类时间串，只认 `xx:yy` 会把身份读成时间 ⇒
  // 必须「会员名 + ID：数字」连在一起认。
  const alimama = run(alimamaIdentityExpression(), {
    document: {
      body: { innerText: '首页 推广 报表 00:00 01:00 02:00 随心品质定制:阿彦 ID：887360146 投放中' },
    },
  });
  assert.equal(alimama.memberName, '随心品质定制:阿彦');
  assert.equal(alimama.memberId, '887360146');
  // 反向自证：只认 `xx:yy` 的写法会命中时间串 —— 这条断言就是用来钉住「不许退回那种写法」。
  assert.equal(/([\u4e00-\u9fa5A-Za-z0-9_]{2,20}):([\u4e00-\u9fa5A-Za-z0-9_]{1,20})/u
    .exec('首页 00:00 随心品质定制:阿彦')[1], '00', '前置条件变了：时间串不再先于会员名出现');

  const noId = run(alimamaIdentityExpression(), { document: { body: { innerText: '随心品质定制:阿彦' } } });
  assert.equal(noId.memberName, null, '没有 ID 就不算认出了身份（否则可能拿到别处的 xx:yy）');
});

test('身份核对：对不上要停、读不到要停、没给期望值只记录不拦', () => {
  // 没给期望值 ⇒ 不拦（但要把读到的带出来，好让日志里看得出「这是记录、不是核对」）。
  const loose = assertShopIdentity({ expected: null, observed: '盖文全卫定制' });
  assert.equal(loose.checked, false);
  assert.equal(loose.observed, '盖文全卫定制');

  // 给对了 ⇒ 通过。
  const ok = assertShopIdentity({ expected: '盖文全卫定制', observed: '盖文全卫定制 ' });
  assert.equal(ok.checked, true);

  // 给错了 ⇒ 停，且两边名字都要出现在报错里（否则只能回去手工复现）。
  assert.throws(() => assertShopIdentity({ expected: '盖文全卫定制', observed: '科塔全卫定制' }),
    /期望「盖文全卫定制」，页面实际「科塔全卫定制」/u);
  // 「读不到」也停：身份未知就等于没核对过，继续点下载是碰运气。
  assert.throws(() => assertShopIdentity({ expected: '盖文全卫定制', observed: null }), /身份读不到/u);
  assert.throws(() => assertShopIdentity({ expected: '   ', observed: '盖文全卫定制' }), /空白/u);

  // 阿里妈妈侧：会员名与 ID **都要**对（会员名可以改，ID 不会）。
  assert.equal(assertMemberIdentity({ expectedName: '随心品质定制:阿彦', expectedId: '887360146',
    observed: { memberName: '随心品质定制:阿彦', memberId: '887360146' } }).checked, true);
  assert.throws(() => assertMemberIdentity({ expectedName: null, expectedId: '887360146',
    observed: { memberName: '随心品质定制:阿彦', memberId: '2995200080' } }), /会员 ID 对不上/u);
  assert.throws(() => assertMemberIdentity({ expectedName: '盖文旗舰店:阿彦', expectedId: null,
    observed: { memberName: '随心品质定制:阿彦', memberId: '887360146' } }), /阿里妈妈会员名/u);
  assert.throws(() => assertMemberIdentity({ expectedId: 'abc', observed: {} }), /6 位以上数字/u);
  assert.equal(assertMemberIdentity({ observed: { memberName: 'x:y' } }).checked, false);
});

test('两个采集脚本都必须核对身份，而且必须在点下载之前；判据不许写死带哈希的类名', () => {
  const shop = readScript('collect-shop-report.mjs');
  assert.match(shop, /sycmShopIdentityExpression/u, '店铺脚本必须读生意参谋身份');
  assert.match(shop, /assertShopIdentity\(/u, '店铺脚本必须拿读到的身份去比对');
  // 光「调了那个函数」不算接线：期望值必须真的从参数传进去。
  // （这正是最容易出现的假接线：函数调了、期望值恒为 null ⇒ 核对永远不拦，日志里却看着像核过。）
  assert.match(shop, /expected: args\.expectShop/u, '店铺脚本没把 --expect-shop 传给核对函数（等于没核对）');
  assert.match(shop, /observed: identity\.shopName/u, '店铺脚本没把读到的店铺名传给核对函数');
  // 位置关系：身份核对必须早于「点下载报表」—— 点完再核对，文件已经落盘了。
  const identityAt = shop.indexOf('await evalOn(args, targetId, sycmShopIdentityExpression())');
  const downloadClickAt = shop.indexOf('clickVerified(args, targetId,\n    { selector: \'[data-collect-download="1"]\'');
  assert.ok(identityAt > 0, '店铺脚本里找不到身份读取处（判据失效了）');
  assert.ok(downloadClickAt > 0, '店铺脚本里找不到下载点击处（判据失效了）');
  assert.ok(identityAt < downloadClickAt, '身份核对必须早于点击下载，否则拦不住已经落盘的文件');
  // `--locate-only` 排练也要能核（排练的语义是「定位全走一遍」，身份属于定位的一部分）。

  const promo = readScript('collect-promotion-report.mjs');
  assert.match(promo, /alimamaIdentityExpression/u, '阿里妈妈脚本必须读会员身份');
  assert.match(promo, /assertMemberIdentity\(/u, '阿里妈妈脚本必须拿会员名/ID 去比对');
  assert.match(promo, /expectedName: args\.expectMember/u,
    '阿里妈妈脚本没把 --expect-member 传给核对函数（等于没核对）');
  assert.match(promo, /expectedId: args\.expectMemberId/u,
    '阿里妈妈脚本没把 --expect-member-id 传给核对函数（等于没核对）');
  const promoIdentityAt = promo.indexOf('await assertAlimamaIdentity(args, targetId)');
  const phaseDispatchAt = promo.indexOf("if (args.phase === 'submit')");
  assert.ok(promoIdentityAt > 0, '阿里妈妈脚本里找不到身份核对调用处（判据失效了）');
  assert.ok(phaseDispatchAt > 0, '阿里妈妈脚本里找不到阶段分发处（判据失效了）');
  assert.ok(promoIdentityAt < phaseDispatchAt,
    '身份核对必须早于两个阶段的点击 —— 两个阶段都要过这一关');
  // 反面：这一页**不显示店铺名**，所以不许把「店铺名」当成阿里妈妈侧的判据来读。
  const alimamaExpr = alimamaIdentityExpression();
  assert.equal(/主店|旗舰店/u.test(alimamaExpr), false,
    '阿里妈妈页没有店铺名，不许在那里按店铺名取身份');

  // 判据必须按文本形状取，不写死带哈希的类名（实测类名形如
  // `src-opEbase-redux-layouts-Frame-module-title-1n_Ad`，前端一发版就变）。
  for (const expression of [sycmShopIdentityExpression(), alimamaIdentityExpression()]) {
    assert.equal(/ebase-frame|shopTextIcon|module-title/u.test(expression), false,
      '身份判据写死了带哈希的类名，前端发版即失效');
  }
  assert.match(sycmShopIdentityExpression(), /主店\|子店/u, '店铺名的形态必须显式写在判据里');
});

test('身份期望值参数：两个站点各一个名字（不合成一个），写错在解析期就炸', () => {
  const base = ['--date', '2026-09-18'];
  // 默认三件套都是 null ⇒ 不带参数的行为与从前逐字相同（不核对、只记录）。
  const bare = parseCollectArgs(base);
  assert.equal(bare.expectShop, null);
  assert.equal(bare.expectMember, null);
  assert.equal(bare.expectMemberId, null);

  const given = parseCollectArgs([...base, '--expect-shop', '盖文全卫定制',
    '--expect-member', '随心品质定制:阿彦', '--expect-member-id', '887360146']);
  assert.equal(given.expectShop, '盖文全卫定制');
  assert.equal(given.expectMember, '随心品质定制:阿彦');
  assert.equal(given.expectMemberId, '887360146');

  // 写错要在**解析期**炸：等看清了页面、点完下载才炸，坑已经踩了。
  assert.throws(() => parseCollectArgs([...base, '--expect-shop', '   ']), /--expect-shop must not be blank/u);
  assert.throws(() => parseCollectArgs([...base, '--expect-member', '']), /--expect-member must not be blank/u);
  assert.throws(() => parseCollectArgs([...base, '--expect-member-id', '88736']), /6\+ digits/u);
  assert.throws(() => parseCollectArgs([...base, '--expect-member-id', 'abc123456']), /6\+ digits/u);
  assert.throws(() => parseCollectArgs([...base, '--expect-shop']), /requires a value/u);
});
