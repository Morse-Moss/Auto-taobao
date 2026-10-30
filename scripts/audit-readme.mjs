#!/usr/bin/env node
/**
 * README 四条守卫。
 *
 * README 掉成「技术文档」有四种典型症状，各对应一条断言：
 *
 *   A 模块覆盖率 —— `skills/` 下每个目录都必须在 README 里点名。
 *      2026-10-30 实测：旧 README 漏了 5 个（日报、商品、推广明细、询单、千牛客服），
 *      而这 5 个正是当时的主业，整整一个月没人发现。**靠记性维护的清单一定会烂，只
 *      有让它红了才有下一次更新。**
 *   B 链接有效性 —— 反引号里的仓库内路径必须真的存在。搬了目录忘改链接，读者点到 404，
 *      而这种失效在渲染后的页面上看不出来（反引号里的死路径和活路径长得一样）。
 *   C 敏感项 —— 本机盘符、macOS 家目录、飞书 base/table id、租户域名不许出现在对外文档。
 *      这类东西一旦进 README，就是随仓库一起公开，且 `git revert` 也留痕。
 *   D 首屏纪律 —— 前 30 行出现安装命令、环境变量、或者以「目录／安装／部署／依赖」
 *      作小节标题，说明这份 README 在当交接文档写而不是当介绍写。
 *      这是唯一一条「口味」断言，所以阈值和禁词都写成显式常量，改它要留痕。
 *
 * 用法：
 *   node scripts/audit-readme.mjs
 *   node scripts/audit-readme.mjs --readme tmp/old.md     # 审计指定文件（变异测试用）
 *   node scripts/audit-readme.mjs --first-screen 40       # 改首屏行数（默认 30）
 *   node scripts/audit-readme.mjs --json
 *   node scripts/audit-readme.mjs --quiet                 # 只打印红项与结论
 *
 * 退出码：0 全绿；1 有红；2 自身出错（读不到文件等）。
 *
 * 为什么断言写在这里而不是写在测试里：README 审计要在每次 check:fast 都跑一遍，
 * 而 check:fast 不跑测试。守卫必须是「每次提交都过一遍的东西」，不是「有人想起来才跑的东西」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 首屏纪律扫多少行。改这个数要连注释一起改，否则明年没人知道为什么是 30。 */
export const DEFAULT_FIRST_SCREEN = 30;

/** 仓库内可以被 README 引用的顶层目录。不在这里的，一律不当路径看，避免把命令参数误判成路径。 */
const TOP_LEVEL_DIRS = new Set([
  'skills', 'runtime', 'scripts', 'docs', 'db', 'evidence', 'config',
  'output', 'tmp', 'agent-runtime', 'generated-images',
]);

/** 允许被引用的仓库根文件。白名单而非黑名单：新加根文件时要显式登记，否则会漏检。 */
const ROOT_FILE_PATTERN = /^(?:README\.md|AGENTS\.md|CHANGELOG\.md|VERSION|package\.json|package-lock\.json|requirements\.txt)$/;

/** 首屏禁词。每条都要给出「为什么禁」，否则后人只会往列表里加词，不会删词。 */
export const FIRST_SCREEN_BANS = Object.freeze([
  { id: 'install', pattern: /\b(?:npm\s+(?:ci|install)|pip\s+install|yarn\s+add|pnpm\s+(?:i|install))\b/i,
    why: '安装命令出现在首屏，等于告诉读者「这是给别人照着手册装的」，而首屏该说的是它值不值得看' },
  { id: 'env', pattern: /环境变量/,
    why: '环境变量属于部署细节，读者还没决定要不要用，讲这个顺序反了' },
  { id: 'toc-heading', pattern: /^#{1,3}\s*(?:目录|安装|部署|依赖|文件结构|模块列表)\s*$/m,
    why: '首屏就把「目录/安装/部署/依赖」当第一节，这是交接文档的开头，不是项目介绍的开头' },
  { id: 'abs-path', pattern: /绝对路径/,
    why: '在介绍里解释路径怎么写的，说明正文里混进了本机环境说明' },
]);

/** 敏感项。顺序即报告顺序。 */
export const SENSITIVE_PATTERNS = Object.freeze([
  { id: 'win-drive', pattern: /(?<![A-Za-z0-9])[A-Za-z]:(?:\\|\/(?!\/))/g,
    why: 'Windows 本机盘符路径（如 D:\\... ），换一台机器就失效，且暴露本机目录结构' },
  { id: 'mac-home', pattern: /\/Users\/[A-Za-z]/g,
    why: 'macOS 本机家目录路径' },
  { id: 'feishu-table', pattern: /\btbl[A-Za-z0-9]{8,}\b/g,
    why: '飞书 table id，公开即等于把表暴露给所有人' },
  { id: 'feishu-base', pattern: /\bbase\/[A-Za-z0-9]{15,}\b/g,
    why: '飞书 base token' },
  { id: 'feishu-tenant', pattern: /\b[a-z0-9]{8,}\.feishu\.cn\b/g,
    why: '飞书租户域名，可反查组织' },
]);

/**
 * 判断一个反引号片段像不像「仓库内路径」。
 * 宁漏不误：把命令参数、URL、glob、占位符全部排除，只留下真的能 existsSync 的东西。
 * 漏检的代价是少一条提示，误检的代价是天天假红 —— 假红会让人关掉门禁。
 */
export function looksLikeRepoPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length < 3) return false;
  if (/^(?:--|-[A-Za-z]<|\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) return false;
  if (/[\s*?{}|"'`]/.test(value)) return false;
  if (value.includes('<')) return false;

  const withoutAnchor = value.replace(/#.*$/, '');
  const normalized = withoutAnchor.replace(/^\.\//, '');
  if (!normalized) return false;
  const hadSlash = normalized.includes('/');
  if (hadSlash) return TOP_LEVEL_DIRS.has(normalized.split('/')[0]);
  return ROOT_FILE_PATTERN.test(normalized);
}

/** 从 Markdown 正文里抠出所有可能指向仓库内文件的片段的原始值（未去重、未规范化）。 */
export function extractRepoPathMentions(text) {
  const body = text.replace(/```[\s\S]*?```/g, '');
  const mentions = [];
  for (const match of body.matchAll(/`([^`\n]{2,200})`/g)) mentions.push(match[1]);
  for (const match of body.matchAll(/\]\(([^)\s]{2,300})\)/g)) mentions.push(match[1]);
  return mentions;
}

/** 把一条引用规范成仓库相对路径：去锚点、去 ./ 前缀、去尾斜杠。 */
export function normalizeRepoPath(raw) {
  return String(raw).trim()
    .replace(/#.*$/, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function checkModuleCoverage({ root, text }) {
  const skillsDir = path.join(root, 'skills');
  if (!existsSync(skillsDir)) {
    return { id: 'A', title: '模块覆盖率', status: 'skip', details: ['没有 skills/ 目录，跳过'] };
  }
  // 下划线开头的目录按约定是内部目录，不要求出现在 README。
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
  const missing = dirs.filter((name) => !text.includes(name));
  if (missing.length === 0) {
    return { id: 'A', title: '模块覆盖率', status: 'pass', details: [`skills/ 下 ${dirs.length} 个目录全部在 README 中点名`] };
  }
  return {
    id: 'A',
    title: '模块覆盖率',
    status: 'fail',
    details: [
      `${dirs.length} 个 skills 目录里有 ${missing.length} 个没在 README 出现`,
      ...missing.map((name) => `- skills/${name}`),
    ],
  };
}

function checkLinkValidity({ root, text }) {
  const raw = extractRepoPathMentions(text);
  const candidates = [...new Set(raw.filter(looksLikeRepoPath).map(normalizeRepoPath))].sort();
  if (candidates.length === 0) {
    return { id: 'B', title: '链接有效性', status: 'skip', details: ['README 里没有可校验的仓库内路径'] };
  }
  const missing = candidates.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length === 0) {
    return { id: 'B', title: '链接有效性', status: 'pass', details: [`${candidates.length} 个仓库内路径全部存在`] };
  }
  return {
    id: 'B',
    title: '链接有效性',
    status: 'fail',
    details: [
      `${candidates.length} 个引用里有 ${missing.length} 个指向不存在的路径`,
      ...missing.map((rel) => `- ${rel}`),
    ],
  };
}

function checkSensitive({ text }) {
  const hits = [];
  for (const { id, pattern, why } of SENSITIVE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const start = Math.max(0, match.index - 12);
      const snippet = text.slice(start, Math.min(text.length, match.index + match[0].length + 12))
        .replace(/\s+/g, ' ');
      hits.push(`${id}: ${match[0]} … ${snippet} （${why}）`);
    }
  }
  if (hits.length === 0) {
    return { id: 'C', title: '敏感项', status: 'pass', details: [`${SENSITIVE_PATTERNS.length} 条规则全部无命中`] };
  }
  return { id: 'C', title: '敏感项', status: 'fail', details: [`命中 ${hits.length} 处`, ...hits] };
}

function checkFirstScreen({ text, firstScreen }) {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, firstScreen).join('\n');
  const hits = [];
  for (const { id, pattern, why } of FIRST_SCREEN_BANS) {
    const match = head.match(pattern);
    if (!match) continue;
    const lineNo = lines.slice(0, firstScreen).findIndex((line) => pattern.test(line)) + 1;
    hits.push(`${id}: 第 ${lineNo} 行「${match[0].trim()}」（${why}）`);
  }
  if (hits.length === 0) {
    return { id: 'D', title: '首屏纪律', status: 'pass', details: [`前 ${firstScreen} 行没有安装/组织说明类信号`] };
  }
  return {
    id: 'D',
    title: '首屏纪律',
    status: 'fail',
    details: [`前 ${firstScreen} 行命中 ${hits.length} 条`, ...hits],
  };
}

/**
 * 审计一份 README。纯函数，不读 process.argv —— 测试要能直接喂内容进来。
 * @returns {{file:string, absolutePath:string, lines:number, chars:number, checks:Array, ok:boolean}}
 */
export function auditReadme({ root = ROOT, readme = 'README.md', firstScreen = DEFAULT_FIRST_SCREEN } = {}) {
  const absolutePath = path.isAbsolute(readme) ? readme : path.join(root, readme);
  if (!existsSync(absolutePath)) {
    throw new Error(`README 不存在：${absolutePath}`);
  }
  const text = readFileSync(absolutePath, 'utf8');
  const checks = [
    checkModuleCoverage({ root, text }),
    checkLinkValidity({ root, text }),
    checkSensitive({ text }),
    checkFirstScreen({ text, firstScreen }),
  ];
  return {
    file: path.relative(root, absolutePath).split(path.sep).join('/') || readme,
    absolutePath,
    lines: text.split(/\r?\n/).length,
    chars: text.length,
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

/** 把审计结果渲染成给人看的多行文本。 */
export function formatReport(report, { quiet = false } = {}) {
  const out = [];
  out.push(`==> README audit: ${report.file} (${report.lines} 行 / ${report.chars} 字符)`);
  for (const check of report.checks) {
    if (quiet && check.status === 'pass') continue;
    const tag = check.status === 'pass' ? 'PASS' : check.status === 'skip' ? 'SKIP' : 'FAIL';
    out.push(`  [${tag}] ${check.id} ${check.title}: ${check.details[0] ?? ''}`);
    for (const line of check.details.slice(1)) out.push(`         ${line}`);
  }
  out.push(`==> README audit: ${report.ok ? 'PASS' : 'FAIL'}`);
  return out.join('\n');
}

function main(argv) {
  const readmeIndex = argv.indexOf('--readme');
  const firstScreenIndex = argv.indexOf('--first-screen');
  const readme = readmeIndex >= 0 ? argv[readmeIndex + 1] : 'README.md';
  const firstScreen = firstScreenIndex >= 0 ? Number(argv[firstScreenIndex + 1]) : DEFAULT_FIRST_SCREEN;
  if (!readme) {
    console.error('--readme 后面要跟一个文件路径');
    return 2;
  }
  if (!Number.isFinite(firstScreen) || firstScreen <= 0) {
    console.error('--first-screen 要跟一个正整数');
    return 2;
  }

  let report;
  try {
    report = auditReadme({ readme, firstScreen });
  } catch (error) {
    console.error(`==> README audit: ERROR ${error.message}`);
    return 2;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, { quiet: argv.includes('--quiet') }));
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
