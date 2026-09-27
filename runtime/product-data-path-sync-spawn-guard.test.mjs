// 守卫：商品数据这条链上**不许出现「没写 stdio 的同步起子进程」**。
//
// 为什么需要它（2026-09-27 实测）：本机宿主沙箱对「给了子进程 stdin 管道」的同步 spawn 直接回
// `EBUSY`（`errno=-4082`），此时 `status=null`、`stdout=null`、`stderr=''`：
//   · 导入脚本把它读成「XLS/ZIP parser failed」⇒ 五家店底单+询单+推广**全部**导入失败，飞书零写入；
//   · `stop-all` 把它读成「监听表是空的」⇒ 断言「没有在跑，无需处理」并退 0（假绿）；
//   · `release-product-data-browsers` 把它读成「在听的端口数是 0」⇒ `released` 恒 true。
// 三处症状完全不同、病根同一个，所以判据只有一条：**同步 spawn 必须显式写 stdio，且 stdin 不许是管道**。
//
// 范围说明（故意不是全仓）：本守卫只钉「商品数据入口这条链」的文件。全仓版本（`grep -rn` 之后逐处判读）
// 见 CHANGELOG 里记的那条 L3 待办 —— 现在做全仓版会因为**别的会话正在改的文件**立刻变红，
// 那不是发现缺陷，只是噪音。这份清单是「这条链的接线图」，改动时请同步维护。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PATH_FILES = [
  'scripts/run-product-data-job.mjs',
  'scripts/release-product-data-browsers.mjs',
  'scripts/stop-all.mjs',
  'runtime/browser-inventory.mjs',
  'runtime/environment-preflight.mjs',
  'runtime/product-data-job-core.mjs',
  'skills/sycm-product-data/scripts/import-product-data.mjs',
  'skills/sycm-product-data/scripts/collect-product-report.mjs',
  'skills/sycm-product-data/scripts/login-preflight.mjs',
  'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
  'skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs',
  'skills/sycm-promotion-data/scripts/import-promotion-data.mjs',
  'skills/sycm-promotion-data/scripts/collect-product-report.mjs',
];

const CALL_RE = /\b(spawnSync|execFileSync|execSync)\s*\(/gu;
// 同步 spawn 的选项就在调用点附近；取一段窗口找 stdio，而不是去解析 JS（守卫要能读、不要能编译）。
const WINDOW = 900;
const STDIO_RE = /stdio\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/u;

/** 从 `stdio` 的写法里取出「stdin 这一档」。返回 null 表示取不出（例如动态拼接 ⇒ 也算不合规）。 */
function stdinSlot(stdioLiteral) {
  const inner = stdioLiteral.trim();
  if (!inner.startsWith('[')) return inner.replace(/['"]/gu, ''); // 'ignore' / 'inherit'
  const first = inner.slice(1, -1).split(',')[0]?.trim();
  return first ? first.replace(/['"]/gu, '') : null;
}

test('商品数据链上每个同步 spawn 都显式写了 stdio，且 stdin 不是管道', () => {
  const offenders = [];
  for (const relative of PATH_FILES) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(CALL_RE)) {
      const window = source.slice(match.index, match.index + WINDOW);
      const stdioMatch = window.match(STDIO_RE);
      const line = source.slice(0, match.index).split('\n').length;
      if (!stdioMatch) {
        offenders.push(`${relative}:${line} ${match[1]} 没有写 stdio（沙箱下会 EBUSY 并伪装成业务失败）`);
        continue;
      }
      const stdin = stdinSlot(stdioMatch[1]);
      if (stdin === 'pipe') {
        offenders.push(`${relative}:${line} ${match[1]} 的 stdio 把 stdin 设成了 'pipe'（EBUSY 的成因就是它）`);
      } else if (stdin === null || stdin.startsWith('[')) {
        offenders.push(`${relative}:${line} ${match[1]} 的 stdio 写法取不到 stdin 档：${stdioMatch[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `这些同步 spawn 会让整条链静默失败：\n${offenders.join('\n')}`);
});

test('三处导入解析点都钉在 read-product-xls.py / python 上（改名要连守卫一起改）', () => {
  const anchors = [
    ['skills/sycm-product-data/scripts/import-product-data.mjs', 'read-product-xls.py'],
    ['skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs', 'read-product-xls.py'],
    ['skills/sycm-promotion-data/scripts/import-promotion-data.mjs', 'process.env.PYTHON'],
  ];
  for (const [relative, anchor] of anchors) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.ok(source.includes(anchor), `${relative} 里找不到锚点 ${anchor} —— 解析口径变了就要重看这段守卫`);
  }
});
