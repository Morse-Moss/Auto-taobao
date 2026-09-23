// 提交前泄漏自查：本批证据目录里不许出现收件人 id / 应用 id / 密钥 / Bearer。
//
// 为什么要在**证据**里留一份可跑的自查（而不是只在 tmp/ 里跑一次）：
// 「收据里带不带收件人」这件事只有真发过一次才知道。本轮真发了一条告警 ⇒ 收据里
// 可能带 `target`（收件人 open_id）。脚本自己在写盘前打码，这个扫描是**独立的第二道**：
// 打码规则写错（少一个前缀、大小写、全角）时，扫描会红，而不是等人 review 时用眼睛发现。
//
// 路径按**自身位置**算（`..`/`..`＝仓库根），所以这份脚本复制进 evidence/ 之后仍可跑。
// 用法：node evidence/auto-login-alert-2026-09-23/scan-leaks.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const REPO = join(HERE, '..', '..');
const ROOTS = [HERE, join(REPO, 'evidence', 'login-fill-origin-2026-09-23')];
const PATTERNS = [
  ['open_id', /ou_[0-9a-f]{20,}/gu],
  ['chat_id', /oc_[0-9a-f]{20,}/gu],
  ['app_id', /cli_[A-Za-z0-9]{8,}/gu],
  ['oauth_token', /t-[A-Za-z0-9]{20,}/gu],
  ['bearer', /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu],
];

const hits = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }  // 二进制（截图）跳过
    for (const [label, pattern] of PATTERNS) {
      const found = text.match(pattern);
      if (found) hits.push(`${full} :: ${label} :: ${[...new Set(found)].join(', ')}`);
    }
  }
};
for (const root of ROOTS) walk(root);

const out = hits.length
  ? `命中 ${hits.length} 处：\n${hits.join('\n')}`
  : '（干净：没有命中任何收件人 id / 应用 id / 密钥 / Bearer）';
writeFileSync(join(HERE, 'leak-scan.txt'), `${out}\n`, 'utf8');
process.stdout.write(`${out}\n`);
