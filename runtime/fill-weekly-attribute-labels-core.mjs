// 竞品周表规则列写回的**纯判据层**（2026-09-21 抽出）。
//
// 为什么要抽出来：这两条规则此前埋在 runtime/fill-weekly-attribute-labels.mjs 里，
// 而那是个顶层 await 的 CLI（连上去就拉 1417 + 830 条记录），测试够不到它 ——
// 于是「只填空不覆盖」这条最关键的约束既没人守，也没法验。
//
// 本次要治的事实（2026-09-21 实测，见 evidence/competitor-state-2026-09-21/）：
//  · 尺寸链的口径是「**只有 A/B 才该有尺寸**」：competitor-v2-core.mjs 只给
//    A-爆款竞品 / B-高价值竞品 记『待补 SKU尺寸』。所以周表里大量『无注明』
//    本身不是 bug，只有 A/B 行上是「无注明」才是缺的。
//  · 09-16 那次写回跑在 SKU 采集**之前** 4 分 40 秒（写回 02:59:19Z / 采集 03:03:59Z），
//    那时 SKU 数据还没进来，于是回落标题规则，把 A/B 行的尺寸写成了『无注明』。
//  · 「只填空不覆盖」把那个错误永久锁死：09-21 重跑 1417 行、**写入 0 行** —— 静默全绿。
//  · 联结键用「商品标题」时跨周必然落空（实测与 SKU明细 的交集只有 3/1417，
//    因为每周采到的商品本就不同）；改用「商品链接里的商品 id」后周表侧 1417/1417 可命中。
//
// 所以这里定死三件事：主键怎么取、A/B 怎么判、某一格到底写还是跳过。

// 商品链接 → 商品 id。淘系链接形如
//   https://item.taobao.com/item.htm?spm=a21n57...&id=921092099640
// 也接受 id 在首位（?id=...）或经过跳转包裹后的形态。
export function extractProductId(link) {
  const match = /[?&]id=(\d+)/u.exec(String(link ?? ''));
  return match ? match[1] : '';
}

// 竞品分类在周表上是 Formula(type 20)，读回来是 {type,value:[...]} 对象，
// 调用方必须先经 text() 归一成字符串再进来。
export function isAbClass(value) {
  return /^[AB]-/u.test(String(value ?? '').trim());
}

// 允许被「重算」的列 —— 只有这两列。其余 8 列（5 属性 + 数据状态 + 待补数据项 +
// 搜索关键词）永远只填空不覆盖，否则可重复执行这条性质就没了。
export const RECOMPUTABLE_COLUMNS = Object.freeze(['尺寸', '适用空间']);

// 单格处置。返回值：
//   'fill'           当前为空 → 写入算出来的值
//   'recompute'      当前有值，但这是 A/B 行的 尺寸/适用空间，且 SKU 侧拿到了更好的值 → 覆盖
//   'skip-empty'     算出来是空 → 不写（绝不往表里写空值）
//   'skip-existing'  当前有值且不满足重算条件 → 保持原值（默认行为，也是幂等性的来源）
//   'skip-degraded'  当前有值，但新值本身含『无注明』/『不适用』 → 不写（别把有值擦成无值）
//   'skip-same'      新值与原值逐字相同 → 不写（省一次无意义更新）
// joined 表示这一行的 SKU 数据是不是真通过键接上的 —— 没接上就没有「更好的值」可言。
export function decideWrite({ name, existing, next, isAb, recomputeAb, joined }) {
  if (!next) return 'skip-empty';
  if (!existing) return 'fill';
  const recomputable = Boolean(recomputeAb) && Boolean(isAb) && Boolean(joined)
    && RECOMPUTABLE_COLUMNS.includes(name);
  if (!recomputable) return 'skip-existing';
  if (next.includes('无注明') || next.includes('不适用')) return 'skip-degraded';
  if (next === existing) return 'skip-same';
  return 'recompute';
}
