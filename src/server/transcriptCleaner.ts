/**
 * Optional LLM cleanup pass for voice transcripts.
 *
 * Speech-to-text mishears technical/product names ("ChatGPT MCP" -> "gptcmcp",
 * "Kubernetes" -> "cooper netties"). A small per-term vocabulary bias (voice.ts)
 * catches the known cases, but it can't scale to everything a user might say.
 * This pass instead runs the raw transcript through the fast model, whose broad
 * world knowledge fixes mishearings of names/brands/jargon with no hand-kept list.
 *
 * It is best-effort and conservative: it never throws (a model hiccup returns the
 * original text), and it refuses outputs that look like the model "answered" the
 * message instead of just cleaning it. Opt-in via ARES_VOICE_CLEANUP=true.
 */

import type { Synthesizer } from '../llm/synthesize.js';

export type TranscriptCleaner = (text: string) => Promise<string>;

const SYSTEM_PROMPT = `You repair errors in a speech-to-text transcript of a short dictated message.
The raw transcript may contain misheard technical or product names, brand names, acronyms, or words that were wrongly split or merged (e.g. "gptcmcp" -> "ChatGPT MCP", "cooper netties" -> "Kubernetes", "ant tropic" -> "Anthropic").
Rules:
- Return ONLY the corrected transcript text. No quotes, no preamble, no commentary, no explanation.
- Fix obvious mishearings of well-known names, acronyms, and split/merged words using context.
- Otherwise preserve the speaker's exact wording, meaning, language, and punctuation. Do NOT answer, expand, summarize, translate, or add anything.
- If the transcript already looks correct, return it unchanged.`;

/**
 * Bind a {@link TranscriptCleaner} to a {@link Synthesizer}. Runs on the fast tier
 * and caps output growth so a model that ignores the rules (and answers the
 * message) can't replace the user's words with a long response.
 */
export function buildTranscriptCleaner(synthesize: Synthesizer): TranscriptCleaner {
  return async (text) => {
    const original = text.trim();
    if (!original) return text;
    try {
      const result = await synthesize(SYSTEM_PROMPT, original, { tier: 'fast', maxTokens: 500 });
      const cleaned = result.trim();
      // Reject empty output or a response so much longer it's clearly not a cleanup
      // (the model answered the message instead of correcting it).
      if (!cleaned) return original;
      if (cleaned.length > original.length * 3 + 60) return original;
      return cleaned;
    } catch {
      // Cleanup is a nicety — never let it fail the transcription.
      return original;
    }
  };
}
