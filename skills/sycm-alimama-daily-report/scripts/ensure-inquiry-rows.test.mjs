import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectingShopKeys, SHOPS_NOT_COLLECTING_YET, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';

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

test('真实登记表：默认范围＝collectingShopKeys()，且与「待收集」表互补（不重不漏）', () => {
  const registered = shopBrowserKeys();
  const collecting = collectingShopKeys();
  assert.deepEqual(resolveTargetShops(null), collecting);
  // 这条断言原来写的是 `collecting.length < registered.length`（2026-10-16 16:22「销售二部先暂停」）。
  // 2026-10-26 五家换号重登、用户指令恢复采集 ⇒ 待收集表清空，两支名单**逐字相同**，
  // 严格小于不再成立。所以判据换成「差集恰好由待收集表解释」：
  //   · 表空 ⇒ 退化成等值断言（此时若仍有店没进默认范围，说明它掉缝里了）；
  //   · 表非空 ⇒ 仍拦「有店既不在采集名单、也不在任何名单里」。
  // 这不是放宽：原来的 `<` 只证明「有停采店」，证明不了「少的那几家正好是待收集的那几家」。
  const missing = registered.filter((key) => !collecting.includes(key));
  assert.deepEqual([...missing].sort(),
    SHOPS_NOT_COLLECTING_YET.filter((key) => registered.includes(key)).sort(),
    '登记表里没进默认范围的店，必须恰好是 SHOPS_NOT_COLLECTING_YET 里那几家 —— 否则有店掉进缝里');
  for (const key of collecting) {
    assert.equal(resolveTargetShops(null).includes(key), true, `${key} 在采集名单里，默认范围必须包含它`);
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
