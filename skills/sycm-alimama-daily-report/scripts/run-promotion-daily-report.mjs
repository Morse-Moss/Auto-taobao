#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import { pendingForKind, readLedger } from './promotion-task-ledger.mjs';
import { judgeResume, recordSubmitted, writeLedger } from './promotion-task-ledger.mjs';
import {
  alimamaIdentityExpression, assertMemberIdentity, createPageReloader, defaultDownloadsDir,
  listDownloads, newEntries,
} from './collect-core.mjs';
import {
  buildKeywordReportUrl, KEYWORD_TASK_RE, KEYWORD_ZIP_RE,
  validateKeywordReportState, validateAudienceReportState, buildAudienceReportUrl,
  AUDIENCE_TASK_RE, AUDIENCE_ZIP_RE,
  confirmSubmittedTask, reusablePromotionTask,
} from './promotion-daily-report-core.mjs';

const LIST_URL = 'https://one.alimama.com/index.html#!/report/download-list';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(proxy, endpoint, init) {
  const response = await fetch(`${proxy}${endpoint}`, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status} ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return body; }
}
async function evalOn(proxy, target, expression) {
  const result = await request(proxy, `/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
  const value = result?.value;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
async function navigate(proxy, target, url) {
  await request(proxy, `/navigate?target=${encodeURIComponent(target)}&url=${encodeURIComponent(url)}`, { method: 'POST', body: '' });
  await sleep(2500);
}
// 列表页的「真刷新」。为什么不能拿 `navigate` 顶：目标 URL 与当前 URL 相同时它是同文档导航，
// 浏览器什么都不做 —— 交付里只能用真重载（`collect-core.createPageReloader`，自带「等就绪」，
// 免得重载打断 eval 上下文后读到空白页、把「还没渲染」误判成「没有这个控件」）。
const reloadListPage = createPageReloader({ evalOn, delay: sleep, log: (message) => console.log(message) });
// 「要读列表，就先走这一下」——三个读取点（复用基线、提交前、提交后确认）统一用它。
// 为什么要两步：`navigate` 只在**路由真的变了**时才有效（从报表路由回列表路由时它是真导航），
// 而当前页已经在列表路由时它是空操作 —— 于是读到的会是上一次渲染的快照。少了这一步的代价不是
// 「慢」：复用基线读旧 ⇒ 漏掉已有同日任务、多做一次重复提交；确认读旧 ⇒ 把已生成成功的任务判成
// 「15 分钟未确认」、整家店误杀（2026-10-12 三家店实证）。
async function openFreshTaskList(proxy, target) {
  await navigate(proxy, target, LIST_URL);
  await reloadListPage(proxy, target);
}
async function findPage(proxy) {
  const targets = await request(proxy, '/targets');
  const pages = targets.filter((item) => item.type === 'page' && String(item.url).includes('one.alimama.com'));
  if (pages.length !== 1) throw new Error(`expected one alimama page, got ${pages.length}`);
  return pages[0].targetId;
}
function parse(argv) {
  const out = { date: null, shop: null, task: null, kind: 'keyword', phase: 'submit', downloads: defaultDownloadsDir(), proxy: null, reportUrl: null, ledger: path.resolve('runtime/promotion-task-ledger.json'), locateOnly: false, expectMember: null, expectMemberId: null, submitConfirmTimeoutMs: 15 * 60 * 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') out.date = argv[++i];
    else if (key === '--shop') out.shop = argv[++i];
    else if (key === '--task') out.task = argv[++i];
    else if (key === '--kind') out.kind = argv[++i];
    else if (key === '--phase') out.phase = argv[++i];
    else if (key === '--downloads') out.downloads = path.resolve(argv[++i]);
    else if (key === '--ledger') out.ledger = path.resolve(argv[++i]);
    else if (key === '--proxy') out.proxy = argv[++i];
    else if (key === '--report-url') out.reportUrl = argv[++i];
    else if (key === '--expect-member') out.expectMember = argv[++i];
    else if (key === '--expect-member-id') out.expectMemberId = argv[++i];
    else if (key === '--locate-only') out.locateOnly = true;
    else if (key === '--submit-confirm-timeout-ms') out.submitConfirmTimeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.date ?? '')) throw new Error('--date must be YYYY-MM-DD');
  if (!Number.isFinite(out.submitConfirmTimeoutMs) || out.submitConfirmTimeoutMs <= 0) throw new Error('--submit-confirm-timeout-ms must be a positive integer');
  return out;
}
async function identity(proxy, target, args) {
  if (!args.expectMember && !args.expectMemberId) return;
  const got = await evalOn(proxy, target, alimamaIdentityExpression());
  assertMemberIdentity({ expectedName: args.expectMember, expectedId: args.expectMemberId, observed: got });
  console.log(`[身份] ${got.memberName} / ${got.memberId} ✓`);
}
async function readTasks(proxy, target, kind) {
  const re = kind === 'audience' ? AUDIENCE_TASK_RE : KEYWORD_TASK_RE;
  return evalOn(proxy, target, `JSON.stringify([...new Set([...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && ${re}.test(e.textContent.trim())).map((e) => e.textContent.trim()))])`);
}
async function readTaskRows(proxy, target, kind) {
  const re = kind === 'audience' ? AUDIENCE_TASK_RE : KEYWORD_TASK_RE;
  return evalOn(proxy, target, `(() => { const pattern=${re}; const rangePattern=/(\\d{4}-\\d{2}-\\d{2})\\s*至\\s*(\\d{4}-\\d{2}-\\d{2})/; const seen=new Set(); return JSON.stringify([...document.querySelectorAll('tr')].map((tr)=>{const text=(tr.innerText||'').replace(/\\s+/g,' ').trim(); const match=[...tr.querySelectorAll('*')].find((e)=>e.children.length===0&&pattern.test((e.textContent||'').trim())); const name=(match?.textContent||'').trim(); const range=text.match(rangePattern); return {name,rangeStart:range?.[1]||null,rangeEnd:range?.[2]||null,status:text.includes('生成成功')?'生成成功':text.includes('生成失败')?'生成失败':'生成中'};}).filter((row)=>row.name&&(!seen.has(row.name)&&seen.add(row.name))) )})()`);
}
async function readState(proxy, target) {
  return evalOn(proxy, target, `(() => JSON.stringify({href: location.href, text: document.body.innerText || '', triggers: [...document.querySelectorAll('.mx-trigger')].map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()), dimensions: [...document.querySelectorAll('input[type=checkbox]')].map((e) => ({value: e.value, checked: e.checked}))}))()`);
}
export function dimensionTriggerExpression() {
  return `(() => { const text=[...document.querySelectorAll('*')].find((x)=>(x.textContent||'').trim()==='维度'); if (!text) return false; const e=text.closest('button,[role="button"],[class*="trigger"],[class*="select"]')||text.parentElement||text; e.click(); return true; })()`;
}
async function setAllDimensions(proxy, target, kind) {
  let opened = false;
  for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
    opened = await evalOn(proxy, target, dimensionTriggerExpression());
    if (!opened) await sleep(1000);
  }
  if (!opened) throw new Error('找不到关键词数据明细维度选择器');
  let result = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await evalOn(proxy, target, `(() => { const visible=(x)=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0}; const boxes=[...document.querySelectorAll('input[type=checkbox]')].filter(visible); if (!boxes.length) return {ok:false, reason:'dimension-checkbox-missing'}; const wanted=${JSON.stringify(kind === 'audience' ? ['promotion','date','campaign'] : [])}; boxes.forEach((x) => { const label=(x.parentElement?.textContent||'')+(x.nextElementSibling?.textContent||''); if (!wanted.length || wanted.includes(x.value) || wanted.some((w) => label.includes(w)) || label.includes('全选')) { if (!x.checked) x.click(); } }); const ok = [...document.querySelectorAll('button')].find((x) => visible(x) && (x.textContent || '').trim() === '确定'); if (!ok) return {ok:false, reason:'confirm-missing'}; ok.click(); return {ok:true, count:boxes.length}; })()`);
    if (result?.ok) break;
    await sleep(250);
  }
  if (!result?.ok) throw new Error(`设置关键词维度全选失败: ${result?.reason ?? 'unknown'}`);
  await sleep(1800);
}
async function submit(proxy, target, kind) {
  const clicked = await evalOn(proxy, target, `(() => { const e = [...document.querySelectorAll('button,a,div,span')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === '下载报表'); if (!e) return false; e.click(); return true; })()`);
  if (!clicked) throw new Error(`${kind === 'audience' ? '人群' : '关键词'}报表找不到下载报表按钮`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ok = await evalOn(proxy, target, `(() => { const e = [...document.querySelectorAll('button,a,div,span')].find((x) => x.children.length === 0 && /^(确定|确认)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!e) return false; e.click(); return true; })()`);
    if (ok) return;
    await sleep(800);
  }
  throw new Error('关键词报表下载弹窗未出现可点击的确定');
}
async function fetchTask(proxy, target, task, downloads, kind) {
  await openFreshTaskList(proxy, target);
  const rowExpression = `(() => { const n=[...document.querySelectorAll('td,th,span,div')].find((e)=>(e.textContent||'').trim()===${JSON.stringify(task)}&&e.children.length===0); const tr=n?.closest('tr'); const box=tr?.querySelector('input[type=checkbox]'); if(!box)return null; const r=box.getBoundingClientRect(); return {center:[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)],checked:box.checked}; })()`;
  let row = null;
  for (let attempt = 0; attempt < 15 && !row; attempt += 1) { row = await evalOn(proxy, target, rowExpression); if (!row) await sleep(1000); }
  if (!row) throw new Error(`找不到关键词报表任务 ${task}`);
  if (!row.checked) { await request(proxy, `/clickPoint?target=${encodeURIComponent(target)}`, { method: 'POST', body: JSON.stringify({ x: row.center[0], y: row.center[1] }) }); await sleep(900); }
  const pointExpression = `(() => { const visible=(x)=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(x).visibility!=='hidden'}; const n=[...document.querySelectorAll('td,th,span,div')].find((e)=>(e.textContent||'').trim()===${JSON.stringify(task)}&&e.children.length===0); const tr=n?.closest('tr'); const body=tr?.parentElement; const isOp=(x)=>x?.matches('tr[mx-stickytable-operation^="line"]'); const a=(isOp(tr?.nextElementSibling)&&tr.nextElementSibling)||[...(body?.querySelectorAll('tr[mx-stickytable-operation^="line"]')||[])].find((x)=>x.previousElementSibling===tr); const e=[...(a?.querySelectorAll('button,a,[role="button"],span,div')||[])].find((x)=>(x.textContent||'').trim()==='下载'&&visible(x)); if(!e)return null; const b=e.closest('button,a,[role="button"]')||e; const r=b.getBoundingClientRect(); return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]; })()`;
  let point = null;
  for (let attempt = 0; attempt < 20 && !point; attempt += 1) { point = await evalOn(proxy, target, pointExpression); if (!point) await sleep(1000); }
  if (!point) throw new Error(`关键词报表任务 ${task} 尚未出现下载入口`);
  const zipRe = kind === 'audience' ? AUDIENCE_ZIP_RE : KEYWORD_ZIP_RE;
  const before = listDownloads(downloads, zipRe).map((item) => item.name);
  await request(proxy, `/clickPoint?target=${encodeURIComponent(target)}`, { method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }) });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { await sleep(2000); const fresh = newEntries(before, listDownloads(downloads, zipRe).map((item) => item.name)); if (fresh.length) return path.join(downloads, fresh[0]); }
  throw new Error(`关键词报表下载超时: ${task}`);
}
async function main() {
  const args = parse(process.argv.slice(2));
  args.proxy ??= `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  const target = await findPage(args.proxy);
  await identity(args.proxy, target, args);
  if (args.phase === 'fetch') {
    const taskRe = args.kind === 'audience' ? AUDIENCE_TASK_RE : KEYWORD_TASK_RE;
    if (!args.task || !taskRe.test(args.task)) throw new Error('--phase fetch 需要匹配 kind 的任务名');
    const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-promotion-report.mjs');
    const sharedFetch = spawnSync(process.execPath, [driver, '--phase', 'fetch', '--date', args.date,
      '--report-kind', args.kind, '--shop-key', args.shop, '--proxy', args.proxy,
      '--expect-member', args.expectMember, '--expect-member-id', args.expectMemberId,
      '--task', args.task, '--ledger', args.ledger, '--downloads', args.downloads,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (sharedFetch.status !== 0) throw new Error(sharedFetch.stderr || sharedFetch.stdout || '共享日报取件流程失败');
    const file = sharedFetch.stdout.match(/promotionZipPath = (.+)/u)?.[1]?.trim();
    if (!file) throw new Error(`共享日报取件未返回落盘文件路径：${sharedFetch.stdout}`);
    console.log(`[下载] ${args.kind}ZipPath = ${file}`);
    return;
  }
  // 任务基线必须从下载任务管理读取；当前页可能是 SYCM 或阿里妈妈首页，在那里读到空数组
  // 会让复用判据（reusable/resume）漏掉已有同日任务、从而多做一次不必要的重复提交。
  // 而「页签就在列表路由」时只 navigate 是读不到真值的（同 URL ＝ 空操作）⇒ 基线也必须真刷新。
  await openFreshTaskList(args.proxy, target);
  const beforeRows = await readTaskRows(args.proxy, target, args.kind);
  if (!args.shop) throw new Error('--shop is required for shared task-ledger recovery');
  const ledger = readLedger(args.ledger);
  const resume = judgeResume({ ledger, date: args.date, shop: args.shop, list: beforeRows, kind: args.kind });
  const pending = pendingForKind(ledger, { date: args.date, shop: args.shop, kind: args.kind });
  let task = null;
  if (resume.action === 'block') throw new Error(`任务恢复核验失败：${resume.reason}`);
  if (resume.action === 'reuse') {
    task = pending.find((entry) => beforeRows.some((row) => row.name === entry.taskName && row.rangeStart === args.date && row.rangeEnd === args.date && row.status === '生成成功'))?.taskName ?? null;
    if (!task) throw new Error(`台账有待取任务但列表不满足日期/状态复用条件：${resume.reason}`);
    console.log(`[复用] ${args.kind}TaskName = ${task}`);
  } else {
  // 台账已结清时仍优先复用平台上同一业务日的成功任务，避免重跑把同一日报重复提交。
  const existing = reusablePromotionTask(beforeRows, { kind: args.kind, date: args.date });
  if (existing) {
    task = existing;
    console.log(`[复用] ${args.kind}TaskName = ${task}（平台已有同日生成成功任务，跳过提交）`);
  } else {
  await navigate(args.proxy, target, args.reportUrl ?? (args.kind === 'audience' ? buildAudienceReportUrl(args.date) : buildKeywordReportUrl(args.date)));
  const dimensions = await setAllDimensions(args.proxy, target, args.kind);
  const state = await readState(args.proxy, target);
  (args.kind === 'audience' ? validateAudienceReportState : validateKeywordReportState)(state, args.date);
  console.log(`[校验] 阿里妈妈${args.kind === 'audience' ? '人群' : '关键词'}报表 / ${args.date} / 维度设置 ✓`);
  if (args.locateOnly) return;
  await submit(args.proxy, target, args.kind);
  await openFreshTaskList(args.proxy, target);
  // ㊶（2026-10-11）根修：确认判据从「列表差集恰好新增 1 条」改为「按业务日定位生成成功任务」。
  // 差集判据在 10-10 晚、10-11 早两轮实测里一律读不到刚提交的新任务（提交本身全部成功、任务
  // 生成成功，只是进入列表视图要平台异步刷新，原 20×4s 等待窗不够，最长实测 13 分钟才可见）。
  // 走到这里的前提是 before 阶段 reusable 判据未命中（否则上面已复用跳过提交），因此提交后
  // 列表里出现的「本业务日 + 本 kind + 生成成功」任务就是本轮结果；多条时取最新，与复用同口径。
  const confirmDeadline = Date.now() + args.submitConfirmTimeoutMs;
  let lastRows = [];
  for (;;) {
    const rows = await readTaskRows(args.proxy, target, args.kind);
    lastRows = rows;
    const confirmed = confirmSubmittedTask({ rows, kind: args.kind, date: args.date });
    if (confirmed) {
      task = confirmed;
      writeLedger(args.ledger, recordSubmitted(readLedger(args.ledger), { date: args.date, shop: args.shop, taskName: task, proxy: args.proxy, kind: args.kind }));
      break;
    }
    if (Date.now() >= confirmDeadline) {
      throw new Error(`${args.kind === 'audience' ? '人群' : '关键词'}报表提交后 ${Math.round(args.submitConfirmTimeoutMs / 60000)} 分钟内未在下载列表确认到业务日 ${args.date} 的生成成功任务；最后一次读到的任务行：${JSON.stringify(lastRows)}`);
    }
    await sleep(5000);
    // 2026-10-12 真机误杀实证（本循环原来的最后一步是 `await navigate(args.proxy, target, LIST_URL)`）：
    // 目标 URL 与当前 URL **相同**时 navigate 是「同文档导航」，浏览器什么都不做 —— 这条规矩
    // 本项目 09-21 就在 `date-picker` 里踩过、`collect-core.createPageReloader` 的注释里也写着。
    // 后果不是「慢一点」，而是**列表永远停在提交后第一次渲染那一版**：晚几秒才变成生成成功的任务
    // 一条都读不到 ⇒ 判「15 分钟内未确认」⇒ 这家店被误杀。10-12 那轮盖文淘宝（人群 083624）、
    // 盖文天猫（关键词 085140）、科塔淘宝 三家都是这么被判死的，平台侧任务其实早就生成成功。
    // 换成**真重载**才谈得上「再读一次列表」（重载会打断 eval 上下文，reloader 自带等就绪）。
    await reloadListPage(args.proxy, target);
  }
  }
  }
  console.log(`[提交] ${args.kind}TaskName = ${task}`);
  console.log('[下一步] 等任务变为生成成功后运行 --phase fetch --task ' + task);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`采集失败：${error.message}`); process.exitCode = 1; });
