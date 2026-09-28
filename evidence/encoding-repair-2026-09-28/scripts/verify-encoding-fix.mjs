// 验证 read-product-xls.py 的输出编码修复（前后对照）。
// 用法: node evidence/encoding-repair-2026-09-28/scripts/verify-encoding-fix.mjs（在仓库根跑）
// 判据: 「无 PYTHONIOENCODING/PYTHONUTF8」环境下
//        修复前 → 输出含 U+FFFD（GBK 被按 utf-8 解码）
//        修复后 → 输出含 U+FFFD 0 次
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const srcPy = path.join(root, 'skills/sycm-product-data/scripts/read-product-xls.py');

// ---- 1. 造一个「去掉修复」的副本（突变体），用于证明修复真的有用 ----
const original = fs.readFileSync(srcPy, 'utf8');
// 按行剥离（不依赖行尾风格，兼容 CRLF/LF）
const lines = original.split(/\r?\n/);
const keep = [];
for (let i = 0; i < lines.length; i += 1) {
  if (/^\s*try:\s*$/.test(lines[i])
    && /^\s+sys\.stdout\.reconfigure\(encoding='utf-8'\)\s*$/.test(lines[i + 1] || '')
    && /^\s*except Exception:\s*$/.test(lines[i + 2] || '')
    && /^\s+pass\s*$/.test(lines[i + 3] || '')) {
    i += 3;
    continue;
  }
  keep.push(lines[i]);
}
const stripped = keep.join('\n');
if (stripped === original) {
  console.log('FATAL: 没能从源文件里剥掉 reconfigure 块，找不到要突变的目标');
  process.exit(2);
}
const mutantPy = path.join(import.meta.dirname, '_read-product-xls-nofix.py');
fs.writeFileSync(mutantPy, stripped, 'utf8');
console.log('突变体已生成:', mutantPy, '(剥掉了 reconfigure 块)');
console.log('源文件含 reconfigure:', /sys\.stdout\.reconfigure/.test(original));
console.log('突变体含 reconfigure:', /sys\.stdout\.reconfigure/.test(stripped));

// ---- 2. 找一个真实的 .xls 样本（纯 node 递归，绕开 bash 的中文路径问题）----
function findXls(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findXls(p);
      if (r) return r;
    } else if (e.name.toLowerCase().endsWith('.xls')) {
      return p;
    }
  }
  return null;
}
const sample = findXls(path.join(root, 'evidence'));
if (!sample) {
  console.log('FATAL: evidence/ 下找不到 .xls 样本');
  process.exit(2);
}
console.log('样本:', sample);

// ---- 3. 计数工具 ----
function countFffd(text) {
  let n = 0;
  for (const ch of text) if (ch === '\uFFFD') n += 1;
  return n;
}
function run(pyFile, envPatch) {
  const env = { ...process.env, ...envPatch };
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === null) delete env[k];
  }
  const r = spawnSync(process.env.PYTHON || 'py', ['-3', pyFile, sample], {
    encoding: 'utf8',
    // 沙箱下同步 spawn 带 stdin 管道会 EBUSY，必须显式 ignore
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const out = r.stdout || '';
  let parsedOk = false;
  try {
    const rows = JSON.parse(out);
    parsedOk = Array.isArray(rows) && rows.length > 0;
  } catch {
    parsedOk = false;
  }
  return {
    status: r.status,
    bytes: Buffer.byteLength(out, 'utf8'),
    fffd: countFffd(out),
    parsedOk,
    err: (r.stderr || '').trim().slice(0, 200),
    head: out.slice(0, 120),
  };
}

const CASES = [
  { label: 'A 修复后 + 清空编码环境变量（模拟出问题时的真实环境）', py: srcPy, env: { PYTHONIOENCODING: null, PYTHONUTF8: null } },
  { label: 'B 修复后 + 强制 PYTHONIOENCODING=gbk（最坏情况）', py: srcPy, env: { PYTHONIOENCODING: 'gbk', PYTHONUTF8: null } },
  { label: 'C 突变体(未修复) + 清空编码环境变量【对照组，应复现乱码】', py: mutantPy, env: { PYTHONIOENCODING: null, PYTHONUTF8: null } },
  { label: 'D 突变体(未修复) + 强制 PYTHONIOENCODING=gbk【对照组，应复现乱码】', py: mutantPy, env: { PYTHONIOENCODING: 'gbk', PYTHONUTF8: null } },
];

console.log('\n%-72s %8s %8s %8s %10s', 'CASE', 'status', 'bytes', 'U+FFFD', 'JSON ok');
console.log('-'.repeat(112));
const results = [];
for (const c of CASES) {
  const r = run(c.py, c.env);
  results.push({ ...c, ...r });
  console.log(
    '%s %8s %8s %8s %10s',
    c.label.padEnd(72).slice(0, 72),
    String(r.status),
    String(r.bytes),
    String(r.fffd),
    String(r.parsedOk),
  );
}

console.log('\n--- 采样 ---');
for (const r of results) {
  console.log('[' + r.label.slice(0, 2) + '] ' + r.head.replace(/\s+/g, ' '));
}

// ---- 4. 判定 ----
const A = results[0], B = results[1], C = results[2], D = results[3];
const checks = [
  ['A 修复后无乱码 (U+FFFD==0)', A.fffd === 0],
  ['A JSON 可解析', A.parsedOk],
  ['B 最强 GBK 下仍无乱码 (U+FFFD==0)', B.fffd === 0],
  ['B JSON 可解析', B.parsedOk],
  ['C 对照组确实复现乱码 (U+FFFD>0) —— 证明样本本身含中文', C.fffd > 0],
  ['D 对照组确实复现乱码 (U+FFFD>0)', D.fffd > 0],
];
console.log('\n--- 判定 ---');
let allOk = true;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  if (!ok) allOk = false;
}
console.log('\nVERDICT: ' + (allOk ? 'FIX CONFIRMED' : 'NEED REVIEW'));
process.exitCode = allOk ? 0 : 1;
