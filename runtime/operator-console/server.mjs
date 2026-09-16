#!/usr/bin/env node
// 运营台本地服务（2026-09-16 一期只读读接口 + 二期动作层）。
//
// 四条硬约束：
//   1) **只监听 127.0.0.1**。它渲染的是登录态与运行状态，不出本机。绑 0.0.0.0 就是把这台机器的
//      运营信息暴露到局域网 —— 这个决定写死在代码里，不给开关。
//   2) 端口只从 runtime/browser-ports.mjs 取（PROJECT_PORTS.operatorConsole），
//      用 OPERATOR_CONSOLE_PORT 可显式覆盖，非法值直接抛错而不是静默回落（坑 35）。
//   3) **读接口只收 GET/HEAD，动作用 POST**。写动作不允许藏在 GET 里（一次预取就能触发副作用），
//      读接口也不接受 POST。协议层的分工就是「读」与「改」的分工。
//   4) **动作白名单在服务端**（见 actions.mjs）：命令由服务端从固定表拼出来，请求只允许带周期，
//      永远不拼 shell。页面能改，服务端不能被骗。
//
// 启动：node runtime/operator-console/server.mjs
// 覆盖：OPERATOR_CONSOLE_PORT=19025 node runtime/operator-console/server.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_PORTS, resolvePort } from '../browser-ports.mjs';
import { REPO_ROOT, RUNTIME_ROOT, buildAccountsPayload, buildEnvPayload, buildRunsPayload } from './state.mjs';
import { CONSOLE_ACTIONS, auditLogPath, runAction } from './actions.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// 请求体上限：动作只带一个小 JSON。不设上限等于给本机开一个免费的 OOM 入口。
const BODY_LIMIT = 8 * 1024;

const ACTION_PATH = '/api/actions/';

// 静态文件只认这三个名字。不给路径拼接留口子，也就不存在目录穿越。
const STATIC_FILES = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
});

function json(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

// 只接受 JSON 请求体，且有大小上限。读 HTTP body 必须自己处理这三件事：
//   1) 超过上限就断开，不能让它把内存吃干；
//   2) 空体/坏 JSON 是 400，不是 500（是调用方写错了，不是服务炸了）；
//   3) 读流也要有超时兜底，否则一个只连不发的客户端能挂住一个连接。
function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    if (String(request.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
      rejectBody(Object.assign(new Error('Content-Type 必须是 application/json。'), { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }));
      return;
    }
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => {
      request.destroy();
      rejectBody(Object.assign(new Error('读取请求体超时。'), { statusCode: 408, code: 'BODY_TIMEOUT' }));
    }, 10_000);
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        clearTimeout(timer);
        request.destroy();
        rejectBody(Object.assign(new Error(`请求体超过 ${BODY_LIMIT} 字节上限。`), { statusCode: 413, code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolveBody({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectBody(Object.assign(new Error('请求体必须是一个 JSON 对象。'), { statusCode: 400, code: 'BAD_BODY' }));
          return;
        }
        resolveBody(parsed);
      } catch (error) {
        rejectBody(Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400, code: 'BAD_JSON' }));
      }
    });
    request.on('error', () => {
      clearTimeout(timer);
      rejectBody(Object.assign(new Error('读取请求体失败。'), { statusCode: 400, code: 'BODY_STREAM_ERROR' }));
    });
  });
}

// port 是**实际监听的端口**，必须由调用方（main）在 listen 后传进来：
// 只报登记表里的默认值会在换端口时说出一个自己没在监听的端口（本次就是这样被发现的）。
export function createConsoleServer({ runtimeRoot = RUNTIME_ROOT, repoRoot = REPO_ROOT, port = PROJECT_PORTS.operatorConsole } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;

    // 动作端点：只收 POST。不 decode、不拼路径 —— 名字直接拿去查白名单，认不出就 404。
    if (path.startsWith(ACTION_PATH)) {
      if (request.method !== 'POST') {
        json(response, 405, {
          error: 'METHOD_NOT_ALLOWED',
          message: '动作端点只接受 POST。读用 GET、改用 POST，这是一条不许越过的分工。',
          method: request.method,
          hint: `POST ${path}，Content-Type: application/json`,
        });
        return;
      }
      let params;
      try {
        params = await readJsonBody(request);
      } catch (error) {
        json(response, error.statusCode ?? 400, { error: error.code ?? 'BAD_BODY', message: String(error.message ?? error) });
        return;
      }
      const name = path.slice(ACTION_PATH.length);
      try {
        const { statusCode, payload } = await runAction({ name, params, runtimeRoot, repoRoot });
        json(response, statusCode, payload);
      } catch (error) {
        json(response, 500, { error: 'ACTION_FAILED', message: String(error?.message ?? error), action: name });
      }
      return;
    }

    if (path.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, {
          error: 'METHOD_NOT_ALLOWED',
          message: '读接口只接受 GET/HEAD。要触发动作请用 POST /api/actions/<动作名>。',
          method: request.method,
          actions: Object.keys(CONSOLE_ACTIONS),
        });
        return;
      }
      try {
        if (path === '/api/health') {
          json(response, 200, {
            ok: true,
            console: {
              host: '127.0.0.1',
              port,
              registryPort: PROJECT_PORTS.operatorConsole,
              reads: ['GET /api/health', 'GET /api/env', 'GET /api/accounts', 'GET /api/runs'],
              actions: Object.entries(CONSOLE_ACTIONS).map(([name, spec]) => ({
                name,
                label: spec.label,
                mutating: spec.mutating,
                requiresConfirm: spec.requiresConfirm === true,
                needsPeriod: spec.needsPeriod === true,
              })),
              auditLog: auditLogPath(runtimeRoot),
            },
            runtimeRoot,
            repoRoot,
            now: new Date().toISOString(),
          });
          return;
        }
        if (path === '/api/env') {
          json(response, 200, await buildEnvPayload({ port }));
          return;
        }
        if (path === '/api/accounts') {
          json(response, 200, buildAccountsPayload());
          return;
        }
        if (path === '/api/runs') {
          json(response, 200, buildRunsPayload({ runtimeRoot, repoRoot }));
          return;
        }
        json(response, 404, {
          error: 'UNKNOWN_ENDPOINT',
          message: `没有这个接口：${path}`,
          available: ['/api/health', '/api/env', '/api/accounts', '/api/runs'],
          actions: Object.keys(CONSOLE_ACTIONS).map((name) => `POST /api/actions/${name}`),
        });
      } catch (error) {
        // 探针/读文件炸了也要给一个能看的响应，而不是让页面白屏。
        json(response, 500, {
          error: 'CONSOLE_READ_FAILED',
          message: String(error?.message ?? error),
          endpoint: path,
        });
      }
      return;
    }

    const asset = STATIC_FILES[path];
    if (!asset) {
      json(response, 404, { error: 'NOT_FOUND', message: `没有这个路径：${path}` });
      return;
    }
    try {
      const body = await readFile(resolve(MODULE_DIR, asset.file));
      response.writeHead(200, {
        'content-type': asset.type,
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      json(response, 500, { error: 'ASSET_READ_FAILED', message: String(error?.message ?? error) });
    }
  });
}

export function parseServerArgs(argv = []) {
  const options = { port: resolvePort('OPERATOR_CONSOLE_PORT', PROJECT_PORTS.operatorConsole), host: '127.0.0.1', runtimeRoot: RUNTIME_ROOT, repoRoot: REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`--port 必须是 1-65535 的整数，收到 ${JSON.stringify(argv[index])}`);
      options.port = value;
    } else if (arg === '--runtime-root') {
      const value = argv[++index];
      if (!value) throw new Error('--runtime-root requires a value');
      options.runtimeRoot = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseServerArgs(argv);
  const server = createConsoleServer({ runtimeRoot: options.runtimeRoot, repoRoot: options.repoRoot, port: options.port });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        rejectListen(new Error(`端口 ${options.port} 已被占用。要么关掉占用它的进程，要么用 OPERATOR_CONSOLE_PORT=<另一个端口> 启动。`));
        return;
      }
      rejectListen(error);
    });
    server.listen(options.port, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  console.log(JSON.stringify({
    listening: `http://127.0.0.1:${address.port}`,
    portSource: process.env.OPERATOR_CONSOLE_PORT ? 'OPERATOR_CONSOLE_PORT' : 'runtime/browser-ports.mjs#PROJECT_PORTS.operatorConsole',
    bind: '127.0.0.1（不出本机）',
    reads: 'GET /api/health /api/env /api/accounts /api/runs',
    actions: Object.entries(CONSOLE_ACTIONS).map(([name, spec]) => `POST /api/actions/${name}${spec.requiresConfirm ? '（需确认）' : ''}`),
    auditLog: auditLogPath(options.runtimeRoot),
    runtimeRoot: options.runtimeRoot,
  }, null, 2));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 2; });
}
