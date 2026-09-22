// 「这个页签属于哪个目标页面」—— 全仓唯一实现（2026-09-22 建）。
//
// 为什么必须抽成一处：此前这段判断散在三个地方各写了一遍
//   · `skills/sycm-alimama-daily-report/scripts/date-picker.mjs`（resolveTarget 的 matchOf / siblings）
//   · `runtime/shop-pages.mjs`（命中计数 / 漂移页 foreign）
//   · `runtime/xws-platform-health-preflight.mjs`（classifyExpectedPages 的数页面）
// 三处的口径都是「**整串 URL 里 includes 片段**」。而生意参谋的**登录跳转页**恰好长这样：
//
//   https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
//
// 目标地址躺在查询参数 `_target` 里 ⇒ 整串确实「包含」那个片段 ⇒ **被误认成工作页**。
// 后果不是小噪音：体检报「生意参谋工作页不唯一（按片段找到 2 个）」、`resolveTarget` 抛
// `expected one sycm page, got 2` ⇒ **整轮日报一步都不跑**。
// 2026-09-17 与 2026-09-22 各发生一次，两次都是同一个码：
//   evidence/rerun-2026-09-17/health/00-health-check-daily.txt
//   evidence/multi-shop-2026-09-21-rerun6/00-health-check-daily.txt
//
// 判据改成看 URL 的**结构**：
//   · 片段里没有 '/'（如 `one.alimama.com`）⇒ 只比主机；
//   · 片段里有 '/'（如 `sycm.taobao.com/qos/service/frame/shop/performance`）⇒
//     主机相同 **且 pathname 包含片段的路径部分**；
//   · 主机比较允许**子域**（片段写 `feishu.cn/base/…`，实际页在 `kcne618basvj.feishu.cn`，
//     旧口径靠 includes 蒙对，新口径要显式允许）。
// 查询串（`?…`）与 hash（`#…`）一律不参与匹配 —— 这正是上面的登录跳转页不再假命中的原因。
//
// 边界（写清楚，免得以后有人拿它当通用 URL 匹配器）：片段里 `?` / `#` 之后的内容会被丢掉，
// 所以「同一个 base 的不同 table」这种**靠查询串区分**的期望页面，本函数分辨不了。
// 目前没有这种用法（`expected-pages.mjs` 的飞书片段只到 baseToken）。真要区分，得改这里。

/**
 * URL 的「主机」——协议 + 主机名（含端口），统一小写。认不出来返回 null。
 *
 * 为什么是「主机相等」而不是「片段包含」（2026-09-20 现场）：漂移页的特点恰恰是**片段不再匹配**
 * （工作页被第 5 步留在报表预览 URL 上，`sycm.taobao.com/qos/.../performance` 这个片段就认不出它了），
 * 唯一还认得出来的，是它还在同一个站点上。
 * 认不出主机的值一律返回 null —— 但**要说准是哪一类**（2026-09-22 对着实测改正）：
 *   · 没有 `://` 的（`about:blank`）⇒ 返回 null；
 *   · `devtools://devtools/bundled/inspector.html` 这种**有协议+主机**的 ⇒ 返回 `devtools://devtools`
 *     （正则认为它格式合法，不拦）。
 * 无论哪种，它们都**永远当不上候选**：期望站点的 host 都是 `https://sycm.taobao.com` 这类，
 * 与它们不相等。所以这条纪律仍然成立 —— 它们不是「漂走的那一页」，把它们导航走是破坏而不是修复。
 * （写清这个区别，是因为下面 `parseUrl` 的注释里引用了它，而含混的注释会让人以为「非 http 一律 null」。）
 *
 * 本函数原住在 `runtime/shop-pages.mjs`（那里为它写了完整的理由与用例），2026-09-22 收编到这里，
 * 让「URL 结构」这件事只有一处实现；shop-pages 从本模块 re-export，对外接口与测试都不变。
 */
export function hostOfUrl(value) {
  const match = String(value ?? '').match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/iu);
  return match ? `${match[1].toLowerCase()}${match[2].toLowerCase()}` : null;
}

/**
 * 拆出参与匹配的两要素（主机名、路径）。返回 null 只发生在 `new URL()` 真的抛错时。
 *
 * 注意 `about:blank` **不会**返回 null：它在 Node 里是合法 URL，只是 `hostname` 为空、
 * `pathname` 为 `'blank'`。空 hostname 会在 `hostMatches` 那一步被挡掉（片段主机非空）
 * ⇒「about:blank 不命中任何期望页面」仍然成立，但原因是**主机不匹配**，不是「解析失败」。
 * 2026-09-22 写用例时发现原注释把这两件事混成了一件，这里改准。
 */
export function parseUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return {
      hostname: url.hostname.toLowerCase(),
      pathname: url.pathname,
    };
  } catch {
    return null;
  }
}

/** 主机相同（含子域）：`kcne618basvj.feishu.cn` 命中片段主机 `feishu.cn`。 */
export function hostMatches(pageHostname, fragmentHost) {
  const host = String(pageHostname ?? '').toLowerCase();
  const want = String(fragmentHost ?? '').toLowerCase();
  if (!host || !want) return false;
  return host === want || host.endsWith(`.${want}`);
}

/**
 * 这个页签 URL 属于片段描述的那个期望页面吗？（全仓唯一判据）
 *
 * 返回 false 的两类里，只有一类是「页面不在」—— 另一类是「它是登录页/跳转页，本来就不是工作页」。
 * 这正是旧口径出错的地方：旧口径把后者也算成前者。
 */
export function urlMatchesFragment(url, fragment) {
  // 片段里 `?` / `#` 之后不参与匹配（见文件头「边界」）。
  const raw = String(fragment ?? '').split('#')[0].split('?')[0];
  if (!raw) return false;
  const page = parseUrl(url);
  if (!page) return false;

  const slash = raw.indexOf('/');
  const fragmentHost = slash === -1 ? raw : raw.slice(0, slash);
  const fragmentPath = slash === -1 ? '' : raw.slice(slash);

  if (!hostMatches(page.hostname, fragmentHost)) return false;
  if (!fragmentPath) return true;
  return page.pathname.includes(fragmentPath);
}

/** 从一堆页签里挑出属于该片段的（`type === 'page'` 与旧口径一致）。 */
export function pagesMatching(targets, fragment) {
  const list = Array.isArray(targets) ? targets : [];
  return list.filter((target) => target?.type === 'page' && urlMatchesFragment(target.url, fragment));
}
