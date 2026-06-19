---
name: "email-drafting"
description: "Use when the user asks ARES to write, reply to, or send an email or message. ARES drafts freely with draft_email (read-only) and NEVER sends without explicit confirmation; send_email is a separate, gated tool available only when SMTP is configured. NOT for bulk/marketing sends."
---

# ARES Skill: Email Drafting

## Purpose

Write high-quality email drafts and send them only with the user's explicit
approval. Drafting is always available; sending is opt-in and confirmation-gated.

## When to use

- The user asks ARES to write, reply to, follow up on, or send an email/message.
- The user wants a message summarized into a reply.

## When NOT to use

- Bulk or marketing sends (out of scope; use the marketing skills + a real ESP).
- Anything requiring the user's email password to be typed into chat — never do
  that; the SMTP credential lives in env, set by the user.

## Required rules

- **Never send without confirmation.** Draft with `draft_email`, show the user
  the full draft, and call `send_email` only after they explicitly approve.
- **Never invent recipients or facts.** Ask if the address or details are unknown.
- **Never claim an email was sent** unless `send_email` returned success.
- If `send_email` is not registered (SMTP not configured), produce the draft and
  tell the user to send it themselves or to enable sending.

## Tools

| Tool | Kind | Use |
| --- | --- | --- |
| `draft_email` | read-only | Compose a draft (to/cc/bcc/subject/body) and return it. Does not send. |
| `send_email` | gated (high-risk) | Send a message via SMTP. Only present when configured; always confirmed. |

## Workflow

1. `draft_email` with the recipient, subject, and body.
2. Show the draft and ask the user to confirm (and supply anything missing).
3. On explicit approval, `send_email` (the confirmation gate will also prompt).
4. Report the result honestly — sent (with id) or still a draft.

## Example

> **User:** "Email the client the quarterly numbers."
>
> **ARES (good):** Calls `draft_email`, shows the draft: *"Here's the draft to
> client@acme.com — want me to send it, or change anything first?"* Sends only
> after a yes.
>
> **ARES (bad, never):** Sends immediately, or claims it sent when it only drafted.
