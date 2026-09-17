#!/usr/bin/env node
//
// 采集段第 2 步：阿里妈妈「营销场景报表」—— 两个阶段。
//
//   --phase submit  报表页滚到底 → 点「下载报表」→ 弹窗点「确定」（提交一个下载任务）
//   --phase fetch   下载任务管理 → 认出新任务那一行的「下载」→ 点它，等文件落到磁盘
//
// 为什么要分两阶段（2026-09-17）：平台侧提示「数据量大时最长 10 分钟」，提交完要等它生成。
// 分成两条命令，中间那段等待就可以拿去干别的（演示里正好用来做店铺报表那一步），
// 而不是把一段死等塞在流程中间。
//
// 点击逻辑与 2026-09-17 11:2x 实跑通过的现场脚本逐条一致，只把日期/任务名/目录变成参数。
// 最贵的一条经验在 fetch 里：**下载按钮不在文件名那一行**，它在紧邻的下一个 tr。
// 按「同一行」找永远找不到，而且不会报错，只是一直等（旧脚本空转 3 分钟就是这么来的）。
import path from 'node:path';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import {
  PROMOTION_TASK_PATTERN, PROMOTION_ZIP_PATTERN, defaultDownloadsDir, listDownloads, newEntries,
  newestTaskName, parseCollectArgs, pickNewest,
} from './collect-core.mjs';

const ALIMAMA_LIST_URL = 'https://one.alimama.com/index.html#!/report/download-list';

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

async function evalOn(args, targetId, expression) {
  const payload = JSON.parse(await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression }));
  try { return JSON.parse(payload?.value); } catch { return payload?.value; }
}

async function bringToFront(args, targetId) {
  await proxyJson(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
}

async function click(args, targetId, selector) {
  return proxyJson(`${args.proxy}/click?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: selector });
}

async function findAlimamaPage(args) {
  const targets = JSON.parse(await proxyJson(`${args.proxy}/targets`));
  const matches = targets.filter((target) => target.type === 'page'
    && String(target.url).includes('one.alimama.com'));
  if (matches.length !== 1) throw new Error(`expected one alimama page on ${args.proxy}, got ${matches.length}`);
  return matches[0].targetId;
}

// 点击前一律 elementFromPoint 复核：按钮常在视口外（实测 y≈1462），
// 真实鼠标点击会静默落空且不报错 —— 这是本项目坑 33/44 那一族。
async function hitCheck(args, targetId, selector) {
  return evalOn(args, targetId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: 'element-missing' });
    const r = el.getBoundingClientRect();
    const point = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    const hitOk = !!point && (point === el || el.contains(point) || point.contains(el));
    return JSON.stringify({ ok: hitOk, y: Math.round(r.y),
      inViewport: r.y >= 0 && r.y < window.innerHeight, reason: hitOk ? null : 'not-hit' });
  })()`);
}

async function phaseSubmit(args, targetId) {
  console.log(`[submit] 页面 = ${await evalOn(args, targetId, 'location.href')}`);
  const located = await evalOn(args, targetId, `(() => {
    const candidates = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载报表');
    if (!candidates.length) return JSON.stringify({ found: 0 });
    candidates[0].scrollIntoView({ block: 'center' });
    candidates[0].setAttribute('data-collect-alimama-download', '1');
    return JSON.stringify({ found: candidates.length });
  })()`);
  if (!located.found) throw new Error('页面上找不到「下载报表」按钮（页面没落位到报表页？）');
  await delay(1500);
  const hit = await hitCheck(args, targetId, '[data-collect-alimama-download="1"]');
  if (!hit.ok) throw new Error(`「下载报表」复核未通过（${hit.reason}，y=${hit.y}，视口内=${hit.inViewport}）`);
  // 排练开关：定位与复核都走一遍，但不点 —— 这样能在不动任何东西的前提下先证明选择器是对的。
  if (args.locateOnly) {
    console.log(`[submit] --locate-only：找到「下载报表」并复核通过（y=${hit.y}，视口内=${hit.inViewport}），未点击`);
    return;
  }
  console.log(`[submit] 滚动后复核通过（y=${hit.y}）→ 点击 → `
    + `${(await click(args, targetId, '[data-collect-alimama-download="1"]')).slice(0, 80)}`);

  await delay(3000);
  const dialog = await evalOn(args, targetId, `(() => {
    const buttons = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => el.children.length === 0 && /^(确定|确认|取消|关闭)$/.test(el.textContent.trim()));
    const info = buttons.map((el, i) => {
      el.setAttribute('data-collect-dialog', String(i));
      const r = el.getBoundingClientRect();
      const point = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      return { i, text: el.textContent.trim(),
        visible: r.width > 0 && r.height > 0 && r.y >= 0 && r.y < window.innerHeight,
        hitOk: !!point && (point === el || el.contains(point) || point.contains(el)) };
    });
    return JSON.stringify({ buttons: info });
  })()`);
  const confirm = (dialog.buttons || []).find((button) => button.text === '确定' && button.hitOk);
  if (!confirm) {
    throw new Error(`弹窗里没有可点的「确定」（候选 ${JSON.stringify(dialog.buttons)}）⇒ 任务未提交`);
  }
  console.log(`[submit] 点「确定」(#${confirm.i}) → `
    + `${(await click(args, targetId, `[data-collect-dialog="${confirm.i}"]`)).slice(0, 80)}`);
  await delay(3500);
  const hint = await evalOn(args, targetId, `(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return JSON.stringify({ hint: (text.match(/(提交成功|已提交|生成中|请在下载[^ ]{0,12}查看|已加入下载[^ ]{0,10})/) || [''])[0] });
  })()`);
  console.log(`[submit] 提交后提示 = ${JSON.stringify(hint.hint)}`);
  console.log('[submit] 下一步：等它「生成成功」后跑 --phase fetch（提示语里说数据量大时最长 10 分钟）');
}

async function phaseFetch(args, targetId) {
  const before = listDownloads(args.downloads, PROMOTION_ZIP_PATTERN).map((entry) => entry.name);
  console.log(`[fetch] 下载任务管理｜已有 zip ${before.length} 个｜目录 ${args.downloads}`);
  await proxyJson(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}`
    + `&url=${encodeURIComponent(ALIMAMA_LIST_URL)}`);
  await delay(7000);

  // 认任务名：给了 --task 就用它（必须真的在列表里）；没给就取列表里时间戳最大的那个。
  // 刻意**不按「今天」过滤**：任务名里的日期是导出日而不是目标日（跨零点跑时两者不同），
  // 而时间戳本身是可比较的，最大的就是刚提交的那个 —— 少一个会错的判据。
  const names = await evalOn(args, targetId, `(() => {
    const pattern = ${PROMOTION_TASK_PATTERN.toString()};
    const found = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && pattern.test(el.textContent.trim()))
      .map((el) => el.textContent.trim());
    return JSON.stringify({ names: [...new Set(found)] });
  })()`);
  const wanted = args.task ?? newestTaskName(names.names || []);
  if (!wanted) throw new Error(`下载任务列表里认不出任务（候选 ${JSON.stringify(names.names || [])}）`);
  if (args.task && !(names.names || []).includes(args.task)) {
    throw new Error(`指定的任务 ${args.task} 不在列表里（现有 ${JSON.stringify(names.names)}）`);
  }
  console.log(`[fetch] 目标任务 = ${wanted}${args.task ? '（--task 指定）' : `（列表里最新，候选 ${names.names.length} 个）`}`);

  // 下载按钮在文件名行的**下一个** tr；往后再找，最多看 4 个兄弟。
  const located = await evalOn(args, targetId, `(() => {
    const cell = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(wanted)})[0];
    if (!cell) return JSON.stringify({ found: false, reason: 'task-row-missing' });
    const row = cell.closest('tr');
    const siblings = [];
    let node = row;
    for (let i = 0; i < 4 && node; i += 1) {
      node = node.nextElementSibling;
      if (!node) break;
      const download = [...node.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载')[0];
      siblings.push({ i, hasDownload: !!download,
        text: (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) });
      if (download) { download.setAttribute('data-collect-task-download', '1'); break; }
    }
    return JSON.stringify({ found: true, siblings,
      rowText: row ? row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : null });
  })()`);
  if (!located.found || !siblingsHaveDownload(located.siblings)) {
    throw new Error(`在 ${wanted} 附近找不到「下载」按键（探测结果 ${JSON.stringify(located.siblings)}）`);
  }
  console.log(`[fetch] 文件名行 = ${String(located.rowText).slice(0, 80)}`);
  console.log(`[fetch] 下载按钮在第 +${(located.siblings.find((s) => s.hasDownload) || {}).i} 个兄弟行`);

  await delay(1000);
  const hit = await hitCheck(args, targetId, '[data-collect-task-download="1"]');
  if (!hit.ok) throw new Error(`「下载」复核未通过（${hit.reason}，y=${hit.y}，视口内=${hit.inViewport}）`);
  // 排练开关：行定位 + 兄弟行定位 + 复核都走完，但不点下载。
  if (args.locateOnly) {
    console.log(`[fetch] --locate-only：任务行与「下载」都定位到并复核通过（y=${hit.y}），未点击`);
    return;
  }
  console.log(`[fetch] 复核通过（y=${hit.y}）→ 点击 → `
    + `${(await click(args, targetId, '[data-collect-task-download="1"]')).slice(0, 80)}`);

  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await delay(3000);
    const fresh = newEntries(before, listDownloads(args.downloads, PROMOTION_ZIP_PATTERN).map((entry) => entry.name));
    if (fresh.length) {
      const newest = pickNewest(listDownloads(args.downloads, PROMOTION_ZIP_PATTERN)
        .filter((entry) => fresh.includes(entry.name)));
      console.log(`[fetch] 新文件：${newest.name}（${newest.size} bytes）`);
      console.log(`[fetch] promotionZipPath = ${path.join(args.downloads, newest.name)}`);
      return;
    }
    console.log(`[fetch] 等待下载… ${Math.round((args.timeoutMs - (deadline - Date.now())) / 1000)}s`);
  }
  throw new Error(`${args.timeoutMs}ms 内没等到新 zip：判据取文件系统，页面说「生成成功」不算数`);
}

function siblingsHaveDownload(siblings) {
  return Array.isArray(siblings) && siblings.some((entry) => entry.hasDownload);
}

async function main() {
  const args = parseCollectArgs(process.argv.slice(2),
    { phases: ['submit', 'fetch'], flags: ['--locate-only'] });
  args.proxy = args.proxy ?? `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  args.downloads = path.resolve(args.downloads ?? defaultDownloadsDir());
  const targetId = await findAlimamaPage(args);
  await bringToFront(args, targetId);
  console.log(`[0/2] 阿里妈妈页 ${targetId}｜phase=${args.phase}｜目标日 ${args.date}`);
  if (args.phase === 'submit') await phaseSubmit(args, targetId);
  else await phaseFetch(args, targetId);
}

main().catch((error) => {
  console.error(`\n采集失败：${error.message}`);
  process.exitCode = 1;
});
