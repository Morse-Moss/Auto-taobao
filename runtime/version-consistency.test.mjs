// 版本号一致性守卫（2026-09-23 建，技术债 E1）。
//
// 治的病：**同一个事实写在三处，然后它们开始不一致。**
// 本仓库此前三处都没有版本号（无 git tag、无 VERSION、package.json 无 version），
// 于是「这是哪一版跑出来的」这个问题在事后永远答不上来 —— 而诊断包规格第一条就要它
// （docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md P0-6）、架构提案 §4.3 也要它。
// 现在造了唯一来源，就要有人守着它别分裂。
//
// 守什么：
//   1) `VERSION` 本身可解析、且**只有一行**（多行会让「到底哪个是版本」重新变成判断题）；
//   2) `package.json` 的 `version` 与它逐字一致；
//   3) `CHANGELOG.md` 的**第一条**标题与它逐字一致，且按版本号**严格递减**排列 ——
//      防的是「新版本顺手追加到文件末尾」这种最常见的写错法；
//   4) 非法格式当场被拒（`v1.0.0` / `1.0` / 空 / 多行）—— 否则 `1.0.0` 与 `1.0`
//      会在字符串比较里变成两个不同的东西；
//   5) 读不到文件时**抛错而不是回落 `unknown`**（这是 version.mjs 的第一条口径，
//      这里把它钉住：一个写着「版本：unknown」的诊断包会让人以为读过了）。
//
// 它**不**做的事：不去比较 git tag。tag 是发布动作，本仓库还没有发布动作；
// 拿一个不存在的机制当判据，只会让守卫在第一天就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT, VERSION_FILE, parseVersion, readVersion, versionLine, versionLineSafe,
} from './version.mjs';

const readText = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** 语义化版本三段数的排序键。 */
function versionKey(value) {
  const [core] = value.split('-');
  return core.split('.').map((part) => Number(part));
}

function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

test('VERSION 存在、可解析、且只有一行', () => {
  const raw = readText(VERSION_FILE);
  const lines = raw.trim().split(/\r?\n/u);
  assert.equal(
    lines.length,
    1,
    `${VERSION_FILE} 里应当只有一行版本号，实际有 ${lines.length} 行 —— `
      + '多行会让「到底哪个是版本」重新变成判断题（要写说明请写进 CHANGELOG.md）',
  );
  const version = readVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/u, `当前版本号 ${version} 不是 x.y.z 形式`);
});

test('package.json 的 version 与 VERSION 逐字一致', () => {
  const pkg = JSON.parse(readText('package.json'));
  assert.equal(
    pkg.version,
    readVersion(),
    'package.json 的 version 与 VERSION 不一致。处置：以 VERSION 为唯一来源，'
      + '把 package.json 改过来（而不是反过来改 VERSION —— 那会让「唯一来源」失效）。',
  );
});

test('CHANGELOG.md 首条标题与 VERSION 一致，且版本号严格递减排列', () => {
  const text = readText('CHANGELOG.md');
  const headings = [...text.matchAll(/^##\s+\[([^\]]+)\]\s+-\s+(\S+)\s*$/gmu)]
    .map((m) => ({ version: m[1], date: m[2] }));

  assert.ok(headings.length > 0,
    'CHANGELOG.md 里一条 `## [x.y.z] - YYYY-MM-DD` 标题都没有 —— 要么文件被清空，要么格式变了');

  const version = readVersion();
  assert.equal(
    headings[0].version,
    version,
    `CHANGELOG.md 第一条写的是 ${headings[0].version}，而 VERSION 是 ${version}。`
      + '处置：新版本要**加在最上面**，且与 VERSION 逐字一致（代码与它同一次提交）。',
  );

  for (const { version: v, date } of headings) {
    assert.doesNotThrow(() => parseVersion(v), `CHANGELOG.md 里的版本号 ${v} 格式不对`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/u, `${v} 的日期 ${date} 不是 YYYY-MM-DD`);
  }

  const versions = headings.map((h) => h.version);
  assert.equal(new Set(versions).size, versions.length, `CHANGELOG.md 里有重复版本号：${versions.join('、')}`);
  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(
      compareVersions(versions[i - 1], versions[i]) > 0,
      `CHANGELOG.md 的版本顺序不对：${versions[i - 1]} 排在 ${versions[i]} 前面，`
        + '应当是新版本在上、旧版本在下',
    );
  }
});

test('parseVersion：接受合法写法，拒绝会让同一个版本变成两个字符串的写法', () => {
  // 合法：首尾空白与结尾换行是文件里的常态（写一行就是带换行）。
  assert.equal(parseVersion('1.0.0'), '1.0.0');
  assert.equal(parseVersion('  1.0.0\n'), '1.0.0');
  assert.equal(parseVersion('1.0.0-rc.1'), '1.0.0-rc.1');

  // 非法：每一条都对应一种真会发生的写错法。
  for (const bad of ['', '   ', 'v1.0.0', '1.0', '1.0.0.0', '1.0.0 ', 'VERSION', 'latest']) {
    if (bad === '1.0.0 ') continue; // 首尾空白会被 trim 掉，这是刻意允许的
    assert.throws(() => parseVersion(bad), new RegExp('版本号'), `${JSON.stringify(bad)} 应当被拒`);
  }
  assert.equal(parseVersion('1.0.0 '), '1.0.0', '首尾空白应当被规范化，而不是报错');
  assert.throws(() => parseVersion(null), /版本号/u);
  assert.throws(() => parseVersion(undefined), /版本号/u);
});

test('readVersion：读不到就抛错，绝不回落成 unknown', () => {
  assert.throws(
    () => readVersion({ root: path.join(REPO_ROOT, 'tmp', '__not_a_dir__') }),
    /读不到版本号文件/u,
    '读不到文件时必须抛错 —— 回落 unknown 会让「版本：unknown」看起来像读过了',
  );
});

test('versionLine 与 versionLineSafe：前者准、后者活，两边措辞都不许掩盖失败', () => {
  const version = readVersion();
  assert.equal(versionLine(), `sycm-automation ${version}`);
  assert.equal(versionLine({ component: '日报链' }), `日报链 ${version}`);
  assert.equal(versionLineSafe(), `sycm-automation ${version}`);

  // 失手时：不抛错（长跑入口不该因为一行日志停摆），但**原因必须在同一行里**。
  const bad = { root: path.join(REPO_ROOT, 'tmp', '__not_a_dir__') };
  const line = versionLineSafe(bad);
  assert.match(line, /unknown/u);
  assert.match(line, /读不到版本号文件/u, 'unknown 后面必须跟着原因，否则它与静默回落没有区别');
  assert.throws(() => versionLine(bad), /读不到版本号文件/u, '要准的那个出口仍然必须抛错');
});
