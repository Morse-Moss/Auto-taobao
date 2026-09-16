#!/usr/bin/env node
// 运营台本地服务（2026-09-16 一期）。
//
// 三条硬约束：
//   1) **只监听 127.0.0.1**。它渲染的是登录态与运行状态，不出本机。绑 0.0.0.0 就是把这台机器的
//      运营信息暴露到局域网 —— 这个决定写死在代码里，不给开关。
//   2) 端口只从 runtime/browser-ports.mjs 取（PROJECT_PORTS.operatorConsole），
//      用 OPERATOR_CONSOLE_PORT 可显式覆盖，非法值直接抛错而不是静默回落（坑 35）。
//   3) 一期**只读**：只实现 GET。任何写方法一律 405，并且返回一句人话说明为什么。
//      与其让按钮悄悄失败，不如让它在协议层就说清「还没有这个动作」。
//
// 启动：node runtime/operator-console/server.mjs
// 覆盖：OPERATOR_CONSOLE_PORT=19025 node runtime/operator-console/server.mjs

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_PORTS, resolvePort } from '../browser-ports.mjs';
import { REPO_ROOT, RUNTIME_ROOT, buildAccountsPayload, buildEnvPayload, buildRunsPayload } from './state.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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

export function createConsoleServer({ runtimeRoot = RUNTIME_ROOT, repoRoot = REPO_ROOT } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // 明确的「还没有」比一个静默失败好：运营点下去至少知道发生了什么。
        json(response, 405, {
          error: 'METHOD_NOT_ALLOWED',
          message: '运营台一期是只读的：只有 GET。启动与登录窗口要等每条链都有 operator CLI 之后再接。',
          method: request.method,
        });
        return;
      }
      try {
        if (path === '/api/health') {
          json(response, 200, {
            ok: true,
            console: { host: '127.0.0.1', port: PROJECT_PORTS.operatorConsole, readonly: true },
            runtimeRoot,
            repoRoot,
            now: new Date().toISOString(),
          });
          return;
        }
        if (path === '/api/env') {
          json(response, 200, await buildEnvPayload());
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
  const server = createConsoleServer({ runtimeRoot: options.runtimeRoot, repoRoot: options.repoRoot });
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
    mode: 'readonly',
    endpoints: ['/', '/api/health', '/api/env', '/api/accounts', '/api/runs'],
    runtimeRoot: options.runtimeRoot,
  }, null, 2));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 2; });
}
