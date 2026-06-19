/**
 * Playwright-backed {@link BrowserController}.
 *
 * Kept separate from browser.ts so the tool/safety layer carries no static
 * Playwright dependency (tests inject a fake controller, never touch this file).
 * Playwright itself is imported lazily on first use, so the app boots without the
 * browser binary; a missing binary surfaces as a clear install hint via the
 * `guard()` in browser.ts.
 *
 * The page-introspection script runs in the browser context, so it is passed as a
 * STRING to page.evaluate — the project's tsconfig has no DOM lib, and a string
 * body keeps `document`/`location` out of tsc's sight. Each interactive element is
 * tagged with a `data-ares-ref` attribute so fill/click/submit resolve a stable
 * ref rather than a brittle generated selector.
 */

import type { Browser, Page } from 'playwright';
import type { BrowserController, NavResult, PageSnapshot } from './browser.js';

export interface PlaywrightControllerOptions {
  headless: boolean;
  timeoutMs: number;
}

// Browser-context introspection. Returns the page's url/title/text and every
// interactive element tagged with a stable `data-ares-ref`. Flags secret-bearing
// fields (type=password or a name/label/autocomplete that looks sensitive).
const SNAPSHOT_SCRIPT = `(() => {
  const sensitiveRe = /pass|pwd|otp|one-?time|\\bpin\\b|cvv|cvc|secret|token|seed|mnemonic|private[-_ ]?key|card[-_ ]?number|credit/i;
  const fields = [];
  const buttons = [];
  let i = 0;
  const els = Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], a[href]'));
  for (const el of els) {
    const ref = 'e' + (i++);
    el.setAttribute('data-ares-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase() || undefined;
    const name = el.getAttribute('name') || undefined;
    const id = el.id || undefined;
    let label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || undefined;
    if (!label && id) { const l = document.querySelector('label[for="' + id + '"]'); if (l && l.textContent) label = l.textContent.trim(); }
    if (!label) { const t = (el.textContent || '').trim(); if (t) label = t.slice(0, 80); }
    const auto = el.getAttribute('autocomplete') || '';
    const hay = [type, name, id, label, auto].filter(Boolean).join(' ');
    const sensitive = type === 'password' || sensitiveRe.test(hay);
    const info = { ref, tag, type, name, id, label, sensitive };
    const isButton = tag === 'button' || type === 'submit' || type === 'button' || el.getAttribute('role') === 'button' || tag === 'a';
    if (isButton) buttons.push(info); else fields.push(info);
  }
  const text = (document.body && document.body.innerText) ? document.body.innerText : '';
  return { url: location.href, title: document.title, text: text, fields: fields, buttons: buttons };
})()`;

const sel = (ref: string): string => `[data-ares-ref="${ref.replace(/"/g, '')}"]`;

export function createPlaywrightController(opts: PlaywrightControllerOptions): BrowserController {
  let browser: Browser | undefined;
  let page: Page | undefined;

  async function ensurePage(): Promise<Page> {
    if (page) return page;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: opts.headless });
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    return page;
  }

  return {
    async navigate(url: string, timeoutMs: number): Promise<NavResult> {
      const p = await ensurePage();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { url: p.url(), title: await p.title() };
    },

    async snapshot(): Promise<PageSnapshot> {
      const p = await ensurePage();
      return (await p.evaluate(SNAPSHOT_SCRIPT)) as PageSnapshot;
    },

    async fill(ref: string, value: string): Promise<void> {
      const p = await ensurePage();
      await p.fill(sel(ref), value);
    },

    async click(ref: string): Promise<void> {
      const p = await ensurePage();
      await p.click(sel(ref));
    },

    async submit(ref: string | undefined, timeoutMs: number): Promise<NavResult> {
      const p = await ensurePage();
      const target = ref ? sel(ref) : 'button[type=submit], input[type=submit], button:not([type])';
      await p.click(target, { timeout: timeoutMs });
      // A submit usually navigates; tolerate forms that update in place.
      await p.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
      return { url: p.url(), title: await p.title() };
    },

    async close(): Promise<void> {
      await browser?.close().catch(() => {});
      browser = undefined;
      page = undefined;
    },
  };
}
