# ARES web UI (Next.js 15). Build context is ./web.
# NEXT_PUBLIC_ARES_API is inlined at BUILD time (it's a client-side URL), so it
# must be the public URL of the API as seen from the user's browser.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_ARES_API
ENV NEXT_PUBLIC_ARES_API=$NEXT_PUBLIC_ARES_API
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Standalone output: a minimal server bundle + the static assets it serves.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
