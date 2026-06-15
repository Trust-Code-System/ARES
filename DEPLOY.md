# Deploying ARES (single VPS, Docker Compose)

> **Hosting the web UI on Vercel instead?** See [VERCEL.md](VERCEL.md) — the API
> still needs a persistent host (it can't run on Vercel serverless), so you run
> [docker-compose.api.yml](docker-compose.api.yml) here for the API and let Vercel
> serve `web/`.

This brings up four containers on one server:

| Service     | What it is                                  | Exposed |
|-------------|---------------------------------------------|---------|
| `caddy`     | Reverse proxy + automatic HTTPS             | 80, 443 |
| `web`       | Next.js UI (`web/`)                         | internal |
| `api`       | Agent + HTTP API (`src/server`, port 3001)  | internal |
| `dragonfly` | Redis-compatible store for the scheduler + memory queue | internal |

**Postgres is not run here** — `DATABASE_URL` must point at your managed Postgres
(Supabase etc.) with the `vector` extension available. The **desktop app is a
local client**, not deployed; it just points at the API URL.

---

## 1. Prerequisites

- A VPS (Ubuntu/Debian) with **Docker** + the **Compose plugin** installed.
- A **domain** with two DNS `A` records pointing at the server's IP:
  - `ares.example.com`        → web UI
  - `api.ares.example.com`    → API
- Ports **80** and **443** open. (No domain? See "IP-only" at the bottom.)
- A managed Postgres reachable from the internet (your existing `DATABASE_URL`).

## 2. Get the code + configure

```bash
git clone https://github.com/Trust-Code-System/ARES.git
cd ARES
git checkout feat/jarvis-voice-hud   # until merged to master

# Put your real secrets in .env (NOT committed). Start from the example if needed:
#   cp .env.example .env && edit it
# Your .env must contain at least:
#   ARES_API_KEY=<32+ random chars>     (openssl rand -base64 32)
#   ANTHROPIC_API_KEY=...   and/or  GEMINI_API_KEY=...
#   DATABASE_URL=postgres://...         (managed PG, reachable from the server)
# Then add the deploy line:
echo 'ARES_DOMAIN=ares.example.com' >> .env
```

See [.env.deploy.example](.env.deploy.example) for the deploy-specific additions.
`REDIS_URL`, `ARES_API_HOST`, and `ARES_API_ORIGINS` are set automatically by
[docker-compose.yml](docker-compose.yml) — you don't need them in `.env`.

> **Why a domain matters for the API URL:** the browser calls the API directly,
> so the web image is **built** with `NEXT_PUBLIC_ARES_API=https://api.${ARES_DOMAIN}`.
> Change the domain → rebuild `web` (step 4 with `--build`).

## 3. Launch

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f api      # watch migrations run, then "ARES API online"
```

Caddy obtains TLS certs automatically on first request. Then open
`https://ares.example.com`, and log in with your `ARES_API_KEY`.

## 4. Updating after a code change

```bash
git pull
docker compose up -d --build     # rebuilds changed images, recreates containers
```

Database migrations run automatically on every API boot (idempotent).

## 5. Point the desktop app at it

On your machine (not the server):

```bash
# Windows PowerShell
$env:ARES_API_URL = "https://api.ares.example.com"
npm run desktop
```

The desktop client (`desktop/main.py`) talks to that API for chat, voice
transcription, and TTS.

## 6. Operations

```bash
docker compose logs -f api web caddy   # tail logs
docker compose restart api             # restart one service
docker compose down                    # stop everything (keeps volumes/data)
docker compose down -v                 # ALSO wipes Dragonfly + workspace volumes
```

Persistent state lives in named volumes: `dragonfly-data` (queue/scheduler),
`ares-workspace` (the agent's file workspace), `caddy-data` (TLS certs). Your
actual memory/audit data lives in **Postgres**, not in these volumes.

---

## IP-only (no domain)

Automatic HTTPS needs a domain. To run on a bare IP over plain HTTP for testing:

1. Skip Caddy and publish the app ports. Create `docker-compose.override.yml`:

   ```yaml
   services:
     api:
       ports: ["3001:3001"]
       environment:
         ARES_API_ORIGINS: "http://YOUR_IP:3000"
     web:
       ports: ["3000:3000"]
       build:
         args:
           NEXT_PUBLIC_ARES_API: "http://YOUR_IP:3001"
     caddy:
       profiles: ["disabled"]   # don't start Caddy
   ```

2. `docker compose up -d --build`, then open `http://YOUR_IP:3000`.

This is fine for a quick test, but **use a domain + HTTPS for anything real** —
mic access and secure cookies behave badly over plain HTTP, and the API key
would travel unencrypted.
