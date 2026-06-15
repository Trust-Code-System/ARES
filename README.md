# ARES — Autonomous Reasoning & Execution System

A personal autonomous AI assistant ("Jarvis") for a single principal user. Not a
chatbot — a persistent agentic system that perceives, reasons, acts through tools,
and logs everything.

> **Status: Phases 1–4 complete; Phase 5 (web UI) in progress.** The agent loop +
> tool dispatch (Phase 1), persistent two-store memory (Phase 2), the full safety
> backbone + tool suite (Phase 3), and autonomy (Phase 4) are built and runnable
> end to end. Phase 5's **API server** (`npm run serve`) is built and tested, with
> a live token-streaming chat endpoint and OpenAI-backed voice; the **Next.js UI**
> in [web/](web) (chat + dashboard + voice) is built and run-verified against it.
>
> - **Phase 3 — Tools:** files (sandboxed), `web_fetch` (SSRF-guarded),
>   `web_search`, `notify`, the **MCP bridge** (Gmail/Calendar imported as gated
>   tools), the sandboxed **`run_command`** tool, and gated **trading** tools —
>   over the standing-rules engine, confirmation queue, and hard **spend/trade caps**.
> - **Phase 4 — Autonomy:** the **kill switch**, the **activity feed**, the
>   **autonomous runner**, a **scheduler** (BullMQ/Redis + in-memory fallback)
>   driving the **morning briefing** and **inbox scan**, a **webhook** trigger
>   layer, and off-hot-path memory ingestion. Run the daemon with `npm run
>   scheduler`, a one-off autonomous task with `npm run autonomous`, and the kill
>   switch with `npm run control`.

## What's here

```
src/
  index.ts              Composition root — wires everything, CLI + REPL
  config.ts             Env loading, fail-fast validation
  types.ts              Core interfaces (the seams between every part)
  llm/
    anthropic.ts        Anthropic Messages API wrapper
    openai.ts           OpenAI Responses API adapter (streaming + tool replay)
    gemini.ts           Gemini generateContent adapter (streaming + tool replay)
    factory.ts          Select provider from ARES_LLM_PROVIDER
  agent/
    orchestrator.ts     THE AGENT LOOP: perceive → retrieve → reason → act → log
  tools/
    registry.ts         The tool registry (catalog + schema rendering)
    define.ts           defineTool — Zod schema → JSON schema + runtime validation
    permissions.ts      Durable tool enable/disable (in-memory + Postgres)
    confirmation.ts     Basic gate (auto/deny/prompt) — used in tests/dev
    index.ts            createDefaultRegistry(options)
    builtin/            get_current_time, calculate, notify, files, documents, tasks, webFetch, webSearch, shell, trading
    net/ssrf.ts         SSRF guard (private-IP/redirect checks) for web_fetch
  safety/
    store.ts            Rules + queue contracts, in-memory impls, rule matching
    pgStore.ts          Postgres rules + queue
    gate.ts             RuleBasedConfirmationGate (caps → rules → prompt → queue)
    caps.ts             SpendCapEnforcer + CostLedger (hard money limits, in-memory ledger)
    pgStore.ts          Postgres rules + queue + durable cost ledger
    factory.ts          buildSafetyBackend() — DB vs in-memory wiring
  mcp/
    client.ts           McpClient interface + FakeMcpClient (offline/test double)
    classify.ts         read-only vs state-mutating classifier (fail-safe)
    bridge.ts           importMcpTools() — wrap MCP tools as gated ARES tools
    sdkClient.ts        SdkMcpClient — MCP SDK over stdio (the real connection)
    factory.ts          buildMcpTools() — connect configured servers, import tools
  autonomy/
    store.ts            Kill switch + activity feed contracts, in-memory impls
    pgStore.ts          Postgres kill switch + activity feed
    runner.ts           AutonomousRunner (kill-switch gated, feed-logged, abortable)
    scheduler.ts        Scheduler contract + nextRun(cron) + InMemoryScheduler
    bullmqScheduler.ts  BullMQ/Redis scheduler (durable, the production path)
    jobs.ts             agentJob/maintenanceJob builders (schedule → runner)
    briefingJobs.ts     morning-briefing + inbox-scan job definitions
    webhooks.ts         WebhookHandler + WebhookServer (external events → runner)
    factory.ts          buildAutonomyBackend() + buildScheduler() — DB/Redis vs in-memory
  db/
    client.ts           Postgres pool wrapper (Db interface) + pgvector helpers
    migrate.ts          Migration runner (`npm run migrate`)
  memory/
    types.ts            Memory vocabulary (StructuredFact, MemoryChunk, …)
    embeddings.ts       EmbeddingClient: Voyage (prod) + offline hash (dev/test)
    stores.ts           SemanticStore/StructuredStore + in-memory impls
    pgStores.ts         Postgres impls (pgvector search, deduped upsert)
    retriever.ts        DbMemoryRetriever (top-k semantic + structured) + Null
    ingestor.ts         MemoryIngestor: extract facts + embed exchange + store
    consolidation.ts    Nightly dedupe + summarize pass
    queue.ts            Off-hot-path ingestion: in-process MemoryQueue + writer
    bullmqQueue.ts      Durable BullMQ/Redis ingestion queue + worker
    factory.ts          buildMemoryBackend() — DB/Redis vs in-memory wiring
  server/
    api.ts              ApiHandler — JSON endpoints over every backend (pure, tested)
    httpServer.ts       node:http adapter + SSE chat stream + voice endpoints
    auth.ts             API-key + session authentication
    schemas.ts          Zod schemas for HTTP request bodies
    voice.ts            Composable OpenAI/Gemini STT + OpenAI/ElevenLabs TTS
    index.ts            `npm run serve` — the API server composition root
  scripts/
    consolidate.ts      CLI for the consolidation job (`npm run consolidate`)
  logging/
    logger.ts           Console logger + in-memory audit log
    pgAuditLog.ts       Append-only Postgres audit log (immutable)
migrations/
  0001_memory_and_audit.sql   structured_memory, semantic_memory, audit_log
  0002_safety.sql             standing_rules, confirmation_queue
  0003_autonomy.sql           kill_switch (singleton), activity_feed
  0004_cost_ledger.sql        cost_ledger (durable rolling-window spend total)
  0005_userdata.sql           notifications, tasks, tool_permissions
```

### The agent loop (Phase 1)

`Agent.run()` in [src/agent/orchestrator.ts](src/agent/orchestrator.ts) implements a
**manual** agentic loop (not the SDK tool runner) so that every tool call can be
intercepted by the confirmation gate and recorded in the audit log:

1. **Perceive** — take an input (a user message or, later, a triggered event).
2. **Retrieve** — pull relevant memory and inject it into the system prompt
   (stubbed to empty in Phase 1).
3. **Reason** — call Claude with the full tool schema and adaptive thinking.
4. **Act** — execute any `tool_use` blocks through the registry; state-mutating
   tools route through the confirmation gate first. Feed results back.
5. **Loop** until the model stops requesting tools, hits the iteration cap, or
   refuses.
6. **Log** — every model response, tool request, gate decision, and execution is
   written to the audit log as an immutable event.

### Tool dispatch

Each tool is a typed function with a JSON schema and a `kind`
(`read_only` | `state_mutating`), registered centrally. The `kind` is enforced in
**code**, not in the prompt: `state_mutating` tools cannot run without passing the
confirmation gate.

### Memory (Phase 2)

Two stores, persisted to Postgres (Supabase) — never flat files:

- **`structured_memory`** — typed, deduped facts about the user's world:
  `fact · person · project · preference · decision`. One table with a `kind`
  discriminator; kind-specific fields live in a JSONB `attributes` column.
- **`semantic_memory`** — embedded chunks of conversations/documents/events,
  retrieved by cosine similarity (`pgvector`, HNSW index).

The loop is closed at both ends:

- **Before reasoning** ([retriever.ts](src/memory/retriever.ts)): the incoming
  message is embedded, the top-k semantic chunks and the most relevant structured
  facts are pulled, and both are folded into the system prompt as a context block.
- **After a run** ([ingestor.ts](src/memory/ingestor.ts)): the exchange is chunked
  and embedded into `semantic_memory`, and the **fast** model is asked — via a
  *forced* `record_memory` tool call, so the output is schema-valid by
  construction — to extract durable facts, which are upserted (deduped on a
  normalized `kind:subject:content` key) into `structured_memory`. Ingestion is
  guarded so a memory failure can never fail the user's turn. As of Phase 4 it runs
  **off the hot path** ([queue.ts](src/memory/queue.ts)): the orchestrator only
  *enqueues* the finished exchange and returns; a background worker drains the queue
  and does the embedding/extraction. One-shot CLIs `flushMemory()` before exit. With
  `REDIS_URL` set the queue is durable ([bullmqQueue.ts](src/memory/bullmqQueue.ts)):
  enqueued exchanges persist in Redis and survive a crash/restart (a worker — in
  the same process, or a dedicated one — picks them up); in-process otherwise.
- **Nightly** ([consolidation.ts](src/memory/consolidation.ts), `npm run
  consolidate`): near-duplicate chunks are superseded and old conversations are
  summarized into compact `summary` chunks. Nothing is deleted — rows are marked
  `superseded_at` and excluded from retrieval, preserving the audit trail.

The **audit log** also moves to Postgres in this phase
([pgAuditLog.ts](src/logging/pgAuditLog.ts)): an append-only table with an
UPDATE/DELETE trigger that enforces immutability in the database itself.

> **No infra? It still runs.** Without `DATABASE_URL`/`VOYAGE_API_KEY`, ARES falls
> back to in-memory stores and an offline hash embedder so the pipeline works end
> to end — but it logs a warning and **nothing persists across restarts**. This is
> a dev convenience, not a persistence mode.

### Tools & safety (Phase 3)

Tools are split read-only vs. state-mutating; the split is enforced in the loop,
not the prompt. Current suite:

| Tool | Kind | Notes |
| --- | --- | --- |
| `read_file` · `list_files` | read-only | Jailed to `ARES_WORKSPACE_DIR`; path-escape + symlink checks. |
| `write_file` | state-mutating | Same jail; gated. |
| `read_pdf` · `read_docx` · `read_spreadsheet` | read-only | Document text extraction in the same workspace jail (PDF via pdf-parse, DOCX via mammoth, XLSX/XLS/CSV via SheetJS → CSV). Output capped to bound context. |
| `extract_image_text` | read-only | Image/screenshot OCR via **Claude vision** (png/jpg/gif/webp). Registered only when `ANTHROPIC_API_KEY` is set; works even if the reasoning provider is OpenAI/Gemini. |
| `web_fetch` | read-only | http(s) only, **SSRF guard** (blocks private/loopback/link-local/metadata IPs, re-checked per redirect hop), timeout + size cap, HTML→text. |
| `web_search` | read-only | Google-grounded Gemini search or Tavily; registered when the selected provider has a key. |
| `notify` | state-mutating | Push to the user (terminal for now); each delivery is recorded to `notifications` history when a store is wired. |
| `create_task` · `update_task` | state-mutating | Manage the principal's task list (durable `tasks` table). Gated like `remember_memory`. |
| `list_tasks` | read-only | List/filter the principal's tasks. |
| `search_memory` · `remember_memory` · `forget_memory` | read-only / gated | Explicit structured-memory recall, write, and forget. |
| `run_command` | state-mutating | **Off by default.** Allowlisted programs only, no shell, jailed cwd, hard timeout, output cap. |
| `run_python` | state-mutating | Isolated Python process, jailed cwd, hard timeout/output cap, and always gated. |
| `open_application` · `open_url` | state-mutating | Approved app aliases and HTTP(S) URLs only; always gated. |
| `get_positions` · `get_balance` | read-only | **Off by default.** Brokerage reads via a pluggable provider — paper broker, or **Alpaca** (`ARES_BROKER=alpaca`). |
| `place_trade` | state-mutating | **Off by default.** Gated + subject to the hard trade notional cap. Executes via the paper or Alpaca broker. |
| `calculate` · `get_current_time` | read-only | Deterministic built-ins. |
| *MCP-imported* (Gmail, Calendar, …) | classified per tool | Imported from MCP servers; read verbs → read-only, everything else → gated. |

**The confirmation gate** ([safety/gate.ts](src/safety/gate.ts)) decides every
state-mutating call in this order:

0. **Hard spend/trade caps** ([safety/caps.ts](src/safety/caps.ts)) — checked
   *first* and overriding everything below (even `auto` mode and standing rules). A
   call whose cost (read from its input via configured cost fields) would breach the
   per-action limit, the rolling-window limit, or the trade notional cap is denied
   in code. The model cannot talk its way past a money limit. The rolling-window
   total is read from a `CostLedger` — Postgres-backed (`cost_ledger`, migration
   `0004`) when `DATABASE_URL` is set, so the window survives restarts; in-memory
   otherwise (the window resets on restart).
1. **Mode** — `ARES_CONFIRMATION_MODE=auto` approves (dev), `deny` blocks all
   (read-only safe mode).
2. **Standing rules** ([safety/store.ts](src/safety/store.ts)) — a matching
   `allow`/`deny` rule decides with no human (deny wins). Rules match a tool name
   (or `*`) plus a subset predicate over the input.
3. **Human present** (TTY / injected prompter) — prompt `y` / `n` / `a`. Choosing
   **always** persists a standing allow-rule so you're never re-asked for that tool.
4. **No human** — the request is parked in the **confirmation queue** (durable)
   and the call returns not-approved with the queue id. This is what lets Phase 4's
   autonomous runs avoid both silent mutation *and* hanging on a prompt.

Rules and the queue persist to Postgres (migration `0002`) when `DATABASE_URL` is
set, in-memory otherwise.

### External tools via MCP (Gmail, Calendar, …)

ARES reaches external services by acting as an **MCP client**: it connects to
stdio MCP servers, lists their tools, and imports them into the *same* registry as
the built-ins ([mcp/bridge.ts](src/mcp/bridge.ts)). An imported tool is just a
`Tool` with a `kind`, so it passes through the confirmation gate and audit log
with no special-casing — sending mail or creating a calendar event is gated
exactly like `write_file`. The read-only/state-mutating split is decided by a
**fail-safe classifier** ([mcp/classify.ts](src/mcp/classify.ts)): only recognized
read verbs (`list`, `get`, `search`, …) run ungated; recognized write verbs *and
anything unrecognized* are gated. Per-tool `classifyOverrides` cover exceptions.

Configure servers with `ARES_MCP_SERVERS` (a JSON array). Each entry is launched
as a subprocess; one failing to connect is logged and skipped, never fatal:

```json
[
  {
    "name": "gmail",
    "command": "npx",
    "args": ["-y", "@example/gmail-mcp-server"],
    "env": { "GOOGLE_OAUTH_TOKEN": "..." },
    "classifyOverrides": { "modify_labels": "state_mutating" }
  }
]
```

Imported tool names are namespaced (`gmail_send_email`) and sent to the model in
non-strict schema mode (upstream MCP schemas aren't authored for strict mode).
This unblocks the Phase-4 morning briefing and inbox-scan jobs, which need real
mail/calendar data. Exercising it end-to-end needs a real MCP server + Google
OAuth; the bridge, classifier, and import wrapping are covered by offline tests
against a `FakeMcpClient`.

### Autonomy control plane (Phase 4)

Autonomy means ARES acting **without a human at the keyboard** — on a schedule, or
woken by an event. Two primitives, built first because everything autonomous
depends on them, gate that:

- **The kill switch** ([autonomy/store.ts](src/autonomy/store.ts)) — a single,
  durable flag that **instantly pauses all autonomous activity**. The
  [autonomy/runner.ts](src/autonomy/runner.ts) checks it before a task starts (an
  engaged switch → the task is *skipped*, never silently dropped) **and** polls it
  during a run, so engaging the switch from anywhere — including a separate process
  via `npm run control stop` — trips the `AbortSignal` the agent loop already
  honors and stops an in-flight run. It is enforced in code, never the prompt.
- **The activity feed** ([autonomy/store.ts](src/autonomy/store.ts)) — every
  autonomous task is recorded with its lifecycle (`running` → `completed` /
  `failed` / `skipped` / `aborted`) and linked to its audit-log run. This is the
  high-level "what has ARES been doing" view the Phase 5 dashboard will render;
  the audit log remains the low-level immutable event stream beneath it.

The **autonomous runner** ([autonomy/runner.ts](src/autonomy/runner.ts)) wraps the
agent and enforces both invariants in one place. State-mutating tool calls are
still gated inside the loop (with no human present they queue rather than execute);
the kill switch is the bigger hammer that stops the run itself.

The **scheduler** ([autonomy/scheduler.ts](src/autonomy/scheduler.ts)) is what
makes ARES wake *itself* up. It holds named, cron-recurring jobs and fires their
handlers when due; the handlers are usually `AutonomousRunner` tasks (see
[autonomy/jobs.ts](src/autonomy/jobs.ts)), so every firing inherits the kill
switch and the activity feed for free. Same split as everywhere else:
`BullMqScheduler` (Redis, durable, survives restarts, the production path) when
`REDIS_URL` is set; `InMemoryScheduler` (zero-infra, jobs run only while the
process lives) otherwise. Cron strings are parsed in **local time**, so
`0 6 * * *` means 06:00 in the host's timezone. The autonomy daemon
([scripts/scheduler.ts](src/scripts/scheduler.ts)) wires the agent + runner +
scheduler and registers the **morning briefing** (06:00 daily — calendar + mail
summary + overnight news, delivered via `notify`), the **inbox scan** (hourly —
surface anything urgent), and, with a database, a nightly `consolidate`
maintenance job ([autonomy/briefingJobs.ts](src/autonomy/briefingJobs.ts)). Since
`notify` is gated and the daemon has no human, it seeds a standing allow-rule for
`notify` at startup so the briefing can actually reach you.

```bash
# run the autonomy daemon (fires scheduled jobs until Ctrl-C)
npm run scheduler
npm run scheduler -- --once morning-briefing   # fire one job immediately and exit

# run a one-off task on the autonomous path (no human; mutations queue)
npm run autonomous -- "summarize my day and flag anything urgent"
npm run autonomous -- --trigger schedule:test "draft a morning briefing"

# the human's hand on the kill switch
npm run control                 # state + recent activity
npm run control stop "too risky"  # pause ALL autonomous activity
npm run control resume          # allow it again
npm run control feed 20         # last 20 activity records
```

The morning briefing + inbox scan use the Gmail/Calendar tools when an MCP server
is configured (else they note the gap and continue). The daemon also exposes an
optional **webhook trigger** ([autonomy/webhooks.ts](src/autonomy/webhooks.ts)):
with `ARES_WEBHOOK_SECRET` set, `POST /webhook/<source>` (authenticated via the
`x-ares-token` header) turns an external event into an autonomous run through the
same kill-switch-gated, feed-logged runner. Kill switch and activity feed persist
to Postgres (migration `0003`) when `DATABASE_URL` is set, in-memory otherwise — and an
in-memory switch is per-process, so it can't be controlled from a second terminal.
Likewise the in-memory scheduler doesn't persist schedules; set `REDIS_URL` for a
durable, restart-surviving scheduler.

### Web interface (Phase 5)

The UI is split into a tested **API server** and a thin **Next.js client**:

- **API server** ([src/server](src/server), `npm run serve`, default
  `127.0.0.1:3001`) —
  `ApiHandler` is pure request→response over the existing backends, so it's
  unit-tested directly: `POST /api/chat` (+ an SSE `/api/chat/stream` that
  forwards **live model tokens and audit events** as the run unfolds — the
  orchestrator surfaces them through an optional `AgentEventHandlers` sink, not a
  post-hoc chunking of the final answer), the
  activity feed, per-run audit events, structured-fact browse (`/api/memory`) and
  **semantic browse** (`/api/memory/semantic?q=…`, which embeds the query and
  returns the top-k chunks by cosine similarity), the confirmation queue with
  approve/deny, the kill switch (read + flip), the tool catalog with on/off
  toggles, and the scheduled-job list. Voice endpoints
  (`/api/voice/transcribe`, `/api/voice/speak`) are backed by a pluggable
  `VoiceProvider` ([server/voice.ts](src/server/voice.ts)). Input and output are
  independently routed: Gemini or OpenAI for transcription, and ElevenLabs or
  OpenAI for speech. Without a complete input/output pair they return `501`.
- **Next.js client** ([web/](web), `cd web && npm install && npm run dev`) — a HUD
  chat that streams answers with live tool activity, specialist modes, push-to-talk,
  OpenAI speech playback, and interruption controls, plus a dashboard (kill switch,
  confirmation queue, capability status, tool toggles, jobs, activity feed,
  explicit remember/forget controls, structured facts, and semantic search). It is a thin client over the API and lives
  outside the root TypeScript build; see [web/README.md](web/README.md). **Built
  and run-verified** against the API server (Next.js 15 App Router + Tailwind 3,
  React 19): both pages render, the dashboard's CRUD calls (kill switch, tool
  toggles, confirmation approve/deny) and the chat SSE stream round-trip with
  token-level model output and live audit events. The chat client also surfaces
  runs that finish with **no answer**
  (error/refusal/aborted) instead of leaving the bubble blank.

```bash
npm run serve            # terminal 1 — API on :3001
cd web && npm install && npm run dev   # terminal 2 — UI on :3000
```

**Authentication.** Set `ARES_API_KEY` (>= 16 chars) to lock down the control
plane: every endpoint except `GET /api/health` and `POST /api/auth/login` then
requires a credential. Clients log in once (`POST /api/auth/login` with the key)
and receive a short-lived **session token** (TTL `ARES_SESSION_TTL_HOURS`, default
12h, in-memory) used as `Authorization: Bearer <token>`; the raw key is also
accepted directly (via `Authorization: Bearer` or `x-api-key`) for CLI/curl. Key
comparison is constant-time. The dashboard prompts for the key and stores only the
session token. If `ARES_API_KEY` is unset the API is unauthenticated (dev mode) —
allowed only on loopback; the server **refuses to bind a non-loopback
`ARES_API_HOST` without a key**. It also rejects browser origins outside
`ARES_API_ORIGINS`.

## Gemini, ElevenLabs, and desktop mode

ARES can use Gemini for reasoning, turn-based audio transcription, and
Google-grounded search while using ElevenLabs Flash v2.5 for low-latency speech
output. Provider selection remains configurable, so OpenAI and Anthropic continue
to work as fallbacks.

The current conversation transport is low-latency push-to-talk with interruptible
playback. It is not an always-open, full-duplex Gemini Live WebSocket session;
that requires a separate persistent audio/VAD transport and should not be enabled
under the same label.

The cross-platform PySide6 client lives in [desktop/](desktop). It streams chat,
records push-to-talk audio, plays and interrupts speech, displays live tool
activity, and renders a pulsing 3D-style avatar core.

```bash
npm run desktop:setup
npm run serve
npm run desktop
```

New gated local tools:

- `run_python` executes Python in isolated mode inside `ARES_WORKSPACE_DIR`.
- `open_application` opens an approved OS-specific application alias.
- `open_url` opens only absolute HTTP(S) URLs.

These tools are state-mutating and still require the normal ARES confirmation
gate. They do not bypass the audit log.

Relevant environment variables:

- `GEMINI_API_KEY`, `ARES_GEMINI_REASONING_MODEL`, `ARES_GEMINI_FAST_MODEL`
- `ARES_SEARCH_PROVIDER=auto|google|tavily`
- `ARES_VOICE_STT_PROVIDER=auto|gemini|openai`
- `ARES_VOICE_TTS_PROVIDER=auto|elevenlabs|openai`
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`
- `ARES_PYTHON_ENABLED`, `ARES_PYTHON_COMMAND`, `ARES_PYTHON_TIMEOUT_MS`
- `ARES_SYSTEM_ACTIONS_ENABLED`

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env      # then add your ANTHROPIC_API_KEY
```

### Memory backend (optional but recommended)

Point `DATABASE_URL` at a Postgres with the `vector` extension available
(Supabase has it), set `VOYAGE_API_KEY` for real embeddings, then create the
schema:

```bash
npm run migrate           # applies migrations/*.sql once, tracked in schema_migrations
```

The migration creates the `vector(1024)` embedding column. If you change the
embedding model/dimension, update both `ARES_EMBEDDING_DIM` and the migration —
the runner refuses to start on a mismatch.

### Run it

```bash
# one-shot
npm run ask -- "What's 1200 * 1.08 split over 12 months? Then notify me of the result."

# interactive REPL
npm start
```

```bash
npm test                  # offline unit/integration suite (no network/DB needed)
npm run typecheck         # tsc --noEmit
```

## Environment variables

| Variable                  | Default             | Purpose                                                      |
| ------------------------- | ------------------- | ------------------------------------------------------------ |
| `ARES_LLM_PROVIDER`       | `anthropic`         | Main reasoning provider: `anthropic` or `openai`.             |
| `ANTHROPIC_API_KEY`       | —                   | Required when the selected provider is Anthropic.             |
| `ARES_REASONING_MODEL`    | `claude-opus-4-8`   | Model for orchestration/reasoning.                           |
| `ARES_FAST_MODEL`         | `claude-sonnet-4-6` | Cheaper model for high-frequency sub-tasks (wired, not yet used). |
| `OPENAI_API_KEY`          | —                   | Required for OpenAI reasoning and enables voice mode.         |
| `ARES_OPENAI_REASONING_MODEL` | `gpt-5.5`       | OpenAI Responses API reasoning model.                         |
| `ARES_OPENAI_FAST_MODEL`  | `gpt-5.4-mini`      | OpenAI model for lower-cost extraction/maintenance work.      |
| `ARES_MAX_ITERATIONS`     | `12`                | Hard cap on tool-use round trips per run (`1`-`100`).        |
| `ARES_CONFIRMATION_MODE`  | `prompt`            | `prompt` (ask at terminal) · `auto` (approve, dev only) · `deny` (read-only safe mode). |
| `DATABASE_URL`            | — (optional)        | Postgres/Supabase connection string. Unset → ephemeral in-memory memory + audit. |
| `VOYAGE_API_KEY`          | — (optional)        | Voyage AI key for embeddings. Unset → offline hash embedder (poor recall). |
| `ARES_EMBEDDING_MODEL`    | `voyage-3.5`        | Embedding model.                                             |
| `ARES_EMBEDDING_DIM`      | `1024`              | Embedding dimension. **Must match the `vector(N)` column in the migration.** |
| `ARES_WORKSPACE_DIR`      | `./workspace`       | Sandbox the file tools are jailed to.                       |
| `TAVILY_API_KEY`          | — (optional)        | Enables `web_search`. Unset → the tool isn't registered.    |
| `REDIS_URL`               | — (optional)        | Redis for the BullMQ scheduler **and** the durable memory ingestion queue. Unset → in-memory scheduler + in-process queue (no persistence). |
| `ARES_MCP_SERVERS`        | — (optional)        | JSON array of stdio MCP servers to import tools from (see below). Unset → none. |
| `ARES_WEBHOOK_SECRET`     | — (optional)        | Shared secret enabling the daemon's webhook trigger endpoint. Unset → webhooks off. |
| `ARES_WEBHOOK_PORT`       | `8787`              | Port the webhook server listens on (daemon only). |
| `ARES_SPEND_PER_ACTION_LIMIT` | — (optional)    | Max cost of a single tool call. Unset → not enforced. |
| `ARES_SPEND_ROLLING_LIMIT` | — (optional)       | Max cumulative cost within the rolling window. |
| `ARES_SPEND_ROLLING_WINDOW_HOURS` | `24`        | Window for the rolling spend limit. |
| `ARES_TRADE_NOTIONAL_CAP` | — (optional)        | Hard ceiling on any single trade's notional. |
| `ARES_SPEND_COST_FIELDS`  | (built-in defaults) | JSON map of tool name → input field holding the cost amount. |
| `ARES_SHELL_ENABLED`      | `false`             | Set `true` to register the sandboxed `run_command` tool. |
| `ARES_SHELL_ALLOWLIST`    | (built-in defaults) | Comma-separated allowlist of bare program names `run_command` may run. |
| `ARES_SHELL_TIMEOUT_MS`   | `10000`             | Hard timeout (then SIGKILL) for a `run_command` call. |
| `ARES_TRADING_ENABLED`    | `false`             | Set `true` to register the trading tools (paper broker by default). |
| `ARES_TRADING_PAPER_CASH` | `100000`            | Starting cash for the paper broker. |
| `ARES_BROKER`             | `paper`             | Broker behind the trading tools: `paper` (in-memory) or `alpaca`. |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | — (optional) | Alpaca credentials; required when `ARES_BROKER=alpaca`. |
| `ALPACA_BASE_URL`         | paper endpoint      | Alpaca API host. Defaults to the **paper** endpoint; set the live host to trade real money. |
| `ARES_API_KEY`            | — (optional)        | Shared key locking down the HTTP API (>= 16 chars). When set, all endpoints except `/api/health` and `/api/auth/login` require it. **Required** to bind a non-loopback `ARES_API_HOST`. |
| `ARES_SESSION_TTL_HOURS`  | `12`                | Lifetime of a login session token (0 < h <= 720). |
| `ARES_API_HOST`           | `127.0.0.1`         | Bind host for the Phase-5 API server. Non-loopback requires `ARES_API_KEY`. |
| `ARES_API_PORT`           | `3001`              | Port for the Phase-5 API server (`npm run serve`). |
| `ARES_API_ORIGINS`        | local UI origins    | Comma-separated browser origin allowlist for the API. |
| `ARES_VOICE_STT_MODEL`    | `whisper-1`         | Speech-to-text model for voice mode. |
| `ARES_VOICE_TTS_MODEL`    | `tts-1`             | Text-to-speech model for voice mode. |
| `ARES_VOICE_TTS_VOICE`    | `alloy`             | TTS voice name. |
| `ARES_VOICE_TTS_FORMAT`   | `mp3`               | TTS audio container (mp3/opus/aac/flac/wav/pcm). |
| `OPENAI_BASE_URL`         | `https://api.openai.com/v1` | Override the OpenAI base URL (compatible gateways). |

## Adding a new tool

1. Create `src/tools/builtin/myTool.ts` with `defineTool` and a Zod schema:

   ```ts
   import { z } from 'zod';
   import type { ToolResult } from '../../types.js';
   import { defineTool } from '../define.js';

   export const myTool = defineTool({
     name: 'my_tool',
     description: 'Be specific about WHEN to call this, not just what it does.',
     kind: 'read_only', // or 'state_mutating' to route through the gate
     schema: z.object({ query: z.string().describe('…') }),
     async execute(input, ctx): Promise<ToolResult> {
       // input is typed + already validated; ctx gives logger, runId, AbortSignal
       return { ok: true, content: 'result text the model sees' };
     },
   });
   ```

2. Register it in [src/tools/index.ts](src/tools/index.ts):

   ```ts
   import { myTool } from './builtin/myTool.js';
   // …
   .register(myTool)
   ```

The Zod schema is the **single source of truth**: [defineTool](src/tools/define.ts)
derives the JSON `input_schema` the model sees (via `z.toJSONSchema`) AND keeps the
Zod schema for runtime validation. Before dispatch the orchestrator validates (and
strips/coerces) the model's arguments against it, passing the parsed value to
`execute`; malformed input is rejected with a readable error instead of running the
tool. MCP-imported tools keep their upstream raw JSON schema and fall back to
presence-checking `required`. State-mutating tools are gated and audited automatically.
HTTP request bodies are validated the same way via Zod schemas in
[src/server/schemas.ts](src/server/schemas.ts).

## Design principles enforced in code

- **Deterministic where it matters** — math runs in `calculate`'s parser, not the model.
- **Mutations are gated** — `state_mutating` tools require approval or a standing rule (Phase 3); enforced in the orchestrator, never the prompt.
- **Everything is auditable** — the `AuditLog` records each decision and action as an immutable event (append-only Postgres table, immutability enforced by a DB trigger).
- **Interfaces over implementations** — the orchestrator depends only on `types.ts`. Swapping in Postgres/pgvector and real tools is a change to the composition root, not the loop.

## Roadmap (not built yet)

- **Phase 3 — Tools: done.** The MCP bridge (Gmail/Calendar import, gated +
  audited), `web_fetch` SSRF hardening, the sandboxed `run_command` tool, and the
  gated trading tools (with the trade notional cap) — on top of the gate, standing
  rules, confirmation queue, files, `web_fetch`, and `web_search`.
- **Phase 4 — Autonomy: done.** Kill switch, activity feed, autonomous runner, the
  BullMQ/Redis scheduler (with in-memory fallback), the morning-briefing +
  hourly-inbox-scan jobs, the webhook trigger layer, off-hot-path memory ingestion,
  and hard spend/trade caps enforced in the gate.
- **Phase 5 — Interface (in progress):** the **API server** (`npm run serve`,
  [src/server](src/server)) exposing chat (SSE) + all dashboard data is **done and
  tested**; the **Next.js UI** ([web/](web)) — chat with a live tool-activity
  sidebar and a dashboard (memory, activity feed, jobs, tool toggles, confirmation
  approve/deny, kill switch) — and a **voice** mic button. The UI is built and
  run-verified against the API; voice supports Gemini/OpenAI transcription and
  ElevenLabs/OpenAI speech through the composable `VoiceProvider`.
  **Single-user authentication** (API key + session tokens) gates the API and the
  dashboard. Remaining: optional UI polish. The React app is intentionally outside
  the root TypeScript build.
