/**
 * Confirmation-gate wiring. Mirrors the memory factory: durable Postgres stores
 * when a Db is available, in-memory otherwise. Returns the gate plus the stores
 * so other surfaces (a CLI/UI to approve queued actions, Phase 5) can reach them.
 */

import type { Config } from '../config.js';
import type { ConfirmationGate, Logger } from '../types.js';
import type { ConfirmationPrompt } from '../tools/confirmation.js';
import type { Db } from '../db/client.js';
import {
  InMemoryConfirmationQueue,
  InMemoryRulesStore,
  type ConfirmationQueueStore,
  type StandingRulesStore,
} from './store.js';
import { PgConfirmationQueue, PgCostLedger, PgRulesStore } from './pgStore.js';
import { RuleBasedConfirmationGate } from './gate.js';
import { InMemoryCostLedger, SpendCapEnforcer, type CostLedger } from './caps.js';

export interface SafetyBackend {
  gate: ConfirmationGate;
  rules: StandingRulesStore;
  queue: ConfirmationQueueStore;
  caps: SpendCapEnforcer;
}

export function buildSafetyBackend(
  config: Config,
  db: Db | undefined,
  logger: Logger,
  prompt?: ConfirmationPrompt,
): SafetyBackend {
  const rules: StandingRulesStore = db ? new PgRulesStore(db) : new InMemoryRulesStore();
  const queue: ConfirmationQueueStore = db ? new PgConfirmationQueue(db) : new InMemoryConfirmationQueue();
  // Durable spend ledger when a DB is present, so the rolling-window total survives
  // restarts; in-memory otherwise. The caps are enforced identically either way —
  // only persistence of the rolling window differs.
  const ledger: CostLedger = db ? new PgCostLedger(db) : new InMemoryCostLedger();
  const caps = new SpendCapEnforcer(config.spend, ledger);
  const gate = new RuleBasedConfirmationGate({
    mode: config.confirmationMode,
    rules,
    queue,
    logger,
    caps,
    ...(prompt ? { prompt } : {}),
  });
  return { gate, rules, queue, caps };
}
