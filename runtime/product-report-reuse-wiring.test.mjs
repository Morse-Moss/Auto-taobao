// 守卫：商品链「同业务日重跑」自愈的**接线**（2026-10-17 加）。
//
// 为什么单独一份：`reuseCandidateTask` 本身是纯函数（见
// skills/sycm-promotion-data/scripts/product-report-core.mjs），好测；真会静默失效的是它两端的接线：
//   ① 采集侧 —— 不把 `submittedOn` 传进 `submit()`，或者 catch 里不用它，
//      自愈就变成「catch 里再抛一次同样的错」，症状与修之前一模一样（本项目已发作过三次的那种）。
//      更阴的一种：把 `o.date`（业务日）当成 `submittedOn` 传进去 —— 任务名里是**提交当天**，
//      业务日是「昨天」⇒ 永远筛不到候选，自愈永不触发，而代码看上去「明明接了」。
//   ② 导入侧 —— 复用不保证数据就是目标日（任务名看不出参数），唯一的安全网是
//      `validatePromotionReport(..., { date })` 的逐行日期校验。它一旦没被传 `date`，
//      一次复用就能把 10-15 的推广数据写成 10-16 的，而收据上看不出任何异常。
//
// 所以这份守卫只钉「调用侧真传了什么」，纯函数行为由 skill 侧单测负责。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replaceAll('\r\n', '\n');

const COLLECTOR = 'skills/sycm-promotion-data/scripts/collect-product-report.mjs';
const IMPORTER = 'skills/sycm-promotion-data/scripts/import-promotion-data.mjs';

test('结构：采集侧真的把 reuseCandidateTask 接进了「无法唯一确认」那条 catch 里', () => {
  const source = read(COLLECTOR);
  assert.match(source, /import \{[^}]*\breuseCandidateTask\b[^}]*\} from '\.\/product-report-core\.mjs'/u,
    '没有从 product-report-core 引入 reuseCandidateTask');
  const uniqueCall = source.indexOf('uniqueNewProductTask(before,after)');
  assert.ok(uniqueCall > 0, '找不到 uniqueNewProductTask 的调用点 —— 结构变了就要连这份守卫一起改');
  const catchAt = source.indexOf('catch', uniqueCall);
  const reuseCall = source.indexOf('reuseCandidateTask(', catchAt);
  assert.ok(catchAt > uniqueCall && reuseCall > catchAt,
    '自愈必须长在 uniqueNewProductTask 抛错的那条 catch 里；写成「提交前先猜一个」就等于放弃「平台确实没生成新任务」这个判据');
  const rethrow = source.indexOf('if(!reused)throw error', reuseCall);
  assert.ok(rethrow > reuseCall,
    '没有候选时必须把**原来那条错**抛出去；否则「今天真的没交过、也没生成」会被伪装成别的东西');
  const assign = source.indexOf('task=reused', rethrow);
  assert.ok(assign > rethrow, '拿到候选之后没有真的把 task 换成它 ⇒ 后面下载的仍是空值');
});

test('结构：submittedOn 取「提交当天」（+08），绝不拿业务日顶替', () => {
  const source = read(COLLECTOR);
  // 与 run() 里同一处写法：new Date(Date.now()+8*3600*1000).toISOString().slice(0,10)
  const compute = source.indexOf('const submittedOn=new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);');
  assert.ok(compute > 0,
    '找不到 submittedOn 的赋值 —— 必须由**当前时刻**算，任务名里的日期是提交当天、不是数据日');
  const passAt = source.indexOf('submit(proxy,target,before,submittedOn)', compute);
  assert.ok(passAt > compute,
    'submittedOn 算出来却没传进 submit() ⇒ 自愈筛的是 undefined，等于没接');
  // 反面：任何拿 o.date / 业务日 顶替提交日的写法都要拦下来
  assert.doesNotMatch(source, /submit\(proxy,target,before,o\.date\)/u,
    '把业务日当提交日传 ⇒ 业务日是「昨天」，永远筛不到今天的任务，自愈永不触发');
  assert.doesNotMatch(source, /submittedOn\s*=\s*o\.date\b/u,
    '把业务日当提交日传 ⇒ 业务日是「昨天」，永远筛不到今天的任务，自愈永不触发');
});

test('结构：导入侧把 --date 真的交给了逐行日期校验（复用的唯一安全网）', () => {
  const source = read(IMPORTER);
  assert.match(source, /validatePromotionReport\(x\.headers,x\.rows,\{date:o\.date\}\)/u,
    '导入器没有把 --date 传给 validatePromotionReport ⇒ 复用出来的错日期数据会被整批写进去，且收据无异常');
  // 反面：别处再冒出第二个「不传 date」的调用点，等于给这条安全网开了后门
  const calls = source.match(/validatePromotionReport\(/gu) ?? [];
  assert.equal(calls.length, 1,
    `导入器里只允许一处 validatePromotionReport 调用（实际 ${calls.length} 处）—— 多出来的那处很容易漏传 date`);
});

test('接线：collect-product-report 的 run() 与 submit() 参数名对得上', () => {
  const source = read(COLLECTOR);
  const sig = source.match(/async function submit\(([^)]*)\)/u);
  assert.ok(sig, '找不到 submit 的定义 —— 结构变了就要连这份守卫一起改');
  const params = sig[1].split(',').map((x) => x.trim());
  assert.deepEqual(params, ['proxy', 'target', 'before', 'submittedOn'],
    'submit 的形参名/顺序变了，调用侧还在按位置传 ⇒ 自愈会拿到 undefined 或拿反');
});
