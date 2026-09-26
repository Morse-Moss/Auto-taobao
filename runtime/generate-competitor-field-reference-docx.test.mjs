import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'runtime/generate-competitor-field-reference-docx.cjs');
const CLIENT_MD = path.join(ROOT, 'docs/references/COMPETITOR-FIELD-REFERENCE-CLIENT.md');
const WORKDIR = path.join(os.tmpdir(), 'sycm-docx-parser-guard');

function render(src, out) {
  // `stdio` 必须显式写、且 stdin 只能是 `'ignore'`（2026-09-26，与 CHANGELOG 1.7.1/1.7.2 同一病根）：
  // 不写 stdio 时默认**三根都是管道**，而本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回
  // `EBUSY`（`errno=-4082`）⇒ `status` 是 `null`，两条用例报
  // `renderer exited null: undefined` / `null !== 0`，看起来像**渲染器坏了**，
  // 实际是这道门自己根本没跑起来。本文件是这处漏修的**第四处**
  //（1.7.1 修了链上与几个门禁脚本、1.7.2 补修了 delivery-status，都没扫到这里）。
  // stdout 要接下来判断，所以只把 stdin 改成 ignore。
  return spawnSync(process.execPath, [SCRIPT, '--src', src, '--out', out], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('renderer consumes every special-looking line instead of stalling', () => {
  // 这三种行都满足解析器的 isSpecial，却没有任何分支接住它们：
  //   1) 段落行以行内代码开头（isSpecial 的字符类含反引号）
  //   2) 「#」后不带空格的伪标题（不匹配 /^(#{1,4})\s+/）
  //   3) 五级及以上的井号（超出 heading 正则的 1-4）
  // 兜底分支若原地空转，index 不前进，会无限 push 空段落直到堆耗尽。
  fs.mkdirSync(WORKDIR, { recursive: true });
  const src = path.join(WORKDIR, 'stall.md');
  const out = path.join(WORKDIR, 'stall.docx');
  fs.writeFileSync(src, [
    '# 兜底回归样例',
    '',
    '`行内代码` 开头的一整行。',
    '',
    '#nospace 的伪标题。',
    '',
    '##### 五级井号。',
    '',
    '正常段落。',
    '',
  ].join('\n'));

  const result = render(src, out);

  assert.equal(result.status, 0, `renderer exited ${result.status}: ${result.stderr}`);
  assert.ok(fs.statSync(out).size > 0, 'renderer produced an empty docx');
});

test('client reference markdown renders end to end', () => {
  // 交付用的 md 一旦出现解析器没有分支接住的行首字符，这个测试会先炸，
  // 而不是等到交付当天渲染 OOM 才发现。
  fs.mkdirSync(WORKDIR, { recursive: true });
  const out = path.join(WORKDIR, 'client.docx');

  const result = render(CLIENT_MD, out);

  assert.equal(result.status, 0, `renderer exited ${result.status}: ${result.stderr}`);
  assert.ok(fs.statSync(out).size > 0, 'renderer produced an empty docx');
});
