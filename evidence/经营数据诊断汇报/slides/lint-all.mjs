#!/usr/bin/env node
// 逐页 lint：调 slidep 引擎，打印每页 ok/diagnostics，任何一页有 error 就非零退出。
// 用法：node lint-all.mjs [--pptx <path>] [--pages=13]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@tencent/slidep/dist/index.js';

const argv = process.argv.slice(2);
const pptxIdx = argv.indexOf('--pptx');
const PPTX = pptxIdx >= 0 ? argv[pptxIdx + 1] : join(here, '..', '经营数据诊断汇报.pptx');
const pagesArg = argv.find((x) => /^--pages=\d+$/u.test(x));
const PAGES = pagesArg ? Number(pagesArg.split('=')[1]) : 13;

if (!existsSync(PPTX)) {
    console.error(`pptx 不存在：${PPTX}`);
    process.exit(1);
}

let bad = 0;
for (let i = 1; i <= PAGES; i++) {
    const f = join(here, `${String(i).padStart(2, '0')}.slide`);
    const tag = String(i).padStart(2, '0');
    try {
        const out = execFileSync(process.execPath, [ENTRY, 'lint', PPTX, '--dsl-file', f, '--page-index', String(i - 1)], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],   // 本机沙箱：stdin 继承会 EBUSY（项目内已多次踩到）
            windowsHide: true,
        });
        const json = JSON.parse(out.trim().split(/\r?\n/u).pop());
        const errs = (json.diagnostics ?? []).filter((d) => d.severity === 'error');
        if (!json.ok || errs.length) {
            bad++;
            console.log(`FAIL  ${tag}  ok=${json.ok}  ${errs.map((d) => `${d.ruleId}: ${d.message}`).join(' | ')}`);
        } else {
            console.log(`ok    ${tag}`);
        }
    } catch (e) {
        bad++;
        const msg = String(e.stdout ?? e.message).trim().split(/\r?\n/u).slice(-2).join(' ');
        console.log(`FAIL  ${tag}  ${msg}`);
    }
}
console.log(`\n共 ${PAGES} 页；失败 ${bad}`);
process.exit(bad ? 1 : 0);
