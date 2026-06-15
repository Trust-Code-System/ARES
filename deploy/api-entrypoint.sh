#!/bin/sh
# Apply DB migrations (idempotent), then start the API server. Migrations are
# retried so a brief DB cold-start doesn't crash the container on first boot.
set -e

echo "[ares] applying database migrations..."
n=0
until npm run migrate; do
  n=$((n + 1))
  if [ "$n" -ge 10 ]; then
    echo "[ares] migrations still failing after $n attempts — giving up." >&2
    exit 1
  fi
  echo "[ares] migrate attempt $n failed; retrying in 3s..." >&2
  sleep 3
done

echo "[ares] starting API server..."
exec npm run serve
