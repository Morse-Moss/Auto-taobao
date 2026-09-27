import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shopBrowserKeys, shopInstance, PROJECT_PORTS } from './browser-ports.mjs';
import { activeProfileName, envFilePath } from './feishu-targets.mjs';

function commandVersion(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/u)[0]; } catch (error) { return `UNAVAILABLE: ${error.message}`; }
}

export function runEnvironmentPreflight({ root = path.resolve(import.meta.dirname, '..'), workflow = 'all' } = {}) {
  const credentialFile = envFilePath(activeProfileName());
  const ports = [PROJECT_PORTS.dailyReportBrowser, PROJECT_PORTS.dailyReportProxy, ...shopBrowserKeys().flatMap(shop => { const x = shopInstance(shop); return [x.browserPort, x.proxyPort]; })];
  const uniquePorts = new Set(ports);
  const checks = [
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
    { name: 'python', ok: !commandVersion(process.platform === 'win32' ? 'py' : 'python3', process.platform === 'win32' ? ['-3', '--version'] : ['--version']).startsWith('UNAVAILABLE'), detail: commandVersion(process.platform === 'win32' ? 'py' : 'python3', process.platform === 'win32' ? ['-3', '--version'] : ['--version']) },
    { name: 'feishu-credentials', ok: fs.existsSync(credentialFile), detail: credentialFile },
    { name: 'ports-unique', ok: uniquePorts.size === ports.length, detail: ports },
    { name: 'project-root', ok: fs.existsSync(path.join(root, 'package.json')), detail: root },
  ];
  return { version: 1, workflow, checkedAt: new Date().toISOString(), profile: activeProfileName(), ok: checks.every(check => check.ok), checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const json = process.argv.includes('--json');
  const result = runEnvironmentPreflight({ workflow: process.argv[process.argv.indexOf('--workflow') + 1] || 'all' });
  console.log(json ? JSON.stringify(result, null, 2) : result.checks.map(check => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'));
  if (!result.ok) process.exitCode = 1;
}
