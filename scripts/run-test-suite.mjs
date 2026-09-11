// Suite runner for the repository test layers.
//
// Why this exists: the repository has 98 test files but no package-level entry
// point that runs them. Discovery here is directory-based (not hardcoded file
// lists) so that new tests are picked up automatically, and the exclusion
// registry below is the single, auditable place that decides which tests are
// offline-safe versus gated on external systems.
//
// Suites:
//   unit        - all skill tests that need no browser, proxy, clipboard or DB
//   skills      - the skill-test half of `unit` (used by CI to parallelise)
//   runtime     - all runtime/*.test.mjs (verified offline-clean)
//   integration - exactly the files excluded above, run in one place
//
// Usage: node scripts/run-test-suite.mjs <unit|runtime|integration> [--concurrency=N] [--dry-run]
//
// --concurrency=N passes --test-concurrency through. The
// xws-export-market-analysis suite spawns the real CLI against fake proxies
// and contains stall/deadline timing tests that can flake when many files run
// in parallel on a loaded machine; use --concurrency=1 to reproduce a quiet
// run before treating any failure there as a regression.
//
// --dry-run prints the resolved file list per suite and exits without running
// anything, so the exclusion partition stays auditable.
//
// Conventions honoured from docs/standards/README.md:
//   - explicit file lists are preferred over shell glob expansion on Windows;
//   - integration tests must report "skipped" (not pass) when their external
//     system is unavailable, so the suite never fakes a green result.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Files that must never run in the offline suites, with the reason they are
// gated. Every entry here is run by the `integration` suite instead.
const EXCLUSIONS = [
  {
    file: 'skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs',
    reason: 'integration: drives the live web-access CDP proxy (127.0.0.1:3456), the real Windows clipboard, and real browser tabs',
  },
  {
    file: 'skills/xws-export-market-analysis/tests/postgres-state.test.mjs',
    reason: 'integration: requires XWS_TEST_DATABASE_URL; skips itself when unset',
  },
];

function listTestFiles(relativeDir) {
  const absolute = path.join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(relativeDir, name).replaceAll('\\', '/'));
}

function discoverSkillTests() {
  const files = [];
  for (const skill of readdirSync(path.join(root, 'skills'))) {
    for (const subdir of ['tests', 'scripts']) {
      files.push(...listTestFiles(path.join('skills', skill, subdir)));
    }
  }
  return files.sort();
}

function discoverRuntimeTests() {
  return listTestFiles('runtime').sort();
}

function runSuite(files, label, extraArgs = []) {
  if (files.length === 0) {
    console.log(`==> ${label}: no test files`);
    return 0;
  }
  console.log(`==> ${label}: ${files.length} file(s)`);
  const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const argv = process.argv.slice(2);
const suite = argv.find((value) => !value.startsWith('--'));
const concurrencyArg = argv.find((value) => value.startsWith('--concurrency='));
const dryRun = argv.includes('--dry-run');
const extraArgs = concurrencyArg ? [`--test-concurrency=${concurrencyArg.split('=')[1]}`] : [];
if (concurrencyArg && !/^\d+$/.test(concurrencyArg.split('=')[1])) {
  console.error('--concurrency must be a positive integer');
  process.exit(2);
}
const skillTests = discoverSkillTests();
const runtimeTests = discoverRuntimeTests();
const excluded = new Map(EXCLUSIONS.map((entry) => [entry.file, entry.reason]));

function partition(files) {
  const offline = [];
  const gated = [];
  for (const file of files) {
    (excluded.has(file) ? gated : offline).push(file);
  }
  return { offline, gated };
}

const skills = partition(skillTests);
const runtime = partition(runtimeTests);

function printList(label, files) {
  console.log(`${label}: ${files.length}`);
  for (const file of files) console.log(`  ${file}`);
}

let status = 0;
if (dryRun) {
  if (!suite) {
    printList('unit:skills', skills.offline);
    printList('unit:runtime', runtime.offline);
    printList('integration', [...skills.gated, ...runtime.gated]);
  } else if (suite === 'unit') {
    printList('unit:skills', skills.offline);
    printList('unit:runtime', runtime.offline);
  } else if (suite === 'skills') {
    printList('skills', skills.offline);
  } else if (suite === 'runtime') {
    printList('runtime', runtime.offline);
  } else if (suite === 'integration') {
    printList('integration', [...skills.gated, ...runtime.gated]);
  } else {
    console.error(`unknown suite: ${suite}`);
    status = 2;
  }
  process.exit(status);
}

if (suite === 'skills') {
  status = runSuite(skills.offline, 'skills');
} else if (suite === 'unit') {
  for (const [file, reason] of excluded) {
    console.log(`    excluded from offline suites: ${file} (${reason})`);
  }
  status = runSuite(skills.offline, 'unit:skills');
  if (status === 0) status = runSuite(runtime.offline, 'unit:runtime');
} else if (suite === 'runtime') {
  status = runSuite(runtime.offline, 'runtime');
} else if (suite === 'integration') {
  const gated = [...skills.gated, ...runtime.gated];
  console.log('    NOTE: these tests need external systems and may fail fast when unavailable:');
  for (const file of gated) console.log(`      ${file} - ${excluded.get(file)}`);
  status = runSuite(gated, 'integration');
} else {
  console.error('usage: node scripts/run-test-suite.mjs <unit|skills|runtime|integration>');
  console.error('  unit        - offline skill + runtime tests (no browser, proxy, clipboard or DB)');
  console.error('  skills      - the skill-test half of unit only');
  console.error('  runtime     - runtime/*.test.mjs only');
  console.error('  integration - the gated files that offline suites exclude');
  process.exit(2);
}

process.exit(status);
