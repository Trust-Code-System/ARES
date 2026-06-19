export interface AgentPersona {
  role: string;
  expertise: string[];
  when_to_use: string[];
  when_not_to_use: string[];
  output_style: string;
  required_checks: string[];
  collaboration_rules: string[];
  handoff_format: string;
}
