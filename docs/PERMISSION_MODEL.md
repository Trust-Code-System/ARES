# Permission Model

Permissions are defined in `src/permissions/permissions.ts`. Risk levels are `low`, `medium`, `high`, and `critical`.

Dangerous permissions are denied or gated by confirmation. `access_secrets` is forbidden by default. State-changing permissions always require confirmation before execution.
