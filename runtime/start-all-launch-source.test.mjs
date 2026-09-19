// 判据：`scripts/start-all.mjs` 取「怎么起」的口径必须是 buildFullPlan()，而不是 buildDeclarationPlan()。
//
// 为什么要有这条测试（2026-09-19 实测到的真崩溃）：
//   用户授权「全部杀了重跑」，`node scripts/start-all.mjs --timeout 60` 立刻崩在
//     TypeError: Cannot read properties of undefined (reading 'find')
//       at main (scripts/start-all.mjs:145)
//   根因：start-all 调的是 buildDeclarationPlan()，而它的条目上**没有** `launch` 字段
//   （launch/stopOrder 是 buildFullPlan() 补上的）⇒ `item.launch.find(...)` 必崩。
//
//   它能活到这一刻，是因为唯一的验证方式是 `--dry-run`，而排练模式只走打印分支、
//   压根不进 spawn 循环。**排练路径全绿 ≠ 真路径能跑** —— 这是这条测试要钉住的东西：
//   判据不能在「同一件事的另一条分支」上取，否则它证明不了任何事。
//
// 判据分两层，故意都留着：
//   · 数据层 —— 六种判决下该起的每个角色，都能在条目自己的 launch 里找到（崩溃的直接成因）；
//   · 源码层 —— start-all 不许再退回 buildDeclarationPlan（防止「改回来」这种回归）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT, stripComments } from './arch-boundary-scan.mjs';
import { buildDeclarationPlan } from './browser-inventory.mjs';
import { buildFullPlan, selectActions } from './launch-plan.mjs';

const START_ALL = path.join(REPO_ROOT, 'scripts/start-all.mjs');
const CODE = stripComments(fs.readFileSync(START_ALL, 'utf8'));

test('buildFullPlan 的每个条目都带 launch（buildDeclarationPlan 的条目不承诺带）', () => {
  const full = buildFullPlan();
  assert.ok(full.length > 0, '一个实例都没有 —— 登记表读空时这条判据没有意义，必须报错而不是通过');
  for (const entry of full) {
    assert.ok(
      Array.isArray(entry.launch),
      `${entry.who} 的 buildFullPlan 条目上没有 launch 数组 —— start-all 就是在这里崩的`,
    );
    assert.deepEqual(
      entry.launch.map((c) => c.role).sort(),
      ['browser', 'proxy'],
      `${entry.who} 的启动命令不是「浏览器 + 代理」两条`,
    );
    for (const command of entry.launch) {
      assert.equal(typeof command.file, 'string');
      assert.ok(command.file.length > 0, `${entry.who}/${command.role} 的启动脚本路径是空的`);
      assert.ok(Array.isArray(command.args), `${entry.who}/${command.role} 的 args 不是数组`);
    }
  }
  // 差别本身也要被钉住：没有它，下一个人会以为两者可以互换。
  const first = buildDeclarationPlan()[0];
  assert.equal(
    Object.hasOwn(first, 'launch'), false,
    'buildDeclarationPlan 的条目现在带 launch 了 —— 若这是有意的，请同步改掉这条判据的说明，'
    + '否则它会和「start-all 必须用 buildFullPlan」那条互相矛盾',
  );
});

test('六种判决下该起的每个角色，都能在条目自己的 launch 里找到', () => {
  const judgements = ['ready', 'proxy-missing', 'browser-missing', 'missing', 'foreign', 'unconfirmed'];
  // 未知判决也必须查：selectActions 的 default 分支同样要保证不给出起不来的角色。
  const buckets = [...judgements, 'unknown-verdict'];
  for (const entry of buildFullPlan()) {
    const available = new Set(entry.launch.map((c) => c.role));
    for (const judgement of buckets) {
      for (const role of selectActions(judgement).start) {
        assert.ok(
          available.has(role),
          `${entry.who} 判决=${judgement} 时要起 ${role}，但它的 launch 里只有 ${[...available].join('/')}`
          + ' —— 这正是 2026-09-19 那次崩溃的形状',
        );
      }
    }
  }
});

test('scripts/start-all.mjs 的命令口径是 buildFullPlan，不得退回 buildDeclarationPlan', () => {
  assert.ok(
    /buildFullPlan\s*\(/u.test(CODE),
    'scripts/start-all.mjs 没有从 buildFullPlan() 取计划 —— 它需要 launch 字段才能起进程',
  );
  assert.ok(
    !/buildDeclarationPlan\s*\(/u.test(CODE),
    'scripts/start-all.mjs 又用回 buildDeclarationPlan() 了：它的条目上没有 launch，'
    + '一旦真有实例需要起就会崩在 item.launch.find(...)，而排练模式看不见',
  );
});
