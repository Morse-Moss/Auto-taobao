#!/usr/bin/env node
// 飞书告警投递 CLI：告警 JSON 从 stdin 进，投递收据 JSON 从 stdout 出。
//
// 契约与仓库现有的 `notifyOperator(command, alert)` 一致（见 runtime/xws-sku-auth-preflight.mjs）：
// 告警以 JSON 形式写进 stdin。**注意**：现有实现用 `spawn(command, [], { shell: false })` 调用，
// 传不了额外参数，所以本 CLI 必须能在「零参数」下工作——所有配置都从
// 飞书 profile 的 env 文件与环境变量读取。
//
// 配置优先级（高 → 低）：命令行参数 > env 文件 > 进程环境变量。
// 之所以让 env 文件压过进程环境：本项目的口径是「飞书目标与凭据以 profile 为单点事实来源」
// （见 runtime/feishu-targets.mjs），部署事实不该被一个临时导出的环境变量悄悄改写。
//
// 退出码：0 = 已送达或 dry-run；1 = 未送达（NOT_CONFIGURED / FAILED）以及自身出错。
// 「没发出去」必须是非零退出码——否则调用方会把一条没送达的告警记成送达。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { activeProfileName, envFilePath, parseEnvFile } from './feishu-targets.mjs';
import { createTokenProvider, deliverAlert, renderAlertText } from './notify-feishu-core.mjs';

const VALUE_OPTIONS = new Map([
  ['--profile', 'profile'],
  ['--env-file', 'envFile'],
  ['--recipient', 'recipient'],
  ['--recipient-type', 'recipientType'],
  ['--fallback-recipient', 'fallbackRecipient'],
  ['--fallback-recipient-type', 'fallbackRecipientType'],
  ['--webhook', 'webhook'],
  ['--alert-file', 'alertFile'],
]);

export function parseNotifyArgs(argv = []) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const key = VALUE_OPTIONS.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function pick(...candidates) {
  for (const candidate of candidates) {
    const normalized = String(candidate ?? '').trim();
    if (normalized) return normalized;
  }
  return null;
}

export function resolveNotifyConfig({ options = {}, values = {}, env = {} } = {}) {
  return {
    recipient: pick(options.recipient, values.SYCM_NOTIFY_RECIPIENT, env.SYCM_NOTIFY_RECIPIENT),
    recipientType: pick(
      options.recipientType,
      values.SYCM_NOTIFY_RECIPIENT_TYPE,
      env.SYCM_NOTIFY_RECIPIENT_TYPE,
      'email',
    ),
    fallbackRecipient: pick(
      options.fallbackRecipient,
      values.SYCM_NOTIFY_FALLBACK_RECIPIENT,
      env.SYCM_NOTIFY_FALLBACK_RECIPIENT,
    ),
    fallbackRecipientType: pick(
      options.fallbackRecipientType,
      values.SYCM_NOTIFY_FALLBACK_RECIPIENT_TYPE,
      env.SYCM_NOTIFY_FALLBACK_RECIPIENT_TYPE,
      'chat_id',
    ),
    webhook: pick(options.webhook, values.SYCM_NOTIFY_WEBHOOK, env.SYCM_NOTIFY_WEBHOOK),
  };
}

export function parseAlertJson(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('alert JSON is required on stdin (or pass --alert-file)');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`alert JSON is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('alert JSON must be an object');
  }
  return parsed;
}

async function readStdin(stdin) {
  if (!stdin || stdin.isTTY === true || typeof stdin[Symbol.asyncIterator] !== 'function') {
    throw new Error('alert JSON is required on stdin (or pass --alert-file)');
  }
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    read = readFileSync,
    fetchImpl = globalThis.fetch,
    write = console.log,
    stdin = process.stdin,
  } = {},
) {
  const options = parseNotifyArgs(argv);
  const profileName = activeProfileName(env);
  const envFile = options.envFile ? resolve(options.envFile) : envFilePath(profileName);
  const values = parseEnvFile(read(envFile, 'utf8'));
  const appId = String(values.FEISHU_APP_ID ?? '').trim();
  const appSecret = String(values.FEISHU_APP_SECRET ?? '').trim();
  if (!appId || !appSecret) {
    throw new Error(`${envFile} must define FEISHU_APP_ID and FEISHU_APP_SECRET`);
  }

  const rawAlert = options.alertFile
    ? read(resolve(options.alertFile), 'utf8')
    : await readStdin(stdin);
  const alert = parseAlertJson(rawAlert);

  if (options.dryRun) {
    const receipt = {
      version: 'feishu-notify-receipt-v1',
      status: 'DRY_RUN',
      text: renderAlertText(alert),
    };
    write(JSON.stringify(receipt, null, 2));
    return receipt;
  }

  const config = resolveNotifyConfig({ options, values, env });
  const receipt = await deliverAlert({
    alert,
    fetchImpl,
    tokenProvider: config.recipient || config.fallbackRecipient
      ? createTokenProvider({ fetchImpl, appId, appSecret })
      : null,
    recipient: config.recipient,
    recipientType: config.recipientType,
    fallbackRecipient: config.fallbackRecipient,
    fallbackRecipientType: config.fallbackRecipientType,
    webhookUrl: config.webhook,
  });
  write(JSON.stringify(receipt, null, 2));
  if (receipt.status !== 'SENT') {
    const error = new Error(`alert not delivered: ${receipt.status}`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: 'FAILED',
      error: String(error?.message ?? error),
      ...(error?.receipt ? { receipt: error.receipt } : {}),
    }));
    process.exitCode = 1;
  });
}
