import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = resolve(root, 'skills', 'xws-export-market-analysis', 'SKILL.md');
const commitKeys = new Set();
let leaseReleased = false;

export async function loadSkill() {
  const text = await readFile(skillPath, 'utf8');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!match || !match[1].includes('name: xws-export-market-analysis')) throw new Error('skill manifest invalid');
  return 'xws-export-market-analysis@2.2.1';
}

export async function observePage(input) {
  return { page: input.pages.start, rows: input.rows };
}

export async function decideAction(observation) {
  return { capability: 'fake.browser.export', page: observation.page };
}

export async function executeAction(decision, input) {
  if (decision.capability !== 'fake.browser.export') throw new Error('capability denied');
  return { page: decision.page, rows: input.rows };
}

export async function validateArtifact(artifact) {
  if (!Array.isArray(artifact.rows) || artifact.rows.length < 1 || artifact.rows.some((row) => !row?.productLink)) {
    throw new Error('artifact validation failed');
  }
  return { valid: true, rowCount: artifact.rows.length };
}

export async function commitArtifact({ run, artifact, validation }) {
  if (!validation.valid) throw new Error('commit requires valid artifact');
  const key = `${run.id}:page:${artifact.page}`;
  if (!commitKeys.has(key)) commitKeys.add(key);
  return { commitCount: 1 };
}

export async function releaseLease() {
  leaseReleased = true;
  return { released: leaseReleased };
}
