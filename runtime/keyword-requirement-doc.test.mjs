// 运营需求原文与现役公式的对齐守卫（2026-09-20 建）。
//
// 为什么需要它：运营最原始的需求脑图此前**不在仓库里**，导致每次确认 A/B/C 口径都只能从代码反推，
// 同一件事被反复拿出来问。把需求落成 docs/requirements/KEYWORD-PRIORITY-REQUIREMENT-ORIGINAL.md
// 只解决「有没有」。这份守卫解决「会不会又飘走」——它钉住两件最容易悄悄分叉的事：
//
//  1. 需求原话里的灰豚门槛（「话题浏览量达1000w」）与公式源码里的字面量（>=10000000）必须相等。
//     两处各写一份数字，正是这个项目一直在治的病；任何一边单独改都必须红。
//  2. §1 的逐字转写块必须完整保留。这条防的是**用代码去改需求原文**：实现变了就回去改转写、
//     让两边「看起来一致」，比不一致更坏——那等于把需求涂改成实现的样子，以后再也分不清谁是谁。
//     所以断言只认 §1 那个 ```text 代码块内的文字，不看正文里复述的部分。
//
// 它不做的事：不判断脑图与代码谁对（见该文件 §6，那是需要运营裁决的事，守卫不越权裁决）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs/requirements/KEYWORD-PRIORITY-REQUIREMENT-ORIGINAL.md');
const PNG_PATH = path.join(REPO_ROOT, 'docs/requirements/KEYWORD-PRIORITY-REQUIREMENT-ORIGINAL.png');
const FORMULA_PATH = path.join(REPO_ROOT, 'runtime/keyword-decision-formulas.mjs');

// §1 逐字转写块里必须逐字出现的原话（从截图上复核过的字面）。
const VERBATIM_LINES = Object.freeze([
  '优先级',
  '根据以上的数据分类，再评分出A/B/C级别',
  '优先级是判断落地执行的顺序，越高级越要快操作，例如一些新晋的关键词，趋势好，有需求，',
  '但是竞争还不大的时候，我们要迅速抓到这一波趋势',
  'A标准',
  '交易热度高',
  '搜索人气中或以上',
  '再去灰豚验证，话题浏览量达1000w',
  'B标准',
  '交易热度中',
  'C标准',
  '剩余不达标的',
  '品牌词',
]);

function transcriptionBlock() {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const block = doc.match(/## 1\. 逐字转写[\s\S]*?```text\n([\s\S]*?)```/u);
  assert.ok(block, '需求文件里找不到 §1 逐字转写的 ```text 代码块');
  return block[1];
}

test('需求原图与转写文件都在仓库里', () => {
  assert.equal(existsSync(PNG_PATH), true, `需求原图缺失：${PNG_PATH}`);
  assert.equal(existsSync(DOC_PATH), true, `需求转写文件缺失：${DOC_PATH}`);
});

test('转写文件里的灰豚门槛与公式源码的字面量相等', () => {
  const formulaSource = readFileSync(FORMULA_PATH, 'utf8');
  const matched = formulaSource.match(/>=(\d{7,})\s*,/u);
  assert.ok(matched, '公式源码里找不到灰豚浏览量的数值门槛（>= 七位以上数字）');
  const threshold = Number(matched[1]);
  assert.ok(Number.isInteger(threshold) && threshold > 0, `门槛解析异常：${matched[1]}`);

  const wan = threshold / 10000;
  assert.ok(Number.isInteger(wan), `门槛 ${threshold} 不是整数个「万」，「话题浏览量达Xw」这种写法对不上`);

  const doc = readFileSync(DOC_PATH, 'utf8');
  assert.ok(
    doc.includes(`话题浏览量达${wan}w`),
    `需求文件里没有原话「话题浏览量达${wan}w」（公式门槛 ${threshold}）`,
  );
  assert.ok(
    doc.includes(threshold.toLocaleString('en-US')),
    `需求文件里没有门槛的千分位写法 ${threshold.toLocaleString('en-US')}`,
  );
});

test('§1 逐字转写块逐字保留，没有被实现方向改写', () => {
  const block = transcriptionBlock();
  const missing = VERBATIM_LINES.filter((line) => !block.includes(line));
  assert.deepEqual(missing, [], `§1 转写块里缺失或被改写的原话：${missing.join(' / ')}`);
});
