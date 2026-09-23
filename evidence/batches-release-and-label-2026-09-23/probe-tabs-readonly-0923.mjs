// 只读取证：看五个店铺窗口此刻的页签（**只 GET /targets，不新建、不导航、不关任何页**）。
// 目的：验证用户 2026-09-23 三条要求里的两条 —— 「不要空页」与「每个店铺的浏览器要有标识页」。
// 判据（打印在最下面）：每个店铺窗口里 blank 页签数 = 0，且 label 页签数 = 1。
//
// 用法（**必须在店铺浏览器活着的时候跑**：本机 05:44:55 已按新口径释放，之后跑只会读到「读不到」）：
//   node evidence/batches-release-and-label-2026-09-23/probe-tabs-readonly-0923.mjs
//
// 收进 evidence 时改过一行：import 从 `../runtime/...` 改成 `../../runtime/...`
// （脚本按自身位置算相对路径，复制后深了一层就会静默指向别处 —— 那种失效只有真跑才看得见）。
import { SHOP_BROWSERS, shopBrowserKeys } from '../../runtime/browser-ports.mjs';

const fetchImpl = fetch;
async function targets(proxyPort) {
  const r = await fetchImpl(`http://127.0.0.1:${proxyPort}/targets`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const payload = await r.json();
  return Array.isArray(payload) ? payload : (payload?.targets ?? []);
}

const rows = [];
for (const shop of shopBrowserKeys()) {
  const entry = SHOP_BROWSERS[shop];
  let list = [];
  let error = null;
  try { list = await targets(entry.proxyPort); } catch (e) { error = String(e?.message ?? e); }
  const pages = list.filter((t) => (t?.type ?? 'page') === 'page');
  const urls = pages.map((t) => String(t?.url ?? ''));
  const blanks = urls.filter((u) => /^about:(blank|newtab)/u.test(u));
  const labels = urls.filter((u) => u.includes('shop-window-label.html'));
  const row = { shop, proxyPort: entry.proxyPort, reachable: error === null, error, pageCount: pages.length, blanks: blanks.length, labels: labels.length, urls };
  rows.push(row);
  console.log(`\n=== ${shop}（代理 ${entry.proxyPort}） 页签 ${pages.length} 个：空白 ${blanks.length} 个、标识页 ${labels.length} 个${error ? `  ⚠ 读不到：${error}` : ''}`);
  for (const u of urls) console.log(`    ${u.slice(0, 160)}`);
}

console.log('\n=== 判据 ===');
let bad = 0;
for (const row of rows) {
  if (!row.reachable) { console.log(`✗ ${row.shop}：读不到代理（${row.error}）`); bad += 1; continue; }
  if (row.blanks !== 0) { console.log(`✗ ${row.shop}：还有 ${row.blanks} 个空白页（用户明确要求「不要空页」）`); bad += 1; }
  if (row.labels !== 1) { console.log(`✗ ${row.shop}：标识页 ${row.labels} 个（期望恰好 1 个）`); bad += 1; }
  if (row.blanks === 0 && row.labels === 1) console.log(`✓ ${row.shop}：空白 0 个、标识页 1 个`);
}
console.log(bad === 0 ? '\n结论：五家店 ✅ —— 没有空白页，每家有且只有一个标识页' : `\n结论：${bad} 处不符合`);
process.exitCode = bad === 0 ? 0 : 1;
