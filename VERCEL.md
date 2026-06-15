# Deploying ARES: Web on Vercel + API on a VPS

Vercel hosts the **Next.js web UI**. The **API server cannot run on Vercel**
(it needs long-lived SSE streams, always-on BullMQ workers, in-memory sessions,
a held DB/Dragonfly connection, and shell/python tools — none of which fit
serverless). So the API runs on a small VPS via [docker-compose.api.yml](docker-compose.api.yml),
and the browser (served from Vercel) talks to it over HTTPS.

```
  Browser ──▶ https://ares.vercel.app            (Vercel: web UI)
         └──▶ https://api.yourdomain.com/api/...  (VPS: API + Dragonfly)
                                    └──▶ Postgres (managed, via DATABASE_URL)
```

You need: a **domain** (for the API's TLS) and a VPS. Decide the API URL up
front — it's baked into the web build.

---

## Part A — API on the VPS (do this first)

1. Create an Ubuntu VPS; point **`api.yourdomain.com`** (an `A` record) at its IP.
2. Install Docker, clone the repo, create `.env` (see [DEPLOY.md](DEPLOY.md) step 5),
   and add:
   ```bash
   ARES_DOMAIN=yourdomain.com
   ARES_WEB_ORIGIN=https://ares.vercel.app   # your Vercel URL(s), comma-separated
   # plus your existing ARES_API_KEY, ANTHROPIC/GEMINI keys, DATABASE_URL
   ```
3. Launch the API-only stack:
   ```bash
   docker compose -f docker-compose.api.yml up -d --build
   docker compose -f docker-compose.api.yml logs -f api   # wait for "ARES API online"
   ```
4. Verify: `curl https://api.yourdomain.com/api/health` → `{"ok":true}`.

> `ARES_WEB_ORIGIN` is the CORS allow-list. After Vercel gives you the real URL
> (Part B), make sure it's listed here, then `docker compose -f docker-compose.api.yml up -d`
> to apply. Include both the `*.vercel.app` URL and any custom domain.

## Part B — Web on Vercel

1. Push your branch (done): `feat/jarvis-voice-hud` on `Trust-Code-System/ARES`.
2. In Vercel → **Add New… → Project → Import** that GitHub repo.
3. Configure the project:
   - **Root Directory:** `web`
   - **Framework Preset:** Next.js (auto-detected)
   - **Production Branch:** `feat/jarvis-voice-hud` (or merge to `master` first)
4. Add an **Environment Variable** (Production + Preview), then deploy:
   ```
   NEXT_PUBLIC_ARES_API = https://api.yourdomain.com
   ```
   This is inlined at build time, so it must be set **before** the build. If you
   change it later, redeploy.
5. **Deploy.** You get `https://<project>.vercel.app`.
6. Back in Part A, set `ARES_WEB_ORIGIN` to that URL (and your custom domain if
   you add one in Vercel), and re-up the API so CORS allows it.

## Verify end-to-end

Open the Vercel URL, log in with your `ARES_API_KEY`, send a message. If the
chat hangs or the console shows a CORS error, the API's `ARES_WEB_ORIGIN`
doesn't match the exact Vercel origin — fix and re-up the API.

## Notes

- **Custom domain for the web** (e.g. `ares.yourdomain.com`): add it in Vercel's
  Domains tab, then add it to `ARES_WEB_ORIGIN` on the API. `NEXT_PUBLIC_ARES_API`
  stays the API URL.
- The web app's own `/api/market` route runs as a Vercel function — no conflict,
  since the ARES API lives on the separate `api.` host.
- Don't put `ARES_API_KEY` or `DATABASE_URL` in Vercel — the browser never needs
  them; only `NEXT_PUBLIC_ARES_API` belongs there.
