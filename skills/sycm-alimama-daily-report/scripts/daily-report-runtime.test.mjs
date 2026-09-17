import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildEnvironment,
  dirHasEntries,
  resolveEvidenceDir,
  resolveOptionToken,
} from './daily-report-runtime.mjs';

const SCRIPTS_DIR = import.meta.dirname;

// 用「哪些目录算被占」的假判据做测试：真实目录里有内容与否会随别人的跑动漂移。
function occupied(...dirs) {
  const set = new Set(dirs);
  return (dir) => set.has(dir);
}

test('证据目录：第一次跑用基础目录，同一代已经有人用过就顺延 -rerun2 / -rerun3', () => {
  const base = 'evidence/daily-report-2026-09-16';
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied() }),
    { dir: base, generation: 1, reason: 'base-empty' });
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied(base) }),
    { dir: `${base}-rerun2`, generation: 2, reason: 'base-occupied' });
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied(base, `${base}-rerun2`) }),
    { dir: `${base}-rerun3`, generation: 3, reason: 'base-occupied' });
});

test('证据目录：显式给了目录就不改名（那是调用方的选择，脚本不替他决定）', () => {
  const explicit = 'C:/tmp/mine';
  for (const policy of ['fresh', 'latest']) {
    assert.deepEqual(
      resolveEvidenceDir({ baseDir: 'evidence/x', explicit, isOccupied: occupied('evidence/x'), policy }),
      { dir: explicit, generation: null, reason: 'explicit' },
    );
  }
});

// 这条是 2026-09-17 真正的坑：回填若按 'fresh' 走，第一天的第二次跑会把它推到 -rerun3，
// 于是同一次运行的 plan/receipt 和回填产物被拆进两个目录，「哪一代」这个问题就没有答案了。
test('证据目录 latest 策略：并入当前最新一代，而不是另开一代', () => {
  const base = 'evidence/daily-report-2026-09-16';
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied(), policy: 'latest' }),
    { dir: base, generation: 1, reason: 'latest' });
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied(base), policy: 'latest' }),
    { dir: base, generation: 1, reason: 'latest' });
  assert.deepEqual(resolveEvidenceDir({ baseDir: base, isOccupied: occupied(base, `${base}-rerun2`), policy: 'latest' }),
    { dir: `${base}-rerun2`, generation: 2, reason: 'latest' });
});

test('证据目录：策略写错或没给 baseDir 一律抛错（不许静默按默认值跑）', () => {
  assert.throws(() => resolveEvidenceDir({ baseDir: 'evidence/x', policy: 'whatever' }), /unknown evidence policy/u);
  assert.throws(() => resolveEvidenceDir({}), /requires a baseDir/u);
  assert.throws(() => resolveEvidenceDir({ baseDir: '' }), /requires a baseDir/u);
});

test('dirHasEntries：目录不存在或读不到只算「没内容」，不抛错', () => {
  assert.equal(dirHasEntries(path.join(SCRIPTS_DIR, '__definitely_not_here__')), false);
  assert.equal(dirHasEntries(SCRIPTS_DIR), true);
});

test('环境旁证：默认值标 registry-default，环境变量优先，非法值如实记 env-invalid', () => {
  const ports = { browser: 19122, proxy: 19123 };
  const identities = { id: 'browser-a', label: 'Browser A' };

  const fallback = buildEnvironment({ proxyUrl: 'http://127.0.0.1:19123', ports, identities, env: {} });
  assert.deepEqual(fallback.browserPort, { port: 19122, source: 'registry-default', registryDefault: 19122 });
  assert.deepEqual(fallback.proxyPort, { port: 19123, source: 'registry-default', registryDefault: 19123 });
  assert.deepEqual(fallback.browserId, { id: 'browser-a', source: 'registry-default' });
  assert.match(fallback.computedAt, /^\d{4}-\d{2}-\d{2}T/u);

  const overridden = buildEnvironment({ proxyUrl: null, ports, identities,
    env: { CDP_BROWSER_PORT: '19999', CDP_PROXY_PORT: '19998', CDP_BROWSER_ID: 'other' } });
  assert.deepEqual(overridden.browserPort, { port: 19999, source: 'env', registryDefault: 19122 });
  assert.deepEqual(overridden.proxyPort, { port: 19998, source: 'env', registryDefault: 19123 });
  assert.deepEqual(overridden.browserId, { id: 'other', source: 'env' });

  // 关键：不合法的值**不许**悄悄回落到登记表默认值 —— 那会把「跑在别的端口上」这件事抹掉。
  const invalid = buildEnvironment({ ports, identities, env: { CDP_BROWSER_PORT: '  ' , CDP_PROXY_PORT: '70000' } });
  assert.deepEqual(invalid.browserPort, { port: 19122, source: 'registry-default', registryDefault: 19122 });
  assert.equal(invalid.proxyPort.port, null);
  assert.equal(invalid.proxyPort.source, 'env-invalid');
  assert.equal(invalid.proxyPort.raw, '70000');
});

test('页面模型的单元格：SingleSelect 的选项 id 必须换成名字，换不出来要标出来', () => {
  const names = { optIYzOzu2: '盖文天猫', optOther: '盖文旗舰店' };
  assert.deepEqual(resolveOptionToken('optIYzOzu2', names),
    { value: 'optIYzOzu2', display: '盖文天猫', resolvedBy: 'option-id' });
  // 同一个 id 在不同字段指向不同名字时，「映射成功」是假的：保留原始 id 并标注，不猜。
  assert.deepEqual(resolveOptionToken('optIYzOzu2', names, { optIYzOzu2: true }),
    { value: 'optIYzOzu2', display: 'optIYzOzu2', resolvedBy: 'ambiguous-option-id' });
  // 普通文本/数字照原样过（别把 13 变成字符串，也别把店名当 id 去查）。
  assert.deepEqual(resolveOptionToken('盖文天猫', names), { value: '盖文天猫', display: '盖文天猫', resolvedBy: null });
  assert.deepEqual(resolveOptionToken(13, names), { value: 13, display: 13, resolvedBy: null });
  assert.deepEqual(resolveOptionToken({ text: 'x' }, names), { value: 'x', display: 'x', resolvedBy: null });
  assert.equal(resolveOptionToken(null, names), null);
  assert.equal(resolveOptionToken(undefined, names), null);
});

test('回读表达式：注入的是同名实现（不是另抄一份），且真的走选项映射', async () => {
  const { readTableExpression } = await import('./readback-daily-report.mjs');
  const expression = readTableExpression({ tableId: 'tblX', viewId: 'vewY' });
  // 注入的实现必须与模块里那个函数**逐字相同**，否则「测过的」和「在跑的」会分家。
  assert.ok(expression.includes(resolveOptionToken.toString()),
    '表达式里的 resolveOptionToken 与 daily-report-runtime.mjs 的不是同一份实现');
  assert.match(expression, /resolveOptionToken\(token, optionName, optionAmbiguous\)/u);
  assert.match(expression, /option-id/u);
  assert.match(expression, /ambiguous-option-id/u);
  // 注入它就是为了别在页面里再抄一份：抄一份就会有两份实现。
  assert.equal(expression.match(/const resolveOptionToken =/gu)?.length, 1);
});

test('两个写入方都把证据目录交给 resolveEvidenceDir，回填用 latest 并入同一代', () => {
  const report = readFileSync(path.join(SCRIPTS_DIR, 'run-daily-report.mjs'), 'utf8');
  const backfill = readFileSync(path.join(SCRIPTS_DIR, 'run-inquiry-backfill.mjs'), 'utf8');
  for (const [name, source] of [['run-daily-report.mjs', report], ['run-inquiry-backfill.mjs', backfill]]) {
    assert.ok(source.includes('resolveEvidenceDir('), `${name} 没有走 resolveEvidenceDir`);
    // 这条精确钉住被修掉的那个形状：`args.outputDir || path.join(...evidence...)` 直接当输出目录。
    assert.equal(/args\.outputDir\s*\|\|/u.test(source), false,
      `${name} 又自己拼证据目录了：同一天第二次跑会静默覆盖上一轮`);
    assert.equal(/path\.resolve\(args\.outputDir \|\|/u.test(source), false, `${name} 又自己拼证据目录了`);
  }
  // 反向自证：判据真的在判东西，而不是正则写废了才全绿。
  assert.ok(/args\.outputDir\s*\|\|/u.test('const d = args.outputDir || path.join(root, "x")'), '判据本身失效了');
  assert.equal(/args\.outputDir\s*\|\|/u.test('const d = args.outputDir ? path.resolve(args.outputDir) : null'), false);
  assert.match(backfill, /policy: 'latest'/u, '回填必须并入当前最新一代');
  assert.match(report, /baseDir, explicit: args\.outputDir, isOccupied: dirHasEntries/u);
});
