// 「在任务行的操作行里挑一个可点的『下载』入口」—— 纯函数（2026-10-21 抽出来）。
//
// 为什么抽出来：这段判据原来 inline 在 collect-product-report.mjs 的一个超长模板串里，
// 只能靠真实浏览器验 ⇒ 既没有离线用例，也做不了突变验证。而它正是本项目反复出问题的那一类：
// **把「读取方式太窄」误报成「页面上没有」**。
//
// 现场（2026-10-20 里可林天猫）：报错「商品报表任务下载入口不可见」，可同一份失败现场里
// 报表已渲染 35 行商品数据、URL 日期正确、遮挡层 0 —— 入口本来就在。旧判据压了三个窄条件：
//     叶子节点（children.length === 0） && 文字恰好 === '下载' && width > 0
// 阿里妈妈这类 antd/React 页面里，按钮文字常包在 span 里、可能带图标或全角空格；
// 层级一变「叶子节点」就不成立，React 重渲染还会把刚找到的节点换掉。
//
// 现在的判据（宽松在前、严格在后）：
//   1. 文字**包含**「下载」就算候选（不再要求恰好相等）；精确相等只用来**排序**，不当门槛。
//   2. 尺寸必须 > 0 且中心点落在视口内 —— 视口外一律不点：点出去会落到别的元素上，
//      症状会变成「点了没反应」，比直接报错更难查。
//   3. 输出**按优先级排好的一串候选**，由调用方逐个用浏览器 elementFromPoint 复核后才点。
//      不在这里判定命中：命中测试必须是浏览器的真实结果，不能靠几何推算。
//
// 失败时**不返回空**，而是带上「看到了什么」：让下一层报错说清是「压根没有下载字样」
// 还是「有但点不到 / 在视口外」，不必再靠人肉复现（旧版这些全是同一句符号）。

/** 候选的优先级：文字恰好是「下载」最高，常见变体次之，其余含「下载」的再次。 */
function rank(candidate) {
  const text = String(candidate?.text ?? '').trim();
  if (text === '下载') return 3;
  if (text === '下载报表' || text === '下载数据' || text === '下载文件' || text === '下载明细') return 2;
  return 1;
}

/**
 * @param candidates 形如 `[{ text, rect:{x,y,w,h} }]`（从页面上取回的原始候选）
 * @param viewport   `{ width, height }`
 * @returns {{ok:true, candidates:[{point:[number,number], text:string}], saw:string[]}
 *          |{ok:false, reason:'no-download-text'|'outside-viewport'|'zero-size', saw:string[]}}
 */
export function rankDownloadCandidates(candidates, { viewport } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const saw = list.slice(0, 5).map((c) => ({ text: String(c.text ?? '').trim().slice(0, 40) }));
  if (list.length === 0) return { ok: false, reason: 'no-download-text', saw };

  const { width = 0, height = 0 } = viewport ?? {};
  const sized = list.filter((c) => (c.rect?.w ?? 0) > 0 && (c.rect?.h ?? 0) > 0);
  if (sized.length === 0) return { ok: false, reason: 'zero-size', saw };

  const inView = sized
    .map((c) => {
      const point = [Math.round((c.rect.x ?? 0) + (c.rect.w ?? 0) / 2), Math.round((c.rect.y ?? 0) + (c.rect.h ?? 0) / 2)];
      return { candidate: c, point };
    })
    .filter(({ point }) => point[0] >= 0 && point[1] >= 0 && point[0] < width && point[1] < height);
  if (inView.length === 0) return { ok: false, reason: 'outside-viewport', saw };

  // 稳定排序：优先级高的在前，同优先级保持页面顺序（不依赖 sort 的实现细节）。
  const ordered = inView
    .map((item, index) => ({ ...item, rank: rank(item.candidate), index }))
    .sort((a, b) => (b.rank - a.rank) || (a.index - b.index))
    .map(({ candidate, point }) => ({ point, text: String(candidate.text ?? '').trim().slice(0, 40) }));

  return { ok: true, candidates: ordered, saw };
}

/** 把失败结果拼成一句能直接定位的人话。 */
export function describeDownloadFailure(result) {
  const saw = result?.saw?.length
    ? `；操作行里含「下载」的元素：${JSON.stringify(result.saw)}`
    : '；操作行里没有任何含「下载」的元素';
  switch (result?.reason) {
    case 'no-download-text': return `操作行里没有「下载」入口${saw}`;
    case 'outside-viewport': return `「下载」入口在视口之外（点它会落到别的元素上）${saw}`;
    default: return `「下载」入口尺寸为 0，无法点击${saw}`;
  }
}
