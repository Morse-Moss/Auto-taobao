// 运营台前端（2026-09-16 一期）。
//
// 铁律：页面是「只读渲染器 + 动作触发器」，永远不当第二份状态真相。
// 具体到代码上就是两条纪律：
//   1) 所有状态都来自 /api/* 的返回，页面不做任何推断（不自己算有没有登录、不自己排阶段顺序）。
//   2) 只用 textContent 渲染数据，不用 innerHTML —— 状态的原文来自磁盘上的文件，
//      那些文件里可能有任意字符（商品标题、告警文案），拼 HTML 就是把文件内容当代码执行。
//
// 「取不到就显示灰 + 带理由」是本页的核心表现：一个没有理由的灰块等于没有信息。

const h = (tag, attrs, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
const setBody = (id, ...nodes) => { const node = document.getElementById(id); clear(node); node.append(...nodes); return node; };

const LAMP_CLASS = { green: 'lamp-green', amber: 'lamp-amber', red: 'lamp-red', grey: 'lamp-grey', blue: 'lamp-blue' };
const chipClass = (lamp, plain) => (plain ? 'chip chip-plain' : `chip chip-${LAMP_CLASS[lamp] ? lamp : 'grey'}`);
const lampSpan = (lamp) => h('span', { class: `lamp ${LAMP_CLASS[lamp] ?? 'lamp-grey'}` });
const chip = (lamp, text, extra = '') => h('span', { class: `${chipClass(lamp)}${extra ? ` ${extra}` : ''}` }, lampSpan(lamp), h('span', { text }));

function fmtTime(value) {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtAge(ms) {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

// 灰块统一入口：**必须**带理由。没有理由的灰块不许出现（这就是「取不到」与「真没问题」的区别）。
// data-* 是给验收脚本用的稳定选择器：断言不许依赖中文文案，文案改了不该让验收变红/变绿。
function greyBox({ headline, reason, code, sourcePath, lookedFor }) {
  return h('div', { class: 'greybox', 'data-testid': 'grey-box', 'data-reason-code': code ?? '' },
    h('div', { class: 'reason' }, h('b', { text: headline })),
    h('div', { text: reason }),
    code ? h('div', { class: 'code', text: `reasonCode: ${code}` }) : null,
    sourcePath ? h('div', { class: 'code', text: `读的是：${sourcePath}` }) : null,
    !sourcePath && lookedFor ? h('div', { class: 'code', text: `应该读：${lookedFor}（不存在）` }) : null);
}

// 没有后端动作的按钮：一律 disabled + 说清为什么。
// 「假装能点」比「不能点」危险得多 —— 运营会以为系统已经在跑了。
function stubButton(text, opts = {}) {
  return h('button', {
    class: [opts.primary ? 'primary' : null, opts.optional ? 'opt' : null].filter(Boolean).join(' '),
    disabled: true,
    'data-testid': 'stub-button',
    title: opts.why ?? '这个动作还没有后端：理由见同一块里的灰块',
  }, text);
}

const state = {
  env: null, accounts: null, runs: null,
  selectedPeriod: null, selectedRoute: null, selectedChain: 'faq',
  // 这三个是「动作」的状态，不是「运行」的状态 —— 运行状态永远只在磁盘上。
  pendingConfirm: null, actionBusy: null, actionResult: null,
};

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `${path} → HTTP ${response.status}`);
  return payload;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

const periodParams = (period) => {
  const [periodStart, periodEnd] = String(period ?? '').split('_');
  return { periodStart, periodEnd };
};
const actionKey = (action, params) => `${action}|${params?.periodStart ?? ''}_${params?.periodEnd ?? ''}`;

// 动作改的是磁盘上的收据，所以动作之后**必须重读**，绝不能在页面里手动改状态。
async function refreshData() {
  const [env, accounts, runs] = await Promise.all([getJson('/api/env'), getJson('/api/accounts'), getJson('/api/runs')]);
  state.env = env; state.accounts = accounts; state.runs = runs;
}

async function fireAction({ action, params, confirm, rerender }) {
  state.actionBusy = actionKey(action, params);
  state.actionResult = null;
  rerender();
  let outcome;
  try {
    outcome = await postJson(`/api/actions/${action}`, { ...params, ...(confirm ? { confirm: true } : {}) });
  } catch (error) {
    state.actionBusy = null;
    state.actionResult = { key: actionKey(action, params), ok: false, status: 0, payload: { error: 'NETWORK', message: String(error.message ?? error) } };
    rerender();
    return;
  }
  state.actionBusy = null;
  if (outcome.ok) {
    state.pendingConfirm = null;
    state.actionResult = { key: actionKey(action, params), ok: true, payload: outcome.payload };
    try {
      await refreshData();
    } catch (error) {
      state.actionResult.payload = { ...outcome.payload, message: `${outcome.payload.message ?? '动作已完成'}（但重读状态失败：${error.message}）` };
    }
    rerender();
    return;
  }
  // 400 + CONFIRM_REQUIRED = 服务端把「将要执行什么」的原文交回来了。摆给运营看，等他点第二次。
  if (outcome.status === 400 && outcome.payload?.error === 'CONFIRM_REQUIRED') {
    state.pendingConfirm = { key: actionKey(action, params), action, params, preview: outcome.payload, rerender };
    rerender();
    return;
  }
  state.actionResult = { key: actionKey(action, params), ok: false, status: outcome.status, payload: outcome.payload };
  rerender();
}

function actionResultNode(result) {
  const payload = result.payload ?? {};
  return h('div', {
    class: `action-result lamp-${result.ok ? 'green' : 'red'}`,
    'data-testid': 'action-result',
    'data-ok': String(result.ok),
    'data-error': payload.error ?? '',
  },
    h('div', null,
      h('b', { text: result.ok ? '动作已完成：' : `动作被拒（${payload.error ?? `HTTP ${result.status}`}）：` }),
      h('span', { text: payload.message ?? (result.ok ? `下一步 ${payload.nextAction ?? '—'}` : '') })),
    payload.period || payload.nextAction
      ? h('div', { class: 'tiny mono', text: `周期 ${payload.period ?? '—'} · 状态 ${payload.status ?? '—'} · 下一步 ${payload.nextAction ?? '—'}` })
      : null,
    payload.willRun ? h('div', { class: 'tiny mono', text: payload.willRun }) : null,
    payload.reason ? h('div', { class: 'tiny', text: `调度器理由：${payload.reason}` }) : null,
    typeof payload.durationMs === 'number'
      ? h('div', { class: 'tiny', text: `用时 ${Math.round(payload.durationMs / 1000)} 秒 · 审计流水 ${payload.auditPath ?? '（未写）'}` })
      : null,
    payload.stderr ? h('div', { class: 'tiny mono', text: `stderr：${String(payload.stderr).slice(-600)}` }) : null);
}

// 需要确认的动作必须是**两步**：第一次点击只拿到「将要执行什么」，第二次带 confirm:true 才执行。
// 为什么不让按钮一次点到底：推进一格会改收据、动数据，一步到位的按钮在这个场景里是不负责任的。
function actionButton({ text, action, params, primary, optional, confirmLabel, rerender }) {
  const key = actionKey(action, params);
  const busy = state.actionBusy === key;
  if (state.pendingConfirm?.key === key) {
    const preview = state.pendingConfirm.preview;
    return [h('div', { class: 'confirm', 'data-testid': 'confirm-row', 'data-action': action },
      h('div', { class: 'what', text: `这一步会真的推进：${preview.nextAction ?? '（判不出来）'}（当前 ${preview.status ?? '—'}）` }),
      h('div', { class: 'cmd mono', text: preview.willRun ?? '（服务端没有给出将要执行的命令，所以不该确认）' }),
      h('div', { class: 'tiny', text: '推进一格不可撤回；收据与审计流水写在本控制台的 runtime 根目录。' }),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', 'data-testid': 'confirm-yes', disabled: preview.willRun ? null : true, onclick: () => fireAction({ action, params, confirm: true, rerender }) }, confirmLabel ?? '确认执行'),
        h('button', { 'data-testid': 'confirm-no', onclick: () => { state.pendingConfirm = null; rerender(); } }, '取消')))];
  }
  const nodes = [h('button', {
    class: [primary ? 'primary' : null, optional ? 'opt' : null].filter(Boolean).join(' '),
    disabled: busy ? true : null,
    'data-testid': 'action-button',
    'data-action': action,
    'data-busy': String(busy),
    onclick: () => fireAction({ action, params, rerender }),
  }, busy ? `${text}（正在跑…）` : text)];
  if (state.actionResult && state.actionResult.key === key) nodes.push(actionResultNode(state.actionResult));
  return nodes;
}

// ---------------------------------------------------------------------------
// 顶栏与汇总横幅
// ---------------------------------------------------------------------------

function renderTopbar() {
  const { env, runs, accounts } = state;
  const meta = document.getElementById('topbar-meta');
  clear(meta);
  meta.append(
    h('span', { text: `控制台端口 ${env?.console?.port ?? '—'}` }),
    h('span', { text: `浏览器配置 ${env?.browsers?.length ?? 0} 个` }),
    h('span', { text: `读到周期快照 ${runs?.runs?.filter((run) => run.available).length ?? 0} 个` }),
    h('span', { text: `读取于 ${fmtTime(env?.generatedAt)}` }),
  );

  const banner = document.getElementById('banner-summary');
  clear(banner);
  const needing = state.todoItems ?? [];
  const realBlockers = needing.filter((item) => item.real !== false && item.lamp !== 'grey').length;
  const sample = accounts?.probed === false;
  banner.className = `banner ${realBlockers > 0 ? 'banner-warn' : 'banner-info'}`;
  banner.dataset.testid = 'summary-banner';
  banner.dataset.sampleAccounts = String(sample);
  banner.dataset.blockers = String(realBlockers);
  banner.append(
    h('b', { text: '状态只从文件读：' }),
    h('span', { text: '页面自己不算进度、不判登录态。能点的按钮只有三个动作（预览 / 重新检查 / 推进一格），' }),
    h('span', { text: '每一个都真的会去跑对应脚本，执行前会先把命令原文摆给你看。' }),
    sample ? h('span', { text: ' 账号体检尚未接真实检查，那一块是示例数据。' }) : null,
    h('span', { text: ` 当前有 ${realBlockers} 项需要你处理。` }),
  );
}

// ---------------------------------------------------------------------------
// ① 今天
// ---------------------------------------------------------------------------

function renderToday() {
  const runs = state.runs;
  const withStatus = (runs.runs ?? []).filter((run) => run.available);
  const latest = withStatus[0] ?? null;
  const nodes = [
    greyBox({
      headline: '「今天该做什么」暂时给不出',
      reason: '排期器（SOP 里的 round-runner --show-plan）还没有生产调用方，没有可读的排期计划文件。'
        + '这里不放一个猜出来的日期 —— 猜错日期等于跑错周期。',
      code: 'SCHEDULER_NOT_WIRED',
    }),
    h('div', { class: 'spacer-y' }),
  ];
  if (latest) {
    nodes.push(h('div', { class: 'row' },
      h('span', { class: 'tiny', text: '上一次读过状态的周期：' }),
      h('span', { class: 'mono', text: latest.period }),
      chip(latest.stale ? 'amber' : latest.status === 'DONE' ? 'green' : 'amber', latest.status),
      h('span', { class: 'tiny', text: `检查于 ${fmtTime(latest.checkedAt)}（${fmtAge(latest.ageMs)}）` }),
    ));
  } else {
    nodes.push(h('div', { class: 'empty', text: '还没有任何周期快照可读。' }));
  }
  if (withStatus.length > 1) {
    nodes.push(h('div', { class: 'spacer-y' }));
    nodes.push(h('div', { class: 'tiny', text: '所有读到快照的周期（新→旧）：' }));
    const list = h('ul', { class: 'recap' });
    for (const run of withStatus) {
      list.append(h('li', null,
        h('span', { class: 'mono', text: run.period }),
        h('span', { text: ` · ${run.status}${run.available ? ` · 下一步 ${run.nextAction}` : ''} · ${fmtTime(run.checkedAt)}` }),
      ));
    }
    nodes.push(list);
  }
  setBody('today-body', ...nodes);
}

// ---------------------------------------------------------------------------
// ② 账号体检
// ---------------------------------------------------------------------------

function renderAccountLights(lights) {
  const wrap = h('div', { class: 'lights' });
  for (const [key, label] of [['browser', '浏览器'], ['proxy', '代理'], ['config', '配置']]) {
    const light = lights[key];
    wrap.append(chip(light.lamp, `${label}：${light.text}`, 'tiny'));
  }
  return wrap;
}

function renderAccountCard(card) {
  const top = h('div', { class: 'card-top' },
    lampSpan(card.lamp),
    h('span', { class: 'title', text: card.title }),
    card.sample ? h('span', { class: 'chip chip-plain tiny', text: '示例' }) : null,
    card.reserved ? h('span', { class: 'chip chip-plain tiny', text: '预留' }) : null,
    h('span', { class: 'spacer' }),
    h('span', { class: `chip chip-${card.lamp}`, text: card.status ? `${card.statusLabel} · ${card.status}` : card.statusLabel }),
  );
  const actions = h('div', { class: 'actions' });
  if (card.buttons.length === 0) {
    actions.append(h('span', { class: 'tiny', text: card.lamp === 'green' ? '不需要操作' : '没有可点的按钮（正是这条状态的定义）' }));
  } else {
    for (const button of card.buttons) actions.append(stubButton(button.text, { optional: button.optional, primary: button.id === 'open-login' }));
  }
  return h('div', {
    class: `card${card.sample ? ' sample' : ''}${card.reserved ? ' reserved' : ''}`,
    'data-testid': 'account-card',
    'data-account-key': card.accountKey,
    'data-lamp': card.lamp,
    'data-sample': String(card.sample === true),
  },
    top,
    card.note ? h('div', { class: 'note', text: card.note }) : null,
    h('div', { class: 'reason', text: card.reason }),
    h('div', { class: 'meta', text: [
      `检查时间 ${fmtTime(card.checkedAt)}`,
      `证据 ${card.evidencePath ?? '（无）'}`,
      card.checkedAt && Date.now() - Date.parse(card.checkedAt) > 30 * 60 * 1000 ? '可能已过期' : null,
    ].filter(Boolean).join(' · ') }),
    actions);
}

function renderAccounts() {
  const accounts = state.accounts;
  const notice = document.getElementById('accounts-notice');
  clear(notice);
  notice.append(h('div', { class: 'banner banner-warn', 'data-testid': 'sample-notice' }, h('b', { text: '示例数据：' }), h('span', { text: accounts.notice })));
  if (accounts.notYetEmittedStatuses.length > 0) {
    const row = h('div', { class: 'row', style: 'margin:8px 20px 0' });
    row.append(h('span', { class: 'tiny', text: '词表里有、体检还没产出的状态（不许当成已覆盖）：' }));
    for (const status of accounts.notYetEmittedStatuses) row.append(h('span', { class: 'chip chip-plain tiny', text: status }));
    notice.append(row);
  }

  const columns = document.getElementById('accounts-columns');
  clear(columns);
  for (const group of accounts.groups) {
    const column = h('div', {
      class: 'col',
      'data-testid': 'browser-column',
      'data-browser': group.key,
      'data-account-kind': group.account,
    },
      h('div', { class: 'col-head' },
        h('span', { class: 'name', text: group.label }),
        h('span', { class: 'who', text: `身份=${group.account} · profile=${group.profile}` })),
      h('div', { class: 'col-routes', text: group.routesSummary }),
      renderAccountLights(state.env.browsers.find((browser) => browser.key === group.key)?.lights ?? {}),
    );
    for (const card of group.cards) column.append(renderAccountCard(card));
    columns.append(column);
  }

  setBody('accounts-footer',
    h('div', { class: 'row' },
      stubButton('全部检查', { primary: true, why: '还没有「按浏览器 profile 分组探登录态」的探针（G1/G2）。现有体检脚本是商品级的 SKU 检查、不是账号级检查，拿它冒充账号体检只会给出错误的绿灯。' }),
      h('span', { class: 'tiny', text: '接上之后：一个列内的卡串行跑（同一个 profile 上并发多个动作会互相抢焦点），两列之间可以并行；探针一次只跑一遍、失败不重试（失败重试是风控的加速器）。' })),
    h('div', { class: 'tiny', style: 'margin-top:6px' },
      '所以这一块现在没有任何可点按钮：一张示例卡配一个假按钮，比一张灰卡配一句「还没有探针」危险得多。'));
}

// ---------------------------------------------------------------------------
// ③ 启动
// ---------------------------------------------------------------------------

function renderLaunch() {
  const env = state.env;
  const routes = env.routes;
  if (!state.selectedRoute) state.selectedRoute = routes.find((route) => route.browser)?.key ?? routes[0]?.key ?? null;
  const selected = routes.find((route) => route.key === state.selectedRoute) ?? null;
  const periods = (state.runs.runs ?? []).map((run) => run.period);
  const defaultPeriod = state.selectedPeriod ?? state.runs.defaultPeriod ?? '';

  const routeSelect = h('select', { onchange: (event) => { state.selectedRoute = event.target.value; renderLaunch(); } },
    ...routes.map((route) => h('option', { value: route.key, selected: route.key === state.selectedRoute ? true : null },
      `${route.label}${route.browser ? '' : '（不开浏览器）'}`)));
  const periodSelect = h('select', { onchange: (event) => { state.selectedPeriod = event.target.value; renderLaunch(); renderProgress(); } },
    ...(periods.length > 0
      ? periods.map((period) => h('option', { value: period, selected: period === defaultPeriod ? true : null }, period))
      : [h('option', { value: '' }, '（还没有周期记录）')]));

  // 注意：spacer-y 是「12px 高的占位块」，**不能**拿它当内容容器 ——
  // 把内容塞进去会让所有行挤在 12px 里互相压住（第一次渲染就是这样压成一团的）。
  const facts = h('div');
  if (selected) {
    facts.append(h('div', { class: 'row' },
      h('span', { class: 'tiny', text: '这条路线会用到：' }),
      selected.noBrowser
        ? chip('blue', selected.noBrowserReason, 'tiny')
        : chip('grey', `浏览器 ${selected.browser}`, 'tiny'),
      chip('grey', `账号 ${selected.account}`, 'tiny'),
      selected.needsExtension ? chip('amber', `插件 ${selected.needsExtension}`, 'tiny') : null,
    ));
    facts.append(h('div', { class: 'tiny', style: 'margin-top:6px', text: `站点 ${selected.sites.join(' / ')}　脚本 ${selected.skills.length > 0 ? selected.skills.join(' / ') : '（仓库内暂无调用方）'}` }));
  }

  setBody('launch-body',
    h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { text: '路线' }), routeSelect),
      h('div', { class: 'field' }, h('label', { text: '周期' }), periodSelect,
        h('span', { class: 'derived', text: periods.length > 0 ? `实际会用的周期：${defaultPeriod}` : '还没有周期可读' })),
    ),
    h('div', { class: 'spacer-y' }),
    facts,
    h('div', { class: 'row spacer-y' },
      ...actionButton({ text: '预览这次会做什么', action: 'preview-faq', params: periodParams(defaultPeriod), rerender: renderLaunch }),
      ...actionButton({ text: '推进一个阶段', action: 'advance-faq', params: periodParams(defaultPeriod), primary: true, confirmLabel: '确认推进一格', rerender: renderLaunch }),
      h('span', { class: 'tiny', text: '两个都真的会去跑脚本：预览是只读干跑，推进会真的改收据；执行前会把命令原文摆给你确认。' })),
    greyBox({
      headline: '「开始」只做到了「一次推进一格」，还缺什么',
      reason: '链上能自动跑的只有确定性的那几个阶段；浏览器采集与飞书发布一律拒（采集要按 xws-faq-operator 技能做，'
        + '发布必须在命令行用 --authorize-publish 显式授权）。另外「今天该做什么」还缺排期器、'
        + '「点开始前先探队列」还缺队列探针的生产调用方 —— 这两件没接之前，页面不会替它们编一个答案。',
      code: 'QUEUE_PROBE_NOT_WIRED',
    }),
  );
}

// ---------------------------------------------------------------------------
// ④ 进度
// ---------------------------------------------------------------------------

const STAGE_MARK = { done: '✓', current: '▶', pending: '○', skipped: '⤼' };
const STAGE_LABEL = {
  done: '已完成', current: '进行中（下一步就是它）', pending: '未开始', skipped: '跳过',
};

function renderStage(stage) {
  const appearance = stage.skipped ? 'skipped' : stage.complete ? 'done' : stage.current ? 'current' : 'pending';
  return h('div', {
    class: `stage ${appearance}`,
    'data-testid': 'stage',
    'data-stage': appearance,
    'data-stage-name': stage.name,
  },
    h('div', { class: 'mark', text: STAGE_MARK[appearance] }),
    h('div', null,
      h('div', null,
        h('span', { class: 'sname', text: stage.name }),
        h('span', { class: 'stitle', text: `　${STAGE_LABEL[appearance]}${stage.reason ? ` · ${stage.reason}` : ''}` })),
      h('div', { class: 'stitle mono', text: `字段 ${stage.field}` })));
}

function renderProgress() {
  const runs = state.runs;
  const periods = runs.runs.map((run) => run.period);
  const target = state.selectedPeriod ?? runs.defaultPeriod;
  const run = runs.runs.find((item) => item.period === target) ?? null;

  const chainSelect = h('select', { onchange: (event) => { state.selectedChain = event.target.value; } },
    ...runs.availableChains.map((chain) => h('option', { value: chain.key, selected: state.selectedChain === chain.key ? true : null }, chain.label)),
    ...runs.missingChains.map((chain) => h('option', { value: chain.key, disabled: true }, `${chain.label}（还没有阶段清单）`)));
  const periodSelect = h('select', { onchange: (event) => { state.selectedPeriod = event.target.value; renderProgress(); } },
    ...(periods.length > 0
      ? periods.map((period) => h('option', { value: period, selected: period === target ? true : null }, period))
      : [h('option', { value: '' }, '（还没有周期记录）')]));

  const body = [
    h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { text: '链' }), chainSelect),
      h('div', { class: 'field' }, h('label', { text: '周期' }), periodSelect)),
    h('div', { class: 'spacer-y' }),
  ];

  if (!run) {
    body.push(greyBox({
      headline: '这个周期没有可读的进度',
      reason: periods.length > 0 ? '选中的周期没有状态文件。' : '本机还没有任何周期的状态快照。',
      code: periods.length > 0 ? 'NO_STATUS_FILE_IN_PERIOD_DIR' : 'NO_PERIODS',
      lookedFor: 'runtime/faq-analysis/<周期>/operator-status.json',
    }));
  } else if (!run.available) {
    body.push(greyBox({
      headline: `读不出 ${run.period} 的进度`,
      reason: run.reason,
      code: run.reasonCode,
      sourcePath: run.sourcePath,
      lookedFor: run.lookedFor ?? null,
    }));
  } else {
    const kpi = h('div', { class: 'kpi' },
      h('div', null, h('span', { class: 'k', text: '状态' }), h('span', { class: 'v', text: run.status })),
      h('div', null, h('span', { class: 'k', text: '下一步' }), h('span', { class: 'v', text: run.nextAction })),
      h('div', null, h('span', { class: 'k', text: '检查时间' }), h('span', { class: 'v', text: fmtTime(run.checkedAt) })),
      h('div', null, h('span', { class: 'k', text: '距今' }), h('span', { class: 'v', text: fmtAge(run.ageMs) })),
      h('div', null, h('span', { class: 'k', text: '阶段' }), h('span', { class: 'v', text: `${run.stageCounts.done}/${run.stageCounts.total}` })),
    );
    const chips = h('div', { class: 'row' },
      run.stale ? chip('amber', '快照可能已过期', 'tiny') : null,
      run.sourcePath ? h('span', { class: 'chip chip-plain tiny mono', text: `读的是 ${run.sourcePath}` }) : null,
    );
    const stages = h('div', { class: 'stages', 'data-testid': 'stage-list', 'data-period': run.period, 'data-status': run.status });
    for (const stage of run.stages) stages.append(renderStage(stage));
    body.push(kpi, chips, h('div', { class: 'spacer-y' }), stages);
    // 进度块也有动作。注意「推进」只在**读得到**状态时出现：读不到的时候连自己在第几步都不知道，
    // 那时候给一个推进按钮，等于让人在盲区里按按钮。
    body.push(h('div', { class: 'row spacer-y' },
      ...actionButton({ text: '重新检查', action: 'refresh-faq-status', params: periodParams(run.period), rerender: renderProgress }),
      ...actionButton({ text: '推进一个阶段', action: 'advance-faq', params: periodParams(run.period), primary: true, confirmLabel: '确认推进一格', rerender: renderProgress }),
      h('span', { class: 'tiny', text: '「重新检查」只重跑状态检查（会把检查时间刷新）；「推进一个阶段」每次只推一格，推完重新读状态。' })));
  }

  body.push(h('div', { class: 'spacer-y' }));
  if (runs.missingChains.length > 0) {
    body.push(greyBox({
      headline: '其它链暂时没有阶段清单',
      reason: runs.missingChains.map((chain) => `${chain.label}：${chain.reason}`).join('；') + '。一期不给它们编一条假的进度条。',
      code: 'NO_STAGE_LIST_FOR_OTHER_CHAINS',
    }));
  }
  setBody('progress-body', ...body);
}

// ---------------------------------------------------------------------------
// ⑤ 需要你做的事
// ---------------------------------------------------------------------------

function collectTodoItems() {
  const items = [];
  const accounts = state.accounts;
  // 体检未接是**真实**的待办（它决定这个页面现在能信到什么程度），所以列在第一项。
  if (accounts?.probed === false) {
    items.push({
      lamp: 'grey', real: true,
      what: '账号体检还没接真实检查',
      why: accounts.notice,
      // 故意**不**给按钮：接真实体检要先有「按 profile 分组探登录态」的探针（G1/G2），
      // 现在没有，编一个按钮出来只会得到「点了没反应」。
      actions: [],
      noActionReason: '这一项要等「按浏览器 profile 分组探登录态」的探针（G1/G2）接上；现在没有后端可点。',
    });
  }
  for (const run of state.runs.runs) {
    if (run.available && run.blocker) {
      items.push({
        lamp: 'red', real: true,
        what: `${run.period} 卡在商品 ${run.blocker.productId}`,
        why: `${run.blocker.code}：${run.blocker.message}`,
        // 解 blocker 要去那个商品目录里改证据（或清掉告警），不在这个页面里做。
        actions: [],
        noActionReason: '解阻塞要在商品证据目录里处理（改证据或销告警），运营台不代做。',
      });
    }
    if (run.available && run.stale) {
      items.push({
        lamp: 'amber', real: true,
        what: `${run.period} 的快照是 ${fmtAge(run.ageMs)}的，可能不代表现在的状态`,
        why: '这一轮还没跑完，快照会过期。重新跑一次状态检查再看。',
        actions: [{ text: '重新检查', action: 'refresh-faq-status', params: periodParams(run.period) }],
      });
    }
    if (!run.available && run.reasonCode === 'STATUS_FILE_INCONSISTENT') {
      items.push({
        lamp: 'red', real: true,
        what: `${run.period} 的状态快照自相矛盾，判不出进度`,
        why: `${run.reason}（读的是 ${run.sourcePath}）`,
        actions: [{ text: '重新检查', action: 'refresh-faq-status', params: periodParams(run.period) }],
      });
    }
  }
  return items;
}

function renderTodo() {
  const items = collectTodoItems();
  state.todoItems = items;
  const block = document.getElementById('block-todo');
  const list = document.getElementById('todo-list');
  clear(list);
  // 空则整块隐藏（设计文档 §2）。一期因为它总有一项「体检未接」，所以基本不会空。
  block.hidden = items.length === 0;
  for (const item of items) {
    const actions = h('div', { class: 'actions' });
    if (item.actions.length === 0) {
      actions.append(h('span', { class: 'tiny', text: item.noActionReason ?? '这一步还没有后端动作，页面不给一个点了没反应的键。' }));
    }
    for (const action of item.actions) {
      actions.append(...actionButton({ text: action.text, action: action.action, params: action.params, primary: true, rerender: renderTodo }));
    }
    list.append(h('div', {
      class: `todo-item ${item.lamp}`,
      'data-testid': 'todo-item',
      'data-lamp': item.lamp,
    },
      h('div', { class: 'what' }, h('span', { class: `lamp ${LAMP_CLASS[item.lamp]}` }), ' ', item.what),
      h('div', { class: 'why', text: item.why }),
      actions));
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function renderFoot() {
  const foot = document.getElementById('foot');
  clear(foot);
  foot.append(h('div', { text: '真相源：runtime/browser-ports.mjs（分组与端口）· runtime/faq-analysis/<周期>/operator-status.json（进度）· evidence/faq-operator-status-*.json（历史快照）' }));
  foot.append(h('div', { text: '本页不产生任何状态：所有灯都来自上面这些文件；取不到就显示灰并写明理由。动作只触发脚本，脚本写完收据后页面重读。' }));
  foot.append(h('div', { text: `动作审计流水：${state.env?.console?.auditLog ?? 'runtime/operator-console/actions.jsonl'}（每个动作一行，含参数、结果、用时）` }));
  foot.append(h('div', { text: '已接的动作：预览（只读干跑）/ 重新检查（重跑状态检查）/ 推进一个阶段（每次一格，两步确认）。采集与发布不在运营台里，必须去命令行。' }));
}

function renderAll() {
  renderTopbar();
  renderToday();
  renderAccounts();
  renderLaunch();
  renderProgress();
  renderTodo();
  renderTopbar(); // ⑤ 会改变「需要你处理」的计数，重渲染一次横幅
  // 给验收脚本一个「渲染完了」的可靠信号：靠等文案或者 sleep 都不如直接读这个标记。
  document.body.dataset.renderState = 'rendered';
}

async function boot() {
  try {
    await refreshData();
    renderAll();
  } catch (error) {
    document.body.dataset.renderState = 'error';
    const banner = document.getElementById('banner-summary');
    banner.className = 'banner banner-warn';
    clear(banner);
    banner.append(h('b', { text: '读不到后端数据：' }), h('span', { text: String(error.message ?? error) }));
    for (const id of ['today-body', 'accounts-columns', 'launch-body', 'progress-body']) {
      const node = document.getElementById(id);
      if (node) { clear(node); node.append(h('div', { class: 'empty', text: '后端读取失败，见顶部提示。' })); }
    }
  }
  renderFoot();
}

boot();
