#!/usr/bin/env node
//
// 独立回读：**不走 runner 的校验路径**，直接读飞书页面的 bitable 模型，再截两张图。
//
// 为什么要有这个独立路径（2026-09-16 复盘）：runner 的断言读的是它自己刚写进去的东西，
// 「写入方自证」这件事本身没法排除「写入方和读者的口径一起错了」。这里换一条完全不同的
// 通路（CDP → 页面内存模型）去读同一个事实，两张图存证，收据里那两个数字才有旁证。
//
// 为什么从临时脚本收编进仓库（2026-09-17）：它原先住在 %Temp% 下，按日期写死端口、
// 每次重录都要重写一遍，而且**把飞书页面模型里的 SingleSelect 选项 id 当成了店名**
// —— 回读结果里「店铺」那一列印的是 optIYzOzu2 这种 id，读证据的人得自己去猜是哪家店。
// 页面模型存的是选项 id，OpenAPI 存的是名字（两套表示）：所以这里必须显式做一次映射，
// 映射不出来就如实标出来，不许把 id 冒充成名字。
//
// 用的是日报链的商家号代理（端口从 runtime/browser-ports.mjs 取，唯一来源）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets } from '../../../runtime/feishu-targets.mjs';
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import { assertEvidenceShopKey } from './shop-identities.mjs';
// resolveFieldValue / classifyFieldCoverage 不在这里直接用：它们是以**源码**形式注入到页面里跑的，
// 取源码这件事本身收在 injectedHelpersSource() 里（顺带把依赖的常量一起带上）。
import {
  buildEnvironment, dirHasEntries, evidenceBaseDir, injectedHelpersSource, resolveEvidenceDir,
} from './daily-report-runtime.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');

const DEFAULTS = Object.freeze({
  proxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
  appToken: TARGET.baseToken,
});
const SOURCE_TABLE = Object.freeze({ key: 'source', tableId: TARGET.sourceTable, viewId: TARGET.sourceView,
  label: '底单', shotSuffix: 'push' });
const INQUIRY_TABLE = Object.freeze({ key: 'inquiry', tableId: TARGET.inquiryTable, viewId: null,
  label: '询单表', shotSuffix: 'backfill' });
// 店铺 id -> 店名的**权威表**：询单表那张「店铺」字段。派生/Lookup 字段（底单的「店铺」）
// 自身没有选项表，它的值是从别处取来的 id，得有个指定的地方去查 —— 不指定就只能全 base 扫，
// 而全 base 扫会被月度表里那份被截短的名字（「盖文」vs「盖文淘宝」）判成歧义。
const CANONICAL_SHOP_TABLE_ID = TARGET.inquiryTable;
const CANONICAL_SHOP_FIELD = '店铺';
// 两张表关心的字段并集；哪张表有哪个就记哪个，没有的不出现（不做「补 null」，
// 免得读者以为「这个字段读到了但值空」）。
//
// **但「没有」有两种，必须分开**（2026-09-17 修的正是这个缺口）：这张表没有这个字段（正常），
// 还是要了这个字段却读不到（要显式记下来）。后者原先被同一个 `continue` 吞掉，
// 产物里看起来和前者一模一样 —— 实测底单的「店铺」是 Lookup(type 19)，
// `record.fields` 里连键都没有。现在交给 classifyFieldCoverage 分三类写清楚。
const FIELDS_OF_INTEREST = Object.freeze([
  '统计日期', '日期', '店铺名称', '店铺', '询单量', '同层同行询单量',
]);
// 派生「店铺」读不到时，同表里哪个字段是它的可读替身（实测底单有「店铺名称」= 盖文旗舰店）。
// 只作提示用：这些名字该表没有就自动不出现。
const READABLE_FALLBACKS = Object.freeze(['店铺名称']);

function parseArgs(argv) {
  const args = { ...DEFAULTS, screenshots: true, timeoutMs: 30000, rowsTimeoutMs: 24000, shopKey: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else if (key === '--shot-suffix') args.shotSuffix = argv[++index];
    else if (key === '--leave-on') args.leaveOn = argv[++index];
    // 证据目录的店铺维度（运营叫法）。**不给时行为逐字不变**；
    // 多店铺串行回读时必须给同一个值，否则它会并入另一家店的那一代目录里。
    else if (key === '--shop-key') args.shopKey = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--skip-screenshots') args.screenshots = false;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.reportDate ?? '')) throw new Error('missing or invalid --date');
  args.outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  if (args.shotSuffix !== undefined && !/^[a-z0-9-]+$/u.test(args.shotSuffix)) {
    throw new Error('--shot-suffix must be lowercase letters/digits/dashes');
  }
  if (args.leaveOn !== undefined && !['source', 'inquiry'].includes(args.leaveOn)) {
    throw new Error('--leave-on must be source or inquiry');
  }
  return args;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function proxyEval(args, targetId, expression) {
  const response = await fetch(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST', body: expression,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `eval failed: HTTP ${response.status}`);
  return payload.value;
}

async function discoverFeishuPage(args) {
  const targets = await fetch(`${args.proxy}/targets`).then(response => response.json());
  const matches = targets.filter(target => target.type === 'page' && target.url.includes(`/base/${args.appToken}`));
  if (matches.length !== 1) throw new Error(`expected one Feishu page for target base, got ${matches.length}`);
  return matches[0];
}

// 页面模型要等 bitable 初始化完。判据必须落在**目标表**上，不能只等 `base.tables` 存在：
// 2026-09-17 实测，导航后 `base.tables` 已经是个真对象，可里面还没有那张表的键 ——
// 这时去读会炸 `table not loaded: tbl84...`（是竞态，同一脚本有时过有时不过，最坏的一种）。
// 这里**轮询**等目标表出现，不用固定 sleep：固定 sleep 快一点就落空、慢一点就白等。
async function waitForModel(args, targetId, tableId) {
  const deadline = Date.now() + args.timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const ready = await proxyEval(args, targetId,
        `(() => {
          const base = window.bitableStore?.modelOperator?.base;
          if (!base) return false;
          return Object.values(base.tables || {}).some(item => item && item.id === ${JSON.stringify(tableId)});
        })()`);
      if (ready === true) return true;
      last = ready;
    } catch (error) {
      last = error.message;
    }
    await delay(2000);
  }
  throw new Error(`Feishu table ${tableId} did not load within ${args.timeoutMs}ms (last=${JSON.stringify(last)})`);
}

// 只数行数，用来判断「这张表的记录集齐了没有」——比整表读一遍便宜得多。
function rowCountExpression(tableId) {
  return `(() => {
    const base = window.bitableStore?.modelOperator?.base;
    const table = Object.values(base?.tables || {}).find(item => item && item.id === ${JSON.stringify(tableId)});
    if (!table) return JSON.stringify({ recordsNum: null, loaded: 0 });
    return JSON.stringify({
      recordsNum: table.recordsNum ?? null,
      loaded: Object.values(table.records || {}).filter(Boolean).length,
    });
  })()`;
}

// 记录集**齐了没有**，是这份证据能不能当结论用的前提。
//
// 2026-09-17 实测：`recordsNum` 报 2197，可 `records` 里只有 200 条 —— 页面是按需物化的，
// 没物化到的那部分在模型里根本不存在。此时「当天命中 0 条」有两种可能：真的没有，
// 或者**目标行还没被物化**。两者不能混为一谈，所以先**有界地等**行集齐；
// 等不齐就如实标 incomplete，让人知道这个计数是下界而不是结论。
async function waitForRows(args, targetId, tableId) {
  const deadline = Date.now() + args.rowsTimeoutMs;
  let last = { recordsNum: null, loaded: 0 };
  while (Date.now() < deadline) {
    last = JSON.parse(await proxyEval(args, targetId, rowCountExpression(tableId)));
    if (last.recordsNum !== null && last.loaded >= last.recordsNum) return { ...last, complete: true };
    await delay(2000);
  }
  return { ...last, complete: false };
}

// 导出给测试用：这段表达式是「页面里真的会跑的那份逻辑」，只有在离线时能拼出来、
// 才谈得上验证它确实注入了选项映射（否则测试只能去正则匹配源码，验不到行为）。
// `reportDate` 可选：给了就把「哪些字段没读到」的统计口径收到**目标日那几行**，
// 没给就按全表报（口径写在产物的 fieldsCoverageScope 里，不许含糊）。
export function readTableExpression(table, options = {}) {
  const reportDate = options.reportDate ?? null;
  return `(() => {
    ${injectedHelpersSource()}
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu bitable model is not ready');
    const all = Object.values(base.tables || {}).filter(Boolean);
    const table = all.find(item => item.id === ${JSON.stringify(table.tableId)});
    if (!table) throw new Error('table not loaded: ' + ${JSON.stringify(table.tableId)});

    const optionsOf = (field) => {
      const map = Object.create(null);
      for (const option of (field?.property?.options || [])) {
        if (option && option.id) map[option.id] = option.name ?? null;
      }
      return map;
    };

    // 全 base 的选项扫描：**只作最后一层兜底**，并且记住哪些 id 名不同名（那才是真歧义）。
    const globalMap = Object.create(null);
    const globalAmbiguous = Object.create(null);
    for (const item of all) {
      for (const field of Object.values(item.fields || {})) {
        for (const option of (field?.property?.options || [])) {
          if (!option || !option.id) continue;
          const name = option.name ?? null;
          if (globalMap[option.id] === undefined) globalMap[option.id] = name;
          else if (globalMap[option.id] !== name) globalAmbiguous[option.id] = true;
        }
      }
    }

    const canonicalField = Object.values(
      all.find(item => item.id === ${JSON.stringify(CANONICAL_SHOP_TABLE_ID)})?.fields || {},
    ).find(field => field && field.name === ${JSON.stringify(CANONICAL_SHOP_FIELD)});
    const canonicalShop = optionsOf(canonicalField);

    const fieldMeta = Object.fromEntries(Object.values(table.fields || {})
      .filter(field => field && field.name).map(field => [field.name, { id: field.id, type: field.type }]));
    const ownOptions = Object.create(null);
    for (const field of Object.values(table.fields || {})) {
      if (!field || !field.id) continue;
      const map = optionsOf(field);
      if (Object.keys(map).length) ownOptions[field.id] = map;
    }

    // 分层顺序见 daily-report-runtime.mjs 的 resolveFieldValue：字段自己的选项 → 权威店铺表 → 全 base。
    // 分层的必要性是实测出来的：只做最后一层会把 12 家店里的 5 家判成歧义、退回原始 id。
    const unwrap = (cell) => {
      if (cell === null || cell === undefined) return null;
      const value = (typeof cell === 'object' && 'value' in cell) ? cell.value : cell;
      if (Array.isArray(value)) return value.length ? value[0] : null;
      if (value && typeof value === 'object') return value.text ?? value.name ?? value.value ?? null;
      return value;
    };

    const describe = (cell, field) => resolveFieldValue(unwrap(cell), {
      type: field.type,
      optionLayers: [
        { map: ownOptions[field.id] || {}, source: 'field-option-id' },
        { map: canonicalShop, source: 'canonical-shop-option-id' },
        { map: globalMap, source: 'global-option-id', ambiguous: globalAmbiguous },
      ],
    });

    const rows = Object.entries(table.records || {})
      .filter(([, record]) => record)
      .map(([recordId, record]) => {
        const cells = record.fields || record;
        const values = {};
        for (const name of ${JSON.stringify(FIELDS_OF_INTEREST)}) {
          const field = fieldMeta[name];
          if (!field) continue;
          const described = describe(cells[field.id], field);
          if (described) values[name] = described;
        }
        // reportDate 是给调用方做「当天命中几条」过滤用的便利键：取日期字段自己的 display。
        const dateName = ['统计日期', '日期'].find(name => values[name]);
        if (dateName) values.reportDate = values[dateName];
        return { recordId, values };
      });

    // 「哪些字段该有值却没读到」——见 daily-report-runtime.mjs 的 classifyFieldCoverage。
    // 派生字段（底单的「店铺」是 Lookup）在 record.fields 里连键都没有，这不是值空，
    // 必须如实写出来，否则这一列会静默消失、被读成「当天没写进去」。
    //
    // 口径：给了 reportDate 就只统计**目标日那几行**（那才是要交付的口径；整张表里绝大多数
    // 行是别的日期，它们没有值本来就不算问题），当天一行都没有时退回全表并如实标出 scope。
    const sampleRecord = (Object.values(table.records || {}).filter(Boolean)[0] || {});
    const reportDate = ${JSON.stringify(reportDate)};
    const scopedRows = reportDate
      ? rows.filter(row => row.values.reportDate?.display === reportDate)
      : rows;
    const coverage = classifyFieldCoverage({
      rows: scopedRows.length ? scopedRows : rows,
      scope: scopedRows.length ? \`reportDate=\${reportDate}\` : (reportDate ? \`entire-table (当天没有命中行)\` : null),
      fieldMeta,
      sampleKeys: Object.keys(sampleRecord.fields || sampleRecord),
      fieldsOfInterest: ${JSON.stringify(FIELDS_OF_INTEREST)},
      readableFallback: ${JSON.stringify(READABLE_FALLBACKS)}.filter(name => Object.hasOwn(fieldMeta, name)),
    });

    return JSON.stringify({
      tableId: table.id, tableName: table.name,
      recordsNumFromPageModel: table.recordsNum ?? null,
      loadedRows: rows.length,
      rows,
      ...coverage,
    });
  })()`;
}

async function screenshot(args, targetId, file) {
  const response = await fetch(`${args.proxy}/screenshot?target=${encodeURIComponent(targetId)}`
    + `&file=${encodeURIComponent(file)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `screenshot failed: HTTP ${response.status}`);
  return payload.saved;
}

/**
 * 取一张截图，**失败不抛**：返回 `{ ok, saved | error }`。
 *
 * 为什么必须这样（2026-09-20 实测，两次复现）：源表那一页正文 59 万字符时，
 * `Page.captureScreenshot` 稳定超过代理里 `sendCDP` 的 30 秒固定超时（代理解析成
 * `HTTP 500 / CDP 命令超时: Page.captureScreenshot`）。而实测同一时刻这一页
 * `visibilityState=visible`、`hasFocus=true`、视口 1528×732 ⇒ **不是「页面不可见」**，
 * 是这张页面截图本身就慢。
 *
 * 原先截图抛错会穿透整个 main ⇒ 两张表的**独立回读也一起丢掉**（`independent-readback.json`
 * 写在 try 之后，根本不会落盘）。一次佐证失败毁掉主证据，是这一条链上最贵的一种失败：
 * 主证据（两张表的回读）当时明明已经读到手了。
 *
 * 所以这里把它降级成**可记录的降级项**：产物里如实写 `screenshots[key]=null` 与
 * `screenshotErrors`，stderr 大声报出来，最后由调用方决定退出码 —— 缺证据要说出来，
 * 但不能用它顶掉数据结论。
 */
export async function captureScreenshotSafe({
  args, targetId, file, shot = screenshot, warn = console.error,
} = {}) {
  try {
    return { ok: true, saved: await shot(args, targetId, file) };
  } catch (error) {
    const message = String(error?.message ?? error);
    warn(`[screenshot] 截图失败：${message}`
      + '（数据回读不受影响，照常继续；产物里 screenshots 那一项会写成 null）');
    return { ok: false, error: message, file };
  }
}

async function navigate(args, target, url) {
  const response = await fetch(`${args.proxy}/navigate?target=${encodeURIComponent(target.targetId)}`
    + `&url=${encodeURIComponent(url)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `navigate failed: HTTP ${response.status}`);
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 回读**没有源产物可核**（它读的是飞书页面模型），所以只做能做的那一半：
  // 键必须是**已登记**的运营叫法，不许拿页头店名/随便一个字符串当目录后缀。
  // 放在 mkdir 之前，这样「贴错标签的目录」根本不会被建出来。
  if (args.shopKey) assertEvidenceShopKey(args.shopKey);
  const baseDir = evidenceBaseDir({ evidenceRoot: path.join(REPO_ROOT, 'evidence'),
    reportDate: args.reportDate, shopKey: args.shopKey });
  // 回读是**同一次运行的最后一步**：并入当前最新一代，而不是另开一代。
  const resolved = resolveEvidenceDir({ baseDir, explicit: args.outputDir, isOccupied: dirHasEntries, policy: 'latest' });
  args.outputDir = resolved.dir;
  mkdirSync(args.outputDir, { recursive: true });

  const page = await discoverFeishuPage(args);
  const origin = new URL(page.url).origin;
  const tableUrl = (table) => `${origin}/base/${args.appToken}?table=${table.tableId}`
    + (table.viewId ? `&view=${table.viewId}` : '');

  const result = {
    at: new Date().toISOString(),
    reportDate: args.reportDate,
    environment: buildEnvironment({
      proxyUrl: args.proxy,
      ports: { browser: PROJECT_PORTS.dailyReportBrowser, proxy: PROJECT_PORTS.dailyReportProxy },
      identities: { id: BROWSER_IDS.dailyReport, label: BROWSER_LABELS.dailyReport },
    }),
    evidence: { outputDir: args.outputDir, generation: resolved.generation, reason: resolved.reason },
    path: 'CDP → 页面 bitable 内存模型（不经过 runner 的断言，也不经过飞书 OpenAPI）',
    proxy: args.proxy,
    page: { targetId: page.targetId, url: page.url, leftOn: null, navigations: [] },
    tables: {},
    screenshots: {},
  };

  // 截图失败**只降级、不中断**：收集起来，记进产物，最后如实说清楚（见 captureScreenshotSafe）。
  const screenshotFailures = [];

  // 读两张表。**这一段包在 try/finally 里**（2026-09-20）：收尾的归位必须无论成败都发生。
  // 原先归位写在成功路径末尾，readback 一失败（实测：网林等询单表超时）就不执行 ——
  // 页面停在询单表上留给**下一家店**，而报错挂在下一家身上、措辞与真因无关。
  //
  // 这是兜底，不是主修。主修是让**用这一页的步骤自己落位**（run-daily-report.mjs 的
  // ensureTargetPage）：有它之后，这一页停在哪儿不再由「上一步有没有正常收尾」决定。
  // 兜底的意义只是「出错那一轮也别把状态留在外面」。
  //
  // 读每一张表之前都**先导航到那张表**，不在一张表的页面上顺手读另一张。
  // 2026-09-17 的教训：老标签页里的记录集是打开那一刻的快照，跨表读到的记录数会与
  // 真实值差一截（实测同一张表两个页面报过 12 之差）；导航本身即一次重新加载，
  // 顺手把这个问题消掉，也不用再开第二个页签。
  try {
    for (const table of [SOURCE_TABLE, INQUIRY_TABLE]) {
      const url = tableUrl(table);
      await navigate(args, page, url);
      result.page.navigations.push(url);
      await waitForModel(args, page.targetId, table.tableId);
      const rowState = await waitForRows(args, page.targetId, table.tableId);
      const raw = await proxyEval(args, page.targetId, readTableExpression(table, { reportDate: args.reportDate }));
      const parsed = JSON.parse(raw);
      const onDate = parsed.rows.filter(row => row.values.reportDate?.display === args.reportDate);
      result.tables[table.key] = {
        table: table.label, ...parsed,
        rowsComplete: rowState.complete,
        // 行集不齐时，命中数只是**下界**，不许当成结论。
        onDateCountIsLowerBound: !rowState.complete,
        onDateCount: onDate.length,
        onDateRows: onDate,
        ...(rowState.complete ? {} : {
          caveat: `页面只物化了 ${rowState.loaded} / ${rowState.recordsNum ?? '?'} 条记录，`
            + `未物化的部分在模型里不存在 ⇒ onDateCount=${onDate.length} 是下界，不能据此断言「当天没有」；`
            + '权威判据仍以写入链的 API 路径（selectDailyStoreRecord）为准。',
        }),
      };
      if (args.screenshots) {
        await fetch(`${args.proxy}/bringToFront?target=${encodeURIComponent(page.targetId)}`).catch(() => {});
        await delay(1500);
        const file = path.join(args.outputDir,
          `feishu-${table.key}-table-after-${args.shotSuffix ?? table.shotSuffix}.png`);
        const shot = await captureScreenshotSafe({ args, targetId: page.targetId, file });
        result.screenshots[table.key] = shot.ok ? shot.saved : null;
        if (!shot.ok) {
          screenshotFailures.push({ table: table.key, label: table.label, file, error: shot.error });
        }
      }
    }
  } finally {
    // 收尾把页面留在**底单**上：底单是这条链的默认工作面，runner 也要求飞书页停在
    // `table=<底单>&view=<视图>`。回读是运行的最后一步，别把一个「页面停在别处」的状态
    // 留给下一个人（2026-09-17 实测踩过：回读把页留在询单表，紧接着的重跑被
    // `expected one Feishu page for target base` 拦下）。
    //
    // 抛错路径上这里**必须吞掉自己的错误**：原始异常（比如询单表没等到）才是要报出来的那个，
    // 归位失败只影响下一个使用者，不该把真正的失败原因顶掉 —— 顶掉之后，
    // 「为什么这家没读成」就再也看不到了，而这正是前面那一轮最花时间的地方。
    const stayOn = args.leaveOn ?? SOURCE_TABLE.key;
    const leaveTable = stayOn === INQUIRY_TABLE.key ? INQUIRY_TABLE : SOURCE_TABLE;
    try {
      await navigate(args, page, tableUrl(leaveTable));
      await waitForModel(args, page.targetId, leaveTable.tableId);
      result.page.leftOn = tableUrl(leaveTable);
    } catch (error) {
      console.error(`[leaveOn] 归位失败：${error.message}`);
      console.error(`[leaveOn] 期望停在 ${tableUrl(leaveTable)}，但现在这一页停在哪张表上不确定；`
        + '下一次用它的步骤（push 的 ensureTargetPage）会自己落位回源表，不影响下一家的正确性');
    }
  }

  if (screenshotFailures.length) result.screenshotErrors = screenshotFailures;
  const readbackPath = path.join(args.outputDir, 'independent-readback.json');
  writeFileSync(readbackPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const show = (entry) => `${entry.table}: recordsNum=${entry.recordsNumFromPageModel}`
    + `（这是**页面模型**里的值，可能落后于服务端） loaded=${entry.loadedRows} 命中 ${args.reportDate}=${entry.onDateCount}`
    + (entry.rowsComplete ? '' : `  ⚠️ 行集未齐（只物化 ${entry.loadedRows}/${entry.recordsNumFromPageModel}）⇒ 命中数是下界，不能据此断言「当天没有」`);
  console.log(`readbackPath = ${readbackPath}`);
  console.log(show(result.tables.source));
  console.log(show(result.tables.inquiry));
  // 「读不到的字段」必须打印出来：它原先和「这个字段不属于这张表」长得一样，
  // 于是「派生字段读不到」会被读成「那格本来就是空的」。
  for (const entry of [result.tables.source, result.tables.inquiry]) {
    for (const field of entry.absentFields ?? []) {
      console.log(`  ⚠️ ${entry.table}「${field.name}」${field.rowsWithoutValue}/${field.rowsObserved} 行没有值`
        + `（口径 ${field.scope ?? '全表'}）`
        + ` — ${field.reason}${field.note ? `｜${field.note}` : ''}`);
    }
  }
  for (const row of result.tables.inquiry.onDateRows) {
    const v = (name) => row.values[name]?.display ?? '—';
    console.log(`  ${v('reportDate')} | ${v('店铺')} | ${row.recordId} | 询单量=${v('询单量')} | 同层同行=${v('同层同行询单量')}`);
  }
  for (const [key, file] of Object.entries(result.screenshots)) {
    console.log(file === null
      ? `  screenshot(${key}) → 缺失（见上面 [screenshot] 警告；数据回读不受影响）`
      : `  screenshot(${key}) → ${file}`);
  }
  // 归位失败时这里**必须说实话**：那一行上面已经打了 [leaveOn] 警告，但读的人也可能
  // 只看最后一行 —— 此时产物里 `page.leftOn` 是 null，别打印成「已留在 null」。
  console.log(result.page.leftOn
    ? `页面已留在：${result.page.leftOn}`
    : '页面**没有**归位：这一页现在停在哪张表上不确定（见上面的 [leaveOn] 警告）；'
      + '下一次用它的步骤会自己落位回源表');

  // 缺证据要说出来，但不许把它说成「数据没核对」。两句话必须分开写：
  // 数据的结论已经落盘了（上面那行 readbackPath），这里只报「佐证不完整」。
  // 退出码仍非零 —— 否则 stage 会报成功，而产物里明明缺了两张图。
  if (screenshotFailures.length) {
    console.error(`\n[不完整] 数据回读已核对并落盘：${readbackPath}`);
    console.error(`[不完整] 但有 ${screenshotFailures.length} 张截图没取到：`
      + screenshotFailures.map((item) => `${item.label}（${item.error}）`).join('；'));
    console.error('[不完整] 截图是佐证不是判据，缺它不影响上面的数据结论；本阶段仍按失败退出，'
      + '好让人知道这一轮的证据不完整。');
    process.exitCode = 1;
  }
}

// 只有被直接当命令跑时才执行 main；被 import（离线测试拼表达式）时不许产生副作用。
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
