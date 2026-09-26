import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  RUNTIME_EXTRA_DIRS,
  RUNTIME_OWN_INVOCATION_DIRS,
  auditRuntimeTestDirs,
  discoverRuntimeTests,
} from '../scripts/test-suite-discovery.mjs';

// 这条守的是「测试写了但没有任何套件跑它」。
// 本项目的 runtime 发现是平铺的：新加一个 `runtime/<x>/` 目录放测试，它不会被任何套件跑到，
// 而套件仍然是全绿的 —— 一个绿色的假象。所以 runtime/ 下每个含 .test.mjs 的目录，
// 必须被「平铺套件 / 额外纳入 / 自己的调用方式」三者之一认领。
test('every runtime subdirectory that holds tests is claimed by some suite', () => {
  const audit = auditRuntimeTestDirs();
  // 先自证扫描真的扫到了东西：空结果不许被读成「没问题」（见坑 33）。
  assert.ok(audit.found.length >= 2, `扫描没找到任何含测试的目录，audit 本身可能坏了：${JSON.stringify(audit.found)}`);
  assert.ok(audit.found.includes('runtime'));
  assert.ok(audit.found.includes('runtime/operator-console'));
  assert.ok(audit.found.includes('runtime/sop-runtime'));
  assert.deepEqual(audit.unclaimed, [], '这些目录里有测试，但没有任何套件会跑到它们');
  // 反向：登记表里写了、磁盘上却没有测试 —— 路径写错或测试被搬走，也是一次红灯。
  assert.deepEqual(audit.emptyClaims, [], '登记表里有这些目录，但它们实际上没有测试文件');
});

// 自带调用方式的目录必须给出理由，理由不能是空串（空理由等于没有理由）。
test('directories kept out of the flat suite carry a reason', () => {
  for (const entry of RUNTIME_OWN_INVOCATION_DIRS) {
    assert.match(entry.dir, /^runtime\/[\w.-]+$/u);
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length >= 8, `${entry.dir} 的理由太短或为空`);
  }
  // 两张表不许有交集：一个目录要么并入套件，要么走自己的调用方式。
  const extra = new Set(RUNTIME_EXTRA_DIRS);
  for (const entry of RUNTIME_OWN_INVOCATION_DIRS) assert.ok(!extra.has(entry.dir), `${entry.dir} 同时出现在两张表里`);
});

// 额外纳入的目录必须真的存在且有测试 —— 路径写错会静默地一个文件都不加进来。
test('extra directories actually exist and contribute tests', () => {
  const files = discoverRuntimeTests();
  for (const dir of RUNTIME_EXTRA_DIRS) {
    const owned = files.filter((file) => file.startsWith(`${dir}/`));
    assert.ok(owned.length > 0, `${dir} 被声明纳入了套件，但一个测试文件都没被加进来`);
  }
  // 平铺的那一层也必须还在（别把 runtime/*.test.mjs 弄丢了）。
  assert.ok(files.some((file) => /^runtime\/[^/]+\.test\.mjs$/u.test(file)));
  // 重复文件会让同一个测试跑两遍，并且让覆盖率的账对不上。
  assert.equal(new Set(files).size, files.length);
});

// 只读探针：dry-run 解析出的清单必须与 discoverRuntimeTests 一致，
// 否则「文档/输出里说的清单」与「真的跑的东西」会分家。
test('the suite dry-run reports the same file list the discovery returns', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/run-test-suite.mjs', 'runtime', '--dry-run'], {
    // cwd 用**仓库根**（由本文件的位置推出来），不用 `process.cwd()` —— 后者取决于谁在哪跑测试，
    // 从别的目录跑时 `scripts/run-test-suite.mjs` 会找不到，而失败信息只是「清单对不上」。
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    // `stdio` 必须显式写成 stdin `'ignore'`（2026-09-26 补，同 CHANGELOG 1.7.1 那一族）：
    // 不写时默认「三根都是管道」，而**本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」
    // 直接回 EBUSY**（`status=null`）⇒ 这一条会以 `null !== 0` **假红**，
    // 把「宿主掐断了子进程」报成「清单不一致」。1.7.1 修了链上三处生产点与两个测试，**漏了这一处**。
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  assert.equal(result.status, 0, `error=${result.error?.message ?? 'none'}\n${result.stderr || result.stdout}`);
  const listed = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.test.mjs'));
  assert.deepEqual(listed.sort(), discoverRuntimeTests());
});
