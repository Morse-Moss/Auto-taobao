import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { retiredKeywordDecisionWriter } from './retired-keyword-decision-writer.mjs';

test('retired direct writer fails before credentials or network can be used', () => {
  assert.throws(() => retiredKeywordDecisionWriter(), /RETIRED.*apply-weekly-decision-formulas.*sync-decision-history/iu);
  const source = fs.readFileSync(new URL('./apply-keyword-decisions.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('retiredKeywordDecisionWriter()') < main.indexOf('readEnv(ENV_FILE)'));
});
