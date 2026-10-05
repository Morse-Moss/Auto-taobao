import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FAILURE_STATE_EXPRESSION,
  captureFailureState,
  renderFailureStateText,
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
