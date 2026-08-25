import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findPython() {
  const candidates = [];
  if (process.env.SYCM_PYTHON) candidates.push({ command: process.env.SYCM_PYTHON, args: [] });
  candidates.push({
    command: path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    args: [],
  });
  candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] }, { command: 'py', args: ['-3'] });
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, '-c', 'import openpyxl'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  throw new Error('No Python runtime with openpyxl was found; the export pair cannot be verified');
}

export async function verifyExportPair({ csv, xlsx, expectedEndDate }) {
  if (!csv || !xlsx || !/^\d{4}-\d{2}-\d{2}$/u.test(expectedEndDate ?? '')) {
    throw new Error('CSV, XLSX, and expected end date are required for source proof');
  }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-export-pair.py');
  const python = findPython();
  const result = spawnSync(python.command, [
    ...python.args,
    script,
    path.resolve(csv),
    path.resolve(xlsx),
    expectedEndDate,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0) {
    let message = result.stderr.trim() || result.stdout.trim() || `Verifier exited with status ${result.status}`;
    try { message = JSON.parse(message).message ?? message; } catch { /* Keep verifier output. */ }
    throw new Error(message);
  }
  const payload = JSON.parse(result.stdout.trim());
  if (payload.status !== 'success') throw new Error('Export pair verification did not succeed');
  return payload;
}
