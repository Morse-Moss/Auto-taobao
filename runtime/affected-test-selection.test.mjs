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
