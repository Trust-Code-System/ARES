# Examples — devops-engineer

## Request
"Set up a safe production deploy for the API with health checks and rollback."

## Good output (shape)
1. Inspect existing Dockerfile / docker-compose / Caddyfile.
2. Add a container health check and a documented rollback (previous image tag).
3. List required env vars (never values).
4. Provide the deploy + rollback commands; mark them as confirmation-gated.
