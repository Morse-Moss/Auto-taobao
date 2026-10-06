#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import {
  alimamaIdentityExpression, assertMemberIdentity, defaultDownloadsDir,
  listDownloads, newEntries,
} from './collect-core.mjs';
import {
  buildKeywordReportUrl, KEYWORD_TASK_RE, KEYWORD_ZIP_RE,
  uniqueNewKeywordTask, validateKeywordReportState, validateAudienceReportState, buildAudienceReportUrl,
  AUDIENCE_TASK_RE, AUDIENCE_ZIP_RE, uniqueNewAudienceTask,
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
async function findPage(proxy) {
  const targets = await request(proxy, '/targets');
  const pages = targets.filter((item) => item.type === 'page' && String(item.url).includes('one.alimama.com'));
  if (pages.length !== 1) throw new Error(`expected one alimama page, got ${pages.length}`);
  return pages[0].targetId;
}
function parse(argv) {
  const out = { date: null, shop: null, task: null, kind: 'keyword', phase: 'submit', downloads: defaultDownloadsDir(), proxy: null, reportUrl: null, locateOnly: false, expectMember: null, expectMemberId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') out.date = argv[++i];
    else if (key === '--shop') out.shop = argv[++i];
    else if (key === '--task') out.task = argv[++i];
    else if (key === '--kind') out.kind = argv[++i];
    else if (key === '--phase') out.phase = argv[++i];
    else if (key === '--downloads') out.downloads = path.resolve(argv[++i]);
    else if (key === '--proxy') out.proxy = argv[++i];
    else if (key === '--report-url') out.reportUrl = argv[++i];
    else if (key === '--expect-member') out.expectMember = argv[++i];
    else if (key === '--expect-member-id') out.expectMemberId = argv[++i];
    else if (key === '--locate-only') out.locateOnly = true;
    else throw new Error(`unknown argument ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.date ?? '')) throw new Error('--date must be YYYY-MM-DD');
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
async function readState(proxy, target) {
  return evalOn(proxy, target, `(() => JSON.stringify({href: location.href, text: document.body.innerText || '', triggers: [...document.querySelectorAll('.mx-trigger')].map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim()), dimensions: [...document.querySelectorAll('input[type=checkbox]')].map((e) => ({value: e.value, checked: e.checked}))}))()`);
}
async function setAllDimensions(proxy, target, kind) {
  const opened = await evalOn(proxy, target, `(() => { const e = [...document.querySelectorAll('.mx-trigger')].find((x) => (x.textContent || '').includes('维度')); if (!e) return false; e.click(); return true; })()`);
  if (!opened) throw new Error('找不到关键词数据明细维度选择器');
  const result = await evalOn(proxy, target, `(() => { const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter((x) => x.closest('[role=dialog],.oui-dialog,.next-overlay')); if (!boxes.length) return {ok:false, reason:'dimension-checkbox-missing'}; boxes.forEach((x) => { const label=(x.parentElement?.textContent||'')+(x.nextElementSibling?.textContent||''); const wanted=${JSON.stringify(kind === 'audience' ? ['主题','时间','计划'] : [])}; if (!wanted.length || wanted.some((w) => label.includes(w))) { if (!x.checked) x.click(); } }); const ok = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确定'); if (!ok) return {ok:false, reason:'confirm-missing'}; ok.click(); return {ok:true, count:boxes.length}; })()`);
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
  await navigate(proxy, target, LIST_URL);
  const row = await evalOn(proxy, target, `(() => { const n=[...document.querySelectorAll('*')].find((e)=>(e.textContent||'').trim()===${JSON.stringify(task)}&&e.children.length===0); const tr=n?.closest('tr'); const box=tr?.querySelector('input[type=checkbox]'); if(!box)return null; const r=box.getBoundingClientRect(); return {center:[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)],checked:box.checked}; })()`);
  if (!row) throw new Error(`找不到关键词报表任务 ${task}`);
  if (!row.checked) { await request(proxy, `/clickPoint?target=${encodeURIComponent(target)}`, { method: 'POST', body: JSON.stringify({ x: row.center[0], y: row.center[1] }) }); await sleep(900); }
  const point = await evalOn(proxy, target, `(() => { const n=[...document.querySelectorAll('*')].find((e)=>(e.textContent||'').trim()===${JSON.stringify(task)}&&e.children.length===0); const a=n?.closest('tr')?.nextElementSibling; const e=[...(a?.querySelectorAll('*')||[])].find((x)=>(x.textContent||'').trim()==='下载'&&x.getBoundingClientRect().width>0); if(!e)return null; const b=e.closest('button')||e; const r=b.getBoundingClientRect(); return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]; })()`);
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
    const file = await fetchTask(args.proxy, target, args.task, args.downloads, args.kind);
    console.log(`[下载] ${args.kind}ZipPath = ${file}`);
    return;
  }
  const before = await readTasks(args.proxy, target, args.kind);
  await navigate(args.proxy, target, args.reportUrl ?? (args.kind === 'audience' ? buildAudienceReportUrl(args.date) : buildKeywordReportUrl(args.date)));
  const dimensions = await setAllDimensions(args.proxy, target, args.kind);
  const state = await readState(args.proxy, target);
  (args.kind === 'audience' ? validateAudienceReportState : validateKeywordReportState)(state, args.date);
  console.log(`[校验] 阿里妈妈${args.kind === 'audience' ? '人群' : '关键词'}报表 / ${args.date} / 维度设置 ✓`);
  if (args.locateOnly) return;
  await submit(args.proxy, target, args.kind);
  await navigate(args.proxy, target, LIST_URL);
  const after = await readTasks(args.proxy, target, args.kind);
  const task = args.kind === 'audience' ? uniqueNewAudienceTask(before, after) : uniqueNewKeywordTask(before, after);
  console.log(`[提交] ${args.kind}TaskName = ${task}`);
  console.log('[下一步] 等任务变为生成成功后运行 --phase fetch --task ' + task);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`采集失败：${error.message}`); process.exitCode = 1; });
