import { spawnSync } from 'node:child_process';
const script = 'skills/sycm-product-data/scripts/read-product-xls.py';
const file = process.argv[2];
const show = (label, r) => console.log(label, JSON.stringify({ status: r.status, errno: r.error?.code ?? null, err: r.error?.message ?? null, stdoutLen: (r.stdout ?? '').length, stderr: (r.stderr ?? '').slice(0, 200) }));
show('default(no stdio):', spawnSync('py', ['-3', script, file], { encoding: 'utf8' }));
show("stdio ignore/pipe/pipe:", spawnSync('py', ['-3', script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
