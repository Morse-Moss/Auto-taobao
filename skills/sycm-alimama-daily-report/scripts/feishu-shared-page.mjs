// 五家店**共用的一页**飞书页：它现在停在哪张表、该停在哪张表、以及「停错表」时怎么把话说清。
//
// 为什么独立成模块（2026-09-20 定论）：一轮多店铺里只有第 7 步 push 与第 11 步 readback 用这一页，
// 而「把页面送回源表」写在 readback-daily-report.mjs 的**成功路径末尾**。readback 一失败
// （实测：网林 readback 等询单表超时，归位那一步没执行），页面就停在询单表上，
// 紧接着**下一家店**的 push 进场只做断言、不做导航（改前 run-daily-report.mjs 里零 /navigate），
// 0.3 秒就被自己的断言拦下，报出来的却是「Feishu page is not on authorized table/view」——
// 与真正的原因（上一家的收尾没跑完）无关，而且受影响的不是出错的那一家。
//
// 结论：这一页是**共享可变状态**，而共享可变状态不能由「上一步有没有正常收尾」决定。
// 使用方进场时自己落位（导航只换 URL、不碰任何数据），断言退化成回读校验。
// 判据与措辞集中在这里，是为了让 push 与 readback 两侧对同一件事给同一个答案 ——
// 这与 runtime/browser-ports.mjs 只留一份端口登记是同一个道理的第三次应用。

// 页面 URL 与「授权的 table/view」的关系。**返回结构化结果、不在这里抛错**：
// 同一份判断要用在两个位置（决定要不要落位、以及落位之后复核），
// 而报错该带多少上下文由调用方决定（见下面的 assertOnTargetPage / describeTargetMismatch）。
export function inspectPageUrl(pageUrl, { appToken, tableId, viewId } = {}) {
  const text = String(pageUrl ?? '');
  // base 的匹配用**整串 includes**，与 run-daily-report / readback 从 /targets 挑页面时用的口径逐字一致。
  // 这两处必须给同一个答案，否则会出现「按 A 口径选中了这一页、按 B 口径又判它不合格」的状态。
  const onAppToken = text.includes(`/base/${appToken}`);
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    parsed = null;
  }
  const actualTable = parsed ? parsed.searchParams.get('table') : null;
  const actualView = parsed ? parsed.searchParams.get('view') : null;
  return {
    url: text,
    parseable: Boolean(parsed),
    onAppToken,
    actualTable,
    actualView,
    expectedTable: tableId ?? null,
    expectedView: viewId ?? null,
    onTarget: Boolean(parsed) && onAppToken
      && actualTable === tableId && actualView === viewId,
  };
}

// 落位目标：`https://<host>/base/<baseToken>?table=<表>&view=<视图>`。
// 形状与 readback-daily-report.mjs 的 tableUrl() **逐字相同** —— 那里已经在用，且导航之后确实能读到表。
// 刻意不复用当前 URL 上别的查询参数：这一页的入场口子只有这一个，多带一个参数就多一个变量。
export function buildTargetTableUrl(pageUrl, { appToken, tableId, viewId } = {}) {
  const origin = new URL(String(pageUrl)).origin;
  return `${origin}/base/${appToken}?table=${tableId}${viewId ? `&view=${viewId}` : ''}`;
}

// 停错表时的诊断文案。
//
// 硬要求（2026-09-19 实亏一轮才定下来）：必须同时写出**当前**与**期望**，并点出最可能的原因。
// 只说一句「表对不上」，下一个人看不出这一页其实是上一家留下的 —— 于是他会去查本家的采集，
// 而那一侧完全正常。
//
// knownTables：可选 `{ 表id: 可读名 }`。汇报与报错里不甩 id 是本项目的既定要求，
// 所以登记过的表一律「id（可读名）」一起给：既能被人看懂，也能被 grep。
export function describeTargetMismatch(pageUrl, { appToken, tableId, viewId, knownTables = {} } = {}) {
  const state = inspectPageUrl(pageUrl, { appToken, tableId, viewId });
  const label = (id) => {
    if (!id) return '（没有这个参数）';
    const name = knownTables[id];
    return name ? `${id}（${name}）` : `${id}（未登记的表）`;
  };
  const parts = [
    'Feishu page is not on authorized table/view',
    `｜当前 table=${label(state.actualTable)}&view=${state.actualView ?? '（没有这个参数）'}`,
    `｜期望 table=${label(tableId)}&view=${viewId ?? '（无）'}`,
  ];
  if (!state.parseable) {
    parts.push('｜这一页的 URL 解析不出来：先把 /targets 的输出整个打出来看它现在是什么');
  } else if (!state.onAppToken) {
    parts.push(`｜这一页已经不在目标 base（${appToken}）上：可能是被人切走了，也可能代理连到了别的浏览器实例`);
  } else if (state.actualTable !== tableId) {
    parts.push('｜五家店**共用这一页**，而它停在了别张表上：这通常是上一家店的阶段没收尾留下的'
      + '（readback 会依次导航到源表与询单表，它的归位写在成功路径末尾，一失败就不执行），'
      + '不是本家的采集出了问题');
    parts.push('｜本步进场时应当自己落位到源表（见 run-daily-report.mjs 的 ensureTargetPage）：'
      + '这条断言是在落位之后复核，它失败说明落位没生效 —— 先看代理是不是连错了浏览器');
  } else {
    parts.push('｜表是对的，只有 view 不同：这一页可能被人切过视图，或授权视图 id 已经变了');
  }
  return parts.join('');
}

// 上一条的抛错版本。`onTarget` 时原样返回 state，调用方可以接着用。
export function assertOnTargetPage(pageUrl, options = {}) {
  const state = inspectPageUrl(pageUrl, options);
  if (state.onTarget) return state;
  throw new Error(describeTargetMismatch(pageUrl, options));
}

// 「这一 base 上必须恰好一个页面」失败时的诊断。
//
// 改前这条只报一个数字（got 0 / got 2），而 got 0 的两种成因在数字上长得一模一样：
// 页面被切到了别的 base，或者代理连到了一台根本没有这一页的浏览器。
// 把 /targets 当前认到的页面列出来，一眼就能分开；只报数字则一定要去手工再跑一次探针。
export function describePageSearchFailure(pages, { appToken } = {}) {
  const all = Array.isArray(pages) ? pages : [];
  const pageEntries = all.filter((page) => page?.type === 'page');
  const matches = pageEntries.filter((page) => String(page?.url ?? '').includes(`/base/${appToken}`));
  const render = (page) => `${page.targetId ?? '(无 targetId)'} ${page.url ?? '(无 url)'}`;
  const lines = [
    `expected one Feishu page for target base, got ${matches.length}`,
    `｜目标 base ${appToken}：应当恰好一个页面开在它上面`,
    pageEntries.length
      ? `｜当前认到的页面 ${pageEntries.length} 个：${pageEntries.map(render).join(' ／ ')}`
      : '｜当前一个页面都没认到：多半是代理连到了别的浏览器实例，或那台浏览器还没起来',
  ];
  if (pageEntries.length && matches.length === 0) {
    lines.push('｜有页面、但没有一个在目标 base 上：这一页可能被切到了别的 base');
  }
  lines.push('｜先把 /targets 的完整输出打出来再动手，别猜');
  return lines.join('');
}
