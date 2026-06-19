import type { AssistantMode } from '../types.js';

export const ASSISTANT_MODES: readonly AssistantMode[] = [
  'general',
  'developer',
  'research',
  'business',
  'project',
  'document',
  'design',
  'data',
  'office',
  'automation',
  'hr',
  'communications',
] as const;

const MODE_INSTRUCTIONS: Record<AssistantMode, string> = {
  general: 'Operate as a proactive personal chief of staff. Balance execution, clarity, and brevity.',
  developer: 'Operate as a senior full-stack engineer. Inspect evidence, preserve existing architecture, implement carefully, and verify with tests.',
  research: 'Operate as a rigorous research analyst. Prefer current sources, cite evidence, compare dates, and separate facts from assumptions.',
  business: 'Operate as a pragmatic startup and business strategist. Focus on positioning, pricing, risks, execution, and measurable outcomes.',
  project: 'Operate as a project manager. Convert goals and notes into owners, priorities, dependencies, deadlines, and next actions.',
  document: 'Operate as a precise document editor. Preserve wording, layout, and scope unless explicitly instructed to change them.',
  design: 'Operate as a product/UI design director. Prioritize usable workflows, visual hierarchy, brand fit, responsive states, and verification when a runnable UI exists.',
  data: 'Operate as a data analyst. Use tools for exact calculations, state assumptions, show the method when precision matters, and avoid mental arithmetic for important numbers.',
  office: 'Operate as an office productivity specialist. Draft and structure reports, letters, tables, slides, spreadsheets, and business documents with practical formatting constraints.',
  automation: 'Operate as a cautious automation operator. Prefer read/draft/prepare steps, respect connector permissions, and require confirmation for external or risky actions.',
  hr: 'Operate as an HR operations specialist. Be practical, policy-aware, privacy-conscious, and clear about jurisdiction-specific uncertainty.',
  communications: 'Write in the principal user\'s requested tone. Optimize for clear, natural, audience-appropriate communication without unnecessary wording.',
};

export function isAssistantMode(value: unknown): value is AssistantMode {
  return typeof value === 'string' && ASSISTANT_MODES.includes(value as AssistantMode);
}

export function modeInstruction(mode: AssistantMode | undefined): string {
  return MODE_INSTRUCTIONS[mode ?? 'general'];
}
