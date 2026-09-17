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
// 点击逻辑与 2026-09-17 现场脚本逐条一致，只把日期/任务名/目录变成参数。
// 取件那一步的模型在 2026-09-17 被**推翻重写过一次**，以现场实测为准（细节见 collect-core 的
// `downloadEntryExpression` 上方注释）。三条最容易踩的：
//   ① 下载入口在**文件名那行的下一个 tr**（该行的操作行），而操作行**默认 display:none**，
//      只有该行被激活（真实点它的复选框、并回读 checked=true）才显形；
//   ② 因此不存在「底部操作栏」那条路 —— 那是当时恰好激活的那一行的操作行按钮；
//   ③ 点击前**必须当场重新量矩形**：量到点之间页面会动，差一行（41px）就会点到别的任务的单元格上，
//      `clicked:true` 却什么都不发生，而且不报错。零尺寸矩形一律 fail-closed。
import path from 'node:path';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import {
  PROMOTION_TASK_PATTERN, PROMOTION_ZIP_PATTERN, TASK_DOWNLOAD_MARK, checkboxStateExpression,
  defaultDownloadsDir, describeEntryMiss, describeHitMiss, describeHitPass, downloadEntryExpression,
  hitCheckExpression, listDownloads, newEntries, newestTaskName, parseCollectArgs, pickNewest,
  restoreCheckboxesExpression, scrollIntoViewExpression, targetRowExpression,
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

// 真实鼠标点击（CDP 的按下→抬起序列），点位取复核时那个「确实命中自己」的坐标。
// 为什么 fetch 段必须用它：2026-09-17 做了一次干净的对照 —— 先用正确协议激活目标任务行、
// 确认标的元素就是它那个唯一的可见「下载」（rect [136,368,49,24]、全页可见叶子恰 1 个），
// 然后对**同一个元素**先发 JS 的 el.click()（`POST /click` 按选择器）：15 秒没有任何文件落盘；
// 同一元素改用真实鼠标点中心，3 秒落盘。所以这不是「选择器选错了」的假象，是页面只认真实鼠标事件。
// 这条不影响 submit 段：那里的「下载报表」「确定」用 JS 点击是有效的，差别在页面各自怎么实现。
async function clickPoint(args, targetId, point) {
  return proxyJson(`${args.proxy}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }) });
}

// 用哪个点：中心点命中就用中心（最不容易擦到边），否则用复核时找到的那个命中点。
function pointOf(hit) {
  const point = hit.centerIsSelf && hit.rect
    ? [Math.round(hit.rect[0] + hit.rect[2] / 2), Math.round(hit.rect[1] + hit.rect[3] / 2)]
    : hit.firstHit;
  // 零尺寸矩形算出来的「中心」是 (0,0)，点下去正好落在页面左上角 —— 实测会把阿里妈妈页
  // 从「下载任务管理」导航到「首页」。复核通过已经隐含 rect 非零，这里再挡一道：
  // 在这一页上「点到了别处」不会报错，只会静默地什么都不发生，最难查。
  if (!Array.isArray(point) || !(point[0] > 0 || point[1] > 0)) {
    throw new Error(`拒绝点击可疑坐标 ${JSON.stringify(point)}（rect=${JSON.stringify(hit.rect)}）`
      + '—— 零尺寸或缺失坐标的点击只会静默落空，甚至点到页面别处');
  }
  return point;
}

async function findAlimamaPage(args) {
  const targets = JSON.parse(await proxyJson(`${args.proxy}/targets`));
  const matches = targets.filter((target) => target.type === 'page'
    && String(target.url).includes('one.alimama.com'));
  if (matches.length !== 1) throw new Error(`expected one alimama page on ${args.proxy}, got ${matches.length}`);
  return matches[0].targetId;
}

// 点击前一律复核：按钮常在视口外（实测文档坐标 y≈1462），真实鼠标点击会静默落空且不报错
// —— 这是本项目坑 33/44 那一族。
// 判据在 collect-core 里（矩形内是否存在「视口内且命中自己」的采样点），这里只负责调用与报错措辞：
// 2026-09-17 实测过一次误判 —— 元素整个在视口右边界外时，只看中心点会直接判失败。
async function hitCheck(args, targetId, selector) {
  return evalOn(args, targetId, hitCheckExpression(selector));
}

async function phaseSubmit(args, targetId) {
  console.log(`[submit] 页面 = ${await evalOn(args, targetId, 'location.href')}`);
  const located = await evalOn(args, targetId, `(() => {
    // 同样是 hash 路由：不重载页面，上一轮标过的元素会留在 DOM 里，先清掉。
    document.querySelectorAll('[data-collect-alimama-download]')
      .forEach((el) => el.removeAttribute('data-collect-alimama-download'));
    const candidates = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载报表');
    if (!candidates.length) return JSON.stringify({ found: 0 });
    candidates[0].setAttribute('data-collect-alimama-download', '1');
    const clickable = candidates[0].closest('button,a,[role=button]');
    return JSON.stringify({ found: candidates.length, tag: candidates[0].tagName,
      clickableAncestor: clickable && clickable !== candidates[0] ? clickable.tagName : null });
  })()`);
  if (!located.found) throw new Error('页面上找不到「下载报表」按钮（页面没落位到报表页？）');
  // 报出「取的是哪个元素」：文档序第一个常常是按钮内部的文字 span 而不是 button 本身，
  // 点它靠的是事件冒泡 —— 这一点在录像里也值得说清，免得看的人以为选择器选错了。
  console.log(`[submit] 候选 ${located.found} 个，取文档序第一个（${located.tag}`
    + `${located.clickableAncestor ? `，其可点祖先是 ${located.clickableAncestor}，点击靠冒泡触发` : ''}）`);
  // 两个方向都要居中：只写 block 时窄窗口下按钮会落在视口右边界之外（2026-09-17 实测）。
  await evalOn(args, targetId, scrollIntoViewExpression('[data-collect-alimama-download="1"]'));
  await delay(1500);
  const hit = await hitCheck(args, targetId, '[data-collect-alimama-download="1"]');
  if (!hit.ok) throw new Error(`「下载报表」复核未通过（${describeHitMiss(hit)}）`);
  // 排练开关：定位与复核都走一遍，但不点 —— 这样能在不动任何东西的前提下先证明选择器是对的。
  if (args.locateOnly) {
    console.log(`[submit] --locate-only：找到「下载报表」并复核通过（${describeHitPass(hit)}），未点击`);
    return;
  }
  console.log(`[submit] 滚动后复核通过（${describeHitPass(hit)}）→ 点击 → `
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

  // 取件前提：**先激活目标任务行**。它的操作行默认 display:none，只有这一行被激活才显形，
  // 而页面上任何时刻可见的「下载」叶子恰好 1 个 —— 不激活就会点到别的任务行的入口上，
  // 而这一页「点错」不报错。激活的可靠动作是真实鼠标点该行的复选框，并**回读** checked=true：
  // 点没点上不看接口返回值（它恒 true），看页面状态。
  const boxesBefore = await evalOn(args, targetId, checkboxStateExpression());
  const row = await evalOn(args, targetId, targetRowExpression(wanted));
  if (!row.found) throw new Error(`下载任务列表里找不到 ${wanted} 那一行（${row.reason}）`);
  if (!row.hasCheckbox) throw new Error(`${wanted} 那一行没有复选框，无法激活它的操作行`);
  console.log(`[fetch] 目标任务行 = 第 ${row.trIndex} 行｜${String(row.rowText).slice(0, 80)}`);
  // 「找到了那一行」不等于「那一行现在能取件」。任务还在生成中时，它的入口点了也不落盘，
  // 现场表现是 30 秒空等 —— 和「点错了」长得一模一样。先把状态判掉，别留给超时去猜。
  if (!/生成成功/u.test(String(row.rowText))) {
    throw new Error(`目标任务 ${wanted} 还不是「生成成功」（行文本 `
      + `${JSON.stringify(String(row.rowText).slice(0, 80))}）⇒ 现在取件只会空等；`
      + '等列表里这一行显示生成成功再来跑 --phase fetch');
  }
  if (row.checked) {
    console.log('[fetch] 该行本就是选中态，跳过点击');
  } else {
    await selectTargetRow(args, targetId, wanted, row);
  }

  // 入口：只认**目标任务行的下一行**（它的操作行）里那个可见的「下载」。
  const entrySelector = `[${TASK_DOWNLOAD_MARK}="1"]`;
  let located = await evalOn(args, targetId, downloadEntryExpression(wanted));
  if (!located.ok) throw new Error(`找不到 ${wanted} 的操作行里的「下载」入口（${describeEntryMiss(located)}）`);
  console.log(`[fetch] 入口 = 第 ${located.actionTrIndex} 行（正是该任务行的操作行）`
    + `｜rect=${JSON.stringify(located.rect)}，center=${JSON.stringify(located.center)}`
    + `｜操作行内叶子 ${located.leavesInActionRow} 个`);
  // 全页可见的「下载」叶子应当恰好 1 个；多了说明有别的行也处于激活态，「下的是哪一条」就不再唯一。
  if (located.visibleDownloads !== 1) {
    console.log(`[fetch] 注意：页面上可见的「下载」共 ${located.visibleDownloads} 个（期望 1 个）`);
  }

  // 不在视口才滚动。**滚动本身会改变显隐状态**（实测滚完那个入口就换了一行），
  // 所以滚完必须重新定位、重新断言，不能拿滚动前的坐标继续用。
  if (!located.inViewport) {
    await evalOn(args, targetId, scrollIntoViewExpression(entrySelector));
    await delay(1200);
    located = await evalOn(args, targetId, downloadEntryExpression(wanted));
    if (!located.ok) throw new Error(`滚动后入口不再可定位（${describeEntryMiss(located)}）`);
    console.log(`[fetch] 原位置在视口外，滚动后重新定位：rect=${JSON.stringify(located.rect)}`
      + `，center=${JSON.stringify(located.center)}`);
  }

  // 复核与点击之间只隔一次往返：这一页「量到点」之间页面会动，差一行（41px）就点空。
  const hit = await hitCheck(args, targetId, entrySelector);
  if (!hit.ok) throw new Error(`「下载」复核未通过（${describeHitMiss(hit)}）`);
  // 排练开关：选行 + 定位 + 复核都走一遍，但不点下载。
  // 选行是排练的**必要**步骤（不然操作行不显形，排练会「通过」而真跑失败），
  // 所以排练结束要把勾选状态恢复原样 —— 排练的语义是「只读」，不能留下状态改动。
  if (args.locateOnly) {
    const restored = await evalOn(args, targetId, restoreCheckboxesExpression(boxesBefore.checked));
    console.log(`[fetch] --locate-only：入口已定位并复核通过（${describeHitPass(hit)}），未点击；`
      + `勾选状态已恢复（改动 ${restored.changed} 项，现为 ${JSON.stringify(restored.checked)}）`);
    return;
  }
  const point = pointOf(hit);
  console.log(`[fetch] 复核通过（${describeHitPass(hit)}）→ 真实鼠标点击 (${point.join(',')}) → `
    + `${(await clickPoint(args, targetId, point)).slice(0, 80)}`);

  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await delay(3000);
    const fresh = newEntries(before, listDownloads(args.downloads, PROMOTION_ZIP_PATTERN).map((entry) => entry.name));
    if (fresh.length) {
      const newest = pickNewest(listDownloads(args.downloads, PROMOTION_ZIP_PATTERN)
        .filter((entry) => fresh.includes(entry.name)));
      // 新文件必须就是**目标任务**那一份。页面上「下载」按钮并没有「下载哪一条」的显式表述
      // （靠的是哪一行被激活），万一落到别的任务上，就要在这里抓住，而不是拿一份错的源文件
      // 往下走 —— 错源文件的后果是静默写错数据。
      if (!(newest.name === `${wanted}.zip` || newest.name.startsWith(`${wanted} (`))) {
        throw new Error(`落盘的不是目标任务：期望 ${wanted}.zip，实得 ${newest.name}`
          + '（下载的对象与预期不符，停在这里比继续更省事）');
      }
      console.log(`[fetch] 新文件：${newest.name}（${newest.size} bytes）`);
      console.log(`[fetch] promotionZipPath = ${path.join(args.downloads, newest.name)}`);
      return;
    }
    console.log(`[fetch] 等待下载… ${Math.round((args.timeoutMs - (deadline - Date.now())) / 1000)}s`);
  }
  throw new Error(`${args.timeoutMs}ms 内没等到新 zip：判据取文件系统，页面说「生成成功」不算数`);
}

// 勾选目标任务行：**点之前先确认那一点真的是这个复选框**。
// 2026-09-17 实测踩到：页面上一个 z-index 999999 的浮层正好压住第一行，`elementFromPoint` 命中的是
// 浮层里的 TD —— 真实点击落在浮层上、复选框纹丝不动，而这一页**点错不报错**（只表现为 30 秒空等）。
// 浮层会自己收起来，所以「等一会儿、重新量、再点」就过了；把它做成显式重试，而不是让调用方去猜。
async function selectTargetRow(args, targetId, taskName, firstRow) {
  const attempts = args.selectAttempts;
  const described = (row) => `${row.checkboxHitTag ?? '?'}`
    + `${row.checkboxHitClass ? `.${row.checkboxHitClass}` : ''}`;
  let row = firstRow;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (row.checkboxHit === false) {
      console.log(`[fetch] 第 ${attempt}/${attempts} 次：复选框中心被 ${described(row)} 挡住，`
        + '等一会儿重试（不硬点 —— 这一页点错不报错）');
    } else {
      console.log(`[fetch] 真实鼠标点它的复选框 (${row.checkboxCenter.join(',')}) → `
        + `${(await clickPoint(args, targetId, row.checkboxCenter)).slice(0, 80)}`);
      await delay(1500);
      const after = await evalOn(args, targetId, targetRowExpression(taskName));
      if (after.checked) {
        const now = await evalOn(args, targetId, checkboxStateExpression());
        console.log(`[fetch] 回读 checked=true，当前勾选 = ${JSON.stringify(now.checked)}`);
        return after;
      }
      row = after;
      console.log(`[fetch] 第 ${attempt}/${attempts} 次点击没生效（回读 checked=false）`);
    }
    if (attempt < attempts) {
      await delay(1200);
      row = await evalOn(args, targetId, targetRowExpression(taskName));
      if (!row.found) throw new Error(`重试勾选时找不到 ${taskName} 那一行（${row.reason}）`);
    }
  }
  throw new Error(`勾选 ${taskName} 失败（试了 ${attempts} 次都回读 checked=false；`
    + `最后一次中心命中 ${described(row)}）—— 它的操作行不会显形，取件必然落空，停在这里比继续更省事`);
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
