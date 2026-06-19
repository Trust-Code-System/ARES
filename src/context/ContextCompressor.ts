export class ContextCompressor {
  compress(text: string, maxChars = 4000): string {
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.6)).trim();
    const tail = text.slice(-Math.floor(maxChars * 0.3)).trim();
    return `${head}\n\n[...compressed ${text.length - head.length - tail.length} chars...]\n\n${tail}`;
  }
}
