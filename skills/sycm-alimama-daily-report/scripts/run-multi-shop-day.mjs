#!/usr/bin/env node
//
// 按店铺循环跑一天的日报链 —— 「多店铺一轮」的那层驱动。
//
// 为什么需要它（2026-09-18 一轮多店铺实测的结论）：单店那十个步骤早就脚本化了，
// 但把它们串起来靠的是人手 —— **每家店一份口头顺序**，而顺序里有三处错一步就静默变形的地方：
//   · 落位要做两次（采集把生意参谋那个页签留在报表预览页 ⇒ 回填前必须回位 + 重跑 date-picker --site sycm）；
//   · 三个写入方的 `--shop-key` 必须同值（不同值 = 回填并进另一家店那一代证据目录）；
//   · 推送段的 `--shop-xlsx` / `--promotion-zip` 是**必填**，而这两个路径只有采集段知道
//     ⇒ 采集与推送必须在同一轮里，中间不能换人接手（换手就成手填路径 = 「默认值即目标」的形态）。
// 手抄顺序时这三条都不显眼，而它们的失败分别是「0 行」「目录贴错标签」「missing required argument」。
// 所以驱动存在的意义不是省几条命令，而是**把顺序与一致性变成代码**，让它只有一种走法。
//
// 三种模式（默认最保守的那一种）：
//   默认（排练）          落位 + 采集 + 干跑，**一个字节都不写飞书**。真跑前的自检用。
//   --verify-existing N  推送段走只读核对（`--verify-existing --expected-before-count N`）：
//                        核对「目标日那一天那一行还在、字段还对」，不新增不覆盖。
//   --commit             真写（推送 + 回填都加 `--commit`）。**目标日已被写过会硬重复停止**，先按 SOP §9.3 删那天。
//
// 每台店各走一遍的十个阶段（顺序即 SOP §10.1；第 7/8 步的顺序是实测结论，不是偏好）：
//   1 alimama-date   2 promotion-submit   3 sycm-date       4 shop-report   5 promotion-fetch
//   6 push           7 sycm-reset         8 sycm-date-again 9 backfill      10 readback
//
// 为什么 7/8 必须分开：第 4 步点开「日报」预览会把生意参谋那个页签导到
// `lyone/auto_analysis/datafetch/report_generation`，而回填只认 `qos/.../shop/performance` ⇒
// 先回位、再重跑一次落位（重新导航会把页签与日期一起重置）。漏做第 8 步的症状是
// `expected one 当日询单人数 table, got 0`。
//
// 一条链跨两个浏览器（这是本文件里唯一「不同阶段用不同代理」的原因）：
//   采集段与询单读取跑在**这家店自己的**代理（19041~19044）——采集脚本只认代理，裸 CDP 端口连不上；
//   推送段与回读段跑在**商家浏览器**的代理（19023）——它们要读飞书 base 页，而那页只在那一个浏览器里。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS, ROUTES, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { dailyReportTargets } from '../../../runtime/feishu-targets.mjs';
import { createPlatformHealthCheck } from '../../../runtime/xws-platform-health-preflight.mjs';
import { siteAdapter } from './date-picker.mjs';
import { describeIdentity, expectArgs, formatArgv, shopIdentity } from './shop-identities.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const NODE = process.execPath;
const SITE_SYCM_ENTRY = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const SYCM_FRAGMENT = 'sycm.taobao.com/qos/service/frame/shop/performance';

// 三种模式是**闭集**。为什么要显式列出并校验：push 那一支是靠 `mode === 'commit'` /
// `mode === 'verify'` 两个分支决定加不加参数的，传进来一个别的值（比如 'dry' 这种想当然的写法）
// 会既不加 `--commit` 也不加 `--verify-existing` —— 静默变成排练，而调用方以为自己开了提交。
export const MODES = Object.freeze(['rehearse', 'verify', 'commit']);

// 阶段名是**闭集**，而且 `--only` 的实现是「不点名就跳过」—— 所以拼错一个名字不会报错，
// 只会把十个阶段全部跳过：整轮「跑完」、退出码 0、一步没做。这正是本项目反复出现的
// 「静默落空」形态，因此在解析期就把它钉死。常量与 buildShopStages 的真实产出由函数内
// 一条断言互锁（两处漂移会当场抛错，而不是让 `--only` 的合法值清单慢慢腐化）。
export const STAGE_NAMES = Object.freeze([
  'health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report', 'promotion-fetch',
  'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback',
]);

// 体检要「恰好各一个」的页面。**片段取自唯一权威**（date-picker 的 SITES、飞书目标登记表），
// 不在这里另抄一份 —— 抄一份就是等着它和落位判据漂移（坑 37）。
//
// 为什么不用体检模块的 `--route=dailyReport`：那是**宿主级**片段（`sycm.taobao.com`），
// 而店家浏览器上天然有两个 sycm 页面（门户首页 + 工作页）⇒ 必然报「不唯一」；
// 且多店铺下阿里妈妈页在**各店自己的**浏览器上，商家浏览器根本没有它 ⇒ 必然报「不在」。
// 2026-09-18 晚实测：`--route=dailyReport` 对 19023 报 2 项 blocking，两条都是判据与现场不匹配
// （假红）。假红比不检查更坏：它训练人去忽略这个信号。
export function expectedPagesForShop() {
  return [
    { name: '生意参谋工作页', urlFragment: siteAdapter('sycm').urlFragment },
    { name: '阿里妈妈报表页', urlFragment: siteAdapter('alimama').urlFragment },
  ];
}

export function expectedPagesForDailyBrowser() {
  return [
    { name: '生意参谋工作页', urlFragment: siteAdapter('sycm').urlFragment },
    { name: '飞书底单页', urlFragment: `feishu.cn/base/${dailyReportTargets().baseToken}` },
  ];
}

export const parseArgs = (argv) => {
  const args = { date: null, shops: null, commit: false, verifyExisting: null, keepGoing: false,
    only: null, logs: null, downloads: null, shopXlsx: null, promotionZip: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') args.date = argv[++i];
    else if (key === '--shops') args.shops = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--commit') args.commit = true;
    else if (key === '--verify-existing') args.verifyExisting = Number(argv[++i]);
    else if (key === '--keep-going') args.keepGoing = true;
    else if (key === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--logs') args.logs = argv[++i];
    else if (key === '--downloads') args.downloads = argv[++i];
    // 只给「采集已经跑完、要单独重跑推送段」用（那一轮的产物路径不可能再问采集要）。
    // 这两种情况下必须两种都给/都不给 —— 只给一种是「一半手填」的形态，见 withSourcePaths。
    else if (key === '--shop-xlsx') args.shopXlsx = argv[++i];
    else if (key === '--promotion-zip') args.promotionZip = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.date ?? '')) throw new Error('missing or invalid --date (YYYY-MM-DD)');
  if (args.commit && args.verifyExisting !== null) {
    throw new Error('--commit 与 --verify-existing 互斥：一个是写，一个是只读核对');
  }
  if (args.verifyExisting !== null && !Number.isInteger(args.verifyExisting)) {
    throw new Error('--verify-existing 需要一个整数（导入前底单的条数）');
  }
  if ((args.shopXlsx === null) !== (args.promotionZip === null)) {
    throw new Error('--shop-xlsx 与 --promotion-zip 必须成对给（少给一个就会退回采集段，两种来源混着用）');
  }
  if (args.only) {
    const unknown = args.only.filter((name) => !STAGE_NAMES.includes(name));
    if (unknown.length) {
      throw new Error(`--only 里有不认识的阶段名：${unknown.join(', ')}`
        + `（合法值：${STAGE_NAMES.join(' / ')}）`
        + ' —— 不认识的会被当成「没点名」而跳过，于是整轮跑完却一步没做，退出码还是 0');
    }
  }
  return args;
};

/**
 * 一台店的全部阶段。**纯函数**（不碰网络、不读文件）⇒ 顺序与参数可以被离线断言。
 *
 * 返回的每一项：{ stage, script, argv, env, note }。`script` 为 null = 驱动自己做的事
 * （只有 sycm-reset 一项，它是一次导航，没有现成脚本）。
 */
export function buildShopStages(shopKey, options) {
  const { date, mode, shopXlsx = null, promotionZip = null, expectedBeforeCount = null, downloads = null } = options;
  if (!MODES.includes(mode)) {
    throw new Error(`未知模式 ${JSON.stringify(mode)}：只认 ${MODES.join(' / ')}`
      + ' —— 不能默默当排练跑（那样会「以为在提交、其实只是干跑」）');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date ?? ''))) {
    throw new Error(`buildShopStages 需要 YYYY-MM-DD 的日期，收到 ${JSON.stringify(date)}`);
  }
  if (mode === 'verify' && !Number.isInteger(expectedBeforeCount)) {
    throw new Error('verify 模式必须给 expectedBeforeCount（导入前底单条数，整数）—— 没有它核对就没有判据');
  }
  const shop = shopInstance(shopKey);
  const identity = shopIdentity(shopKey);
  // 身份期望值**必须齐全**才开跑：缺了就是「在没有判据的情况下跑完」（坑 38 的形态）。
  const identityArgs = expectArgs(shopKey, { require: ['shop', 'member'] }).args;
  const shopProxy = `http://127.0.0.1:${shop.proxyPort}`;
  const dailyProxy = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  const common = downloads ? ['--downloads', downloads] : [];
  // 审计表里那四列（browser_port / browser_id / proxy_port / …）的来源是**环境变量**，
  // 环境变量不设时回落成路线默认值 ⇒ 不设的话每家店的审计行都会写成 19022/19023，
  // 而实际打的是这家店自己的代理。所以每一阶段都显式带上它真正要连的那一组。
  const shopEnv = {
    CDP_BROWSER_PORT: String(shop.browserPort), CDP_PROXY_PORT: String(shop.proxyPort),
    CDP_BROWSER_ID: shop.browserId, CDP_BROWSER_LABEL: shop.label,
  };
  const dailyEnv = {
    CDP_BROWSER_PORT: String(PROJECT_PORTS.dailyReportBrowser),
    CDP_PROXY_PORT: String(PROJECT_PORTS.dailyReportProxy),
    CDP_BROWSER_ID: BROWSER_IDS.dailyReport, CDP_BROWSER_LABEL: BROWSER_LABELS.dailyReport,
  };
  const stages = [];
  const add = (stage, script, argv, env, note, ownAction = null) =>
    stages.push({ stage, script, argv, env, note, ownAction });

  // 体检排在最前面（SOP §10.0 的「起跑前逐项确认」落成代码）。它不采任何数据，
  // 只回答「现在能不能跑」；结论有 blocking 项就停这一家（见 runHealthCheck）。
  add('health-check', null, [], shopEnv,
    '体检：这家店的浏览器在不在、profile 对不对、两个必需页面各恰好一个', 'health');

  add('alimama-date', 'date-picker.mjs',
    ['--site', 'alimama', '--date', date, '--proxy', shopProxy], shopEnv,
    '阿里妈妈落位（日期全在 URL hash 里，navigate 即落位）');
  add('promotion-submit', 'collect-promotion-report.mjs',
    ['--phase', 'submit', '--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '提交推广报表生成任务（之后平台要生成几分钟，中途用第 3/4 步填掉）');
  add('sycm-date', 'date-picker.mjs',
    ['--site', 'sycm', '--date', date, '--proxy', shopProxy], shopEnv,
    '生意参谋落位（切页签到 询单到付款 再定日期）');
  add('shop-report', 'collect-shop-report.mjs',
    ['--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '点开日报预览并下载店铺工作簿（会把这个页签留在预览页）');
  add('promotion-fetch', 'collect-promotion-report.mjs',
    ['--phase', 'fetch', '--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '取推广 zip（先断言任务行是「生成成功」，再真实点复选框）');

  // 注意这三个写入方的 `--shop-key` 是**同一个值**（同一个变量），不是三处各写一遍：
  // 不同值会让回填并进另一家店那一代证据目录，而目录名上看不出来（错标签比不贴标签更糟）。
  const pushArgs = ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey];
  if (shopXlsx) pushArgs.push('--shop-xlsx', shopXlsx);
  if (promotionZip) pushArgs.push('--promotion-zip', promotionZip);
  if (mode === 'commit') pushArgs.push('--commit');
  else if (mode === 'verify') pushArgs.push('--verify-existing', '--expected-before-count', String(expectedBeforeCount));
  add('push', 'run-daily-report.mjs', pushArgs, dailyEnv,
    mode === 'commit' ? '推送（会写底单新增一行）'
      : mode === 'verify' ? '推送段的**只读核对**：核那一行还在、字段还对（不写）'
        : '推送干跑（落 plan.json，不写）');

  add('sycm-reset', null, [], shopEnv,
    '生意参谋回位：把被第 4 步带走的那个页签送回 qos/.../shop/performance（驱动自己导航）', 'reset');
  add('sycm-date-again', 'date-picker.mjs',
    ['--site', 'sycm', '--date', date, '--proxy', shopProxy], shopEnv,
    '回位会重置页签与日期 ⇒ 必须重跑落位，否则回填报 expected one 当日询单人数 table, got 0');

  const backfillArgs = ['--date', date, '--proxy', shopProxy, '--source-shop', identity.fullName,
    '--shop', shopKey, '--shop-key', shopKey];
  if (mode === 'commit') backfillArgs.push('--commit');
  add('backfill', 'run-inquiry-backfill.mjs', backfillArgs, shopEnv,
    mode === 'commit' ? '询单回填（写两个字段）' : '询单回填干跑（取数 + 判处置，不写）');

  add('readback', 'readback-daily-report.mjs',
    ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey], dailyEnv,
    '独立回读 + 截图（换一条通路读同一个事实）');

  // 与 `STAGE_NAMES` 互锁：那份常量是 `--only` 的合法值来源，它一旦和真实阶段表漂移，
  // 「拼错名字」就又变成静默跳过了 —— 只是这次的错误由常量自己造出来。逐字比，不比长度。
  const produced = stages.map((item) => item.stage);
  if (produced.join(',') !== STAGE_NAMES.join(',')) {
    throw new Error('阶段表与 STAGE_NAMES 漂移了：\n'
      + `  实际产出 ${produced.join(',')}\n  常量     ${STAGE_NAMES.join(',')}`);
  }

  return stages;
}

/**
 * 把采集段的产物路径注入推送段的参数表。
 *
 * **替换而不是追加**：`buildShopStages` 是纯函数，调用方可能已经给了这两个值（离线断言用），
 * 追加会得到两个 `--shop-xlsx` —— 后一个胜出、静默，「两份真相当中有一份是假的」正是要防的东西。
 *
 * **两种来源只许存在一种**：全部来自采集段（同轮），或者全部来自命令行（单独重跑推送段）。
 * 混着用意味着有一个路径是上一轮留下的，而它在文件名上看不出来属于哪一天/哪家店。
 */
export function withSourcePaths(argv, { shopXlsx, promotionZip } = {}) {
  const both = Boolean(shopXlsx) && Boolean(promotionZip);
  const neither = !shopXlsx && !promotionZip;
  if (!both && !neither) {
    throw new Error(`源产物路径只给了一半（${shopXlsx ? '只有 --shop-xlsx' : '只有 --promotion-zip'}）`
      + ' —— 一半手填一半来自采集段，两种来源混着用。停手。');
  }
  if (neither) {
    throw new Error('没有拿到 shopXlsxPath / promotionZipPath：push 的这两个参数是必填，不猜路径。'
      + '要么让采集段（shop-report / promotion-fetch）在本轮里跑过，'
      + '要么用 --shop-xlsx + --promotion-zip 显式给一对（单独重跑推送段时）。');
  }
  for (const [flag, value] of [['--shop-xlsx', shopXlsx], ['--promotion-zip', promotionZip]]) {
    if (!existsSync(value)) throw new Error(`采集/命令行给的源产物不存在：${flag} ${value}`);
  }
  const cleaned = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--shop-xlsx' || argv[i] === '--promotion-zip') { i += 1; continue; }
    cleaned.push(argv[i]);
  }
  return cleaned.concat(['--shop-xlsx', shopXlsx, '--promotion-zip', promotionZip]);
}

const proxyJson = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `proxy request failed: HTTP ${response.status}`);
  return payload;
};

/**
 * 生意参谋回位。
 *
 * 为什么不能只靠 `resolveTarget` 那个自愈分支：它要求「同一主机下**恰好一个**页面」。
 * 店铺浏览器里本来就有一个 `sycm.taobao.com/portal/home.htm`，而第 4 步把性能页导成了
 * 报表预览页 ⇒ 同主机两个页面 ⇒ 自愈分支不成立（它宁可报错也不乱导航，这是对的）。
 * 所以这里显式做：找到**那个被带走的页签**（同主机、既不是首页也不是性能页），送它回去。
 * 认不出来就如实报错并列出所有页面，**不猜**。
 */
async function resetSycmPage({ proxy, log }) {
  const targets = (await proxyJson(`http://127.0.0.1:${proxy}/targets`))
    .filter((t) => t.type === 'page');
  const sycmPages = targets.filter((t) => String(t.url).includes('sycm.taobao.com'));
  const performing = sycmPages.filter((t) => String(t.url).includes(SYCM_FRAGMENT));
  if (performing.length === 1) {
    log(`回位：不需要 —— 已经恰好一个性能页（${performing[0].url.slice(0, 80)}）`);
    return { action: 'none', pages: sycmPages.map((t) => t.url) };
  }
  const drifted = sycmPages.filter((t) => !String(t.url).includes('portal/home'));
  if (performing.length === 0 && drifted.length === 1) {
    log(`回位：把 ${drifted[0].url.slice(0, 90)} 送回 ${SITE_SYCM_ENTRY}`);
    await proxyJson(`http://127.0.0.1:${proxy}/navigate?target=${encodeURIComponent(drifted[0].targetId)}`
      + `&url=${encodeURIComponent(SITE_SYCM_ENTRY)}`, { method: 'POST', body: '' });
    await new Promise((r) => { setTimeout(r, 3000); });
    const after = (await proxyJson(`http://127.0.0.1:${proxy}/targets`))
      .filter((t) => t.type === 'page' && String(t.url).includes(SYCM_FRAGMENT));
    if (after.length !== 1) {
      throw new Error(`回位后仍不是恰好一个性能页（${after.length} 个）—— 停手，先看现场`);
    }
    return { action: 'navigated', pages: after.map((t) => t.url) };
  }
  throw new Error(`生意参谋页的样子不是我预期的，回位不敢乱动。同主机 ${sycmPages.length} 个页面：\n`
    + sycmPages.map((t) => `  · ${t.url}`).join('\n'));
}

function runStage(shopKey, stage, { repoRoot, logDir }) {
  const log = (line) => console.log(`[${shopKey}] ${line}`);
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const startedAt = new Date().toISOString();
  const scriptPath = path.join(repoRoot, 'skills/sycm-alimama-daily-report/scripts', stage.script);
  const command = `${NODE} ${formatArgv([scriptPath, ...stage.argv])}`;
  const result = spawnSync(NODE, [scriptPath, ...stage.argv], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, ...stage.env },
  });
  const text = `\n===== ${startedAt} =====\n$ ${command}\nexit=${result.status} signal=${result.signal ?? ''} error=${result.error?.message ?? 'none'}\n`
    + `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`;
  writeFileSync(outPath, text, 'utf8');
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const line of combined.split(/\r?\n/)) {
    // 采集段的两条路径标记与推送段那行 `[shop-key]` 都要在驱动这一层露出：
    // 前者是后面 push 的入参，后者是「证据目录贴对了店铺没有」当天唯一的当场证据。
    if (/^\s*(?:\[[^\]]+\]\s*)?(shopXlsxPath|promotionZipPath) = \S/u.test(line) || /\[shop-key\]/u.test(line)) log(line.trim());
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    logPath: path.relative(repoRoot, outPath), command };
}

/**
 * 从某个阶段的 stdout 里取产物路径。
 *
 * 为什么不能只认行首：两个采集脚本的打印格式**不一样**（实测原文）——
 *   collect-shop-report.mjs      `      shopXlsxPath = …`（缩进，没有前缀）
 *   collect-promotion-report.mjs `[fetch] promotionZipPath = …`（有 `[fetch] ` 前缀）
 * 只写 `^\s*<marker> = ` 会让推广 zip 的路径永远抓不到，而症状是「采集成功、push 报没有拿到路径」——
 * 一个看起来像采集问题的驱动问题。所以这里允许一个可选的行首 `[xxx] ` 前缀。
 */
export const findPath = (text, marker) => {
  const match = new RegExp(`^\\s*(?:\\[[^\\]]+\\]\\s*)?${marker} = (.+)$`, 'mu').exec(text);
  return match ? match[1].trim() : null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.commit ? 'commit' : args.verifyExisting !== null ? 'verify' : 'rehearse';
  const shops = args.shops ?? shopBrowserKeys();
  for (const key of shops) shopInstance(key);
  const logRoot = path.resolve(args.logs ?? path.join(REPO_ROOT, 'evidence', `multi-shop-${args.date}`));
  const downloads = args.downloads ?? null;
  const explicitSources = { shopXlsx: args.shopXlsx, promotionZip: args.promotionZip };

  console.log(`[驱动] 目标日 ${args.date}｜模式 ${mode}｜店铺 ${shops.length} 家：${shops.join(' / ')}`);
  console.log(`[驱动] 日志根 ${logRoot}`);
  if (mode === 'commit') console.log('[驱动] --commit：会真的写飞书。目标日已有行会硬重复停止（先按 §9.3 删那天）。');
  if (mode === 'verify') console.log(`[驱动] 只读核对模式：--expected-before-count ${args.verifyExisting}（不写飞书）`);
  if (mode === 'rehearse') console.log('[驱动] 排练模式：采集是真的，两个写入方都是干跑，不写飞书。');
  for (const key of shops) console.log(`[驱动]   ${describeIdentity(key)}`);

  const summary = { date: args.date, mode, startedAt: new Date().toISOString(), round: {}, shops: {} };

  // 一轮一次：商家浏览器的体检。推送段与回读段都跑在它上面，而飞书底单页只在那一个浏览器里
  // （采集段在别处 ⇒ 它们各自的体检在各店自己的阶段里）。它不通过就整轮都不必跑，
  // 所以这一条**与 --keep-going 无关**：换哪家店都缺同一个前提。
  // browserKey 取自路线表（`ROUTES.dailyReport.browser`），不写死键名。
  mkdirSync(logRoot, { recursive: true });
  const roundHealth = await runHealthCheck({
    shopKey: null,
    stage: { stage: 'health-check-daily', index: 0 },
    logDir: logRoot,
    repoRoot: REPO_ROOT,
    browserKey: ROUTES.dailyReport.browser,
    expectedPages: expectedPagesForDailyBrowser(),
  });
  summary.round.healthCheckDaily = {
    status: roundHealth.status,
    logPath: roundHealth.logPath,
    ok: roundHealth.detail?.ok ?? null,
    blocking: roundHealth.detail?.blocking?.map((f) => f.code) ?? null,
  };
  if (roundHealth.status !== 0) {
    console.error('[驱动] 商家浏览器体检未通过 ⇒ 整轮不跑（推送段与回读段都要用它）。'
      + `详见 ${roundHealth.logPath}`);
    summary.finishedAt = new Date().toISOString();
    writeFileSync(path.join(logRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.exitCode = 1;
    return;
  }

  for (const key of shops) {
    const shopLogDir = path.join(logRoot, key);
    mkdirSync(shopLogDir, { recursive: true });
    const record = { status: 'pending', stages: [], source: {} };
    summary.shops[key] = record;
    let index = 0;
    const run = async (stage) => {
      index += 1;
      const withIndex = { ...stage, index };
      if (args.only && !args.only.includes(stage.stage)) {
        console.log(`[${key}] ${index}. ${stage.stage} —— 跳过（--only 没点名）`);
        return { status: 0, skipped: true, stdout: '', logPath: null };
      }
      console.log(`[${key}] ${index}. ${stage.stage} —— ${stage.note}`);
      let result;
      if (withIndex.ownAction === 'health') {
        result = await runHealthCheck({ shopKey: key, stage: withIndex, logDir: shopLogDir, repoRoot: REPO_ROOT });
      } else if (withIndex.ownAction === 'reset') {
        result = await runReset(key, withIndex, { logDir: shopLogDir, repoRoot: REPO_ROOT });
      } else {
        result = runStage(key, withIndex, { repoRoot: REPO_ROOT, logDir: shopLogDir });
      }
      record.stages.push({ stage: stage.stage, status: result.status, skipped: Boolean(result.skipped),
        logPath: result.logPath ?? null, argv: stage.argv });
      return result;
    };

    try {
      for (const stage of buildShopStages(key, { date: args.date, mode, expectedBeforeCount: args.verifyExisting, downloads })) {
        // 采集段产出的两条路径要在 push 之前填进参数。**三种模式都要填**：
        // `--shop-xlsx` / `--promotion-zip` 在 run-daily-report.mjs 里是必填参数，
        // 「只读核对就不给源文件」会让 push 直接 missing required argument —— 那就不是只读，
        // 而是连核对都没跑。所以 verify 与 commit 一样要带上采集段的产物路径。
        let argv = stage.argv;
        if (stage.stage === 'push') {
          const sources = explicitSources.shopXlsx
            ? explicitSources
            : { shopXlsx: record.source.shopXlsx, promotionZip: record.source.promotionZip };
          // 显式给的与采集段报的是两份真相 —— 同时存在且不同就是「有一份是假的」。
          if (explicitSources.shopXlsx && record.source.shopXlsx
            && explicitSources.shopXlsx !== record.source.shopXlsx) {
            throw new Error('--shop-xlsx 与采集段报出来的工作簿不是同一个文件'
              + `（命令行 ${explicitSources.shopXlsx}／采集段 ${record.source.shopXlsx}）—— 停手`);
          }
          argv = withSourcePaths(stage.argv, sources);
        }
        const result = await run({ ...stage, argv });
        if (result.status !== 0) {
          record.status = 'failed';
          record.failedStage = stage.stage;
          const tail = String(result.stderr ?? '').trim().split(/\r?\n/u).slice(-12).filter(Boolean);
          if (tail.length) console.error(`[${key}]   stderr 尾部：\n${tail.map((l) => `      ${l}`).join('\n')}`);
          throw new Error(`阶段 ${stage.stage} 失败（exit ${result.status ?? result.signal}）`);
        }
        if (stage.stage === 'shop-report') {
          record.source.shopXlsx = findPath(result.stdout, 'shopXlsxPath');
          if (record.source.shopXlsx) console.log(`[${key}]   店铺工作簿 = ${record.source.shopXlsx}`);
        }
        if (stage.stage === 'promotion-fetch') {
          record.source.promotionZip = findPath(result.stdout, 'promotionZipPath');
          if (record.source.promotionZip) console.log(`[${key}]   推广 zip = ${record.source.promotionZip}`);
        }
      }
      record.status = 'ok';
    } catch (error) {
      record.error = error.message;
      console.error(`[${key}] 停在这一步：${error.message}`);
      if (!args.keepGoing) {
        console.error(`[驱动] 按默认策略停整轮（要看完全部店加 --keep-going）。已跑的店记在 ${path.relative(REPO_ROOT, logRoot)}。`);
        break;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  const summaryPath = path.join(logRoot, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\n[驱动] 汇总：');
  for (const [key, record] of Object.entries(summary.shops)) {
    console.log(`  ${key}：${record.status}${record.failedStage ? `（停在 ${record.failedStage}）` : ''}`
      + `${record.error ? ` —— ${record.error}` : ''}`);
  }
  console.log(`[驱动] 明细 ${path.relative(REPO_ROOT, summaryPath)}`);
  if (Object.values(summary.shops).some((r) => r.status !== 'ok')) process.exitCode = 1;
}

// 体检也是驱动自己做的：它要按**浏览器实例**参数化，而且没有现成脚本。
//
// 判据：有 blocking 项就停这一家（fail-closed）。这与「探针没读到不停线」不冲突 ——
// 「没读到」在体检模块内部已经被降级成非 blocking（`AUTH_UNKNOWN`），
// 能走到这里的 blocking 都是「读到了，而且不对」。
/**
 * 体检结论 → 阶段退出码。**读不出来也不算通过**（返回 3）。
 *
 * 这是 fail-closed 的另一半：只有明确 `ok: true` 才放行。写成 `result.ok ? 0 : 2` 也「看起来对」，
 * 但那样 `undefined` / 少了 `ok` 字段的返回值会落进 2 或 0，取决于怎么写 —— 而体检模块与驱动
 * 是两个文件，它的返回形状将来变了，这里**不会**报错，只会安静地换个结论。
 * 抽成纯函数是为了让它能被离线断言：`null` 与 `{}` 必须也是「不放行」。
 */
export function healthStageStatus(result) {
  if (!result || typeof result.ok !== 'boolean') return 3;
  return result.ok ? 0 : 2;
}

async function runHealthCheck({ shopKey, stage, logDir, repoRoot, browserKey = null, expectedPages = null }) {
  const label = shopKey ?? '一轮';
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`[${label}]   ${line}`); };
  let status = 0;
  let result = null;
  try {
    const check = createPlatformHealthCheck({
      browserKey: browserKey ?? shopKey,
      expectedPages: expectedPages ?? expectedPagesForShop(),
    });
    result = await check({});
    const warnings = result.findings.filter((finding) => !finding.blocking);
    log(`体检${result.ok ? '通过' : '未通过'}：阻断 ${result.blocking.length} 项，告警 ${warnings.length} 项`);
    for (const finding of result.blocking) log(`  [阻断] ${finding.code}：${finding.detail}`);
    for (const finding of warnings) log(`  [告警] ${finding.code}：${finding.detail}`);
    log(`  ${result.note}`);
    status = healthStageStatus(result);
  } catch (error) {
    // 体检自己出错（模块加载/参数问题）⇒ 记非零，不静默当成通过。
    lines.push(`ERROR ${error.message}`);
    status = 3;
  }
  lines.push('');
  lines.push(JSON.stringify(result, null, 2));
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  return { status, stdout: lines.join('\n'), detail: result, logPath: path.relative(repoRoot, outPath) };
}

// 回位是驱动自己做的（没有现成脚本），日志格式与别的阶段一致，便于按同一套办法看。
async function runReset(shopKey, stage, { logDir, repoRoot }) {
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`[${shopKey}]   ${line}`); };
  let status = 0;
  let detail = null;
  try {
    // 这一支只有驱动自己在做 I/O（要 navigate）⇒ 必须 await，否则「阶段报成功但页面没动」。
    detail = await resetSycmPage({ proxy: stage.env.CDP_PROXY_PORT, log });
  } catch (e) {
    lines.push(`ERROR ${e.message}`);
    status = 1;
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  return { status, stdout: lines.join('\n'), detail, logPath: path.relative(repoRoot, outPath) };
}

// 顶层入口：main 是 async（回位那一支要 await），所以这里也要 await。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
