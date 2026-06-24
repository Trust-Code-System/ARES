# Importing Skills & MCP Servers

ARES can pull in third-party **skills** (SKILL.md playbooks) and **MCP servers**
the same way Claude and Codex do — by pasting a GitHub URL or naming an npm
package. There are three entry points for each: the chat agent, the web
dashboard, and the CLI.

## Skills from a GitHub repo

**1. Just ask in chat.** The agent has a confirmation-gated `install_skill_repo`
tool:

> Install the skills from https://github.com/org/skill-pack

It clones files only (never executes repo code), runs the static security
scanner, refuses activation on `critical`+ findings, then refreshes
`find_skill`/`use_skill` so the new skills are immediately usable.

**2. Web dashboard.** Open **Skills** (`/skills/import`), paste the repo URL
(optional ref), and click **Install**. The page shows how many skills landed and
the scanner report, then refreshes the library list. Backed by
`POST /api/skills/import` → the same `installSkillRepo` installer the chat tool
uses.

**3. CLI.**

```bash
npm run skills:import -- https://github.com/org/repo
npm run skills:audit
npm run skills:list
npm run skills:enable -- imported/skill-id
```

The CLI importer writes skills under `skills/imported/` **disabled** pending
audit. (The chat/web installer instead activates into the managed
`skills/.installed/owner/repo` area after the scan passes.) Neither path ever
executes imported scripts — bundled scripts run only through the gated, audited
`run_python` tool.

## MCP servers (Gmail, Calendar, filesystem, …)

**1. Just ask in chat.** The agent has `install_mcp_server`,
`list_mcp_servers`, `set_mcp_server_enabled`, and `remove_mcp_server`:

> Install the filesystem MCP from npm package @modelcontextprotocol/server-filesystem

**2. Web dashboard.** Open **MCP** (`/mcp`) to install an npm-package or custom
stdio server, then enable/disable/remove installed servers. Backed by
`GET /api/mcp`, `POST /api/mcp/install`, `POST /api/mcp/<name>/enable|disable`,
and `DELETE /api/mcp/<name>`.

**3. Env.** Set `ARES_MCP_SERVERS` (a JSON array) for servers to import at
startup.

Servers are written to the managed config at `ARES_MCP_CONFIG_PATH`
(default `./mcp.servers.json`) and installed **disabled** by default. Tools from
enabled servers are imported on the **next ARES restart**.
