# ARES API server (src/server). Runs the agent + HTTP API on port 3001.
# Two stages: install deps once, then a lean runtime that runs migrations on
# boot and serves via tsx (the backend is TypeScript-first; no compile step).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Full install (incl. devDeps) — tsx/typescript live there and run the server.
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tini for clean signal handling; python3 backs the run_python tool; ca-certs for TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY deploy/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh && mkdir -p /data/workspace
EXPOSE 3001
ENTRYPOINT ["tini", "--", "/usr/local/bin/api-entrypoint.sh"]
