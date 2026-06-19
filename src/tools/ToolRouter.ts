import type { ToolDefinition } from './ToolDefinition.js';
import { ToolExecutionGuard } from './ToolExecutionGuard.js';
import { ToolResultNormalizer } from './ToolResultNormalizer.js';

export class AresToolRouter {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly guard = new ToolExecutionGuard(), private readonly normalizer = new ToolResultNormalizer()) {}

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const decision = this.guard.check(tool);
    if (!decision.allowed) throw new Error(decision.reason ?? `Tool denied: ${name}`);
    if (decision.confirmationRequired) throw new Error(`Tool requires confirmation: ${name}`);
    if (!tool.execute) throw new Error(`Tool has no executor: ${name}`);
    return this.normalizer.normalize(await tool.execute(input));
  }
}
