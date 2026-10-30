/**
 * `scripts/audit-readme.mjs` 的用例。
 *
 * 为什么这份守卫要单独写测试：门禁最容易出的错不是「不红」，而是**假绿**——
 * 判据写宽了，什么都能过；写窄了，天天误报，最后有人把它关掉。所以这里两类都钉：
 * 每条断言在「该红」的输入上确实红，且在「不该红」的输入上不红。
 *
 * 另外专门钉 `looksLikeRepoPath`：它是整份守卫里唯一做「猜测」的地方
 * （猜一个反引号片段是不是路径）。猜宽了会把 `npm ci` 当路径报红，猜窄了会漏掉死链接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  auditReadme,
  extractRepoPathMentions,
  formatReport,
  looksLikeRepoPath,
  normalizeRepoPath,
} from '../scripts/audit-readme.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-readme.mjs');

function withTempReadme(content, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'audit-readme-'));
  const file = path.join(dir, 'README.md');
  writeFileSync(file, content, 'utf8');
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkOf(report, id) {
  const found = report.checks.find((check) => check.id === id);
  assert.ok(found, `没有 id 为 ${id} 的检查项`);
  return found;
}

test('当前仓库 README 四条断言全绿', () => {
  const report = auditReadme({ root: ROOT });
  const failed = report.checks.filter((check) => check.status === 'fail');
  assert.deepEqual(
    failed.map((check) => `${check.id} ${check.title}: ${check.details.join(' | ')}`),
    [],
    '当前 README 应当全绿；红了就按上面的详情改 README，不要把断言放宽',
  );
  assert.equal(report.ok, true);
  // 覆盖率这条要有牙齿：skills 目录一个不少地进去。
  const coverage = checkOf(report, 'A');
  assert.equal(coverage.status, 'pass');
  assert.match(coverage.details[0], /个目录全部在 README 中点名/);
});

test('A 模块覆盖率：少点一个 skills 目录就红，详情点名到目录', () => {
  withTempReadme('# 某项目\n\n一句话介绍。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const coverage = checkOf(report, 'A');
    assert.equal(coverage.status, 'fail');
    assert.equal(report.ok, false);
    // 必须点名具体目录，只报「有缺失」等于没报。
    assert.ok(
      coverage.details.some((line) => line.includes('skills/sycm-alimama-daily-report')),
      `详情里应当出现具体目录名，实际是：${coverage.details.join(' | ')}`,
    );
  });
});

test('A 模块覆盖率：目录名出现在正文任意位置都算点名，不要求出现在表格里', () => {
  const allNames = ['# 某项目', '', '提到的模块：', ''];
  const skillsList = auditReadme({ root: ROOT }).checks.find((c) => c.id === 'A');
  assert.equal(skillsList.status, 'pass');
  // 用当前 README 的模块名拼一份最简正文，确认不是「只认表格格式」。
  const names = [
    'sycm-alimama-daily-report', 'sycm-product-data', 'sycm-promotion-data', 'sycm-inquiry-data',
    'sycm-export-search-rank', 'sycm-to-feishu-base', 'xws-export-market-analysis',
    'xws-to-feishu-base', 'xws-sku-collection', 'xws-faq-operator', 'xws-faq-raw-collection',
    'xws-question-library-collection', 'huitun-to-feishu-keyword-heat', 'qianniu-kefu-chat',
  ];
  withTempReadme(`${allNames.join('\n')}${names.join('、')}\n`, (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    assert.equal(checkOf(report, 'A').status, 'pass');
  });
});

test('B 链接有效性：引用了不存在的 docs 路径就红', () => {
  withTempReadme('# 某项目\n\n详见 `docs/ops/NOT-EXIST-9f2a.md`。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const links = checkOf(report, 'B');
    assert.equal(links.status, 'fail');
    assert.ok(
      links.details.some((line) => line.includes('docs/ops/NOT-EXIST-9f2a.md')),
      `详情里应当出现那条死链，实际是：${links.details.join(' | ')}`,
    );
  });
});

test('B 链接有效性：带锚点与 ./ 前缀的引用按规范化后的路径校验', () => {
  withTempReadme('# 某项目\n\n见 `./docs/ops/DAILY-FLOW-SCHEDULE.md#怎么跑` 与 [说明](docs/project-knowledge.md)。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const links = checkOf(report, 'B');
    assert.equal(links.status, 'pass', links.details.join(' | '));
  });
});

test('C 敏感项：盘符路径与飞书 table id 都要红', () => {
  withTempReadme('# 某项目\n\n配置在 `D:\\retire\\x`，表是 `tblAbCdEf12345678`。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const sensitive = checkOf(report, 'C');
    assert.equal(sensitive.status, 'fail');
    const joined = sensitive.details.join(' | ');
    assert.ok(joined.includes('win-drive'), joined);
    assert.ok(joined.includes('feishu-table'), joined);
  });
});

test('C 敏感项：URL 里的冒号不能被当成盘符', () => {
  withTempReadme('# 某项目\n\n参考 https://example.com/a 与 `https://example.com/b`。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    assert.equal(checkOf(report, 'C').status, 'pass', checkOf(report, 'C').details.join(' | '));
  });
});

test('D 首屏纪律：前 30 行出现「## 目录」就红；挪到 30 行之后不红', () => {
  withTempReadme('# 某项目\n\n## 目录\n\n- 一堆文件\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const firstScreen = checkOf(report, 'D');
    assert.equal(firstScreen.status, 'fail');
    assert.ok(firstScreen.details.join(' | ').includes('toc-heading'));
  });

  const padding = Array.from({ length: 34 }, (_, index) => `第 ${index + 1} 行的正文。`).join('\n');
  withTempReadme(`# 某项目\n\n${padding}\n\n## 目录\n\n- 一堆文件\n`, (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    assert.equal(checkOf(report, 'D').status, 'pass', checkOf(report, 'D').details.join(' | '));
  });
});

test('D 首屏纪律：首屏出现安装命令与环境变量都要红', () => {
  withTempReadme('# 某项目\n\n先 `npm ci`，再配好环境变量。\n', (file) => {
    const report = auditReadme({ root: ROOT, readme: file });
    const joined = checkOf(report, 'D').details.join(' | ');
    assert.ok(joined.includes('install'), joined);
    assert.ok(joined.includes('env'), joined);
  });
});

test('looksLikeRepoPath：命令、参数、URL、glob、占位符、普通标识符都不当路径', () => {
  const rejected = [
    '--locate-only',
    'npm run test:offline',
    'node scripts/audit-readme.mjs',
    'https://example.com/a',
    'docs/*.md',
    '<店铺>',
    '<app-token>',
    'engines.node',
    'success',
    'evidence',
    'README',
    'D:\\retire\\x',
  ];
  for (const value of rejected) {
    assert.equal(looksLikeRepoPath(value), false, `不该当路径：${value}`);
  }

  const accepted = [
    'skills/sycm-product-data',
    'docs/ops/DAILY-FLOW-SCHEDULE.md',
    'AGENTS.md',
    'CHANGELOG.md',
    'runtime/',
    'evidence/',
  ];
  for (const value of accepted) {
    assert.equal(looksLikeRepoPath(value), true, `应当当路径：${value}`);
  }
});

test('normalizeRepoPath：去锚点、去 ./、去尾斜杠', () => {
  assert.equal(normalizeRepoPath('./docs/a.md#b'), 'docs/a.md');
  assert.equal(normalizeRepoPath('evidence/'), 'evidence');
  assert.equal(normalizeRepoPath('  docs/x.md  '), 'docs/x.md');
});

test('extractRepoPathMentions：代码块里的内容不进候选，行内反引号与链接进', () => {
  const text = [
    '行内 `skills/a` 与 [链接](docs/b.md)。',
    '```powershell',
    'node `skills/c`',
    '```',
  ].join('\n');
  const mentions = extractRepoPathMentions(text);
  assert.ok(mentions.includes('skills/a'), mentions.join(' | '));
  assert.ok(mentions.includes('docs/b.md'), mentions.join(' | '));
  assert.equal(mentions.includes('skills/c'), false, '代码块里的内容不该进候选');
});

test('CLI：全绿退 0，并打出 PASS', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /README audit: PASS/);
});

test('CLI：有红退 1，并打出 FAIL 与具体项', () => {
  withTempReadme('# 某项目\n\n## 目录\n\n配置在 `D:\\retire\\x`。\n', (file) => {
    const result = spawnSync(process.execPath, [SCRIPT, '--readme', file], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[FAIL\] A 模块覆盖率/);
    assert.match(result.stdout, /\[FAIL\] C 敏感项/);
    assert.match(result.stdout, /README audit: FAIL/);
  });
});

test('CLI：--readme 指向不存在的文件退 2', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--readme', 'docs/__no_such_readme__.md'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /README 不存在/);
});

test('formatReport：quiet 下不打印 PASS 行，但仍打出结论', () => {
  const report = auditReadme({ root: ROOT });
  const verbose = formatReport(report);
  assert.match(verbose, /\[PASS\] A 模块覆盖率/);
  const quiet = formatReport(report, { quiet: true });
  assert.equal(/\[PASS\]/.test(quiet), false);
  assert.match(quiet, /README audit: PASS/);
});
