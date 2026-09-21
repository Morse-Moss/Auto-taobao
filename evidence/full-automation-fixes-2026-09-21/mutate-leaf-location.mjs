// 突变验证：刚改的那两条断言（叶子模块的位置判据）能不能真的红、且点名到期望的那一条。
//
// 为什么非要验：这两条断言是**源码文本扫描**型判据，它红了不代表拦住了什么 ——
// 只有「改坏 → 它红 → 且红的是这一条」才算数。还原后必须 sha256 逐字节一致。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/Retire/sycm-automation';
const SCRIPT_DIR = path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts');
const DRIVER = path.join(SCRIPT_DIR, 'run-multi-shop-day.mjs');
const LEAF = path.join(SCRIPT_DIR, 'expected-pages.mjs');
const ALIAS = path.join(SCRIPT_DIR, 'expected-pages-alias.mjs');
const TEST = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const origDriver = fs.readFileSync(DRIVER, 'utf8');
const origSha = sha(DRIVER);

function run() {
  try {
    const out = execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const namedFails = (out) => [...out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1]);

const results = [];

// M1：叶子被搬到别处（正断言该红）；别名文件是真副本，保证驱动仍能加载，
//     否则整个测试文件在 import 阶段就崩、报不出「是哪一条判据拦下的」。
fs.copyFileSync(LEAF, ALIAS);
fs.writeFileSync(DRIVER, origDriver.replace("from './expected-pages.mjs'", "from './expected-pages-alias.mjs'"));
let r = run();
results.push({ mut: 'M1 驱动改成从 expected-pages-alias.mjs 取清单', exit: r.exit, fails: namedFails(r.out) });
fs.writeFileSync(DRIVER, origDriver);
fs.rmSync(ALIAS, { force: true });

// M2：源码里出现 runtime 侧的 specifier（负断言该红）。
//     用注释注入即可 —— 这条判据本来就是文本扫描，验的是它的机制在不在。
fs.writeFileSync(DRIVER, `${origDriver}\n// mutation probe: from '../../../runtime/expected-pages.mjs'\n`);
r = run();
results.push({ mut: 'M2 源码里出现 ../../../runtime/expected-pages.mjs 的 from 写法', exit: r.exit, fails: namedFails(r.out) });
fs.writeFileSync(DRIVER, origDriver);

// 还原自证：逐字节一致 + 别名文件确实没了
const restoredInPlace = sha(DRIVER) === origSha;
const aliasGone = !fs.existsSync(ALIAS);
console.log(JSON.stringify({ restoredInPlace, aliasGone, origSha, results }, null, 2));
