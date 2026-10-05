// 守卫：商品数据链的**跑前登录预检接线**（2026-10-05 改：预检不再是闸门）。
//
// 为什么单独一份：这次改的不是一个函数，而是「一个退出码在**五处**同时改变含义」：
//   ① 判定段（`rows[]` → 本批先不采的店；`rows` 读不出才是唯一 fail-closed）
//   ② 采集段（被剔除的店在采集之前就退出，不许进共享下载目录）
//   ③ 缺口段（剔除要**记进 gaps**，否则整批少采几家而整轮报绿 —— 比不修更坏）
//   ④ 归因段（`failedStage` 要落 `login`，不然会把人指到 `product-import`）
//   ⑤ 补页段（读不到且无人被踢回登录页时先补页复查一次，且复用既有补页实现）
// 漏任何一处都不报错、只静默做错事。所以这里既钉源码接线点，也跑纯函数用例。
//
// 起因（2026-10-05 真机，`evidence/product-data-job-2026-10-04/…-7e3ec402/`）：
// 盖文天猫阿里妈妈页签不在位 ⇒ 探针 only 回 `UNREADABLE` ⇒ 预检退出码 3 ⇒ 旧代码 `throw`
// ⇒ **整批 5 家一步采集都没跑**；而事后只读复查该店两个站点都是 LOGGED_IN。
// 日报链对此的既有约定是 `buildLoginPreflightStep()` 的 `blocking: false`（「守卫不是闸门」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { blockedShopsFrom, describeLoginRow, shouldRepairPages } from '../scripts/run-product-data-job.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'scripts/run-product-data-job.mjs';

/** 读源码并把行尾归一到 LF —— 断言按 `\n` 写，别因为工作区的 CRLF 变红。 */
function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

// ---------------------------------------------------------------------------
// 一、纯函数：判「哪几家先不采」
// ---------------------------------------------------------------------------

test('只有 verdict=OK 才算通过：UNKNOWN（读不到）与 NEEDS_LOGIN（掉登录）都要被剔除', () => {
  const blocked = blockedShopsFrom({
    rows: [
      { shop: '网林淘宝', verdict: 'OK', sites: { sycm: 'LOGGED_IN', alimama: 'LOGGED_IN' }, needsLogin: [], unreadable: [] },
      { shop: '盖文天猫', verdict: 'UNKNOWN', sites: { sycm: 'LOGGED_IN', alimama: 'UNREADABLE' }, needsLogin: [], unreadable: ['alimama'] },
      { shop: '科塔淘宝', verdict: 'NEEDS_LOGIN', sites: { sycm: 'LOGGED_OUT', alimama: 'LOGGED_IN' }, needsLogin: ['sycm'], unreadable: [] },
    ],
  });
  assert.deepEqual([...blocked.keys()], ['盖文天猫', '科塔淘宝'],
    'UNKNOWN 是「没有结论」，不许被当成通过 —— 那正是 2026-09-19 空窗口被判成 ALREADY_LOGGED_IN 那次的形态');
  assert.equal(blocked.get('盖文天猫'), '未通过（读不到=阿里妈妈）');
  assert.equal(blocked.get('科塔淘宝'), '未通过（掉登录=生意参谋）');
});

test('回执行缺失（子进程没起来）时返回空表 —— 调用方必须另判 fail-closed', () => {
  // 这一条是在钉**边界**：空表在「预检退出码 0」时是正常的，在「退出码非 0」时意味着无法归因。
  // 两者的区分在接线点那一侧（`!Array.isArray(login.report?.rows)`），不在这个函数里 ——
  // 所以这里只声明它会返回空表，别让它被误用成「空表＝全部通过」。
  assert.equal(blockedShopsFrom(null).size, 0);
  assert.equal(blockedShopsFrom({}).size, 0);
  assert.equal(blockedShopsFrom({ rows: [] }).size, 0);
});

test('描述里点名的是**后台**（生意参谋/阿里妈妈），名字取自 SITES 而不是另抄一份', () => {
  assert.equal(describeLoginRow({ verdict: 'UNKNOWN', needsLogin: [], unreadable: ['sycm', 'alimama'] }),
    '读不到=生意参谋、阿里妈妈');
  assert.equal(describeLoginRow({ verdict: 'NEEDS_LOGIN', needsLogin: ['alimama'], unreadable: [] }),
    '掉登录=阿里妈妈');
  // 两边都有时两句话都要出现 —— 只说一边会让收信人漏掉另一个后台。
  assert.equal(describeLoginRow({ verdict: 'NEEDS_LOGIN', needsLogin: ['sycm'], unreadable: ['alimama'] }),
    '掉登录=生意参谋；读不到=阿里妈妈');
  // 没有站点明细时不许报成空串（那会打印出「盖文天猫/登录 未通过（）」）。
  assert.equal(describeLoginRow({ verdict: 'UNKNOWN', needsLogin: [], unreadable: [] }), 'verdict=UNKNOWN');
});

// ---------------------------------------------------------------------------
// 二、纯函数：判「要不要先补页再复查」
// ---------------------------------------------------------------------------

test('读不到 + 没有人被踢回登录页 ⇒ 补页（这正是 2026-10-05 当晚的形状）', () => {
  assert.equal(shouldRepairPages({
    rows: [
      { shop: '盖文天猫', needsLogin: [], unreadable: ['alimama'] },
      { shop: '网林淘宝', needsLogin: [], unreadable: [] },
    ],
  }), true);
});

test('有店被实锤踢回登录页 ⇒ **不补页**（补页没用，也不许拿它掩盖掉登录）', () => {
  assert.equal(shouldRepairPages({
    rows: [{ shop: '科塔淘宝', needsLogin: ['sycm'], unreadable: ['alimama'] }],
  }), false, '混合情形（一个掉登录 + 一个读不到）不许触发补页 —— 那道闸的条件就是「没有 false」');
});

test('全部通过、或没有逐店结论时不补页', () => {
  assert.equal(shouldRepairPages({ rows: [{ shop: 'x', needsLogin: [], unreadable: [] }] }), false);
  assert.equal(shouldRepairPages({ rows: [] }), false);
  assert.equal(shouldRepairPages(null), false);
});

// ---------------------------------------------------------------------------
// 三、接线点：源码里必须真的接上
// ---------------------------------------------------------------------------

test('① 旧的那句「预检不过就 throw」必须消失（它就是整批停手的唯一原因）', () => {
  const source = readSource(ENTRY);
  assert.ok(!source.includes('登录预检未通过（${login.code}），已停止采集并保留告警收据'),
    '旧的 throw 还在 ⇒ 一个店读不到仍然会冻住整批 5 家（2026-10-05 实测形态）');
  // 唯一允许的 throw：拿不到逐店结论（无法归因）。
  const throws = [...source.matchAll(/throw new Error\(`登录预检未通过/gu)];
  assert.equal(throws.length, 1, '登录预检这一段应当只剩一处 throw（`rows` 读不出来那一处）');
  assert.ok(source.includes('!Array.isArray(login.report?.rows)'),
    'fail-closed 的判据不见了 —— 少了它，子进程没起来时会被读成「全部通过」');
});

test('② 被剔除的店在采集之前就退出（不许进那个共享下载目录）', () => {
  const source = readSource(ENTRY);
  const skipAt = source.indexOf("if (blocked.has(shop)) { item.stoppedAt = 'login'; continue; }");
  const collectAt = source.indexOf('PRODUCT_JOB_FILES.productCollect');
  assert.ok(skipAt > 0, '采集循环里少了剔除判定 ⇒ 注定失败的那一家照样去点导出，把共享目录搅乱');
  assert.ok(collectAt > skipAt, '剔除判定排在了采集**之后** ⇒ 形同虚设');
});

test('③ 剔除必须记进 gaps（否则少采几家而整轮报绿）', () => {
  const source = readSource(ENTRY);
  assert.ok(source.includes('gaps.push(`${shop}/登录 ${reason}`)'),
    '剔除没有记缺口 ⇒ 本批少采几家、退出码仍是 0 —— 这比不改更坏');
  // 导入段要跳过被剔除的店，否则会再记一条「底单 未采集」，同一件事记两条。
  assert.ok(source.includes('if (blocked.has(item.shop)) continue;'),
    '导入段没有跳过被剔除的店 ⇒ 缺口数虚高');
});

test('④ failedStage 归因要落 `login`，且排在 product-import 之前', () => {
  const source = readSource(ENTRY);
  const loginAt = source.indexOf("gaps.some((gap) => gap.includes('登录')) ? 'login'");
  const productAt = source.indexOf("gaps.some((gap) => gap.includes('底单')) ? 'product-import'");
  assert.ok(loginAt > 0, '归因表里没有「登录」这一档 ⇒ 被预检剔除的店会被报成 `product-import`（把人指到错的地方）');
  assert.ok(productAt > loginAt, '登录归因必须排在底单之前 —— 它最先发生');
});

test('⑤ 补页复用既有的唯一实现，不在这里另写一份', () => {
  const source = readSource(ENTRY);
  assert.match(source, /import \{ normalizePages \} from '\.\.\/runtime\/page-normalize\.mjs'/u,
    '补页没有复用 page-normalize.mjs ⇒ 出现第二份补页实现（新建页面的写路径全仓只许一处）');
  assert.ok(source.includes('expectedPagesForShop('),
    '期望页面清单没有从 expected-pages.mjs 取 ⇒ 期望页会与体检/落位那两处漂移');
  assert.ok(!source.includes('/new?url='),
    '这里自己拼了新建页面的请求 ⇒ 绕过了 shop-pages.mjs 的 pinned=1 等三条纪律');
});

test('⑥ 推广段「有意跳过不记缺口」在**两处**同口径（正常路径 + 异常路径）', () => {
  const source = readSource(ENTRY);
  assert.ok(source.includes('if (!options.skipPromotion && !item.promotionFile) gaps.push('),
    '正常路径那一处漏了 `!options.skipPromotion` ⇒ 带 --skip-promotion 的定时入口每轮都被自己的缺口判失败');
  assert.ok(source.includes('if (!options.skipPromotion && !item.promotionFile) addGap('),
    '异常路径那一处的闸门不见了（它是原有的，别在改动里丢掉）');
});
