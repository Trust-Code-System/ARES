/**
 * The thin MCP client surface ARES depends on.
 *
 * ARES integrates external capabilities (Gmail, Google Calendar, …) by acting as
 * an MCP *client*: it connects to an MCP server, lists its tools, and imports them
 * into the normal tool registry (see bridge.ts) so they pass through the SAME
 * confirmation gate and audit log as every built-in. The orchestrator never learns
 * a tool came from MCP — it's just a {@link Tool} with a `kind`.
 *
 * We depend on this minimal interface rather than the MCP SDK directly so the
 * bridge logic is testable with {@link FakeMcpClient} and the SDK stays a swappable
 * transport detail (sdkClient.ts).
 */

import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (used as the Anthropic input_schema). */
  inputSchema: Anthropic.Tool.InputSchema;
}

export interface McpCallResult {
  /** Flattened text the model sees. */
  content: string;
  /** Maps to ToolResult.ok === false. */
  isError: boolean;
  /** Optional structured payload, recorded in the audit log. */
  data?: unknown;
}

export interface McpClient {
  /** Human label for logs and as the default tool namespace. */
  readonly serverName: string;
  connect(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** In-memory MCP client for tests and offline development. */
export class FakeMcpClient implements McpClient {
  private connected = false;

  constructor(
    readonly serverName: string,
    private readonly tools: McpToolDescriptor[],
    private readonly handler?: (name: string, args: Record<string, unknown>) => McpCallResult,
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.connected) throw new Error('FakeMcpClient.listTools called before connect()');
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (this.handler) return this.handler(name, args);
    return { content: `called ${name} with ${JSON.stringify(args)}`, isError: false, data: args };
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
