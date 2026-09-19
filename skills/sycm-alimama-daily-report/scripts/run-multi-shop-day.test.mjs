import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BROWSER_IDS, PROJECT_PORTS, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { siteAdapter } from './date-picker.mjs';
import { shopIdentity } from './shop-identities.mjs';
import { MODES, STAGE_NAMES, buildShopStages, expectedPagesForDailyBrowser, expectedPagesForShop, findPath, healthStageStatus, parseArgs, withSourcePaths } from './run-multi-shop-day.mjs';

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
test('驱动：四家店的审计身份互不相同，且没有一家被写成日报链那一组', () => {
  const proxyPorts = new Map();
  for (const key of shopBrowserKeys()) {
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
  assert.equal(new Set(proxyPorts.values()).size, proxyPorts.size, '四家店的代理端口必须互不相同');
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

test('驱动：采集段的三个身份期望值来自登记表，且四家店互不相同', () => {
  const headers = new Set();
  for (const key of shopBrowserKeys()) {
    const row = shopIdentity(key);
    const stages = byStage(buildShopStages(key, { date: DATE, mode: 'rehearse' }));
    for (const name of COLLECTORS) {
      const argv = stages[name].argv;
      assert.equal(flagValue(argv, '--expect-shop'), row.sycmHeader, `${key}/${name} 的 --expect-shop`);
      assert.equal(flagValue(argv, '--expect-member'), row.alimamaMemberName, `${key}/${name} 的 --expect-member`);
      assert.equal(flagValue(argv, '--expect-member-id'), row.alimamaMemberId, `${key}/${name} 的 --expect-member-id`);
    }
    headers.add(row.sycmHeader);
    // 登记表这两个字段现在同值（页头店名就是平台店铺全称）。哪天真分开不要紧，
    // 但要**知道**分开了 —— 回填的 --source-shop 取的是 fullName，页头读回来的是 sycmHeader。
    assert.equal(row.sycmHeader, row.fullName, `${key} 的 sycmHeader 与 fullName 漂移了，--source-shop 要重看`);
  }
  assert.equal(headers.size, shopBrowserKeys().length, '四家店的页头店名必须互不相同');
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
  // 保拉淘宝 / 盖文天猫 在登记表里，但没有隔离 profile ⇒ 没有浏览器可连，必须当场拒绝。
  assert.throws(() => buildShopStages('保拉淘宝', { date: DATE, mode: 'rehearse' }), /未登记的店铺实例/u);
  assert.throws(() => buildShopStages('盖文天猫', { date: DATE, mode: 'rehearse' }), /未登记的店铺实例/u);
});

test('驱动：四家已登记的店铺都能构造出完整阶段（没有哪家要到真跑时才因身份缺失而炸）', () => {
  for (const key of shopBrowserKeys()) {
    assert.equal(buildShopStages(key, { date: DATE, mode: 'rehearse' }).length, EXPECTED_ORDER.length, key);
  }
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
