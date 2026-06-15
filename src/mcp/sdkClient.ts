/**
 * {@link McpClient} backed by the official MCP SDK over a stdio transport.
 *
 * This is the real connection ARES uses to talk to a locally-spawned MCP server
 * (e.g. a Gmail or Google Calendar MCP server you run as a subprocess). The SDK
 * details are confined here; everything else in ARES depends only on the
 * {@link McpClient} interface, and tests use {@link FakeMcpClient}.
 *
 * The live connection spawns a real subprocess, so that path isn't in the unit
 * suite — but the pure mapping helpers it relies on ({@link mcpToolToDescriptor},
 * {@link mcpResultToCallResult}, {@link flattenContent}) and the not-connected
 * guard are exported and tested, and the bridge/classification logic is covered
 * against {@link FakeMcpClient}.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { McpClient, McpCallResult, McpToolDescriptor } from './client.js';

/** How to launch a stdio MCP server subprocess. */
export interface StdioServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class SdkMcpClient implements McpClient {
  readonly serverName: string;
  private client?: Client;
  private transport?: StdioClientTransport;

  constructor(private readonly spec: StdioServerSpec) {
    this.serverName = spec.name;
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args ?? [],
      ...(this.spec.env ? { env: this.spec.env } : {}),
    });
    this.client = new Client({ name: 'ares', version: '0.1.0' });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.requireClient().listTools();
    return res.tools.map(mcpToolToDescriptor);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const res = await this.requireClient().callTool({ name, arguments: args });
    return mcpResultToCallResult(res);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`MCP client for "${this.serverName}" is not connected.`);
    return this.client;
  }
}

/** Map an MCP SDK tool descriptor to ARES's {@link McpToolDescriptor} (pure). */
export function mcpToolToDescriptor(t: {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}): McpToolDescriptor {
  return {
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
  };
}

/** Map an MCP `callTool` response to ARES's {@link McpCallResult} (pure). */
export function mcpResultToCallResult(res: unknown): McpCallResult {
  const r = (res ?? {}) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  return {
    content: flattenContent(r.content),
    isError: Boolean(r.isError),
    data: r.structuredContent,
  };
}

/** Flatten MCP content blocks (text/other) into a single string for the model. */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else parts.push(`[${String(b.type ?? 'content')}]`);
    }
  }
  return parts.join('\n').trim();
}
