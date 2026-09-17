// 部署单的「引用还活着」守卫。
//
// 为什么需要它：部署单是给人在**另一台机器**上照着做的。它一旦引用了不存在的文件
//（脚本被删、被改名、目录重组），现场的表现是照着抄、然后撞上「找不到文件」——
// 而文档本身看起来毫无问题。这与坑 31（每步成功≠结果对）是同一种失效模式，
// 只是载体从代码换成了文档。
//
// 判据来源：**部署单自身**。这里不抄一份「应该有哪几条路径」的名单 ——
// 抄一份就等于让文档和测试互相成为第二真相源，两边都要同步。
//
// 提取规则与它的理由：
//   1. 必须**以仓库顶层目录开头**（runtime/ skills/ scripts/ docs/ db/ evidence/ …）。
//      理由：文档里有按文件名引用的「同目录文档」（如 SYSTEM-OVERVIEW-AND-DEPLOYMENT.md），
//      那不是相对仓库根的路径，算进来只会误报。
//   2. 必须**带已知扩展名** —— 带扩展名的是文件，能直接判存在性。
//      不带扩展名的目录引用（runtime/operator-console 这类）不纳入：目录改名的概率低，
//      而为它们补一套「排除已被文件覆盖的前缀」的逻辑，会把守卫做复杂且更难信。
//   3. 排除占位与通配（`evidence/daily-report-<日期>/`、`runtime/sop-runtime/*.test.mjs`）。
//      一个总在喊「找不到」的守卫，最后一定会被无视。
//
// 注意：命令既可能写在反引号里，也可能写在 ``` 代码块里（§1.3 的复现命令就是后者），
// 所以**不能**只在反引号内匹配 —— 第一版就是这么写的，结果只解析出 2 个，漏掉了代码块。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../scripts/test-suite-discovery.mjs';

const RUNBOOK = path.join(REPO_ROOT, 'docs', 'ops', 'DEPLOYMENT-RUNBOOK.md');

const TOP_DIRS = 'runtime|skills|scripts|docs|db|evidence|agent-runtime|supervisor-agent';
const PATH_RE = new RegExp(
  `(?:${TOP_DIRS})/[A-Za-z0-9_./-]*\\.(?:mjs|json|md|ya?ml|py|sql|cjs|txt)`,
  'gu',
);

// 2026-09-17 实测：部署单里有 4 个文件路径引用。
// 下限设 3（比实测低一格）而不是恰好 4：合法地删掉一条命令不该立刻炸测试，
// 但提取逻辑（正则 / 文档结构）一旦失效必须立刻红。
// 判据要能被读成「真的没问题」，而不是「没扫到」（见项目笔记坑 33）。
const MIN_REFERENCES = 3;

test('部署单引用的仓库内文件都还存在', () => {
  assert.ok(existsSync(RUNBOOK), `找不到部署单：${RUNBOOK}`);

  const text = readFileSync(RUNBOOK, 'utf8');
  const referenced = [...new Set([...text.matchAll(PATH_RE)].map((m) => m[0]))].sort();

  assert.ok(
    referenced.length >= MIN_REFERENCES,
    `从部署单里只解析出 ${referenced.length} 个文件路径引用（下限 ${MIN_REFERENCES}）：`
      + `${JSON.stringify(referenced)} —— 提取逻辑可能坏了，或文档的验证命令被删掉了`,
  );

  const missing = referenced.filter((rel) => !existsSync(path.join(REPO_ROOT, rel)));
  assert.deepEqual(
    missing,
    [],
    '部署单引用了不存在的路径 —— 文件被删/改名了，或者文档写错了。现场照着做会直接撞上「找不到文件」',
  );
});
