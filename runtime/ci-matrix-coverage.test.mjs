import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { discoverSkillTests, REPO_ROOT } from '../scripts/test-suite-discovery.mjs';
import { walkMjs } from './arch-boundary-scan.mjs';

// 这条守的是「测试写了、套件能跑、但 CI 不跑它」。
//
// 为什么需要它（2026-09-17 实测发现）：`skills` 套件用目录发现，会自动认出
// `skills/<name>/{tests,scripts}` 下的新测试；而 `.github/workflows/ci.yml` 的矩阵是**手写的名单**。
// 于是「新加一个 skill、测试也齐、本地全绿」之后，CI 上它一个用例都不跑，而 CI 仍然是绿的
// —— 与 test-suite-discovery.test.mjs 守的是同一族问题（绿色假象），只是换了一层。
// 实测当时的缺口：sycm-alimama-daily-report / xws-faq-operator / xws-sku-collection 三个 skill
// 共 8 个测试文件在 CI 上零覆盖，而矩阵里的注释还写着「它们的测试在 runtime/ 里，fast-gate 已覆盖」
// —— 注释与事实不符，且没有任何东西会因此变红。
//
// 判据不是「抄一份名单进测试」（那会变成第二份真相），而是**从套件的发现结果推导期望值**：
// 谁有测试，谁就必须在 CI 矩阵里。规则改了只改一处。

const CI_FILE = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

// 从工作流里取矩阵的 skill 名单。刻意手写解析而不是引 YAML 库：
// 仓库的 Node 依赖里没有 YAML 解析器，为一条守卫加依赖不划算；
// 而且矩阵就这一种形状（`- skill: <name>`），解析不到时下面的非空自证会立刻红。
function skillsInCiMatrix() {
  const text = readFileSync(CI_FILE, 'utf8');
  return [...text.matchAll(/^\s*-\s*skill:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
}

// 谁「有测试」以套件的发现为准（与 `run-test-suite.mjs skills` 用的是同一个函数）。
function skillsOwningTests() {
  const set = new Set();
  for (const file of discoverSkillTests()) {
    const parts = file.split('/');
    if (parts[0] === 'skills' && parts.length > 1) set.add(parts[1]);
  }
  return set;
}

test('CI 矩阵里的 skill 名单与「自带测试的 skill」完全一致', () => {
  assert.ok(existsSync(CI_FILE), `找不到 CI 工作流：${CI_FILE}`);

  const listed = skillsInCiMatrix();
  const owned = skillsOwningTests();

  // 先自证两边都真的扫到了东西：空结果不许被读成「没问题」（见坑 33）。
  assert.ok(owned.size >= 5, `没发现任何自带测试的 skill，发现逻辑可能坏了：${[...owned].join(', ')}`);
  assert.ok(listed.length >= 5, `CI 矩阵里一个 skill 都没有，解析可能坏了：${JSON.stringify(listed)}`);

  // 名单内部不许重复：重复会让同一个 skill 跑两遍，覆盖率的账也对不上。
  assert.equal(new Set(listed).size, listed.length, `CI 矩阵里有重复条目：${listed.join(', ')}`);

  const missing = [...owned].filter((skill) => !listed.includes(skill)).sort();
  assert.deepEqual(
    missing,
    [],
    '这些 skill 自带测试、本地套件会跑，但 CI 矩阵里没有它们 —— 等于在 CI 上零覆盖',
  );

  const phantom = [...listed].filter((skill) => !owned.has(skill)).sort();
  assert.deepEqual(
    phantom,
    [],
    'CI 矩阵里有这些 skill，但它们名下没有任何被发现的测试文件 —— 要么名字写错，要么测试被搬走了',
  );
});

test('CI 两个 Job 都用 setup-python 的同一套 3.12 安装并验证依赖', () => {
  const text = readFileSync(CI_FILE, 'utf8').replace(/\r\n/g, '\n');
  const occurrences = (needle) => text.split(needle).length - 1;

  assert.equal(occurrences('- uses: actions/setup-python@'), 2,
    'fast-gate 与 skill-tests 都必须显式安装固定 Python；少了任一 job 就会继续吃 runner 镜像漂移');
  assert.equal(occurrences("python-version: '3.12'"), 2,
    '两个 Job 必须钉同一个 3.12，而不是 py -3 隐式选择最新版本');
  assert.equal(occurrences('run: python -m pip install --disable-pip-version-check -r requirements.txt'), 2,
    '依赖只能装进 setup-python 暴露的 python，不能再保留 py / python 双安装');
  assert.equal(occurrences('run: python -c "import sys, openpyxl, PIL, docx;'), 2,
    '安装后必须用同一命令真实导入 openpyxl / Pillow / python-docx，缺依赖要当场红');
  assert.equal(occurrences('py -3 -m pip install'), 0,
    '旧的 py -3 安装会绕过 PATH，选到 runner 上的另一套解释器');
  for (const name of ['PYTHON', 'SYCM_PYTHON', 'XWS_PYTHON']) {
    assert.ok(text.includes(`\n  ${name}: python\n`),
      `workflow 顶层必须给 ${name}=python，让支持覆盖的测试与安装使用同一解释器`);
  }
});

test('PYTHON 显式覆盖时不得再附加 Windows 启动器的 -3 参数', () => {
  const files = [...walkMjs('skills'), ...walkMjs('scripts')];
  const hits = [];
  for (const relative of files) {
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
    if (/process\.env\.PYTHON\s*(?:\|\||\?\?)\s*'py'/u.test(source)) hits.push({ relative, source });
  }

  // 当前同族清单：四个技能导入解析点 + check-fast + run-affected-tests。
  // 扫描是发现式而非抄六行白名单；以后新增同类调用点也会自动进入这道判据。
  assert.ok(hits.length >= 6, `PYTHON 调用点扫描失效：只找到 ${hits.length} 处，预期至少 6 处`);
  const offenders = [];
  for (const { relative, source } of hits) {
    const hasCommand = /const pythonCommand\s*=\s*process\.env\.PYTHON\s*\|\|\s*'py';/u.test(source);
    const hasPrefix = /const pythonPrefix\s*=\s*process\.env\.PYTHON\s*\?\s*\[\]\s*:\s*\['-3'\];/u.test(source);
    const prefixUses = [...source.matchAll(/\.\.\.pythonPrefix/gu)].length;
    if (!hasCommand || !hasPrefix || prefixUses < 1 || /spawnSync\(\s*process\.env\.PYTHON/u.test(source)) {
      offenders.push(`${relative}（command=${hasCommand} prefix=${hasPrefix} uses=${prefixUses}）`);
    }
  }
  assert.deepEqual(offenders, [],
    `显式 PYTHON=python 时，旧写法会把 -3 交给 python.exe 本身并报 Unknown option：\n${offenders.join('\n')}`);

  // 反向自证：扫描判据必须认得出旧调用点，不能因文件清单或正则失效而假绿。
  assert.ok(/process\.env\.PYTHON\s*(?:\|\||\?\?)\s*'py'/u.test("spawnSync(process.env.PYTHON || 'py', ['-3'])"),
    'PYTHON 调用点识别正则失效');
});
