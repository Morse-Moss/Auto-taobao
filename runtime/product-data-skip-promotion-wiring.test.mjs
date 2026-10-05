// 守卫：商品数据链的**推广段闸门接线**（2026-10-05 加 `--skip-promotion`）。
//
// 为什么单独一份：`product-data-job-core.test.mjs` 测的是**渲染出来的命令**与 plan 的字段 ——
// 全是函数级的。而这次改动真正新增的是「一个开关在**四处**同时生效」：
//   ① 采集段（连推广采集脚本都不起）
//   ② 导入段（连导入都不做）
//   ③ 缺口段（有意跳过**不记缺口**，否则整轮会被自己的闸门判成失败）
//   ④ 收据段（两处 markStage 记 `SKIPPED`，不是 PENDING / COMPLETED / FAILED）
// 漏掉任何一处都不报错，只会**静默**地做错事：
//   漏 ① ⇒ 白采一遍、多下十几个 ZIP；漏 ② ⇒ 把 10 月推广写进关账的 9 月 base（本闸门存在的全部理由）；
//   漏 ③ ⇒ 链永远退 1 并发告警；漏 ④ ⇒ 收据读成「推广还没轮到」，下次重跑也没有提示。
// 所以这里不看函数返回值，直接钉**这四个接线点在源码里的位置**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../scripts/run-product-data-job.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'scripts/run-product-data-job.mjs';

/** 读源码并把行尾归一到 LF —— 断言按 `\n` 写，不该因为工作区的 CRLF 而变红（2026-10-05 踩过）。 */
function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

test('① 采集段：跳过判定排在推广采集调用之前（不许先采后判断）', () => {
  const source = readSource(ENTRY);
  const guardAt = source.indexOf('if (options.skipPromotion) continue;');
  const collectAt = source.indexOf('PRODUCT_JOB_FILES.promotionCollect');
  assert.ok(guardAt > 0, '采集段少了 `if (options.skipPromotion) continue;` ⇒ 白采一遍、多下十几个 ZIP');
  assert.ok(collectAt > 0, '找不到推广采集调用 —— 结构变了就要连这份守卫一起改');
  assert.ok(guardAt < collectAt,
    '跳过判定排在了推广采集**之后** ⇒ 采集照样跑，闸门形同虚设');
});

test('② 导入段：跳过分支存在，且推广导入被挡在 else 分支里', () => {
  const source = readSource(ENTRY);
  const skipBranchAt = source.indexOf('if (options.skipPromotion) {\n      log(`[导入] 推广段有意跳过');
  assert.ok(skipBranchAt > 0,
    '导入段少了显式的跳过分支 ⇒ 只跳采集不跳导入会是「静默走完、收据里没有任何『有意跳过』的痕迹」');
  const importAt = source.indexOf('PRODUCT_JOB_FILES.promotionImport');
  assert.ok(importAt > skipBranchAt, '推广导入没有排在跳过分支之后 ⇒ 跳过时它照样会执行');
  // `importPromotionPerShop` 的定义必须落在 `} else {` 里面：留在外面就等于时刻准备着执行。
  const between = source.slice(skipBranchAt, source.indexOf('const promoReady'));
  assert.ok(between.includes('const importPromotionPerShop'),
    '`importPromotionPerShop` 的定义没有落在 else 分支里 ⇒ 跳过时它仍在作用域内可被调用');
});

test('③ 缺口段：有意跳过的推广不记缺口（否则链会被自己的闸门判成失败）', () => {
  const source = readSource(ENTRY);
  assert.ok(source.includes('if (!options.skipPromotion && !item.promotionFile) addGap('),
    '缺口补记那条少了 `!options.skipPromotion` ⇒ 跳过推广时每一家都会记一条「推广 未采集」，整轮退 1 并告警');
});

test('④ 收据段：两处 markStage 都记 SKIPPED，且恰好两处（不多不少）', () => {
  const source = readSource(ENTRY);
  const skipped = [...source.matchAll(/markStage\(receipt,\s*'promotion',\s*options\.skipPromotion/gu)];
  assert.equal(skipped.length, 2,
    `收据里的推广阶段应当恰好两处受闸门控制（runRound 一处 + main 一处），实际 ${skipped.length} 处 —— `
    + '少一处就会让那一路把「有意跳过」记成 FAILED 或 PENDING');
  // SKIPPED 必须真写出来，不能只判 skipPromotion 却仍旧落到 COMPLETED/FAILED。
  assert.equal([...source.matchAll(/'SKIPPED'/gu)].length, 2,
    'SKIPPED 这个状态值应当恰好出现两次（对应上面两处）；写成 PENDING 会被读成「还没轮到、下次会跑」');
  // 注释里的词表也要跟着更新，否则下一个人按注释写的值会被判成非法。
  assert.match(source, /PENDING（没轮到）\/ COMPLETED \/ FAILED \/ \*\*SKIPPED（有意跳过）\*\*/u,
    '阶段状态词表的注释没把 SKIPPED 写进去 ⇒ 下一个人会以为只有三个合法值');
});

test('CLI 契约：--skip-promotion 默认关闭、写进 --help', () => {
  // 默认关闭（＝照旧做推广）：跳过是一个**决定**，不该是不写参数时的副作用。
  // 默认「开」会让所有手工排查与按店重跑都悄悄少做一段。
  assert.equal(parseArgs(['--date', 'yesterday', '--commit']).skipPromotion, false);
  assert.equal(parseArgs(['--skip-promotion']).skipPromotion, true);
  // `--help` 是这条开关对外唯一的说明。开关存在而 help 里没有它，等于没承诺过。
  assert.match(readSource(ENTRY), /\[--skip-promotion\]/u,
    '--help 里没有写 --skip-promotion ⇒ 用命令行的人不会知道它存在');
});
