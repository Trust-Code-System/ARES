---
name: "form-filling"
description: "Use when the user asks ARES to complete an online form — a registration, job application, government form, invoice, HR form, or any web form — using the browser_* tools. ARES fills fields but NEVER submits without explicit confirmation and NEVER types passwords or other secrets. NOT for writing browser test suites (use playwright-pro) or large-scale scraping (use browser-automation)."
---

# ARES Skill: Form Filling

## Purpose

Help the user complete online forms with the headless-browser tools, while
holding a hard safety line: fill the form, show the user what was entered, and
submit **only** after they explicitly approve.

Enabled only when `ARES_BROWSER_ENABLED=true` (and the Chromium binary is
installed: `npx playwright install chromium`).

## When to use

- The user asks ARES to fill an application, registration, government form,
  invoice, HR form, or any web form.
- The user wants ARES to enter known, non-secret data into a page's fields.

## When NOT to use

- Writing browser tests / E2E suites → use **playwright-pro**.
- Bulk scraping / data pipelines → use **browser-automation**.
- Anything requiring a password, OTP, card number, or other secret to be typed —
  ARES refuses; the user must enter those themselves.

## Required rules (non-negotiable)

- **Never submit automatically.** Submitting is a separate, confirmation-gated
  tool (`browser_submit`). Fill, summarize, then ask before submitting.
- **Never type secrets.** `browser_fill` refuses any value that looks like a
  password/OTP/key/token, and refuses to type into a password/sensitive field.
- **Never invent user data.** If a required field's value is unknown, ask the
  user — do not guess.
- **Show a review summary** of every filled field before submission.
- Navigation is SSRF-guarded and http(s)-only.

## Tools (the ARES `browser_*` built-ins)

| Tool | Kind | Use |
| --- | --- | --- |
| `browser_navigate` | read-only | Open an http(s) page. |
| `browser_read` | read-only | Read page text + fields/buttons (each with a `ref`); flags sensitive fields. |
| `browser_fill` | gated | Fill non-secret fields by `ref`. Does not submit. |
| `browser_click` | gated | Click a non-submit element (expand, choose a radio, etc.). |
| `browser_submit` | gated (high-risk) | Submit the form — only after explicit user confirmation. |
| `browser_close` | read-only | Close the browser session. |

## Tools forbidden

- Any tool that stores passwords or credentials.
- Submitting payment or changing account settings without confirmation.

## Workflow

1. `browser_navigate` to the form URL.
2. `browser_read` to discover fields (note any `sensitive: true` fields — leave
   those for the user).
3. `browser_fill` the known, non-secret fields.
4. Summarize what was filled and what remains (especially sensitive fields).
5. Ask the user to confirm. Only then call `browser_submit`.

## Example

> **User:** "Fill this form and submit it."
>
> **ARES (good):** Reads the form, fills name/email/address, then: *"I've filled
> Name, Email, and Address. The Password field I've left for you to enter
> manually. Here's the summary — shall I submit?"* — and submits only after a yes.
>
> **ARES (bad, never do this):** Fills everything and immediately submits, or types
> a password the user pasted into chat.
