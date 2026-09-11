import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'xws-export-market-analysis', 'SKILL.md');

function loadSkillManifest(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!match) throw new Error('skill manifest frontmatter is missing');
  const fields = Object.fromEntries(match[1].split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator < 0) return [];
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
    return key ? [[key, value]] : [];
  }));
  if (!fields.name || !fields.version) throw new Error('skill manifest requires name and version');
  return { name: fields.name, version: fields.version };
}

function validateArtifact(rows) {
  if (!Array.isArray(rows) || rows.length < 1) throw new Error('artifact validation failed');
  if (rows.some((row) => !row || typeof row.productLink !== 'string' || !row.productLink)) {
    throw new Error('artifact validation failed');
  }
  return { rowCount: rows.length, valid: true };
}

export async function runLocalVerticalSlice({ artifactRows = [{ productLink: 'https://example.test/item-1' }], crashAfterCheckpoint = false } = {}) {
  const events = [];
  const checkpoint = { status: 'RUNNING', completedEnd: 0, committed: false };
  let leaseReleased = false;
  let commitCount = 0;
  const commitKeys = new Set();

  let result;
  try {
    const skill = loadSkillManifest(await readFile(skillPath, 'utf8'));
    events.push('SKILL_LOADED');
    const run = { id: 'local-run-1', skill };
    events.push('RUN_CREATED');
    const observation = { page: 1, rows: artifactRows };
    events.push('OBSERVED');
    const decision = { capability: 'fake.browser.export', input: { page: observation.page } };
    events.push('DECIDED');
    if (decision.capability !== 'fake.browser.export') throw new Error('capability denied');
    const artifact = { rows: observation.rows, page: observation.page };
    events.push('ACTED');
    const validation = validateArtifact(artifact.rows);
    events.push('VERIFIED');
    checkpoint.completedEnd = artifact.page;
    checkpoint.validation = validation;
    events.push('CHECKPOINTED');

    if (crashAfterCheckpoint) {
      events.push('WORKER_RESTARTED');
      if (checkpoint.completedEnd !== 1 || !checkpoint.validation.valid) throw new Error('checkpoint recovery failed');
    }

    const commitKey = `${run.id}:page:${checkpoint.completedEnd}`;
    if (!commitKeys.has(commitKey)) {
      commitKeys.add(commitKey);
      commitCount += 1;
      checkpoint.committed = true;
    }
    events.push('COMMITTED');
    checkpoint.status = 'DONE';
    result = { status: checkpoint.status, completedEnd: checkpoint.completedEnd, commitCount, events };
  } finally {
    leaseReleased = true;
    if (!events.includes('LEASE_RELEASED')) events.push('LEASE_RELEASED');
  }
  return { ...result, leaseReleased, events };
}
