import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectingShopKeys, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(path.join(SCRIPT_DIR, 'ensure-inquiry-rows.mjs')).href;
const { resolveTargetShops } = await import(MODULE_URL);

// 2026-10-07 晚用户口径：「要补齐销售一部的数据，二部先别动」。
// 这一组用例钉的就是那句口径 —— 默认范围从「登记表全量 13 家」收成「参与采集的 8 家」，
// 而不是反过来（先默认 13 家、再靠调用方记得收窄）。漂回去的症状很隐蔽：
// 每天往停采部门那 5 行写两列、它们永远空着，而表上看不出这是「被动的」。
const REGISTERED = ['甲淘宝', '乙天猫', '丙淘宝', '丁天猫', '戊淘宝', 'A龙头店', 'B龙头店', 'C淘宝'];
const COLLECTING = ['甲淘宝', '乙天猫', '丙淘宝', '丁天猫', '戊淘宝'];
const DEPS = { registered: REGISTERED, collecting: COLLECTING };

test('resolveTargetShops：不给 --shops 时默认＝参与采集的名单（不是登记表全量）', () => {
  assert.deepEqual(resolveTargetShops(null, DEPS), COLLECTING);
  assert.deepEqual(resolveTargetShops(undefined, DEPS), COLLECTING);
  // 空数组与「没给」同义（解析层已经把 `--shops ''` 拒掉了，这里只是不给出第二套口径）。
  assert.deepEqual(resolveTargetShops([], DEPS), COLLECTING);
});

test('resolveTargetShops：默认名单里一个停采店都不含（这条就是「二部先别动」）', () => {
  const got = resolveTargetShops(null, DEPS);
  const notCollecting = REGISTERED.filter((key) => !COLLECTING.includes(key));
  assert.equal(notCollecting.length, 3, '样本自身要保证「有停采店」这件事成立');
  for (const key of notCollecting) {
    assert.equal(got.includes(key), false, `${key} 是停采店，不该出现在默认范围里`);
  }
  assert.equal(got.length, COLLECTING.length);
});

test('resolveTargetShops：显式 --shops 仍能点名停采店（保留临时补的能力，不是封禁）', () => {
  assert.deepEqual(resolveTargetShops(['A龙头店'], DEPS), ['A龙头店']);
  assert.deepEqual(resolveTargetShops(['A龙头店', '甲淘宝'], DEPS), ['甲淘宝', 'A龙头店']);
});

test('resolveTargetShops：产物顺序按登记表，不按命令行给的顺序', () => {
  assert.deepEqual(resolveTargetShops(['戊淘宝', '甲淘宝', '丙淘宝'], DEPS),
    ['甲淘宝', '丙淘宝', '戊淘宝']);
});

test('resolveTargetShops：未登记的店名 fail-closed，且错误里点名是哪几家', () => {
  assert.throws(() => resolveTargetShops(['甲淘宝', '查无此店'], DEPS), (error) => {
    assert.match(error.message, /查无此店/u);
    assert.match(error.message, /未登记/u);
    // 「被点名未登记的」只该有 查无此店 —— 甲淘宝 是已登记的，不能被这句误伤。
    // （注意别整串断言：错误文案后半段本来就带一份「已登记：…」清单。）
    const named = error.message.split('；已登记')[0];
    assert.doesNotMatch(named, /甲淘宝/u);
    return true;
  });
});

test('真实登记表：默认范围＝collectingShopKeys()，且严格小于 shopBrowserKeys()', () => {
  const registered = shopBrowserKeys();
  const collecting = collectingShopKeys();
  assert.deepEqual(resolveTargetShops(null), collecting);
  assert.ok(collecting.length < registered.length,
    '当前销售2部仍在停采；若某天两部都要采，这两条口径会相等 —— 那时这条断言要跟着改口径，不能默默放宽');
  for (const key of registered.filter((k) => !collecting.includes(k))) {
    assert.equal(resolveTargetShops(null).includes(key), false, `${key} 不该在默认范围里`);
  }
});

test('源码级：默认口径来自 collectingShopKeys，且没退回「不给参数就铺登记表全量」', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(path.join(SCRIPT_DIR, 'ensure-inquiry-rows.mjs'), 'utf8');
  assert.match(source, /collectingShopKeys/u, '默认范围必须来自 collectingShopKeys()');
  // 反面：不许出现「return registered」这种把默认写成登记表全量的写法。
  assert.doesNotMatch(source, /if\s*\(!shops[^)]*\)\s*return\s+\[?\.{0,3}registered/u,
    '默认分支不许回落到 registered（登记表全量）');
});
