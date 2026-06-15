/**
 * AI fine-tuning dataset pipeline (public surface).
 *
 * Prepare → validate → sanitize → split → export, all provider-agnostic at the
 * core. See docs/AI_TRAINING_STRATEGY.md for *when* to fine-tune (rarely) and
 * docs/DATASET_FORMAT.md for the schema. The strategy: RAG for knowledge, skills
 * for workflows, memory for preferences, tools for actions — fine-tune only for
 * repeated output patterns, classification, routing, and tone.
 */

export * from './types.js';
export * from './sanitizer.js';
export * from './validate.js';
export * from './dataset.js';
export * from './export.js';
