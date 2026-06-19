export interface PromptTemplate {
  id: string;
  description: string;
  template: string;
}

export class PromptTemplateRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): void {
    this.templates.set(template.id, template);
  }

  render(id: string, vars: Record<string, string>): string {
    const template = this.templates.get(id);
    if (!template) throw new Error(`Unknown prompt template: ${id}`);
    return template.template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => vars[key] ?? '');
  }
}
