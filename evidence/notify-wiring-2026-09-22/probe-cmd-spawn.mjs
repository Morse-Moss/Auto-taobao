// 一次性探针：确认 spawn(<path.cmd>, [], {shell:false}) 在 Windows 上到底行不行。
// 起因：skills/xws-sku-collection/SKILL.md 把 `--notify-command` 描述成「path-to-wrapper」，
// 而 docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md:250 说「.mjs 要当 --notify-command 还得包一个 .cmd」。
// 如果 .cmd 在 shell:false 下根本起不来，那这份「兜底做法」是假的，得写进证据。
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'cmd-spawn-probe-'));
const cmd = join(dir, 'wrapper.cmd');
const mjs = join(dir, 'inner.mjs');
await writeFile(mjs, 'console.log(JSON.stringify({ status: "SENT", from: "inner" }));\n');
await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${mjs}"\r\n`);

function attempt(label, command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => done({ label, error: `${e.code ?? ''} ${e.message}`.trim() }));
    child.on('close', (code) => done({ label, code, out: out.trim().slice(0, 200), err: err.trim().slice(0, 200) }));
    child.stdin.end('');
  });
}

console.log(await attempt('spawn(.cmd, [], shell:false)', cmd, []));
console.log(await attempt('spawn(node, [.mjs], shell:false)', process.execPath, [mjs]));
console.log(await attempt('spawn(.mjs, [], shell:false)', mjs, []));
