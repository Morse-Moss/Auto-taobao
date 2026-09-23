// 真机验证（自定位版：本文件在 <repo>/evidence/<批次>/ 下，所以 runtime 在 ../../runtime）：「没有标签页、但有空白页」时，新逻辑是不是**接管**那个空白页，而不是新建一个。
//
// 为什么必须真跑（不能只靠离信用例）：离线用例用的是**假代理**，
// 它只断言「脚本发了 /navigate」；而「代理的 /navigate 到底能不能把一个 about:blank 导航走」
// 只有真浏览器能回答 —— 这正是本项目反复吃过的「函数级用例全绿 ≠ 接线接上了」。
//
// 做法：把那个状态真造出来 —— 关掉里可林现在那个标签页（它本来就会被 15 分钟回收，
// 这里只是把「下一轮会自然发生的事」提前一次），然后跑 `--commit`，看空白页的 targetId 是不是**原地**变成了标签页。
// 若中途失败，再跑一次 `--commit` 即可恢复（那时会走新建分支）。
import { spawnSync } from 'node:child_process';
import { SHOP_BROWSERS } from '../../runtime/browser-ports.mjs';

const SHOP = '里可林淘宝';
const NODE = process.execPath;
const LABEL_NAME = 'shop-window-label.html';
const { proxyPort } = SHOP_BROWSERS[SHOP];
const PROXY = `http://127.0.0.1:${proxyPort}`;

const targets = async () => {
  const res = await fetch(`${PROXY}/targets`, { signal: AbortSignal.timeout(8000) });
  const payload = await res.json();
  return (Array.isArray(payload) ? payload : payload?.targets ?? []).filter((t) => (t.type ?? 'page') === 'page');
};
const show = (list, tag) => {
  console.log(`[${tag}] ${list.length} 个页签`);
  for (const t of list) console.log(`  ${t.targetId}  ${String(t.url).slice(0, 130)}`);
};
const isBlank = (t) => /^about:(blank|newtab)/u.test(String(t.url));
const isLabel = (t) => String(t.url).includes(LABEL_NAME);

// 现场可能已经没有空白页了（上一轮刚接管过，或链路这一轮没留残渣）⇒ 先自己造一个，
// 否则这条路径无从验证、而「无从验证」看起来和「坏了」一模一样。
// 造出来的那个页签就是「链路用完没关的空白页」的替身 —— 接管成功后它就不存在了。
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
let before = await targets();
show(before, '前');

if (!before.some(isBlank)) {
  console.log('\n现场没有空白页 ⇒ 先 /new 一个 about:blank 造出状态（否则这条路径无从验证）');
  await fetch(`${PROXY}/new?url=${encodeURIComponent('about:blank')}&label=probe-blank`, { method: 'POST' });
  await sleep(1500);
  before = await targets();
  show(before, '造出空白页之后');
}

const label = before.find(isLabel);
const blank = before.find(isBlank);
if (!label) { console.log('\n没有标签页可关 ⇒ 造不出「无标签页」状态，验证终止'); process.exit(2); }
if (!blank) { console.log('\n造不出空白页 ⇒ 这条路径在当前现场无从验证，终止'); process.exit(2); }
console.log(`\n将关掉标签页 ${label.targetId}；期望脚本去接管空白页 ${blank.targetId}\n`);

await fetch(`${PROXY}/close?target=${encodeURIComponent(label.targetId)}`, { method: 'POST' });
await new Promise((resolve) => { setTimeout(resolve, 1500); });
const mid = await targets();
show(mid, '关掉标签页之后');

const run = spawnSync(NODE, ['runtime/shop-window-label.mjs', '--commit', '--front', '--only', SHOP],
  { cwd: 'D:/Retire/sycm-automation', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
console.log('\n--- 挂标签页的输出 ---');
console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`);

const after = await targets();
show(after, '后');

const adopted = after.find((t) => t.targetId === blank.targetId);
const stillBlank = after.filter(isBlank);
const labels = after.filter(isLabel);
const ok = Boolean(adopted) && isLabel(adopted) && stillBlank.length === 0 && labels.length === 1;

console.log('\n--- 判定 ---');
console.log(`空白页那个 targetId（${blank.targetId}）现在指向：${adopted ? String(adopted.url).slice(0, 120) : '（已经不存在了）'}`);
console.log(`接管成功（原地变成标签页）：${ok ? '是' : '否'}`);
console.log(`窗口里还剩空白页：${stillBlank.length} 个（期望 0）`);
console.log(`标签页数量：${labels.length}（期望 1）`);
// 口径说明：这里中间那个「关掉标签页」是**为了造状态**才做的，不是接管带来的。
// 接管本身只做一件事：把空白页那个页签原地换成标签页 —— 所以「接管这一步不增加页签」才是要看的判据。
console.log(`页签总数：前 ${before.length} → 关掉标签页后 ${mid.length} → 接管后 ${after.length}`
  + `（接管这一步${after.length === mid.length ? '没有增加页签：符合' : `增加了页签：不符合`}）`);
process.exit(ok ? 0 : 1);
