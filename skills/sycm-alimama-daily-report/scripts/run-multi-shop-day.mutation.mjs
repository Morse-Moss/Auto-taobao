// 突变验证：驱动里这一族判据（代理重试）能不能真的红、且红在期望的那一条。
//
// 为什么非验不可：这一族里有一条是**源码文本扫描**型判据（「proxyJson 里有没有真的调那条判据」），
// 它红了不代表拦住了什么。而且新加的「可重发」判据很容易写成恒真（那也能让原有用例全绿）。
// 只有「改坏 → 它红 → 错的还是这一条」才算数。还原后必须 sha256 逐字节一致（末尾自证并打印）。
//
// 后缀刻意**不是** `.test.mjs`（同 runtime/content-heat-judge.mutation.mjs 的约定）：
// 它是验判据的工具，不是判据本身 —— 进了套件就等于每次全量都改一遍源码再还原。
// 手动跑：node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mutation.mjs
//
// 这些突变的原型是一次**真事故**（2026-09-21 第二轮排练四家店卡在 sycm-reset、报 ERROR fetch failed）：
//   当时既没有重试，也没有「判据只重发没拿到应答的那一类」这条边界。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const ROOT = path.resolve(DIR, '../../..');
const DRIVER = path.join(DIR, 'run-multi-shop-day.mjs');
const TEST = path.join(DIR, 'run-multi-shop-day.test.mjs');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map([[DRIVER, fs.readFileSync(DRIVER, 'utf8')]]);
const shas = new Map([...originals.keys()].map((file) => [file, sha(file)]));

/** 替换必须命中，否则当场停手 —— 「改坏没改成」会让整轮突变给出假绿。 */
function replaceIn(file, from, to) {
  const text = originals.get(file);
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`${path.basename(file)}：期望命中 1 处，实际 ${hits} 处 —— 停手，别把这次结果当成验证`);
  const next = text.split(from).join(to);
  fs.writeFileSync(file, next, 'utf8');
  if (fs.readFileSync(file, 'utf8') !== next) throw new Error(`${path.basename(file)}：写入没生效（静默丢写）`);
}

function restore() {
  for (const [file, text] of originals) fs.writeFileSync(file, text, 'utf8');
}

function run() {
  try {
    const out = execFileSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, out };
  } catch (error) {
    return { exit: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const results = [];
function mutate(name, apply, expectation) {
  try {
    apply();
    const { exit, out } = run();
    // 断言消息有两种打印形态：单行 `error: '...'` 与多行块；`duration_ms` 排在 `error` **之前**，
    // 所以别按 duration_ms 截断（那会把 error 一起切掉，把真被抓住的突变误报成「漏掉」）。
    // 按「每个测试一段」切：ok / not ok 行是天然的段首。
    const blocks = out.split(/^(?=(?:ok|not ok) \d+ - )/mu).filter((part) => part.startsWith('not ok '));
    const failedTests = blocks.map((block) => block.split('\n')[0].replace(/^not ok \d+ - /u, '').trim());
    const caught = exit !== 0 && blocks.some((block) => expectation.test(block));
    results.push({ name, caught, exit, failedTests, blockHead: blocks[0]?.slice(0, 260) ?? null });
  } catch (error) {
    results.push({ name, caught: false, error: error.message });
  } finally {
    restore();
  }
}

const RETRYABLE_TAIL = '  return /\\b(?:fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|UND_ERR_SOCKET)\\b/iu\n'
  + '    .test(both);';

mutate('M1 可重发判据写成恒真（拿到应答的那一类也被重发）',
  () => replaceIn(DRIVER, RETRYABLE_TAIL, '  return true;'),
  /拿到 HTTP 应答的失败被判成了可重发/u);

mutate('M2 可重发判据漏掉 fetch failed（这次事故的原文就是它）',
  () => replaceIn(DRIVER, 'fetch failed|ECONNREFUSED', 'ECONNREFUSED'),
  /连接层失败判据丢掉了「fetch failed」这一种/u);

mutate('M3 接线断掉：proxyJson 不再看那条判据（判据成孤岛）',
  () => replaceIn(DRIVER, '      if (!judgeProxyRetryable(error)) throw error;\n', '      if (error === null) throw error;\n'),
  /proxyJson 必须调用这条判据/u);

mutate('M7 不可重试的那一类被包装掉了（服务端给的答案被说成「连不上」）',
  () => replaceIn(DRIVER, '      if (!judgeProxyRetryable(error)) throw error;\n',
    '      if (!judgeProxyRetryable(error)) throw new Error(\'代理连不上\');\n'),
  /不可重试的那一类必须/u);

mutate('M4 重试次数等于没重试（PROXY_ATTEMPTS 改成 1）',
  () => replaceIn(DRIVER, 'const PROXY_ATTEMPTS = 3;', 'const PROXY_ATTEMPTS = 1;'),
  /重试次数要是 2~5 之间的整数/u);

mutate('M5 去掉退避（失败就连打，退化成空转）',
  () => replaceIn(DRIVER, '      await new Promise((r) => { setTimeout(r, PROXY_BACKOFF_MS); });\n', ''),
  /重发之间要有退避/u);

mutate('M6 报错不写试了几次（事后分不清抖动与长期不通）',
  () => replaceIn(DRIVER, '代理连不上（连试 ${PROXY_ATTEMPTS} 次）', '代理连不上'),
  /重试用尽后要报出\*\*试了几次\*\*/u);

// 还原自证：逐字节一致
const restored = [...originals.keys()].every((file) => sha(file) === shas.get(file));
const summary = {
  restored,
  shas: Object.fromEntries([...shas].map(([file, hash]) => [path.basename(file), hash])),
  caught: results.filter((r) => r.caught).length,
  total: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (results.some((r) => !r.caught) || !restored) process.exitCode = 1;
