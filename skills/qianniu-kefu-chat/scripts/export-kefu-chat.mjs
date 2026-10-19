#!/usr/bin/env node
// 千牛客服聊天记录 · 周采集入口（2026-10-19）
//
// 用法：
//   node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs \
//     [--week last-week | --date YYYY-MM-DD] \
//     [--shops 盖文天猫,里可林天猫,网林天猫,里可林淘宝] \
//     [--lookback-days 30] [--out <目录>] [--evidence <目录>] [--notify|--notify-dry-run]
//
// 设计要点（全部有实测依据，见 SKILL.md）：
//   ① 会话列表按**创建时间**过滤且宽区间会被截断 ⇒ 回溯 + 窗口切 7 天一段查。
//   ② 会话创建早于本周但本周有消息的必须靠回溯捞回来（30 天样本覆盖 100%）。
//   ③ 消息明细没有结束边界 ⇒ 取回后按窗口过滤，某页首条越过窗口末尾就停。
//   ④ userId 取会话行的 userID.appUid；userNick 用 cntaobao<店铺全称>。
//   ⑤ 单店失败不影响其他店；NEEDS_LOGIN / PAGES_ABSENT 退出码 3（要人）。
//   ⑥ 不发静默失败：给了 --notify 就落 alert.json 走共享告警路径。
//
// 环境前提：目标店铺浏览器与代理**已在运行**（本版不负责起停；批次壳负责起停是第二步）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOP_BROWSERS } from '../../../runtime/browser-ports.mjs';
import { SHOP_IDENTITIES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';
import {
  APP_PATH_FRAGMENT, APP_URL, DEFAULT_LOOKBACK_DAYS, MTOP_API,
  buildListChunks, buildShopStats, buildUserNick, classifyDirection, agentNameOf,
  computeShopSideUids, conversationShopUid, conversationCid, dedupeConversations,
  dedupeMessages, filterMessagesToWindow, formatShanghai, inferBuyerUid, normalizeMessage, notifyCommand,
  resolveWeek,
  toIsoDate, transferNamesOf, isRobotCid,
} from './kefu-chat-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_SHOPS = ['盖文天猫', '里可林天猫', '网林天猫', '里可林淘宝'];

// 一次 eval 只推进**一个**会话：整轮最坏耗时 = SESSION_BUDGET_MS + 一次重试，
// 必须稳稳小于代理的 30 秒 CDP 超时（2026-10-19 首轮四家就是死在这：并发 3 个会话
// 各自的硬闸加起来超过 30 秒，被代理整轮掐断）。推进不动就原样留在页内，下一轮续跑。
const SESSION_BUDGET_MS = 18000;
const REQ_TIMEOUT_MS = 6000;
const STALL_LIMIT = 3;

function parseArgs(argv) {
  const out = {
    week: 'last-week', date: null, shops: DEFAULT_SHOPS, lookbackDays: DEFAULT_LOOKBACK_DAYS,
    out: path.join(REPO_ROOT, 'output/kefu-chat'), evidence: null, notify: false, notifyDry: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--week') out.week = String(argv[++i] ?? 'last-week');
    else if (arg === '--date') out.date = String(argv[++i] ?? '');
    else if (arg === '--shops') out.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--lookback-days') out.lookbackDays = Number(argv[++i]);
    else if (arg === '--out') out.out = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--evidence') out.evidence = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--notify') out.notify = true;
    else if (arg === '--notify-dry-run') { out.notify = true; out.notifyDry = true; }
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(out.lookbackDays) || out.lookbackDays < 0) throw new Error('--lookback-days 必须是非负数字');
  return out;
}

function resolveShops(requested) {
  const byFullName = new Map(SHOP_IDENTITIES.map((row) => [row.fullName, row]));
  const out = [];
  for (const name of requested) {
    const key = SHOP_BROWSERS[name] ? name : SHOP_IDENTITIES.find((row) => row.fullName === name)?.key;
    if (!key || !SHOP_BROWSERS[key]) throw new Error(`不认识这家店：${name}（既不是内部叫法，也不是店铺全称）`);
    const identity = SHOP_IDENTITIES.find((row) => row.key === key);
    out.push({
      key,
      fullName: byFullName.get(identity?.fullName)?.fullName ?? identity?.fullName ?? null,
      proxyPort: SHOP_BROWSERS[key].proxyPort,
      browserPort: SHOP_BROWSERS[key].browserPort,
    });
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, { timeoutMs = 10000, body = null, method = 'GET' } = {}) {
  const response = await fetch(url, { method, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`返回非 JSON：${text.slice(0, 200)}`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function makeEval(shop) {
  return async (targetId, expr) => {
    const json = await fetchJson(`http://127.0.0.1:${shop.proxyPort}/eval?target=${targetId}`, {
      method: 'POST', body: expr, timeoutMs: 30000,
    });
    if (json.error) throw new Error(`页内报错：${json.error}`);
    if (typeof json.value !== 'string') {
      throw new Error(`页内返回值不是字符串（原始响应：${JSON.stringify(json).slice(0, 300)}）—— 表达式很可能抛了`);
    }
    return json.value;
  };
}

async function ensureTarget(shop) {
  const tabs = await fetchJson(`http://127.0.0.1:${shop.proxyPort}/targets`, { timeoutMs: 5000 });
  const hit = tabs.find((tab) => String(tab.url ?? '').includes(APP_PATH_FRAGMENT));
  if (hit) return hit.targetId;
  const created = await fetchJson(`http://127.0.0.1:${shop.proxyPort}/new?url=${encodeURIComponent(APP_URL)}&pinned=1`, { timeoutMs: 30000 });
  if (!created?.targetId) throw new Error(`打开聊天记录页失败：${JSON.stringify(created).slice(0, 200)}`);
  return created.targetId;
}

/**
 * 新开的页签 lib.mtop 是异步加载的：读到之前调接口会被当成「页内报错」。
 * 实测开页后约 2-5 秒就绪；给 15 秒耐心，超时才判 PAGES_ABSENT。
 */
async function waitForMtopLib(ev, targetId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const kind = await ev(targetId, `typeof (window.lib && window.lib.mtop && window.lib.mtop.request)`);
      if (kind === 'function') return true;
    } catch { /* 页面还在加载，继续等 */ }
    await sleep(800);
  }
  return false;
}

const listExpr = (beginDate, endDate) => `(async function(){
  try {
    const r = await window.lib.mtop.request({api:'${MTOP_API.conversationList}',v:'1.0',
      data:{selfWwNick:null,targetWwNick:null,beginDate:'${beginDate}',endDate:'${endDate}'}});
    const rows = (r.data && r.data.result) || [];
    return JSON.stringify({ok:true, rows:rows});
  } catch(e) {
    const ret = (e && e.ret && e.ret[0]) || null;
    return JSON.stringify({ok:false, code:(ret && (ret.code || ret.msg)) || String((e && e.message) || e)});
  }
})()`;

async function probeLogin(ev, targetId, endMs) {
  const day = toIsoDate(endMs - 1);
  const key = day.replaceAll('-', '');
  const result = JSON.parse(await ev(targetId, listExpr(key, key)));
  return result;
}

const initExpr = (payload) => `window.__kf=${JSON.stringify(payload)};'init'`;

const stepExpr = () => `(async function(){
  const ex = window.__kf;
  if (!ex) return JSON.stringify({fatal:'no-init'});
  if (!ex.cur) {
    if (ex.idx >= ex.rows.length) return JSON.stringify({allDone:true, idx:ex.idx, total:ex.rows.length, fails:ex.fails, err:ex.err, failedCids:ex.failedCids||[]});
    ex.cur = ex.rows[ex.idx];
    ex.idx += 1;
    ex.msgs = [];
    ex.cursor = ex.weekStart;
    ex.stall = 0;
  }
  const row = ex.cur;
  const deadline = Date.now() + ${SESSION_BUDGET_MS};
  const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  const mtop = function(data){
    return Promise.race([
      window.lib.mtop.request(Object.assign({api:'${MTOP_API.messageList}',v:'1.0'}, data)),
      new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('mtop-request-timeout')); }, ${REQ_TIMEOUT_MS}); }),
    ]);
  };
  for (;;) {
    if (Date.now() > deadline) {
      ex.stall += 1;
      if (ex.stall >= ${STALL_LIMIT}) {
        ex.fails += 1;
        ex.err = 'session-stalled:' + row.cid;
        (ex.failedCids = ex.failedCids || []).push(row.cid);
        ex.cur = null;
        return JSON.stringify({failed:true, cid:row.cid, err:ex.err, idx:ex.idx, total:ex.rows.length, fails:ex.fails, failedCids:ex.failedCids});
      }
      return JSON.stringify({pending:true, cid:row.cid, idx:ex.idx, total:ex.rows.length, fails:ex.fails});
    }
    let r;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        r = await mtop({data:{userNick:ex.userNick, cid:row.cid, userId:row.uid, cursor:ex.cursor, forward:true, count:100, needRecalledContent:true}});
        break;
      } catch (e) {
        if (attempt === 1) {
          ex.fails += 1;
          ex.err = String((e && e.ret && e.ret[0] && (e.ret[0].code || e.ret[0].msg)) || (e && e.message) || e).slice(0, 200);
          (ex.failedCids = ex.failedCids || []).push(row.cid);
          ex.cur = null;
          return JSON.stringify({failed:true, cid:row.cid, err:ex.err, idx:ex.idx, total:ex.rows.length, fails:ex.fails, failedCids:ex.failedCids});
        }
        await sleep(800);
      }
    }
    const d = (r && r.data) || {};
    const batch = d.userMessages || [];
    let beyond = false;
    for (const m of batch) {
      const t = Number(m.sendTime);
      if (t >= ex.weekEnd) { beyond = true; continue; }
      if (t >= ex.weekStart) ex.msgs.push(m);
    }
    const more = d.hasMore === true || d.hasMore === 'true';
    if (beyond || !more) {
      const session = {cid:row.cid, uid:row.uid, displayName:row.displayName, createTime:row.createTime, modifyTime:row.modifyTime, messages:ex.msgs};
      ex.cur = null;
      ex.msgs = [];
      return JSON.stringify({session:session, idx:ex.idx, total:ex.rows.length, fails:ex.fails, err:ex.err});
    }
    ex.cursor = d.nextCursor;
  }
})()`;

async function collectShop(shop, week, options, evidenceDir) {
  const startedAt = new Date().toISOString();
  const record = { key: shop.key, fullName: shop.fullName, status: 'FAILED', error: null, stats: null, files: [], startedAt };
  const ev = makeEval(shop);

  let targetId;
  try {
    targetId = await ensureTarget(shop);
  } catch (error) {
    record.status = 'BROWSER_DOWN';
    record.error = `浏览器/代理不可用（端口 ${shop.proxyPort}）：${error.message}`;
    return record;
  }

  if (!(await waitForMtopLib(ev, targetId))) {
    record.status = 'PAGES_ABSENT';
    record.error = '聊天记录页已打开但 15 秒内没就绪（window.lib.mtop 不可用）——人工看一眼该窗口';
    return record;
  }

  const login = await probeLogin(ev, targetId, week.endMs);
  if (login.ok !== true) {
    const code = String(login.code ?? '');
    record.status = /SESSION_EXPIRED|SESSION|LOGIN/iu.test(code) ? 'NEEDS_LOGIN' : 'LIST_FAILED';
    record.error = `聊天记录接口不可用：${code}`;
    return record;
  }

  // ① 会话列表：回溯窗口按 7 天切块，避免宽区间被截断。
  const chunks = buildListChunks({ startMs: week.startMs, endMs: week.endMs, lookbackDays: options.lookbackDays });
  const rows = [];
  for (const chunk of chunks) {
    let result = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = JSON.parse(await ev(targetId, listExpr(chunk.beginDate, chunk.endDate)));
        if (result.ok) break;
      } catch (error) {
        result = { ok: false, code: error.message };
      }
      await sleep(1200);
    }
    if (!result?.ok) {
      record.status = 'LIST_FAILED';
      record.error = `会话列表查询失败（${chunk.beginDate}~${chunk.endDate}）：${result?.code ?? 'unknown'}`;
      return record;
    }
    rows.push(...result.rows);
  }
  const conversations = dedupeConversations(rows);

  // ② 消息明细：只取窗口内的消息；窗口外的一律丢弃。
  const payload = {
    rows: conversations.map((row) => ({
      cid: conversationCid(row),
      uid: conversationShopUid(row),
      displayName: row.displayName ?? null,
      createTime: Number(row.createTime),
      modifyTime: Number(row.modifyTime),
    })),
    idx: 0, fails: 0, err: null, failedCids: [],
    userNick: buildUserNick(shop.fullName),
    weekStart: week.startMs,
    weekEnd: week.endMs,
  };
  await ev(targetId, initExpr(payload));

  const rawDir = path.join(evidenceDir, 'raw', shop.key);
  fs.mkdirSync(rawDir, { recursive: true });
  let dumped = 0;

  /**
   * 跑一遍「逐会话取消息」。一次 eval 推进一个会话，推进不动的留在页内下一轮续跑。
   * 失败（重试过仍拿不到）的 cid 收集起来，整遍结束后再给一次机会 ——
   * 实测这种失败是长跑中的瞬时抖动：单独重放同一条会话 100-200ms 就成功、消息数为 0。
   */
  const runPass = async (passRows, label) => {
    await ev(targetId, initExpr({ ...payload, rows: passRows, idx: 0, fails: 0, err: null, failedCids: [] }));
    let status = { idx: 0, total: passRows.length, fails: 0, err: null, failedCids: [] };
    let loopError = null;
    for (let guard = 0; guard < 20000; guard += 1) {
      let next;
      try {
        next = JSON.parse(await ev(targetId, stepExpr()));
      } catch (error) {
        loopError = error.message;
        break;
      }
      if (next.fatal) { loopError = `页内状态丢失：${next.fatal}`; break; }
      status = {
        idx: Number(next.idx ?? status.idx),
        total: Number(next.total ?? status.total),
        fails: Number(next.fails ?? status.fails),
        err: next.err ?? status.err,
        failedCids: next.failedCids ?? status.failedCids ?? [],
      };
      if (next.allDone) break;
      if (next.session) {
        fs.writeFileSync(path.join(rawDir, `part-${label}-${String(dumped).padStart(4, '0')}.json`), JSON.stringify([next.session]));
        dumped += 1;
        continue;
      }
      if (next.failed) continue;
      if (next.pending) { await sleep(80); continue; }
      break;
    }
    return { ...status, loopError };
  };

  const pass1 = await runPass(payload.rows, 'p1');
  let failedCids = pass1.failedCids ?? [];
  let lastErr = pass1.err;
  if (failedCids.length) {
    const retryRows = payload.rows.filter((row) => failedCids.includes(row.cid));
    const pass2 = await runPass(retryRows, 'p2');
    failedCids = pass2.failedCids ?? [];
    lastErr = pass2.err ?? lastErr;
  }
  const last = { idx: pass1.idx, total: pass1.total, fails: failedCids.length, err: lastErr, failedCids };
  if (pass1.loopError || pass1.idx < pass1.total) {
    record.status = 'COLLECT_FAILED';
    record.error = `没采完：${pass1.idx}/${pass1.total}（重试后仍失败 ${failedCids.length} 场，最后错误 ${lastErr ?? pass1.loopError ?? '-'}）`;
  }

  // ③ 归一化：去重、过滤窗口、方向判定、客服名。
  const byCid = new Map();
  for (const file of fs.readdirSync(rawDir).filter((name) => name.endsWith('.json')).sort()) {
    const part = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
    for (const session of part) {
      const prev = byCid.get(session.cid);
      if (!prev || session.messages.length > prev.messages.length) byCid.set(session.cid, session);
    }
  }
  const sessions = [...byCid.values()].map((session) => {
    const messages = dedupeMessages(filterMessagesToWindow(
      (session.messages ?? []).map(normalizeMessage),
      week.startMs, week.endMs,
    )).sort((a, b) => a.sendTime - b.sendTime);
    return {
      cid: session.cid,
      shopUid: session.uid ?? null,
      buyerUid: null,
      displayName: session.displayName ?? null,
      createTime: Number(session.createTime),
      modifyTime: Number(session.modifyTime),
      messages,
    };
  }).filter((session) => session.messages.length > 0);

  // 店侧 uid 先定（会话行店账号 + 昵称带冒号的发送方），再据此推断每场买家。
  const shopSideUids = computeShopSideUids(sessions);
  for (const session of sessions) {
    session.buyerUid = inferBuyerUid(session, shopSideUids);
    for (const message of session.messages) {
      message.dir = classifyDirection({
        senderUid: message.senderUid, senderName: message.senderName,
        buyerUid: session.buyerUid, shopSideUids, shopName: shop.fullName,
      });
      message.agentName = message.dir === 'agent' ? agentNameOf(message.senderName, shop.fullName) : null;
      for (const name of transferNamesOf(message.text)) {
        if (!session.servingAgents) session.servingAgents = [];
        if (!session.servingAgents.includes(name)) session.servingAgents.push(name);
      }
      if (message.dir === 'agent' && message.agentName) {
        if (!session.servingAgents) session.servingAgents = [];
        if (!session.servingAgents.includes(message.agentName)) session.servingAgents.push(message.agentName);
      }
    }
    session.servingAgents = session.servingAgents ?? [];
    session.isRobot = isRobotCid(session.cid);
    session.startText = session.messages.length ? formatShanghai(session.messages[0].sendTime) : '';
    session.endText = session.messages.length ? formatShanghai(session.messages[session.messages.length - 1].sendTime) : '';
    session.msgCount = session.messages.length;
  }

  const stats = buildShopStats(sessions);
  const normalizedFile = path.join(evidenceDir, 'shops', `${shop.key}.json`);
  fs.mkdirSync(path.dirname(normalizedFile), { recursive: true });
  fs.writeFileSync(normalizedFile, JSON.stringify({
    shop: shop.fullName, key: shop.key, week: { start: week.startDate, end: week.endDate, weekId: week.weekId },
    lookbackDays: options.lookbackDays, shopSideUids,
    failedCids: last.failedCids ?? [],
    stats, sessions,
  }, null, 1));

  record.stats = stats;
  record.files.push(path.relative(REPO_ROOT, normalizedFile).replaceAll('\\', '/'));
  if (record.status !== 'COLLECT_FAILED') record.status = 'OK';
  record.failedSessionCids = last.failedCids ?? [];
  record.error = record.error ?? (last.fails
    ? `${last.fails} 场会话失败（已跳过：${(last.failedCids ?? []).join(',') || last.err || '-'}）`
    : null);
  record.finishedAt = new Date().toISOString();
  return record;
}

function currentVersion() {
  try { return fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8').trim(); } catch { return 'unknown'; }
}

async function notify({ week, summaryFile, failed, paused, shops, dryRun = false }) {
  const alertId = `kefu-week-${week.weekId}`;
  const ok = !failed && !paused;
  const alertFile = path.join(path.dirname(summaryFile), ok ? 'alert-ok.json' : 'alert.json');
  const failedShops = shops.filter((shop) => shop.status !== 'OK');
  const body = {
    type: ok ? 'KEFU_WEEKLY_OK' : 'KEFU_WEEKLY_FAILED',
    severity: ok ? 'INFO' : 'ERROR',
    title: ok
      ? `【客服聊天记录】已收齐（${week.label}）`
      : `【客服聊天记录】没收齐（${week.label}）`,
    alertId,
    fingerprint: failedShops.map((shop) => `${shop.key}:${shop.status}`).join('|') || 'OK',
    createdAt: new Date().toISOString(),
    source: { targetLabel: `${week.label} 客服聊天记录`, period: week.weekId, capability: '客服聊天记录' },
    reason: ok
      ? `共 ${shops.filter((s) => s.status === 'OK').length} 家店，会话 ${shops.reduce((n, s) => n + (s.stats?.sessions ?? 0), 0)} 场、消息 ${shops.reduce((n, s) => n + (s.stats?.messages ?? 0), 0)} 条。`
      : failedShops.map((shop) => `${shop.fullName ?? shop.key}：${shop.status}${shop.error ? `（${shop.error}）` : ''}`).join('；'),
    action: ok ? '无需处理。' : '按状态处理：NEEDS_LOGIN 需在对应店铺窗口人工登录；BROWSER_DOWN 需先起浏览器；其余看证据目录。',
    tech: {
      runId: path.basename(path.dirname(summaryFile)),
      evidenceDir: path.relative(REPO_ROOT, path.dirname(summaryFile)).replaceAll('\\', '/'),
      stage: 'kefu-collect',
      exitCode: ok ? 0 : 1,
      version: currentVersion(),
    },
  };
  fs.writeFileSync(alertFile, `${JSON.stringify(body, null, 2)}\n`);
  const { spawnSync } = await import('node:child_process');
  const command = notifyCommand({
    nodePath: process.execPath,
    notifyScript: path.join(REPO_ROOT, 'runtime/notify-feishu.mjs'),
    alertFile,
    dryRun,
  });
  const sent = spawnSync(command.file, command.args, command.options);
  return {
    ok: sent.status === 0,
    out: (sent.stdout || sent.stderr || (sent.error ? String(sent.error.message) : '') || '').trim().slice(0, 800),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs [--week last-week|--date YYYY-MM-DD] [--shops a,b] [--lookback-days 30] [--out dir] [--evidence dir] [--notify|--notify-dry-run]');
    return 0;
  }
  const week = resolveWeek({ date: options.date, lastWeek: options.date ? false : true });
  const shops = resolveShops(options.shops);
  const runId = `${week.weekId}-${Date.now()}`;
  const evidenceDir = options.evidence ?? path.join(REPO_ROOT, 'evidence', `kefu-chat-${week.weekId}`, runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  console.log(`[kefu] 周 ${week.label}（lookback ${options.lookbackDays} 天），${shops.length} 家店`);
  const records = [];
  for (const shop of shops) {
    let record;
    try {
      record = await collectShop(shop, week, options, evidenceDir);
    } catch (error) {
      // 单店意外异常只记在这家店头上，绝不拖垮整轮（2026-10-19 首轮就是被一家店拖死的）。
      record = {
        key: shop.key, fullName: shop.fullName, status: 'FAILED',
        error: `采集过程异常：${error.message}`, stats: null, files: [],
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      };
    }
    records.push(record);
    console.log(`[kefu] ${shop.fullName ?? shop.key}：${record.status}`
      + `${record.stats ? ` 会话 ${record.stats.sessions} 消息 ${record.stats.messages}` : ''}`
      + `${record.error ? ` —— ${record.error}` : ''}`);
  }

  const paused = records.some((r) => r.status === 'NEEDS_LOGIN' || r.status === 'PAGES_ABSENT');
  const failed = records.some((r) => r.status !== 'OK');
  const summary = {
    workflow: 'kefu-chat',
    week: { weekId: week.weekId, start: week.startDate, end: week.endDate, label: week.label },
    runId,
    lookbackDays: options.lookbackDays,
    startedAt: records[0]?.startedAt ?? null,
    finishedAt: new Date().toISOString(),
    status: failed ? (paused ? 'PAUSED_FOR_HUMAN' : 'FAILED') : 'COMPLETED',
    shops: records,
  };
  const summaryFile = path.join(evidenceDir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`[kefu] 证据目录：${path.relative(REPO_ROOT, evidenceDir)}`);

  if (options.notify) {
    const result = await notify({ week, summaryFile, failed, paused, shops: records, dryRun: options.notifyDry });
    if (options.notifyDry) {
      console.log('[kefu] 通知：DRY_RUN（未发送），将发出的原文如下：');
      console.log(result.out);
    } else {
      console.log(`[kefu] 通知：${result.ok ? 'SENT' : 'FAILED'} ${result.ok ? '' : result.out}`);
    }
  }
  if (!failed) return 0;
  return paused ? 3 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[kefu] 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
