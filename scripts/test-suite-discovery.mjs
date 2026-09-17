// 测试发现与「哪个目录归哪个套件」的登记表。
//
// 为什么单独一个模块：run-test-suite.mjs 是主程序（import 就会执行），所以它的注册表
// 没法被测试直接断言。把发现逻辑放在这里之后，runtime 测试就能检查它 ——
// 于是「新加一个带测试的子目录、结果没有任何套件跑它」会变成一次红灯，而不是一次静默遗漏。
//
// 现状（2026-09-17）：listTestFiles 是**平铺**的（只扫一层）。runtime/ 下有 5 个自带测试的
// 子目录，其中 3 个有自己的调用方式、2 个（operator-console、isolated-proxy）纳入 runtime 套件。
// 下面三张表合起来必须恰好覆盖「runtime/ 下所有含 .test.mjs 的目录」，否则测试会红。
//
// 2026-09-17 变更：isolated-proxy 从「自己的调用方式」挪进 runtime 套件。原 reason 写的是
// 「探的是本机 CDP 代理/浏览器端口；本机没开那两个端口时它的结论没有意义」—— 这条早已失准：
// 它的 browser-discovery.test.mjs 全程 mock globalThis.fetch，不碰任何真实端口，纯离线。
// 一个失准的 reason 会让下一个加测试的人照着它抄（这条 reason 本身就是坑 38 的产物：
// 能力在生产者侧被删掉之后，理由文本还留在消费者侧）。

import { readdirSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// 平铺发现之外，额外纳入 runtime（与 unit:runtime）套件的子目录。
// 判据：纯离线（不碰 DB、不碰真实浏览器端口、不起外部进程）。
export const RUNTIME_EXTRA_DIRS = Object.freeze([
  'runtime/operator-console',
  'runtime/isolated-proxy',
]);

// 有自己的调用方式、因此不并入 runtime 平铺套件的子目录。
// `reason` 不是装饰：它要能回答「为什么不放进去」。放不出理由的目录，就该放进去。
export const RUNTIME_OWN_INVOCATION_DIRS = Object.freeze([
  {
    dir: 'runtime/durable',
    reason: '需要 Postgres 与子进程（集成层）；放进离线套件会让套件在没库的机器上变红',
  },
  {
    dir: 'runtime/sop-runtime',
    reason: '有文档化的独立调用方式（node --test "runtime/sop-runtime/*.test.mjs"），基线数字按字面量记在 PHASE-ARCHIVE.md，并进套件会改动那份账',
  },
  {
    dir: 'runtime/supervisor-agent',
    reason: '原型层：仓库内没有调用方，不在门禁内（见项目长期笔记「agent 两套」）',
  },
]);

export function listTestFiles(relativeDir, root = REPO_ROOT) {
  const absolute = path.join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(relativeDir, name).replaceAll('\\', '/'));
}

export function discoverRuntimeTests(root = REPO_ROOT) {
  const files = listTestFiles('runtime', root);
  for (const dir of RUNTIME_EXTRA_DIRS) files.push(...listTestFiles(dir, root));
  return files.sort();
}

export function discoverSkillTests(root = REPO_ROOT) {
  const files = [];
  let skills;
  try {
    skills = readdirSync(path.join(root, 'skills'));
  } catch {
    return files;
  }
  for (const skill of skills) {
    for (const subdir of ['tests', 'scripts']) {
      files.push(...listTestFiles(path.join('skills', skill, subdir), root));
    }
  }
  return files.sort();
}

// 「有没有人跑它」的自检。返回两张清单：
//   unclaimed   —— 磁盘上有测试、但没有任何套件认领它的目录（测试写了没人跑）
//   emptyClaims —— 登记表里写了、但磁盘上没有测试的目录（路径写错，或者测试被搬走了）
//
// 认领分两种范围，这个区分是必须的：
//   exact —— 平铺发现只覆盖 `runtime/` **这一层**。如果把它当成前缀，那么
//            `runtime/tmp-任何东西/` 都会被它「认领」，守卫就永远不会红（突变验证发现的）。
//   tree  —— 额外纳入与自己有调用方式的目录按树认领：认领 `runtime/supervisor-agent`
//            就等于认领它下面所有层级（比如 `runtime/supervisor-agent/proposal`），
//            不必为每一层再登记一次。
// 判通的标准是两张清单都空。空结果必须能被读成「真的没问题」而不是「没扫到」（见坑 33）：
// 所以 found 一并返回，调用方可以断言它非空。
export function auditRuntimeTestDirs(root = REPO_ROOT) {
  const claims = new Map();
  for (const file of listTestFiles('runtime', root)) claims.set('runtime', { how: 'flat runtime suite', scope: 'exact' });
  for (const dir of RUNTIME_EXTRA_DIRS) claims.set(dir, { how: 'runtime suite (extra dir)', scope: 'tree' });
  for (const entry of RUNTIME_OWN_INVOCATION_DIRS) claims.set(entry.dir, { how: 'own invocation', scope: 'tree', reason: entry.reason });
  const isClaimed = (dir) => [...claims.entries()].some(([claim, meta]) => (
    meta.scope === 'exact' ? dir === claim : (dir === claim || dir.startsWith(`${claim}/`))
  ));
  const covered = (claim, dirs) => {
    const meta = claims.get(claim);
    return dirs.some((dir) => (meta.scope === 'exact' ? dir === claim : (dir === claim || dir.startsWith(`${claim}/`))));
  };

  const found = new Set();
  const walk = (absolute, relative) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(absolute, entry.name), `${relative}/${entry.name}`);
        continue;
      }
      if (entry.name.endsWith('.test.mjs')) found.add(relative);
    }
  };
  walk(path.join(root, 'runtime'), 'runtime');

  const foundList = [...found].sort();
  return {
    claimed: [...claims.keys()].sort(),
    found: foundList,
    unclaimed: foundList.filter((dir) => !isClaimed(dir)).sort(),
    emptyClaims: [...claims.keys()].filter((claim) => !covered(claim, foundList)).sort(),
  };
}
