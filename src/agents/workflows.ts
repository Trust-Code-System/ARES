/**
 * Multi-agent workflow templates (Phase 9).
 *
 * Loads the `workflows/*.workflow.json` templates and selects one for a request
 * by keyword/trigger match. Like {@link selectAgents}, selection is a pure,
 * testable function — no network or model calls. A workflow is an
 * orchestrator–worker plan: an ordered list of (agent, task) stages the main
 * agent runs in sequence, each worker inheriting the SAME safety gate and caps.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';

export interface WorkflowStage {
  agent: string;
  task: string;
  outputs?: string;
  tools?: string[];
  skills?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger_keywords: string[];
  required_inputs?: string[];
  requires_sensitive_data_scan?: boolean;
  stages: WorkflowStage[];
  quality_checks?: string[];
  final_deliverable?: string;
}

/** Load every `*.workflow.json` under `dir`. Bad files are skipped (never thrown). */
export function loadWorkflows(dir: string, logger?: Logger): Workflow[] {
  const root = path.resolve(dir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Workflow[] = [];
  for (const name of names) {
    if (!name.endsWith('.workflow.json')) continue;
    const full = path.join(root, name);
    try {
      if (!statSync(full).isFile()) continue;
      const wf = JSON.parse(readFileSync(full, 'utf8')) as Workflow;
      if (wf && typeof wf.id === 'string' && Array.isArray(wf.stages)) out.push(wf);
    } catch {
      logger?.warn?.('skipped malformed workflow', { file: name });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Select the best-matching workflow for a request, or null when none clears the
 * bar. Scores by trigger-phrase containment (strong) plus per-keyword token
 * overlap, so "build this feature from idea to production" → feature-build.
 */
export function selectWorkflow(text: string, workflows: readonly Workflow[]): Workflow | null {
  const lower = text.toLowerCase();
  const queryTokens = new Set(terms(text));

  let best: { wf: Workflow; score: number } | null = null;
  for (const wf of workflows) {
    let score = 0;
    for (const kw of wf.trigger_keywords) {
      const k = kw.toLowerCase();
      if (lower.includes(k)) score += 5 + terms(k).length; // whole trigger phrase present
      else {
        const kwTokens = terms(k);
        const overlap = kwTokens.filter((t) => queryTokens.has(t)).length;
        // Reward only a strong partial match (most of the phrase's words present).
        if (kwTokens.length >= 2 && overlap >= kwTokens.length - 1) score += overlap;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { wf, score };
  }
  return best ? best.wf : null;
}
