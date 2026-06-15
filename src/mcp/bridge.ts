/**
 * The MCP bridge — turn a connected {@link McpClient}'s tools into ARES {@link Tool}s.
 *
 * Each imported tool is namespaced (`gmail_send_email`), classified read-only vs
 * state-mutating (classify.ts), and given an `execute` that forwards to the MCP
 * server. Crucially, the result is an ordinary {@link Tool} placed in the same
 * registry as the built-ins, so it inherits the confirmation gate and the audit
 * log with no special-casing in the orchestrator. Mutating MCP calls (send mail,
 * create event) are therefore gated exactly like `write_file`.
 *
 * Imported tools are marked `strict: false` because upstream MCP JSON schemas
 * aren't authored for Anthropic strict mode.
 */

import type { Logger, Tool, ToolKind, ToolResult } from '../types.js';
import type { McpClient, McpToolDescriptor } from './client.js';
import { classifyMcpTool } from './classify.js';

export interface ImportOptions {
  client: McpClient;
  /** Prefix for imported tool names, e.g. 'gmail'. Defaults to the server name. */
  namespace?: string;
  logger: Logger;
  /** Per-(remote)-tool-name kind overrides for cases the heuristic gets wrong. */
  classifyOverrides?: Record<string, ToolKind>;
}

/** Connect (if needed) and import every tool the MCP server exposes. */
export async function importMcpTools(opts: ImportOptions): Promise<Tool[]> {
  const namespace = sanitizeSegment(opts.namespace ?? opts.client.serverName);
  const descriptors = await opts.client.listTools();
  const tools = descriptors.map((d) => toTool(d, namespace, opts));
  opts.logger.info('imported MCP tools', {
    server: opts.client.serverName,
    namespace,
    count: tools.length,
    mutating: tools.filter((t) => t.kind === 'state_mutating').map((t) => t.name),
  });
  return tools;
}

function toTool(descriptor: McpToolDescriptor, namespace: string, opts: ImportOptions): Tool {
  const kind = classifyMcpTool(descriptor.name, opts.classifyOverrides);
  const name = sanitizeToolName(`${namespace}_${descriptor.name}`);
  const remoteName = descriptor.name;

  return {
    name,
    description: descriptor.description || `(${namespace}) ${remoteName}`,
    kind,
    strict: false,
    inputSchema: normalizeSchema(descriptor.inputSchema),
    async execute(input): Promise<ToolResult> {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const result = await opts.client.callTool(remoteName, args);
      return {
        ok: !result.isError,
        content: result.content || (result.isError ? 'MCP tool returned an error.' : '(no content)'),
        data: result.data,
      };
    },
  };
}

/** Ensure the schema is an object-typed JSON Schema the Messages API accepts. */
function normalizeSchema(schema: McpToolDescriptor['inputSchema']): McpToolDescriptor['inputSchema'] {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = schema as Record<string, unknown>;
  const properties = s.properties && typeof s.properties === 'object' ? s.properties : {};
  return { ...s, type: 'object', properties } as McpToolDescriptor['inputSchema'];
}

/** A namespace segment: lowercase, only [a-z0-9_]. */
function sanitizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
}

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
