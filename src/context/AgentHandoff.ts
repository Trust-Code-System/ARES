export interface AgentHandoff {
  from: string;
  to: string;
  task: string;
  context: string;
  constraints: string[];
  expectedOutput: string;
  verification: string[];
}
