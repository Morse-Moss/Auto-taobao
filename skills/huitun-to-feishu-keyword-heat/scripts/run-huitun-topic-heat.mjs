#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  advanceQuerySettlement,
  assertProxyBrowserHealth,
  assertAuthorizedMutation,
  buildQueueBinding,
  buildUpdatePlan,
  candidateKeyword,
  canonicalEqual,
  classifyTopicSnapshot,
  detectHumanRequired,
  HUITUN_RESULT_SCHEMA_VERSION,
  HUITUN_RESULT_SOURCE,
  hasConfirmedAccount,
  parseOptions,
  plain,
  resultSnapshotSignature,
  selectCandidates,
  selectRunTarget,
  validateResultDocument,
  verifyBackfill,
} from './flow.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const API_ROOT = 'https://open.feishu.cn/open-apis';
const OFFICIAL_URL = 'https://dy.huitun.com/app/#/dashboard';
const XHS_TOPIC_URL = 'https://xhs.huitun.com/#/anchor/anchor_topic';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function helpText() {
  return `Usage: node run-huitun-topic-heat.mjs [options]

Reads the complete Feishu A候选 queue, collects exact-name topic views from
灰豚数据红薯版, and prepares or applies a protected topic-view backfill.

Options:
  --app-token ID              Feishu Base app token
  --table-id ID               Required weekly Feishu table ID
  --table-name TEXT           Required exact weekly table name
  --env-file FILE             File containing FEISHU_APP_ID and FEISHU_APP_SECRET
  --proxy URL                 CDP proxy URL (default: this project's merchant-chain Proxy in
                              runtime/browser-ports.mjs; do not borrow another project's proxy)
  --browser-id ID             Expected proxy browser id (default: edge-daily-report)
  --output-dir DIR            Run evidence directory root
  --results FILE              Reuse a collected result file and skip browser collection
  --result-max-age-hours N    Reject reused results older than N hours (default: 24)
  --max-candidates N          Refuse an unexpectedly large queue (default: 50)
  --fallback-b                Use the explicitly authorized strict B fallback when no A queue exists
  --poll-seconds N            Result stability poll interval (default: 1)
  --query-timeout-seconds N   Per-keyword deadline (default: 30)
  --apply                     Write the one authorized field after dry-run validation
  --confirm-table ID          Required with --apply and must equal --table-id
  --self-test                 Run network-free checks
  --help                      Show this help

Rows with blank 优先级 or 优先级=待数据 stop with AI_REQUIRED before browser work.
Without --apply, the command is read-only apart from local evidence files.
`;
}

function humanRequired(reason, details = {}) {
  const error = new Error(reason);
  error.code = 'HUMAN_REQUIRED';
  error.details = details;
  return error;
}

function stalled(reason, details = {}) {
  const error = new Error(reason);
  error.code = 'STALLED';
  error.details = details;
  return error;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function safeSegment(value) {
  return String(value || 'run').replace(/[^\w\u4e00-\u9fff-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50) || 'run';
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

function writeJson(file, value, flag = 'w') {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag });
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret, appToken, tableId }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.tableId = tableId;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu authentication failed: ${response.status} ${payload.msg ?? ''}`.trim());
    }
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, apiPath, body) {
    const response = await fetch(`${API_ROOT}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      const safePath = apiPath.replace(`/apps/${this.appToken}`, '/apps/<redacted>');
      throw new Error(`Feishu API failed: ${method} ${safePath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?page_size=100`)).items ?? [];
  }

  async listFields() {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields?page_size=100`)).items ?? [];
  }

  async listRecords() {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async apply(plan) {
    const apiPath = `/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/batch_update`;
    const body = { records: plan.updates };
    assertAuthorizedMutation({
      appToken: this.appToken,
      tableId: this.tableId,
      method: 'POST',
      apiPath,
      body,
      plan,
    });
    return this.request('POST', apiPath, body);
  }
}

function requiredField(fields, name, type) {
  const matches = fields.filter((field) => field.field_name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  if (type != null && matches[0].type !== type) {
    throw new Error(`${name} expected field type ${type}; received ${matches[0].type}`);
  }
  return matches[0];
}

async function inspectAuthorizedTable(api, options) {
  const tables = await api.listTables();
  const table = tables.find((item) => item.table_id === options.tableId);
  if (table?.name !== options.tableName) {
    throw new Error(`Authorized table mismatch: expected ${options.tableName}, received ${table?.name ?? '<missing>'}`);
  }
  const [fields, records] = await Promise.all([api.listFields(), api.listRecords()]);
  requiredField(fields, '搜索词');
  requiredField(fields, '内容热度', 1);
  requiredField(fields, '灰豚话题浏览量', 2);
  requiredField(fields, '优先级', 20);
  return { fields, records };
}

async function proxyRequest(proxy, endpoint, options = {}) {
  const response = await fetch(`${proxy}${endpoint}`, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Proxy returned invalid JSON for ${endpoint}`);
  }
  if (!response.ok || data?.error) {
    const detail = String(data?.error || text || '').replace(/[\r\n]+/gu, ' ').slice(0, 300);
    throw new Error(`Proxy ${endpoint} failed${detail ? `: ${detail}` : ''}`);
  }
  return data;
}

async function listTargets(proxy) {
  const data = await proxyRequest(proxy, '/targets');
  return Array.isArray(data) ? data : (Array.isArray(data?.value) ? data.value : []);
}

class HuitunBrowser {
  constructor({ proxy, runLabel, pollMs, queryTimeoutMs, runDir, log }) {
    this.proxy = proxy;
    this.runLabel = runLabel;
    this.pollMs = pollMs;
    this.queryTimeoutMs = queryTimeoutMs;
    this.runDir = runDir;
    this.log = log;
    this.opened = false;
  }

  async open() {
    await listTargets(this.proxy);
    await proxyRequest(this.proxy, `/new?url=${encodeURIComponent(OFFICIAL_URL)}&label=${encodeURIComponent(this.runLabel)}`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await this.target();
        this.opened = true;
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error('Timed out waiting for the labeled Huitun tab');
  }

  async target() {
    return selectRunTarget(await listTargets(this.proxy), this.runLabel);
  }

  async evaluate(expression) {
    const target = await this.target();
    const data = await proxyRequest(this.proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: expression,
    });
    return data?.value;
  }

  async clickAt(selector) {
    const target = await this.target();
    return proxyRequest(this.proxy, `/clickAt?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: selector,
    });
  }

  async clickDom(selector) {
    const target = await this.target();
    return proxyRequest(this.proxy, `/click?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: selector,
    });
  }

  // 坐标精确点击。为什么不复用 clickAt：clickAt 是「自己算 rect 中心再点」，中间隔着一次
  // 网络往返，目标在这段时间里动过就会点空且不报错；这里要的是「先复核过命中点，再按这个点打」。
  async clickPoint({ x, y }) {
    const target = await this.target();
    return proxyRequest(this.proxy, `/clickPoint?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ x, y }),
    });
  }

  async screenshot(name) {
    const target = await this.target();
    const file = path.join(this.runDir, name);
    await proxyRequest(this.proxy, `/screenshot?target=${encodeURIComponent(target.targetId)}&file=${encodeURIComponent(file)}`);
    return file;
  }

  async close() {
    if (!this.opened) return;
    const target = await this.target();
    await proxyRequest(this.proxy, `/close?target=${encodeURIComponent(target.targetId)}`);
    this.opened = false;
  }

  async inspectPage() {
    return this.evaluate(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
          && rect.width > 0 && rect.height > 0;
      };
      const riskPattern = /验证码|滑块验证|安全验证|账号异常|风控|访问受限|操作频繁|无权限|权限不足|扫码登录|登录\\/注册|请登录|微信登录|短信验证/u;
      const candidates = [...document.querySelectorAll('[role=dialog],.ant-modal-wrap,.ant-message-notice-content,.ant-notification-notice,.ant-drawer,[class*=captcha],[class*=Captcha],[class*=verify],[class*=Verify],button,a')];
      const visibleTexts = candidates.filter(visible).map((element) => (element.innerText || '').trim())
        .filter((text) => text && text.length <= 500 && riskPattern.test(text));
      const accountText = [...document.querySelectorAll('header,header *,[class*=header],[class*=header] *')].filter(visible)
        .map((element) => (element.innerText || '').trim()).find((text) => /(?:DY[0-9]+|ID[:： ]*[0-9]+)/u.test(text)) || '';
      return { title: document.title, url: location.href, visibleTexts, accountText };
    })()`);
  }

  async ensureAllowed({ requireAccount = false, stage }) {
    const snapshot = await this.inspectPage();
    const blocker = detectHumanRequired(snapshot);
    if (blocker) throw humanRequired(`${stage} requires user action`, blocker);
    if (requireAccount && !hasConfirmedAccount(snapshot.accountText)) {
      throw humanRequired(`${stage} login state could not be confirmed`, { code: 'LOGIN_REQUIRED' });
    }
    return snapshot;
  }

  async waitForAccount({ stage, allowLogin = false }) {
    let snapshot;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      snapshot = await this.inspectPage();
      const blocker = detectHumanRequired(snapshot, { allowLogin });
      if (blocker) throw humanRequired(`${stage} requires user action`, blocker);
      if (hasConfirmedAccount(snapshot.accountText)) return snapshot;
      await sleep(300);
    }
    throw humanRequired(`${stage} login state could not be confirmed`, { code: 'LOGIN_REQUIRED' });
  }

  async dismissMarketingModal() {
    const marked = await this.evaluate(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const modal = [...document.querySelectorAll('.ant-modal-wrap')].find((element) => {
        const text = element.innerText || '';
        return visible(element) && /免费领会员|立即领取|拉新领会员/u.test(text)
          && !/登录|验证码|安全验证|权限/u.test(text);
      });
      if (!modal) return false;
      modal.setAttribute('data-huitun-marketing-modal', '1');
      return true;
    })()`);
    if (!marked) return false;
    await this.evaluate(`(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      window.dispatchEvent(event);
    })()`);
    await sleep(300);
    let stillVisible = await this.evaluate(`(() => {
      const modal = document.querySelector('[data-huitun-marketing-modal="1"]');
      if (!modal) return false;
      const style = getComputedStyle(modal);
      const rect = modal.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })()`);
    if (stillVisible) {
      await this.clickDom('[data-huitun-marketing-modal="1"]');
      await sleep(300);
      stillVisible = await this.evaluate(`(() => {
        const modal = document.querySelector('[data-huitun-marketing-modal="1"]');
        if (!modal) return false;
        const style = getComputedStyle(modal);
        const rect = modal.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })()`);
    }
    if (stillVisible) throw humanRequired('灰豚新人营销弹窗无法自动关闭', { code: 'MARKETING_MODAL' });
    this.log('MARKETING_MODAL_DISMISSED');
    return true;
  }

  async switchToRedBook() {
    let target = await this.target();
    if (new URL(target.url).origin === 'https://xhs.huitun.com') return;
    await this.waitForAccount({ stage: '灰豚官网', allowLogin: true });
    await this.dismissMarketingModal();
    const triggerMarked = await this.evaluate(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll('header *,[class*=header] *,button,[role=button],span[class*="header_link"][class*="dropdown-trigger"],[class*=header] img[src*="logo_dy"]')]
        .filter(visible)
        .filter((element) => /(?:抖音|红薯|抖泰|平台).{0,4}版$/u.test((element.innerText || '').trim())
          || /header_link.*dropdown-trigger/u.test(String(element.className))
          || /logo_dy/u.test(element.src || ''))
        .sort((left, right) => left.getBoundingClientRect().width - right.getBoundingClientRect().width);
      const target = candidates[0];
      if (!target) return false;
      const trigger = target.closest('span[class*="header_link"][class*="dropdown-trigger"]') || target;
      trigger.setAttribute('data-huitun-platform-trigger', '1');
      return true;
    })()`);
    if (triggerMarked) await this.clickAt('[data-huitun-platform-trigger="1"]');
    else await this.clickAt('span.antd-pro-components-mod-basic-header-index-header_link.ant-dropdown-trigger');
    let marked = false;
    const menuDeadline = Date.now() + 5_000;
    while (Date.now() < menuDeadline && !marked) {
      marked = await this.evaluate(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const image = [...document.querySelectorAll('.ant-dropdown-menu-item img')]
        .find((element) => visible(element) && /logo_xhs/i.test(element.src || ''));
      const item = image?.closest('.ant-dropdown-menu-item');
      if (!item) return false;
      item.setAttribute('data-huitun-xhs-platform', '1');
      return true;
      })()`);
      if (!marked) await sleep(200);
    }
    if (!marked) throw new Error('The visible red-book platform option was not found');
    await this.clickAt('[data-huitun-xhs-platform="1"]');

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      target = await this.target();
      if (new URL(target.url).origin === 'https://xhs.huitun.com') {
        this.log('PLATFORM_READY', { platform: '灰豚数据红薯版' });
        return;
      }
      await sleep(500);
    }
    throw new Error('Timed out switching to 灰豚数据红薯版');
  }

  async openTopicSearch() {
    await this.waitForAccount({ stage: '灰豚红薯版' });
    const confirmTopicSearch = async () => {
      const ready = await this.evaluate(`Boolean(document.querySelector('input[placeholder="请输入话题关键词"]'))`);
      if (!ready) return false;
      await this.ensureAllowed({ requireAccount: true, stage: '灰豚话题搜索' });
      this.log('TOPIC_SEARCH_READY', { url: XHS_TOPIC_URL });
      return true;
    };

    let target = await this.target();
    if (target.url.includes('#/anchor/anchor_topic') && await confirmTopicSearch()) return;

    // 这一步为什么不能「标个属性再点」：话题入口在「热门内容」子菜单里，展开带动画，锚点在动画
    // 中途会漂；按 rect 中心盲点一下，点空了既不报错、页面也不动，只能干等到超时。
    // 2026-09-21 实测 4 次里 3 次这样静默失败（锚点明明可见、URL 30 秒不变）。
    // 所以改成：滚进视口 → 用 elementFromPoint 复核「这一点真的落在锚点上」→ 才点 → 点完看它跳没跳。
    // 判据本身仍是 page-contract.md 的 `a[href="#/anchor/anchor_topic"]`，这里只补「点得着」与「点了有反应」。
    const deadline = Date.now() + 30_000;
    let clicks = 0;
    let lastMiss = 'not-attempted';
    while (Date.now() < deadline) {
      const point = await this.evaluate(`(() => {
        const link = document.querySelector('a[href="#/anchor/anchor_topic"]');
        if (!link) return { ok: false, reason: 'anchor-missing' };
        link.scrollIntoView({ block: 'center' });
        const rect = link.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'anchor-collapsed' };
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { ok: true, x, y,
          hitIsTarget: Boolean(hit) && (hit === link || link.contains(hit)),
          hitDesc: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 60) : 'none' };
      })()`);
      if (!point?.ok) {
        lastMiss = point?.reason || 'anchor-unreadable';
        await this.clickDom('div.ant-menu-submenu-title[aria-controls$="sub8-popup"]');
        await sleep(300);
        continue;
      }
      if (!point.hitIsTarget) {
        lastMiss = `point hits ${point.hitDesc}`;
        await sleep(250);
        continue;
      }
      clicks += 1;
      await this.clickPoint({ x: point.x, y: point.y });
      this.log('TOPIC_ENTRY_CLICKED', { attempt: clicks, x: Math.round(point.x), y: Math.round(point.y) });
      const settle = Date.now() + 4_000;
      let navigated = false;
      while (Date.now() < settle) {
        target = await this.target();
        if (target.url.includes('#/anchor/anchor_topic')) { navigated = true; break; }
        await sleep(250);
      }
      if (!navigated) {
        lastMiss = 'clicked but did not navigate';
        continue;
      }
      // 换了 hash 不等于页面就绪（SPA 先改路由、再渲染表格）。这里必须等，不能只查一次就
      // 回头再点一遍 —— 那会打出一个假的 attempt=2，让「重试到底有没有救场」变成看不出来的事。
      const render = Date.now() + 3_000;
      while (Date.now() < render) {
        if (await confirmTopicSearch()) return;
        await sleep(250);
      }
      lastMiss = 'navigated but the topic input did not render';
    }
    throw new Error(`Timed out opening 灰豚话题搜索 (clicks=${clicks}, lastMiss=${lastMiss})`);
  }

  async readSearchSnapshot() {
    return this.evaluate(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
          && rect.width > 0 && rect.height > 0;
      };
      const riskPattern = /验证码|滑块验证|安全验证|账号异常|风控|访问受限|操作频繁|无权限|权限不足|扫码登录|登录\\/注册|请登录|微信登录|短信验证/u;
      const visibleTexts = [...document.querySelectorAll('[role=dialog],.ant-modal-wrap,.ant-message-notice-content,.ant-notification-notice,.ant-drawer,[class*=captcha],[class*=Captcha],[class*=verify],[class*=Verify],button,a')]
        .filter(visible).map((element) => (element.innerText || '').trim())
        .filter((text) => text && text.length <= 500 && riskPattern.test(text));
      const rows = [...document.querySelectorAll('tbody.ant-table-tbody tr.ant-table-row')]
        .filter(visible).map((row) => [...row.querySelectorAll(':scope > td')].map((cell) => (cell.innerText || '').trim()));
      const empty = [...document.querySelectorAll('.ant-table-placeholder')].find(visible);
      const loading = [...document.querySelectorAll('.ant-spin-spinning')].filter(visible).length;
      return {
        query: document.querySelector('input[placeholder="请输入话题关键词"]')?.value || '',
        rows,
        emptyText: (empty?.innerText || '').trim(),
        loading,
        visibleTexts,
      };
    })()`);
  }

  async search(keyword) {
    this.log('QUERY_STARTED', { keyword });
    const value = JSON.stringify(keyword);
    const set = await this.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="请输入话题关键词"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${value});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === ${value};
    })()`);
    if (!set) throw new Error(`Could not set the Huitun topic keyword: ${keyword}`);
    const before = await this.readSearchSnapshot();
    if (before.query !== keyword) throw new Error(`Huitun query changed unexpectedly: expected ${keyword}, received ${before.query}`);
    const preSignature = resultSnapshotSignature(before);
    const preLoading = Number(before.loading) > 0;
    await this.clickAt('button.ant-input-search-button');

    const deadline = Date.now() + this.queryTimeoutMs;
    let state = {};
    while (Date.now() < deadline) {
      const snapshot = await this.readSearchSnapshot();
      const blocker = detectHumanRequired(snapshot);
      if (blocker) throw humanRequired(`灰豚查询 ${keyword} requires user action`, blocker);
      const settled = advanceQuerySettlement({ keyword, preSignature, preLoading, state, snapshot });
      state = settled.state;
      if (settled.result) {
        const result = settled.result;
        this.log('QUERY_DONE', { keyword, status: result.status, topic: result.topic, viewsRaw: result.viewsRaw, views: result.views });
        return result;
      }
      await sleep(state.transitionSeen ? this.pollMs : Math.min(this.pollMs, 250));
    }
    const screenshot = await this.screenshot(`stalled-${safeSegment(keyword)}.png`).catch(() => null);
    throw stalled(`Huitun query did not settle before the deadline: ${keyword}`, { keyword, screenshot });
  }
}

function buildResultDocument(items, targetBinding) {
  return {
    schemaVersion: HUITUN_RESULT_SCHEMA_VERSION,
    source: {
      ...HUITUN_RESULT_SOURCE,
      collected_at: new Date().toISOString(),
    },
    target: targetBinding,
    items,
  };
}

function summarizePlan(plan) {
  return plan.expected.map((item) => ({
    keyword: item.keyword,
    status: item.status,
    topic: item.topic,
    viewsRaw: item.viewsRaw,
    contentHeat: item.contentHeat,
    views: item.desired.灰豚话题浏览量,
    expectedPriority: item.expectedPriority,
    willWrite: plan.updates.some((update) => update.record_id === item.recordId),
  }));
}

export function buildAiRequiredManifest({ runId, options, snapshot, error, runDir }) {
  if (error?.code !== 'AI_REQUIRED') throw new Error('AI_REQUIRED manifest requires an AI_REQUIRED error');
  return {
    status: 'AI_REQUIRED',
    runId,
    target: { tableId: options.tableId, tableName: options.tableName },
    fieldCount: snapshot.fields.length,
    recordCount: snapshot.records.length,
    pendingCount: Number(error.details?.pendingCount ?? 0),
    runDir,
  };
}

function writeBackup({ runDir, options, fields, records, resultDocument }) {
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    tableId: options.tableId,
    fields,
    records,
    resultDocument,
  }, null, 2)}\n`;
  const backupPath = path.join(runDir, `before-backfill-${stamp()}.json`);
  fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
  return { path: backupPath, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function waitForFormulaSettlement(api, plan) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const records = await api.listRecords();
    const byId = new Map(records.map((record) => [record.record_id, record]));
    const settled = plan.expected.every((item) => {
      const value = byId.get(item.recordId)?.fields?.优先级;
      return plain(value) === item.expectedPriority;
    });
    if (settled) return records;
    await sleep(1_000);
  }
  throw new Error('Feishu priority formulas did not settle within 60 seconds');
}

function selfTest() {
  const options = parseOptions(['--self-test']);
  const exact = classifyTopicSnapshot({ keyword: '家用浴缸', rows: [['#家用浴缸#', '109.4w']], emptyText: '' });
  const noExact = classifyTopicSnapshot({ keyword: '家用浴缸', rows: [['#成人家用浴缸#', '9.5w']], emptyText: '' });
  const records = [{ record_id: 'r1', fields: { 搜索词: '家用浴缸', 优先级: 'A候选' } }];
  const binding = buildQueueBinding({ appToken: 'app', tableId: 'table', tableName: 'test', records });
  const resultDocument = buildResultDocument([exact], binding);
  let provenance = true;
  let plan;
  try {
    plan = buildUpdatePlan({
      records,
      resultDocument,
      resultContext: { binding, maxAgeMs: options.resultMaxAgeMs, nowMs: Date.now() },
    });
  } catch {
    provenance = false;
  }
  const apiPath = '/bitable/v1/apps/app/tables/table/records/batch_update';
  let mutation = true;
  try {
    assertAuthorizedMutation({ appToken: 'app', tableId: 'table', method: 'POST', apiPath, body: { records: plan.updates }, plan });
  } catch {
    mutation = false;
  }
  return {
    ok: true,
    checks: {
      options: options.apply === false && options.tableId === '' && options.tableName === '',
      exactMatch: exact.views === 1_094_000 && exact.topic === '#家用浴缸#',
      noExact: noExact.views === 0 && noExact.topic === null,
      risk: detectHumanRequired({ visibleTexts: ['请完成滑块验证'] })?.code === 'CAPTCHA'
        && detectHumanRequired({ visibleTexts: [] }) === null,
      provenance,
      mutation,
    },
  };
}

async function run(options) {
  const runId = `${stamp()}-${safeSegment(options.tableName)}`;
  const runtimeRoot = path.resolve(options.outputDir || path.join(PROJECT_ROOT, 'runtime', 'huitun-runs'));
  const runDir = path.join(runtimeRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  const log = (event, details = {}) => {
    const record = { at: new Date().toISOString(), event, ...details };
    console.log(JSON.stringify(record));
    fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const proxyHealth = await proxyRequest(options.proxy, '/health');
  assertProxyBrowserHealth(proxyHealth, options.browserId);
  log('PROXY_READY', { browser: proxyHealth.browser.id });

  log('START', { tableId: options.tableId, tableName: options.tableName, apply: options.apply });
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    tableId: options.tableId,
  });
  await api.authenticate();

  let snapshot = await inspectAuthorizedTable(api, options);
  let candidates;
  try {
    candidates = selectCandidates(snapshot.records, { mode: options.candidateMode });
  } catch (error) {
    if (error.code === 'AI_REQUIRED') {
      const manifest = buildAiRequiredManifest({ runId, options, snapshot, error, runDir });
      writeJson(path.join(runDir, 'manifest.json'), manifest);
      log('AI_REQUIRED', { pendingCount: manifest.pendingCount, runDir });
    }
    throw error;
  }
  if (candidates.length > options.maxCandidates) {
    throw new Error(`A-candidate queue ${candidates.length} exceeds --max-candidates ${options.maxCandidates}`);
  }
  const candidateNames = candidates.map(candidateKeyword);
  log('QUEUE_READY', { candidates: candidateNames.length, keywords: candidateNames });
  if (candidateNames.length === 0) {
    const manifest = {
      status: 'DONE_NO_CANDIDATES',
      runId,
      target: { tableId: options.tableId, tableName: options.tableName },
      fieldCount: snapshot.fields.length,
      recordCount: snapshot.records.length,
      runDir,
    };
    writeJson(path.join(runDir, 'manifest.json'), manifest);
    log('DONE_NO_CANDIDATES', { runDir });
    return manifest;
  }
  const initialBinding = buildQueueBinding({
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    records: snapshot.records,
    candidateMode: options.candidateMode,
  });

  let resultDocument;
  let resultsPath;
  let browser;
  let preserveBrowser = false;
  try {
    if (options.resultsPath) {
      resultsPath = path.resolve(options.resultsPath);
      resultDocument = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      validateResultDocument({
        document: resultDocument,
        binding: initialBinding,
        maxAgeMs: options.resultMaxAgeMs,
      });
      log('RESULTS_REUSED', { resultsPath });
    } else {
      browser = new HuitunBrowser({
        proxy: options.proxy,
        runLabel: runId,
        pollMs: options.pollMs,
        queryTimeoutMs: options.queryTimeoutMs,
        runDir,
        log,
      });
      await browser.open();
      await browser.switchToRedBook();
      await browser.openTopicSearch();
      const items = [];
      for (const keyword of candidateNames) items.push(await browser.search(keyword));
      resultDocument = buildResultDocument(items, initialBinding);
      resultsPath = path.join(runDir, 'results.json');
      writeJson(resultsPath, resultDocument, 'wx');
      log('RESULTS_WRITTEN', { resultsPath, count: items.length });
      await browser.close();
    }
  } catch (error) {
    preserveBrowser = ['HUMAN_REQUIRED', 'STALLED'].includes(error.code);
    if (browser?.opened && !preserveBrowser) await browser.close().catch(() => {});
    throw error;
  } finally {
    if (browser?.opened && !preserveBrowser) await browser.close().catch(() => {});
  }

  snapshot = await inspectAuthorizedTable(api, options);
  const liveBinding = buildQueueBinding({
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    records: snapshot.records,
    candidateMode: options.candidateMode,
  });
  const plan = buildUpdatePlan({
    records: snapshot.records,
    resultDocument,
    candidateMode: options.candidateMode,
    resultContext: { binding: liveBinding, maxAgeMs: options.resultMaxAgeMs },
  });
  const summary = {
    target: { tableId: options.tableId, tableName: options.tableName },
    fieldCount: snapshot.fields.length,
    recordCount: snapshot.records.length,
    resultsPath,
    plannedRecordUpdates: plan.updates.length,
    results: summarizePlan(plan),
  };

  if (!options.apply) {
    const manifest = { status: 'DRY_RUN_READY', runId, ...summary, runDir };
    writeJson(path.join(runDir, 'manifest.json'), manifest);
    log('DRY_RUN_READY', { plannedRecordUpdates: plan.updates.length, runDir });
    return manifest;
  }

  const backup = writeBackup({ runDir, options, fields: snapshot.fields, records: snapshot.records, resultDocument });
  log('BACKUP_WRITTEN', { path: backup.path, sha256: backup.sha256 });
  if (plan.updates.length > 0) {
    log('APPLY_STARTED', { records: plan.updates.length, fields: ['灰豚话题浏览量'] });
    await api.apply(plan);
  }
  const after = await waitForFormulaSettlement(api, plan);
  const fieldsAfter = await api.listFields();
  if (!canonicalEqual(snapshot.fields, fieldsAfter)) {
    throw new Error('Huitun backfill changed field definitions');
  }
  const verification = verifyBackfill({ before: snapshot.records, after, plan });
  const manifest = {
    status: 'APPLIED_AND_VERIFIED',
    runId,
    ...summary,
    backup,
    verification,
    runDir,
  };
  writeJson(path.join(runDir, 'manifest.json'), manifest);
  log('DONE', { recordsWritten: verification.recordsWritten, runDir });
  return manifest;
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return 0;
    }
    if (options.selfTest) {
      const result = selfTest();
      if (!result.ok || Object.values(result.checks).some((value) => value !== true)) throw new Error('self-test check failed');
      console.log(JSON.stringify(result));
      return 0;
    }
    await run(options);
    return 0;
  } catch (error) {
    const code = error.code || 'FAILED';
    console.error(JSON.stringify({ status: code, error: error.message, details: error.details || {} }));
    return code === 'HUMAN_REQUIRED' ? 2 : code === 'STALLED' ? 3 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { helpText, run, selfTest, waitForFormulaSettlement };
