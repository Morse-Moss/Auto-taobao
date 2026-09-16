import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';

// 集成测试：直连**本项目乙（商家浏览器）**的 CDP 代理，动真实剪贴板与真实浏览器标签。
// 端口从登记表取 —— 原先写死的是别的项目的共享代理（别人的浏览器 + 别人的登录态）。
const base = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;

function setClipboard(text) {
  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeClipboard {
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr hMem);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr hMem);
}
'@
$text = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::Unicode.GetBytes($text + [char]0)
if (-not [NativeClipboard]::OpenClipboard([IntPtr]::Zero)) { throw 'OpenClipboard failed' }
try {
  [void][NativeClipboard]::EmptyClipboard()
  $size = [UIntPtr]::new([uint64]$bytes.LongLength)
  $memory = [NativeClipboard]::GlobalAlloc(2, $size)
  if ($memory -eq [IntPtr]::Zero) { throw 'GlobalAlloc failed' }
  $pointer = [NativeClipboard]::GlobalLock($memory)
  if ($pointer -eq [IntPtr]::Zero) { throw 'GlobalLock failed' }
  try { [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length) }
  finally { [void][NativeClipboard]::GlobalUnlock($memory) }
  if ([NativeClipboard]::SetClipboardData(13, $memory) -eq [IntPtr]::Zero) { throw 'SetClipboardData failed' }
} finally {
  [void][NativeClipboard]::CloseClipboard()
}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    input: text,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || 'failed to set system clipboard');
}

async function findTarget(title) {
  const response = await fetch(`${base}/targets`);
  assert.equal(response.status, 200, 'target discovery must succeed');
  const targets = await response.json();
  const target = targets.find(candidate => candidate.type === 'page' && candidate.title === title);
  assert.ok(target, `target ${title} must exist`);
  return target.targetId;
}

const missingTarget = await fetch(`${base}/paste?target=missing-target`, { method: 'POST' });
assert.equal(missingTarget.status, 400, 'unknown targets must be rejected');

const help = await fetch(`${base}/help`);
assert.equal(help.status, 200, 'proxy help must expose the paste endpoint');
const helpText = await help.text();
assert.match(helpText, /\/paste\?target=/, 'help must document paste endpoint');
assert.match(helpText, /\/key\?target=/, 'help must document key endpoint');
assert.match(helpText, /\/chooseFile\?target=/, 'help must document file chooser endpoint');
assert.match(helpText, /\/hover\?target=/, 'help must document hover endpoint');

const nonce = Date.now();
const title = `codex-paste-integration-${nonce}`;
const text = `paste-${nonce}\talpha\r\nsecond-row\tbeta`;
const page = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>${title}</title><textarea id="target" autofocus></textarea><input id="file" type="file"><div id="hover" onmouseenter="window.hovered=(window.hovered||0)+1">hover</div>`)}`;
const created = await fetch(`${base}/new?url=${encodeURIComponent(page)}`);
assert.equal(created.status, 200, 'temporary paste target must be created');
const tempDir = mkdtempSync(path.join(os.tmpdir(), 'codex-choose-file-'));
const tempFile = path.join(tempDir, 'fixture.txt');
writeFileSync(tempFile, 'fixture');

try {
  let target = await findTarget(title);
  const focused = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: "document.querySelector('#target').focus(); true",
  });
  assert.equal(focused.status, 200, 'temporary textarea must be focused');

  setClipboard(text);
  target = await findTarget(title);
  const pasted = await fetch(`${base}/paste?target=${target}`, { method: 'POST' });
  assert.equal(pasted.status, 200, 'paste request must succeed');

  target = await findTarget(title);
  const inspected = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: "document.querySelector('#target').value",
  });
  assert.equal(inspected.status, 200, 'temporary textarea must be readable');
  const { value } = await inspected.json();
  assert.equal(value, text.replaceAll('\r\n', '\n'), 'real Ctrl+V must insert the clipboard text');

  target = await findTarget(title);
  const singleLine = `key-${nonce}`;
  const resetCaret = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: `document.querySelector('#target').value = ${JSON.stringify(singleLine)}; document.querySelector('#target').setSelectionRange(0, 0); true`,
  });
  assert.equal(resetCaret.status, 200, 'temporary textarea caret must be reset');

  target = await findTarget(title);
  const keyed = await fetch(`${base}/key?target=${target}`, {
    method: 'POST',
    body: JSON.stringify({ key: 'End' }),
  });
  assert.equal(keyed.status, 200, 'allowlisted key request must succeed');

  target = await findTarget(title);
  const caret = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: "document.querySelector('#target').selectionStart",
  }).then(response => response.json());
  assert.equal(caret.value, singleLine.length, 'End must move the caret to the end');

  target = await findTarget(title);
  const rejectedKey = await fetch(`${base}/key?target=${target}`, {
    method: 'POST',
    body: JSON.stringify({ key: 'F5' }),
  });
  assert.equal(rejectedKey.status, 400, 'non-allowlisted keys must be rejected');

  target = await findTarget(title);
  const chosen = await fetch(`${base}/chooseFile?target=${target}`, {
    method: 'POST',
    body: JSON.stringify({ selector: '#file', files: [tempFile] }),
  });
  assert.equal(chosen.status, 200, 'file chooser request must succeed');

  target = await findTarget(title);
  const chosenName = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: "document.querySelector('#file').files[0]?.name || ''",
  }).then(response => response.json());
  assert.equal(chosenName.value, 'fixture.txt', 'file chooser must populate the selected file');

  target = await findTarget(title);
  const hovered = await fetch(`${base}/hover?target=${target}`, {
    method: 'POST',
    body: JSON.stringify({ selector: '#hover' }),
  });
  assert.equal(hovered.status, 200, 'hover request must succeed');

  target = await findTarget(title);
  const hoverCount = await fetch(`${base}/eval?target=${target}`, {
    method: 'POST',
    body: 'window.hovered || 0',
  }).then(response => response.json());
  assert.equal(hoverCount.value, 1, 'hover must dispatch one mouseenter event');

} finally {
  const target = await findTarget(title).catch(() => null);
  if (target) await fetch(`${base}/close?target=${target}`);
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('paste endpoint contract passed');
