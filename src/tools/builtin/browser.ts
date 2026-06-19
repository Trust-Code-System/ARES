/**
 * Browser / form-filling tools (Playwright). OFF BY DEFAULT — enabled only when
 * `ARES_BROWSER_ENABLED=true`, because it drives a real browser against live
 * sites.
 *
 * Safety model (mirrors the master prompt's Form Filling skill):
 *   - NEVER auto-submit. Filling fields is one gated tool; *submitting* is a
 *     separate, explicitly-named tool so the confirmation prompt and audit log
 *     read "ARES wants to SUBMIT a form", not a generic click.
 *   - NEVER type secrets. browser_fill refuses any value that looks like a
 *     password/OTP/key/token (the same detector the gate uses) and refuses to
 *     type into a password/sensitive field. The user enters those manually.
 *   - SSRF-guarded navigation: the model can't point the browser at localhost,
 *     the cloud metadata endpoint, or the internal network (same guard as
 *     web_fetch).
 *   - read/navigate are read_only; fill/click/submit are state_mutating, so they
 *     pass through the confirmation gate like every other external action.
 *
 * The Playwright dependency is loaded lazily inside {@link createPlaywrightController}
 * so the app boots without it; if the browser binary is missing the tool returns
 * a clear "run npx playwright install chromium" message instead of crashing.
 *
 * The tools take an injectable {@link BrowserController}, so the safety logic is
 * unit-tested against a fake page with no real browser (see tests/browser.test.ts).
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.js';
import { defineTool } from '../define.js';
import { assertPublicUrl, SsrfError } from '../net/ssrf.js';
import { containsSensitiveData, isSensitiveKey } from '../../security/redactor.js';

/** One interactive element on the page, tagged with a stable ref for fill/click. */
export interface InteractiveElement {
  /** Stable handle assigned by the last snapshot, e.g. "e3". Use it in fill/click. */
  ref: string;
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  /** Password/secret-bearing field — ARES must never type into it. */
  sensitive: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Truncated visible text of the page. */
  text: string;
  /** Inputs / textareas / selects. */
  fields: InteractiveElement[];
  /** Buttons and submit controls. */
  buttons: InteractiveElement[];
}

export interface NavResult {
  url: string;
  title: string;
}

/**
 * The minimal browser surface the tools need. The real implementation wraps
 * Playwright; tests inject a fake. `ref` is the handle returned by snapshot().
 */
export interface BrowserController {
  navigate(url: string, timeoutMs: number): Promise<NavResult>;
  snapshot(): Promise<PageSnapshot>;
  fill(ref: string, value: string): Promise<void>;
  click(ref: string): Promise<void>;
  /** Submit the form owning `ref` (or the page's primary form) and await navigation. */
  submit(ref: string | undefined, timeoutMs: number): Promise<NavResult>;
  close(): Promise<void>;
}

const MAX_TEXT = 8000;

export function createBrowserTools(controller: BrowserController, timeoutMs = 30000): Tool[] {
  // Remember the last snapshot so fill/click can resolve a ref to an element and
  // enforce the "never type into a sensitive field" rule.
  let lastElements = new Map<string, InteractiveElement>();

  const rememberSnapshot = (snap: PageSnapshot): void => {
    lastElements = new Map([...snap.fields, ...snap.buttons].map((e) => [e.ref, e]));
  };

  const navigate = defineTool({
    name: 'browser_navigate',
    description:
      'Open a web page in the headless browser. Read-only (a GET navigation). Follow with ' +
      'browser_read to see the page text and its form fields/buttons. Only http(s) URLs on ' +
      'the public internet are allowed.',
    kind: 'read_only',
    schema: z.object({ url: z.string().describe('Absolute http(s) URL to open.') }),
    async execute(input): Promise<ToolResult> {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return { ok: false, content: `Not a valid URL: ${input.url}` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, content: 'Only http and https URLs are allowed.' };
      }
      try {
        await assertPublicUrl(url);
      } catch (err) {
        if (err instanceof SsrfError) return { ok: false, content: err.message };
        throw err;
      }
      return guard(async () => {
        const res = await controller.navigate(url.toString(), timeoutMs);
        return { ok: true, content: `Opened ${res.url} — "${res.title}".`, data: res };
      });
    },
  });

  const read = defineTool({
    name: 'browser_read',
    description:
      'Read the current page: its visible text plus a list of form fields and buttons, each ' +
      'with a `ref` to use in browser_fill / browser_click / browser_submit. Sensitive ' +
      '(password-like) fields are flagged and must be left for the user to fill manually.',
    kind: 'read_only',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      return guard(async () => {
        const snap = await controller.snapshot();
        rememberSnapshot(snap);
        const summary = {
          url: snap.url,
          title: snap.title,
          fields: snap.fields.map((f) => ({ ref: f.ref, tag: f.tag, type: f.type, label: f.label ?? f.name ?? f.id, sensitive: f.sensitive })),
          buttons: snap.buttons.map((b) => ({ ref: b.ref, label: b.label ?? b.name ?? b.id })),
        };
        const text = snap.text.length > MAX_TEXT ? `${snap.text.slice(0, MAX_TEXT)}…[truncated]` : snap.text;
        return { ok: true, content: `${JSON.stringify(summary)}\n\n--- page text ---\n${text}`, data: summary };
      });
    },
  });

  const fill = defineTool({
    name: 'browser_fill',
    description:
      'Fill one or more form fields by their `ref` (from browser_read). Does NOT submit. ' +
      'Refuses to type secrets (passwords, OTPs, keys, tokens) or to type into a password/' +
      'sensitive field — ask the user to enter those manually. Call browser_read first.',
    kind: 'state_mutating',
    schema: z.object({
      fields: z
        .array(z.object({ ref: z.string().describe('Element ref from browser_read.'), value: z.string() }))
        .min(1)
        .describe('Field ref → value pairs to fill.'),
    }),
    async execute(input): Promise<ToolResult> {
      // Refuse the whole call if ANY value looks like a secret — fail closed.
      for (const f of input.fields) {
        if (containsSensitiveData(f.value) || isSensitiveKey(f.value)) {
          return {
            ok: false,
            content:
              'Refused: a value appears to be a password/OTP/key/token. ARES never types secrets — ' +
              'ask the user to enter it manually.',
          };
        }
        const el = lastElements.get(f.ref);
        if (el?.sensitive) {
          return {
            ok: false,
            content: `Refused: field ${f.ref} ("${el.label ?? el.name ?? el.id}") is a sensitive field. The user must fill it manually.`,
          };
        }
      }
      return guard(async () => {
        const filled: string[] = [];
        for (const f of input.fields) {
          await controller.fill(f.ref, f.value);
          filled.push(f.ref);
        }
        return { ok: true, content: `Filled ${filled.length} field(s): ${filled.join(', ')}. Not submitted.`, data: { filled } };
      });
    },
  });

  const click = defineTool({
    name: 'browser_click',
    description:
      'Click a non-submit element by `ref` (e.g. expand a section, choose a radio/checkbox, ' +
      'open a menu). To submit a form, use browser_submit instead so the action is confirmed ' +
      'as a submission.',
    kind: 'state_mutating',
    schema: z.object({ ref: z.string().describe('Element ref from browser_read.') }),
    async execute(input): Promise<ToolResult> {
      return guard(async () => {
        await controller.click(input.ref);
        return { ok: true, content: `Clicked ${input.ref}.`, data: { ref: input.ref } };
      });
    },
  });

  const submit = defineTool({
    name: 'browser_submit',
    description:
      'SUBMIT a form — a high-risk, state-changing action (it may create an account, place an ' +
      'order, or send data). Always requires confirmation. Show the user a summary of what was ' +
      'filled and submit only after they approve. Optionally pass the submit button `ref`.',
    kind: 'state_mutating',
    schema: z.object({
      ref: z.string().describe('Optional submit-button ref from browser_read.').optional(),
    }),
    async execute(input): Promise<ToolResult> {
      return guard(async () => {
        const res = await controller.submit(input.ref, timeoutMs);
        return { ok: true, content: `Submitted. Now at ${res.url} — "${res.title}".`, data: res };
      });
    },
  });

  const close = defineTool({
    name: 'browser_close',
    description: 'Close the browser session and free resources. Read-only.',
    kind: 'read_only',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      await controller.close();
      lastElements = new Map();
      return { ok: true, content: 'Browser closed.' };
    },
  });

  return [navigate, read, fill, click, submit, close];
}

/** Run a controller call, turning a missing-browser error into a helpful message. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install|Cannot find module 'playwright'/i.test(msg)) {
      return {
        ok: false,
        content: 'The browser is not installed. Run: npx playwright install chromium',
      };
    }
    return { ok: false, content: `Browser action failed: ${msg}` };
  }
}
