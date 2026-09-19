import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isPinned,
  selectIdleTabs,
  selectShutdownTabs,
  countPinned,
} from './managed-tabs.mjs';

// 这个文件的由来（2026-09-19）：店名标签页（客户靠它认「这个窗口是哪家店」）是用 `/new`
// 建的 ⇒ 进 managedTabs ⇒ 闲置 15 分钟被代理回收、代理退出时再被清一轮。
// 现场表现是「页面自己消失了」，而**没有任何一处报错**。修法是给页加 `pinned`，
// 判定抽到 ./managed-tabs.mjs。这里既守判定本身，也守「判定只有一个解释点」。

const IDLE = 15 * 60 * 1000;

function tabs(entries) {
  return new Map(entries.map(([id, info]) => [id, info]));
}

test('闲置回收：没到时长的不关，到了的关', () => {
  const stale = tabs([['stale', { lastAccessed: 0 }]]);
  assert.deepEqual(
    selectIdleTabs(stale, { now: IDLE - 1, idleTimeoutMs: IDLE }),
    [],
    '差 1ms 都不该关：回收是单向动作，宁可晚一轮',
  );
  assert.deepEqual(
    selectIdleTabs(stale, { now: IDLE, idleTimeoutMs: IDLE }),
    ['stale'],
    '恰好到时长就算到期（边界取「等于也关」，与改之前的内联判定逐字一致）',
  );

  // 混合场景：只挑到期的那条，且顺序按 managedTabs 的插入序（调用方据此打日志）。
  const mixed = tabs([
    ['fresh', { lastAccessed: 1_000_000 }],
    ['stale-a', { lastAccessed: 0 }],
    ['stale-b', { lastAccessed: 0 }],
  ]);
  assert.deepEqual(
    selectIdleTabs(mixed, { now: 1_000_000 + IDLE - 1, idleTimeoutMs: IDLE }),
    ['stale-a', 'stale-b'],
    'fresh 还差 1ms，不该被连坐',
  );
});

test('钉住的页到期也不关 —— 三种写法都算钉住', () => {
  for (const encoding of [true, 1, '1']) {
    const map = tabs([['label', { lastAccessed: 0, pinned: encoding }]]);
    assert.deepEqual(
      selectIdleTabs(map, { now: 10 * IDLE, idleTimeoutMs: IDLE }),
      [],
      `pinned=${JSON.stringify(encoding)} 必须被当成钉住：只认严格 true 的话，`
      + '写侧任何一处写回字符串，症状就是「照旧被回收，而代码看上去两处都对」',
    );
  }
  // 反向：falsy 一律不算钉住，否则默认状态会意外把工作页永久留下。
  for (const encoding of [false, 0, '0', undefined, null]) {
    const map = tabs([['work', { lastAccessed: 0, pinned: encoding }]]);
    assert.deepEqual(
      selectIdleTabs(map, { now: 10 * IDLE, idleTimeoutMs: IDLE }),
      ['work'],
      `pinned=${JSON.stringify(encoding)} 是默认状态，不该被读成钉住`,
    );
  }
});

test('读不到访问时间的页不关 —— 没证据不是证据', () => {
  const map = tabs([
    ['no-field', {}],
    ['null-field', { lastAccessed: null }],
    ['nan', { lastAccessed: NaN }],
    ['string', { lastAccessed: '1700000000000' }],
  ]);
  assert.deepEqual(
    selectIdleTabs(map, { now: 10 * IDLE, idleTimeoutMs: IDLE }),
    [],
    '缺访问时间说明记账本身坏了；这时唯一不可逆的动作是「关掉」，所以不动手',
  );
});

test('代理退出：非钉住的全关，钉住的留下', () => {
  const map = tabs([
    ['label-a', { lastAccessed: 0, pinned: true }],
    ['label-b', { lastAccessed: 0, pinned: '1' }],
    ['work-a', { lastAccessed: 0 }],
    ['work-b', { lastAccessed: 0, pinned: false }],
  ]);
  assert.deepEqual(selectShutdownTabs(map), ['work-a', 'work-b'],
    '代理重启是 SOP 的一部分（起跑前重起）；这里不豁免，标签页每次都跟着消失，等于没挂');
  assert.equal(countPinned(map), 2, '/health 报的 pinnedTabs 要对得上');
});

test('isPinned 是唯一的解释点（写侧两种写法都在覆盖内）', () => {
  assert.equal(isPinned({ pinned: true }), true);
  assert.equal(isPinned({ pinned: '1' }), true);
  assert.equal(isPinned({ pinned: 1 }), true);
  assert.equal(isPinned({ pinned: false }), false);
  assert.equal(isPinned({}), false);
  assert.equal(isPinned(undefined), false, '缺 entry 不能抛错：回收扫描不该因为一条坏记录中断');
});

test('代理主程序不许自己解释 pinned —— 判定只能有一处', () => {
  const source = readFileSync(new URL('./cdp-proxy.mjs', import.meta.url), 'utf8');
  // 先剥注释：本仓库有先例 —— 自己写的说明性注释会让源码判据报假红。
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  assert.ok(code.includes("from './managed-tabs.mjs'"),
    '代理必须从 managed-tabs.mjs 取判定；抄回内联版本等于又变成没人测得到的那份');
  assert.ok(code.includes('selectIdleTabs(') && code.includes('selectShutdownTabs('),
    '两条回收路径都必须走纯函数');
  assert.equal(code.includes('info.pinned'), false,
    '内联解释 pinned 是这次要修掉的形态：它在 import 就起服务器的模块里，没有测试碰得到');
});
