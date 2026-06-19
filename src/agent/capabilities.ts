/**
 * Claude-inspired ARES capability blueprint.
 *
 * This is not marketing copy. It is the runtime checklist ARES should use when a
 * broad "Jarvis/Claude-like" request arrives, and the status surface the UI can
 * show so missing configuration is visible instead of silently ignored.
 */

export type CapabilityId =
  | 'reasoning'
  | 'coding'
  | 'documents'
  | 'long_context_memory'
  | 'connectors_mcp'
  | 'research'
  | 'deep_research'
  | 'web_verification'
  | 'output_workspace'
  | 'skills'
  | 'file_engine'
  | 'computer_mode'
  | 'ui_design'
  | 'data_analysis'
  | 'office_work'
  | 'memory'
  | 'meeting_intelligence'
  | 'image_generation_boundary'
  | 'effort_control'
  | 'hallucination_control'
  | 'autonomy_permissions'
  | 'audit_log'
  | 'project_workspaces';

export interface CapabilityBlueprintItem {
  id: CapabilityId;
  label: string;
  strength: 'core' | 'strong' | 'medium' | 'guarded' | 'external';
  mode: string;
  instruction: string;
}

export interface RuntimeCapability {
  id: CapabilityId;
  label: string;
  enabled: boolean;
  detail: string;
  strength: CapabilityBlueprintItem['strength'];
}

export const CAPABILITY_BLUEPRINT: readonly CapabilityBlueprintItem[] = [
  {
    id: 'reasoning',
    label: 'Reasoning and planning',
    strength: 'core',
    mode: 'general',
    instruction:
      'Break complex goals into intent, context, tool needs, risk, execution steps, verification, and a concise final answer.',
  },
  {
    id: 'coding',
    label: 'Coding and codebase work',
    strength: 'strong',
    mode: 'developer',
    instruction:
      'Read the repository before changing it, preserve local architecture, edit scoped files, run relevant checks, and report verification.',
  },
  {
    id: 'documents',
    label: 'Document intelligence',
    strength: 'strong',
    mode: 'document',
    instruction:
      'Extract, summarize, compare, validate, and preserve wording/layout requirements for PDFs, Word docs, spreadsheets, images, and text.',
  },
  {
    id: 'long_context_memory',
    label: 'Long context and project knowledge',
    strength: 'strong',
    mode: 'project',
    instruction:
      'Use chat history, semantic retrieval, structured memories, and project-specific facts instead of treating each request as isolated.',
  },
  {
    id: 'connectors_mcp',
    label: 'Connectors and MCP',
    strength: 'strong',
    mode: 'automation',
    instruction:
      'Use configured connectors for external apps, respect inherited permissions, and manage MCP servers through the MCP tools when asked.',
  },
  {
    id: 'research',
    label: 'Deep research',
    strength: 'strong',
    mode: 'research',
    instruction:
      'For research tasks, gather multiple angles, compare sources, cite evidence, and separate confirmed facts from assumptions.',
  },
  {
    id: 'deep_research',
    label: 'Deep research synthesis',
    strength: 'strong',
    mode: 'research',
    instruction:
      'For questions that need several angles weighed, use deep_research to plan sub-queries, read multiple sources, and produce one cited report; save it as an artifact when it is substantial.',
  },
  {
    id: 'web_verification',
    label: 'Current web verification',
    strength: 'strong',
    mode: 'research',
    instruction:
      'Use current search/fetch tools for unstable facts, check dates, rank source quality, and avoid fake confidence.',
  },
  {
    id: 'output_workspace',
    label: 'Output workspace',
    strength: 'medium',
    mode: 'office',
    instruction:
      'When output is substantial or reusable, create or update an artifact-like file, report, document, spreadsheet, slide brief, or code asset.',
  },
  {
    id: 'skills',
    label: 'Repeatable skills',
    strength: 'core',
    mode: 'general',
    instruction:
      'For specialized repeatable work, find and load the relevant skill before answering from general knowledge.',
  },
  {
    id: 'file_engine',
    label: 'File creation and editing',
    strength: 'strong',
    mode: 'document',
    instruction:
      'Create, read, edit, convert, summarize, compare, and validate workspace files through jailed file/document tools.',
  },
  {
    id: 'computer_mode',
    label: 'Computer and desktop actions',
    strength: 'guarded',
    mode: 'automation',
    instruction:
      'Treat desktop/app/browser actions as useful but risky; use approved actions only and require confirmation before changing the user world.',
  },
  {
    id: 'ui_design',
    label: 'UI and design direction',
    strength: 'medium',
    mode: 'design',
    instruction:
      'Design usable interfaces, layouts, and creative direction, then verify visual fit when a runnable UI exists.',
  },
  {
    id: 'data_analysis',
    label: 'Data analysis',
    strength: 'medium',
    mode: 'data',
    instruction:
      'Use tools for exact calculations, spreadsheets, charts, and datasets; show method when precision matters.',
  },
  {
    id: 'office_work',
    label: 'Presentations and office work',
    strength: 'medium',
    mode: 'office',
    instruction:
      'Draft reports, tables, letters, slides, policies, and business documents while keeping final formatting review in mind.',
  },
  {
    id: 'memory',
    label: 'Structured memory',
    strength: 'strong',
    mode: 'project',
    instruction:
      'Store and retrieve user preferences, project facts, decisions, contacts, tasks, and do-not-do rules as structured memory.',
  },
  {
    id: 'meeting_intelligence',
    label: 'Meeting and voice-note intelligence',
    strength: 'medium',
    mode: 'office',
    instruction:
      'Turn meeting/voice-note transcripts into action with analyze_transcript: summary, decisions, action items (owners/dates), and open questions; then create_task and remember_memory for the items worth keeping.',
  },
  {
    id: 'image_generation_boundary',
    label: 'Image generation',
    strength: 'medium',
    mode: 'design',
    instruction:
      'When an image is wanted, prefer generate_image to render it into the workspace if that tool is available; otherwise provide prompts, direction, or diagrams and say native generation is not configured.',
  },
  {
    id: 'effort_control',
    label: 'Effort and response depth',
    strength: 'core',
    mode: 'general',
    instruction:
      'Match effort to the request: answer quick asks briefly, and for deep/critical work be thorough, verify with tools, and check your own reasoning. The principal can also set the per-turn effort level explicitly.',
  },
  {
    id: 'hallucination_control',
    label: 'Hallucination control',
    strength: 'guarded',
    mode: 'research',
    instruction:
      'Say when evidence is insufficient, cite sources for serious claims, and distinguish facts, assumptions, and recommendations.',
  },
  {
    id: 'autonomy_permissions',
    label: 'Autonomy and permissions',
    strength: 'guarded',
    mode: 'automation',
    instruction:
      'Apply autonomy levels: answer, draft, read, low-risk action, approval-required external action, blocked dangerous action.',
  },
  {
    id: 'audit_log',
    label: 'Audit log',
    strength: 'core',
    mode: 'automation',
    instruction:
      'Record tool requests, gate decisions, executed actions, failures, run starts, and run finishes for traceability.',
  },
  {
    id: 'project_workspaces',
    label: 'Project workspaces',
    strength: 'strong',
    mode: 'project',
    instruction:
      'Keep PetroBrain, DocuScan, Atlas HR, ARES, marketing, office, and other project contexts separated by memory and task scope.',
  },
] as const;

export const ARES_CAPABILITY_PROMPT = [
  '## Capability blueprint',
  'When the principal gives a broad feature, project, or "make ARES/Jarvis process this" request, classify it against the full ARES capability blueprint. Do not drop parts silently.',
  'Use this checklist:',
  ...CAPABILITY_BLUEPRINT.map((item) => `- ${item.label}: ${item.instruction}`),
  'If a category is unavailable because a provider/tool/connector is not configured, say that plainly and continue with the best available path.',
].join('\n');

