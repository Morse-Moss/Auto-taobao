import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { discoverSkillTests, REPO_ROOT } from '../scripts/test-suite-discovery.mjs';

// 这条守的是「测试写了、套件能跑、但 CI 不跑它」。
//
// 为什么需要它（2026-09-17 实测发现）：`skills` 套件用目录发现，会自动认出
// `skills/<name>/{tests,scripts}` 下的新测试；而 `.github/workflows/ci.yml` 的矩阵是**手写的名单**。
// 于是「新加一个 skill、测试也齐、本地全绿」之后，CI 上它一个用例都不跑，而 CI 仍然是绿的
// —— 与 test-suite-discovery.test.mjs 守的是同一族问题（绿色假象），只是换了一层。
// 实测当时的缺口：sycm-alimama-daily-report / xws-faq-operator / xws-sku-collection 三个 skill
// 共 8 个测试文件在 CI 上零覆盖，而矩阵里的注释还写着「它们的测试在 runtime/ 里，fast-gate 已覆盖」
// —— 注释与事实不符，且没有任何东西会因此变红。
//
// 判据不是「抄一份名单进测试」（那会变成第二份真相），而是**从套件的发现结果推导期望值**：
// 谁有测试，谁就必须在 CI 矩阵里。规则改了只改一处。

const CI_FILE = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

// 从工作流里取矩阵的 skill 名单。刻意手写解析而不是引 YAML 库：
// 仓库的 Node 依赖里没有 YAML 解析器，为一条守卫加依赖不划算；
// 而且矩阵就这一种形状（`- skill: <name>`），解析不到时下面的非空自证会立刻红。
function skillsInCiMatrix() {
  const text = readFileSync(CI_FILE, 'utf8');
  return [...text.matchAll(/^\s*-\s*skill:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
}

// 谁「有测试」以套件的发现为准（与 `run-test-suite.mjs skills` 用的是同一个函数）。
function skillsOwningTests() {
  const set = new Set();
  for (const file of discoverSkillTests()) {
    const parts = file.split('/');
    if (parts[0] === 'skills' && parts.length > 1) set.add(parts[1]);
  }
  return set;
}

test('CI 矩阵里的 skill 名单与「自带测试的 skill」完全一致', () => {
  assert.ok(existsSync(CI_FILE), `找不到 CI 工作流：${CI_FILE}`);

  const listed = skillsInCiMatrix();
  const owned = skillsOwningTests();

  // 先自证两边都真的扫到了东西：空结果不许被读成「没问题」（见坑 33）。
  assert.ok(owned.size >= 5, `没发现任何自带测试的 skill，发现逻辑可能坏了：${[...owned].join(', ')}`);
  assert.ok(listed.length >= 5, `CI 矩阵里一个 skill 都没有，解析可能坏了：${JSON.stringify(listed)}`);

  // 名单内部不许重复：重复会让同一个 skill 跑两遍，覆盖率的账也对不上。
  assert.equal(new Set(listed).size, listed.length, `CI 矩阵里有重复条目：${listed.join(', ')}`);

  const missing = [...owned].filter((skill) => !listed.includes(skill)).sort();
  assert.deepEqual(
    missing,
    [],
    '这些 skill 自带测试、本地套件会跑，但 CI 矩阵里没有它们 —— 等于在 CI 上零覆盖',
  );

  const phantom = [...listed].filter((skill) => !owned.has(skill)).sort();
  assert.deepEqual(
    phantom,
    [],
    'CI 矩阵里有这些 skill，但它们名下没有任何被发现的测试文件 —— 要么名字写错，要么测试被搬走了',
  );
});
