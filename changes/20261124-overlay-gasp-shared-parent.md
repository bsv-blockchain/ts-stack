---
release:
  "@bsv/overlay": patch
---
GASP replays each transaction once when a graph contains several of its outputs. Validation and finalisation process each funding transaction before its spenders.

## Migration

No consumer migration is required.
