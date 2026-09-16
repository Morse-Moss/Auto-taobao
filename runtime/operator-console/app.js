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

// 只读按钮：一期所有动作都没有后端，所以一律 disabled + 说明，绝不渲染成「点了会有事」。
function stubButton(text, opts = {}) {
  return h('button', {
    class: [opts.primary ? 'primary' : null, opts.optional ? 'opt' : null].filter(Boolean).join(' '),
    disabled: true,
    title: opts.why ?? '一期是只读页面，按钮还没有接后端动作',
  }, text);
}

const state = { env: null, accounts: null, runs: null, selectedPeriod: null, selectedRoute: null, selectedChain: 'faq' };

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `${path} → HTTP ${response.status}`);
  return payload;
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
    h('b', { text: '只读页面：' }),
    h('span', { text: '所有状态都从既有文件读，页面自己不算；按钮点了不会有动作（下一期接）。' }),
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
      stubButton('全部检查', { primary: true }),
      h('span', { class: 'tiny', text: '体检是只读探针，一次只跑一遍、失败不重试（失败重试是风控的加速器）。' })),
    h('div', { class: 'tiny', style: 'margin-top:6px' },
      '这一块接上真实体检之后：一个列内的卡串行跑（同一个 profile 上并发多个动作会互相抢焦点），两列之间可以并行。'));
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
  const periodSelect = h('select', { onchange: (event) => { state.selectedPeriod = event.target.value; renderProgress(); } },
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
      stubButton('预览这次会做什么'),
      stubButton('开始', { primary: true }),
      h('span', { class: 'tiny', text: '一期只读：启动入口要等每条链都有自己的 operator CLI（G6）才接。' })),
    greyBox({
      headline: '「预览」为什么是灰的',
      reason: '预览要先探队列（READY 有活 / EMPTY 今天没活 / WAITING_HUMAN 等你扫码 / 探测失败），'
        + '这套语义在 runtime/sop-runtime/capability-scheduler.mjs 里已经写好，但它还没有生产调用方。'
        + '没有探针就点「开始」，就是把「今天没活」和「等你扫码」都渲染成失败 —— 运营会开始乱点。',
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
      actions: [],
    });
  }
  for (const run of state.runs.runs) {
    if (run.available && run.blocker) {
      items.push({
        lamp: 'red', real: true,
        what: `${run.period} 卡在商品 ${run.blocker.productId}`,
        why: `${run.blocker.code}：${run.blocker.message}`,
        actions: [{ text: '去处理' }],
      });
    }
    if (run.available && run.stale) {
      items.push({
        lamp: 'amber', real: true,
        what: `${run.period} 的快照是 ${fmtAge(run.ageMs)}的，可能不代表现在的状态`,
        why: '这一轮还没跑完，快照会过期。重新跑一次状态检查再看。',
        actions: [{ text: '重新检查' }],
      });
    }
    if (!run.available && run.reasonCode === 'STATUS_FILE_INCONSISTENT') {
      items.push({
        lamp: 'red', real: true,
        what: `${run.period} 的状态快照自相矛盾，判不出进度`,
        why: `${run.reason}（读的是 ${run.sourcePath}）`,
        actions: [{ text: '去处理' }],
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
    if (item.actions.length === 0) actions.append(h('span', { class: 'tiny', text: '这一步需要先有后端动作，一期没有可点的键。' }));
    for (const action of item.actions) actions.append(stubButton(action.text));
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
  foot.append(h('div', { text: '本页不产生任何状态：所有灯都来自上面这些文件；取不到就显示灰并写明理由。' }));
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
    const [env, accounts, runs] = await Promise.all([getJson('/api/env'), getJson('/api/accounts'), getJson('/api/runs')]);
    state.env = env; state.accounts = accounts; state.runs = runs;
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
