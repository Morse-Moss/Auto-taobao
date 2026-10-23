// 商品链失败告警**业务段文案**的离线判据（2026-10-22）。
//
// 存在的理由：用户原话「告警文案需要更加符合问题，而不是卡在第几步」。
// 文案是发给人的，坏了不会报错、只会让收信人读到一句看不懂也做不了的话 ——
// 所以必须有一条用例把「收信人读到的那一句」钉住，而不是靠发一条真告警用眼睛看。
//
// 钉的四件事：
//   ① 点名到店、按段分组（这才是收信人要的答案）；
//   ② 业务段**不许**出现 `inquiry-import` 这类机读阶段码（那是「卡在第几步」）；
//   ③ HUMAN_REQUIRED 时不许出现「不需要你在浏览器里做什么」（那句话会把人拦住）；
//   ④ 空缺口返空串（让调用方退回兜底文案，而不是拼出半句话）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  describeGapsByStage,
  describeNextAction,
  describePhenomena,
  parseGap,
  plainFailureClass,
} from './product-alert-copy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 逐字取自 2026-10-22 那一轮真机的 5 处缺口（evidence/product-data-job-2026-10-21/
// 2026-10-21-20261022021253864-e1dbdbf9/collection.json）。
const REAL_GAPS_2026_10_22 = Object.freeze([
  '里可林天猫/询单 未采集：采集失败：轮询 30s 内未进入商品咨询分析页',
  '盖文天猫/询单 未采集：采集失败：轮询 30s 内未进入商品咨询分析页',
  '网林天猫/推广 未采集：采集失败：找不到商品数据明细维度选择器',
  '里可林天猫/推广 未采集：采集失败：找不到商品数据明细维度选择器',
  '盖文天猫/推广 未采集：采集失败：找不到商品数据明细维度选择器',
]);

test('parseGap 认得「店/段 说明」的三种真机形状', () => {
  assert.deepEqual(parseGap('网林天猫/推广 未采集：找不到维度'), { shop: '网林天猫', stage: '推广', note: '找不到维度' });
  const failedImport = parseGap('盖文天猫/询单 导入失败：403 无权限');
  assert.equal(failedImport.shop, '盖文天猫');
  assert.equal(failedImport.stage, '询单');
  assert.match(failedImport.note, /^导入失败：403/u);
  // 部门级/整轮级缺口拆不出店与段 ⇒ 原样留下（不猜）
  const dept = parseGap('推广 批量导入失败（销售1部）：unexpected');
  assert.equal(dept.shop, null);
  assert.equal(dept.stage, null);
  assert.match(dept.note, /批量导入失败/u);
});

test('业务段点名到店：按段分组、段序固定、同段合并', () => {
  const text = describeGapsByStage(REAL_GAPS_2026_10_22);
  // 段名必须是业务说法（商品底单/询单/推广），不能退回机读段码 ——
  // 2026-10-22 突变 M1 实测：只断言「询单 2 家缺（…）」会漏掉段名被换成 `inquiry` 这种改坏。
  assert.match(text, /询单 2 家缺（里可林天猫、盖文天猫）/u);
  assert.match(text, /推广 3 家缺（网林天猫、里可林天猫、盖文天猫）/u);
  // 段序：底单 → 询单 → 推广（业务上先有底单再有询单）
  assert.ok(text.indexOf('询单') < text.indexOf('推广'), '段序必须底单→询单→推广');
  // 只出现实际缺的段：这一轮底单 8/8 全成，就不该出现「商品底单」
  assert.doesNotMatch(text, /商品底单/u);
  // 段名集合必须逐字受控：把整句按「；」切开后，每段都以三选一的业务段名开头
  const segments = text.split('；');
  for (const segment of segments) {
    assert.match(segment, /^(商品底单|询单|推广) \d+ 家缺（/u, `段名必须是业务说法，实际：${segment}`);
  }
});

test('业务段不许出现机读阶段码（用户原话：不要「卡在第几步」）', () => {
  const text = describeGapsByStage(REAL_GAPS_2026_10_22);
  for (const code of ['inquiry-import', 'product-import', 'promotion-import', 'UNCLASSIFIED', 'RECOVERED']) {
    assert.ok(!text.includes(code), `业务段不该出现机读码：${code}`);
  }
});

test('拆不出的缺口不许被悄悄吞掉', () => {
  const text = describeGapsByStage([...REAL_GAPS_2026_10_22, '推广 批量导入失败（销售1部）：boom']);
  assert.match(text, /另有 1 处未完成/u);
});

test('空缺口返空串（调用方据此退回兜底文案）', () => {
  assert.equal(describeGapsByStage([]), '');
  assert.equal(describeGapsByStage(undefined), '');
  assert.equal(describePhenomena([]), '');
  assert.equal(describePhenomena(undefined), '');
});

test('失败分类翻成人话，且不把机读码直接印给收信人', () => {
  const map = {
    HUMAN_REQUIRED: '登录或验证码',
    TRANSIENT_EXTERNAL: '重跑一次',
    UNKNOWN_WRITE: '先核对飞书',
    RECOVERED: '自己恢复',
    FAILED: '没能自动修好',
  };
  for (const [klass, expected] of Object.entries(map)) {
    const text = plainFailureClass(klass);
    assert.ok(text.includes(expected), `${klass} 的人话应含「${expected}」，实际：${text}`);
    assert.ok(!text.includes(klass), `不该把机读码 ${klass} 原样印出来`);
  }
  // 未知分类也要有一句能读的
  assert.match(plainFailureClass('WHATEVER_NEW'), /技术同学/u);
});

test('动作段：HUMAN_REQUIRED 时不许说「不需要你在浏览器里做什么」', () => {
  const human = describeNextAction('HUMAN_REQUIRED');
  assert.ok(!human.includes('不需要你在浏览器里做什么'), `HUMAN_REQUIRED 时这句会把人拦住：${human}`);
  assert.match(human, /登录|验证码/u);

  for (const klass of ['TRANSIENT_EXTERNAL', 'FAILED', 'UNKNOWN_WRITE', 'RECOVERED']) {
    assert.match(describeNextAction(klass), /不需要你在浏览器里做什么/u, `${klass} 应明确告诉运营不用动手`);
  }
});

test('逐店现象带前缀、超长截断、空白压成单空格', () => {
  const text = describePhenomena(['  网林天猫/推广\n  未采集  ']);
  assert.match(text, /^逐店现象：网林天猫\/推广 未采集$/u);

  const long = describePhenomena([`网林天猫/推广 ${'很长'.repeat(200)}`], 40);
  assert.ok(long.length <= 41, `截断后不该超长：${long.length}`);
  assert.ok(long.endsWith('…'), '截断要有省略号，让人知道还有下文');
});

test('接线守卫：告警发送处真的调用了这四个函数', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'run-product-data-job.mjs'), 'utf8');
  // 只抽函数名 import 进来、调用点却还是旧的内联实现，是这条链上已经发作过的形态（M1 突变假绿）。
  assert.match(source, /import \{[^}]*describeGapsByStage[^}]*\} from '\.\.\/runtime\/product-alert-copy\.mjs'/u);
  assert.match(source, /const gapSummary = describeGapsByStage\(gaps\);/u);
  assert.match(source, /plainFailureClass\(failure\?\.class\)/u);
  assert.match(source, /const phenomenon = describePhenomena\(gaps\);/u);
  assert.match(source, /const action = describeNextAction\(failure\?\.class\);/u);
  // 缺口必须真的被传进 notifyFailure（传参侧与形参侧的字段名要一致，别只看调用存在）
  assert.match(source, /async function notifyFailure\(\{[^}]*\bgaps = \[\]/u);
  assert.match(source, /notifyFailure\(\{[^}]*\bgaps \}/u);
  // 旧的机读拼接不许回来
  assert.ok(!source.includes("`逐店现象：${gaps.map"), '内联拼接已抽出，不许在发送处再写一份');
});
