---
release:
  "@bsv/overlay-express": patch
---
/arc-ingest answers 503 instead of 202 to a MINED or IMMUTABLE callback that carries no Merkle path, so Arcade retries it with the stored path instead of treating the callback as delivered and leaving the transaction unproven.

## Migration

No consumer migration is required.
