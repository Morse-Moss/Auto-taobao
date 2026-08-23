import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';

const execFileAsync = promisify(execFile);

const SAFE_METADATA_KEYS = [
  'recordId',
  'productId',
  'productUrl',
  'pageUrl',
  'validity',
  'classification',
  'copiedItem',
  'clickResponseText',
  'copyFeedback',
  'authStatusFile',
];

const AUTH_PREFLIGHT_VERSION = 'xws-sku-auth-preflight-v1';
const AUTH_PREFLIGHT_MAX_AGE_MS = 10 * 60 * 1000;
const WINDOWS_CLIPBOARD_COMMAND = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw';

export function buildWindowsClipboardCommand() {
  return WINDOWS_CLIPBOARD_COMMAND;
}

function safeMetadata(metadata) {
  return Object.fromEntries(SAFE_METADATA_KEYS.flatMap((key) => {
    const value = metadata?.[key];
    return value == null || String(value).trim() === '' ? [] : [[key, String(value)]];
  }));
}

function captureTimestamp(value) {
  const parsed = new Date(value ?? Date.now());
  if (Number.isNaN(parsed.valueOf())) throw new Error('capturedAt must be a valid date');
  return parsed.toISOString();
}

function requiredMetadata(metadata, key) {
  const value = String(metadata?.[key] ?? '').trim();
  if (!value) throw new Error(key + ' is required for clipboard capture');
  return value;
}

async function assertAuthPreflight(authStatusFile, metadata) {
  const filePath = String(authStatusFile ?? '').trim();
  if (!filePath) throw new Error('authStatusFile is required before clipboard capture');
  if (!existsSync(filePath)) throw new Error('SKU auth preflight file is unavailable');
  let status;
  try {
    status = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('SKU auth preflight file is not valid JSON');
  }
  if (status?.version !== AUTH_PREFLIGHT_VERSION || status?.status !== 'AUTH_READY') {
    throw new Error('SKU auth preflight did not pass');
  }
  const checkedAt = Date.parse(String(status.checkedAt ?? ''));
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt < 0 || Date.now() - checkedAt > AUTH_PREFLIGHT_MAX_AGE_MS) {
    throw new Error('SKU auth preflight is stale');
  }
  if (String(status.source?.productId ?? '').trim() !== String(metadata?.productId ?? '').trim()
    || String(status.source?.mainRecordId ?? '').trim() !== String(metadata?.recordId ?? '').trim()) {
    throw new Error('SKU auth preflight source differs from clipboard capture source');
  }
  return status;
}

export async function readWindowsClipboard() {
  if (process.platform !== 'win32') throw new Error('Windows clipboard capture requires Windows');
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildWindowsClipboardCommand(),
    ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return String(result.stdout ?? '');
  } catch {
    throw new Error('Windows clipboard could not be read');
  }
}

export async function persistSkuClipboardCapture({
  outputDirectory,
  rawPayload,
  metadata = {},
  capturedAt,
} = {}) {
  if (!outputDirectory) throw new Error('outputDirectory is required');
  if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
    throw new Error('clipboard payload is empty');
  }

  const timestamp = captureTimestamp(capturedAt);
  const sha256 = createHash('sha256').update(rawPayload, 'utf8').digest('hex');
  const captureId = `${timestamp.replace(/[:.]/gu, '-')}-${sha256.slice(0, 12)}`;
  await mkdir(outputDirectory, { recursive: true });

  const payloadPath = path.join(outputDirectory, `xws-sku-payload-${captureId}.txt`);
  const receiptPath = path.join(outputDirectory, `xws-sku-capture-${captureId}.json`);
  const receipt = {
    captureId,
    capturedAt: timestamp,
    payloadSha256: sha256,
    payloadUtf8Bytes: Buffer.byteLength(rawPayload, 'utf8'),
    payloadCharacterCount: [...rawPayload].length,
    metadata: safeMetadata(metadata),
  };

  await writeFile(payloadPath, rawPayload, 'utf8');
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { captureId, payloadPath, receiptPath, sha256 };
}

export async function captureClipboard({
  outputDirectory,
  metadata = {},
  capturedAt,
  authStatusFile,
  readClipboard = readWindowsClipboard,
} = {}) {
  if (!outputDirectory) throw new Error('outputDirectory is required');
  await assertAuthPreflight(authStatusFile, metadata);
  const copyFeedback = String(metadata?.copyFeedback ?? '').trim();
  if (!/(?:已复制|copied)/iu.test(copyFeedback)) {
    throw new Error('copyFeedback must confirm the SKU copy');
  }
  const normalizedMetadata = {
    ...metadata,
    recordId: requiredMetadata(metadata, 'recordId'),
    productId: requiredMetadata(metadata, 'productId'),
    productUrl: requiredMetadata(metadata, 'productUrl'),
    classification: requiredMetadata(metadata, 'classification'),
    validity: requiredMetadata(metadata, 'validity'),
    copiedItem: String(metadata.copiedItem ?? 'SKU').trim() || 'SKU',
    copyFeedback,
    authStatusFile: path.basename(authStatusFile),
  };
  const rawPayload = await readClipboard();
  const capture = await persistSkuClipboardCapture({
    outputDirectory,
    rawPayload,
    metadata: normalizedMetadata,
    capturedAt,
  });
  const batchIndexPath = await updateSkuBatchIndex({
    directory: outputDirectory,
    source: { ...normalizedMetadata, mainRecordId: normalizedMetadata.recordId },
    artifacts: { payload: capture.payloadPath, captureReceipt: capture.receiptPath },
    status: 'CAPTURED',
    updatedAt: capturedAt,
  });
  return { ...capture, batchIndexPath };
}

export function parseCaptureArgs(argv = []) {
  const options = { metadata: { copiedItem: 'SKU' } };
  const valueOptions = new Map([
    ['--output-directory', 'outputDirectory'],
    ['--record-id', 'recordId'],
    ['--product-id', 'productId'],
    ['--product-url', 'productUrl'],
    ['--page-url', 'pageUrl'],
    ['--validity', 'validity'],
    ['--classification', 'classification'],
    ['--copied-item', 'copiedItem'],
    ['--click-response-text', 'clickResponseText'],
    ['--copy-feedback', 'copyFeedback'],
    ['--auth-status-file', 'authStatusFile'],
    ['--captured-at', 'capturedAt'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = valueOptions.get(argument);
    if (!key) throw new Error('Unknown argument: ' + argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    if (key === 'outputDirectory' || key === 'capturedAt' || key === 'authStatusFile') options[key] = value;
    else options.metadata[key] = value;
    index += 1;
  }
  if (!options.outputDirectory) throw new Error('--output-directory is required');
  if (!options.authStatusFile) throw new Error('--auth-status-file is required');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCaptureArgs(argv);
  const capture = await captureClipboard({
    outputDirectory: options.outputDirectory,
    metadata: options.metadata,
    capturedAt: options.capturedAt,
    authStatusFile: options.authStatusFile,
  });
  console.log(JSON.stringify({
    captureId: capture.captureId,
    payloadPath: capture.payloadPath,
    receiptPath: capture.receiptPath,
    batchIndexPath: capture.batchIndexPath,
    payloadSha256: capture.sha256,
  }, null, 2));
  return capture;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
