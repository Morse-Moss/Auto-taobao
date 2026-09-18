// 窗口标签页：让「这台浏览器是哪家店的」在**机器前**一眼可读。
//
// 为什么需要它（2026-09-18 用户原话）：
//   「飞书给我发了提醒，但是我不知道是哪一个店铺的浏览器需要登录，
//     还有我看到每个浏览器里面有多个界面，也没有登录」
//
// 告警能说出店名（`login-merchant-core.mjs` 的 `shopName`），但告警**没法替收信人点开某个窗口** ——
// 飞书里点不了本机的浏览器。所以「哪家店」这件事必须在机器那一侧也有落点：
// **窗口标题里写着店名**，收信人照着标题就能对上（任务栏、窗口列表里显示的就是这一行）。
//
// 四台窗口标题如果都是默认的页面名，它们长得一模一样，告警说了店名也等于没说。
// 这就是本模块唯一真正起作用的那一件事：把店名写进标题，并且在窗口里用大字再写一遍。
//
// 三条设计约束：
//   1) **纯函数与 IO 分开**（与本仓库其它地方同一条分界）：「标题该长什么样」「哪些页签是残留」
//      是判据，必须能离线测；真正去动浏览器的只有 `ensureLabelTabOn` 一个函数。
//   2) **只用各店自己的代理**（`/targets` `/navigate` `/new`），不直连调试端口 ——
//      裸 CDP 端口在 2026-09-18 实测「页面上什么都有，脚本一个也连不上」。
//   3) **默认不动任何东西**：CLI 不带 `--commit` 时只打印「哪台缺标签页 / 现在有哪些页签」。
import { SHOP_BROWSERS, shopBrowserKeys } from './browser-ports.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 标签页本身。放在仓库里（原先那份在 `D:/Retire/edge-profiles/` 下，是仓库外的临时件：
// 换一台机器就没有，也没人知道它是从哪来的 —— 一份行为定义不该只活在某台机器上）。
export const LABEL_PAGE_PATH = fileURLToPath(new URL('./shop-window-label.html', import.meta.url));
export const LABEL_PAGE_NAME = 'shop-window-label.html';

// 窗口标题的后缀。改这里就等于改「告警里那句指路」的前提，所以测试会把它和告警文案绑在一起看。
export const WINDOW_TITLE_SUFFIX = ' · 日报采集窗口';

export function windowTitleFor(shop) {
  const name = String(shop ?? '').trim();
  if (!name) throw new Error('windowTitleFor 需要一个店名 —— 没有店名的标题等于没标');
  return `${name}${WINDOW_TITLE_SUFFIX}`;
}

// 标签页的 URL。`state` 是可选的：量到登录状态就带过来，量不到就**整个参数不带**，
// 页面上那一行也就不显示 —— 不写「未知」去占位，那会让人以为量过了。
export function labelPageUrlFor({ shop, port = null, state = null, ok = null, pagePath = LABEL_PAGE_PATH } = {}) {
  const name = String(shop ?? '').trim();
  if (!name) throw new Error('labelPageUrlFor 需要一个店名');
  const query = new URLSearchParams({ shop: name });
  if (port !== null && port !== undefined && port !== '') query.set('port', String(port));
  const text = String(state ?? '').trim();
  if (text) {
    query.set('state', text);
    if (ok === true) query.set('ok', '1');
  }
  // file:// + 绝对路径。Windows 盘符必须转成 /D:/… 形式，否则 URL 会被解析成 host。
  const path = String(pagePath).replace(/\\/gu, '/');
  return `file:///${path.replace(/^\/+/u, '')}?${query.toString()}`;
}

// 这个窗口里出现的页签是什么性质。分类是为了回答用户那句「我看到每个浏览器里面有多个界面」——
// 让人知道哪些是链路要用的、哪些只是过程产物，而不是自己去猜。
export const TAB_KINDS = Object.freeze({
  work: Object.freeze({ label: '工作页（链路要用）', needed: true }),
  label: Object.freeze({ label: '窗口标签页（写着这是哪家店）', needed: true }),
  qianniu: Object.freeze({ label: '千牛工作台（预留槽位，日报链不读）', needed: false }),
  loginPage: Object.freeze({ label: '淘宝登录页（登录过程留下的）', needed: false }),
  blank: Object.freeze({ label: '空白页（残留）', needed: false }),
  other: Object.freeze({ label: '其它页面（残留）', needed: false }),
});

export function tabKindOf(url) {
  const value = String(url ?? '');
  if (value.includes(LABEL_PAGE_NAME) || value.includes('_window-label')) return 'label';
  if (value.includes('sycm.taobao.com') || value.includes('one.alimama.com')) return 'work';
  if (value.includes('login.taobao.com') || value.includes('havanalogin.taobao.com')) return 'loginPage';
  if (value.includes('myseller.taobao.com') || value.includes('qianniu.taobao.com')) return 'qianniu';
  if (/^about:(blank|newtab)/u.test(value)) return 'blank';
  return 'other';
}

// 把一个窗口的页签清单分成「链路要用的」与「残留」。
// 只报告、不决定要不要关：千牛是 SOP 里的预留槽位，登录页是登录过程留下的，
// 一律当垃圾关掉会误伤 —— 判据说清性质，处置留给 `--prune`（默认不开）。
export function classifyShopTabs(targets = []) {
  const pages = targets.filter((t) => (t?.type ?? 'page') === 'page');
  return pages.map((t) => {
    const url = String(t?.url ?? '');
    const kind = tabKindOf(url);
    return {
      targetId: t?.targetId ?? t?.id ?? null,
      url,
      kind,
      label: TAB_KINDS[kind].label,
      needed: TAB_KINDS[kind].needed,
    };
  });
}

export function leftoverTabs(classified = []) {
  return classified.filter((t) => t.needed !== true);
}

export function isLabelTab(url) {
  const value = String(url ?? '');
  return value.includes(LABEL_PAGE_NAME) || value.includes('_window-label');
}

// ---------------------------------------------------------------------------
// IO：以下都打各店自己的代理（不直连调试端口）
// ---------------------------------------------------------------------------

async function readTargets(proxyUrl, fetchImpl) {
  const response = await fetchImpl(`${proxyUrl}/targets`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GET /targets → HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : (payload?.targets ?? []);
}

/**
 * 让这家店的窗口里恰好有一个窗口标签页，且它写的是这家店、以及（可选）当前登录状态。
 *
 * 幂等：已存在就导航它（不会越堆越多），不存在才新建。
 * **只动标签页**：链路要用的工作页、千牛、登录页一概不碰，残留页签也只报告。
 */
export async function ensureLabelTabOn({
  proxyUrl,
  shop,
  port = null,
  state = null,
  ok = null,
  fetchImpl = fetch,
} = {}) {
  const targets = await readTargets(proxyUrl, fetchImpl);
  const classified = classifyShopTabs(targets);
  const labels = classified.filter((t) => t.kind === 'label');
  const url = labelPageUrlFor({ shop, port, state, ok });

  if (labels.length > 1) {
    // 堆了多个标签页时按纪律停手：navigate 哪个都不对，关掉哪个都是替人做决定。
    return { ok: false, shop, classified, error: `这个窗口里堆了 ${labels.length} 个标签页，先去关到只剩一个` };
  }
  if (labels.length === 1) {
    await fetchImpl(`${proxyUrl}/navigate?target=${encodeURIComponent(labels[0].targetId)}&url=${encodeURIComponent(url)}`,
      { method: 'POST', signal: AbortSignal.timeout(15000) });
    return { ok: true, shop, reused: true, targetId: labels[0].targetId, url, classified };
  }
  const created = JSON.parse(await fetchImpl(
    `${proxyUrl}/new?url=${encodeURIComponent(url)}&label=window-label`,
    { method: 'POST', signal: AbortSignal.timeout(15000) },
  ).then((r) => r.text()));
  return { ok: true, shop, reused: false, targetId: created?.targetId ?? null, url, classified };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
// 用法：
//   node runtime/shop-window-label.mjs                       # 只报告，不动浏览器
//   node runtime/shop-window-label.mjs --commit              # 给每家店挂/更新标签页（幂等）
//   node runtime/shop-window-label.mjs --commit --only 盖文淘宝
//   node runtime/shop-window-label.mjs --commit --state "需要登录" --ok 0
//
// 不带 `--commit` 时是**只读报告**：它同时回答用户那句「我看到每个浏览器里面有多个界面」——
// 每个页签是什么性质、哪些是链路要用的、哪些是残留，都列出来，不用人去猜。

function parseCli(argv) {
  const opts = { commit: false, only: null, state: null, ok: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const flags = ['--only', '--state', '--ok'];
    if (!flags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--only') opts.only = value;
    if (token === '--state') opts.state = value;
    if (token === '--ok') opts.ok = value === '1' || value === 'true';
    i += 1;
  }
  if (opts.only !== null && !shopBrowserKeys().includes(opts.only)) {
    throw new Error(`Unknown --only ${opts.only} (known: ${shopBrowserKeys().join(' / ')})`);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log('node runtime/shop-window-label.mjs [--commit] [--only 店名] [--state 文本] [--ok 1|0]');
    return;
  }
  const shops = opts.only ? [opts.only] : shopBrowserKeys();
  const report = { commit: opts.commit, shops: {} };
  let failed = 0;

  for (const shop of shops) {
    const entry = SHOP_BROWSERS[shop];
    const proxyUrl = `http://127.0.0.1:${entry.proxyPort}`;
    try {
      if (!opts.commit) {
        const targets = await readTargets(proxyUrl, fetch);
        const classified = classifyShopTabs(targets);
        const labels = classified.filter((t) => t.kind === 'label').length;
        report.shops[shop] = {
          browserPort: entry.browserPort,
          proxyPort: entry.proxyPort,
          windowTitle: windowTitleFor(shop),
          labelTabs: labels,
          needsLabelTab: labels === 0,
          tabs: classified.map((t) => `${t.label}  ${t.url}`),
          leftover: leftoverTabs(classified).map((t) => `${t.label}  ${t.url}`),
        };
        continue;
      }
      const result = await ensureLabelTabOn({
        proxyUrl, shop, port: entry.browserPort, state: opts.state, ok: opts.ok,
      });
      report.shops[shop] = result.ok
        ? { ok: true, reused: result.reused, targetId: result.targetId, windowTitle: windowTitleFor(shop) }
        : { ok: false, error: result.error };
      if (!result.ok) failed += 1;
    } catch (error) {
      // 「没读到」不算失败：浏览器可能这轮没起。如实记下来，不编一个结论。
      report.shops[shop] = { ok: false, unreachable: true, error: String(error?.message ?? error).slice(0, 200) };
      failed += 1;
    }
  }

  report.failed = failed;
  console.log(JSON.stringify(report, null, 1));
  if (failed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
