export interface ContextSource {
  id: string;
  type: 'user_request' | 'memory' | 'project' | 'skill' | 'file' | 'tool_result' | 'research_source';
  title: string;
  content: string;
  createdAt?: string;
}

export interface ContextPack {
  request: string;
  sources: ContextSource[];
  tokenBudget?: number;
  warnings: string[];
}
