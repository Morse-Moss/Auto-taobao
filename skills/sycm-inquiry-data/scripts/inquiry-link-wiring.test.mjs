// 接线守卫：`collect-inquiry-report.mjs` 是否真的走**有界轮询**等 `link`（2026-10-21 加）。
//
// 病根同 download-entry-wiring.test.mjs：inquiry-link-poll.test.mjs 钉的是轮询函数本身
// （第 N 次读到就走、超时不抛），但 2026-10-20 网林家居那次假红是**采集脚本只读一次**
// —— 轮询函数写得再对，采集侧不调用照样假红。
// 判据是源码文本：一次性读取的旧写法不许回来，且必须 import 并调用 pollInquiryLink。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'collect-inquiry-report.mjs'), 'utf8');

test('import 了轮询函数（不是只 import 名字不调用）', () => {
  assert.match(
    source,
    /import\s*\{[^}]*pollInquiryLink[^}]*\}\s*from\s*'\.\/inquiry-core\.mjs'/s,
    '必须从 inquiry-core.mjs 导入 pollInquiryLink',
  );
  assert.match(source, /await\s+pollInquiryLink\s*\(/, '必须真的 await 调用 pollInquiryLink');
});

test('页面状态读取走轮询，不再一次性直接读', () => {
  // 旧写法：const state = await evalOn(...READ_PAGE_STATE...); 读完立刻判，读到空就抛。
  assert.match(source, /polled\s*=\s*await\s+pollInquiryLink/, '页面状态必须来自轮询结果');
  assert.match(source, /const\s+state\s*=\s*polled\.state/, '后续判据必须吃轮询回来的 state');
  assert.doesNotMatch(
    source,
    /const\s+state\s*=\s*await\s+evalOn\s*\(/,
    '不许退回「一次性 evalOn 读页面状态」——异步填充的 link 会读到空',
  );
});

test('轮询没读到 link 时把读次数带进报错', () => {
  // 失败时要能一眼看出「等了 N 次都没读到」还是「读到了但字段不对」。
  assert.match(source, /polled\.reads/, '报错里必须带上轮询次数');
});

test('身份校验对空状态安全（不许 TypeError 盖掉真原因）', () => {
  // 空对象时 state.shop 是 undefined，`state.shop.includes(...)` 会抛 TypeError，
  // 把「页面没读出来」变成一句 JS 报错 —— 那正是最难查的形态。
  assert.match(source, /String\(\s*state\.shop\s*\?\?\s*''\s*\)\.includes/, '身份校验必须先兜空');
});
