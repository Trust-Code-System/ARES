/**
 * Persistent MCP server config store.
 *
 * ARES already understands stdio MCP server specs. This store gives the agent a
 * durable, auditable place to register those specs at runtime instead of asking
 * the principal to hand-edit ARES_MCP_SERVERS.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '../config.js';
import type { ToolKind } from '../types.js';

export interface StoredMcpServerConfig extends McpServerConfig {
  enabled: boolean;
  /** Human-facing provenance such as "npm:@modelcontextprotocol/server-filesystem". */
  source?: string;
  /** ISO timestamp for audit/debugging. */
  installedAt?: string;
}

export interface McpConfigFile {
  version: 1;
  servers: StoredMcpServerConfig[];
}

const EMPTY: McpConfigFile = { version: 1, servers: [] };

export function loadMcpConfigFile(configPath: string): McpConfigFile {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return { ...EMPTY, servers: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MCP config file is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('MCP config file must be an object.');
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.servers)) {
    throw new Error('MCP config file must contain a "servers" array.');
  }
  return {
    version: 1,
    servers: p.servers.map(parseStoredServer),
  };
}

export function saveMcpConfigFile(configPath: string, config: McpConfigFile): void {
  mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ version: 1, servers: config.servers }, null, 2)}\n`);
}

export function upsertMcpServer(
  configPath: string,
  server: StoredMcpServerConfig,
  opts: { overwrite?: boolean } = {},
): McpConfigFile {
  const config = loadMcpConfigFile(configPath);
  const existing = config.servers.findIndex((s) => s.name === server.name);
  if (existing >= 0 && opts.overwrite === false) {
    throw new Error(`MCP server "${server.name}" is already installed.`);
  }
  if (existing >= 0) config.servers[existing] = server;
  else config.servers.push(server);
  saveMcpConfigFile(configPath, config);
  return config;
}

export function setMcpServerEnabled(configPath: string, name: string, enabled: boolean): McpConfigFile {
  const config = loadMcpConfigFile(configPath);
  const server = config.servers.find((s) => s.name === name);
  if (!server) throw new Error(`No installed MCP server named "${name}".`);
  server.enabled = enabled;
  saveMcpConfigFile(configPath, config);
  return config;
}

export function removeMcpServer(configPath: string, name: string): McpConfigFile {
  const config = loadMcpConfigFile(configPath);
  const before = config.servers.length;
  config.servers = config.servers.filter((s) => s.name !== name);
  if (config.servers.length === before) throw new Error(`No installed MCP server named "${name}".`);
  saveMcpConfigFile(configPath, config);
  return config;
}

export function activeMcpServers(configPath: string): McpServerConfig[] {
  return loadMcpConfigFile(configPath).servers
    .filter((s) => s.enabled)
    .map(stripStoredFields);
}

export function mcpServerFromNpmPackage(input: {
  name: string;
  npmPackage: string;
  packageArgs?: string[];
  env?: Record<string, string>;
  namespace?: string;
  classifyOverrides?: Record<string, ToolKind>;
  enabled?: boolean;
}): StoredMcpServerConfig {
  const args = ['-y', input.npmPackage, ...(input.packageArgs ?? [])];
  return {
    name: sanitizeServerName(input.name),
    command: 'npx',
    args,
    enabled: input.enabled ?? false,
    source: `npm:${input.npmPackage}`,
    installedAt: new Date().toISOString(),
    ...(input.env ? { env: input.env } : {}),
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(input.classifyOverrides ? { classifyOverrides: input.classifyOverrides } : {}),
  };
}

export function mcpServerFromCommand(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  namespace?: string;
  classifyOverrides?: Record<string, ToolKind>;
  enabled?: boolean;
}): StoredMcpServerConfig {
  return {
    name: sanitizeServerName(input.name),
    command: input.command,
    ...(input.args ? { args: input.args } : {}),
    enabled: input.enabled ?? false,
    source: `command:${input.command}`,
    installedAt: new Date().toISOString(),
    ...(input.env ? { env: input.env } : {}),
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(input.classifyOverrides ? { classifyOverrides: input.classifyOverrides } : {}),
  };
}

function parseStoredServer(raw: unknown, i: number): StoredMcpServerConfig {
  if (!raw || typeof raw !== 'object') throw new Error(`servers[${i}] must be an object.`);
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.command !== 'string') {
    throw new Error(`servers[${i}] requires string "name" and "command".`);
  }
  return {
    name: sanitizeServerName(r.name),
    command: r.command,
    ...(Array.isArray(r.args) ? { args: r.args.map(String) } : {}),
    ...(r.env && typeof r.env === 'object' ? { env: r.env as Record<string, string> } : {}),
    ...(typeof r.namespace === 'string' ? { namespace: r.namespace } : {}),
    ...(r.classifyOverrides && typeof r.classifyOverrides === 'object'
      ? { classifyOverrides: r.classifyOverrides as Record<string, ToolKind> }
      : {}),
    enabled: r.enabled === true,
    ...(typeof r.source === 'string' ? { source: r.source } : {}),
    ...(typeof r.installedAt === 'string' ? { installedAt: r.installedAt } : {}),
  };
}

function stripStoredFields(server: StoredMcpServerConfig): McpServerConfig {
  return {
    name: server.name,
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.namespace ? { namespace: server.namespace } : {}),
    ...(server.classifyOverrides ? { classifyOverrides: server.classifyOverrides } : {}),
  };
}

function sanitizeServerName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('MCP server name must contain at least one letter or number.');
  return clean;
}
