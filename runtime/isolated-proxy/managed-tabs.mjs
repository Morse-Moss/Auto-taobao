// 受管标签页的「该不该回收」判定 —— 从 cdp-proxy.mjs 里抽出来的纯函数。
//
// 为什么要单独一个模块（2026-09-19）：这段判定原来内联在代理主程序里，而代理主程序
// **import 就会起服务器**（末尾是 main().catch(...)），所以它里面任何一行判定都没法被
// 单元测试碰到。于是「钉住的标签页不参与回收」这条规则只能靠现场看一眼来证明 ——
// 而那正是这个仓库反复吃过亏的地方（判据不可测 ⇒ 回归时静默失效）。
//
// 抽出来之后，「哪些页该关」变成两个可枚举的纯函数，代理只负责把结果交给
// Target.closeTarget。行为一字未改，改的只是「能不能被断言」。

// 「钉住」的唯一判据 —— 全仓只有这一处解释 `pinned` 字段。
//
// 这里刻意接受三种写法（`true` / `1` / `'1'`）：写侧有两条路 —— `/new?pinned=1` 从查询串
// 来（`q.pinned === '1'` ⇒ boolean）、`/pin` 直接置 `true`。只认严格 `true` 的话，
// 将来任何一处写回字符串，症状会是「标签页照旧被回收，而代码看上去两处都对」。
// 反过来，falsy（`false`/`0`/`'0'`/缺字段）一律不算钉住 —— 那是默认状态，别让它意外留下。
export function isPinned(entry) {
  const value = entry?.pinned;
  return value === true || value === 1 || value === '1';
}

// 闲置回收：返回这次该关掉的 targetId 列表。
//
// 两条豁免：① 钉住的（店名标签页这类，客户靠它认窗口）；② 还没到闲置时长的。
// 另外一条口径上的选择：**读不到访问时间的不关**。
// 这与登录态那条「读不到 ≠ 已登录」同源 —— 没证据不是证据；而这里的「猜错」方向
// 是把客户要看的窗口关掉，属于不可逆的一侧，所以默认不动手。
export function selectIdleTabs(managedTabs, { now, idleTimeoutMs } = {}) {
  const ids = [];
  for (const [targetId, info] of managedTabs) {
    if (isPinned(info)) continue;
    const lastAccessed = info?.lastAccessed;
    if (typeof lastAccessed !== 'number' || !Number.isFinite(lastAccessed)) continue;
    if (now - lastAccessed < idleTimeoutMs) continue;
    ids.push(targetId);
  }
  return ids;
}

// 代理退出时的回收：除了钉住的，其余全关。
// 代理重启是 SOP 的一部分（起跑前重起），若这里不豁免，标签页就会跟着每次重启消失 ——
// 等于没挂。
export function selectShutdownTabs(managedTabs) {
  const ids = [];
  for (const [targetId, info] of managedTabs) {
    if (!isPinned(info)) ids.push(targetId);
  }
  return ids;
}

export function countPinned(managedTabs) {
  let pinned = 0;
  for (const [, info] of managedTabs) if (isPinned(info)) pinned += 1;
  return pinned;
}
