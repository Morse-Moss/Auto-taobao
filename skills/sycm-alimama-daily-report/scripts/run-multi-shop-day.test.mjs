import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BROWSER_IDS, PROJECT_PORTS, ROUTES, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { renderAlertText } from '../../../runtime/notify-feishu-core.mjs';
import { OVERLAY_NOT_DISMISSED_TOKEN } from './collect-core.mjs';
import { triageFailures } from './remediation-table.mjs';
import { planRepair } from './repair-actions.mjs';
import { siteAdapter } from './date-picker.mjs';
import { IDENTITY_SHOP_HEADER_VERIFIED_SHOPS, shopIdentity } from './shop-identities.mjs';
import { DEFAULT_AUTO_REPAIR_MAX_ROUNDS, FAILURE_CAUSES, HUMAN_REQUIRED_CAUSES, MODES, STAGE_LABELS, STAGE_NAMES, TARGET_DATE_LITERALS, assertAlertIsBusinessReadable, autoRepairAndRetry, buildRepairRequest, buildRoundFailureAlert, buildShopStages, describePageWhereabouts, describeShopFailure, dispatchRoundAlert, executeRepairCandidate, expectedPagesForDailyBrowser, expectedPagesForShop, findPath, healthStageStatus, judgeProxyRetryable, judgeResetLanded, normalizeLoginPreflight, parseArgs, planAlertDeferral, probeSyncSpawnSanity, proxyJson, proxyPortForBrowser, readLoginPreflight, recoverFailedShop, resolveAlertDispatch, resolveTargetDate, roundFailureSummary, shopFailureCause, stageLabelOf, stageNumber, withSourcePaths } from './run-multi-shop-day.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../../..');
const DATE = '2026-09-17';
const SHOP = '里可林淘宝';

// 顺序是**规格**（SOP §10.0 的起跑前体检 + §10.1 的十步），所以期望值写成字面量 ——
// 从实现推导出来的顺序永远等于实现，那种测试不可能红。
const EXPECTED_ORDER = ['health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report',
  'promotion-fetch', 'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback'];
const SHOP_STAGES = ['health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report',
  'promotion-fetch', 'sycm-reset', 'sycm-date-again', 'backfill'];
const DAILY_STAGES = ['push', 'readback'];
const WRITERS = ['push', 'backfill', 'readback'];
const COLLECTORS = ['promotion-submit', 'shop-report', 'promotion-fetch'];

const stagesOf = (key = SHOP, overrides = {}) => buildShopStages(key, { date: DATE, mode: 'rehearse', ...overrides });
const byStage = (stages) => Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
const flagValue = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
};
const countFlag = (argv, flag) => argv.filter((value) => value === flag).length;

// 只需要「一个真实存在的文件」来验存在性判据，用仓库里本来就有的两个。
const REAL_XLSX = path.join(REPO_ROOT, 'package.json');
const REAL_ZIP = path.join(REPO_ROOT, 'requirements.txt');

test('驱动：阶段顺序与 SOP §10.1 逐字一致（回位在第 4 步之后、回填之前）', () => {
  assert.deepEqual(stagesOf().map((stage) => stage.stage), EXPECTED_ORDER);
});

test('驱动：有脚本的带脚本；没脚本的必须声明自己那一支（否则阶段会报 ok 却什么也没做）', () => {
  for (const stage of stagesOf()) {
    if (stage.script === null) {
      // 这是 2026-09-18 晚加体检阶段时补的：主流程按 `ownAction` 分派，
      // 一个 `script: null` 又没声明分支的阶段**不会报错**，只会静默什么都不做 ——
      // 而它的日志文件照样生成、状态照样是 0。
      assert.ok(stage.ownAction, `${stage.stage} 没有脚本，却没声明 ownAction —— 主流程没有分支会执行它`);
      assert.deepEqual(stage.argv, [], `${stage.stage} 没有脚本，参数就该是空的`);
      continue;
    }
    assert.equal(stage.ownAction, null, `${stage.stage} 有脚本，不该再声明 ownAction`);
    assert.equal(path.basename(stage.script), stage.script, `${stage.stage} 的 script 应是文件名而不是路径`);
  }
  // 两支自办阶段各自是谁，逐字钉住：名字换了而主流程的分支没跟着换，这条会红。
  assert.deepEqual(stagesOf().filter((stage) => stage.ownAction)
    .map((stage) => `${stage.stage}:${stage.ownAction}`), ['health-check:health', 'sycm-reset:reset']);
});

test('驱动：每个带脚本的阶段都自带 --date 与 --proxy（不靠调用方 shell 里恰好有什么）', () => {
  for (const stage of stagesOf()) {
    if (!stage.script) continue;
    assert.equal(flagValue(stage.argv, '--date'), DATE, `${stage.stage} 的 --date`);
    assert.ok(flagValue(stage.argv, '--proxy'), `${stage.stage} 的 --proxy`);
  }
});

test('驱动：采集/回填/回位打这家店自己的代理，推送/回读打商家浏览器代理（飞书页只在那一个浏览器里）', () => {
  const shop = shopInstance(SHOP);
  const stages = byStage(stagesOf());
  for (const name of SHOP_STAGES) {
    const stage = stages[name];
    // 自办阶段（体检、回位）没有脚本，也就没有 `--proxy` 参数：它们连哪台浏览器是靠
    // `env.CDP_PROXY_PORT` 读的。这条断言守的就是那次读 —— 读错了它们会在**商家浏览器**上干活
    // （体检去查错机器、回位在错窗口里导航），而那**也会「成功」**（那个窗口里同样有生意参谋页）
    // ⇒ 静默打错浏览器。
    if (stage.script === null) {
      assert.deepEqual(stage.argv, [], `${name} 没有脚本，不该有参数`);
      assert.equal(stage.env.CDP_PROXY_PORT, String(shop.proxyPort), `${name} 读的代理端口`);
      continue;
    }
    assert.equal(flagValue(stage.argv, '--proxy'), `http://127.0.0.1:${shop.proxyPort}`, `${name} 的代理`);
    assert.equal(stage.env.CDP_PROXY_PORT, String(shop.proxyPort), `${name} 的 env 代理端口`);
  }
  for (const name of DAILY_STAGES) {
    assert.equal(flagValue(stages[name].argv, '--proxy'),
      `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`, `${name} 的代理`);
    assert.equal(stages[name].env.CDP_BROWSER_ID, BROWSER_IDS.dailyReport, `${name} 的 env 身份`);
  }
});

// 这条是「审计表四列来自环境变量」那个坑的判据：不显式设，四家店的审计行会全部写成商家浏览器那一组，
// 而实际打的是各自店铺的代理 —— 事后复盘会看不出哪条记录属于哪家店。
test('驱动：每家店的审计身份互不相同，且没有一家被写成日报链那一组', () => {
  // 2026-09-30：只对**身份齐全、真能构造出阶段**的店断言。
  // 另外 8 家页头店名还没实测，buildShopStages 对它们 fail-closed（当场抛），
  // 所以它们根本没有「阶段里的审计身份」可查 —— 那件事由身份闸门负责，这里不越权替它兜底。
  const proxyPorts = new Map();
  const runnable = shopBrowserKeys().filter((key) => shopIdentity(key).sycmHeader);
  assert.ok(runnable.length > 0, '一个能跑的店都没有 —— 下面的断言会变成空循环（看着绿，其实什么都没验）');
  for (const key of runnable) {
    const shop = shopInstance(key);
    for (const stage of buildShopStages(key, { date: DATE, mode: 'rehearse' })) {
      if (DAILY_STAGES.includes(stage.stage)) continue;
      assert.equal(stage.env.CDP_BROWSER_PORT, String(shop.browserPort), `${key}/${stage.stage} 浏览器端口`);
      assert.equal(stage.env.CDP_BROWSER_ID, shop.browserId, `${key}/${stage.stage} browser id`);
      assert.equal(stage.env.CDP_BROWSER_LABEL, shop.label, `${key}/${stage.stage} browser label`);
      assert.notEqual(stage.env.CDP_BROWSER_ID, BROWSER_IDS.dailyReport, `${key}/${stage.stage} 用了日报链身份`);
      assert.notEqual(stage.env.CDP_PROXY_PORT, String(PROJECT_PORTS.dailyReportProxy),
        `${key}/${stage.stage} 用了日报链代理端口`);
    }
    proxyPorts.set(key, shop.proxyPort);
  }
  assert.equal(new Set(proxyPorts.values()).size, proxyPorts.size, '各家店的代理端口必须互不相同');
  // 端口唯一性要对**全部**登记店铺成立，不只是能跑的那几家 —— 这条不需要身份，直接问登记表。
  const allProxies = shopBrowserKeys().map((key) => shopInstance(key).proxyPort);
  assert.equal(new Set(allProxies).size, allProxies.length, '13 家的代理端口必须互不相同');
});

test('驱动：三个写入方的 --shop-key 是同一个值且各只出现一次', () => {
  const stages = byStage(stagesOf());
  for (const name of WRITERS) {
    assert.equal(countFlag(stages[name].argv, '--shop-key'), 1, `${name} 的 --shop-key 出现次数`);
    assert.equal(flagValue(stages[name].argv, '--shop-key'), SHOP, `${name} 的 --shop-key`);
  }
  // 回填里两个店名字段：--shop 是飞书选项名、--source-shop 是源产物/页头店名，
  // assertEvidenceShopKey 会拿这两个互核，所以都不能是随手写的。
  assert.equal(flagValue(stages.backfill.argv, '--shop'), SHOP);
  assert.equal(flagValue(stages.backfill.argv, '--source-shop'), shopIdentity(SHOP).fullName);
});

test('驱动：采集段的三个身份期望值来自登记表，且每家给的都逐字对得上', () => {
  const headers = new Set();
  let gated = 0;
  for (const key of shopBrowserKeys()) {
    const row = shopIdentity(key);
    if (!row.sycmHeader) {
      // 2026-09-30：13 家里有 8 家的页头店名还没实测（底座建好、人还没登录过）。
      // buildShopStages 对身份**要求齐全**（fail-closed），所以这 8 家的正确行为是
      // 「当场抛错、点名缺哪一项」—— 不是「构造出一份没有闸门的阶段表」。
      assert.throws(() => buildShopStages(key, { date: DATE, mode: 'rehearse' }),
        /还没有实测值/u, `${key} 缺页头店名时不许构造出阶段（那会变成「没判据就跑完」）`);
      gated += 1;
      continue;
    }
    const stages = byStage(buildShopStages(key, { date: DATE, mode: 'rehearse' }));
    for (const name of COLLECTORS) {
      const argv = stages[name].argv;
      // 三个期望值都「有就给、没有就不给」：`flagValue` 在开关缺席时返回 null。
      // 这条写法顺带钉住一件事：**不许拿猜出来的值把空缺填上**（填了这里就红）。
      assert.equal(flagValue(argv, '--expect-shop'), row.sycmHeader, `${key}/${name} 的 --expect-shop`);
      assert.equal(flagValue(argv, '--expect-member'), row.alimamaMemberName, `${key}/${name} 的 --expect-member`);
      assert.equal(flagValue(argv, '--expect-member-id'), row.alimamaMemberId, `${key}/${name} 的 --expect-member-id`);
    }
    // 登记表这两个字段**默认同值**（页头店名就是平台店铺全称）。唯一允许分开的是
    // 「平台把长店名截断」那一情形（2026-09-30 实测：保拉淘宝页头是 `Paola Lenti保拉伦...`，
    // 底单原文是 `Paola Lenti保拉伦蒂`）。分开时**必须知道** ——
    // 回填的 `--source-shop` 取的是 fullName，页头读回来的是 sycmHeader。
    if (row.sycmHeader !== row.fullName) {
      const stem = row.sycmHeader.replace(/\.{3}$/u, '');
      assert.equal(stem.length >= 4 && row.fullName.startsWith(stem), true,
        `${key} 的 sycmHeader 与 fullName 漂移了，且不构成「被平台截断」—— --source-shop 要重看`);
    }
    headers.add(row.sycmHeader);
  }
  assert.equal(headers.size, IDENTITY_SHOP_HEADER_VERIFIED_SHOPS.length,
    '已实测的页头店名必须互不相同（分母取实测清单：写死一个数，加一家店就红一次）');
  assert.equal(gated + IDENTITY_SHOP_HEADER_VERIFIED_SHOPS.length, shopBrowserKeys().length,
    '「能跑」+「被身份闸门挡住」必须正好等于全部店铺 —— 漏掉的那家会既不跑也不报错');
});

test('驱动：三种模式的写入口径（排练两个写入方都干跑；verify 只核对；commit 才写）', () => {
  const rehearse = byStage(stagesOf());
  assert.equal(countFlag(rehearse.push.argv, '--commit'), 0);
  assert.equal(countFlag(rehearse.push.argv, '--verify-existing'), 0);
  assert.equal(countFlag(rehearse.backfill.argv, '--commit'), 0);

  const verify = byStage(stagesOf(SHOP, { mode: 'verify', expectedBeforeCount: 1879 }));
  assert.equal(countFlag(verify.push.argv, '--verify-existing'), 1);
  assert.equal(flagValue(verify.push.argv, '--expected-before-count'), '1879');
  assert.equal(countFlag(verify.push.argv, '--commit'), 0);
  assert.equal(countFlag(verify.backfill.argv, '--commit'), 0, 'verify 模式回填也必须干跑');

  const commit = byStage(stagesOf(SHOP, { mode: 'commit' }));
  assert.equal(countFlag(commit.push.argv, '--commit'), 1);
  assert.equal(countFlag(commit.push.argv, '--verify-existing'), 0);
  assert.equal(countFlag(commit.backfill.argv, '--commit'), 1);

  for (const mode of MODES) {
    const push = byStage(stagesOf(SHOP, { mode, expectedBeforeCount: 1879 })).push.argv;
    assert.ok(!(push.includes('--commit') && push.includes('--verify-existing')), `${mode} 模式拼出了互斥参数`);
  }
});

test('驱动：历史日回填降级开关默认关、只在显式打开时透传，且不污染别的阶段', () => {
  // 为什么这三条都要断言（2026-09-19 实测）：`run-inquiry-backfill.mjs` 早就支持
  // `--allow-missing-peer`，但驱动没接 ⇒ 四家店补跑 09-17 时**全部**停在第 10 步
  // （`expected one benchmark row 同行同层均值, got 0`）。接线本身要能被断言，
  // 否则「开关存在」与「开关被用上」是两件事，现象完全一样（都是停在回填）。
  //
  // 但默认必须是关的：默认降级会掩盖「本该有基准却没有」的真故障。
  // 所以第一条断言守的是「不传时，参数表与从前逐字相同」。
  for (const mode of MODES) {
    const argv = byStage(stagesOf(SHOP, { mode, expectedBeforeCount: 1879 })).backfill.argv;
    assert.equal(countFlag(argv, '--allow-missing-peer'), 0, `${mode} 模式默认不该降级`);
  }

  const stages = byStage(stagesOf(SHOP, { mode: 'commit', allowMissingPeer: true }));
  assert.equal(countFlag(stages.backfill.argv, '--allow-missing-peer'), 1, '显式打开时要传且只传一次');
  assert.equal(countFlag(stages.backfill.argv, '--commit'), 1, '降级开关不该顶掉 --commit');
  // 只影响回填。若它漏到 push/readback，就会把「写飞书那一侧」也变成降级路径 ——
  // 而那两个脚本根本不认这个参数（会 unknown argument）。
  for (const name of ['push', 'readback']) {
    assert.equal(countFlag(stages[name].argv, '--allow-missing-peer'), 0, `${name} 被降级开关污染了`);
  }

  assert.equal(parseArgs(['--date', DATE, '--allow-missing-peer']).allowMissingPeer, true);
  assert.equal(parseArgs(['--date', DATE]).allowMissingPeer, false);
});

test('驱动：未知模式 / 错日期 / verify 缺 expectedBeforeCount / 未登记的店，一律抛错不静默', () => {
  assert.throws(() => stagesOf(SHOP, { mode: 'dry' }), /未知模式/u);
  assert.throws(() => stagesOf(SHOP, { mode: undefined }), /未知模式/u);
  assert.throws(() => stagesOf(SHOP, { date: '2026/09/17' }), /YYYY-MM-DD/u);
  assert.throws(() => stagesOf(SHOP, { mode: 'verify' }), /expectedBeforeCount/u);
  // 未登记的店名必须当场拒绝：没有登记就没有「隔离 profile + 端口」可连，
  // 而回落成共用 profile 会让「那家店跑完了但什么都没采到」看起来像成功。
  // 2026-09-30：原来举的反例是「保拉淘宝 / 里可林天猫」——它们在 13 家扩编后**已经登记**，
  // 于是这条断言悄悄失效（不再抛错，用例却还是绿的）。改成用一个真正不在登记表里的名字。
  assert.throws(() => buildShopStages('盖文1688', { date: DATE, mode: 'rehearse' }), /未登记的店铺实例/u);
  assert.throws(() => buildShopStages('', { date: DATE, mode: 'rehearse' }), /未登记的店铺实例/u);
});

test('驱动：身份齐全的店都能构造出完整阶段；身份缺的当场抛且点名缺哪一项', () => {
  // 用例名 2026-09-30 改（原来叫「已登记的店铺都能构造出完整阶段」）：
  // 「已登记」与「能跑」在 13 家扩编后不再是同一件事 —— 登记表 13 家，实测过页头店名的只有 5 家。
  // 旧名字会让后来者以为 13 家都能跑，而实际是 13 家**登记**、5 家**能跑**、8 家被身份闸门挡住。
  let runnable = 0;
  let gated = 0;
  for (const key of shopBrowserKeys()) {
    if (shopIdentity(key).sycmHeader) {
      assert.equal(buildShopStages(key, { date: DATE, mode: 'rehearse' }).length, EXPECTED_ORDER.length, key);
      runnable += 1;
    } else {
      assert.throws(() => buildShopStages(key, { date: DATE, mode: 'rehearse' }), /还没有实测值/u, key);
      gated += 1;
    }
  }
  assert.equal(runnable, IDENTITY_SHOP_HEADER_VERIFIED_SHOPS.length,
    '能跑的家数必须等于「已实测页头店名」清单 —— 两边不一致说明有一家是硬闯进来的，或清单没跟着更');
  assert.equal(runnable + gated, shopBrowserKeys().length, '两家都要算进去，没有第三类');
});

test('驱动：体检的期望页面用**路径级**片段，且与落位脚本的 SITES 同源', () => {
  // 为什么必须路径级：宿主级片段 `sycm.taobao.com` 在这两个浏览器上都命中 2 个页面
  // （门户首页 + 工作页）⇒ 体检会**永远**报「不唯一」。2026-09-18 晚实测过这套假红
  // （`--route=dailyReport` 对 19023 报 2 项 blocking，两条都是判据与现场不匹配）。
  // 为什么必须同源：片段抄一份就等着它与落位判据漂移 —— 而漂移的症状是体检放行、
  // 落位那一步才炸，中间隔了一整轮采集。
  const sycmFragment = siteAdapter('sycm').urlFragment;
  assert.ok(sycmFragment.includes('/'), `sycm 的片段必须是路径级（含 /），实际 ${sycmFragment}`);
  assert.notEqual(sycmFragment, 'sycm.taobao.com', 'sycm 的片段不许退回主机名');
  assert.deepEqual(expectedPagesForShop().map((page) => page.urlFragment),
    [sycmFragment, siteAdapter('alimama').urlFragment]);
  const daily = expectedPagesForDailyBrowser().map((page) => page.urlFragment);
  assert.equal(daily[0], sycmFragment);
  // 飞书那一页要带 base token：只写 `feishu.cn/base/` 的话，用户随手多开一个 base 页
  // 就会让推送与回读同时报「不唯一」，而它们其实该认的是**底单那一个**。
  assert.match(daily[1], /^feishu\.cn\/base\/\S+$/u, `飞书那一页要带 base token，实际 ${daily[1]}`);
});

test('驱动：体检结论只有「明确 ok:true」才放行，读不出来算不放行', () => {
  // 体检阶段是 fail-closed 的第一道闸：它的结论直接决定这家店（或整轮）跑不跑。
  // 所以「读不出来」必须落在不放行那一侧 —— 把 undefined 当通过，这道闸就是装饰品。
  assert.equal(healthStageStatus({ ok: true }), 0);
  assert.equal(healthStageStatus({ ok: false }), 2);
  assert.equal(healthStageStatus(null), 3, '没拿到结论 ≠ 通过');
  assert.equal(healthStageStatus(undefined), 3);
  assert.equal(healthStageStatus({}), 3, '少了 ok 字段 ≠ 通过');
  assert.equal(healthStageStatus({ ok: 'yes' }), 3, 'ok 不是布尔值 ≠ 通过');
  assert.equal(healthStageStatus({ ok: 1 }), 3);
});

test('驱动：从采集脚本的 stdout 里抓得到两条产物路径（含 [fetch] 那种带前缀的行）', () => {
  // 这两段的格式与下面那条用例从**脚本源码**里读回来的模板一致。
  const shopOut = '[report] 下载完成\n      shopXlsxPath = C:/Users/Administrator/Downloads/店铺日报(2026-09-17).xlsx\n';
  const promoOut = '[fetch] promotionZipPath = C:/Users/Administrator/Downloads/推广(2026-09-17).zip\n';
  assert.equal(findPath(shopOut, 'shopXlsxPath'), 'C:/Users/Administrator/Downloads/店铺日报(2026-09-17).xlsx');
  assert.equal(findPath(promoOut, 'promotionZipPath'), 'C:/Users/Administrator/Downloads/推广(2026-09-17).zip');
  assert.equal(findPath('[fetch] promotionZipPath = X', 'promotionZipPath'), 'X');
  assert.equal(findPath('没有任何标记的输出', 'promotionZipPath'), null);
});

// 把「测试里的期望格式」钉在「脚本里的真话」上：哪天采集脚本改了打印格式，
// 这条会红 —— 否则驱动会安静地抓不到路径，而症状看起来像采集失败。
test('驱动：产物路径的抓取格式与两个采集脚本里的打印模板真的对得上', () => {
  const sources = {
    shopXlsxPath: readFileSync(path.join(SCRIPTS_DIR, 'collect-shop-report.mjs'), 'utf8'),
    promotionZipPath: readFileSync(path.join(SCRIPTS_DIR, 'collect-promotion-report.mjs'), 'utf8'),
  };
  for (const [marker, source] of Object.entries(sources)) {
    const line = new RegExp(`^\\s*console\\.log\\(\`([^\`]*${marker} = [^\`]*)\`\\);`, 'mu').exec(source);
    assert.ok(line, `${marker}：脚本里找不到它的打印语句（格式改了？驱动抓不到路径了）`);
    assert.equal(findPath(line[1].replace(/\$\{[^}]*\}/gu, 'VALUE'), marker), 'VALUE',
      `${marker}：脚本里的打印模板改成驱动认不出的形状了`);
  }
});

test('驱动：源产物路径是替换而不是追加（两份真相不许同时留在参数表里）', () => {
  const argv = ['--date', DATE, '--shop-xlsx', 'D:/old/a.xlsx', '--promotion-zip', 'D:/old/b.zip',
    '--shop-key', SHOP];
  const out = withSourcePaths(argv, { shopXlsx: REAL_XLSX, promotionZip: REAL_ZIP });
  assert.equal(countFlag(out, '--shop-xlsx'), 1);
  assert.equal(countFlag(out, '--promotion-zip'), 1);
  assert.equal(flagValue(out, '--shop-xlsx'), REAL_XLSX);
  assert.equal(flagValue(out, '--promotion-zip'), REAL_ZIP);
  assert.equal(countFlag(out, '--shop-key'), 1, '注入路径不该碰别的参数');
  assert.equal(flagValue(out, '--date'), DATE);
});

test('驱动：源产物路径只给一半 / 都不给 / 文件不存在，一律抛错', () => {
  const argv = ['--date', DATE];
  assert.throws(() => withSourcePaths(argv, { shopXlsx: REAL_XLSX }), /只给了一半/u);
  assert.throws(() => withSourcePaths(argv, { promotionZip: REAL_ZIP }), /只给了一半/u);
  assert.throws(() => withSourcePaths(argv, {}), /没有拿到 shopXlsxPath/u);
  assert.throws(() => withSourcePaths(argv, { shopXlsx: 'D:/nope/a.xlsx', promotionZip: REAL_ZIP }), /不存在/u);
});

test('驱动 CLI：--commit 与 --verify-existing 互斥，源产物路径必须成对，未知参数不吞', () => {
  const parsed = parseArgs(['--date', DATE, '--shops', '里可林淘宝,网林天猫', '--keep-going', '--only', 'push']);
  assert.deepEqual(parsed.shops, ['里可林淘宝', '网林天猫']);
  assert.deepEqual(parsed.only, ['push']);
  assert.equal(parsed.keepGoing, true);
  assert.equal(parsed.commit, false);
  // 2026-09-25：默认值是「一家失败不带走其余」。这条判据管的是**默认方向** ——
  // 不给任何旗标时 `stopOnFirstFailure` 必须是 false，否则一处单店缺陷又会把一整天的数据带走
  // （实测：`evidence/daily-job-2026-09-24/job.log` 里四轮全都是这个形状）。
  assert.equal(parseArgs(['--date', DATE]).stopOnFirstFailure, false, '默认不许停整轮');
  assert.equal(parseArgs(['--date', DATE, '--keep-going']).stopOnFirstFailure, false,
    '--keep-going 现在是默认值的显式声明，不该改变方向');
  assert.equal(parseArgs(['--date', DATE, '--stop-on-first-failure']).stopOnFirstFailure, true,
    '退回旧行为要显式点名');
  assert.throws(() => parseArgs(['--date', DATE, '--stop-on-failure']), /unknown argument/u,
    '拼错的旗标不许静默吞掉（吞掉的后果是「以为自己让它停了，其实一路跑完」）');
  assert.throws(() => parseArgs(['--date', DATE, '--commit', '--verify-existing', '1879']), /互斥/u);
  assert.throws(() => parseArgs(['--date', DATE, '--verify-existing', 'many']), /整数/u);
  assert.throws(() => parseArgs(['--date', DATE, '--shop-xlsx', REAL_XLSX]), /成对/u);
  assert.throws(() => parseArgs(['--date', DATE, '--promotion-zip', REAL_ZIP]), /成对/u);
  assert.throws(() => parseArgs(['--date', DATE, '--bogus']), /unknown argument/u);
  assert.throws(() => parseArgs([]), /--date/u);
});

test('驱动 CLI：--only 里出现拼错的阶段名必须当场抛错，不许静默跳过整轮', () => {
  // `--only` 的实现是「不点名就跳过」⇒ 拼错名字的后果不是报错，而是十个阶段全被跳过、
  // 退出码 0、一步没做（「跑完了」与「什么都没跑」在 stdout 上长得一样）。
  // 所以合法值必须在解析期校验，并把完整合法清单打进错误里。
  assert.throws(() => parseArgs(['--date', DATE, '--only', 'pushh']), (err) => {
    assert.match(err.message, /不认识的阶段名/u);
    assert.match(err.message, /pushh/u);
    for (const name of EXPECTED_ORDER) {
      assert.match(err.message, new RegExp(name, 'u'), `合法值清单里少了 ${name}`);
    }
    return true;
  });
  // 名字混在一串里也一样 —— 不能只看第一个
  assert.throws(() => parseArgs(['--date', DATE, '--only', 'push,readbak']), /readbak/u);
  assert.deepEqual(parseArgs(['--date', DATE, '--only', 'push,readback']).only, ['push', 'readback']);
});

test('驱动：STAGE_NAMES 与真实的阶段表逐字一致（否则合法值清单自己会造出「拼错就等于没事」）', () => {
  assert.deepEqual([...STAGE_NAMES], EXPECTED_ORDER);
  // 互锁断言只比「常量 vs 产出」，如果两边一起改坏（比如把 readback 从两处同时删掉），
  // 它不会红 —— 那条规格由上面这句对 SOP §10.1 字面量的比对来守。
  assert.throws(() => buildShopStages('没有这家店', { date: DATE, mode: 'rehearse' }), /未登记|不存在|unknown|没有/u);
});

// ================================================================ 定时：目标日与告警
//
// 这一段守的是「明天起无人值守」的两件必需品：① 定时命令不必自己算日期；
// ② 出了错要有一条**收信人照着能做**的飞书提醒（而不是只有退出码）。
//
// 冻结的「现在」：本机 2026-09-20 07:30（= 2026-09-19T23:30Z）。所有与日期有关的断言都用
// 固定时刻 —— 相对日期的最大风险就是跨零点漂一天，拿真实时钟测不出来。

const NOW = new Date('2026-09-19T23:30:00Z');
const ALERT_DATE = '2026-09-19';
const ALERT_LOG_DIR = 'evidence/multi-shop-2026-09-19';
// 这一轮**该跑几家**由调用方给（配置里的事实），不由 summary 数出来 ——
// 整轮没跑起来时 summary.shops 是空的，数出来就是「0 家店」。
// 这里用登记表里的真实键名而不是 ['A','B']：告警正文里的店名要能被人对上窗口。
const ALERT_SHOP_KEYS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];
const alertNow = () => new Date('2026-09-20T00:10:00Z');

const okRecord = () => ({ status: 'ok', stages: [] });
const failedAt = (stage, failureOutput = '') => ({ status: 'failed', failedStage: stage, failureOutput, stages: [] });

// 一轮的真实形状：一家收完、一家停在采集、一家撞上「这一天已经写过」。
const mixedSummary = () => ({
  date: ALERT_DATE,
  mode: 'commit',
  round: { healthCheckDaily: { ok: true, blocking: [], blockingDetails: [] } },
  shops: {
    里可林淘宝: okRecord(),
    网林天猫: failedAt('shop-report', 'Error: expected one download button, got 0\n'),
    科塔淘宝: failedAt('push', 'Error: duplicate daily report row exists: recAbc123\n'),
  },
});

const buildAlert = (summary, overrides = {}) => buildRoundFailureAlert({
  date: ALERT_DATE, summary, shopKeys: ALERT_SHOP_KEYS, now: alertNow, ...overrides,
});
const renderedAlert = (summary, overrides = {}) => renderAlertText(buildAlert(summary, overrides));

// 节流状态文件必须落在临时目录里：这条链的默认路径是 `runtime/alert-throttle.json`，
// 而套件**不许写运行期状态**（跑一次测试就在真库里留下一条「刚发过」的记录，
// 会让真跑的那一轮被自己的测试静默挡掉）。用完即弃，不清理也不影响别的用例。
const tmpThrottle = () => path.join(mkdtempSync(path.join(tmpdir(), 'sycm-alert-throttle-')), 'alert-throttle.json');

test('驱动：--date 认字面量 yesterday，按 Asia/Shanghai 解析（跨零点不漂）', () => {
  assert.equal(resolveTargetDate('yesterday', NOW), '2026-09-19');
  assert.equal(resolveTargetDate('yesterday', new Date('2026-09-20T00:00:00Z')), '2026-09-19',
    '本机 08:00 与 07:30 必须是同一天：口径按本机/站点时区算，不按 UTC');
  assert.equal(resolveTargetDate('2026-09-01', NOW), '2026-09-01', '显式日期原样通过');
  // 认不出来的取值必须当场报错，并把允许的写法列出来 —— 静默落成「今天」会让整整一天的数据错位
  for (const bad of ['today', 'YESTERDAY', 'yestoday', '2026-9-1', '前天', '', null, undefined]) {
    assert.throws(() => resolveTargetDate(bad, NOW), (err) => {
      assert.match(err.message, /YYYY-MM-DD/u);
      assert.match(err.message, /yesterday/u, '报错要顺手告诉人正确写法');
      return true;
    }, `${JSON.stringify(bad)} 不该被接受`);
  }
  assert.deepEqual([...TARGET_DATE_LITERALS], ['yesterday'],
    '相对日期的字面量只留 yesterday：多一个就多一种「调度器以为它算的是另一天」的可能');
});

test('驱动 CLI：--date 走同一条解析，缺了就抛（默认不放宽）', () => {
  const parsed = parseArgs(['--date', 'yesterday'], { now: NOW });
  assert.equal(parsed.date, '2026-09-19');
  assert.equal(parsed.dateInput, 'yesterday', '原始取值要留着：日志里要能看出它被解析成了哪天');
  assert.equal(parseArgs(['--date', DATE], { now: NOW }).date, DATE);
  assert.equal(parseArgs(['--date', DATE], { now: NOW }).dateInput, DATE);
  assert.throws(() => parseArgs([], { now: NOW }), /--date/u, '不给日期仍然必须抛错（定时命令写错就当场停）');
  assert.equal(parseArgs(['--date', DATE], { now: NOW }).notify, false, '--notify 默认关');
  // 0 家店不能当「都收完了」：那会跑出一个退出码 0、什么也没做的「成功」
  assert.throws(() => parseArgs(['--date', DATE, '--shops', ','], { now: NOW }), /0 家店/u);
});

test('驱动：每个阶段都有面向人的中文名（告警正文里不许出现英文阶段名）', () => {
  assert.deepEqual(Object.keys(STAGE_LABELS), [...STAGE_NAMES], '阶段与中文名必须一一对应（新增阶段忘了补就会红）');
  for (const stage of STAGE_NAMES) {
    const label = stageLabelOf(stage);
    assert.ok(label, `${stage} 没有中文名`);
    assert.equal(/[A-Za-z_]/u.test(label), false, `${stage} 的中文名里不该出现英文或下划线：${label}`);
  }
  assert.throws(() => stageLabelOf('new-stage'), /没有面向人的中文名/u);
});

// --- ⑨b：告警闸门「先让 agent 试一下，再叫人」（2026-09-29 补）-------------------
//
// 三层降级的第②层（唤醒修复 agent）原先在真跑里被跳过：链级告警由本文件**直接**发飞书，
// 从不问「这一家该不该先交给 agent」。下面这组钉住「谁拦、谁不拦」的边界。
//
// 关键的安全方向：**只有整批失败都够格交给 agent 时才不发飞书**；只要有一家只能人上，
// 照旧叫人（fail-closed）—— 否则会出现「半批悄悄进了 agent 队列、人只看到另一半」。
const agentActionableRecord = () => ({
  status: 'failed', failedStage: 'shop-report', stages: [],
  repairRequest: {
    cause: 'STAGE_FAILED',
    candidates: [{ action: 'REAPPLY_DATES', mutating: true, why: '日期被回位重置' }],
    statePath: 'evidence/x/98-failure-state.json',
  },
  autoRepair: { gaveUp: '用完 1 轮（候选还剩 RELOAD_PAGE）' },
});
const humanOnlyRecord = () => ({
  status: 'failed', failedStage: 'health-check', stages: [],
  repairRequest: { cause: 'NEEDS_LOGIN', candidates: [{ action: 'RELOAD_PAGE', mutating: true, why: 'x' }] },
});

test('⑨b：默认（不给开关）一个字都不改 —— 有需要人的失败就照旧发告警', () => {
  const summary = { date: ALERT_DATE, shops: { 里可林淘宝: agentActionableRecord() } };
  const off = planAlertDeferral({ summary, enabled: false });
  assert.deepEqual(off, { defer: false, targets: [], humanOnly: [] },
    '默认必须是「不 defer」：这是一个改变「要不要打扰人」的口径开关，安全方向是保持原样');
});

test('⑨b：整批失败都「agent 能救」⇒ 拦住告警并给出派单', () => {
  const summary = { date: ALERT_DATE, shops: { 里可林淘宝: agentActionableRecord(), 网林天猫: agentActionableRecord() } };
  const on = planAlertDeferral({ summary, enabled: true });
  assert.equal(on.defer, true);
  assert.equal(on.targets.length, 2);
  assert.deepEqual(on.targets.map((t) => t.shop), ['里可林淘宝', '网林天猫']);
  assert.deepEqual(on.targets[0].candidates, ['REAPPLY_DATES']);
  assert.equal(on.humanOnly.length, 0);
});

test('⑨b：只要有一家「只能人上」⇒ 不许拦，整批照旧叫人', () => {
  // 登录掉了不是 agent 的活（它要的是登录，不是页面动作）。这一家在场 ⇒ 必须叫人。
  const summary = { date: ALERT_DATE, shops: { 里可林淘宝: agentActionableRecord(), 盖文淘宝: humanOnlyRecord() } };
  const on = planAlertDeferral({ summary, enabled: true });
  assert.equal(on.defer, false, '半批能救不是「都不用叫人」的理由');
  assert.equal(on.humanOnly.includes('盖文淘宝'), true, '要把「只能人上」的店带出来，好写进日志');
});

test('⑨b：一家都不够格时不 defer（那正是叫人场合，不是「拦下来但没派单」）', () => {
  const summary = { date: ALERT_DATE, shops: { 盖文淘宝: humanOnlyRecord() } };
  const on = planAlertDeferral({ summary, enabled: true });
  assert.equal(on.defer, false);
  assert.deepEqual(on.targets, []);
});

test('⑨b：全绿时闸门不参与（没有失败就没有「要不要叫人」这回事）', () => {
  const on = planAlertDeferral({ summary: { date: ALERT_DATE, shops: { 里可林淘宝: okRecord() } }, enabled: true });
  assert.equal(on.defer, false);
});

test('⑨b：整轮被体检拦住（failed 为空、roundBlocked）时不许 defer', () => {
  // 这一条的形态很容易漏：`view.any` 为真（体检没过），但 `failed` 是**空的**
  // —— 一家店的失败记录都还没有，因为整轮根本没开跑。
  // 此时若判成 defer，就等于「把整轮没跑这件事静默吞掉、还假装交给了 agent」，
  // 而 agent 那边一份派单都收不到（targets 为空）。必须照旧叫人。
  const summary = { date: ALERT_DATE, round: { healthCheckDaily: { ok: false, blocking: ['TARGET_PAGE_MISSING'] } },
    shops: { 里可林淘宝: okRecord() } };
  const on = planAlertDeferral({ summary, enabled: true });
  assert.equal(on.defer, false, '整轮没跑起来不是「agent 能救」，是「必须叫人」');
  assert.deepEqual(on.targets, []);
});

test('⑨b：CLI 开关默认关，给了才开', () => {
  assert.equal(parseArgs(['--date', DATE], { now: NOW }).deferAgentActionableAlert, false);
  assert.equal(parseArgs(['--date', DATE, '--defer-agent-actionable-alert'], { now: NOW }).deferAgentActionableAlert, true);
});

test('驱动：告警说的「第 N 步」与日志文件上的编号对得上', () => {
  assert.equal(stageNumber(SHOP, 'health-check'), 1);
  assert.equal(stageNumber(SHOP, 'shop-report'), 5);
  assert.equal(stageNumber(SHOP, 'push'), 7);
  assert.equal(stageNumber(SHOP, 'readback'), 11);
  assert.equal(stageNumber(SHOP, '不存在'), null, '认不出步号时返回 null，由文案写成「?」而不是编一个数字');
});

test('驱动的失败分类：体检拦住 / 重跑撞上已有行 / 阶段报错，三类必须分开', () => {
  assert.equal(shopFailureCause({ failedStage: 'health-check' }), 'SHOP_BLOCKED');
  assert.equal(shopFailureCause({ failedStage: 'push', failureOutput: 'x duplicate daily report row exists: r1' }), 'DUPLICATE_TARGET');
  // 别的阶段说同一句话不算「已经写过」：那只是某个脚本的措辞，不能拿来当结论
  assert.equal(shopFailureCause({ failedStage: 'backfill', failureOutput: 'duplicate daily report row exists' }), 'STAGE_FAILED');
  assert.equal(shopFailureCause({ failedStage: 'sycm-date' }), 'STAGE_FAILED');
  // 「这一项订购不在账号上」**优先于「停在哪一步」**：同一个现场若被报成「去窗口把页面补上」，
  // 收信人会白跑一趟浏览器，而问题不会好（2026-09-21 科塔现场就是这么被报错的）。
  // 判据是确定性名字，不是措辞猜测 —— 那个名字只在「问过平台、平台说 5903」时才会出现。
  assert.equal(shopFailureCause({ failedStage: 'sycm-date', failureOutput: 'SHOP_FUNC_NO_PERMISSION: 平台答复 code=5903' }),
    'SHOP_FUNC_NO_PERMISSION');
  assert.equal(shopFailureCause({ failedStage: 'health-check', failureOutput: 'Error: SHOP_FUNC_NO_PERMISSION: x' }),
    'SHOP_FUNC_NO_PERMISSION', '体检拦下来的同一条现场也要认得出，否则会被报成「去补页面」');
  assert.equal(shopFailureCause({}), 'STAGE_FAILED', '没写停在哪一步也要有结论（不能静默变成「没问题」）');
  const view = roundFailureSummary(mixedSummary());
  assert.equal(view.failed.length, 2);
  assert.deepEqual(view.ok, ['里可林淘宝']);
  assert.equal(view.any, true);
  assert.equal(roundFailureSummary({ shops: { 里可林淘宝: okRecord() } }).any, false, '全绿时不许认为有失败');
  assert.equal(roundFailureSummary({ round: { healthCheckDaily: { ok: false } }, shops: {} }).roundBlocked, true);
});

test('告警：标题自带主体名，正文说清哪几家没跑完、停在哪一步、哪几家已收完、哪几家一步没跑', () => {
  const text = renderedAlert(mixedSummary());
  assert.match(text, /【需要处理】/u, '有失败必须是「需要处理」，不是「提示」');
  assert.match(text, /【需要处理】2 家店的日报没收完（统计日 2026-09-19）/u, '标题要自带主体名与是哪一天');
  assert.match(text, /没跑完 2 家：/u);
  assert.match(text, /网林天猫—— 停在第 5 步（下载店铺日报）/u,
    '店名要能让人对上窗口；**账号名（`网林家居旗舰店:阿彦`）不进业务消息** —— 见下面「形状」那条');
  assert.match(text, /科塔淘宝.*停在第 7 步（写进飞书）/u);
  assert.match(text, /已收完 1 家：里可林淘宝/u, '收信人也要知道哪几家已经好了（不用重复跑）');
  // 「没跑完 1 家」与「另外 4 家一步都没跑」是两件事。少写这一行，收信人会以为今天收工了。
  assert.match(text, /另外 2 家今天一步都没跑/u, '默认「第一家失败即停整轮」⇒ 必须说清还有几家今天压根没开跑');
  assert.match(text, /盖文淘宝、盖文天猫/u);
  assert.match(text, /对象：日报一轮 · 5 家店/u, '家数要来自配置（这一轮该跑几家），不是从记录条数数出来的');
  assert.match(text, /告警编号：daily-round-20260919/u, '事后对账只有编号与时间能引用，不能省');

  // 整轮没跑起来是另一种情形：主语是「全部店铺」，而且要说清是哪一页不齐。
  // 这一条是 2026-09-19 真机干验证渲染出来才发现的：那时 shops 是空的，
  // 「对象」被数成了「日报一轮 · 0 家店」—— 收信人会以为今天根本没排店。
  const blocked = renderedAlert({
    round: { healthCheckDaily: { ok: false, blockingDetails: ['目标页面「飞书底单页」不在这个浏览器里（找到 0 个）；采集会从落位那一步就失败。'] } },
    shops: {},
  });
  assert.match(blocked, /全部店铺的日报都没跑起来（统计日 2026-09-19）/u);
  assert.match(blocked, /对象：日报一轮 · 5 家店/u, '家数要来自配置（这一轮该跑几家），不是从记录条数数出来的');
  assert.match(blocked, /目标页面「飞书底单页」不在这个浏览器里/u, '要指名道姓说缺哪一页，不能只说「体检没过」');
  assert.match(blocked, /飞书「各店铺日报」底单页/u, '下一步要说清去哪开、开哪两页');
  assert.equal(blocked.includes('另外'), false, '整轮没开跑时不存在「另外几家没跑」—— 全部都没跑，别写重');
});

test('告警：每条结论都有自己的「原因 + 下一步」，下一步只写收信人真能做的', () => {
  const text = renderedAlert(mixedSummary());
  assert.match(text, /下一步：/u);
  // 「窗口里缺页面」这一类才需要人去开窗口，所以「进哪个窗口」这句话要在那一类里出现
  const needsWindow = renderedAlert({ round: { healthCheckDaily: { ok: true } },
    shops: { 盖文淘宝: { status: 'failed', failedStage: 'health-check', stages: [] } } });
  assert.match(needsWindow, /日报采集窗口/u, '要告诉收信人进哪个窗口（他明天在屏幕上看到的就是这个标题）');

  // 「跑到一半停住」这一类**不给具体动作** —— 因为成因未知，猜一个（例如「去登录」）
  // 会让收信人白跑一趟浏览器，而实际问题不会好（2026-09-21 的现场是生意参谋页面停在昨天的渲染上）。
  const stalled = renderedAlert({ round: { healthCheckDaily: { ok: true } },
    shops: { 里可林淘宝: failedAt('sycm-date') } });
  assert.match(stalled, /跑到一半停住了/u);
  assert.match(stalled, /不需要你在浏览器里做什么/u, '成因未知时不许编一个「你去登录一下」的动作');
  assert.match(stalled, /转给技术同学/u, '要给出「什么时候找谁」这条可执行的出路');
  assert.equal(/人工登录/u.test(stalled), false, '不许把猜测的病因写成既定原因');

  // 「已经写过了」这一类**不许**给补跑命令 —— 那等于叫人重跑一天已经写好的数据
  const dup = renderedAlert({ round: { healthCheckDaily: { ok: true } }, shops: { 网林天猫: failedAt('push', 'duplicate daily report row exists: r1') } });
  assert.match(dup, /不用处理/u);
  assert.equal(dup.includes('补跑这一天的命令'), false, '「不用处理」不该带补跑命令');
  assert.equal(dup.includes('人工登录'), false, '「不用处理」不该叫人去登录（那是另一类现场要做的事）');
});

// 2026-09-21 修订：这条原来是**词表**判据（判据/幂等/fail-closed…），全绿，而真发出去的那条
// 正文里带着 `evidence\multi-shop-2026-09-20`、一整条 `node …/run-multi-shop-day.mjs --date … --commit --notify`、
// 机器名 `DESKTOP-KJP4RA5`、在线告警报错里的一段 URL —— 业务人员照样看不懂。
// 根因不是「词表漏了几个词」，而是**判据管的是词，泄漏的是形状**（路径、命令行、主机名、编号、账号名），
// 而且这些泄漏全在 `reason`/`action` 这些**自由文本**里：白名单只约束 `source` 的键，约束不到值。
// 所以判据改成两层：词表继续留着（便宜），另加「形状」扫描，且**扫的是告警对象自己的字段**，
// 不只是渲染后的文本 —— 渲染器可能吞字段（白名单静默丢键），对着渲染结果扫会漏掉被吞的部分。
const TECH_SHAPES = [
  [/[A-Za-z]:[\\/]/u, '盘符路径（如 `D:\\…`）'],
  [/(?:^|[^A-Za-z])(?:evidence|runtime|skills|scripts)[\\/]/u, '仓库内的相对目录（如 `evidence\\multi-shop-…`）'],
  [/(?:^|\s)--[a-z][a-z-]+/u, '命令行参数（如 `--commit`）'],
  [/(?:^|[\s`'"(/])node(?:\s|$|\.exe)/u, '命令行本体（`node …`）'],
  [/\b[A-Z][A-Z0-9]{2,}-[A-Z0-9]{4,}\b/u, '主机名形状（如 `DESKTOP-KJP4RA5`）'],
  [/https?:\/\//u, '链接（点了会走系统默认浏览器，到不了目标窗口那个实例，2026-09-19 实测）'],
];

test('告警：PAGE_OBSTRUCTED 的判据是那个**机器标记**，不是措辞猜测', () => {
  // 为什么单独立一条：上面那张 `cases` 表只要求「每一类都有一条样例」，
  // 把分类器里那一行删掉它照样绿（样例还是那张表里的那个对象，表格不负责分类）。
  // 也就是说「表格齐」与「分类器认得出」是两件事，必须分开守。
  assert.equal(shopFailureCause(failedAt('promotion-submit', `[遮挡] 没关掉\n${OVERLAY_NOT_DISMISSED_TOKEN}\n`)),
    'PAGE_OBSTRUCTED');
  // 反面：不带标记时**必须**落回兜底类 —— 否则「关不掉」会被误报成「需要人点一下」，
  // 而兜底那句说的是「这一轮不需要你在浏览器里做什么」（09-26 早上科塔就是这样被报错的）。
  assert.equal(shopFailureCause(failedAt('promotion-submit', '[遮挡] 关后回读：全屏层剩 2 个')), 'STAGE_FAILED');
  // 它也**不许**盖过 SHOP_FUNC_NO_PERMISSION：那一条决定「要不要去平台」，优先级最高。
  assert.equal(shopFailureCause(failedAt('sycm-date',
    `SHOP_FUNC_NO_PERMISSION\n${OVERLAY_NOT_DISMISSED_TOKEN}\n`)), 'SHOP_FUNC_NO_PERMISSION');
  // 人在浏览器里做的事只对这两类有意义（其余类别不驻留、不续跑）。
  assert.deepEqual([...HUMAN_REQUIRED_CAUSES], ['NEEDS_LOGIN', 'PAGE_OBSTRUCTED']);
});

test('告警：文案里不许出现英文阶段名、结论代号、内部术语，也不许出现路径/命令行/主机名/账号名', () => {
  const jargon = ['判据', '幂等', 'fail-closed', 'capability', '会话', '风控'];
  const blockedDetail = '目标页面「生意参谋工作页」不在这个浏览器里（按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）；采集会从落位那一步就失败。';
  const cases = {
    ROUND_BLOCKED: { round: { healthCheckDaily: { ok: false, blockingDetails: ['目标页面「飞书底单页」不在这个浏览器里（按片段 feishu.cn/base/xx 找到 0 个）；采集会从落位那一步就失败。'] } }, shops: {} },
    SHOP_BLOCKED: { round: { healthCheckDaily: { ok: true } }, shops: { 盖文淘宝: { status: 'failed', failedStage: 'health-check', blockingDetails: ['目标页面「阿里妈妈报表页」不在这个浏览器里（按片段 one.alimama.com/index.html 找到 0 个）；采集会从落位那一步就失败。'], stages: [] } } },
    // NEEDS_LOGIN 的判据不在 summary 里，在跑前那一次的结论里 ⇒ 它的样例要多一个入参（见 overrideFor）。
    NEEDS_LOGIN: { round: { healthCheckDaily: { ok: false, blockingDetails: [blockedDetail] } }, shops: {} },
    DUPLICATE_TARGET: { round: { healthCheckDaily: { ok: true } }, shops: { 科塔淘宝: failedAt('push', 'duplicate daily report row exists: r1') } },
    SHOP_FUNC_NO_PERMISSION: { round: { healthCheckDaily: { ok: true } }, shops: { 科塔淘宝: failedAt('sycm-date', 'Error: SHOP_FUNC_NO_PERMISSION: 平台答复 code=5903 No Buy Func Permission') } },
    // 2026-09-26 加。样例里必须**带上那个机器标记**（用常量，不写死字面量）——
    // 不带它的话 `shopFailureCause` 会把它归成 STAGE_FAILED，这一条就成了「用兜底文案考兜底文案」，
    // 全绿而什么都没守住。
    PAGE_OBSTRUCTED: { round: { healthCheckDaily: { ok: true } },
      shops: { 科塔淘宝: failedAt('promotion-submit', `[遮挡] 关后回读：全屏层剩 2 个 ⇒ 没关掉\n${OVERLAY_NOT_DISMISSED_TOKEN}\n`) } },
    STAGE_FAILED: { round: { healthCheckDaily: { ok: true } }, shops: { 里可林淘宝: failedAt('promotion-fetch', 'Error: expected one 生成成功 row, got 0') } },
  };
  assert.deepEqual(Object.keys(cases).sort(), [...FAILURE_CAUSES].sort(),
    '每一条结论都要在这里被渲染一次（漏一条 = 新一类术语味告警没人守）');
  const LOGIN_OVERRIDE = {
    loginPreflight: {
      verdict: 'NEEDS_LOGIN', checked: 5, unknown: [],
      needHuman: [{ shop: '科塔淘宝', sites: ['sycm', 'alimama'] }],
    },
  };
  const overrideFor = (cause) => (cause === 'NEEDS_LOGIN' ? LOGIN_OVERRIDE : {});

  // 账号名是**数据**，所以从登记表取真值来扫 —— 写死几个样例只能挡住已经出现过的那两个。
  const accountNames = ALERT_SHOP_KEYS.map((key) => shopIdentity(key).alimamaMemberName).filter(Boolean);
  assert.ok(accountNames.length >= 2, '登记表里读不到账号名，这条判据会形同虚设');

  for (const [cause, summary] of Object.entries(cases)) {
    const alert = buildAlert(summary, overrideFor(cause));
    const text = renderedAlert(summary, overrideFor(cause));
    // 收信人看得到的**自由文本**（这几段是泄漏实际发生的地方）
    const freeText = [alert.title, alert.reason, alert.action].filter(Boolean).join('\n');
    const haystacks = [['正文', text], ['自由文本字段', freeText]];

    assert.equal('evidence' in alert, false, `${cause} 又给了 evidence —— 运行日志目录是技术串，不该进业务消息`);
    assert.equal('machine' in (alert.source ?? {}), false, `${cause} 又把机器名塞回 source 了（白名单里真有这个键，给了就会原样渲染出去）`);

    for (const [where, hay] of haystacks) {
      assert.equal(hay.includes(cause), false, `${cause} 这个结论代号不该出现在${where}里`);
      for (const stage of STAGE_NAMES) {
        assert.equal(hay.includes(stage), false, `${cause} 的${where}里出现了英文阶段名「${stage}」`);
      }
      for (const word of jargon) {
        assert.equal(hay.includes(word), false, `${cause} 的${where}里出现了内部术语「${word}」`);
      }
      for (const [pattern, label] of TECH_SHAPES) {
        const hit = hay.match(pattern);
        assert.equal(Boolean(hit), false, `${cause} 的${where}里出现了${label}：${hit?.[0] ?? ''}`);
      }
      for (const account of accountNames) {
        assert.equal(hay.includes(account), false, `${cause} 的${where}里出现了账号名「${account}」（会被转发到群/邮件，是泄露面）`);
      }
    }
    assert.match(text, /统计日 2026-09-19/u, `${cause} 的文案没说是哪一天的数据`);
  }
});

test('告警：缺 shopKeys 直接抛（那一行静默消失过，所以不留退化余地）', () => {
  assert.throws(() => buildRoundFailureAlert({ date: ALERT_DATE, summary: mixedSummary(), now: alertNow }),
    /必须拿到 shopKeys/u, '缺参数要当场抛，不许退化成「那一行不显示」');
  assert.throws(() => buildRoundFailureAlert({ date: ALERT_DATE, summary: mixedSummary(), shopKeys: [], now: alertNow }),
    /必须拿到 shopKeys/u, '空数组同样不许 —— 那会渲染成「日报一轮 · 0 家店」');
  assert.doesNotThrow(() => buildAlert(mixedSummary()));
});

test('驱动：每个生成告警的调用点都真的把 shopKeys 与登录态结论接上了（接线判据）', () => {
  // 为什么单独立一条：`buildRoundFailureAlert` 自己的用例全部通过，而**两个调用点漏传 shopKeys**
  // ⇒「另外 N 家今天一步都没跑」那一行静默消失（2026-09-21 实测：改动被静默丢失 + 没有一条用例走这条接线）。
  // 用例里手建的对象再对，接线漏了也白搭 —— 这一类缺陷只有「从失败现场真跑一遍」才拦得住，
  // 这条源码扫描只是**便宜的第二道门**（第一道是函数缺参数就抛，运行时才响）。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  const calls = [...source.matchAll(/^\s*alert: buildRoundFailureAlert\(\{([^}]*)\}/gmu)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `只扫到 ${calls.length} 个调用点 —— 正则认不出真实接线，这条判据就没意义`);
  for (const args of calls) {
    assert.match(args, /shopKeys/u, `调用点没给 shopKeys：${args.trim()}`);
    // 同一条理由：漏传 loginPreflight 的症状也是静默的 —— 告警照发，只是永远说
    // 「这一轮没有先查登录态」，于是这条修复在真机上等于没做。
    assert.match(args, /loginPreflight/u,
      `调用点没把跑前登录态结论接上：${args.trim()}（症状：告警永远说「这一轮没有先查登录态」）`);
    assert.equal(/machine|logDir|evidence/u.test(args), false, `调用点还在传技术字段：${args.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// 跑前登录态结论（2026-09-23 用户拍板「1.改」）。
//
// 为什么值得单独立一节：链的第 0 步体检只答「页面够不够」，而「页面被弹回登录页」与
// 「页签被关掉」在它眼里**同形** ⇒ 掉登录时告警给的是「把这两页各开一个」，收信人照着做无效。
// 这里守的就是「别再说错那句话」，以及「没查过时不许假装查过」。
// ---------------------------------------------------------------------------
const BLOCKED_SUMMARY = () => ({
  round: {
    healthCheckDaily: {
      ok: false,
      blocking: ['TARGET_PAGE_MISSING'],
      blockingDetails: ['目标页面「生意参谋工作页」不在这个浏览器里（按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）；采集会从落位那一步就失败。'],
    },
  },
  shops: {},
});
const loginPre = (needHuman, unknown = [], verdict = null) => normalizeLoginPreflight({
  verdict: verdict ?? (needHuman.length ? 'NEEDS_LOGIN' : unknown.length ? 'INCONCLUSIVE' : 'ALL_IN'),
  checked: 5, needHuman, unknown,
});

test('告警：查过登录态、有店掉了 ⇒ 改成「去登录」，不再叫人去开页面', () => {
  const summary = BLOCKED_SUMMARY();
  const text = renderedAlert(summary, {
    loginPreflight: loginPre([{ shop: '里可林淘宝', sites: ['sycm', 'alimama'] }, { shop: '网林天猫', sites: ['sycm'] }]),
  });
  assert.match(text, /掉登录/u);
  assert.match(text, /里可林淘宝（生意参谋、阿里妈妈）/u,
    '平台名要按店分别说（用户口径：提到某家店必须按平台分别说名字）');
  assert.match(text, /网林天猫（生意参谋）/u);
  assert.match(text, /重新登录/u);
  // **这条修复的全部目的**：掉登录时「把这两页各开一个」是无效动作，必须消失。
  assert.equal(text.includes('把这两页各开一个'), false,
    '掉登录时还在叫人去开页面 —— 收信人会白跑一趟，而问题不会好');
  assert.match(text, /上面那条「页面不齐」就是这么来的/u, '要把「页面不齐」与掉登录的因果挑明');
});

test('告警：这一家是「页面不齐」判下来的、而它的登录掉了 ⇒ 这一家的结论也要改成「去登录」', () => {
  // 上面那条守的是**整轮**那一层；这条守**店里**那一层。
  // 链对每一家店的第 1 步也是页面体检，它同样只看「页面在不在」—— 掉登录时那个页面
  // 就是被弹回了登录页，所以「页面不齐」在这一家身上也只是症状。
  const summary = {
    round: { healthCheckDaily: { ok: true } },
    shops: {
      盖文淘宝: {
        status: 'failed', failedStage: 'health-check', stages: [],
        blockingDetails: ['目标页面「生意参谋工作页」不在这个浏览器里（按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）；采集会从落位那一步就失败。'],
      },
    },
  };
  const text = renderedAlert(summary, { loginPreflight: loginPre([{ shop: '盖文淘宝', sites: ['sycm'] }]) });
  assert.match(text, /这家店的后台掉登录了/u, '这一家的原因要换成「掉登录」');
  assert.match(text, /重新登录/u);
  assert.equal(text.includes('把缺的页面补上'), false,
    '掉登录时「把缺的页面补上」同样是无效动作：补了也会被送回登录页');
  // 反过来：掉登录的**不是**这一家 ⇒ 这一家仍然按「页面不齐」处置（不许张冠李戴）。
  const other = renderedAlert(summary, { loginPreflight: loginPre([{ shop: '里可林淘宝', sites: ['sycm'] }]) });
  assert.match(other, /这家店的专用窗口里页面不齐/u);
  assert.match(other, /里可林淘宝（生意参谋）掉登录了/u);
  assert.equal(other.includes('盖文淘宝（生意参谋）'), false, '这一家没掉登录，不许被算进去');
});

test('告警：没查过登录态 ⇒ 如实说「没查过」，不许装作查过、也不许说「都不缺」', () => {
  const summary = BLOCKED_SUMMARY();
  for (const overrides of [{}, { loginPreflight: null }]) {
    const text = renderedAlert(summary, overrides);
    assert.match(text, /没有先查登录态/u, '「没查」必须说出来：它是这条链今天与昨天的差别所在');
    assert.equal(text.includes('掉登录了'), false, '没查过就不许说谁掉了登录');
    assert.match(text, /把这两页各开一个/u, '没查过时按原来的处置走（它仍然是对的可能性之一）');
  }
});

test('告警：查了、都在登录态 ⇒ 明确说「问题不在登录上」（省掉一趟白跑的浏览器）', () => {
  const text = renderedAlert(BLOCKED_SUMMARY(), { loginPreflight: loginPre([]) });
  assert.match(text, /都在登录态/u);
  assert.match(text, /问题不在登录上/u);
  assert.equal(text.includes('掉登录了'), false);
});

test('告警：查过但没有结论 / 结论读不到 ⇒ 如实说「不知道是不是掉登录」', () => {
  const inconclusive = renderedAlert(BLOCKED_SUMMARY(), {
    loginPreflight: loginPre([], [{ shop: '盖文淘宝', sites: ['alimama'] }]),
  });
  assert.match(inconclusive, /没读出结论/u);
  assert.match(inconclusive, /盖文淘宝（阿里妈妈）/u);

  const unreadable = renderedAlert(BLOCKED_SUMMARY(), {
    loginPreflight: { verdict: null, needHuman: [], unknown: [], checked: null, unreadable: true },
  });
  assert.match(unreadable, /结论没读出来/u);
  assert.equal(unreadable.includes('都在登录态'), false, '结论丢了不许说成「都好的」');
});

test('告警：登录态结论只留本轮要跑的那几家（分批时不许点名别的店）', () => {
  const summary = BLOCKED_SUMMARY();
  // 体检一次查了五家（里可林掉了），而这一轮只跑盖文那两家 ⇒ 告警不该提里可林。
  const text = renderedAlert(summary, {
    loginPreflight: loginPre([{ shop: '里可林淘宝', sites: ['sycm'] }]),
    shopKeys: ['盖文淘宝', '盖文天猫'],
  });
  assert.equal(text.includes('里可林淘宝'), false, '这一轮没跑那家店，点名它只会让收信人困惑');
  assert.match(text, /这一轮的店都不缺登录；掉登录的是别的店/u,
    '「有店掉了、但不是这几家」也必须说出来 —— 沉默会被读成「查过没问题」');
  // 反过来：掉的就是这一轮的店 ⇒ 必须点名。
  const hit = renderedAlert(summary, {
    loginPreflight: loginPre([{ shop: '盖文淘宝', sites: ['sycm'] }]),
    shopKeys: ['盖文淘宝', '盖文天猫'],
  });
  assert.match(hit, /盖文淘宝（生意参谋）掉登录了/u);
});

test('跑前登录态结论的读取：不给＝没查、读不到＝没结论、读到＝只留业务能用的字段', () => {
  assert.equal(readLoginPreflight(null), null, '不给路径 ＝ 这一轮没查过（不是「都不缺」）');
  assert.equal(readLoginPreflight(''), null);
  assert.deepEqual(readLoginPreflight(path.join(tmpdir(), 'sycm-绝对不存在-的结论.json')),
    { verdict: null, needHuman: [], unknown: [], checked: null, unreadable: true },
    '路径给了但读不到 ⇒ 「本来要查、结论没读出来」，不许折成「没查」');

  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sycm-login-pre-')), 'login-preflight.json');
  writeFileSync(file, JSON.stringify({
    machine: 'DESKTOP-KJP4RA5',
    verdict: 'NEEDS_LOGIN',
    checked: 5,
    needHuman: [{ shop: '里可林淘宝', sites: ['sycm', '不认识的平台'] }],
    unknown: [],
    rows: [{ shop: '里可林淘宝', href: 'https://sycm.taobao.com/custom/login.htm?_target=x' }],
  }, null, 1), 'utf8');
  const seen = readLoginPreflight(file);
  assert.equal(seen.verdict, 'NEEDS_LOGIN');
  assert.deepEqual(seen.needHuman, [{ shop: '里可林淘宝', sites: ['sycm'] }],
    '认不出来的平台键要丢掉（那会是一串英文原样发出去）');
  assert.equal(JSON.stringify(seen).includes('DESKTOP'), false, '机器名不许跟着结论走下去');
  assert.equal(JSON.stringify(seen).includes('href'), false, '探针读到的页面地址是技术串');

  // 文件内容是 `null` / 数组 / 半截 JSON ⇒ 一律算「没结论」。折成「没查」会让
  // 「本来要查、结论丢了」这件事从现在这条链上彻底消失。
  for (const broken of ['null', '[1,2]', '{不是 JSON', '']) {
    writeFileSync(file, broken, 'utf8');
    assert.equal(readLoginPreflight(file).unreadable, true, `${JSON.stringify(broken)} 应当算「读不出来」`);
  }
});

test('驱动：不给登录态结论时，roundFailureSummary 的输出**逐字不变**', () => {
  // 「默认不变」是这层唯一的安全保证：多一个键都会让「今天与昨天不一样」而没人知道。
  const summary = mixedSummary();
  const bare = roundFailureSummary(summary);
  assert.equal(Object.hasOwn(bare, 'login'), false);
  assert.deepEqual(bare, roundFailureSummary(summary, {}));
  assert.deepEqual(bare, roundFailureSummary(summary, { loginPreflight: null }));
  assert.equal(bare.any, true);

  // ⚠️ `[]` 与 `null` 是**两件事**：`null` ＝「没查」，`[]` ＝「查了、零家」。
  const empty = roundFailureSummary(summary, { loginPreflight: loginPre([]) });
  assert.equal(Object.hasOwn(empty, 'login'), true);
  assert.equal(empty.any, bare.any, '登录态结论不许把「全绿」翻成「有失败」');
  const allGreen = roundFailureSummary({ shops: { 里可林淘宝: okRecord() } }, { loginPreflight: loginPre([]) });
  assert.equal(allGreen.any, false, '店都收完了就没人要叫人 —— 登录态结论不是失败');
});

test('驱动 CLI：--login-preflight 要一个路径，缺值当场抛（不许静默折成「没查」）', () => {
  assert.equal(parseArgs(['--date', DATE]).loginPreflight, null, '默认不问登录态（手动排障那条命令的形态）');
  assert.equal(parseArgs(['--date', DATE, '--login-preflight', 'x.json']).loginPreflight, 'x.json');
  for (const argv of [['--date', DATE, '--login-preflight'], ['--date', DATE, '--login-preflight', '--commit']]) {
    assert.throws(() => parseArgs(argv), /需要一个结论文件路径/u,
      '缺值静默折成「没查」＝ 这条修复在最需要它的那天不生效，而且看不出来');
  }
});

test('告警：技术字段在**生成处**就被拦（而不是等渲染时静默丢掉或被原样发出去）', () => {
  // 白名单是给全仓共用渲染器定的，里面确实有给技术同学用的键（machine/browserProfile/loginUrl）
  // ⇒ 「这条链的收信人是运营」这件事只能由生成处保证。用例只在上 CI 时红，而消息可能先被手跑发出去。
  assert.throws(() => assertAlertIsBusinessReadable({ title: 'x', source: { machine: 'DESKTOP-KJP4RA5' } }),
    /不该给业务收信人看/u);
  assert.throws(() => assertAlertIsBusinessReadable({ title: 'x', machineName: 'x' }), /不该给业务收信人看/u,
    '变体写法（machineName）也要拦：判据是「包含」不是「相等」');
  assert.throws(() => assertAlertIsBusinessReadable({ title: 'x', evidence: { artifacts: ['evidence/a'] } }),
    /不该给业务收信人看/u);
  assert.throws(() => assertAlertIsBusinessReadable({ title: 'x', source: { 我编的字段: 'v' } }),
    /渲染器不认识的键/u, '名字不在白名单里的 source 键会被静默丢掉 —— 那等于「以为发了、其实没有」');
  assert.doesNotThrow(() => assertAlertIsBusinessReadable(buildAlert(mixedSummary())), '正常那条必须放行');
});

test('告警：全绿时生成告警要当场抛错（成功时不许叫人）', () => {
  assert.throws(() => buildAlert({ round: { healthCheckDaily: { ok: true } }, shops: { 里可林淘宝: okRecord() } }),
    /成功时不许叫人/u);
  assert.throws(() => buildAlert({ shops: {} }), /成功时不许叫人/u, '一轮没跑任何店也不算「有失败」');
});

test('驱动：--notify 只在 --commit 那一档投递；排练/只读核对的失败不进飞书', () => {
  assert.equal(resolveAlertDispatch({ notify: true, mode: 'commit' }).action, 'send');
  // 排练失败的提醒发到飞书会训练人忽略这个通道 —— 而它是唯一会叫人动手的通道
  assert.equal(resolveAlertDispatch({ notify: true, mode: 'rehearse' }).action, 'off');
  assert.equal(resolveAlertDispatch({ notify: true, mode: 'verify' }).action, 'off');
  assert.equal(resolveAlertDispatch({ mode: 'commit' }).action, 'off', '不给 --notify 就默认安静');
  assert.equal(resolveAlertDispatch({ notifyPrint: true, mode: 'commit' }).action, 'print');
  assert.equal(resolveAlertDispatch({ notifyPrint: true, mode: 'rehearse' }).action, 'print', '--notify-print 是「只想看文案」，与模式无关');
  assert.equal(resolveAlertDispatch({ notify: true, notifyPrint: true, mode: 'commit' }).action, 'print',
    '两个都给时以「不投递」为准（宁可少发一条，不可多发一条）');
  for (const input of [{ notify: true, mode: 'commit' }, { notify: true, mode: 'rehearse' }, { mode: 'rehearse' }]) {
    assert.ok(resolveAlertDispatch(input).why, '每种情形都要有一句人看得懂的原因（安静也要说清为什么安静）');
  }
});

test('驱动：打印路径一次投递都不发生，且打印的是真渲染器的输出', () => {
  let calls = 0;
  const lines = [];
  const result = dispatchRoundAlert({
    alert: buildAlert(mixedSummary()),
    dispatch: { action: 'print', why: '--notify-print：只打印不投递' },
    spawn: () => { calls += 1; return { status: 0 }; },
    throttleFile: tmpThrottle(),
    log: (line) => lines.push(line),
  });
  assert.equal(calls, 0, '--notify-print 绝不许真的投递');
  assert.deepEqual(result, { delivered: false, printed: true });
  const printed = lines.join('\n');
  assert.ok(printed.includes('【需要处理】2 家店的日报没收完'), '打印的必须是真渲染器的输出，不是自己拼的一份');
  assert.ok(printed.includes('daily-round-20260919'));
});

test('驱动：action=off 时**一个字都不发**（这条判据必须活在出口里，不许只挂在调用点）', () => {
  // 2026-09-26 补。此前 `dispatchRoundAlert` **没有** off 分支：传 off 会直接落到下面的
  // 去重与投递（去重只按编号/指纹判「最近发过没」，它不读 `dispatch`）⇒ 一个「没让发」的调用
  // 会真发一条飞书出去。当时没炸，只因为两个调用点各自在调用前写了
  // `if (alertDispatch.action !== 'off')` —— 也就是这条判据活在**调用方**。
  // 第三个调用点（`scripts/hold-and-resume.mjs`）差一点就成了那个漏一处的地方。
  let calls = 0;
  const lines = [];
  const result = dispatchRoundAlert({
    alert: buildAlert(mixedSummary()),
    dispatch: resolveAlertDispatch({ notify: false, notifyPrint: false, mode: 'commit' }),
    spawn: () => { calls += 1; return { status: 0 }; },
    throttleFile: tmpThrottle(),
    log: (line) => lines.push(line),
  });
  assert.equal(calls, 0, 'off 档绝不许真的投递 —— 这正是缺了那个分支时会发生的错');
  assert.equal(result.delivered, false);
  assert.equal(result.off, true);
  // 文案照旧进日志：事后要能对上「他本来会看到什么」，这一条不能因为不发就丢掉。
  assert.ok(lines.join('\n').includes('daily-round-20260919'), 'off 档也要把收信人会看到的文案打进日志');
  assert.ok(lines.join('\n').includes('没有打开告警'), '安静也要说清为什么安静');
});

test('驱动：真正投递时走既有的通知出口，且「没送达」要被当回事', () => {
  const alert = buildAlert(mixedSummary());
  const seen = {};
  const delivered = dispatchRoundAlert({
    alert, dispatch: { action: 'send', why: 'x' }, log: () => {},
    throttleFile: tmpThrottle(),
    // 告警 JSON 已改成走 `--alert-file`（stdin 管道会被宿主沙箱掐断），所以在 spawn 这一刻
    // 把它从文件里读出来 —— 文件是在 spawn **返回之后**才删的，这个时点它一定还在。
    spawn: (cmd, argv, options) => {
      Object.assign(seen, { cmd, argv, options, alert: JSON.parse(readFileSync(argv[2], 'utf8')) });
      return { status: 0, stdout: '{"status":"SENT","messageId":"om_x"}' };
    },
  });
  assert.deepEqual(delivered, { delivered: true, printed: false, suppressed: false });
  assert.equal(seen.cmd, process.execPath);
  assert.match(seen.argv[0], /runtime[\\/]notify-feishu\.mjs$/u,
    '告警必须走这个仓库既有的投递出口，不许另造一条（另造的那条没有「没送达就非零退出码」的性质）');
  assert.equal(seen.argv[1], '--alert-file',
    '告警 JSON 必须走文件而不是 stdin：`input:` 会隐式给子进程建 stdin 管道，'
      + '而管道 stdin 的同步 spawn 会被宿主沙箱掐成 EBUSY —— 那条路断了就等于「出事时一条告警都发不出去」');
  assert.deepEqual(seen.options.stdio, ['ignore', 'pipe', 'pipe'],
    'stdio 必须显式声明，且 stdin 不许是管道（默认值就是被掐的那一形态）');
  assert.equal(seen.alert.alertId, 'daily-round-20260919', '喂进去的必须是这条告警的 JSON');
  assert.equal(seen.alert.type, 'DAILY_ROUND_FAILED');

  const notDelivered = dispatchRoundAlert({
    alert, dispatch: { action: 'send', why: 'x' }, logDir: ALERT_LOG_DIR, log: () => {},
    throttleFile: tmpThrottle(),
    spawn: () => ({ status: 1, stderr: 'NOT_CONFIGURED' }),
  });
  assert.equal(notDelivered.delivered, false, '投递失败不许记成送达');
});

test('驱动：跑前环境自检要把「宿主掐断」与「数据问题」当场分开', () => {
  // 掐断那一档：spawnSync 返回的是**错误对象**（不是非零退出码）。文案里必须点名
  // 「这是宿主执行环境限制，不是数据问题」——否则读日志的人会去查采集脚本，方向就反了。
  const blocked = probeSyncSpawnSanity({
    spawn: () => ({ error: Object.assign(new Error('spawnSync node.exe EBUSY'), { code: 'EBUSY' }) }),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, 'EBUSY');
  assert.match(blocked.line, /不是数据问题/u, '必须把归因写死在文案里，而不是留给读日志的人猜');
  assert.match(blocked.line, /EBUSY/u, '错误码要露出来（它是这条判据的原始证据）');

  // 正常那一档：说清楚「这一轮不会因 EBUSY 失败」，而不是留白让人以为没查。
  const ok = probeSyncSpawnSanity({ spawn: () => ({ status: 0, stdout: '' }) });
  assert.equal(ok.blocked, false);
  assert.match(ok.line, /不会因 EBUSY 失败/u, '正常也要有一句明确的结论（安静不等于没查）');
});

test('驱动：环境自检的探针必须探「管道 stdin」那一形态，且只许跑一个什么都不做的子进程', () => {
  let seen = null;
  probeSyncSpawnSanity({ spawn: (cmd, argv, options) => { seen = { cmd, argv, options }; return { status: 0 }; } });
  assert.deepEqual(seen.options.stdio, ['pipe', 'pipe', 'pipe'],
    '探针必须是**被掐的那一形态**（管道 stdin）—— 用 ignore 去探永远绿，测不出任何东西');
  assert.deepEqual(seen.argv, ['-e', '0'], '探针只许跑一个空转的子进程（只读、无副作用）');
});

test('驱动：两个同步子进程调用点必须显式声明 stdio，且 stdin 不许是管道（源码级接线判据）', () => {
  // 为什么用源码扫描而不是行为断言：这两个调用点在函数体深处，行为级要真起子进程才测得到；
  // 而「宿主沙箱掐断」这一环境下行为级判据本身可能就是假的（函数级用例全绿 ≠ 接线接上了）。
  // 这一条治的正是那个形态：把 stdio 删掉、或把告警换回 `input:` 时当场红。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  assert.match(source,
    /spawnSync\(NODE, \[scriptPath, \.\.\.stage\.argv\], \{[\s\S]{0,600}?stdio: \['ignore', 'pipe', 'pipe'\]/u,
    '每个采集/写入阶段都必须以 stdio [ignore,pipe,pipe] 起子进程 —— 默认值（三根都是管道）会被宿主沙箱掐成 EBUSY');
  assert.ok(!/input: JSON\.stringify\(alert\)/u.test(source),
    '告警 JSON 不许走 stdin（`input:`）—— 它会隐式建 stdin 管道，改走 --alert-file');
  assert.match(source, /\[NOTIFY_CLI, '--alert-file', alertPath\]/u,
    '告警必须走 notify-feishu.mjs 既有的 --alert-file 入口');
  // 环境自检必须排在**整轮体检之前**：它是「宿主掐断」与「数据坏了」在日志里的唯一分界，
  // 排在体检之后就等于「已经按业务问题排查了一半，才看到那句解释」。
  const selfCheckAt = source.indexOf('probeSyncSpawnSanity().line');
  const healthAt = source.indexOf('await runHealthCheck({');
  assert.ok(selfCheckAt > 0 && healthAt > 0 && selfCheckAt < healthAt,
    `环境自检必须打在整轮体检之前（自检在 ${selfCheckAt}、体检在 ${healthAt}）`);
  // 光修驱动那一层**不够**：实测这个限制**穿透到孙进程**（用 ['ignore','pipe','pipe']
  // 起起来的子进程，它自己再做默认 stdio 的同步 spawn 照样 EBUSY）。
  // 而第 7 步 push 跑的 run-daily-report.mjs 内部就有一个同步子进程（`py extract-sources.py`）——
  // 它一死，整轮在**第一次真的往飞书写字之前**停住，前面六个阶段的采集全白做。
  const pushSource = readFileSync(path.join(SCRIPTS_DIR, 'run-daily-report.mjs'), 'utf8');
  assert.match(pushSource,
    /spawnSync\(python, pythonArgs, \{[\s\S]{0,700}?stdio: \['ignore', 'pipe', 'pipe'\]/u,
    'push 阶段内部那个 `py extract-sources.py` 也必须以 stdio [ignore,pipe,pipe] 起：'
      + '宿主沙箱的限制会穿透到孙进程，只修驱动那一层整轮还是会死在第一次飞书写入之前');
});

// 去重判据本身的用例**不在这里**：它 2026-09-24 随实现在 `runtime/alert-throttle.mjs`
// 一起搬到了 `runtime/alert-throttle.test.mjs`（判据现在被两条链共用，只有那一层测得到
// 「两条链写同一个文件」这件事）。这里只留本驱动自己的投递口径。

test('驱动：重复的那条只打在本机日志里，一次投递都不发生；且只有真送出去才记时间', () => {
  const throttleFile = tmpThrottle();
  const sentAt = new Date('2026-09-20T02:00:00Z');
  const alert = buildAlert(mixedSummary());
  const lines = [];
  let calls = 0;
  const spawnOk = () => { calls += 1; return { status: 0, stdout: '{"status":"SENT"}' }; };

  // 第一次：真发，并且把「发过了」记下来
  const first = dispatchRoundAlert({ alert, dispatch: { action: 'send', why: 'x' }, spawn: spawnOk,
    throttleFile, now: () => sentAt, log: (line) => lines.push(line) });
  assert.equal(first.delivered, true);
  assert.equal(calls, 1);
  const recorded = JSON.parse(readFileSync(throttleFile, 'utf8'));
  assert.equal(recorded.alertId, alert.alertId);
  assert.equal(recorded.fingerprint, alert.fingerprint, '记的是「停在哪」的指纹，不是一个笼统的「发过」');

  // 第二次（同一轮重跑、停在同一个地方）：不投递，但**文案照样打进本机日志** ——
  // 技术串已经从业务消息里撤掉了，job.log 成了事后唯一能对上「他到底看到了什么」的地方。
  const second = dispatchRoundAlert({ alert, dispatch: { action: 'send', why: 'x' }, spawn: spawnOk,
    throttleFile, now: () => new Date('2026-09-20T02:30:00Z'), log: (line) => lines.push(line) });
  assert.deepEqual(second, { delivered: false, suppressed: true, reason: second.reason });
  assert.equal(calls, 1, '窗口内不许再投递一次');
  assert.ok(lines.join('\n').includes('【需要处理】2 家店的日报没收完'), '被挡下的那条也要留下完整文案');

  // 没送出去**不许记账**：记了，下一次真跑就会被自己的记录挡掉（静默漏报）。
  const failedFile = tmpThrottle();
  dispatchRoundAlert({ alert, dispatch: { action: 'send', why: 'x' }, throttleFile: failedFile,
    spawn: () => ({ status: 1, stderr: 'NOT_CONFIGURED' }), log: () => {} });
  assert.throws(() => readFileSync(failedFile, 'utf8'), '投递失败不该留节流记录');
});

// ------------------------------------------- 失败路径的收尾（2026-09-21 补，第一性原理那一轮的落地）

const SYCM_OK_URL = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const SYCM_DRIFTED_URL = 'https://sycm.taobao.com/lyone/auto_analysis/datafetch/index.htm?taskId=1';
const SYCM_PORTAL_URL = 'https://sycm.taobao.com/portal/home.htm';
const ALIMAMA_PAGE_URL = 'https://one.alimama.com/index.htm#/report/account';

const targetsOf = (...urls) => urls.map((url, i) => ({ type: 'page', url, targetId: `t${i}` }));

test('失败收尾：页面快照按期望清单数，并把「不属于期望清单」的那些页单独列出来', () => {
  const expected = expectedPagesForShop();
  const snap = describePageWhereabouts([
    ...targetsOf(SYCM_PORTAL_URL, SYCM_DRIFTED_URL, ALIMAMA_PAGE_URL),
    { type: 'other', url: 'devtools://devtools/bundled/x.html' },
  ], expected);
  const byName = Object.fromEntries(snap.slots.map((slot) => [slot.page, slot.count]));

  assert.equal(snap.tabs, 3, '只数 page 类型的页签');
  assert.equal(byName['生意参谋工作页'], 0, '漂到报表预览页就不算在位 —— 它已经认不出那个片段了');
  assert.equal(byName['阿里妈妈报表页'], 1);
  assert.deepEqual(snap.foreign, [SYCM_PORTAL_URL, SYCM_DRIFTED_URL],
    'foreign 正是「缺页时它到底漂到哪儿去了」的答案；回位会把它擦掉，所以必须留');
  assert.deepEqual(describePageWhereabouts(null, expected).slots.map((slot) => slot.count), [0, 0],
    '代理读不到时传 null 也要给出形状（由 judgeResetLanded 负责把「读不到」和「0 个」分开）');
});

test('失败收尾：回位判定只看回位之后那份快照，读不到一律不算回位成功', () => {
  const expected = expectedPagesForShop();
  const drifted = describePageWhereabouts(targetsOf(SYCM_DRIFTED_URL), expected);
  const landed = describePageWhereabouts(targetsOf(SYCM_OK_URL, ALIMAMA_PAGE_URL), expected);
  const two = describePageWhereabouts(targetsOf(SYCM_OK_URL, SYCM_OK_URL), expected);

  assert.equal(judgeResetLanded({ before: drifted, after: landed }).restored, true);
  assert.equal(judgeResetLanded({ before: landed, after: landed }).restored, true,
    '本来就位也算就位（那一支回位会报 action=none）');

  const bad = judgeResetLanded({ before: two, after: two });
  assert.equal(bad.restored, false, '两个工作页不算就位 —— 下一轮体检会拦在这里（宁可不放行）');
  assert.equal(bad.beforeCount, 2, '判定要带上「回位前几个」，否则看不出它有没有变好');

  const unreadable = judgeResetLanded({ before: drifted, after: null });
  assert.equal(unreadable.restored, false);
  assert.match(unreadable.detail, /读不到/u,
    '读不到要说「读不到」，不许退化成「0 个」—— 那是把「不知道」说成了坏消息');
});

test('失败收尾：先取证再处置、回位后断言、回位失败不抛也不盖原来那个错', async () => {
  const logDir = mkdtempSync(path.join(tmpdir(), 'sycm-recovery-'));
  const queue = [
    targetsOf(SYCM_DRIFTED_URL, ALIMAMA_PAGE_URL),   // 停手时：工作页漂到预览页
    targetsOf(SYCM_OK_URL, ALIMAMA_PAGE_URL),        // 回位后：回来一个
  ];
  const ok = await recoverFailedShop({
    shopKey: SHOP, logDir, repoRoot: REPO_ROOT,
    readTargets: () => Promise.resolve(queue.shift() ?? null),
    reset: (options) => { options.log('【假回位】'); return Promise.resolve({ action: 'navigated' }); },
  });

  assert.equal(ok.action, 'navigated');
  assert.equal(ok.restored, true);
  assert.equal(ok.leftAt.slots[0].count, 0, '停手时的快照');
  assert.equal(ok.after.slots[0].count, 1, '回位后的快照');
  assert.deepEqual(ok.leftAt.foreign, [SYCM_DRIFTED_URL], '「停手时漂到哪」必须留下来');
  assert.equal(ok.error, null);

  // 顺序判据靠日志正文（这不是形式主义：反过来的话，下一轮的起点就没人知道了）
  const text = readFileSync(path.join(logDir, '99-recovery.txt'), 'utf8');
  assert.ok(text.indexOf('停手时页面停在') < text.indexOf('【假回位】'), '取证必须先于处置');
  assert.ok(text.indexOf('【假回位】') < text.indexOf('回位后'), '断言必须在处置之后');

  // 回位自己炸：只记不抛 —— 抛出去会盖掉「这一轮为什么失败」，那才是主线
  const boom = await recoverFailedShop({
    shopKey: SHOP, logDir, repoRoot: REPO_ROOT,
    readTargets: () => Promise.resolve(targetsOf(SYCM_DRIFTED_URL)),
    reset: () => Promise.reject(new Error('回位后仍不是恰好一个性能页（2 个）')),
  });
  assert.match(boom.error, /仍不是恰好一个性能页/u);
  assert.equal(boom.restored, null, '没走到断言就不许给一个「成功」或「失败」的结论');
  assert.ok(readFileSync(path.join(logDir, '99-recovery.txt'), 'utf8').includes('回位没做成'));

  // 代理整个读不到：不许当成「页面挺好」，也不许抛
  const blind = await recoverFailedShop({
    shopKey: SHOP, logDir, repoRoot: REPO_ROOT,
    readTargets: () => Promise.resolve(null),
    reset: (options) => { options.log('【假回位】'); return Promise.resolve({ action: 'none' }); },
  });
  assert.equal(blind.leftAt, null);
  assert.equal(blind.after, null);
  assert.equal(blind.restored, false, '读不到不许当成就位');
});

test('失败收尾：驱动里真的接上了「记下原错 → 取证回位 → 才停整轮」（接线判据）', () => {
  // 为什么单独立一条：这三个纯函数自己的用例全绿，也拦不住「调用点根本没接上」——
  // 而这里的接线错法尤其贵：接在 `break` 之后，默认策略下唯一失败的那家恰恰不会被收尾。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  const calls = [...source.matchAll(/^\s*record\.recovery = await recoverFailedShop\(\{([^}]*)\}\)/gmu)];
  assert.equal(calls.length, 1, `失败路径的收尾调用点应当恰好 1 个，扫到 ${calls.length} 个`);
  for (const [, args] of calls) {
    assert.match(args, /shopKey: key/u, '要收尾的是刚失败的那一家，不是随便一家');
    assert.match(args, /logDir: shopLogDir/u, '证据要写进这家店自己的目录');
    assert.match(args, /repoRoot: REPO_ROOT/u, '日志路径要相对仓库根（绝对路径落进 summary.json 就没法看了）');
  }
  const assignAt = source.indexOf('record.recovery = await recoverFailedShop({');
  const errAt = source.indexOf('record.error = error.message;');
  // 2026-09-25 起默认值是「继续跑其余店」，所以这里钉的是那个**显式的**停整轮分支
  // （`--stop-on-first-failure`）—— 判据的本意没变：收尾必须排在「停整轮」之前，
  // 排在后面就等于「唯一失败的那一家不被收尾」。
  const stopAt = source.indexOf('if (args.stopOnFirstFailure)');
  assert.ok(stopAt > 0, '找不到「停整轮」那个显式分支了 —— 判据要跟着改，不能静默失效');
  assert.ok(errAt > 0 && assignAt > errAt, '收尾必须在记下 original error 之后（否则盖掉真因）');
  assert.ok(stopAt > assignAt, '收尾必须在「停整轮」之前 —— 放后面等于唯一失败的那家不被收尾');
  // 反向判据：旧的默认值写法不许再回来。
  assert.equal(source.includes('if (!args.keepGoing)'), false,
    '默认值已经翻成「一家失败不带走其余」，不许退回 `if (!args.keepGoing) break`');
});

test('驱动：浏览器键 → 代理端口只认登记表，认不出来当场抛（回落一次就是往别的浏览器上写）', () => {
  for (const key of shopBrowserKeys()) {
    assert.equal(proxyPortForBrowser(key), shopInstance(key).proxyPort, `${key} 的端口要来自它自己的登记`);
  }
  assert.equal(proxyPortForBrowser(ROUTES.dailyReport.browser), PROJECT_PORTS.dailyReportProxy);
  for (const bad of ['competitor', '里可林', '', null, undefined]) {
    assert.throws(() => proxyPortForBrowser(bad), /没有登记的代理端口/u,
      `${JSON.stringify(bad)} 必须抛 —— 回落成默认端口会让「那家店跑完了但什么都没采到」看起来像成功`);
  }
});

test('驱动：体检真的接上了「先归位、再检查」，归位结论进了 summary（接线判据）', () => {
  // 这一段会**真的改到运行中浏览器**（导航一页或新建一页），所以它必须同时满足三件事：
  // 在体检之前跑、结论落进收据、以及修不掉时不许抢答体检的结论。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  const normalizeAt = source.indexOf('normalize = await normalizePages(');
  const checkAt = source.indexOf('result = await check({})');
  assert.ok(normalizeAt > 0, 'runHealthCheck 里没有调用 normalizePages —— 体检又退回成「只看不修」了');
  assert.ok(checkAt > normalizeAt,
    '归位必须在体检调用**之前**：放后面就成了「先判不过、再修」，下一次体检前结论永远修不上');
  assert.match(source, /let normalize = null;/u, '归位要允许失败（代理连不上）—— 缺了初值那句 catch 就会 ReferenceError');
  assert.match(source, /归位没做成（不改体检结论/u, '归位失败不许抢答体检的连通性判据');
  assert.match(source, /let normalize = null;[\s\S]{0,400}?catch \(error\) \{/u, '归位自己必须被 try 住，不能把体检整段带崩');

  // 期望页面清单只许有一个来源（搬去 expected-pages.mjs 之后，驱动里不该再自己拼）。
  // 断言写死成「同目录」而不是「某个绝对位置」是刻意的：这个叶子必须在**能力自己的目录里** ——
  // 抽到 runtime/ 会让它变成 runtime → skills（业务倒灌机制层，见 runtime/arch-boundary.test.mjs），
  // 而 shop-pages 与驱动都要用它，落在任一侧的另一侧就成环。同目录导入正好是这条约束的可执行形态。
  assert.match(source, /from '\.\/expected-pages\.mjs'/u,
    '期望页面清单要来自能力目录内的 expected-pages.mjs，且是唯一来源');
  assert.equal(/from '[^']*runtime\/expected-pages\.mjs'/u.test(source), false,
    '叶子不许再落回 runtime/ —— 那会让 arch-boundary 守卫报「业务倒灌机制层」');
  assert.equal(/siteAdapter\(/u.test(source), false,
    '驱动里不该再直接调 siteAdapter 拼期望页面 —— 那会变成第二个来源');

  // 归位结论必须落进收据：只留在 stdout 的话，事后从 summary 里分不出「本来就好」与「脚本修好的」
  assert.match(source, /record\.stages\.push\(\{[\s\S]{0,1000}?pageNormalize: result\.normalize/u,
    '每个阶段的收据里要带上归位结论（体检那一支才有值）');
  assert.match(source, /normalize: roundHealth\.normalize\?\.verdict\?\.detail/u,
    '一轮的体检结论里也要带上归位结论');
});

test('代理重试判据：只有「没拿到 HTTP 应答」才重发（连接层 / 超时重发，4xx/5xx 不重发）', () => {
  // 可重发的四种形态。`fetch failed` 是 undici 在 ECONNREFUSED/ECONNRESET/socket hang up
  // 上的统一外衣 —— 2026-09-21 四家店第 8 步报的就是它，所以它必须算进来。
  assert.equal(judgeProxyRetryable(new Error('fetch failed')), true,
    '连接层失败判据丢掉了「fetch failed」这一种');
  assert.equal(judgeProxyRetryable(Object.assign(new Error('fetch failed'),
    { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(judgeProxyRetryable(Object.assign(new Error('other'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(judgeProxyRetryable(new Error('socket hang up')), true);
  assert.equal(judgeProxyRetryable(new Error('UND_ERR_SOCKET')), true);
  // 超时也算「没拿到应答」：`AbortSignal.timeout()` 给的是 TimeoutError。
  assert.equal(judgeProxyRetryable(Object.assign(new Error('The operation was aborted due to timeout'),
    { name: 'TimeoutError' })), true, '连接层失败判据丢掉了「超时」这一种');

  // 拿到应答的一律不重发。第一条是排练现场那句原文（科塔第 4 步），它看着像故障、
  // 但它是**服务端给出了答案**（页面上没有那个读数），重发只是把同一个答案再问一遍。
  assert.equal(judgeProxyRetryable(new Error('HTTP 400 Error: sycm date readout count=0')), false,
    '拿到 HTTP 应答的失败被判成了可重发（重发只是把同一个答案再问一遍）');
  assert.equal(judgeProxyRetryable(new Error('proxy request failed: HTTP 500')), false);
  assert.equal(judgeProxyRetryable(new Error('HTTP 403 无权限')), false);
  assert.equal(judgeProxyRetryable(new Error('')), false);
  assert.equal(judgeProxyRetryable(null), false);
});

test('代理重试接线：proxyJson 真的用了那条判据，且有次数上限与退避', () => {
  // 光有判据不算数 —— 它可能是个没人调的孤岛函数（本仓库吃过的亏：函数级用例全绿、接线没接上）。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  const at = source.indexOf('const proxyJson = async');
  assert.ok(at > 0, '找不到 proxyJson —— 这份接线判据的锚点没了，先修判据再看代码');
  const body = source.slice(at, source.indexOf('\n};', at));
  assert.match(body, /judgeProxyRetryable\(error\)/u, 'proxyJson 必须调用这条判据；没调就是孤岛');
  assert.match(body, /if \(!judgeProxyRetryable\(error\)\) throw error;/u,
    '不可重试的那一类必须**立刻原样抛出** —— 吞掉它会让「服务端给了答案」变成「连不上」');
  assert.match(body, /catch \(error\)/u, '重发要落在 catch 里（只有失败才可能重发）');
  assert.match(body, /setTimeout\(r, PROXY_BACKOFF_MS\)/u, '重发之间要有退避，不能空转连打');
  assert.match(body, /连试 \$\{PROXY_ATTEMPTS\} 次/u, '重试用尽后要报出**试了几次**（否则事后分不清抖动与长期不通）');

  // 次数的量级也要钉住：1 次＝等于没重试；太大＝一次抖动能把整轮挂住。
  const attempts = Number(/const PROXY_ATTEMPTS = (\d+);/u.exec(source)?.[1]);
  const backoff = Number(/const PROXY_BACKOFF_MS = (\d+);/u.exec(source)?.[1]);
  assert.ok(Number.isInteger(attempts) && attempts >= 2 && attempts <= 5,
    `重试次数要是 2~5 之间的整数，现在是 ${attempts}（1＝没重试，太大＝抖一下挂住整轮）`);
  assert.ok(Number.isInteger(backoff) && backoff > 0 && backoff <= 5000,
    `退避要是 0~5000ms 之间的整数，现在是 ${backoff}`);
});

test('代理重试：不可重试的失败原样上抛，重试用尽的失败要带次数与原因', async () => {
  // 用一个**假 fetch** 把 proxyJson 的两种出口都走一遍（不需要真代理）。
  // 这里能这么做的前提是：proxyJson 里没有模块级可变量，`fetch` 是每次调用时查的全局。
  const realFetch = globalThis.fetch;
  try {
    // ① 服务端给了 400 ⇒ 一次就抛，且抛的是那句原文（不许包装成「连不上」）。
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status: 400, json: async () => ({ error: 'HTTP 400 Error: sycm date readout count=0' }) };
    };
    await assert.rejects(() => proxyJson('http://127.0.0.1:1/targets'),
      /HTTP 400 Error: sycm date readout count=0/u);
    assert.equal(calls, 1, '拿到应答的失败不该重发');

    // ② 连接一直建不起来 ⇒ 重发到用尽，报错里必须同时有「试了几次」与最后一次的原因。
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await assert.rejects(() => proxyJson('http://127.0.0.1:1/targets'), (error) => {
      assert.match(error.message, /代理连不上（连试 3 次）/u);
      assert.match(error.message, /fetch failed/u);
      assert.match(error.message, /ECONNREFUSED/u, 'cause 也要带出来（它才是真正的错误码）');
      return true;
    });
    assert.equal(calls, 3, '重试次数要与 PROXY_ATTEMPTS 一致');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------- 分诊接线（2026-09-28）

test('接线：告警决策里真的有分诊闸门，且它按「需人处数」放行/拦截', () => {
  // 「函数级用例全绿 ≠ 接线接上了」——triageFailures 自己的用例全过，
  // 但**调用点漏接**的话，行为一个字都不会变（照样每次叫人）。
  // 所以这里扫源码：主流程必须① 算了 triage、② 用 needsHumanCount 做放行判断。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  assert.match(source, /const triage = anyFailed[\s\S]{0,80}triageFailures\(roundFailureSummary\(/u,
    '主流程必须调用 triageFailures，且喂给它的是同一个 summary 的失败视图');
  assert.match(source, /triage\.needsHumanCount === 0/u,
    '必须按「需人处数 === 0」才走「不打扰」这一支');
  assert.match(source, /全都落在「已知、不需要人」里/u,
    '拦截时必须留一行说明为什么没发（否则「没收到」与「没发出去」事后同形）');
});

test('分诊判定：09-27 那轮的真实形状（两家 DUPLICATE_TARGET）⇒ 零处需人 ⇒ 不发打扰', () => {
  // 这是本功能的**原始动机场景**：那天五家店里两家停在 push、成因是「同一天已经写过了」，
  // 正确处置是「不用做任何事」，而旧的告警每天把人叫起来一次。
  const summary = {
    shops: {
      里可林淘宝: okRecord(),
      盖文天猫: okRecord(),
      科塔淘宝: okRecord(),
      网林天猫: { status: 'failed', failedStage: 'push',
        failureOutput: 'Error: duplicate daily report row exists: recvwuXUkNPUkJ' },
      盖文淘宝: { status: 'failed', failedStage: 'push',
        failureOutput: 'Error: duplicate daily report row exists: recvwuYqiOzzLk' },
    },
  };
  const view = roundFailureSummary(summary);
  for (const row of view.failed) assert.equal(row.cause, 'DUPLICATE_TARGET');
  const triage = triageFailures(view.failed);
  assert.equal(triage.total, 2);
  assert.equal(triage.needsHumanCount, 0, '两家「今天已经写过了」都不该叫人');
  assert.equal(triage.silentCount, 2);
});

test('分诊判定：只要有一家是真问题（如掉登录）⇒ 必须叫人，绝不静默', () => {
  const summary = {
    shops: {
      网林天猫: { status: 'failed', failedStage: 'push',
        failureOutput: 'Error: duplicate daily report row exists: recvwuXUkNPUkJ' },
      科塔淘宝: { status: 'failed', failedStage: 'alimama-date', failureOutput: 'boom' },
    },
  };
  const triage = triageFailures(roundFailureSummary(summary).failed);
  assert.equal(triage.needsHumanCount, 1, '兜底类必须叫人 —— 新问题就该出现在这里');
  assert.equal(triage.needsHuman[0].key, '科塔淘宝');
});

// ---------------------------------------------------------------------------
// 修复请求单（2026-09-29）：失败 → 给 agent 的修复菜单
// ---------------------------------------------------------------------------

test('接线：驱动在失败路径上真的产出修复请求单（源码级扫描，防「函数写了但没接」）', () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  assert.match(source, /record\.repairRequest = buildRepairRequest\(/u,
    '失败 catch 块里必须真的调用 buildRepairRequest 并挂到 record 上');
  // 顺序判据：修复请求单必须在**回位之前**生成 —— 回位会把页面导航走，
  // 那之后引用「失败那一刻的现场」就对不上了。用 indexOf 比先后。
  const reqAt = source.indexOf('record.repairRequest = buildRepairRequest(');
  const recAt = source.indexOf('record.recovery = await recoverFailedShop(');
  assert.ok(reqAt > 0 && recAt > 0, '两个调用都要在源码里找得到');
  assert.ok(reqAt < recAt, '修复请求单必须在回位之前生成（回位会毁掉现场）');
});

test('buildRepairRequest：已知成因（PAGE_OBSTRUCTED）⇒ 带候选菜单与重试阶段', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-req-'));
  const req = buildRepairRequest({
    shopKey: '里可林淘宝', stage: 'promotion-fetch',
    error: 'overlay blocked (OVERLAY_NOT_DISMISSED ...)', perception: null, logDir: dir,
  });
  assert.equal(req.cause, 'PAGE_OBSTRUCTED');
  assert.equal(req.retryStage, 'promotion-fetch');
  assert.deepEqual(req.candidates.map((c) => c.action), ['DISMISS_OVERLAYS', 'RELOAD_PAGE']);
  assert.match(req.execHint, /repair-shop-stage\.mjs/u);
  assert.match(req.execHint, /--action <候选动作>/u, '提示里要给动作占位符，不替 agent 定动作');
  assert.ok(req.path, '单子应已落盘并带回相对路径');
});

test('buildRepairRequest：DUPLICATE_TARGET 也给候选（交给人），且不假装要重试', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-req-'));
  const req = buildRepairRequest({
    shopKey: '网林天猫', stage: 'push',
    error: 'Error: duplicate daily report row exists: recvwuXUkNPUkJ', perception: null, logDir: dir,
  });
  assert.equal(req.cause, 'DUPLICATE_TARGET');
  // 这一类的修法是「交给人」（分诊表口径），但请求单仍然如实把它写出来 ——
  // 请求单的职责是「把选择摆给 agent」，不是「替它筛掉」。
  assert.ok(Array.isArray(req.candidates));
  assert.equal(req.retryStage, 'push');
});

test('buildRepairRequest：把感知层的三个产物路径带进单子（agent 要读的是完整事实）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-req-'));
  const req = buildRepairRequest({
    shopKey: '科塔淘宝', stage: 'sycm-date', error: 'still outside viewport', logDir: dir,
    perception: {
      state: { url: 'https://sycm.taobao.com/x', title: '生意参谋', viewport: { w: 1178, h: 460 }, dialogs: [] },
      files: {
        stateJson: path.join(dir, '98-failure-state.json'),
        stateText: path.join(dir, '98-failure-state.txt'),
        screenshot: path.join(dir, '98-failure-page.png'),
      },
    },
  });
  assert.ok(req.statePath && req.stateTextPath && req.screenshotPath);
  assert.equal(req.stateSummary.viewport.w, 1178, '摘要里要带视口 —— 冷启动小窗是已知根因');
  assert.equal(req.stateSummary.overlayCount, 0);
});

test('buildRepairRequest：现场是登录页时，planNote 指出来（但不改候选）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-req-'));
  const req = buildRepairRequest({
    shopKey: '盖文天猫', stage: 'health-check', error: 'pages missing', logDir: dir,
    perception: { state: { url: 'https://sycm.taobao.com/custom/login.htm?_target=x', domSummary: { totalElements: 9 } }, files: {} },
  });
  assert.match(req.planNote, /登录/u, '现场是登录页必须被指出来 —— 否则 agent 会去关已经不存在的弹窗');
});

test('buildRepairRequest：认不出的成因 ⇒ 空候选（不猜动作），但单子照样落盘', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-req-'));
  const req = buildRepairRequest({ shopKey: '科塔淘宝', stage: 'readback', error: 'some brand new thing', logDir: dir });
  assert.equal(req.cause, 'STAGE_FAILED', '未知阶段失败落在兜底类');
  assert.ok(Array.isArray(req.candidates), '兜底类照样给菜单（STAGE_FAILED 在修复表里有登记）');
});

test('buildRepairRequest：落盘失败不抛（主线已经失败了，不能再制造一个错误）', () => {
  const req = buildRepairRequest({
    shopKey: '科塔淘宝', stage: 'push', error: 'x', logDir: 'nowhere',
    writeFile: () => { throw new Error('disk full'); },
  });
  assert.match(req.writeError, /disk full/u);
  assert.equal(req.cause, 'STAGE_FAILED');
});

test('buildRepairRequest：没有 logDir 也能返回对象（只是不落盘）', () => {
  const req = buildRepairRequest({ shopKey: '科塔淘宝', stage: 'push', error: 'x', logDir: null });
  assert.equal(req.path, undefined);
  assert.ok(Array.isArray(req.candidates));
});

// ---------------------------------------------------------------------------
// agent 修复回环（2026-09-29 加）
// 用户的一句话是这条回环的规格：「重试必须要让 agent 根据失败原因去修复再重试」。
// 换句话说，重试**不能是原样再来一遍** —— 下面每一条都在钉这件事的某个侧面。
// ---------------------------------------------------------------------------

test('parseArgs：--auto-repair 默认关（这是一条会动页面的路径，默认必须是「什么都不做」）', () => {
  const args = parseArgs(['--date', DATE]);
  assert.equal(args.autoRepair, false);
  assert.equal(args.autoRepairMaxRounds, DEFAULT_AUTO_REPAIR_MAX_ROUNDS);
});

test('parseArgs：--auto-repair 打开了它，--auto-repair-max-rounds 给出配额', () => {
  const args = parseArgs(['--date', DATE, '--auto-repair', '--auto-repair-max-rounds', '2']);
  assert.equal(args.autoRepair, true);
  assert.equal(args.autoRepairMaxRounds, 2);
});

test('parseArgs：--auto-repair-max-rounds 只收非负整数（负数/小数/乱写一律拒）', () => {
  for (const bad of ['-1', '1.5', 'abc']) {
    assert.throws(() => parseArgs(['--date', DATE, '--auto-repair-max-rounds', bad]), /非负整数/u, `应拒绝 ${bad}`);
  }
  assert.equal(parseArgs(['--date', DATE, '--auto-repair-max-rounds', '0']).autoRepairMaxRounds, 0);
});

test('executeRepairCandidate：没有候选 ⇒ 如实说「没得修」，不猜一个动作出来', async () => {
  let called = false;
  const out = await executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'ROUND_BLOCKED' },
    candidates: [], exec: async () => { called = true; }, log: () => {},
  });
  assert.equal(out.attempted, false);
  assert.equal(called, false, '没有候选就一个动作都不该发出去');
  assert.match(out.detail, /没有可用的修复动作/u);
});

test('executeRepairCandidate：没有注入 exec ⇒ 报接线漏了（而不是静默什么都不做）', async () => {
  const out = await executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED' },
    candidates: ['DISMISS_OVERLAYS'], exec: null, log: () => {},
  });
  assert.equal(out.attempted, false);
  assert.match(out.error, /没有注入 exec/u);
});

test('executeRepairCandidate：exec 抛错也不抛出去（主线已经失败了，不能再换一个错误）', async () => {
  const out = await executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED' },
    candidates: ['DISMISS_OVERLAYS'],
    exec: async () => { throw new Error('代理连不上'); }, log: () => {},
  });
  assert.equal(out.attempted, true);
  assert.equal(out.applied, null);
  assert.match(out.error, /代理连不上/u);
});

test('executeRepairCandidate：只试候选里的第一个，而且用 req 的 shopKey/stage 去执行', async () => {
  const seen = [];
  await executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED' },
    candidates: ['DISMISS_OVERLAYS', 'RELOAD_PAGE'],
    exec: async (o) => { seen.push(o); return { applied: true }; },
    log: () => {},
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'DISMISS_OVERLAYS', '必须挑第一个 —— 表里的顺序就是「先试哪个」');
  assert.equal(seen[0].shopKey, SHOP);
  assert.equal(seen[0].stage, 'shop-report');
});

// --- 对象数组形状的接线用例（2026-09-29 补）-----------------------------------
//
// 上面那条用例传的是**字符串数组**，而生产传的是 `planRepair()` 给的**对象数组**
// `[{action, mutating, why}]`。两者形状不同 ⇒ 函数级全绿、生产里四路 `===` 全落空
// （`run-multi-shop-day.mjs` 原 `const action = list[0]`），`--auto-repair`
// 整条执行路径是死的，而**没有任何一条用例报红**。
//
// 这就是本项目第三次吃「函数级全绿 ≠ 接线接上了」。下面三条的入参**逐字复制生产形状**：
// 候选用对象、断言「exec 收到的 action 是字符串」，不给「传字符串也能过」留后门。
test('executeRepairCandidate：候选是对象数组（生产形状）时，exec 收到的必须是动作名', async () => {
  const seen = [];
  const out = await executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'backfill', cause: 'STAGE_FAILED' },
    // 逐字取自 `planRepair()` 的契约（repair-actions.mjs:116）。
    candidates: [
      { action: 'REAPPLY_DATES', mutating: true, why: '日期又被回位重置了' },
      { action: 'RELOAD_PAGE', mutating: true, why: '页面状态不可信' },
    ],
    exec: async (o) => { seen.push(o); return { applied: true }; },
    log: () => {},
  });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].action, 'string', '动作名传成对象 ⇒ 下游四路 === 全落空');
  assert.equal(seen[0].action, 'REAPPLY_DATES');
  assert.equal(out.action, 'REAPPLY_DATES');
  assert.notEqual(out.action, '[object Object]');
});

test('executeRepairCandidate：候选形状不合法 ⇒ 当场抛（不猜动作、不静默落空）', async () => {
  // 「静默落空」正是这次故障的成因：对象被当动作名传下去，下游认不出就抛
  // `没有实现的动作：[object Object]`，而那已经是**第四层**了，排查要多绕三圈。
  await assert.rejects(() => executeRepairCandidate({
    req: { shopKey: SHOP, stage: 'backfill', cause: 'STAGE_FAILED' },
    candidates: [{ mutating: true, why: '忘了写 action 字段' }],
    exec: async () => ({ applied: true }),
    log: () => {},
  }), /既不是动作名也不是候选对象/u);
});

test('autoRepairAndRetry：gaveUp 文案不许印 [object Object]（候选没试完时）', async () => {
  // 09-29 那轮的生产收据里 `gaveUp` 是 `用完 1 轮（候选还剩 [object Object]）` —— 读的人
  // 看不出还剩哪个动作没试。触发条件是**候选没试完就用完配额**（maxRounds < 候选数），
  // 所以这条刻意让 maxRounds=1、给 2 个候选：第 1 轮试完就耗尽配额，剩下那个进文案。
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x', maxRounds: 1,
    req: { shopKey: SHOP, stage: 'backfill', cause: 'STAGE_FAILED', retryStage: 'backfill',
      candidates: [
        { action: 'REAPPLY_DATES', mutating: true, why: 'A' },
        { action: 'RELOAD_PAGE', mutating: true, why: 'B' },
      ] },
    runStage: async () => ({ status: 1 }),
    exec: async () => ({ applied: false }),
    log: () => {},
  });
  assert.equal(trace.gaveUp, '用完 1 轮（候选还剩 RELOAD_PAGE）');
  assert.ok(!String(trace.gaveUp).includes('[object Object]'),
    'gaveUp 文案不许印 [object Object]（09-29 那轮的生产收据就是这样）');
});

test('autoRepairAndRetry：对象候选用掉一个就摘掉一个，同一个动作不试第二遍', async () => {
  // 原先 `remaining.indexOf(attempt.action)` 拿字符串在**对象数组**里找 ⇒ 恒 -1
  // ⇒ `splice(-1,1)` 摘掉的是最后一个候选，刚试过的那个还留在队列里
  // ⇒ 同一个动作被反复试到 maxRounds 用完。这条钉住「按名字摘」。
  const actions = [];
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x', maxRounds: 3,
    req: { shopKey: SHOP, stage: 'backfill', cause: 'STAGE_FAILED', retryStage: 'backfill',
      candidates: [
        { action: 'REAPPLY_DATES', mutating: true, why: 'A' },
        { action: 'RELOAD_PAGE', mutating: true, why: 'B' },
      ] },
    // 重试永远失败 ⇒ 会把候选一路试完，正好能观察到「每个只试一次」。
    runStage: async () => ({ status: 1 }),
    exec: async (o) => { actions.push(o.action); return { applied: true }; },
    log: () => {},
  });
  assert.deepEqual(actions, ['REAPPLY_DATES', 'RELOAD_PAGE'],
    '两个候选各试一次就没了；出现重复说明摘除按错了下标');
  assert.equal(trace.gaveUp, '候选动作已全部试过');
});

test('autoRepairAndRetry：修复表没登记的成因一个字都不动（登录掉了不自动去点登录）', async () => {
  const executed = [];
  // 这条的判据不是「代码里写没写 NEEDS_LOGIN」，而是**请求单里有没有候选**。
  // 请求单由 `planRepair` 从 `REPAIR_TABLE` 生成，而 `NEEDS_LOGIN` 在那里没有条目
  // ⇒ 候选必为空 ⇒ 一个动作都发不出去。下面用空的 candidates 复现这个真实形状。
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'NEEDS_LOGIN', candidates: [], retryStage: 'shop-report' },
    runStage: async () => { throw new Error('不该重试'); },
    exec: async (o) => { executed.push(o); return { applied: true }; },
    log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.equal(executed.length, 0, '候选为空 ⇒ 一个动作都不该试');
  assert.match(trace.gaveUp, /没有候选动作/u);
});

test('互锁：修复表给候选的成因，就是自动修复会去修的成因（同一个来源，不许两处判）', () => {
  // 这条钉住的是「闸门只有一个来源」：`autoRepairAndRetry` 不读任何排除名单，
  // 它只看候选菜单。于是「谁能被自动修」完全等于「`REPAIR_TABLE` 里谁有候选」。
  // 有人往调用侧加一张「不许修」的名单 ⇒ 这条不会红；但有人往 `REPAIR_TABLE`
  // 里给 NEEDS_LOGIN 加候选 ⇒ 自动修复就会去点登录 —— 所以这条从**表**这一侧守。
  const reqFor = (cause) => buildRepairRequest({ shopKey: SHOP, stage: 'shop-report', error: '', logDir: null });
  assert.ok(reqFor, '形状守卫：buildRepairRequest 仍在');
  const noCandidates = ['NEEDS_LOGIN', 'SHOP_FUNC_NO_PERMISSION', 'ROUND_BLOCKED', 'DUPLICATE_TARGET'];
  for (const cause of noCandidates) {
    const plan = planRepair({ cause, stage: 'shop-report' });
    assert.deepEqual(plan.candidates, [], `${cause} 不该有自动修复候选（它要人/不需要人，都不该动页面）`);
    assert.equal(plan.known, false);
  }
  // 反过来：这几个必须有候选，否则修复层对它们永远不生效（`PAGE_OBSTRUCTED` 是主场景）。
  for (const cause of ['PAGE_OBSTRUCTED', 'SHOP_BLOCKED', 'STAGE_FAILED']) {
    const plan = planRepair({ cause, stage: 'shop-report' });
    assert.ok(plan.candidates.length > 0, `${cause} 必须有候选 —— 否则这一族失败永远不会被自动修`);
  }
});

test('autoRepairAndRetry：maxRounds=0 ⇒ 直接放弃（配额为零）', async () => {
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED', candidates: ['DISMISS_OVERLAYS'] },
    maxRounds: 0, runStage: async () => ({ status: 0 }), exec: async () => ({ applied: true }), log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.match(trace.gaveUp, /maxRounds<=0/u);
  assert.equal(trace.rounds.length, 0);
});

test('autoRepairAndRetry：修成了 ⇒ 重试失败的那一步，且只重试那一步', async () => {
  const retried = [];
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED',
      candidates: ['DISMISS_OVERLAYS', 'RELOAD_PAGE'], retryStage: 'shop-report' },
    runStage: async (name) => { retried.push(name); return { status: 0 }; },
    exec: async () => ({ applied: true }), log: () => {},
  });
  assert.equal(trace.rescued, true);
  assert.deepEqual(retried, ['shop-report'], '重试的必须是失败那一步，不是整条链');
  assert.equal(trace.rounds.length, 1);
  assert.equal(trace.rounds[0].action, 'DISMISS_OVERLAYS');
  assert.equal(trace.rounds[0].retry.status, 0);
});

test('autoRepairAndRetry：动作没落地 ⇒ 换下一个候选，但**不重试阶段**（原样再来一遍正是要消灭的）', async () => {
  const retried = [];
  const tried = [];
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED',
      candidates: ['DISMISS_OVERLAYS', 'RELOAD_PAGE'], retryStage: 'shop-report' },
    maxRounds: 2,
    runStage: async (name) => { retried.push(name); return { status: 0 }; },
    exec: async (o) => { tried.push(o.action); return { applied: o.action === 'RELOAD_PAGE' }; },
    log: () => {},
  });
  assert.deepEqual(tried, ['DISMISS_OVERLAYS', 'RELOAD_PAGE'], '没落地的动作之后要换下一个候选');
  assert.deepEqual(retried, ['shop-report'], '只有落地的那个动作才配触发重试');
  assert.equal(trace.rescued, true);
});

test('autoRepairAndRetry：同一个动作不试第二遍（把页面反复重载会把状态拖更差）', async () => {
  const tried = [];
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED',
      candidates: ['DISMISS_OVERLAYS'], retryStage: 'shop-report' },
    maxRounds: 5,
    runStage: async () => ({ status: 1 }),
    exec: async (o) => { tried.push(o.action); return { applied: true }; },
    log: () => {},
  });
  assert.deepEqual(tried, ['DISMISS_OVERLAYS'], '候选用掉就不再出现在下一轮');
  assert.equal(trace.rescued, false);
  assert.match(trace.gaveUp, /候选/u);
});

test('autoRepairAndRetry：修好了但重试还是失败，且候选耗尽 ⇒ 停手，如实说「试过什么」', async () => {
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED',
      candidates: ['DISMISS_OVERLAYS', 'RELOAD_PAGE'], retryStage: 'shop-report' },
    maxRounds: 3,
    runStage: async () => ({ status: 1 }),
    exec: async () => ({ applied: true }),
    log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.equal(trace.rounds.length, 2, '两个候选各试一轮');
  assert.match(trace.gaveUp, /候选/u);
});

test('autoRepairAndRetry：请求单里没给 retryStage ⇒ 不猜（认不出来就不重试）', async () => {
  const retried = [];
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: null, cause: 'PAGE_OBSTRUCTED', candidates: ['DISMISS_OVERLAYS'], retryStage: null },
    runStage: async (name) => { retried.push(name); return { status: 0 }; },
    exec: async () => ({ applied: true }), log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.deepEqual(retried, [], '认不出重试哪一步就不猜');
  assert.match(trace.gaveUp, /没给重试哪一步/u);
});

test('autoRepairAndRetry：候选本身为空 ⇒ 明确放弃（成因未登记到修复表）', async () => {
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'DUPLICATE_TARGET', candidates: [], retryStage: 'shop-report' },
    runStage: async () => ({ status: 0 }), exec: async () => ({ applied: true }), log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.match(trace.gaveUp, /没有候选动作/u);
});

test('autoRepairAndRetry：回环自己炸了也不抛 —— 主线失败语义原样保留', async () => {
  const trace = await autoRepairAndRetry({
    shopKey: SHOP, logDir: '/tmp/x',
    req: { shopKey: SHOP, stage: 'shop-report', cause: 'PAGE_OBSTRUCTED', candidates: ['DISMISS_OVERLAYS'], retryStage: 'shop-report' },
    runStage: async () => { throw new Error('runStage 炸了'); },
    exec: async () => ({ applied: true }), log: () => {},
  });
  assert.equal(trace.rescued, false);
  assert.match(trace.error, /runStage 炸了/u);
});

test('接线守卫：main 里 autoRepairAndRetry 真的被调用，且排在 recoverFailedShop 之前', () => {
  const src = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  const callAt = src.indexOf('await autoRepairAndRetry(');
  assert.ok(callAt > 0, 'main 必须真的调用这条回环（否则三个模块都白建了）');
  const recoverAt = src.indexOf('record.recovery = await recoverFailedShop(');
  assert.ok(recoverAt > 0, '回位那一步应当还在');
  assert.ok(callAt < recoverAt, '修复要在回位之前 —— 回位会把页面导航走，之后修的就不是那个坏页面了');
  const reqAt = src.indexOf('record.repairRequest = buildRepairRequest(');
  assert.ok(reqAt > 0 && reqAt < callAt, '修复回环读的是请求单 ⇒ 请求单必须先算出来');
  assert.match(src, /if \(args\.autoRepair && args\.autoRepairMaxRounds > 0\)/u,
    '默认关闭这件事必须在代码里看得见，不能只在注释里');
});

test('接线守卫：修复后的重试用的是「按名字重跑」，而不是另建一份阶段表', () => {
  const src = readFileSync(path.join(SCRIPTS_DIR, 'run-multi-shop-day.mjs'), 'utf8');
  // 只看 main 里那一段：`stageNumber`（模块级工具）自己也调 buildShopStages，
  // 扫全文会把那个无害的调用算进来 —— 判据要扫对范围，否则它会因为一句无关代码变红。
  const mainAt = src.indexOf('async function main()');
  assert.ok(mainAt > 0, 'main 应当还在');
  const main = src.slice(mainAt);
  assert.match(main, /const runNamedStage = async \(name\) =>/u, '重试必须按阶段名找');
  assert.match(main, /stages\.find\(\(s\) => s\.stage === name\)/u, '找不到就如实报，不猜一个阶段出来跑');
  // 阶段表只建一次：重试要用与首跑**完全相同**的 argv（含 push 的源文件路径）。
  assert.match(main, /const stages = buildShopStages\(key,/u);
  const buildCount = (main.match(/buildShopStages\(key,/gu) ?? []).length;
  assert.equal(buildCount, 1, `main 里 buildShopStages(key,…) 只该出现一次，实际 ${buildCount} 次`);
});
