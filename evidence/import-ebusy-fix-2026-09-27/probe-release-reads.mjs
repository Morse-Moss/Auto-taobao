// 取证：释放链的三处「读本机状态」在写了 stdio 之后是否真的能跑通。
// 背景：不写 stdio 时宿主沙箱回 EBUSY，于是 stop-all 读到空监听表 ⇒ 断言「没有在跑」⇒ 假绿退 0。
// 注：监听数这一条必须用**数组传参**复刻真实实现（`spawnSync('powershell.exe', [...])`）；
// 用 execSync 的字符串形态会经过 cmd.exe，引号被吃掉、命令行被截断 —— 那是探针的锅，不是被测代码的锅。
import { execSync, spawnSync } from 'node:child_process';

const S = ['ignore', 'pipe', 'ignore'];
const show = (label, fn) => {
  try {
    const value = fn();
    console.log(label, JSON.stringify({ ok: true, chars: String(value).length, preview: String(value).slice(0, 60) }));
  } catch (error) {
    console.log(label, JSON.stringify({ ok: false, code: error.code ?? null, msg: String(error.message).slice(0, 140) }));
  }
};

const procQuery = 'powershell -NoProfile -Command "'
  + '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
  + 'Get-CimInstance Win32_Process '
  + '| Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"';

show('netstat-nolisten:', () => execSync('netstat -ano -p tcp', { stdio: S, maxBuffer: 32 * 1024 * 1024 }).toString('latin1'));
show('procTable       :', () => execSync(procQuery, { stdio: S, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));

const ports = [19022, 19023, 19031];
const listenArgs = ['-NoProfile', '-Command',
  '$ports = ConvertFrom-Json $env:PRODUCT_RELEASE_PORTS; '
    + '$rows = foreach ($p in $ports) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue }; '
    + 'if ($rows) { $rows.Count } else { 0 }'];
const asIs = spawnSync('powershell.exe', listenArgs, { encoding: 'utf8', env: { ...process.env, PRODUCT_RELEASE_PORTS: JSON.stringify(ports) } });
const fixed = spawnSync('powershell.exe', listenArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PRODUCT_RELEASE_PORTS: JSON.stringify(ports) } });
console.log('listen-asIs   :', JSON.stringify({ status: asIs.status, errno: asIs.error?.code ?? null, stdout: asIs.stdout }));
console.log('listen-fixed  :', JSON.stringify({ status: fixed.status, stdout: String(fixed.stdout ?? '').trim(), parsed: Number(String(fixed.stdout ?? '').trim()) || 0 }));
