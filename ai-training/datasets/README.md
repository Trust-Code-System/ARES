# Datasets

Versioned fine-tuning datasets. One JSON file per dataset version, named
`<name>.v<major>.json`. Schema: see [`docs/DATASET_FORMAT.md`](../../docs/DATASET_FORMAT.md).

**Never put secrets, real emails, passwords, or private user data here.** Run the
sanitizer before exporting — it redacts credentials/PII, and the validator fails
on any hard credential. Don't train on private user data without explicit consent.

Pipeline (see `npm run train:*`):

```
validate  →  sanitize  →  split (train/val/test)  →  export (openai|jsonl|csv)
```

Splits are deterministic by content hash, so the same example always lands in the
same partition — that keeps before/after eval comparisons honest. Bump the version
(and keep the old file) to roll back a bad dataset.
