/**
 * Types for the fine-tuning dataset pipeline.
 *
 * A {@link TrainingExample} is one input→output pair. `output` is either a plain
 * string (tone, rewrite, refusal, free-form behaviour) or a structured object
 * (intent classification, agent/skill/tool routing) — both are common targets,
 * so the type carries both and the exporters serialize the object form as JSON.
 *
 * Nothing here is provider-specific; {@link ./export} turns a dataset into the
 * format a given provider wants (OpenAI chat JSONL first — see the strategy doc).
 */

/** Structured routing output (the Phase-4 example shape). All fields optional. */
export interface RoutingOutput {
  intent?: string;
  agent?: string;
  supporting_agents?: string[];
  skills?: string[];
  tools?: string[];
  risk_level?: 'low' | 'medium' | 'high';
  needs_confirmation?: boolean;
  [k: string]: unknown;
}

export interface TrainingExample {
  /** Stable id; derived from a content hash when absent. */
  id?: string;
  /** The user/input side of the pair. */
  input: string;
  /** The target output — free-form text or a structured object. */
  output: string | RoutingOutput;
  /** Optional per-example system/context prompt (used in chat-format export). */
  system?: string;
  /** Freeform tags: task type, locale ("ng"/"gh"), behaviour bucket, etc. */
  tags?: string[];
}

export interface DatasetMeta {
  /** Human description of what this dataset trains. */
  description?: string;
  /** What kind of behaviour: 'routing' | 'tone' | 'classification' | 'refusal' | 'mixed' | string. */
  taskType?: string;
  /** ISO timestamp the dataset object was assembled. */
  createdAt?: string;
  /** Provenance note (where examples came from; never raw user data without consent). */
  sourceNote?: string;
}

export interface Dataset {
  name: string;
  /** Semver-ish version string for rollback/versioning (e.g. "1.0.0"). */
  version: string;
  examples: TrainingExample[];
  meta?: DatasetMeta;
}

/** Train/validation/test partition. Fractions need not be supplied — see splitDataset. */
export interface DatasetSplit {
  train: TrainingExample[];
  validation: TrainingExample[];
  test: TrainingExample[];
}
