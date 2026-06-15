/**
 * Zod-first tool definition.
 *
 * A tool's input is described once as a Zod schema; this derives the JSON Schema
 * the Anthropic API needs (`input_schema`) AND keeps the Zod schema for runtime
 * validation in the orchestrator. One source of truth — no drift between "what
 * the model is told" and "what we actually accept". Zod's strip-by-default object
 * conversion already yields the strict-mode shape Anthropic wants (object +
 * additionalProperties:false + required for non-optional fields).
 *
 * Built-in tools use this; tools imported from MCP servers keep their upstream raw
 * JSON schema (no Zod), and the orchestrator falls back to presence-checking for
 * those — see orchestrator.ts.
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Tool, ToolContext, ToolKind, ToolResult } from '../types.js';

/** Render Zod issues as a short, readable string (e.g. "path: Required; n: too big"). */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Convert a Zod object schema to an Anthropic-compatible JSON Schema. */
export function zodInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  // The Messages API doesn't want the meta `$schema` key; everything else
  // (type/properties/required/additionalProperties) is exactly the shape it expects.
  delete json.$schema;
  json.type = 'object';
  if (json.additionalProperties === undefined) json.additionalProperties = false;
  return json as Anthropic.Tool.InputSchema;
}

export interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  kind: ToolKind;
  /** The single source of truth for this tool's input. */
  schema: S;
  /** Strict schema-conformance mode for the API; defaults to true for built-ins. */
  strict?: boolean;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** Build a {@link Tool} from a Zod-described definition. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): Tool<z.infer<S>> {
  return {
    name: def.name,
    description: def.description,
    kind: def.kind,
    inputSchema: zodInputSchema(def.schema),
    inputZod: def.schema,
    ...(def.strict !== undefined ? { strict: def.strict } : {}),
    execute: def.execute,
  };
}
