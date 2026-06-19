/** Assembles the default tool registry. Add new tools here (see README). */

import { ToolRegistry } from './registry.js';
import type { Tool } from '../types.js';
import { getCurrentTime } from './builtin/getCurrentTime.js';
import { calculate } from './builtin/calculate.js';
import { createNotifyTool } from './builtin/notify.js';
import { createFileTools } from './builtin/files.js';
import { createTaskTools } from './builtin/tasks.js';
import { webFetch } from './builtin/webFetch.js';
import { createWebSearchTool, type SearchProvider } from './builtin/webSearch.js';
import { createDeepResearchTool } from './builtin/deepResearch.js';
import { createRecordingTool } from './builtin/recording.js';
import { createImageGenerationTool } from './builtin/imageGeneration.js';
import type { Synthesizer } from '../llm/synthesize.js';
import type { ImageGenerator } from '../llm/imageGen.js';
import { createShellTool, type ShellToolOptions } from './builtin/shell.js';
import { createTradingTools, type BrokerProvider } from './builtin/trading.js';
import { createGithubTools, type GithubClient } from './builtin/github.js';
import { createMemoryTools } from './builtin/memory.js';
import type { StructuredStore } from '../memory/stores.js';
import { createPythonTool, type PythonToolOptions } from './builtin/python.js';
import { createSystemActionTools } from './builtin/systemActions.js';
import { createDocumentTools } from './builtin/documents.js';
import { createRemotionTool } from './builtin/remotion.js';
import { createSkillTools } from '../skills/index.js';
import { createAgentTools } from '../agents/index.js';
import { createMcpManagementTools } from '../mcp/tools.js';
import type { Provider } from '../llm/router.js';
import type { SkillUsageStore } from '../skills/usage.js';
import type { VisionExtractor } from '../llm/vision.js';
import type { NotificationStore } from '../notifications/store.js';
import type { TaskStore } from '../tasks/store.js';

export interface RegistryOptions {
  /** Workspace root the file tools are jailed to. */
  workspaceDir: string;
  /** Optional web-search backend. web_search is registered only when present. */
  searchProvider?: SearchProvider;
  /**
   * Single-shot LLM synthesizer. When present, analyze_transcript is registered;
   * combined with a searchProvider it also enables deep_research.
   */
  synthesizer?: Synthesizer;
  /** Image generator backend. generate_image is registered only when present. */
  imageGenerator?: ImageGenerator;
  /** Sandboxed shell tool config. Registered only when `enabled` is true. */
  shell?: { enabled: boolean } & Omit<ShellToolOptions, 'workspaceDir'>;
  /** Dedicated Python tool config. Registered only when `enabled` is true. */
  python?: { enabled: boolean } & Omit<PythonToolOptions, 'workspaceDir'>;
  /** Cross-platform approved application and URL launch tools. */
  systemActionsEnabled?: boolean;
  /** Remotion video scaffolder. Registered only when enabled (default off). */
  remotionEnabled?: boolean;
  /** Optional broker backend. Trading tools are registered only when present. */
  tradingProvider?: BrokerProvider;
  /** Optional GitHub client. The github_* dev tools are registered only when present. */
  githubClient?: GithubClient;
  /** Structured memory tools. Present in normal runtime, optional in isolated tests. */
  structuredStore?: StructuredStore;
  /**
   * Vision extractor (Claude) for document image OCR. When present, the
   * `extract_image_text` tool is registered; absent, it's omitted.
   */
  visionExtractor?: VisionExtractor;
  /** Notification history store. When present, `notify` records every delivery. */
  notificationStore?: NotificationStore;
  /** Task store. When present, the create_task/list_tasks/update_task tools are registered. */
  taskStore?: TaskStore;
  /**
   * Expert skill library. When present, find_skill/use_skill and the gated
   * install_skill_repo tool are registered over the vendored skills directory.
   * An optional usageStore records each successful use_skill load.
   */
  skills?: { dir: string; usageStore?: SkillUsageStore };
  /**
   * Specialist-agent (persona) library. When present, the read-only
   * find_agent/use_agent/agent_route tools are registered over the personas
   * directory. `availableProviders` keeps agent_route's model choice honest.
   */
  agents?: { dir: string; usageStore?: SkillUsageStore; availableProviders?: ReadonlySet<Provider> };
  /** Additional tools to register (e.g. tools imported from MCP servers). */
  extraTools?: Tool[];
  /** Managed MCP config file for install/list/enable/disable MCP tools. */
  mcpConfigPath?: string;
}

export function createDefaultRegistry(opts: RegistryOptions): ToolRegistry {
  const registry = new ToolRegistry()
    .register(getCurrentTime)
    .register(calculate)
    .register(createNotifyTool(opts.notificationStore ? { store: opts.notificationStore } : {}))
    .register(webFetch);

  for (const tool of createFileTools(opts.workspaceDir)) registry.register(tool);

  for (const tool of createDocumentTools({
    workspaceDir: opts.workspaceDir,
    ...(opts.visionExtractor ? { vision: opts.visionExtractor } : {}),
  })) {
    registry.register(tool);
  }

  if (opts.searchProvider) registry.register(createWebSearchTool(opts.searchProvider));

  // deep_research needs both a search backend and a synthesizer to write the report.
  if (opts.searchProvider && opts.synthesizer) {
    registry.register(createDeepResearchTool({ search: opts.searchProvider, synthesize: opts.synthesizer }));
  }

  // analyze_transcript (Record Mode) needs only a synthesizer.
  if (opts.synthesizer) registry.register(createRecordingTool(opts.synthesizer));

  // generate_image needs a configured image provider; it writes into the workspace jail.
  if (opts.imageGenerator) {
    registry.register(createImageGenerationTool(opts.imageGenerator, opts.workspaceDir));
  }

  if (opts.shell?.enabled) {
    registry.register(
      createShellTool({
        workspaceDir: opts.workspaceDir,
        allowlist: opts.shell.allowlist,
        timeoutMs: opts.shell.timeoutMs,
        maxOutputBytes: opts.shell.maxOutputBytes,
      }),
    );
  }

  if (opts.python?.enabled) {
    registry.register(createPythonTool({
      workspaceDir: opts.workspaceDir,
      command: opts.python.command,
      timeoutMs: opts.python.timeoutMs,
      maxOutputBytes: opts.python.maxOutputBytes,
    }));
  }

  if (opts.systemActionsEnabled) {
    for (const tool of createSystemActionTools()) registry.register(tool);
  }

  if (opts.remotionEnabled) {
    registry.register(createRemotionTool(opts.workspaceDir));
  }

  if (opts.tradingProvider) {
    for (const tool of createTradingTools(opts.tradingProvider)) registry.register(tool);
  }

  if (opts.githubClient) {
    for (const tool of createGithubTools(opts.githubClient)) registry.register(tool);
  }

  if (opts.structuredStore) {
    for (const tool of createMemoryTools(opts.structuredStore)) registry.register(tool);
  }

  if (opts.taskStore) {
    for (const tool of createTaskTools(opts.taskStore)) registry.register(tool);
  }

  if (opts.mcpConfigPath) {
    for (const tool of createMcpManagementTools({ configPath: opts.mcpConfigPath })) registry.register(tool);
  }

  if (opts.skills) {
    for (const tool of createSkillTools({
      skillsDir: opts.skills.dir,
      ...(opts.skills.usageStore ? { usageStore: opts.skills.usageStore } : {}),
    })) {
      registry.register(tool);
    }
  }

  if (opts.agents) {
    for (const tool of createAgentTools({
      agentsDir: opts.agents.dir,
      ...(opts.agents.usageStore ? { usageStore: opts.agents.usageStore } : {}),
      ...(opts.agents.availableProviders ? { availableProviders: opts.agents.availableProviders } : {}),
    })) {
      registry.register(tool);
    }
  }

  for (const tool of opts.extraTools ?? []) registry.register(tool);

  return registry;
}

export { ToolRegistry } from './registry.js';
