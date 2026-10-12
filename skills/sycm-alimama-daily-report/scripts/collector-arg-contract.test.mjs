import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildShopStages } from './run-multi-shop-day.mjs';
import { collectingShopKeys } from '../../../runtime/browser-ports.mjs';

// 「编排层传的参数，对面认得吗？真的用吗？」—— 契约第 2 类的机器闸门（2026-10-13 加）。
//
// 这一类契约破坏长什么样（本仓真实发生过）：
//   调用方传 `--report-kind=keyword`，被调方压根不认 ⇒ 运行期 `unknown argument` 当场炸；
//   更安静的那一半是：**认了却不用** —— `args.reportKind` 解析成功、主流程里一次都没读，
//   于是「传了」与「没传」跑出来的结果逐字一样，而两边都不报错。
// 本地测试抓不到它：测试跑在工作区，两半都在 ⇒ 必过。`node --check` 只查语法，也不管这个。
//
// 为什么判据取「编排层真实传的 argv」而不是「被调方声明的参数表」：
//   声明表答的是「我能收什么」，契约要答的是「你传给我的每一个我都处理了」。
//   拿声明表去核对，`collect-shop-report.mjs` 会因为共用 `parseCollectArgs` 而背上一堆
//   它根本用不到的参数（台账、生成等待、重试次数…）—— 那是假红，比不检查更坏
//   （假红训练人忽略这个信号）。
//
// 依赖登记：本文件 import `runtime/browser-ports.mjs` 的 `collectingShopKeys()`（参与采集的 8 家）
// 当断言输入 —— 与 `ensure-inquiry-rows.test.mjs` 同一条理由：抄一份名单字符串的话，
// 名单一改这条用例照样绿，而它守的就是「参与采集的口径来自那唯一一处」。

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /import\s[^'"]*from\s*['"](\.[^'"]+\.mjs)['"]/gu;

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** argv 里出现的参数名（跳过值）。 */
export function flagsInArgv(argv) {
  return (Array.isArray(argv) ? argv : []).filter((item) => typeof item === 'string' && item.startsWith('--'));
}

/** `--report-kind` → `reportKind`（与 parseCollectArgs 的布尔开关同一条转法）。 */
export function camelCase(flag) {
  return String(flag).replace(/^--/u, '').replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

/**
 * 把脚本连同它**本地 import 的模块**的源码拼起来（深度 2，防环）。
 *
 * 为什么必须带上 import：日报链那两个采集脚本的 parser 不在自己文件里，而在共用的
 * `collect-core.mjs`（`parseCollectArgs`）。只读脚本自己的源码，`--phase` / `--date` /
 * `--proxy` 会被判成「不认得」—— 那是假红，而假红比不检查更坏。
 */
export function sourcesFor(scriptPath, depth = 2, seen = new Set()) {
  const key = path.resolve(scriptPath);
  if (seen.has(key) || depth < 0 || !existsSync(key)) return '';
  seen.add(key);
  const source = readFileSync(key, 'utf8');
  if (depth === 0) return source;
  let extra = '';
  for (const match of source.matchAll(IMPORT_RE)) {
    extra += sourcesFor(path.resolve(path.dirname(key), match[1]), depth - 1, seen);
  }
  return source + extra;
}

/**
 * 这个参数被**接收**了吗：源码里出现过它的字面量（引号形式）。
 * 三种 parser 都写成 `key === '--x'` / `k==='--x'`，所以引号内命中就够。
 */
export function accepted(source, flag) {
  return [`'${flag}'`, `"${flag}"`, `\`${flag}\``].some((quoted) => source.includes(quoted));
}

/**
 * 这个参数解析后存进了哪个键。找不到直接赋值时返回 `camelCase(flag)` ——
 * 那覆盖「布尔开关走 allowed 白名单」那一类（`--locate-only` → `args.locateOnly`）。
 *
 * 为什么必须找到**真实存进的键**：`date-picker.mjs` 的 `--date` 存的是 `args.requested`。
 * 直接按参数名去找 `args.date` 会假红（它确实被用了，只是换了名字）。
 */
export function storedKey(source, flag) {
  const assign = new RegExp(`['"\`]${escapeRegExp(flag)}['"\`]\\s*\\)\\s*(?:args|o)\\.([A-Za-z_$][\\w$]*)\\s*=`, 'u');
  const match = assign.exec(source);
  return match ? match[1] : camelCase(flag);
}

/** 键在源码里被**读**了几次（`args.x` / `o.x`）。 */
export function readCount(source, key) {
  const read = new RegExp(`(?:args|o)\\.${escapeRegExp(key)}\\b`, 'gu');
  return (source.match(read) ?? []).length;
}

/**
 * 那个键被**读**了吗。三条路都算（少认一条就假红）：
 *   ① 解构进来用：`date-picker.mjs` 的 `runApplyDate({ proxy, site, … })` 从不写
 *      `args.proxy`，`--proxy` 全靠解构进函数 —— 不认这一路会把好好工作的判据判红；
 *   ② 没有直接赋值的键（布尔开关走 `args[name] = true` 那条白名单路，如 `--locate-only`）
 *      ⇒ 源码里出现一次就算被读；
 *   ③ 有直接赋值的键 ⇒ 解析那一行本身就占一次 `args.x =`，所以至少要**再有**一处读写。
 *      只有那一次 ⇒ 收了却没人用（正是要抓的形态）。
 */
export function consumed(source, key) {
  const reads = readCount(source, key);
  const hasDirectAssign = new RegExp(`(?:args|o)\\.${escapeRegExp(key)}\\s*=`, 'u').test(source);
  const destructured = new RegExp(`[{,]\\s*${escapeRegExp(key)}\\s*[,}]`, 'u').test(source);
  return destructured || (hasDirectAssign ? reads >= 2 : reads >= 1);
}

/**
 * 已知「认了但这一侧不用」的参数。**每一行都要写理由** —— 与 arch-boundary 的白名单同一条纪律：
 * 不加理由的例外会腐烂成一份不实清单，而这个守卫存在的意义就是「事实与记录一致」。
 *
 * 这三条都是 2026-10-13 首跑时如实记下来的真事，不是为过绿灯凑的：
 *   · `expectArgs()` 把 `--expect-member` / `--expect-member-id` 拼进**每一个**采集阶段的 argv，
 *     而 `shop-report` 是生意参谋侧的脚本（身份核对只用页头店名 `--expect-shop`），
 *     阿里妈妈那两个期望值它收下但不用。无害，但正是「传了与没传一个样」的形态。
 *     哪天把 identityArgs 按站点拆开，这两条就可以删掉。
 *   · `collect-promotion-report.mjs` 只在 `if (args.reportKind) args.expectShop = args.shopKey;`
 *     写了它、没有任何一处读 —— 阿里妈妈那一页不显示店铺名，这一侧的身份闸门是会员名。
 *     那行赋值因此是死代码（候选清理项，见交付说明）；留着它是为了不改行为，
 *     但必须登记，否则下次有人真去用它时，会以为它一直是通的。
 */
const KNOWN_UNCONSUMED = Object.freeze([
  { script: 'collect-shop-report.mjs', flag: '--expect-member', why: 'shop-report 是生意参谋侧脚本，阿里妈妈会员名用不到（identityArgs 拼给了每个阶段）' },
  { script: 'collect-shop-report.mjs', flag: '--expect-member-id', why: '同上：阿里妈妈会员数字 ID 对这一侧没有意义' },
  { script: 'collect-promotion-report.mjs', flag: '--expect-shop', why: '阿里妈妈页不显示店铺名；这一侧的闸门是会员名。仅有一处赋值、无人读' },
]);

/** 一个阶段（脚本 + argv）的契约核对结果。 */
export function checkStageContract(stage, { ownSource, fullSource }) {
  const flags = flagsInArgv(stage?.argv);
  const problems = [];
  if (!stage?.script) return { stage: stage?.stage ?? '?', script: null, flags, problems };
  for (const flag of flags) {
    if (!accepted(fullSource, flag)) {
      problems.push(`不认得 ${flag}（脚本与它 import 的 parser 里都没有这个参数 ⇒ 真跑会 unknown argument）`);
      continue;
    }
    const key = storedKey(fullSource, flag);
    // 「用没用」只看**这个脚本自己**的源码：共用 parser 收了、调用方一次不读，
    // 正是要抓的形态。白名单例外必须在 KNOWN_UNCONSUMED 里写明理由。
    if (consumed(ownSource, key)) continue;
    const known = KNOWN_UNCONSUMED.find((row) => row.script === stage.script && row.flag === flag);
    if (!known) {
      problems.push(`收了 ${flag}（存进 ${key}）却没有任何地方读它 —— 「传了」与「没传」结果会逐字一样`);
    }
  }
  return { stage: stage.stage, script: stage.script, flags, problems };
}

const readScript = (name) => readFileSync(path.join(SCRIPT_DIR, name), 'utf8');

// ---------------------------------------------------------------- 纯函数判据（合成样本）
//
// 先用合成源码把判据本身钉住。理由：只跑真文件的那个大用例时，判据写错了也会绿
// （比如把「读了」判成「出现过」），而这个仓库已经因为「用例全绿 ≠ 判据对」栽过多次。

test('判据：认得 / 存进哪 / 读没读，三件事分开判', () => {
  const src = [
    "if (key === '--date') args.date = next();",
    "if (key === '--phase') args.phase = next();",
    "if (key === '--report-kind') args.reportKind = next();", // 收了…
    "console.log(args.date, args.phase);",                   // …这两个读了
  ].join('\n');
  assert.equal(accepted(src, '--date'), true);
  assert.equal(accepted(src, '--nope'), false);
  assert.equal(storedKey(src, '--date'), 'date');
  assert.equal(consumed(src, 'date'), true);
  assert.equal(consumed(src, 'phase'), true);
  // report-kind 只被解析、没人读 ⇒ 这正是要抓的那一型
  assert.equal(storedKey(src, '--report-kind'), 'reportKind');
  assert.equal(consumed(src, 'reportKind'), false, '只出现在解析行 ⇒ 不算被消费');
});

test('判据：参数名与内部键不同名时按真实键判（date-picker 的 --date → requested）', () => {
  const src = "else if (key === '--date') args.requested = argv[++index];\napply(args.requested);";
  assert.equal(storedKey(src, '--date'), 'requested');
  assert.equal(consumed(src, 'requested'), true);
  // 若按参数名硬找 args.date 会假红 —— 这条用例钉住「不许那么判」
  assert.equal(consumed(src, 'date'), false);
});

test('判据：解构进函数的参数也算被读（date-picker 的 --proxy 全靠解构）', () => {
  const src = "else if (key === '--proxy') args.proxy = argv[++index];\nasync function run({ proxy, site } = {}) { return proxy; }";
  assert.equal(readCount(src, 'proxy'), 1, '只有解析那一行，没有第二处 args.proxy');
  assert.equal(consumed(src, 'proxy'), true, '不认解构就会把好好工作的判据判红');
  // 反面对照：解构里也没有 ⇒ 仍然算没读
  const bare = "else if (key === '--proxy') args.proxy = argv[++index];\nasync function run({ site } = {}) { return site; }";
  assert.equal(consumed(bare, 'proxy'), false);
});

test('判据：布尔开关按派生键判（--locate-only → locateOnly）', () => {
  const src = "else if (allowed.has(key)) { args[name] = true; }\nif (args.locateOnly) return;";
  assert.equal(storedKey(src, '--locate-only'), 'locateOnly');
  assert.equal(consumed(src, 'locateOnly'), true);
});

test('判据：`o.x` 形状也认（商品链那个脚本用 o 不用 args）', () => {
  const src = "if(k==='--shop')o.shop=argv[++i];\nshopInstance(o.shop);";
  assert.equal(accepted(src, '--shop'), true);
  assert.equal(storedKey(src, '--shop'), 'shop');
  assert.equal(consumed(src, 'shop'), true);
});

// ---------------------------------------------------------------- 真文件：编排层传的每个参数

test('编排层传给每个采集脚本的每个参数，对面都认得、也都真的用', () => {
  const shopKey = collectingShopKeys()[0];
  const stages = buildShopStages(shopKey, { date: '2026-10-13', mode: 'rehearse' });
  const withScript = stages.filter((stage) => stage.script);
  assert.ok(withScript.length >= 5, `核对面异常：只找到 ${withScript.length} 个带脚本的阶段（应 ≥ 5）`);

  const allFlags = new Set();
  const problems = [];
  for (const stage of withScript) {
    const scriptPath = path.join(SCRIPT_DIR, stage.script);
    const contract = checkStageContract(stage, {
      ownSource: readScript(stage.script),
      fullSource: sourcesFor(scriptPath),
    });
    contract.flags.forEach((flag) => allFlags.add(flag));
    if (contract.problems.length > 0) {
      problems.push(`${contract.stage} → ${contract.script}：${contract.problems.join('；')}`);
    }
  }
  assert.ok(allFlags.size >= 8, `核对面异常：只核到 ${allFlags.size} 个参数（应 ≥ 8，否则扫描逻辑坏了）`);
  assert.deepEqual(problems, [],
    `下面这些参数「传了却没被对面当回事」—— 传了与没传跑出来会逐字一样，且两边都不报错：\n${problems.join('\n')}`);
});

// 反面对照：拿**真文件**喂一个对面不认的参数，证明这个守卫真能红。
// 没有这一条，「全绿」可能只是判据根本没接上（本项目已经因为「用例全绿 ≠ 接线接上了」
// 栽过三次）—— 判据能红与判据接对了，是两件事，都要有证据。
test('反面对照：真文件 + 一个对面不认的参数 ⇒ 当场点名（证明守卫真能红）', () => {
  const contract = checkStageContract(
    { stage: 'shop-report', script: 'collect-shop-report.mjs', argv: ['--date', '2026-10-13', '--bogus-flag', 'x'] },
    {
      ownSource: readScript('collect-shop-report.mjs'),
      fullSource: sourcesFor(path.join(SCRIPT_DIR, 'collect-shop-report.mjs')),
    },
  );
  assert.ok(contract.problems.some((line) => /不认得 --bogus-flag/.test(line)),
    `守卫对明显不该过的参数没反应：${contract.problems.join('｜')}`);
});
