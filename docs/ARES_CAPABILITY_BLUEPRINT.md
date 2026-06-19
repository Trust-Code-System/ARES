# ARES Capability Blueprint

This blueprint turns the Claude/Jarvis feature brief into an explicit ARES
checklist. Broad project requests should be processed against every lane here so
ARES does not answer one part and silently leave the rest behind.

## Core Lanes

| Lane | ARES handling |
| --- | --- |
| Reasoning and planning | Break requests into intent, context, tools, risk, execution, verification, and concise output. |
| Coding and codebase work | Inspect the repository, make scoped edits, run relevant checks, and preserve existing architecture. |
| Document intelligence | Read PDFs, Word docs, spreadsheets, text files, and images when OCR is configured. |
| Long context and project knowledge | Use chat history, semantic memory, structured facts, and project-specific scope. |
| Connectors and MCP | Use configured app connectors and manage MCP servers through gated tools. |
| Deep research | Gather multiple angles, compare evidence, and separate facts from assumptions. |
| Deep research synthesis | Run `deep_research` to plan sub-queries, read multiple sources, and produce one cited report artifact. |
| Web verification | Use current search/fetch for unstable facts and check source dates. |
| Output workspace | Create reusable files, reports, briefs, code assets, or document outputs when chat is not enough. |
| Skills | Load repeatable expert playbooks before answering from general knowledge. |
| File engine | Create, read, edit, compare, summarize, and validate workspace files through jailed tools. |
| Computer mode | Treat desktop actions as useful but risky; require confirmation before changing the user world. |
| UI design | Provide product/UI direction and verify runnable frontends when available. |
| Data analysis | Use tools for calculations, spreadsheets, and datasets; show method for precision. |
| Office work | Draft reports, letters, slides, tables, policies, and business documents. |
| Memory | Store and retrieve preferences, project facts, decisions, contacts, tasks, and do-not-do rules. |
| Meeting intelligence | Turn transcripts into a summary, decisions, action items (owners/dates), and open questions via `analyze_transcript`. |
| Image generation | Render images into the workspace with `generate_image` when configured; else provide prompts/direction. |
| Effort control | Match depth to the request; honor the per-turn quick/standard/deep effort level. |
| Hallucination control | Cite sources for serious claims and say when evidence is insufficient. |
| Autonomy permissions | Apply approval levels for read, draft, low-risk action, external action, and blocked dangerous work. |
| Audit log | Record tool requests, gate decisions, executions, failures, and run lifecycle events. |
| Project workspaces | Keep ARES, PetroBrain, DocuScan, Atlas HR, marketing, office, and other project contexts separated. |

## Runtime Wiring

- The canonical list lives in [`src/agent/capabilities.ts`](../src/agent/capabilities.ts).
- The system prompt imports the same checklist for CLI, API server, scheduler, and autonomous runs.
- `/api/status` exposes runtime capability coverage as `capabilities`.
- The Tools page displays the full coverage list; the Dashboard summarizes active blueprint lanes.

## Configuration-Dependent Lanes

Some lanes are always present because they are part of the agent loop: reasoning,
audit logging, hallucination control, autonomy permissions, and project mode.
Other lanes depend on providers or env vars:

| Capability | Typical configuration |
| --- | --- |
| Persistent memory | `DATABASE_URL` plus an embedding provider |
| Web research | `TAVILY_API_KEY` or grounded search provider |
| Python/data execution | `ARES_PYTHON_ENABLED=true` |
| Shell/codebase execution | `ARES_SHELL_ENABLED=true` |
| GitHub tools | `GITHUB_TOKEN` |
| System/computer actions | `ARES_SYSTEM_ACTIONS_ENABLED=true` |
| Active app connectors | `ARES_MCP_SERVERS` or managed MCP server config |
| Image OCR | `ANTHROPIC_API_KEY` for the vision extractor |

