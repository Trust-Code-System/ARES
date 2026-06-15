/**
 * The tool registry: a single source of truth for every capability ARES has.
 *
 * Responsibilities:
 *   - hold the typed {@link Tool} definitions
 *   - render them into the Anthropic `tools` array (schema the model sees)
 *   - look them up by name at dispatch time
 *
 * It deliberately does NOT execute tools or know about the confirmation gate —
 * that orchestration lives in the agent loop, so the registry stays a pure
 * catalog that other surfaces (UI tool toggles, docs) can read.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '../types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  /** Names the operator has switched off (Phase 5 dashboard). Disabled tools are
   *  not offered to the model, so they can't be called. */
  private readonly disabled = new Set<string>();

  /** Register a tool. Throws on duplicate names — names are the dispatch key. */
  register<I>(tool: Tool<I>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Turn a tool on/off. Returns false if the tool isn't registered. */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!this.tools.has(name)) return false;
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
    return true;
  }

  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  /** Catalog for the dashboard: name, kind, and current enabled state. */
  catalog(): Array<{ name: string; kind: Tool['kind']; description: string; enabled: boolean }> {
    return this.list().map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      enabled: this.isEnabled(t.name),
    }));
  }

  /** The schema array passed to the Messages API (excludes disabled tools). */
  toAnthropicTools(): Anthropic.Tool[] {
    return this.list()
      .filter((t) => this.isEnabled(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        // Built-ins default to strict; imported MCP tools opt out (t.strict === false).
        strict: t.strict ?? true,
      }));
  }
}
