/**
 * Classifying imported MCP tools as read-only or state-mutating.
 *
 * This is a SAFETY decision: a tool classified `read_only` runs without the gate,
 * so misjudging a mutating tool as read-only would let it fire unattended. The
 * rule is therefore fail-safe — only a recognized read verb earns `read_only`;
 * everything else (recognized write verb OR unknown) is `state_mutating` and thus
 * gated. An explicit per-name override always wins, for the cases the heuristic
 * gets wrong.
 *
 * Pure and exported so it's unit-tested without a live server.
 */

import type { ToolKind } from '../types.js';

const READ_VERBS = new Set([
  'list', 'get', 'search', 'read', 'find', 'fetch', 'query', 'describe',
  'count', 'view', 'show', 'check', 'lookup', 'retrieve', 'download', 'export',
]);

const WRITE_VERBS = new Set([
  'send', 'create', 'update', 'delete', 'draft', 'modify', 'trash', 'move',
  'add', 'remove', 'insert', 'patch', 'write', 'archive', 'mark', 'reply',
  'forward', 'schedule', 'cancel', 'set', 'post', 'put', 'label', 'star',
  'unstar', 'rename', 'upload', 'share', 'accept', 'decline', 'batch',
]);

/**
 * Well-known MCP tools whose names the verb heuristic can't recognize, but which
 * are pure/read-only (no side effects) — so they shouldn't be gated. Matched with
 * separators and case stripped, so "sequential_thinking", "sequentialThinking",
 * and "sequentialthinking" all resolve. An explicit override still wins over this.
 */
const READ_ONLY_NAMES = new Set([
  'sequentialthinking', // @modelcontextprotocol/server-sequential-thinking: reasoning only
]);

/** Strip separators + case for matching against {@link READ_ONLY_NAMES}. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The leading verb token of a tool name (handles snake_case, kebab, camelCase). */
export function firstToken(name: string): string {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return normalized.split(/[_\-\s.]+/).filter(Boolean)[0] ?? '';
}

export function classifyMcpTool(
  name: string,
  overrides: Record<string, ToolKind> = {},
): ToolKind {
  const override = overrides[name];
  if (override) return override;
  if (READ_ONLY_NAMES.has(normalizeName(name))) return 'read_only';
  const verb = firstToken(name);
  if (READ_VERBS.has(verb)) return 'read_only';
  // Recognized write verb, or anything unrecognized → gated, fail-safe.
  return 'state_mutating';
}
