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
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_PORTS, shopInstance } from '../../../runtime/browser-ports.mjs';
import { feishuDailyPageFragment } from './expected-pages.mjs';
import {
  REPAIR_EXIT_CODES, applyRepairAction, locateStagePage, parseRepairArgs, renderRepairReport, resolveProxy,
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

// --- readTargets 契约用例（2026-09-29 真机排练补）--------------------------------
//
// 病根：`applyRepairAction` 调的是 `readTargets(args)`——传**整个 args 对象**，
// 读回 `{ ok, targets, error }`。而同一个名字在 `failure-perception.mjs` 里是**另一种契约**
// （`readTargets(proxy)`，proxy 是字符串，返回裸数组）。两处同名、两种形状。
//
// `run-multi-shop-day.mjs` 的 `execRepair` 原先抄了 perception 那一种注入，
// 于是 `readTargets` 拿到 `[object Object]`、拼出 `[object Object]/targets` ⇒
// **每个非 RESET_PAGES 的动作都报「读不到页签（代理连不上）」、退 3**（而 RESET_PAGES 不读页签，
// 看起来「正常」）。函数级全绿测不出（用例自己注入 exec，走不到 applyRepairAction）。
// 下面两条把契约钉死：注入一份 `readTargets(args)`，断言它收到的是 args 对象、且页面被定位到。
const TARGETS_FIXTURE = [{
  type: 'page', targetId: 'T1', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new',
}];

test('applyRepairAction：readTargets 收到的是整个 args 对象（不是代理地址字符串）', async () => {
  const seen = [];
  const out = await applyRepairAction(
    { shop: '里可林淘宝', proxy: 'http://127.0.0.1:19041', stage: 'shop-report', action: 'RELOAD_PAGE', logDir: 'tmp/x', dryRun: true },
    {
      readTargets: async (a) => { seen.push(a); return { ok: true, targets: TARGETS_FIXTURE, error: null }; },
      log: () => {},
    },
  );
  assert.equal(seen.length, 1, '非 RESET_PAGES 动作必须先读页签');
  assert.equal(typeof seen[0], 'object', 'readTargets 收的必须是 args 对象，收成字符串会拼出 [object Object]/targets');
  assert.equal(seen[0].proxy, 'http://127.0.0.1:19041', 'args 里必须带 proxy —— 适配器要靠它拼 URL');
  assert.equal(out.targetUrl, TARGETS_FIXTURE[0].url, '定位到页 ⇒ 说明契约对了');
  assert.equal(out.exitCode, REPAIR_EXIT_CODES.APPLIED);
});

test('applyRepairAction：readTargets 契约不符（把 args 当字符串拼进 URL）⇒ 退 3 而不是静默', async () => {
  // 复刻错误注入：base 是对象 ⇒ `${base}/targets` 变成 "[object Object]/targets"
  const out = await applyRepairAction(
    { shop: '里可林淘宝', proxy: 'http://127.0.0.1:19041', stage: 'shop-report', action: 'RELOAD_PAGE', logDir: 'tmp/x' },
    {
      readTargets: async (base) => ({ ok: String(base).startsWith('http'), targets: TARGETS_FIXTURE }),
      log: () => {},
    },
  );
  assert.equal(out.exitCode, REPAIR_EXIT_CODES.INCONCLUSIVE, '读不到页签 ⇒ 退 3（既不通过也不算应用失败）');
  assert.match(String(out.detail), /读不到页签/u);
});

test('applyRepairAction：RESET_PAGES 不需要目标页（归位本身就是去找页）', async () => {
  let called = false;
  const out = await applyRepairAction(
    { shop: '里可林淘宝', proxy: 'http://127.0.0.1:19041', stage: 'shop-report', action: 'RESET_PAGES', logDir: 'tmp/x', dryRun: true },
    { readTargets: async () => { called = true; return { ok: false, targets: null, error: '不该被调' }; }, log: () => {} },
  );
  assert.equal(called, false, 'RESET_PAGES 不该读页签');
  assert.equal(out.exitCode, REPAIR_EXIT_CODES.APPLIED);
});

// ---------------------------------------------------------------------------
// 按阶段选实例（2026-10-14）：`--proxy` 是唯一实例选择器，而「哪一台」随阶段变
// ---------------------------------------------------------------------------
//
// 起因（实测一次，报告在 `evidence/batches-2026-10-13/b2/网林淘宝/97-repair-agent-report.md`）：
// 失败的第 11 步 `readback` 跑在**共用商家浏览器** 19023 上，而框架给 agent 的 `execHint`
// 写的是**这家店自己的**代理；`resolveProxy` 的一致性闸门又**无条件**要求
// 「`--shop X` ⇒ 这家店自己的代理」⇒ agent 连「改成 19023」都做不到（当场被判对不上）。
// 于是动作只能落在店铺实例的**标识页**上：`applied:true`，而动不到真正出问题的那一页。
//
// 现在「哪些阶段跑在共用窗口上」只有一处答案（`stage-browsers.mjs`），本文件只消费它。
const SHOP = '网林淘宝';
const SHOP_PROXY = `http://127.0.0.1:${shopInstance(SHOP).proxyPort}`;
const SHARED_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;

test('resolveProxy：共用阶段（readback）允许「--shop X + 共用代理」这一组', () => {
  assert.equal(resolveProxy({ shop: SHOP, proxy: SHARED_PROXY, stage: 'readback' }), SHARED_PROXY,
    'readback 的作业对象在共用窗口里 —— 原先这一组被闸门判成「对不上」，修复永远指不到那一台');
  assert.equal(resolveProxy({ shop: SHOP, proxy: SHARED_PROXY, stage: 'push' }), SHARED_PROXY);
});

test('resolveProxy：同一个共用代理用在非共用阶段 ⇒ 仍然抛，且报错要点名该去哪一台', () => {
  let error = null;
  try {
    resolveProxy({ shop: SHOP, proxy: SHARED_PROXY, stage: 'backfill' });
  } catch (err) { error = err; }
  assert.ok(error, '非共用阶段配共用代理必须停手（否则动作会落到另一台机器上）');
  assert.match(error.message, /对不上/u);
  assert.ok(error.message.includes(SHOP_PROXY),
    `报错要把「该去的那一台」写出来（缺了它，读单子的人只知道错、不知道改哪个）：${error.message}`);
  assert.match(error.message, /backfill/u, '报错要带上阶段名，否则分不清是哪个阶段按哪台选的');
});

test('resolveProxy：给了店名却不给 --proxy ⇒ 非共用阶段回落这家店自己的代理', () => {
  // 原先一律回落共用 —— 那等于在「对不上就停手」的闸门旁边留了一条不用对就能走的路，
  // 而走上去的后果与「对不上」一样：动作落在另一台浏览器上。
  assert.equal(resolveProxy({ shop: SHOP, proxy: null, stage: 'backfill' }), SHOP_PROXY);
  assert.equal(resolveProxy({ shop: SHOP, proxy: null, stage: 'sycm-date' }), SHOP_PROXY);
});

test('resolveProxy：给了店名却不给 --proxy ⇒ 共用阶段回落共用那台', () => {
  assert.equal(resolveProxy({ shop: SHOP, proxy: null, stage: 'readback' }), SHARED_PROXY);
});

test('resolveProxy：没给店名的裸调用逐字沿用旧口径（回落共用商家浏览器）', () => {
  // `--shop` 出现之前的老用法就长这样，行为刻意不变 —— 改掉它会让所有没点名的调用报错。
  assert.equal(resolveProxy({ shop: null, proxy: null, stage: null }), SHARED_PROXY);
  assert.equal(resolveProxy({ proxy: null, stage: 'backfill' }), SHARED_PROXY,
    '没点名店 ⇒ 不知道是谁的实例，按旧口径回落共用（与本文件原来的行为一致）');
});

// ---------------------------------------------------------------------------
// 目标页定位：飞书底单页（2026-10-14 补 push / readback 的语义标签）
// ---------------------------------------------------------------------------

test('locateStagePage：feishu 提示认得出飞书底单页，且不会认成店铺标识页/别的站点页', () => {
  // 片段从**唯一来源**取（不写死 baseToken：租户可切换，写死会让用例在换租户那天假红）。
  const fragment = feishuDailyPageFragment();
  const targets = [
    { type: 'page', targetId: 'f', url: `https://kcne618basvj.feishu.cn/${fragment}?table=tblX&view=vewY` },
    { type: 'page', targetId: 'l', url: 'file:///D:/Retire/sycm-automation/runtime/label.html?shop=%E7%BD%91%E6%9E%97%E6%B7%98%E5%AE%9D&port=19060' },
    { type: 'page', targetId: 's', url: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new' },
    { type: 'page', targetId: 'z', url: 'about:blank' },
  ];
  const result = locateStagePage({ targets, stageHint: 'feishu' });
  assert.equal(result.ok, true, '给了 feishu 提示就该认得出那一页，而不是退化成「窗口里恰好一个页」');
  assert.equal(result.targetId, 'f');
});

test('locateStagePage：飞书地址躺在查询串里 ⇒ 不假命中（结构判据，不是整串 includes）', () => {
  const fragment = feishuDailyPageFragment();
  // 阳性对照：这一段 URL **确实**把整个片段含在字符串里（旧口径 `includes` 必中）。
  const url = `https://kcne618basvj.feishu.cn/login?next=/${fragment}`;
  assert.ok(url.includes(fragment), '构造前提：整串确实包含片段 —— 否则这条用例在测一件碰巧的事');
  const result = locateStagePage({ targets: [{ type: 'page', targetId: 'x', url }], stageHint: 'feishu' });
  assert.equal(result.ok, false, '主机相同但 pathname 不是 /base/<token> ⇒ 不是那一页（查询串不参与匹配）');
  assert.match(result.reason, /找不到/u);
});

test('接线：归属判据走全仓唯一那一份，且飞书片段每次调用重算（不冻住租户）', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'repair-shop-stage.mjs'), 'utf8');
  assert.match(source, /import \{ pagesMatching \} from '\.\.\/\.\.\/\.\.\/runtime\/target-url-match\.mjs'/u,
    '页签归属必须用 target-url-match.mjs —— 自己写 `.includes(主机)` 会把登录跳转页算成工作页');
  assert.match(source, /pagesMatching\(pages, fragment\)/u,
    '定位要真的调用它，而不是 import 了不用');
  assert.match(source, /if \(hint === 'feishu'\) return feishuDailyPageFragment\(\);/u,
    '飞书片段必须**每次调用时求值**：base 由 dailyReportTargets() 在运行时解析，写成模块级常量会把租户冻住');
  assert.ok(!/\.includes\(host\)/u.test(source),
    '定位函数里不该再留一份自己的 `.includes(主机)` 实现（那是 target-url-match 要治的旧口径）');
});

test('locateStagePage：站点提示下「就剩一个页签」也不许当成目标页（不猜）', () => {
  // 10-13 那次的形态：共用窗口里飞书页不在了，只剩店铺标识页 ⇒ 旧实现退化成
  // 「窗口里恰好一个非 about: 页 ⇒ 就用它」⇒ 修复动作落在标识页上而「成功」。
  const targets = [
    { type: 'page', targetId: 'l', url: 'file:///D:/Retire/sycm-automation/runtime/label.html?shop=x&port=19060' },
  ];
  const result = locateStagePage({ targets, stageHint: 'feishu' });
  assert.equal(result.ok, false, '给了站点提示时，判据是「符合这个站点」而不是「有几个页签」');
  assert.match(result.reason, /找不到/u);
});

test('applyRepairAction：readback 一轮自己找得到飞书底单页（阶段名 → 提示 → 定位 一条线走通）', async () => {
  // 这条把三段接起来：阶段名 → `STAGE_PAGE_HINT[stage]` → `locateStagePage`。
  // 缺了任何一段的量级都一样：`readback` / `push` 会退化成
  // 「窗口里恰好一个页就用它」⇒ 窗口里有标识页 + 工作页时直接停手（`INCONCLUSIVE`），
  // 有标识页 + 飞书页时**动错页**（10-13 那次的形态）。
  const fragment = feishuDailyPageFragment();
  const targets = [
    { type: 'page', targetId: 'l', url: 'file:///D:/Retire/sycm-automation/runtime/label.html?shop=x&port=19060' },
    { type: 'page', targetId: 'f', url: `https://kcne618basvj.feishu.cn/${fragment}?table=tblX` },
  ];
  const out = await applyRepairAction(
    { shop: SHOP, proxy: SHARED_PROXY, stage: 'readback', action: 'RELOAD_PAGE', logDir: 'tmp/x', dryRun: true },
    { readTargets: async () => ({ ok: true, targets }), log: () => {} },
  );
  assert.equal(out.targetUrl, targets[1].url,
    'readback 的目标页是飞书底单页；落到标识页上就是那次「applied:true 却什么都没修」');
  assert.equal(out.exitCode, REPAIR_EXIT_CODES.APPLIED);
});
