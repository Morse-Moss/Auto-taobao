/**
 * `repair-shop-stage.mjs` 的离线用例。
 *
 * 这个脚本是**写路径**（会关弹窗、重载、归位），真机验证成本高且当前禁止起停进程，
 * 所以能离线钉住的判据必须全部钉住 —— 尤其是那三条最容易静默出错的：
 *   ① 动作名闭集校验（拼错一名字不许静默变「什么也没做」）；
 *   ② `--shop` 与 `--proxy` 的一致性（对不上时必须停手，不许往别的店写）；
 *   ③ 目标页定位（认不出来时**不猜一页**）。
 *
 * 不测「真去点页面」那一层（那需要活浏览器，属 integration）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPAIR_EXIT_CODES, locateStagePage, parseRepairArgs, renderRepairReport, resolveProxy,
} from './repair-shop-stage.mjs';

test('parseRepairArgs：动作名不在闭集里 ⇒ 当场抛（不许静默变空操作）', () => {
  assert.throws(
    () => parseRepairArgs(['--action', 'DISMISS_OVERLAY']),
    /不在闭集/u,
    '拼错的动作名（少个 S）必须被拦下',
  );
});

test('parseRepairArgs：不给 --action ⇒ 抛（不知道要做什么就不做）', () => {
  assert.throws(() => parseRepairArgs(['--shop', '里可林淘宝']), /必须给 --action/u);
});

test('parseRepairArgs：合法参数被正确接住（含布尔 --dry-run 与数字参数）', () => {
  const args = parseRepairArgs(['--shop', '里可林淘宝', '--proxy', 'http://127.0.0.1:19041',
    '--stage', 'promotion-fetch', '--cause', 'PAGE_OBSTRUCTED', '--action', 'DISMISS_OVERLAYS',
    '--log-dir', 'evidence/x', '--settle-ms', '3000', '--dry-run']);
  assert.equal(args.shop, '里可林淘宝');
  assert.equal(args.proxy, 'http://127.0.0.1:19041');
  assert.equal(args.stage, 'promotion-fetch');
  assert.equal(args.cause, 'PAGE_OBSTRUCTED');
  assert.equal(args.action, 'DISMISS_OVERLAYS');
  assert.equal(args.settleMs, 3000);
  assert.equal(args.dryRun, true);
});

test('parseRepairArgs：未知参数 ⇒ 抛（不静默吞掉）', () => {
  assert.throws(() => parseRepairArgs(['--action', 'RELOAD_PAGE', '--bogus']), /unknown argument/u);
});

test('resolveProxy：--shop 与 --proxy 对不上 ⇒ 抛（绝不往别的店写）', () => {
  assert.throws(
    () => resolveProxy({ shop: '里可林淘宝', proxy: 'http://127.0.0.1:19045' }),
    /对不上/u,
  );
});

test('resolveProxy：--shop 配它自己的代理 ⇒ 通过', () => {
  const proxy = resolveProxy({ shop: '里可林淘宝', proxy: 'http://127.0.0.1:19041' });
  assert.equal(proxy, 'http://127.0.0.1:19041');
});

test('resolveProxy：不给 --proxy ⇒ 回落商家浏览器默认端口（与采集脚本同口径）', () => {
  const proxy = resolveProxy({ shop: null, proxy: null });
  assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/u);
});

test('locateStagePage：给站点提示时按主机精确匹配', () => {
  const targets = [
    { type: 'page', targetId: 'a', url: 'https://one.alimama.com/index.html' },
    { type: 'page', targetId: 'b', url: 'https://sycm.taobao.com/shop/performance' },
    { type: 'page', targetId: 'c', url: 'about:blank' },
  ];
  assert.equal(locateStagePage({ targets, stageHint: 'alimama' }).targetId, 'a');
  assert.equal(locateStagePage({ targets, stageHint: 'sycm' }).targetId, 'b');
});

test('locateStagePage：同主机多于一个 ⇒ 不猜（停手）', () => {
  const targets = [
    { type: 'page', targetId: 'a', url: 'https://one.alimama.com/1' },
    { type: 'page', targetId: 'b', url: 'https://one.alimama.com/2' },
  ];
  const result = locateStagePage({ targets, stageHint: 'alimama' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /不猜/u);
});

test('locateStagePage：找不到该主机 ⇒ 如实报，不回落第一个页签', () => {
  const targets = [{ type: 'page', targetId: 'x', url: 'https://sycm.taobao.com/x' }];
  const result = locateStagePage({ targets, stageHint: 'alimama' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /找不到/u);
});

test('locateStagePage：没有阶段提示且页签多于一个 ⇒ 不猜', () => {
  const targets = [
    { type: 'page', targetId: 'a', url: 'https://a.example.com' },
    { type: 'page', targetId: 'b', url: 'https://b.example.com' },
  ];
  const result = locateStagePage({ targets, stageHint: null });
  assert.equal(result.ok, false);
  assert.match(result.reason, /不猜/u);
});

test('locateStagePage：没有阶段提示但恰好一个非 about: 页 ⇒ 用它', () => {
  const targets = [{ type: 'page', targetId: 'a', url: 'https://a.example.com' }, { type: 'page', targetId: 'z', url: 'about:blank' }];
  assert.equal(locateStagePage({ targets, stageHint: null }).targetId, 'a');
});

test('locateStagePage：空/全 about: ⇒ 停手（读不到不等于修第一个）', () => {
  assert.equal(locateStagePage({ targets: [], stageHint: 'alimama' }).ok, false);
  assert.equal(locateStagePage({ targets: [{ type: 'page', targetId: 'z', url: 'about:blank' }], stageHint: 'alimama' }).ok, false);
});

test('renderRepairReport：把动作/目标/结论/证据都写进人读正文', () => {
  const text = renderRepairReport({
    action: 'DISMISS_OVERLAYS', shop: '里可林淘宝', stage: 'promotion-fetch', cause: 'PAGE_OBSTRUCTED',
    targetUrl: 'https://one.alimama.com/x', applied: true, detail: '遮挡层已关掉（candidate）',
    evidence: { strategy: 'candidate' }, error: null, dryRun: false,
  });
  assert.match(text, /DISMISS_OVERLAYS/u);
  assert.match(text, /里可林淘宝/u);
  assert.match(text, /已应用/u);
  assert.match(text, /candidate/u);
});

test('退出码口径：三个值互不相同且都是整数', () => {
  const values = Object.values(REPAIR_EXIT_CODES);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(Number.isInteger(v));
  assert.equal(REPAIR_EXIT_CODES.APPLIED, 0);
});
