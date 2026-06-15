# Adapters

Records of tuned-model jobs and the resulting model ids — your rollback ledger.

For each tuning run keep a small JSON note: dataset name + version, provider,
base model, job id, resulting tuned model id, eval delta, and date. To roll back,
point ARES's model config back at the previous tuned id (or the base model).

This directory holds **metadata only** — never API keys or downloaded weights.
Call a tuned model by setting the relevant `ARES_*_MODEL` env var to its id; the
existing model factory/router will use it with no code change.
