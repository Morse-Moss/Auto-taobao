// 按店铺名打印采集脚本要用的身份参数（只读，不连任何外部服务，不点任何东西）。
//
// 存在的理由很窄：登记表（`shop-identities.mjs`）是对的东西，但把它的值**手抄**到命令行上，
// 就又把「抄错一个字」放回来了 —— 而抄错的代价是判据在正确的窗口上拦人、
// 或者在错误的窗口上放行（后者才是要命的那个）。
// 所以这里只做一件事：把登记表里的值原样印成可粘贴的参数。
//
// 用法：
//   node scripts/show-shop-identity.mjs                     # 12 家一览（含未实测标记）
//   node scripts/show-shop-identity.mjs 里可林淘宝          # 打印该店的参数
//   node scripts/show-shop-identity.mjs 安比淘宝 --require shop,member
//                                                          # 缺字段即非零退出（可直接用在脚本里当闸门）
//
// 退出码：0 = 成功；2 = 参数/登记表问题（含 require 未满足）。踩到问题就非零退出，
// 这样它才能被当成闸门用，而不是一个「打印了但没人看」的工具。
import {
  SHOP_IDENTITIES, describeIdentity, expectArgs, formatArgv, platformOf, shopKeys,
} from './shop-identities.mjs';

const argv = process.argv.slice(2);
const key = argv.find((arg) => !arg.startsWith('--'));
const requireIndex = argv.indexOf('--require');
const require = requireIndex === -1 ? [] : String(argv[requireIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const KNOWN_FIELDS = ['shop', 'member'];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

for (const field of require) {
  if (!KNOWN_FIELDS.includes(field)) {
    fail(`--require 只认 ${KNOWN_FIELDS.join(' / ')}，收到「${field}」`);
  }
}
if (!key) {
  process.stdout.write(`已登记 ${SHOP_IDENTITIES.length} 家店（* ＝该店两侧身份都已实测）：\n`);
  for (const row of SHOP_IDENTITIES) {
    const verified = row.sycmHeaderVerified && row.alimamaVerified ? '*' : ' ';
    process.stdout.write(`  ${verified} ${describeIdentity(row.key)}   [${platformOf(row.key)}]\n`);
  }
  process.stdout.write('\n用法：node scripts/show-shop-identity.mjs <店铺叫法> [--require shop,member]\n');
  process.stdout.write(`店铺叫法（＝飞书「店铺」列的值）：${shopKeys().join(' / ')}\n`);
  process.exit(0);
}

// 引号规则只有一处定义（`formatArgv`），别在这里复制一份 —— 复制出来的那份不会跟着改。
let result;
try {
  result = expectArgs(key, { require });
} catch (err) {
  fail(err.message);
}

if (result.args.length === 0) {
  process.stdout.write(`# 「${key}」还没有任何实测身份值，不能开身份判据（${describeIdentity(key)}）\n`);
  process.exit(0);
}

process.stdout.write(`${formatArgv(result.args)}\n`);
if (result.missing.length > 0) {
  // 提示走 stderr：这一行不是可粘贴内容，混进 stdout 会被一起粘到命令行上。
  process.stderr.write(`注意：「${key}」的 ${result.missing.join(' / ')} 还没有实测值`
    + ` —— 上面这行只带了能给的参数，对应的那道判据是**没开**的。\n`);
}
