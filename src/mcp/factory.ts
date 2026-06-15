/**
 * MCP wiring: connect every configured server, import its tools, and hand back a
 * flat {@link Tool} list to register plus a {@link close} to shut the connections
 * down. One server failing to connect is logged and skipped, never fatal — a
 * broken Gmail server shouldn't take ARES offline.
 *
 * Connecting spawns subprocesses, so this is only called by the composition roots
 * that actually need external tools, and only when servers are configured.
 */

import type { Config } from '../config.js';
import type { Logger, Tool } from '../types.js';
import { importMcpTools } from './bridge.js';
import { SdkMcpClient } from './sdkClient.js';
import type { McpClient } from './client.js';

export interface McpBackend {
  tools: Tool[];
  close: () => Promise<void>;
}

export async function buildMcpTools(config: Config, logger: Logger): Promise<McpBackend> {
  if (config.mcpServers.length === 0) {
    return { tools: [], close: async () => {} };
  }

  const clients: McpClient[] = [];
  const tools: Tool[] = [];

  for (const spec of config.mcpServers) {
    const client = new SdkMcpClient({
      name: spec.name,
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    });
    try {
      await client.connect();
      const imported = await importMcpTools({
        client,
        logger,
        ...(spec.namespace ? { namespace: spec.namespace } : {}),
        ...(spec.classifyOverrides ? { classifyOverrides: spec.classifyOverrides } : {}),
      });
      clients.push(client);
      tools.push(...imported);
    } catch (err) {
      logger.warn('MCP server failed to connect; skipping', {
        server: spec.name,
        error: err instanceof Error ? err.message : String(err),
      });
      await client.close().catch(() => {});
    }
  }

  return {
    tools,
    close: async () => {
      for (const client of clients) await client.close().catch(() => {});
    },
  };
}
