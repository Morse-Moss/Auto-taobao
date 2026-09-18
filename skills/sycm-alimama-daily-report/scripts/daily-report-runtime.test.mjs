import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildEnvironment,
  classifyFieldCoverage,
  dirHasEntries,
  evidenceBaseDir,
  injectedHelpersSource,
  resolveEvidenceDir,
  resolveFieldValue,
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

// 证据目录的店铺维度（2026-09-18 一轮多店铺实测暴露的 P1）。
// 缺口长这样：四家店串行跑同一天，`--commit` 走 latest 并入同一代 ⇒
// 后跑的店把先跑的店的 receipt/plan/paste 覆盖掉，而目录名上看不出这是四家店还是随机的最后一家。
// 修法是给目录加一维，但**默认行为必须逐字不变**（单店跑法与所有旧收据路径都不能变）。
test('证据目录的店铺维度：不给键时逐字不变，给了键就加一维', () => {
  const root = 'D:/Retire/sycm-automation/evidence';
  // ① 不给键（含空串、纯空白）⇒ 与 2026-09-14 起的旧形状逐字相同。
  for (const shopKey of [undefined, null, '', '   ']) {
    assert.equal(evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-09-17', shopKey }),
      path.join(root, 'daily-report-2026-09-17'));
  }
  // ② 给了键 ⇒ 日期后面接键；四家店因此各占一个目录，互不覆盖。
  assert.equal(evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-09-17', shopKey: '里可林淘宝' }),
    path.join(root, 'daily-report-2026-09-17-里可林淘宝'));
  // 同一家店同一天两次跑仍落在同一个基础目录上：加维度不改变「代次」语义（rerunN 还是 resolveEvidenceDir 的事）。
  assert.equal(path.basename(evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-09-17', shopKey: '里可林淘宝' })),
    'daily-report-2026-09-17-里可林淘宝');
});

test('证据目录的店铺键：非法键一律抛错，不许被拼进路径', () => {
  const root = 'D:/Retire/sycm-automation/evidence';
  const bad = ['../../etc', 'a/b', 'a\\b', '.', '..', 'a b', 'a\u200bb', 'a:b', 'a*b'];
  for (const shopKey of bad) {
    assert.throws(() => evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-09-17', shopKey }),
      /invalid shop key/u, `这个键本该被拒：${JSON.stringify(shopKey)}`);
  }
  // 反向自证：判据真的在判东西 —— 合法键不许被误伤。
  for (const shopKey of ['里可林淘宝', 'Paola_Lenti', 'A-1.2']) {
    assert.doesNotThrow(() => evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-09-17', shopKey }));
  }
  // 根与日期的守卫照旧：少一个都不许静默拼出一个相对目录。
  assert.throws(() => evidenceBaseDir({ reportDate: '2026-09-17' }), /requires an evidenceRoot/u);
  assert.throws(() => evidenceBaseDir({ evidenceRoot: root }), /invalid report date/u);
  assert.throws(() => evidenceBaseDir({ evidenceRoot: root, reportDate: '2026-9-7' }), /invalid report date/u);
});

test('三个写入方都按同一维拼证据目录，并且都把店铺键交给了它', () => {
  const files = ['run-daily-report.mjs', 'run-inquiry-backfill.mjs', 'readback-daily-report.mjs'];
  for (const name of files) {
    const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    // ① 都不再自己拼 `daily-report-${date}`（那是缺口本身）。
    assert.equal(/`daily-report-\$\{/u.test(source), false,
      `${name} 又自己拼证据目录名了：多店铺串行会互相覆盖`);
    // ② 都走 evidenceBaseDir，并且把 --shop-key 传了下去。
    assert.ok(source.includes('evidenceBaseDir('), `${name} 没有走 evidenceBaseDir`);
    assert.match(source, /shopKey: args\.shopKey/u, `${name} 没有把 --shop-key 传进 evidenceBaseDir`);
    assert.match(source, /--shop-key/u, `${name} 没有解析 --shop-key`);
  }
  // 反向自证：把拼接形状喂给判据，必须判红。
  assert.ok(/`daily-report-\$\{/u.test('const d = `daily-report-${reportDate}`'), '判据本身失效了');
  assert.match(readFileSync(path.join(SCRIPTS_DIR, 'run-daily-report.mjs'), 'utf8'),
    /assertEvidenceShopKey\(args\.shopKey, \{ fullName: fields\['店铺名称'\] \}\)/u,
    '推送方必须把源产物里的店名与键核对（错标签比不贴标签更糟）');
  assert.match(readFileSync(path.join(SCRIPTS_DIR, 'run-inquiry-backfill.mjs'), 'utf8'),
    /assertEvidenceShopKey\(args\.shopKey, \{ shopKey: args\.shop \}\)/u,
    '回填方必须把同一命令里的 --shop 与键核对');
  // 回读方没有源产物可核（它读的是飞书页面模型），所以只核「键是已登记的运营叫法」这一半，
  // 但这一半也必须在 mkdir 之前 —— 否则错标签的目录已经被建出来了，事后拦不住。
  const readback = readFileSync(path.join(SCRIPTS_DIR, 'readback-daily-report.mjs'), 'utf8');
  assert.match(readback, /if \(args\.shopKey\) assertEvidenceShopKey\(args\.shopKey\);/u,
    '回读方必须把键限制在已登记的运营叫法上');
  assert.ok(readback.indexOf('assertEvidenceShopKey(args.shopKey);')
    < readback.indexOf('mkdirSync(args.outputDir'), '键的核对必须在建目录之前');
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
  const own = { map: names, source: 'field-option-id' };
  const single = (token, extra = {}) => resolveFieldValue(token, { optionLayers: [own], ...extra });

  assert.deepEqual(single('optIYzOzu2'),
    { value: 'optIYzOzu2', display: '盖文天猫', resolvedBy: 'field-option-id' });
  // 普通文本/数字照原样过（别把 13 变成字符串，也别把店名当 id 去查）。
  assert.deepEqual(single('盖文天猫'), { value: '盖文天猫', display: '盖文天猫', resolvedBy: null });
  assert.deepEqual(single(13), { value: 13, display: 13, resolvedBy: null });
  assert.deepEqual(single({ text: 'x' }), { value: 'x', display: 'x', resolvedBy: null });
  assert.equal(single(null), null);
  assert.equal(single(undefined), null);
});

// 这条是 2026-09-17 第二次踩到的坑，也是「安静地印出错误证据」的典型：
// 同一个 opt id 在询单表叫「盖文淘宝」、在月度表里只写「盖文」⇒ 若只做全 base 扫描，
// 12 家店里 5 家会被判成歧义、退回原始 id（`optFFaXJeh`），而它看起来完全像个正常值。
// 分层之后：字段自己的选项优先，歧义只可能在最后的兜底层出现。
test('选项解析分层：字段自己的选项优先，跨表同名 id 不许冒充歧义', () => {
  const own = { optFFaXJeh: '盖文淘宝', optIYzOzu2: '盖文天猫' };
  const canonicalShop = { optFFaXJeh: '盖文淘宝', optLookedUp: '里可林天猫' };
  const globalMap = { optFFaXJeh: '盖文', optLookedUp: '里可林天猫' };
  const ambiguous = { optFFaXJeh: true };
  const layers = [
    { map: own, source: 'field-option-id' },
    { map: canonicalShop, source: 'canonical-shop-option-id' },
    { map: globalMap, source: 'global-option-id', ambiguous },
  ];
  const resolve = (token) => resolveFieldValue(token, { optionLayers: layers });

  // 第一层命中：字段自己的名字，跨表那份被截短的「盖文」不该影响它。
  assert.deepEqual(resolve('optFFaXJeh'),
    { value: 'optFFaXJeh', display: '盖文淘宝', resolvedBy: 'field-option-id' });
  // 第二层命中：派生字段（底单的「店铺」）自己没有选项，用权威店铺表解出名字。
  assert.deepEqual(resolve('optLookedUp'),
    { value: 'optLookedUp', display: '里可林天猫', resolvedBy: 'canonical-shop-option-id' });
  // 到了只有兜底层能解释、且同一 id 名不同名时，才退回原始 id 并标注 —— 宁可看见 id，也不要假映射。
  assert.deepEqual(resolveFieldValue('optOnlyGlobal', { optionLayers: [
    { map: {}, source: 'field-option-id' },
    { map: {}, source: 'canonical-shop-option-id' },
    { map: { optOnlyGlobal: '某店' }, source: 'global-option-id' },
  ] }), { value: 'optOnlyGlobal', display: '某店', resolvedBy: 'global-option-id' });
  // 反向自证：歧义判定真的会触发，不是为了写而写。
  assert.deepEqual(resolveFieldValue('optAmbig', { optionLayers: [
    { map: { optAmbig: '甲' }, source: 'global-option-id', ambiguous: { optAmbig: true } },
  ] }), { value: 'optAmbig', display: 'optAmbig', resolvedBy: 'ambiguous-option-id' });
});

// 2026-09-17 实测的第三种「安静地出错」：底单的「店铺」是 Lookup(type 19)，
// 265 个字段里**正好缺它这一个** —— `record.fields` 里连键都没有。回读原先对这种字段
// 与「这张表没有这个字段」走同一个 `continue`，于是产物里两者不可区分，
// 「读不到」被读成了「那格本来就空」。这条测的就是那三类必须分开写。
test('字段覆盖：派生字段读不到、普通字段为空格、表里没这个字段，三者必须区分开', () => {
  const fieldsOfInterest = ['统计日期', '店铺', '店铺名称', '询单量'];
  const fieldMeta = {
    统计日期: { id: 'fldDate', type: 5 },
    店铺: { id: 'fldsPXWgqt', type: 19 },
    店铺名称: { id: 'fldgI8PFX7', type: 1 },
  };
  const coverage = classifyFieldCoverage({
    rows: [
      { values: { 统计日期: { display: '2026-09-16' }, 店铺名称: { display: '盖文旗舰店' } } },
      { values: { 统计日期: { display: '2026-09-15' }, 店铺名称: { display: '盖文旗舰店' } } },
    ],
    fieldMeta,
    // 真实观测：这条记录的键集里**没有** fldsPXWgqt，但**有** fldgI8PFX7。
    sampleKeys: ['fldDate', 'fldgI8PFX7'],
    fieldsOfInterest,
    readableFallback: ['店铺名称'],
  });

  assert.equal(coverage.fieldsCoverageEvaluated, true);
  // 统计口径必须落进产物：整表的「324/2197 行没有值」与目标日的「12 行里几行有值」是两件事，
  // 不写口径的话读者会拿后者去解释前者。
  assert.equal(coverage.fieldsCoverageScope, null);
  assert.equal(classifyFieldCoverage({ rows: [{ values: {} }], fieldMeta: { 询单量: { id: 'fldQ', type: 2 } },
    sampleKeys: ['fldQ'], fieldsOfInterest: ['询单量'], scope: 'reportDate=2026-09-16' }).fieldsCoverageScope,
  'reportDate=2026-09-16');
  // 表里根本没有「询单量」⇒ 只记名字，不当成异常。
  assert.deepEqual(coverage.fieldsNotInTable, ['询单量']);
  assert.equal(coverage.absentFields.length, 1);

  const [shop] = coverage.absentFields;
  assert.equal(shop.name, '店铺');
  assert.equal(shop.fieldId, 'fldsPXWgqt');
  assert.equal(shop.type, 19);
  assert.equal(shop.rowsWithoutValue, 2);
  assert.equal(shop.rowsObserved, 2);
  assert.equal(shop.keyPresentInRecordFields, false);
  assert.equal(shop.reason, 'Lookup-key-absent-from-page-model');
  // 关键：要给出「为什么」和「去哪看权威值」，否则读者只能猜。
  assert.match(shop.note, /record\.fields 里根本不带这个派生字段/u);
  assert.match(shop.note, /不能读成「当天没写进去」/u);
  assert.match(shop.note, /店铺名称/u);
  // 反向自证：两种字段不能混为一谈 —— 值非空的「店铺名称」必须完全不出现。
  assert.equal(coverage.absentFields.some((entry) => entry.name === '店铺名称'), false);

  // 普通字段：键在、值空 ⇒ 那是「这格就是空的」这个业务事实，不许挂派生字段那条说明。
  const plain = classifyFieldCoverage({
    rows: [{ values: {} }, { values: { 询单量: { display: 3 } } }],
    fieldMeta: { 询单量: { id: 'fldQ', type: 2 } },
    sampleKeys: ['fldQ'],
    fieldsOfInterest: ['询单量'],
  });
  assert.deepEqual(plain.absentFields, [{ name: '询单量', fieldId: 'fldQ', type: 2,
    rowsWithoutValue: 1, rowsObserved: 2, scope: null, keyPresentInRecordFields: true,
    reason: 'null-in-page-model' }]);

  // 一行都没有时无从统计 ⇒ 标 evaluated=false，不许当成「所有字段都读到了」。
  const noRows = classifyFieldCoverage({ rows: [], fieldMeta, sampleKeys: [],
    fieldsOfInterest, readableFallback: ['店铺名称'] });
  assert.equal(noRows.fieldsCoverageEvaluated, false);
  assert.deepEqual(noRows.absentFields, []);

  // 全都有值 ⇒ 一条都不报（判据不是「永远报一条」）。
  const healthy = classifyFieldCoverage({
    rows: [{ values: { 询单量: { display: 3 } } }],
    fieldMeta: { 询单量: { id: 'fldQ', type: 2 } }, sampleKeys: ['fldQ'], fieldsOfInterest: ['询单量'],
  });
  assert.deepEqual(healthy.absentFields, []);
});

// 2026-09-17 现场跑才抓到的洞：`fn.toString()` 只带函数体，函数里引用的**模块级常量**
// 不会跟着进页面 —— classifyFieldCoverage 用了 DERIVED_FIELD_TYPES，注入后立刻
// `ReferenceError: DERIVED_FIELD_TYPES is not defined`。离线测试当时全绿，因为它 import 的是
// 模块里那份、作用域是全的。修法是把常量一并注入；判据则必须是**在只有这段代码的环境里真的调用一次**
// —— 字符串比对永远看不见「这个名字在页面里根本不存在」。
test('注入的片段自洽：剥掉模块作用域后仍能真的跑（光比字符串看不见未定义的引用）', () => {
  const source = injectedHelpersSource();
  // 沙箱里只有这一段的声明，模块里其它的名字一概不可见 —— 与页面里的处境一致。
  const factory = new Function(`${source}\nreturn { resolveFieldValue, classifyFieldCoverage };`);
  const sandbox = factory();

  // 真的调一次：日期换算（用到了模块外的 Date，属于语言内建，允许）。
  assert.equal(sandbox.resolveFieldValue(1789488000000, { type: 5 }).display, '2026-09-16');
  // 真的调一次：派生字段读不到 —— 这条正好踩在 DERIVED_FIELD_TYPES 上。
  const coverage = sandbox.classifyFieldCoverage({
    rows: [{ values: {} }],
    fieldMeta: { 店铺: { id: 'fldsPXWgqt', type: 19 } },
    sampleKeys: [],
    fieldsOfInterest: ['店铺'],
    readableFallback: [],
  });
  assert.equal(coverage.absentFields[0].reason, 'Lookup-key-absent-from-page-model');
  // 反向自证：把常量那行抽掉，沙箱里就该炸 —— 否则这条测试并没有在防它要防的东西。
  const withoutConst = source.split('\n').filter((line) => !line.includes('DERIVED_FIELD_TYPES =')).join('\n');
  assert.throws(() => new Function(`${withoutConst}\nreturn classifyFieldCoverage;`)()({
    rows: [{ values: {} }], fieldMeta: { 店铺: { id: 'x', type: 19 } }, sampleKeys: [], fieldsOfInterest: ['店铺'],
  }), /DERIVED_FIELD_TYPES is not defined/u);
});

test('日期字段：epoch 毫秒按 +08:00 换算，不随宿主时区漂移', () => {
  // 2026-09-16 00:00 +08:00
  const epoch = 1789488000000;
  assert.deepEqual(resolveFieldValue(epoch, { type: 5 }),
    { value: epoch, display: '2026-09-16', resolvedBy: 'epoch+08:00' });
  // 北京时间当天 00:30 —— 若按 UTC 算会变成 09-15，这正是坑 42。
  assert.equal(resolveFieldValue(epoch + 30 * 60 * 1000, { type: 5 }).display, '2026-09-16');
  // 非日期字段不许被当 epoch 处理。
  assert.deepEqual(resolveFieldValue(epoch, { type: 2 }), { value: epoch, display: epoch, resolvedBy: null });
});

test('回读表达式：注入的是同名实现（不是另抄一份），且分层顺序写死在里面', async () => {
  const { readTableExpression } = await import('./readback-daily-report.mjs');
  const expression = readTableExpression({ tableId: 'tblX', viewId: 'vewY' });
  // 注入的实现必须与模块里那个函数**逐字相同**，否则「测过的」和「在跑的」会分家。
  assert.ok(expression.includes(resolveFieldValue.toString()),
    '表达式里的 resolveFieldValue 与 daily-report-runtime.mjs 的不是同一份实现');
  assert.equal(expression.match(/const resolveFieldValue =/gu)?.length, 1);
  // 注入整段（含依赖常量）而不是各挑一句，见 injectedHelpersSource 的注释。
  assert.ok(expression.includes(injectedHelpersSource()), '表达式没有用 injectedHelpersSource 拼注入段');
  assert.equal(expression.match(/const classifyFieldCoverage =/gu)?.length, 1);
  assert.match(expression, /fieldsOfInterest:/u);
  assert.match(expression, /readableFallback:/u);
  // 口径必须收到目标日：整表统计会被别的日期的空行淹掉（实测 324/2197），
  // 报出来反而盖过真正要看的那条。
  assert.match(expression, /rows\.filter\(row => row\.values\.reportDate\?\.display === reportDate\)/u,
    '字段覆盖的统计口径必须收到目标日那几行');
  assert.match(expression, /fieldsCoverageScope|scope: scopedRows\.length/u, '口径必须写进产物');
  const scoped = readTableExpression({ tableId: 'tblX' }, { reportDate: '2026-09-16' });
  assert.ok(scoped.includes('const reportDate = "2026-09-16";'), '目标日必须以字面量拼进表达式');
  assert.ok(scoped.includes('reportDate=${reportDate}'), '口径字符串要带上具体日期');
  assert.ok(readTableExpression({ tableId: 'tblX' }).includes('const reportDate = null;'),
    '不给日期时按全表报，且必须显式写 null 而不是漏掉');
  // 三层顺序：字段自己的 → 权威店铺表 → 全 base（带歧义标记）。
  const order = ['field-option-id', 'canonical-shop-option-id', 'global-option-id']
    .map((source) => expression.indexOf(`source: '${source}'`));
  assert.ok(order.every((index) => index > 0), `分层没有齐全：${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '分层顺序不对：字段自己的选项必须排在最前');
  assert.match(expression, /ambiguous: globalAmbiguous/u);
  // 读之前必须**导航到那张表**：跨表读老页面拿到的是打开那一刻的快照（实测差过 12 条）。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'readback-daily-report.mjs'), 'utf8');
  assert.match(source, /await navigate\(args, page, url\);\s*\n\s*result\.page\.navigations\.push\(url\);/u,
    '每张表都必须先导航再读');
  // 行集不齐时「当天命中 0 条」只是下界，必须标注出来 —— 否则「目标行还没被物化」会被读成「当天没有」。
  assert.match(source, /onDateCountIsLowerBound: !rowState\.complete/u, '行集不齐必须标注命中数是下界');
  assert.match(source, /const rowState = await waitForRows\(/u, '读之前必须先等行集齐');
  assert.match(source, /caveat:/u, '行集不齐要写出可读的说明，不能只留一个布尔');
  // 读不到的字段必须**打到屏幕上**：只写进 JSON 的话，看屏的人读到的还是「没有这一列」。
  assert.match(source, /for \(const field of entry\.absentFields \?\? \[\]\)/u,
    '读不到的字段必须打印出来');
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
  // 干跑与 `--commit` 是同一次运行的两阶段：提交必须并入干跑建的那一代。
  // 2026-09-17 实测过反例：commit 走默认 'fresh' ⇒ 干跑落 `-rerun4`、提交顺延 `-rerun5`，一次运行被拆成两代。
  assert.match(report, /policy: args\.commit \? 'latest' : 'fresh'/u,
    '提交必须并入最新一代，否则同一次运行的干跑与收据会被拆到两个目录');
  // 反向自证：判据真的在判东西 —— 把 policy 写成常量就该判红。
  assert.equal(/policy: args\.commit \? 'latest' : 'fresh'/u.test("resolveEvidenceDir({ baseDir, explicit, isOccupied, policy: 'fresh' })"),
    false, 'policy 判据本身失效了');
});
