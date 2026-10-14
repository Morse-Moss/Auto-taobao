// 「窗口太小就别点」这道闸门的突变验证（批次 1.9.0，Task 3 的证据）。
//
// 为什么必须跑：本项目吃过三次同一个亏 —— **用例全绿 + 突变过了 ≠ 接线接上了**。
// 判据要钉住的是「调用侧真的传了什么、对面真的认不认」，所以每个变异都点名期望的用例。
//
// 纪律：源文件必须逐字节还原（sha256 自证），还原发生在断言之前。
// 位置无关：仓库根靠**向上找哨兵文件 `VERSION`** 定位，不写死绝对路径、也不数 `..` 层数
// —— 这样本副本放在 `evidence/<批次>/` 下也能直接跑（见技能 evidence-copy-must-be-runnable）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(ROOT, 'VERSION')) && ROOT !== path.dirname(ROOT)) ROOT = path.dirname(ROOT);
if (!existsSync(path.join(ROOT, 'VERSION'))) {
  console.error(`找不到仓库根（从 ${import.meta.url} 向上没有 VERSION）`);
  process.exit(2);
}

const S = path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts');
const TEST = path.join(S, 'login-merchant-core.test.mjs');
const MAIN = path.join(S, 'login-merchant.mjs');
const CORE = path.join(S, 'login-merchant-core.mjs');
const NODE = process.execPath;

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// EOL 健壮：锚点写成 LF 形态，落到 CRLF 的 checkout 上也能命中；写回时保留原文件的 EOL。
function mutate(text, from, to) {
  const crlf = text.includes('\r\n');
  const norm = text.replace(/\r\n/gu, '\n');
  const count = norm.split(from).length - 1;
  const next = count === 1 ? norm.replace(from, to) : norm;
  return { count, text: crlf ? next.replace(/\n/gu, '\r\n') : next };
}

const MUTATIONS = [
  {
    id: 'M1 闸门条件被换成恒假',
    file: MAIN,
    from: 'if (args.commit && viewport.blocksClick) {',
    to: 'if (args.commit && false) {',
    expect: /第一次坐标点击之前/u,
  },
  {
    id: 'M2 判决词拼错（VIEWPORT_TOO_NARROW → VIEWPORT_TOO_SMALL）',
    file: MAIN,
    from: "receipt.verdict = 'VIEWPORT_TOO_NARROW';",
    to: "receipt.verdict = 'VIEWPORT_TOO_SMALL';",
    expect: /结论词|主脚本/u,
  },
  {
    id: 'M3 词表少一个词（两个词只登记一个）',
    file: CORE,
    from: "Object.freeze(['VIEWPORT_TOO_NARROW', 'VIEWPORT_TOO_SHORT']);",
    to: "Object.freeze(['VIEWPORT_TOO_NARROW']);",
    expect: /登记齐/u,
  },
  {
    id: 'M4 拦不拦恒为假（判据还在，结论永远不拦）',
    file: CORE,
    from: 'const blocksClick = VIEWPORT_CLICK_VERDICTS.includes(base.reason);',
    to: 'const blocksClick = false;',
    expect: /三个出口/u,
  },
  {
    id: 'M5 闸门不看这次读到的读数（喂 null）',
    file: MAIN,
    from: 'judgeViewportForClick(state.viewport)',
    to: 'judgeViewportForClick(null)',
    expect: /第一次坐标点击之前/u,
  },
  {
    id: 'M6 表单状态不再带回窗口读数',
    file: CORE,
    from: '    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },',
    // 只删这一行的内容（上一版会连换行一起删）—— 锚点里不带 `\n` 才能在 CRLF checkout 上也命中。
    to: '',
    expect: /四个信号全空|主脚本/u,
  },
  {
    id: 'M7 阈值在本目录另抄一份 1200x600（先改机制层的值，看抄的那份会不会跟着动）',
    file: CORE,
    from: 'threshold: { width: SHOP_VIEWPORT_MIN_WIDTH, height: SHOP_VIEWPORT_MIN_HEIGHT },',
    to: 'threshold: { width: 1200, height: 600 },',
    expect: /机制层那一份/u,
  },
];

const before = { [MAIN]: sha(MAIN), [CORE]: sha(CORE) };
let allRed = true;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file);
  const applied = mutate(original.toString('utf8'), m.from, m.to);
  if (applied.count !== 1) {
    console.log(`${'BAD  '} ${m.id}`);
    console.log(`      锚点命中 ${applied.count} 次（必须是 1）`);
    allRed = false;
    continue;
  }
  writeFileSync(m.file, applied.text);
  let out = '';
  let code = 0;
  try {
    out = execFileSync(NODE, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = error.status ?? 1;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  writeFileSync(m.file, original); // 立刻还原（在断言之前）
  const restored = sha(m.file) === before[m.file];
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].map((x) => x[1].trim());
  const named = failed.some((name) => m.expect.test(name));
  const ok = code !== 0 && named && restored;
  if (!ok) allRed = false;
  console.log(`${ok ? 'RED  ' : 'BAD  '} ${m.id}`);
  console.log(`      退出码=${code}｜还原逐字节=${restored}｜红的用例=${failed.length ? failed.join(' ｜ ') : '(无)'}`);
}
for (const [file, digest] of Object.entries(before)) {
  const now = sha(file);
  console.log(`${now === digest ? 'OK   ' : 'DIRTY'} ${path.relative(ROOT, file)} ${now === digest ? '(与跑之前逐字节相同)' : '(!! 没还原干净)'}`);
}
console.log(allRed ? '\n结论：七处突变全部按预期变红，且源文件已逐字节还原。' : '\n结论：有突变没有按预期变红 —— 判据还有洞。');
process.exitCode = allRed ? 0 : 1;
