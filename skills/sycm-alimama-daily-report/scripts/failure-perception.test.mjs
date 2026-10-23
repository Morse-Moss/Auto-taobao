import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FAILURE_STATE_EXPRESSION,
  captureFailureState,
  pickFailureTarget,
  renderFailureStateText,
  siteFragmentFor,
  unwrapEvalValue,
} from './failure-perception.mjs';

const makeDir = () => mkdtempSync(path.join(tmpdir(), 'failure-perception-'));

const sampleState = {
  capturedAt: '2026-09-28T00:00:00.000Z',
  url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
  title: '生意参谋',
  viewport: { w: 1178, h: 460, dpr: 1, scrollY: 0 },
  visibleText: '统计时间 2026-09-27 询单到付款',
  dialogs: [{ tag: 'DIV', id: 'wrapper_dlg_797', cls: 'next-dialog-wrapper', z: '99999',
    rect: { x: 0, y: 0, w: 1178, h: 460 }, text: '任务生成中' }],
  interactive: [{ tag: 'BUTTON', id: 'submit', text: '下载报表', cls: 'next-btn',
    rect: { x: 796, y: 0, w: 45, h: 26 } }],
  domSummary: { totalElements: 1234, counts: { DIV: 900 }, containers: [] },
  tables: [{ rows: 0, cols: 0, rect: { x: 0, y: 0, w: 0, h: 0 }, visible: false }],
};

test('表达式是自包裹的 IIFE，且带 safe 包装（页面任何一项取不到都不该中断整体）', () => {
  assert.match(FAILURE_STATE_EXPRESSION, /^\(\(\) => \{/);
  assert.match(FAILURE_STATE_EXPRESSION, /catch \{ return fallback;? \}/);
  assert.match(FAILURE_STATE_EXPRESSION, /viewport/);
  assert.match(FAILURE_STATE_EXPRESSION, /dialogs/);
  assert.match(FAILURE_STATE_EXPRESSION, /interactive/);
  assert.match(FAILURE_STATE_EXPRESSION, /tables/);
});

test('全成功：落 JSON + 人读文本 + 截图，ok=true', async () => {
  const dir = makeDir();
  try {
    const written = [];
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '里可林淘宝', stage: 'promotion-fetch',
      error: '阶段 promotion-fetch 失败（exit 1）',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://sycm.taobao.com/x' }]),
      // ⚠️ 这里必须是**代理真会的那个形状**：`/eval` 回 `{ value: <表达式返回值> }`。
      // 本用例原来喂的是裸字符串 —— 那是错的契约，于是真机上「包装没剥」这个缺陷
      // 在函数级一直全绿（本项目第 N 次「用例全绿 ≠ 接线接上了」）。
      evalInPage: async () => ({ value: JSON.stringify(sampleState) }),
      screenshot: async (proxy, targetId, file) => { written.push(file); return file; },
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.ok(existsSync(result.files.stateJson));
    assert.ok(existsSync(result.files.stateText));
    assert.ok(result.files.screenshot.endsWith('98-failure-page.png'));
    const txt = readFileSync(result.files.stateText, 'utf8');
    assert.match(txt, /停在哪一步：promotion-fetch/);
    assert.match(txt, /wrapper_dlg_797/);
    assert.match(txt, /下载报表/);
    assert.match(txt, /1178x460/);
    const json = JSON.parse(readFileSync(result.files.stateJson, 'utf8'));
    assert.equal(json.viewport.w, 1178);
    assert.equal(json.value, undefined, '落盘的必须是**剥过包装**的现场，不是 {"value":…}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 包装剥层（2026-10-05）
//
// 现场真事：`/eval` 回 `{ value: "…" }`，旧代码只判「是不是字符串」⇒ 拿对象当 state 用 ⇒
// 产物落盘、`ok:true`、人读版每一栏都是 `?` 与空串。**不报错**，所以没人会去查。
// 这一族判据钉住「包装必须剥掉」与「剥不出对象就不许说采到了」。

test('unwrapEvalValue：剥掉 {value} 包装（真代理的形状），也认裸字符串', () => {
  assert.deepEqual(unwrapEvalValue({ value: '{"url":"https://x"}' }), { url: 'https://x' });
  assert.deepEqual(unwrapEvalValue('{"url":"https://x"}'), { url: 'https://x' });
  assert.deepEqual(unwrapEvalValue({ value: { value: '{"url":"https://x"}' } }), { url: 'https://x' },
    '多套一层也别慌（代理再包一层就认不出来了）');
  // 已经是对象、没有包装 ⇒ 原样返回，别动它。
  assert.deepEqual(unwrapEvalValue({ url: 'https://x', title: 'y' }), { url: 'https://x', title: 'y' });
  // 不是 JSON 的字符串 ⇒ 原样返回（由调用点判形状，别在这里假装解析成功）。
  assert.equal(unwrapEvalValue('not json'), 'not json');
});

test('取到的不是现场对象 ⇒ ok=false、如实记原因是「形状不对」，且不落一套空壳产物', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '盖文天猫', stage: 'promotion-fetch',
      error: 'x',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://sycm.taobao.com/x' }]),
      evalInPage: async () => ({ value: 'null' }),
      screenshot: async () => {},
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.equal(result.files.stateJson, undefined, '采空了就不许落一套「看着像采到了」的空壳');
    assert.ok(result.errors.some((line) => /不是页面现场对象/u.test(line)), result.errors.join('｜'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('整段永不抛：读页签抛错也返回对象、把原因记进 errors', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '网林天猫', stage: 'sycm-date-again',
      error: '主线失败原因',
      readTargets: async () => { throw new Error('ECONNRESET'); },
      evalInPage: async () => { throw new Error('不该被调用'); },
      screenshot: async () => { throw new Error('不该被调用'); },
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /ECONNRESET/);
    // 关键：**主线失败原因原样保留**，感知失败不许改写它
    assert.equal(result.stage, 'sycm-date-again');
    assert.equal(result.shopKey, '网林天猫');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('部分失败：DOM 取到了、截图挂了 ⇒ ok=true、JSON 照写、截图记进 errors', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '科塔淘宝', stage: 'sycm-date',
      error: '按钮在视口外',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://sycm.taobao.com/x' }]),
      evalInPage: async () => JSON.stringify(sampleState),
      screenshot: async () => { throw new Error('HTTP 500 / CDP 命令超时: Page.captureScreenshot'); },
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.ok(result.files.stateJson);
    assert.ok(result.files.stateText);
    assert.equal(result.files.screenshot, undefined);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /截图失败/);
    assert.match(result.errors[0], /captureScreenshot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('没有可用页签 ⇒ 不崩，如实记「读不到页签」', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '盖文淘宝', stage: 'push',
      error: 'exit 1',
      readTargets: async () => ([]),
      evalInPage: async () => { throw new Error('不该被调用'); },
      screenshot: async () => { throw new Error('不该被调用'); },
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /读不到任何页签/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('about:blank 会被跳过，优先取真实页面（否则记录的是空页，等于白采）', async () => {
  const dir = makeDir();
  try {
    let usedTarget = null;
    await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '盖文天猫', stage: 'promotion-fetch',
      error: 'x',
      readTargets: async () => ([
        { type: 'page', targetId: 'BLANK', url: 'about:blank' },
        { type: 'page', targetId: 'REAL', url: 'https://sycm.taobao.com/x' },
      ]),
      evalInPage: async (proxy, targetId) => { usedTarget = targetId; return JSON.stringify(sampleState); },
      screenshot: async () => {},
      log: () => {},
    });
    assert.equal(usedTarget, 'REAL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('写盘失败也绝不抛，记进 errors', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '里可林淘宝', stage: 'sycm-date',
      error: 'x',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://sycm.taobao.com/x' }]),
      evalInPage: async () => JSON.stringify(sampleState),
      screenshot: async () => {},
      writeFile: () => { throw new Error('EACCES'); },
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.match(result.errors.join(' '), /写现场产物失败/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('人读文本在 state 为 null 时给明确占位，而不是空字符串', () => {
  const txt = renderFailureStateText(null, { shopKey: 'X', stage: 'push', error: 'y' });
  assert.match(txt, /没能取到页面现场/);
});

test('人读文本不吞关键事实：遮挡层/视口/可见元素都在', () => {
  const txt = renderFailureStateText(sampleState, { shopKey: '里可林淘宝', stage: 'promotion-fetch', error: 'zzz' });
  for (const needle of ['里可林淘宝', 'promotion-fetch', 'zzz', 'wrapper_dlg_797',
    '99999', '1178x460', '下载报表', '796,0,45x26']) {
    assert.ok(txt.includes(needle), `人读文本缺：${needle}`);
  }
});

// ---------------------------------------------------------------- 拍对页（2026-10-13）
//
// 真实现场（这条用例存在的全部理由）：店铺实例的**第一个**非 `about:` 页签是店铺标识页
// （`runtime/shop-window-label.html`），于是 `promotion-fetch` 失败时，旧代码采到的
// 就是那一页 —— 文件在、`ok:true`、内容却与出事的那一页无关：
//   evidence/batches-2026-10-10/b1/里可林淘宝/98-failure-state.txt
//     URL：file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=里可林淘宝&port=19031
// 「没人查」从来不是这条缺陷拖着的理由，是**采错了页**。下面这一族钉住「按站点提示取页」。

test('pickFailureTarget：给了站点提示时挑该站点的页，不被标识页抢走', () => {
  const targets = [
    { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E9%87%8C%E5%8F%AF%E6%9E%97%E6%B7%98%E5%AE%9D&port=19031' },
    { type: 'page', targetId: 'ALIMAMA', url: 'https://one.alimama.com/index.html#!/report/account' },
    { type: 'page', targetId: 'SYCM', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop' },
  ];
  const alimama = pickFailureTarget(targets, { pageHint: 'alimama' });
  assert.equal(alimama.target.targetId, 'ALIMAMA');
  assert.equal(alimama.how, 'pageHint');
  const sycm = pickFailureTarget(targets, { pageHint: 'sycm' });
  assert.equal(sycm.target.targetId, 'SYCM');
  assert.equal(sycm.how, 'pageHint');
});

test('pickFailureTarget：没有提示时逐字保持历史行为（第一个非 about 页签）', () => {
  const targets = [
    { type: 'page', targetId: 'BLANK', url: 'about:blank' },
    { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=x&port=19031' },
    { type: 'page', targetId: 'ALIMAMA', url: 'https://one.alimama.com/index.html' },
  ];
  const picked = pickFailureTarget(targets, {});
  assert.equal(picked.target.targetId, 'LABEL', '不给提示就还是老样子 —— 不许悄悄改默认行为');
  assert.equal(picked.how, 'firstNonAboutPage');
  assert.equal(picked.fragment, null, '没有提示就没有片段，别假装有');
});

test('pickFailureTarget：给了提示但那一站的页不在 ⇒ 退回第一个非 about 页签，且 how 说清是退回的', () => {
  const targets = [
    { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=x&port=19031' },
  ];
  const picked = pickFailureTarget(targets, { pageHint: 'alimama' });
  assert.equal(picked.target.targetId, 'LABEL');
  assert.equal(picked.how, 'firstNonAboutPage');
  assert.equal(picked.fragment, 'one.alimama.com', '片段要留着，调用点才能说「提示了却没挑到」');
});

test('pickFailureTarget：一个页签都没有 ⇒ how=none，不猜', () => {
  assert.equal(pickFailureTarget([], { pageHint: 'alimama' }).how, 'none');
  assert.equal(pickFailureTarget(null, { pageHint: 'alimama' }).how, 'none');
  assert.equal(pickFailureTarget([{ type: 'page', targetId: 'B', url: 'about:blank' }], { pageHint: 'alimama' }).target.targetId, 'B',
    '连非 about 页签都没有时，退回第一个页签，让调用点去报「读不到任何页签」');
});

test('siteFragmentFor：片段只从 date-picker 的 siteAdapter 取，认不出的标签返回 null', () => {
  assert.equal(siteFragmentFor('alimama'), 'one.alimama.com');
  assert.equal(siteFragmentFor('sycm'), 'sycm.taobao.com/qos/service/frame/shop/performance');
  assert.equal(siteFragmentFor('不存在的站点'), null);
  assert.equal(siteFragmentFor(null), null);
});

test('captureFailureState：pageHint 真的传到选页上（拍的是出事那一站，不是标识页）', async () => {
  const dir = makeDir();
  try {
    let usedTarget = null;
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '里可林淘宝', stage: 'promotion-fetch',
      error: '30000ms 内没等到新 zip',
      pageHint: 'alimama',
      readTargets: async () => ([
        { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=x&port=19031' },
        { type: 'page', targetId: 'ALIMAMA', url: 'https://one.alimama.com/index.html#!/report/account' },
      ]),
      evalInPage: async (proxy, targetId) => { usedTarget = targetId; return { value: JSON.stringify(sampleState) }; },
      screenshot: async () => {},
      log: () => {},
    });
    assert.equal(usedTarget, 'ALIMAMA', '拍错页就等于白采 —— 这条钉的是「采到的那一页」');
    assert.equal(result.selected.how, 'pageHint');
    assert.equal(result.selected.url, 'https://one.alimama.com/index.html#!/report/account');
    const txt = readFileSync(result.files.stateText, 'utf8');
    assert.match(txt, /现场页签：按站点提示「alimama」选中/, '人读版必须说清这一页是怎么选中的');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('captureFailureState：提示了却没挑到那一站 ⇒ 留一条告警，且人读版写明是退回的', async () => {
  const dir = makeDir();
  try {
    const lines = [];
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19041', logDir: dir, shopKey: '网林天猫', stage: 'promotion-fetch',
      error: 'x', pageHint: 'alimama',
      readTargets: async () => ([
        { type: 'page', targetId: 'LABEL', url: 'file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=x&port=19031' },
      ]),
      evalInPage: async () => ({ value: JSON.stringify(sampleState) }),
      screenshot: async () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(result.selected.how, 'firstNonAboutPage');
    assert.ok(lines.some((line) => /没挑到页签/.test(line)), lines.join('｜'));
    const txt = readFileSync(result.files.stateText, 'utf8');
    assert.match(txt, /给了提示「alimama」但没挑到该站点的页/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 目录不存在（2026-10-19）
//
// 真事：商品链把 logDir 传成 `<shop>/promotion-collect`，而这个目录只有采到文件才有东西落进去
// ⇒ 提交阶段就失败时它不存在，writeFileSync 直接 ENOENT，现场 JSON 与人读文本一起丢。
// 2026-10-19 网林家居/推广 就是这样丢的证据：报告里只剩「写现场产物失败」+「截图 500」，
// 于是「平台没受理」与「读太早」再也分不开。判据＝目录不存在也必须落下来。

test('logDir 的下层目录不存在时也要把现场落下来（不许 ENOENT 丢证）', async () => {
  const dir = makeDir();
  try {
    const logDir = path.join(dir, 'promotion-collect'); // 故意不建
    assert.equal(existsSync(logDir), false, '前提：这个目录本来不存在');
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19062', logDir, shopKey: '网林家居', stage: 'promotion-collect',
      error: '采集失败：商品报表提交任务无法唯一确认',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://one.alimama.com/index.html#!/report/download-list' }]),
      evalInPage: async () => ({ value: JSON.stringify(sampleState) }),
      screenshot: async () => {},
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, [], `不该再有「写现场产物失败」：${result.errors.join('｜')}`);
    assert.ok(existsSync(result.files.stateJson), '现场 JSON 必须落盘');
    assert.ok(existsSync(result.files.stateText), '人读文本必须落盘');
    assert.match(readFileSync(result.files.stateText, 'utf8'), /停在哪一步：promotion-collect/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('建目录失败也不许盖掉主因：照样返回对象、把原因记进 errors', async () => {
  const dir = makeDir();
  try {
    const result = await captureFailureState({
      proxy: 'http://127.0.0.1:19062', logDir: path.join(dir, 'nope'), shopKey: '网林家居', stage: 'promotion-collect',
      error: '主因',
      readTargets: async () => ([{ type: 'page', targetId: 'T1', url: 'https://one.alimama.com/index.html#!/report/download-list' }]),
      evalInPage: async () => ({ value: JSON.stringify(sampleState) }),
      screenshot: async () => {},
      mkdir: () => { throw new Error('EACCES: 无权限'); },
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.url, sampleState.url);
    assert.ok(result.errors.some((line) => /写现场产物失败.*EACCES/u.test(line)), result.errors.join('｜'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
