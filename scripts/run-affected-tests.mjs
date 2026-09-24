import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function classifyChangedFiles(files) {
  const normalized = files.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''));
  const checks = new Set();

  for (const file of normalized) {
    if (file.endsWith('.md') || file.startsWith('evidence/')) {
      checks.add('docs');
      continue;
    }
    if (file === 'package.json' || file === 'package-lock.json' || file.startsWith('.github/')) {
      checks.add('unit');
      continue;
    }
    if (file.startsWith('agent-runtime/')) {
      checks.add('agent-runtime');
      continue;
    }
    if (file.startsWith('runtime/')) {
      checks.add(file.endsWith('.test.mjs') ? 'runtime-file' : 'runtime');
      continue;
    }
    const skillMatch = file.match(/^skills\/([^/]+)\//);
    if (skillMatch) {
      checks.add(`skill:${skillMatch[1]}`);
      continue;
    }
    if (file.endsWith('.mjs') || file.endsWith('.cjs') || file.endsWith('.js') || file.endsWith('.py')) {
      checks.add('unit');
    }
  }
  return [...checks].sort();
}

export function selectChecks(files) {
  const checks = classifyChangedFiles(files);
  const commands = [];
  const add = (command, args) => {
    const key = [command, ...args].join('\u0000');
    if (!commands.some((item) => item.key === key)) commands.push({ key, command, args });
  };

  if (checks.includes('unit')) add(npmCommand, ['run', 'test:unit']);
  if (checks.includes('runtime')) add(npmCommand, ['run', 'test:runtime']);
  for (const file of files.map((item) => item.replaceAll('\\', '/'))) {
    const skillTest = file.match(/^skills\/([^/]+)\/.*\.test\.mjs$/);
    if (skillTest) add('node', ['--test', file]);
    if (file.match(/^skills\/[^/]+\/.*(?:test_.*|.*_test)\.py$/)) {
      add('py', ['-3', '-m', 'unittest', file, '-q']);
    }
  }
  for (const check of checks.filter((item) => item.startsWith('skill:'))) {
    const skill = check.slice('skill:'.length);
    const hasImplementationChange = files.some((file) => {
      const normalized = file.replaceAll('\\', '/');
      return normalized.startsWith(`skills/${skill}/`) && !normalized.endsWith('.test.mjs') && !normalized.match(/(?:test_.*|.*_test)\.py$/);
    });
    if (hasImplementationChange) add('node', ['scripts/run-test-suite.mjs', 'skills', `--skill=${skill}`]);
  }
  for (const file of files.map((item) => item.replaceAll('\\', '/'))) {
    if (file.startsWith('runtime/') && file.endsWith('.test.mjs')) add('node', ['--test', file]);
  }
  if (checks.includes('runtime')) {
    add(npmCommand, ['run', 'test:runtime']);
  }
  if (checks.includes('agent-runtime')) add('npm', ['run', 'test:agent-runtime']);
  return { checks, commands };
}

function changedFilesFromGit(base, staged) {
  if (staged) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: root,
      encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean);
  }
  if (base) {
    return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean);
  }
  const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).flatMap((file) => {
    if (file.includes(' -> ')) return [file.split(' -> ').at(-1)];
    return [file];
  });
}

function parseArgs(argv) {
  const base = argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) || '';
  const explicit = argv.find((arg) => arg.startsWith('--files='))?.slice('--files='.length) || '';
  return { base: base || null, files: explicit ? explicit.split(',').filter(Boolean) : null, dryRun: argv.includes('--dry-run'), staged: argv.includes('--staged') };
}

function main() {
  const { base, files: explicit, dryRun, staged } = parseArgs(process.argv.slice(2));
  const files = explicit || changedFilesFromGit(base, staged);
  if (files.length === 0) {
    console.log('==> affected tests: no changed files');
    return 0;
  }
  const selection = selectChecks(files);
  console.log(`==> affected tests: ${files.length} changed file(s)`);
  console.log(`==> affected checks: ${selection.checks.join(', ') || 'none'}`);
  if (dryRun) {
    for (const item of selection.commands) console.log(`  ${item.command} ${item.args.join(' ')}`);
    return 0;
  }
  for (const item of selection.commands) {
    const result = spawnSync(item.command, item.args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32' && item.command.endsWith('.cmd'),
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  console.log('==> affected tests: PASS');
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(main());
