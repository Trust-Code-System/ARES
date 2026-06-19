/** Tools for managing installed MCP servers. */

import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { defineTool } from '../tools/define.js';
import {
  loadMcpConfigFile,
  mcpServerFromCommand,
  mcpServerFromNpmPackage,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from './configStore.js';

export interface McpManagementToolOptions {
  configPath: string;
}

export const MCP_MANAGEMENT_PROMPT_NOTE =
  'When the principal asks to install, add, enable, disable, list, or remove MCP servers, use the MCP management tools. Prefer install_mcp_server for npm or stdio MCP server configs.';

const toolKindSchema = z.enum(['read_only', 'state_mutating']);

export function createMcpManagementTools(opts: McpManagementToolOptions): Tool[] {
  const listMcpServers = defineTool({
    name: 'list_mcp_servers',
    description:
      'List MCP servers installed in ARES managed config, including whether each ' +
      'server is enabled for startup. Read-only.',
    kind: 'read_only',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      const config = loadMcpConfigFile(opts.configPath);
      if (config.servers.length === 0) {
        return { ok: true, content: 'No MCP servers are installed in the managed config.', data: { servers: [] } };
      }
      const lines = config.servers.map((s) => {
        const status = s.enabled ? 'enabled' : 'disabled';
        const args = s.args?.length ? ` ${s.args.join(' ')}` : '';
        const source = s.source ? ` (${s.source})` : '';
        return `- ${s.name}: ${status} — ${s.command}${args}${source}`;
      });
      return { ok: true, content: `Installed MCP servers:\n${lines.join('\n')}`, data: { servers: config.servers } };
    },
  });

  const installMcpServer = defineTool({
    name: 'install_mcp_server',
    description:
      'Install/register a stdio MCP server in ARES managed config. Use this when ' +
      'the principal asks to add an MCP server. Prefer npm_package for package ' +
      'based MCPs; use command/args for custom stdio servers. This writes config ' +
      'only; server tools are imported on the next ARES startup. State-mutating.',
    kind: 'state_mutating',
    schema: z
      .object({
        name: z.string().describe('Short server name, e.g. "filesystem", "github", "gmail".'),
        npm_package: z
          .string()
          .describe('NPM package to run with npx -y, e.g. "@modelcontextprotocol/server-filesystem".')
          .optional(),
        package_args: z.array(z.string()).describe('Extra args after the npm package name.').optional(),
        command: z.string().describe('Custom stdio command. Use instead of npm_package.').optional(),
        args: z.array(z.string()).describe('Args for the custom command.').optional(),
        env: z.record(z.string(), z.string()).describe('Environment variables for the MCP subprocess. Avoid putting secrets here when possible.').optional(),
        namespace: z.string().describe('Optional imported-tool prefix; defaults to name.').optional(),
        classify_overrides: z
          .record(z.string(), toolKindSchema)
          .describe('Optional remote tool-name to kind overrides.')
          .optional(),
        enabled: z
          .boolean()
          .describe('Enable this MCP on startup immediately. Default false so it can be reviewed first.')
          .optional(),
        overwrite: z.boolean().describe('Replace an existing server with the same name. Default true.').optional(),
      })
      .refine((v) => Boolean(v.npm_package) !== Boolean(v.command), {
        message: 'Provide exactly one of npm_package or command.',
      }),
    async execute(input, ctx): Promise<ToolResult> {
      const server = input.npm_package
        ? mcpServerFromNpmPackage({
            name: input.name,
            npmPackage: input.npm_package,
            ...(input.package_args ? { packageArgs: input.package_args } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.namespace ? { namespace: input.namespace } : {}),
            ...(input.classify_overrides ? { classifyOverrides: input.classify_overrides } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          })
        : mcpServerFromCommand({
            name: input.name,
            command: input.command ?? '',
            ...(input.args ? { args: input.args } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.namespace ? { namespace: input.namespace } : {}),
            ...(input.classify_overrides ? { classifyOverrides: input.classify_overrides } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          });
      const config = upsertMcpServer(opts.configPath, server, { overwrite: input.overwrite ?? true });
      ctx.logger.info('MCP server installed', { name: server.name, enabled: server.enabled, source: server.source });
      return {
        ok: true,
        content:
          `Installed MCP server "${server.name}" (${server.enabled ? 'enabled' : 'disabled'}).` +
          `\nConfig: ${opts.configPath}` +
          '\nRestart ARES to import tools from enabled MCP servers.',
        data: { server, total: config.servers.length },
      };
    },
  });

  const setMcpServerState = defineTool({
    name: 'set_mcp_server_enabled',
    description:
      'Enable or disable an installed MCP server in the managed config. Enabled ' +
      'servers are imported on the next ARES startup. State-mutating.',
    kind: 'state_mutating',
    schema: z.object({
      name: z.string().describe('Installed MCP server name.'),
      enabled: z.boolean().describe('true to enable, false to disable.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      setMcpServerEnabled(opts.configPath, input.name, input.enabled);
      ctx.logger.info('MCP server state changed', { name: input.name, enabled: input.enabled });
      return {
        ok: true,
        content: `${input.enabled ? 'Enabled' : 'Disabled'} MCP server "${input.name}". Restart ARES for runtime imports to change.`,
        data: { name: input.name, enabled: input.enabled },
      };
    },
  });

  const removeMcpServerTool = defineTool({
    name: 'remove_mcp_server',
    description: 'Remove an installed MCP server from the managed config. State-mutating.',
    kind: 'state_mutating',
    schema: z.object({
      name: z.string().describe('Installed MCP server name.'),
    }),
    async execute(input, ctx): Promise<ToolResult> {
      removeMcpServer(opts.configPath, input.name);
      ctx.logger.info('MCP server removed', { name: input.name });
      return {
        ok: true,
        content: `Removed MCP server "${input.name}". Restart ARES for runtime imports to change.`,
        data: { name: input.name },
      };
    },
  });

  return [listMcpServers, installMcpServer, setMcpServerState, removeMcpServerTool];
}
