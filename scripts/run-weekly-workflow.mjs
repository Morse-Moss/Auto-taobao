#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildWeeklyStagePlan, WEEKLY_STAGES } from '../runtime/weekly-workflow-core.mjs';
import { createWorkflowReceipt, writeWorkflowReceipt } from '../runtime/workflow-receipt.mjs';

function parse(argv) {
  const out = { completed: [], aiReady: false, receipt: null, showPlan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--completed') out.completed = String(argv[++i] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    else if (arg === '--ai-ready') out.aiReady = true;
    else if (arg === '--receipt') out.receipt = path.resolve(argv[++i]);
    else if (arg === '--show-plan') out.showPlan = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const options = parse(process.argv.slice(2));
if (options.help) {
  console.log('node scripts/run-weekly-workflow.mjs --show-plan [--completed stage1,stage2] [--ai-ready] [--receipt file]');
  process.exit(0);
}
const plan = buildWeeklyStagePlan(options);
const receipt = createWorkflowReceipt({ workflow: 'weekly', runId: `weekly-${Date.now()}`, date: new Date().toISOString().slice(0, 10), stages: plan.stages, status: plan.status === 'READY' ? 'RUNNING' : plan.status, nextStage: plan.next, reason: plan.reason ?? null });
if (options.receipt) writeWorkflowReceipt(options.receipt, receipt);
if (options.showPlan || !options.receipt) console.log(JSON.stringify({ stages: WEEKLY_STAGES, ...plan, receipt: options.receipt }, null, 2));
if (plan.status === 'PAUSED_FOR_HUMAN') process.exitCode = 3;
