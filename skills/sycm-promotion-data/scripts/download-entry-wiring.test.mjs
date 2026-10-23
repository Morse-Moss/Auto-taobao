// 接线守卫：`collect-product-report.mjs` 页面侧探针是否真的**按宽判据**取候选（2026-10-21 加）。
//
// 为什么需要这一层：download-entry-core.test.mjs 钉的是「拿到候选之后怎么排、怎么过滤」，
// 但 2026-10-20 里可林天猫那次假红的病根不在排序，而在**页面侧根本没把候选取回来** ——
// 探针里写着 `children.length===0 && textContent==='下载'` 这种窄条件，按钮文字一包进 span
// 就取回空数组，Node 侧再正确也无从排起。
//
// 本项目已发作三次的同一条教训：「用例全绿 + 突变过了」不等于接线接上了。
// 排序层突变确实会红（已验），但把探针退回窄判据，排序层用例一条都不会红 —— 就是这里要堵的洞。
// 所以这条守卫不测行为，只钉**调用侧到底传了什么判据**（源码文本级断言）。
//
// 它读文件、不连浏览器 ⇒ 快、离线、可在任何机器上跑；代价是它只防「退回旧写法」，
// 不证明新写法在真实页面里一定取得到 —— 后者只能靠真跑留证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'collect-product-report.mjs'), 'utf8');

test('页面侧取候选用「包含下载」，不用「恰好等于下载」', () => {
  // 真实写法：filter(x=>(x.textContent||'').includes('下载'))
  assert.match(
    source,
    /filter\(\s*x\s*=>\s*\(\s*x\.textContent\s*\|\|\s*''\s*\)\.includes\(\s*'下载'\s*\)\s*\)/,
    '探针必须用 includes 取候选；退回 === 会把包了 span 的按钮漏掉（2026-10-20 里可林天猫假红的原因）',
  );
});

test('页面侧取候选不再要求叶子节点或宽度', () => {
  // 旧判据三件套：children.length===0 / 恰好相等 / width>0。放宽后前两条不许回来。
  assert.doesNotMatch(
    source,
    /filter\([^)]*children\.length\s*===\s*0[^)]*下载/,
    '取候选时不许再要求叶子节点：antd 按钮的文字常在 span 里',
  );
  assert.doesNotMatch(
    source,
    /\.trim\(\)\s*===\s*'下载'/,
    '取候选时不许用「恰好等于下载」当门槛；精确相等只用于排序（rank 在 download-entry-core.mjs）',
  );
});

test('候选排序与命中判定走抽出来的纯函数与浏览器复核', () => {
  // 排序必须在 Node 侧（可做离线用例 + 突变），命中必须问浏览器 elementFromPoint。
  assert.match(source, /rankDownloadCandidates\s*\(/, '排序必须调用 download-entry-core.mjs 的 rankDownloadCandidates');
  assert.match(source, /describeDownloadFailure\s*\(/, '失败时必须用 describeDownloadFailure 说清「看到了什么」');
  assert.match(source, /elementFromPoint\s*\(/, '命中判定必须是浏览器的 elementFromPoint，不许几何推算');
});

test('失败信息不再是同一句符号', () => {
  // 旧版所有失败都报「商品报表任务下载入口不可见」；新版要带上候选数/看到了什么。
  assert.match(
    source,
    /商品报表下载入口不可用/,
    '失败必须报「不可用 + 原因 + 看到了什么」，不能退回一句「入口不可见」',
  );
});
