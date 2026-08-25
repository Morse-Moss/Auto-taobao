import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

let guard = {};
try {
  guard = await import('./retired-huitun-result-writer.mjs');
} catch {
  // RED phase: the retired-entry guard does not exist yet.
}
const retiredHuitunResultWriter = guard.retiredHuitunResultWriter ?? (() => assert.fail('missing retired Huitun writer guard'));

test('retired fixed-table Huitun writer fails before results, credentials, or network are used', () => {
  assert.throws(() => retiredHuitunResultWriter(), /RETIRED.*huitun-to-feishu-keyword-heat/iu);
  const source = fs.readFileSync(new URL('./apply-huitun-results.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('retiredHuitunResultWriter()') < main.indexOf('resultPathArg'));
  assert.ok(main.indexOf('retiredHuitunResultWriter()') < main.indexOf('readEnv(ENV_FILE)'));
});
