// 淘宝类目 ID → 中文路径 的映射表。
//
// 这份表不是抄来的，是反推出来的：拿 2026-10-26 自采的 88 个商品，
// 与 2026-10-19 小旺神导出的 1441 行按商品链接 JOIN，
// 每条商品的 categoryp（ID 路径）与类目（中文路径）一一对上，三个 ID 全部唯一、零冲突：
//
//   27 50020016 50002411    → 家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸   （80 个商品）
//   27 50020016 50020125    → 家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 按摩浴缸   （ 7 个商品）
//   27 201913404 201913904  → 家装主材 >> 适老卫浴 >> 步入式浴缸            （ 1 个商品）
//
// 这三个正好覆盖 10-19 导出里出现过的全部三类，所以迁移期间类目列可以完全对齐。
//
// 维护约定：
//   遇到表里没有的 ID 时，归一化会保留原始 ID 字符串，不编中文名。
//   发现新 ID 后先确认它对应哪个类目（用同一商品的旧导出对照，或去淘宝类目页确认），
//   确认了再加进来。宁可表里少一条，也不要猜一条——猜出来的类目名会污染下游分类统计，
//   而且没人会回头核对。
//
// 为什么叶子 ID 也单独列一份：categoryp 是完整路径，但有些接口只给 leafCategory。
// 两个 key 指向同一个名字，查哪个都行。

export const CATEGORY_PATHS = Object.freeze({
  '27 50020016 50002411': '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸',
  '27 50020016 50020125': '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 按摩浴缸',
  '27 201913404 201913904': '家装主材 >> 适老卫浴 >> 步入式浴缸',
});

// 叶子 ID → 中文路径。与上面一一对应，仅供只有 leafCategory 的场景使用。
export const CATEGORY_LEAF = Object.freeze({
  '50002411': '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸',
  '50020125': '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 按摩浴缸',
  '201913904': '家装主材 >> 适老卫浴 >> 步入式浴缸',
});

// 合并成一张表供 categoryOf 使用：完整路径优先，叶子只在路径没命中时兜底。
export const CATEGORY_MAP = Object.freeze({ ...CATEGORY_LEAF, ...CATEGORY_PATHS });

// 覆盖率统计：报告里要能说清「多少行转成了中文、多少行还是 ID」。
// 这是对外数字纪律的一部分——类目覆盖率不明时说「按类目统计」就是含糊其辞。
export function categoryCoverage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let named = 0;
  let raw = 0;
  let blank = 0;
  const unknownIds = new Map();
  for (const row of list) {
    const value = String(row?.类目 ?? '').trim();
    if (!value) { blank += 1; continue; }
    if (/^[\d\s]+$/u.test(value)) {
      raw += 1;
      unknownIds.set(value, (unknownIds.get(value) ?? 0) + 1);
      continue;
    }
    named += 1;
  }
  return {
    total: list.length,
    named,
    raw,
    blank,
    namedPct: list.length ? Math.round((named / list.length) * 1000) / 10 : 0,
    unknownIds: [...unknownIds.entries()].map(([id, count]) => ({ id, count })),
  };
}
