import test from 'node:test';
import assert from 'node:assert/strict';

await assert.rejects(
  import('./sync-question-library-template.mjs'),
  /Deprecated FAQ template synchronization is disabled/u,
);

test('legacy FAQ template synchronization is disabled', () => {
  assert.ok(true);
});
