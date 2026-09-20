// 飞书 API 读回值的归一：把「记录字段值」变成可读文本。
//
// 为什么单独成模块：这不是一个随手小工具，是**证据正确性**的一部分。
// 公式字段（type=20）从 API 读回来**不是字符串**，而是 `{type:'text',value:[{text:'…'}]}` 这样的对象；
// 多选字段读回来是对象数组；单选的读回来是字符串；数字列读回来也是字符串。
// 直接 `String(x)` 会得到 `"[object Object]"` —— 2026-09-20 第一次真跑规则段时，
// 收据里的 `priorityDistribution` 就整条变成了 `{"[object Object]": 300}`：
// **看着像有数据，实际什么都没说，比缺这个字段更坏。**
//
// 两份写入器（规则段、内容热度）都要用它，所以住在这里。
// 各写一份实现是 drift 的来源：一处改了 trim、另一处没改，两份收据就开始不一样。

/**
 * 把飞书读回的字段值归一成不带首尾空白的一段文本。
 *
 * 支持的形态（都是实测见过的）：
 *   - `null` / `undefined` → `''`
 *   - 数组（多选、富文本段）→ 逐项递归后拼接
 *   - `{ value: […] }` / `{ value: '标量' }`（公式字段）→ 递归
 *   - `{ text }` / `{ name }`（文本段、选项对象）→ 取其一
 *   - 其它标量 → `String(x).trim()`
 *
 * 两条性质由测试钉住，改实现时不能破坏：
 *   1. 结果里**永不**出现 `[object Object]`；
 *   2. **幂等** —— 把结果回喂必须原样返回。不幂等意味着「带空格的键」和「不带空格的键」
 *      会被统计成两条，把分布悄悄撕开（这正是本函数存在的理由）。
 */
export function readbackText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readbackText).join('');
  if (typeof value === 'object') {
    // `{value: […]}` 与 `{value: '标量'}` 都出现过，统一交回递归处理，
    // 免得标量形态掉进 text/name 分支被读成空字符串而静默丢数据。
    if (value.value !== undefined) return readbackText(value.value);
    return String(value.text ?? value.name ?? '').trim();
  }
  return String(value).trim();
}
