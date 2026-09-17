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
import { buildEnvironment, dirHasEntries, resolveEvidenceDir, resolveOptionToken } from './daily-report-runtime.mjs';

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
// 两张表关心的字段并集；哪张表有哪个就记哪个，没有的不出现（不做「补 null」，
// 免得读者以为「这个字段读到了但值空」）。
const FIELDS_OF_INTEREST = Object.freeze([
  '统计日期', '日期', '店铺名称', '店铺', '询单量', '同层同行询单量',
]);

function parseArgs(argv) {
  const args = { ...DEFAULTS, screenshots: true, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else if (key === '--shot-suffix') args.shotSuffix = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--skip-screenshots') args.screenshots = false;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.reportDate ?? '')) throw new Error('missing or invalid --date');
  args.outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  if (args.shotSuffix !== undefined && !/^[a-z0-9-]+$/u.test(args.shotSuffix)) {
    throw new Error('--shot-suffix must be lowercase letters/digits/dashes');
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

// 页面模型要等 bitable 初始化完（导航后立刻读会拿到 undefined）。
// 这里**轮询**而不是 sleep 固定秒数 —— 固定 sleep 快一点就落空、慢一点就白等。
async function waitForModel(args, targetId) {
  const deadline = Date.now() + args.timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const ready = await proxyEval(args, targetId,
        'Boolean(window.bitableStore?.modelOperator?.base?.tables)');
      if (ready === true) return true;
      last = ready;
    } catch (error) {
      last = error.message;
    }
    await delay(2000);
  }
  throw new Error(`Feishu bitable model did not become ready within ${args.timeoutMs}ms (last=${JSON.stringify(last)})`);
}

// 导出给测试用：这段表达式是「页面里真的会跑的那份逻辑」，只有在离线时能拼出来、
// 才谈得上验证它确实注入了选项映射（否则测试只能去正则匹配源码，验不到行为）。
export function readTableExpression(table) {
  return `(() => {
    const resolveOptionToken = ${resolveOptionToken.toString()};
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu bitable model is not ready');
    const all = Object.values(base.tables || {}).filter(Boolean);
    const table = all.find(item => item.id === ${JSON.stringify(table.tableId)});
    if (!table) throw new Error('table not loaded: ' + ${JSON.stringify(table.tableId)});

    // 全 base 的 SingleSelect 选项表：optXXXX -> 人读的名字。
    // 页面模型存选项 id，OpenAPI 存名字；不映射就会把 optIYzOzu2 当成店名印进证据里。
    const optionName = Object.create(null);
    const optionAmbiguous = Object.create(null);
    for (const item of all) {
      for (const field of Object.values(item.fields || {})) {
        for (const option of (field?.property?.options || [])) {
          if (!option || !option.id) continue;
          const name = option.name ?? null;
          if (optionName[option.id] === undefined) optionName[option.id] = name;
          else if (optionName[option.id] !== name) optionAmbiguous[option.id] = true;
        }
      }
    }

    const unwrap = (cell) => {
      if (cell === null || cell === undefined) return null;
      const value = (typeof cell === 'object' && 'value' in cell) ? cell.value : cell;
      if (Array.isArray(value)) return value.length ? value[0] : null;
      if (value && typeof value === 'object') return value.text ?? value.name ?? value.value ?? null;
      return value;
    };
    // 选项映射的实现从 daily-report-runtime.mjs 注入（.toString()），不在这里再抄一份：
    // 抄一份就会出现「测过的那份」和「真的在跑的那份」两个版本。
    const describe = (cell) => {
      const token = unwrap(cell);
      return token === null ? null : resolveOptionToken(token, optionName, optionAmbiguous);
    };

    const fieldIds = Object.fromEntries(Object.values(table.fields || {})
      .filter(field => field && field.name).map(field => [field.name, field.id]));
    const rows = Object.entries(table.records || {})
      .filter(([, record]) => record)
      .map(([recordId, record]) => {
        const cells = record.fields || record;
        const values = {};
        for (const name of ${JSON.stringify(FIELDS_OF_INTEREST)}) {
          const id = fieldIds[name];
          if (!id) continue;
          const described = describe(cells[id]);
          if (described) values[name] = described;
        }
        // 日期列在页面模型里是 epoch 毫秒；转成日期字符串要显式按 Asia/Shanghai 算，
        // 否则凌晨那几个小时会被读成前一天（本项目坑 42）。
        const dateCell = values['统计日期'] ?? values['日期'] ?? null;
        const ms = dateCell ? Number(dateCell.value) : NaN;
        const date = Number.isFinite(ms)
          ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
        if (date) values.reportDate = { value: ms, display: date, resolvedBy: 'epoch+08:00' };
        return { recordId, values };
      });

    return JSON.stringify({
      tableId: table.id, tableName: table.name,
      recordsNumFromPageModel: table.recordsNum ?? null,
      loadedRows: rows.length,
      rows,
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

async function navigate(args, target, url) {
  const response = await fetch(`${args.proxy}/navigate?target=${encodeURIComponent(target.targetId)}`
    + `&url=${encodeURIComponent(url)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `navigate failed: HTTP ${response.status}`);
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = path.join(REPO_ROOT, 'evidence', `daily-report-${args.reportDate}`);
  // 回读是**同一次运行的最后一步**：并入当前最新一代，而不是另开一代。
  const resolved = resolveEvidenceDir({ baseDir, explicit: args.outputDir, isOccupied: dirHasEntries, policy: 'latest' });
  args.outputDir = resolved.dir;
  mkdirSync(args.outputDir, { recursive: true });

  const page = await discoverFeishuPage(args);
  const origin = new URL(page.url).origin;
  const tableUrl = (table) => `${origin}/base/${args.appToken}?table=${table.tableId}`
    + (table.viewId ? `&view=${table.viewId}` : '');

  // 先落到第一张表上：导航本身就是一次「重新加载」，顺手解决页面上 recordsNum 的陈旧问题
  //（老标签页里的 table.recordsNum 是打开那一刻的值，实测比新开页少/多过）。
  await navigate(args, page, tableUrl(SOURCE_TABLE));
  await waitForModel(args, page.targetId);

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
    page: { targetId: page.targetId, url: page.url, reloadedTo: tableUrl(SOURCE_TABLE) },
    tables: {},
    screenshots: {},
  };

  for (const table of [SOURCE_TABLE, INQUIRY_TABLE]) {
    const raw = await proxyEval(args, page.targetId, readTableExpression(table));
    const parsed = JSON.parse(raw);
    const onDate = parsed.rows.filter(row => row.values.reportDate?.display === args.reportDate);
    result.tables[table.key] = {
      table: table.label, ...parsed,
      onDateCount: onDate.length,
      onDateRows: onDate,
    };
  }

  if (args.screenshots) {
    for (const table of [SOURCE_TABLE, INQUIRY_TABLE]) {
      if (table.key !== SOURCE_TABLE.key) {
        await navigate(args, page, tableUrl(table));
        await waitForModel(args, page.targetId);
      }
      await fetch(`${args.proxy}/bringToFront?target=${encodeURIComponent(page.targetId)}`).catch(() => {});
      await delay(1500);
      const file = path.join(args.outputDir,
        `feishu-${table.key}-table-after-${args.shotSuffix ?? table.shotSuffix}.png`);
      result.screenshots[table.key] = await screenshot(args, page.targetId, file);
    }
  }

  const readbackPath = path.join(args.outputDir, 'independent-readback.json');
  writeFileSync(readbackPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const show = (entry) => `${entry.table}: recordsNum=${entry.recordsNumFromPageModel}`
    + `（页面模型值，可能落后于服务端） loaded=${entry.loadedRows} 命中 ${args.reportDate}=${entry.onDateCount}`;
  console.log(`readbackPath = ${readbackPath}`);
  console.log(show(result.tables.source));
  console.log(show(result.tables.inquiry));
  for (const row of result.tables.inquiry.onDateRows) {
    const v = (name) => row.values[name]?.display ?? '—';
    console.log(`  ${v('reportDate')} | ${v('店铺')} | ${row.recordId} | 询单量=${v('询单量')} | 同层同行=${v('同层同行询单量')}`);
  }
  for (const [key, file] of Object.entries(result.screenshots)) console.log(`  screenshot(${key}) → ${file}`);
}

// 只有被直接当命令跑时才执行 main；被 import（离线测试拼表达式）时不许产生副作用。
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
