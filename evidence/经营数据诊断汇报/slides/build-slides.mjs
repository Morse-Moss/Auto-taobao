#!/usr/bin/env node
// slides/src/*.slide（人手写的自然文案）→ slides/*.slide（可编译产物）
//
// 为什么需要这一步（全部为 2026-10-19 实测结论）：
//   slidep 的 DSL 编译器对「纯 JSX 文本节点」有一套会静默丢字的规则：
//     1) 含数字的片段整段丢弃（"近 30 天" → "近"）；
//     2) 一批符号整段丢弃：/ → · × ≤ ≥ – — ＋ ÷ 等；
//     3) 紧贴 CJK 的空格被删掉（"洗手盆 · 208 个" → "洗手盆·208个"）；
//     4) 两个拉丁词之间的空格保留（"Paola Lenti" 完好）。
//   包进 {'...'} 表达式后，符号与数字都能原样存活；但 {' '} 保不住空格（实测 T1/T2/T3）。
//
//   所以本转换器的策略是：
//     - 数字片段（含千分位/百分号/连字符）→ {'...'}
//     - 一切非中日韩文字、非字母的字符 → {'...'}
//     - 空格：只有夹在两个「安全字符」之间才保留（编译器会自行决定去留）；
//       紧贴被包裹内容的空格直接丢掉——中文排版本就习惯数字旁不加空格。
//     - CJK 文字与拉丁字母保持纯文本，内部的拉丁-拉丁空格不受影响。
//
//   这一步是硬门禁，不是美化：不包就会静默丢字，而 lint 不会报错。
//
// 只改 JSX 文本节点（> 与 < 之间、且不含 { } 的内容）；
// style={{...}} / data={[...]} / src="..." / name='...' 一律不碰。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');

// 可以原样留在纯文本里的字符：CJK 表意文字、CJK 标点、全角形式、拉丁字母
const SAFE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefA-Za-z]/;
// 数字片段：数字开头，后跟小数点/千分位/百分号/连字符
const NUMTAIL = /[0-9.,:%-]/;

// JSX 文本节点：> 与 < 之间，且不含 < > { }
const TEXT_NODE = />([^<>{}]+)</g;

function transform(text) {
    let out = '';
    let buf = '';
    const flush = () => { if (buf) { out += buf; buf = ''; } };
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (SAFE.test(ch)) { buf += ch; i++; continue; }
        // 一切空白（空格/制表/换行）按同一规则处理：后面跟着「要被包裹的内容」
        // 或已经到了文本结尾 → 直接丢；否则归一成单个空格留在安全缓冲里。
        if (/\s/.test(ch)) {
            const next = text[i + 1];
            if (next === undefined || !SAFE.test(next)) { i++; continue; }
            buf += ' '; i++; continue;
        }
        if (/[0-9]/.test(ch)) {
            let tok = '';
            while (i < text.length && NUMTAIL.test(text[i])) { tok += text[i]; i++; }
            flush(); out += `{'${tok}'}`; continue;
        }
        flush(); out += `{'${ch}'}`; i++;
    }
    flush();
    return out;
}

let changed = 0;
for (const f of readdirSync(SRC).filter((x) => /^\d{2}\.slide$/.test(x)).sort()) {
    const raw = readFileSync(join(SRC, f), 'utf8');
    const built = raw.replace(TEXT_NODE, (_m, text) => `>${transform(text)}<`);
    if (built !== raw) changed++;
    writeFileSync(join(here, f), built, 'utf8');
}
console.log(`build-slides: ${changed} 个文件发生包裹改写`);
