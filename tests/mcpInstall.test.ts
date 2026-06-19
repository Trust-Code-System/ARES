/**
 * Managed MCP server installer/config tools. Offline only: these tests write a
 * temporary config file and never start a real MCP subprocess.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  activeMcpServers,
  loadMcpConfigFile,
  mcpServerFromNpmPackage,
  setMcpServerEnabled,
  upsertMcpServer,
} from '../src/mcp/configStore.js';
import { createMcpManagementTools } from '../src/mcp/tools.js';
import type { Logger, ToolContext } from '../src/types.js';

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger: silentLogger, runId: 'test' };

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('managed MCP config store', () => {
  it('upserts npm package servers and exposes only enabled servers as active', () => {
    const configPath = tempConfigPath();
    const server = mcpServerFromNpmPackage({
      name: 'File System',
      npmPackage: '@modelcontextprotocol/server-filesystem',
      packageArgs: ['C:/work'],
    });

    assert.equal(server.name, 'file-system');
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work']);
    assert.equal(server.enabled, false);

    upsertMcpServer(configPath, server);
    assert.equal(loadMcpConfigFile(configPath).servers.length, 1);
    assert.deepEqual(activeMcpServers(configPath), []);

    setMcpServerEnabled(configPath, 'file-system', true);
    const active = activeMcpServers(configPath);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0], {
      name: 'file-system',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'],
    });
  });
});

describe('MCP management tools', () => {
  it('install_mcp_server writes disabled npm config by default, then list shows it', async () => {
    const configPath = tempConfigPath();
    const tools = createMcpManagementTools({ configPath });
    const list = tools[0];
    const install = tools[1];

    const empty = await list.execute({}, ctx);
    assert.equal(empty.ok, true);
    assert.match(empty.content, /No MCP servers/);

    const installed = await install.execute({
      name: 'github',
      npm_package: '@modelcontextprotocol/server-github',
      package_args: ['--stdio'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    }, ctx);
    assert.equal(installed.ok, true);
    assert.match(installed.content, /Installed MCP server "github"/);

    const config = loadMcpConfigFile(configPath);
    assert.equal(config.servers[0]?.enabled, false);
    assert.equal(config.servers[0]?.source, 'npm:@modelcontextprotocol/server-github');

    const after = await list.execute({}, ctx);
    assert.match(after.content, /github: disabled/);
  });

  it('enables and removes installed MCP servers', async () => {
    const configPath = tempConfigPath();
    const tools = createMcpManagementTools({ configPath });
    const install = tools[1];
    const setEnabled = tools[2];
    const remove = tools[3];

    await install.execute({
      name: 'custom',
      command: 'node',
      args: ['server.js'],
      enabled: true,
    }, ctx);

    assert.equal(activeMcpServers(configPath).length, 1);
    const disabled = await setEnabled.execute({ name: 'custom', enabled: false }, ctx);
    assert.equal(disabled.ok, true);
    assert.equal(activeMcpServers(configPath).length, 0);

    const removed = await remove.execute({ name: 'custom' }, ctx);
    assert.equal(removed.ok, true);
    assert.equal(loadMcpConfigFile(configPath).servers.length, 0);
  });
});

function tempConfigPath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ares-mcp-config-'));
  roots.push(root);
  return path.join(root, 'mcp.servers.json');
}
