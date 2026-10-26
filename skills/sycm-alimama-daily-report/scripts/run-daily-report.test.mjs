import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 这个文件只做**源码结构**守卫。跑不出行为用例（`main()` 一进来就要连浏览器与飞书），
// 但它钉的两件事故都是「结构错了、行为看上去没错」的那种，正是本项目吃过多次的形态。

const stripComments = (source) => source
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
  .map((line) => line.replace(/\/\/.*$/u, ''))
  .join('\n');

const codeOnly = stripComments(readFileSync(new URL('./run-daily-report.mjs', import.meta.url), 'utf8'));

test('dry-run 遇到「当天已有行」要先给结论，再轮到真跑抛错（2026-10-26）', () => {
  // 事故形态：三家店的数据早已在飞书，一轮只想验证「导入前的流程」的排练因此全红在第 7 步，
  // 而它红的原因恰恰是「这一天其实已经干完了」—— 和「流程跑不通」是两件相反的事，
  // 被人读到就会得出相反的动作。演练不写飞书，所以重复行对它是**结论**，不是阻断。
  const dupBranch = codeOnly.indexOf('if (duplicates.length)');
  const throwSite = codeOnly.indexOf('duplicate daily report row exists');
  assert.ok(dupBranch > 0, '「当天已有行」那段判据必须在');
  assert.ok(throwSite > dupBranch, '真跑那条 throw 必须仍在同一个判据块里');
  const between = codeOnly.slice(dupBranch, throwSite);
  assert.match(between, /DRY_RUN_READY_BUT_DUPLICATE/u, '演练专用分支必须在（status=DRY_RUN_READY_BUT_DUPLICATE）');
  assert.match(between, /if\s*\(!args\.commit\)/u, '演练分支必须以「不是 --commit」为条件 —— 不许顺手放行真跑');
});

test('真跑那条报错原文不许改：上层靠它分诊成 DUPLICATE_TARGET', () => {
  // run-multi-shop-day.mjs 的 shopFailureCause 用 /duplicate daily report row exists/u 分诊。
  // 改了措辞 ⇒ 判据失效 ⇒ 一个「不用做任何事」的成因被当成「要人处理」，每天把人叫起来。
  assert.match(codeOnly, /duplicate daily report row exists:/u);
});
