// 直接用 MCP 协议调用乐享。用法：
//   node runtime/lexiang-mcp.mjs list
//   node runtime/lexiang-mcp.mjs call <toolName> '<json args>'
//   node runtime/lexiang-mcp.mjs raw <json-rpc-method> '<json params>'
import fs from 'node:fs';

const TOKEN = process.env.LEXIANG_TOKEN;
const ENDPOINT = 'https://mcp.lexiang-app.com/mcp';

let cachedSid = null;

async function rpc(method, params = {}, sessionId = null, isNotification = false) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = { jsonrpc: '2.0', id: Date.now(), method, params };
  if (isNotification) delete body.id;
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const sid = res.headers.get('mcp-session-id') ?? sessionId;
  let payload = null;
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (dataLine) { try { payload = JSON.parse(dataLine.slice(6)); } catch {} }
  if (!payload) { try { payload = JSON.parse(text); } catch {} }
  return { status: res.status, sid, payload, raw: text };
}

async function ensureSession() {
  if (cachedSid) return cachedSid;
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sycm-automation', version: '1.0.0' },
  });
  cachedSid = init.sid ?? '';
  if (!cachedSid) process.stderr.write('[note] 服务端未下发 mcp-session-id，按无状态模式继续\n');
  else await rpc('notifications/initialized', {}, cachedSid, true).catch(() => {});
  return cachedSid;
}

function show(payload) {
  if (!payload) return '(no payload)';
  if (payload.result?.content) {
    return payload.result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(payload.result ?? payload.error ?? payload, null, 2);
}

const [mode, a, b] = process.argv.slice(2);
const sid = (await ensureSession()) || null;

if (mode === 'list') {
  const r = await rpc('tools/list', {}, sid);
  const tools = r.payload?.result?.tools ?? [];
  for (const t of tools) {
    console.log(`- ${t.name}: ${(t.description ?? '').split('\n')[0].slice(0, 100)}`);
  }
  if (b === '--full') console.log(JSON.stringify(tools, null, 2));
} else if (mode === 'schema') {
  const r = await rpc('tools/list', {}, sid);
  const t = (r.payload?.result?.tools ?? []).find((x) => x.name === a);
  console.log(JSON.stringify(t, null, 2));
} else if (mode === 'call') {
  let args = {};
  if (b) args = b.trim().startsWith('@') ? JSON.parse(fs.readFileSync(b.slice(1), 'utf8')) : JSON.parse(b);
  const r = await rpc('tools/call', { name: a, arguments: args }, sid);
  console.log(show(r.payload));
  if (r.payload?.error) console.log('RAW:', r.raw.slice(0, 800));
} else if (mode === 'raw') {
  const r = await rpc(a, b ? JSON.parse(b) : {}, sid);
  console.log(JSON.stringify(r.payload ?? r.raw, null, 2).slice(0, 4000));
} else {
  console.log('usage: list | schema <tool> | call <tool> <json|@file> | raw <method> <json>');
}
