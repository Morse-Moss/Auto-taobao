// 守卫：飞书写入口必须按**目标**取凭据，而不是按 profile 取（2026-10-17 加）。
//
// 这次事故的形态值得单独钉住：10-16 把 10 月的商品 base / 推广 base 换到别的组织，
// 代码里目标的 baseToken 换对了、凭据却还是本组织的 ⇒ 采集全成功、24 次导入全 403/91403、
// 飞书零写入。所有用例当时都是绿的 —— 因为没有任何一条用例问过「写这张 base 用的是谁的身份」。
//
// 所以这里守四件事，缺一件就会让同类事故再飞一次：
//   ① 注册表里每个条目必须**显式**登记 envFile（靠回落就是靠「刚好还是本租户」）；
//   ② `targetCredentials` 真按目标的 envFile 取（不是 profile 的）；
//   ③ 四个写入口的**源码**里不许再出现 `loadFeishuCredentials`（接线，不是纯函数）；
//   ④ 授权类失败要能被分类器认出来（否则告警说「不需要你做什么」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PROMOTION_DAILY_MONTH_BASES,
  PRODUCT_DATA_MONTH_BASES,
  assertPromotionDailyBaseCoverage,
  assertProductDataBaseCoverage,
  envFilePath,
  productDataTargetsForShop,
  promotionDailyTargets,
  targetCredentials,
} from './feishu-targets.mjs';
import { describeTargetProbeFailures, isFeishuAuthError, probeFeishuTargets } from './feishu-target-preflight.mjs';
import { classifyWorkflowError } from './workflow-receipt.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RCNB = 'E:/小红书/.env.feishu-rcnb.local';

test('注册表每个条目都显式登记 envFile，跨组织的那几张指向对方组织凭据', () => {
  assertProductDataBaseCoverage();
  assertPromotionDailyBaseCoverage();
  for (const [key, entry] of Object.entries(PRODUCT_DATA_MONTH_BASES)) {
    assert.ok(entry.envFile, `商品注册表「${key}」缺 envFile`);
  }
  for (const [key, entry] of Object.entries(PROMOTION_DAILY_MONTH_BASES)) {
    assert.ok(entry.envFile, `推广注册表「${key}」缺 envFile`);
  }
  // 事实记账：2026-10 这三张（1 部商品 / 2 部商品 / 1 部推广）在 rcnbpuvafkct 组织里，
  // 2026-09 那张 9 月商品表还在本租户。哪天真换了组织，这条用例会先红，人再改注释。
  assert.equal(PRODUCT_DATA_MONTH_BASES['2026-10:sales1'].envFile, RCNB);
  assert.equal(PRODUCT_DATA_MONTH_BASES['2026-10:sales2'].envFile, RCNB);
  assert.equal(PROMOTION_DAILY_MONTH_BASES['2026-10:sales1'].envFile, RCNB);
  assert.equal(PRODUCT_DATA_MONTH_BASES['2026-09:sales1'].envFile, 'E:/小红书/.env.feishu-kcne.local');
  // 必须与「这家店这一天该写哪张 base」走同一个解析入口，不能另开一套。
  const target = productDataTargetsForShop('盖文淘宝', '2026-10-16', 'kcne');
  assert.equal(target.envFile, RCNB);
  const promotion = promotionDailyTargets('kcne', '2026-10-16');
  assert.equal(promotion.envFile, RCNB);
});

test('缺 envFile 的新条目要在启动时红，而不是跑一小时后 403', () => {
  const entry = PRODUCT_DATA_MONTH_BASES['2026-10:sales1'];
  const { envFile, ...withoutEnvFile } = entry;
  assert.ok(envFile, '被拆出来的字段必须原本存在');
  assert.throws(() => assertProductDataBaseCoverage({ registry: { '2026-10:sales1': withoutEnvFile } }),
    /缺 envFile/u, '新月份漏登记凭据文件是最贵的静默失败：采到了、写不进去');
  assert.throws(() => assertProductDataBaseCoverage({
    registry: { '2026-10:sales1': { ...entry, envFile: 'E:/小红书/foo.txt' } },
  }), /不像一个 \.env 凭据文件路径/u);
  const promotionEntry = PROMOTION_DAILY_MONTH_BASES['2026-10:sales1'];
  const { envFile: promotionEnvFile, ...promotionWithoutEnvFile } = promotionEntry;
  assert.ok(promotionEnvFile);
  assert.throws(() => assertPromotionDailyBaseCoverage({ registry: { '2026-10:sales1': promotionWithoutEnvFile } }),
    /缺 envFile/u);
});

test('targetCredentials 按目标的 envFile 取，不按 profile 取', () => {
  const reads = [];
  const read = (file) => {
    reads.push(file);
    return 'FEISHU_APP_ID=cli_target\nFEISHU_APP_SECRET=secret_target\n';
  };
  const target = productDataTargetsForShop('盖文淘宝', '2026-10-16', 'kcne');
  const credentials = targetCredentials(target, 'kcne', { read });
  assert.equal(credentials.appId, 'cli_target');
  assert.equal(credentials.file, RCNB);
  assert.deepEqual(reads, [RCNB], '读的必须是目标登记的那份文件');
  assert.notEqual(credentials.file, envFilePath('kcne'), 'profile 的凭据文件与目标的不同 —— 这正是那次事故的分水岭');
  // 缺字段仍要当场炸（别让下游拿 undefined 去换 token）。
  assert.throws(() => targetCredentials(target, 'kcne', { read: () => 'FEISHU_APP_ID=cli_x\n' }),
    /must define FEISHU_APP_ID and FEISHU_APP_SECRET/u);
});

test('四个写入口的源码里不许再出现 loadFeishuCredentials（接线守卫）', () => {
  // 纯函数绿 ≠ 接线接上了：`targetCredentials` 写得再对，只要写入口还在用
  // `loadFeishuCredentials('kcne')`，跑起来照样 403。所以直接读源码钉住调用侧。
  const files = [
    'skills/sycm-product-data/scripts/import-product-data.mjs',
    'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
    'skills/sycm-promotion-data/scripts/import-promotion-data.mjs',
    'skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs',
    'skills/sycm-alimama-daily-report/scripts/check-promotion-completeness.mjs',
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
    assert.doesNotMatch(source, /loadFeishuCredentials/u,
      `${relative} 仍在用 profile 凭据写目标 base —— 跨组织后必然 403/91403`);
    assert.match(source, /targetCredentials/u, `${relative} 必须按目标取凭据`);
  }
});

test('授权类失败要在开工前被拦，网络类失败只记账不拦路', async () => {
  assert.equal(isFeishuAuthError('Feishu API failed: 403 91403 Forbidden'), true);
  assert.equal(isFeishuAuthError('Feishu API failed: 403 1063004 无权限'), true);
  assert.equal(isFeishuAuthError('fetch failed: socket hang up'), false);
  // 裸 403 的边界：端口号里出现 403 不算权限问题（否则网络故障会被判成「要人」）。
  assert.equal(isFeishuAuthError('proxy on 14031 is down'), false);

  const authClient = class {
    constructor({ tableId }) { this.tableId = tableId; }
    async listFields() { throw new Error('Feishu API failed: 403 91403 Forbidden'); }
  };
  const flakyClient = class {
    async listFields() { throw new Error('fetch failed: ETIMEDOUT'); }
  };
  const targets = [{ label: '10月商品监控表-销售1部（sales1）', baseToken: 'LQgZbi78oaAmIYsc4urcwk9rnNf', envFile: RCNB, tables: [{ name: '商品底单', tableId: 'tblvmGJfOL4OBYek' }] }];
  const credentialsFor = (target) => targetCredentials(target, 'kcne', { read: () => 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=y\n' });

  const denied = await probeFeishuTargets({ targets, credentialsFor, FeishuClient: authClient });
  assert.equal(denied.ok, false);
  assert.equal(denied.blocking.length, 1, '确定性拒绝必须拦路');
  assert.match(describeTargetProbeFailures(denied)[0], /不认当前凭据/u);

  const unreachable = await probeFeishuTargets({ targets, credentialsFor, FeishuClient: flakyClient });
  assert.equal(unreachable.blocking.length, 0, '网络抖动不该让整轮直接不采数据');
  assert.equal(unreachable.targets[0].status, 'UNREACHABLE');

  const broken = await probeFeishuTargets({
    targets, credentialsFor: () => { throw new Error('env file X must define FEISHU_APP_ID and FEISHU_APP_SECRET'); }, FeishuClient: authClient,
  });
  assert.equal(broken.blocking.length, 1);
  assert.equal(broken.targets[0].status, 'CREDENTIALS_UNUSABLE');
});

test('接线：授权类失败消息经整轮那句 throw 之后归 HUMAN_REQUIRED', () => {
  // 与 run-product-data-job.mjs 收尾处同形：缺口拼进 `本轮不完整（N 处）：…`
  const message = '本轮不完整（24 处）：里可林淘宝/底单 导入失败：Feishu API failed: 403 91403 Forbidden；'
    + '推广 批量导入失败（sales1）：Feishu API failed: 403 91403 Forbidden';
  const classified = classifyWorkflowError(new Error(message));
  assert.equal(classified.class, 'HUMAN_REQUIRED',
    '归成 FAILED/UNCLASSIFIED 会让告警说「这一轮不需要你在浏览器里做什么」，而真实答案是「换凭据」');
  assert.equal(classified.reason, 'PLATFORM_OR_HUMAN_GATE');
  // 开工前预检那句也走同一条分类（它同样是「要人/要配置」，不是可重试的外部故障）。
  const probeFail = classifyWorkflowError(new Error('飞书目标预检失败：10月商品监控表-销售1部（sales1）：这张 base 不认当前凭据'));
  assert.equal(probeFail.class, 'HUMAN_REQUIRED');
});
