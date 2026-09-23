// 真机自动登录尝试（只对当前掉登录的两家天猫店）—— 回答用户那句「做不到自动登录吗？？？」。
//
// 为什么不直接在命令行里写中文店名：本机 shell 不保证把中文 argv 逐字递给 node
// （实测过：中文参数过 shell 会被重编码，店名对不上就变成「Unknown --shop」）。
// 所以店名写在**这个文件里**（UTF-8 落盘），shell 那一层只出现纯 ASCII。
//
// 这条驱动**故意不自带判定**：它只负责把 check-login-shops.mjs 的原始输出与逐店回执落盘。
// 结论一律以回执里的 verdict / notify 为准 —— 驱动自己再加一层「我认为成功了」，
// 就等于多出第二份口径，而两份口径迟早会打架。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO_ROOT, 'skills', 'sycm-alimama-daily-report', 'scripts', 'check-login-shops.mjs');

// 这一轮只点两家：另外三家（里可林淘宝 / 盖文淘宝 / 科塔淘宝）上一轮复核还在登录态，
// 把它们也串进来只会白白多等两个 20 秒静默期（带 --login 时是串行 + 间隔的）。
const SHOPS = '网林天猫,盖文天猫';

const started = new Date();
const result = spawnSync(process.execPath, [CLI, '--login', '--shops', SHOPS, '--json'], {
  cwd: REPO_ROOT,
  // 串行 + 一个 20 秒静默期 + 每店最多 180 秒探测 ⇒ 给足 600 秒，超时但别中途杀掉。
  timeout: 600_000,
  maxBuffer: 32 * 1024 * 1024,
  encoding: 'utf8',
});

const raw = [
  `# 命令：node ${path.relative(REPO_ROOT, CLI).replaceAll('\\', '/')} --login --shops ${SHOPS} --json`,
  `# 开始：${started.toISOString()}`,
  `# 结束：${new Date().toISOString()}`,
  `# 退出码：${result.status}${result.signal ? ` (signal=${result.signal})` : ''}${result.error ? ` error=${result.error.message}` : ''}`,
  '',
  '--- stdout ---',
  result.stdout ?? '',
  '--- stderr ---',
  result.stderr ?? '',
].join('\n');
writeFileSync(path.join(HERE, 'auto-login-attempt.txt'), raw, 'utf8');

let parsed = null;
try {
  parsed = JSON.parse(result.stdout ?? '');
} catch {
  parsed = null;
}
if (parsed) writeFileSync(path.join(HERE, 'auto-login-attempt.json'), JSON.stringify(parsed, null, 1), 'utf8');

// 只打印摘要：完整明细在落盘的两份里，控制台这层只回答「哪家成了、哪家没成、叫没叫人」。
//
// 第一版这里读的是 `row.receipt.login.opened` —— **那个字段不存在**（父脚本的行由
// judgeShopReceipt 拍平，子进程的回执不嵌套在里面的），于是每家都印成「(未走到那一步)」，
// 而盖文天猫那家其实**真的走到过登录页**。一行读错的字段能把「机器试过了」印成
// 「机器什么都没做」—— 这正是本次要消灭的那类静默，所以这里只印**确实存在**的字段。
console.log(`退出码=${result.status}`);
console.log(`收据可解析=${parsed !== null}`);
if (parsed) {
  console.log(`整体结论=${parsed.verdict}`);
  for (const row of parsed.rows ?? []) {
    const n = row.notify ?? null;
    console.log(`  · ${row.shop}：${row.verdict}`);
    console.log(`      两个后台=${JSON.stringify(row.sites ?? null)}`);
    console.log(`      子脚本结论=${row.scriptVerdict ?? '(无)'}${row.detail ? ` —— ${row.detail}` : ''}`);
    const ns = n ? `${n.status}${n.alertId ? ` (${n.alertId})` : ''}` : '(无)';
    console.log(`      飞书投递=${ns}`);
    if (row.probeError) console.log(`      体检没拿到回执：${row.probeError}`);
  }
} else {
  console.log('（原始输出未解析成 JSON，请看 auto-login-attempt.txt）');
}
