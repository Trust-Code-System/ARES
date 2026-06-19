export class ResponseFormatter {
  conciseReport(title: string, sections: Record<string, string | string[]>): string {
    const lines = [`**${title}**`];
    for (const [name, value] of Object.entries(sections)) {
      lines.push(`\n${name}:`);
      if (Array.isArray(value)) lines.push(...value.map((item) => `- ${item}`));
      else lines.push(value);
    }
    return lines.join('\n');
  }
}
