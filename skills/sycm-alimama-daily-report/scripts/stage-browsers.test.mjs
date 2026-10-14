/**
 * `stage-browsers.mjs` 的离线用例（2026-10-14 建，配合「修复层作用域对齐」那一批）。
 *
 * 这个叶子回答的问题只有一个：**某个阶段跑在哪一台浏览器上**。
 * 它之所以值得单独钉，是因为答案原先散在四处的实现里（链自己的 stage 表两处、
 * 派单单子的 `execHint` 与 `instancePrecondition`、自动修复的 `execRepair`），
 * 漂开的后果是**修复动作指向另一台浏览器，而且每一处都不报错** ——
 * 2026-10-13 网林淘宝那次的 `readback` 失败就是这么修的：
 * 动作成功落在**店铺标识页**上，而出问题的那一页在**共用商家浏览器**里
 * （`evidence/batches-2026-10-13/b2/网林淘宝/97-repair-agent-report.md`）。
 *
 * 下面每条用例都刻意写成**字面量**而不是「从实现推导期望值」：
 * 从 `SHARED_PAGE_STAGES` 里读一遍再断言它等于自己，那种用例永远不会红
 * （这条纪律在同一个批次的 mutate 验证里已经被验过一次：删掉闭集里一个词，
 * 用「遍历闭集自身」写的用例**不会**变红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_PORTS, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import {
  SHARED_PAGE_STAGES, describeStageBrowser, proxyForStage, stageUsesSharedPage,
} from './stage-browsers.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const SHARED_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;

// 用例里用的店名都取自登记表（不写死一个可能不存在的名字）——
// 写死的话，哪天登记表改名，这些用例会变成在测「一个未登记的名字」而自己不知道。
const SHOP = '网林淘宝';
const SHOP_PROXY = `http://127.0.0.1:${shopInstance(SHOP).proxyPort}`;

test('SHARED_PAGE_STAGES：闭集逐字为 push / readback（顺序即登记顺序）', () => {
  // 逐字写出来，不遍历它自己 —— 遍历自身时「少一个词」会同时缩短循环，用例照样绿。
  assert.deepEqual([...SHARED_PAGE_STAGES], ['push', 'readback'],
    '共用商家浏览器上的阶段是且仅是这两个；改这张表要同时改链的 stage 表（run-multi-shop-day 有互锁）');
});

test('stageUsesSharedPage：两个共用阶段为真，其余（含认不出的）一律为假', () => {
  for (const stage of ['push', 'readback']) {
    assert.equal(stageUsesSharedPage(stage), true, `${stage} 的作业对象是共用的那一页飞书底单`);
  }
  // 「认不出来 ⇒ false」是**保守方向**：把它当成店铺实例，最坏是对着这家店做事；
  // 反过来（认不出来当共用）会让所有非共用阶段都去动共用窗口。
  for (const stage of [null, undefined, '', 'backfill', 'shop-report', 'sycm-date-again', 'push ', 'PUSH', 'readback2']) {
    assert.equal(stageUsesSharedPage(stage), false, `${JSON.stringify(stage)} 不该被算成共用阶段`);
  }
});

test('proxyForStage：共用阶段与店名无关，恒指共用商家浏览器', () => {
  // 这两条是 10-13 的直接修复：`readback` 失败时，框架必须指到 19023，
  // 哪怕调用方把店名也传了进来（原先「有店名 ⇒ 这家店的代理」把它带到了另一台机器上）。
  assert.equal(proxyForStage({ stage: 'readback', shopKey: SHOP }), SHARED_PROXY);
  assert.equal(proxyForStage({ stage: 'push', shopKey: '里可林淘宝' }), SHARED_PROXY);
  assert.equal(proxyForStage({ stage: 'readback' }), SHARED_PROXY, '不给店名也是共用那台');
});

test('proxyForStage：非共用阶段 + 登记表里的店名 ⇒ 这家店自己的代理', () => {
  assert.equal(proxyForStage({ stage: 'backfill', shopKey: SHOP }), SHOP_PROXY);
  assert.equal(proxyForStage({ stage: 'sycm-date', shopKey: '里可林淘宝' }),
    `http://127.0.0.1:${shopInstance('里可林淘宝').proxyPort}`);
  // 不给阶段但给了店名：仍然按这家店 —— 「没点名阶段」不等于「跑在共用窗口上」。
  assert.equal(proxyForStage({ shopKey: SHOP }), SHOP_PROXY);
});

test('proxyForStage：裸调用与未登记的店名 ⇒ 回落共用（旧口径逐字保留）', () => {
  // 这一条守的是「兼容」：`--shop` 出现之前的裸调用默认就是共用商家浏览器，
  // 改掉它会让所有没点名的调用从「回落共用」变成「报错」，而那不是这次要修的东西。
  assert.equal(proxyForStage({}), SHARED_PROXY);
  assert.equal(proxyForStage(), SHARED_PROXY);
  assert.equal(proxyForStage({ stage: 'backfill', shopKey: '没有这家店' }), SHARED_PROXY);
});

test('proxyForStage：返回完整 URL，且端口只来自登记表（不自己拼第二个数字）', () => {
  // 与 argv / `--proxy` 里的写法逐字一致 —— 各处自己拼字符串正是本叶子要消掉的那份实现。
  assert.match(proxyForStage({ stage: 'readback' }), /^http:\/\/127\.0\.0\.1:\d+$/u);
  // 反向：每一个登记表里的店铺都能拿到**它自己**的代理（巡一遍，防止有店被漏掉/串到共用上）。
  for (const key of shopBrowserKeys()) {
    const expected = `http://127.0.0.1:${shopInstance(key).proxyPort}`;
    assert.equal(proxyForStage({ stage: 'backfill', shopKey: key }), expected, `${key} 的代理取错了`);
    assert.equal(proxyForStage({ stage: 'push', shopKey: key }), SHARED_PROXY, `${key} 的共用阶段该走 19023`);
  }
});

test('describeStageBrowser：要能回答「那台是谁的」，不能只给一个端口号', () => {
  const shared = describeStageBrowser({ stage: 'readback', shopKey: SHOP });
  assert.match(shared, /共用商家浏览器/u, '共用阶段必须说清是「共用」那一台');
  assert.ok(shared.includes(SHARED_PROXY), '并且带上端口，读单子的人才知道去连哪一台');
  assert.ok(!shared.includes(SHOP), '共用阶段不该把店名说成这台的归属（那正是原来误导人的地方）');

  const own = describeStageBrowser({ stage: 'backfill', shopKey: SHOP });
  assert.ok(own.includes(SHOP), '非共用阶段必须点名是哪家店的浏览器');
  assert.ok(own.includes(SHOP_PROXY));
});

test('接线：共用端口来自 browser-ports，本文件里不许出现第二个 19023', () => {
  // 值级断言抓不住「把 19023 抄进代码」这一类 —— 抄的值今天恰好等于登记表，
  // 只有登记表哪天变了才会露出来（那时已经晚了）。所以这里查**源码层**：
  // 剥掉注释后，代码里必须引用登记表常量，且不许有 5 位端口字面量。
  //
  // 剥注释必须避开两件事：
  //  ① URL 里的 `http://` 也含 `//`。所以行注释的判据是「`//` 前面那个字符不是 `:`」
  //     —— 一刀切 `//.*` 会把 `http://…` 之后整行删掉，于是「必须引用 PROJECT_PORTS」
  //     这条断言永远红（这个坑当场踩过一次）。
  //  ② **换行符**（2026-10-14 被 CI 抓到的那个）：CI 的 Windows runner 以 **CRLF** 检出
  //     （`core.autocrlf=true`），而本机工作区是 LF。用 `split('\n')` + `/\/\/.*$/` 时，
  //     行尾那个 `\r` 会让 `$` 失配 ⇒ 注释压根没被剥掉，而注释里恰好写着端口号
  //     ⇒ 本机绿、CI 红。实测对照：LF 下 `MATCHES null`，CRLF 下 `MATCHES ['19023','19060','19060']`。
  //     所以这里照 **`runtime/browser-ports.test.mjs` 的 `stripComments()` 既有口径**写
  //     `split(/\r?\n/)`（AGENTS.md「Line-ending note」：每个源码级断言都必须对 EOL 免疫）。
  const raw = readFileSync(path.join(SCRIPTS_DIR, 'stage-browsers.mjs'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
  assert.match(code, /PROJECT_PORTS\.dailyReportProxy/u,
    '共用代理端口必须从 runtime/browser-ports.mjs 取（那里是唯一登记表）');
  assert.ok(!/19\d{3}/u.test(code),
    '代码里不该出现端口字面量：登记表换了端口，抄死的那个不会跟着变，而症状是「修复动作指向一台不存在的浏览器」');
});
