import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedFiles, selectChecks } from '../scripts/run-affected-tests.mjs';

test('maps a skill change to only that skill suite', () => {
  assert.deepEqual(classifyChangedFiles(['skills/xws-sku-collection/scripts/parse.mjs']), ['skill:xws-sku-collection']);
  assert.deepEqual(selectChecks(['skills/xws-sku-collection/scripts/parse.mjs']).commands, [
    {
      key: 'node\u0000scripts/run-test-suite.mjs\u0000skills\u0000--skill=xws-sku-collection',
      command: 'node',
      args: ['scripts/run-test-suite.mjs', 'skills', '--skill=xws-sku-collection'],
    },
  ]);
});

test('runs only the changed skill test file when the test itself changed', () => {
  assert.deepEqual(selectChecks(['skills/xws-sku-collection/tests/parser.test.mjs']).commands, [
    {
      key: 'node\u0000--test\u0000skills/xws-sku-collection/tests/parser.test.mjs',
      command: 'node',
      args: ['--test', 'skills/xws-sku-collection/tests/parser.test.mjs'],
    },
  ]);
});

test('maps runtime implementation changes to the runtime suite', () => {
  assert.deepEqual(selectChecks(['runtime/round-runner.mjs']).checks, ['runtime']);
  assert.deepEqual(selectChecks(['runtime/round-runner.mjs']).commands[0].args, ['run', 'test:runtime']);
});

test('runs only the changed runtime test file when the test itself changed', () => {
  assert.deepEqual(selectChecks(['runtime/round-runner.test.mjs']).commands, [
    {
      key: 'node\u0000--test\u0000runtime/round-runner.test.mjs',
      command: 'node',
      args: ['--test', 'runtime/round-runner.test.mjs'],
    },
  ]);
});

test('does not run product tests for documentation-only changes', () => {
  assert.deepEqual(selectChecks(['docs/standards/README.md']).checks, ['docs']);
  assert.deepEqual(selectChecks(['docs/standards/README.md']).commands, []);
});

// 2026-09-30 修：只改一个**编排脚本**曾经会命中 `unit` ⇒ 拉进 `unit:skills` 那 67 个技能用例文件，
// 实测 `test:unit` 跑了 22 分 56 秒仍未结束（技能段里有会等满 CLI 60 分钟下载超时的 e2e 用例）。
// 编排脚本的判据本来就在 runtime 里（计划/接线守卫），所以这两条钉住「脚本改动只拉 runtime 段」。
test('a repository-level orchestrator script maps to the runtime suite, never to unit', () => {
  for (const file of ['scripts/run-product-data-job.mjs', 'scripts/run-daily-job.mjs', 'scripts/stop-all.mjs']) {
    const selection = selectChecks([file]);
    assert.deepEqual(selection.checks, ['runtime'], `${file} 应当只命中 runtime`);
    assert.ok(!selection.checks.includes('unit'),
      `${file} 命中了 unit ⇒ 每次改编排脚本都要跑一遍技能用例（小时级），门禁会因此没人跑`);
    assert.deepEqual(selection.commands.map((item) => item.args.join(' ')), ['run test:runtime']);
  }
});

test('non-JS files under scripts/ and stray root scripts still go through unit (no runtime fallback)', () => {
  // `scripts/` 下若出现 `.py`、以及**仓库根**下的零散脚本，没有 runtime 侧判据兜底 ⇒ 宁可贵也不漏。
  assert.deepEqual(classifyChangedFiles(['scripts/tool.py']), ['unit']);
  assert.deepEqual(classifyChangedFiles(['some-root-script.mjs']), ['unit']);
});
