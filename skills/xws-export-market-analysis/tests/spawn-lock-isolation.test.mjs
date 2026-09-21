// 守卫：本技能所有「把 CLI 当子进程跑」的用例，都必须给子进程指一把**用例私有**的市场分析锁。
//
// 为什么需要一条扫源码的判据：锁的默认路径是**机器级**的
// （`os.tmpdir()/xws-runs/.market-analysis.lock`，只有 `XWS_MARKET_ANALYSIS_LOCK` 能改它，
// `XWS_RUNTIME_DIR` 不影响），而子进程会自己去抢那把锁 ⇒ 漏掉一处**不会在本文件的用例里报错**，
// 只会在「同一台机器上并行跑两次套件」时以 BUSY 的形式炸出来
// （`another Xiaowangshen market-analysis run is already active`）。那时现象与改动点隔着好几层，
// 归因成本极高（2026-09-21 实际发生过一次）。所以这里直接扫源码，不靠人记得。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const prepareFlow = path.join(testsDir, "prepare-flow.test.mjs");

// 「裸 env 对象里直接写 XWS_RUNTIME_DIR」＝漏。只有经过 cliEnv() 才允许。
const RAW_ENV = /\{\s*env:\s*\{[^}]*XWS_RUNTIME_DIR[^}]*\}/gu;

test("每个 CLI 子进程都拿到用例私有的市场分析锁（漏一处只会在并行跑套件时炸）", async () => {
  const source = await readFile(prepareFlow, "utf8");

  const raw = source.match(RAW_ENV) ?? [];
  assert.deepEqual(raw, [],
    `这些 env 没有走 cliEnv()，会落回机器级锁、与并行的运行互撞：\n${raw.join("\n")}`);

  const spawned = (source.match(/\bspawn\(/gu) ?? []).length;
  const viaHelper = (source.match(/env: cliEnv\(/gu) ?? []).length;
  // 先自证判据还有效：一个 spawn( 都找不到，说明写法变了、这条断言已经形同虚设。
  assert.ok(spawned > 0, "prepare-flow.test.mjs 里找不到 spawn( —— 判据本身失效了，要同步更新");
  assert.equal(viaHelper, spawned, `spawn( 有 ${spawned} 处，但只有 ${viaHelper} 处走了 cliEnv()`);

  // 防呆：cliEnv() 本身必须真的设锁，否则它只是给 env 改了个名字。
  const helper = /function cliEnv\([^)]*\)\s*\{[\s\S]*?\n\}/u.exec(source);
  assert.ok(helper, "找不到 cliEnv() 的定义");
  assert.match(helper[0], /XWS_MARKET_ANALYSIS_LOCK/u, "cliEnv() 必须设 XWS_MARKET_ANALYSIS_LOCK");
  assert.match(helper[0], /XWS_RUNTIME_DIR/u, "cliEnv() 必须保留 XWS_RUNTIME_DIR（用例的产物目录）");
});

test("用了 XWS_RUNTIME_DIR 的测试文件都会处理市场分析锁", async () => {
  const files = (await readdir(testsDir)).filter((name) => name.endsWith(".test.mjs"));
  const offenders = [];
  for (const name of files) {
    const source = await readFile(path.join(testsDir, name), "utf8");
    if (!source.includes("XWS_RUNTIME_DIR")) continue;
    if (!source.includes("XWS_MARKET_ANALYSIS_LOCK")) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `这些文件用了 XWS_RUNTIME_DIR 却没有处理锁隔离：${offenders.join(", ")}`);
});
