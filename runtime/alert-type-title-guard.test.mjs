// 全仓告警 type 的标题守卫（2026-10-13 统一预警机制，任务 #3）。
//
// 由来：`runtime/xws-sku-auth-preflight.test.mjs` 里原本有一条「预检能发出的每个 type
// 都要有人话标题」的判据 —— 它只覆盖 XWS_* 那七个。统一预警机制把 type 从 7 个扩到
// 21 个（四条主流程 + 登录链 + 通用表旧项），只查一端就会漏另一端，而漏了的症状是
// **静默的**：渲染成「【需要处理】DAILY_ROUND_FAILED」，运营收到一行机器词，
// 日志里一个字都不报。
//
// 这道判据做三件事：
//   ① 扫源码里所有 `type: 'XXX'` 字面量 ⇒ 每个都必须在闭集里（告警）或豁免表里（非告警）；
//   ② `title: 'table'` 的每个 type ⇒ `TITLE_BY_TYPE` 里真有一条人话，且不是大写标识；
//   ③ `title: 'explicit'` 的每个 type ⇒ 发出它的那个文件里同一处有 `title:` 且带【】
//      （代理判据；真正的标题断言在各链自己的用例里）。

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ALERT_TYPES, NON_ALERT_TYPES } from './alert-copy.mjs';
import { TITLE_BY_TYPE } from './notify-feishu-core.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['runtime', 'scripts', 'skills'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * 一行的 `type:` 后面可能跟着三元（`ok ? 'A' : 'B'`）或兜底（`text(x) || 'ROUND'`）⇒
 * 只取**值那一侧**的字面量：三元取最后一个 `?` 之后，`||` 兜底整段砍掉。
 * 动态值（`byStatus.type`）本身扫不到 —— 那是 sop-runtime 通用策略层的形态，
 * 由它自己的用例（round-notify-policy.test.mjs）覆盖，不在这道静态判据里。
 */
function typeLiteralsOf(line) {
  const match = /^\s*type:\s*(.+)$/u.exec(line);
  if (!match) return [];
  let value = match[1];
  const question = value.lastIndexOf('?');
  if (question >= 0) value = value.slice(question + 1);
  const fallback = value.indexOf('||');
  if (fallback >= 0) value = value.slice(0, fallback);
  return [...value.matchAll(/'([A-Z][A-Z0-9_]{2,})'/gu)].map((m) => m[1]);
}

const files = SCAN_DIRS.flatMap((dir) => walk(path.join(REPO_ROOT, dir)))
  .filter((file) => !file.endsWith('.test.mjs'));
const hits = [];
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8');
  source.split(/\r?\n/u).forEach((line, index) => {
    for (const type of typeLiteralsOf(line)) hits.push({ type, file: rel, line: index + 1 });
  });
}

test('扫到的每个 type 字面量都已登记（告警）或已豁免（非告警）', () => {
  assert.ok(hits.length >= 15, `扫描范围不对：只扫到 ${hits.length} 个 type 字面量（判据本身可能失效了）`);
  const unknown = hits.filter((hit) => !ALERT_TYPES[hit.type] && !NON_ALERT_TYPES[hit.type]);
  assert.deepEqual(unknown.map((hit) => `${hit.file}:${hit.line} → ${hit.type}`), [],
    '出现了未登记的 type —— 新告警类型必须在 runtime/alert-copy.mjs 的 ALERT_TYPES 里登记'
    + '（写清标题来自通用表还是调用方显式给、收信人是谁），否则它的标题没人管');
});

test('闭集里每个「标题走通用表」的 type 都有人话标题', () => {
  for (const [type, entry] of Object.entries(ALERT_TYPES)) {
    if (entry.title !== 'table') continue;
    const title = TITLE_BY_TYPE[type];
    assert.ok(title, `${type} 登记为 table，但 TITLE_BY_TYPE 里没有它 ⇒ 漏标题`);
    assert.doesNotMatch(title, /^[A-Z_]+$/u, `${type} 的兜底标题本身还是大写标识`);
    assert.ok(title.length >= 4, `${type} 的标题太短（${title}）—— 不像一句能读的话`);
  }
});

test('闭集里每个「调用方显式给标题」的 type，发出它的文件里都带【】流程名', () => {
  // 代理判据（文件级）：发出这个 type 的文件里必须 ① 有 `title:` 键、② 有【】流程名。
  // 它拦不住「标题给了但写错」—— 那由各链自己的用例拦（它们断言完整标题串），
  // 也拦不住「流程名在变量里、标题模板只拼变量」（hold-and-resume-plan 正是这个形态，
  // 【】住在 noticeLabelsForWorkflow 的 prefix 上）。它拦的是两类静默故障：
  // 整个对象忘了给 title ⇒ 渲染出机读码；文件里一个【】都没有 ⇒ 这批告警没有流程名。
  //
  // `derived: true` 的 type 例外：标题派生自**原来那条**告警的标题（`已恢复：<原标题>`），
  // 流程名跟着原标题走 —— 判据换成「文件里必须引用源告警的 title」。
  const explicitTypes = Object.entries(ALERT_TYPES).filter(([, entry]) => entry.title === 'explicit');
  assert.ok(explicitTypes.length >= 9, `显式标题的 type 只有 ${explicitTypes.length} 个 —— 判据范围不对`);
  for (const [type, entry] of explicitTypes) {
    const emitters = hits.filter((hit) => hit.type === type);
    assert.ok(emitters.length >= 1, `${type} 登记为 explicit，但源码里扫不到它 ⇒ 登记表与实现漂了`);
    for (const hit of emitters) {
      const source = readFileSync(path.join(REPO_ROOT, hit.file), 'utf8');
      assert.match(source, /title:/u, `${hit.file} 发出 ${type} 却没有 title 键（${entry.note}）`);
      if (/【[^】]+】/u.test(source)) continue; // 文件里自己有流程名 ⇒ 通过
      if (entry.derived) {
        assert.match(source, /(openAlert|previousTitle)\?*\.?title/u,
          `${hit.file} 的 ${type} 登记为「标题派生」，但文件里既没有【】流程名、也没有引用源告警的 title（${entry.note}）`);
        continue;
      }
      assert.match(source, /【[^】]+】/u,
        `${hit.file} 发出 ${type}，但整个文件里没有【】流程名（${entry.note}）—— `
        + '收信人第一眼必须看到是哪条流程的事');
    }
  }
});

test('通用标题表本身没有孤儿（表里有、闭集里没有 ⇒ 那次统一漏了一端）', () => {
  const orphans = Object.keys(TITLE_BY_TYPE).filter((type) => !ALERT_TYPES[type]);
  assert.deepEqual(orphans, [], 'TITLE_BY_TYPE 里出现了未登记的 type —— 两处登记必须同一次改完');
});

test('非告警豁免表里没有混进真告警（豁免表越长，这道判据越哑）', () => {
  for (const [type, note] of Object.entries(NON_ALERT_TYPES)) {
    assert.ok(note.length >= 6, `${type} 的豁免理由太短 —— 写清它是什么，别写成「其它」`);
    assert.equal(ALERT_TYPES[type], undefined, `${type} 同时在告警闭集和豁免表里`);
  }
  assert.ok(Object.keys(NON_ALERT_TYPES).length <= 8, '豁免表超过 8 条就该重新分类，而不是继续放行');
});

// 目录存在性：扫描根目录少了一个 ⇒ hits 变少 ⇒ 上面第一条会红。这里再钉一次形状。
test('扫描范围覆盖三个源码根', () => {
  for (const dir of SCAN_DIRS) {
    assert.equal(statSync(path.join(REPO_ROOT, dir)).isDirectory(), true, `${dir} 不在仓库里了`);
  }
});
