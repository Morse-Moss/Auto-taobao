// 只读探针：端口占用（每个连读两次）+ msedge 进程按 user-data-dir 归因。
// 不启停任何进程。输出 JSON 落盘，供 Read 读取（PowerShell stdout 在本机不回显）。
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORTS = [
  19022, 19023,
  19031, 19032, 19033, 19034, 19035,
  19041, 19042, 19043, 19044, 19045,
];

function probeOnce(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ port, listening: true }));
    socket.once('timeout', () => done({ port, listening: false, reason: 'timeout' }));
    socket.once('error', (err) => done({ port, listening: false, reason: err.code || err.message }));
    try {
      socket.connect(port, HOST);
    } catch (err) {
      done({ port, listening: false, reason: err.code || err.message });
    }
  });
}

async function probeTwice(port, gapMs = 700) {
  const first = await probeOnce(port);
  await new Promise((r) => setTimeout(r, gapMs));
  const second = await probeOnce(port);
  return { port, first, second, occupied: first.listening || second.listening };
}

function msedgeProcesses() {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue";',
    '$p = Get-CimInstance Win32_Process -Filter "Name = \'msedge.exe\'" |',
    '  Select-Object ProcessId, CommandLine;',
    'ConvertTo-Json -InputObject @($p) -Depth 3 -Compress',
  ].join(' ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) return { ok: false, error: `powershell exit ${res.status}`, stderr: (res.stderr || '').slice(0, 500) };
  const text = (res.stdout || '').trim();
  if (!text) return { ok: true, raw: [], note: 'powershell 无输出' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}`, head: text.slice(0, 300) };
  }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return { ok: true, raw: list };
}

function attribute(processes) {
  const buckets = new Map();
  const all = [];
  for (const p of processes) {
    const cmd = String(p.CommandLine ?? '');
    const m = cmd.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/i);
    const profile = m ? (m[1] || m[2]) : null;
    const hasType = /--type=([a-z-]+)/i.exec(cmd);
    all.push({ pid: p.ProcessId, profile, type: hasType ? hasType[1] : 'browser(main)' });
    const key = profile ?? '(无 --user-data-dir)';
    if (!buckets.has(key)) buckets.set(key, { profile: key, total: 0, main: 0, children: 0, pids: [] });
    const b = buckets.get(key);
    b.total += 1;
    if (hasType) b.children += 1; else b.main += 1;
    b.pids.push(p.ProcessId);
  }
  return {
    totalMsedge: processes.length,
    distinctProfiles: [...buckets.values()].sort((a, b) => b.total - a.total),
    all,
  };
}

const ports = [];
for (const port of PORTS) ports.push(await probeTwice(port));

const raw = msedgeProcesses();
const result = {
  at: new Date().toISOString(),
  atLocal: new Date().toLocaleString('sv-SE'),
  host: HOST,
  ports,
  occupied: ports.filter((p) => p.occupied).map((p) => p.port),
  free: ports.filter((p) => !p.occupied).map((p) => p.port),
  msedge: raw.ok ? attribute(raw.raw) : raw,
};

const out = process.argv[2] || 'D:/Retire/probe-live/verify-0924-ports.json';
writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
console.log(`written ${out}`);
