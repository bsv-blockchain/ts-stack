---
release:
  "@bsv/overlay": patch
---
Proof ingest now records a Merkle proof for a transaction a topic applied without storing any of its outputs (for example a spend accepted only for the coin it consumed), so its applied rows become proven and enter BRC-136 anchors instead of handleNewMerkleProof throwing and /arc-ingest answering 400.

## Migration

No consumer migration is required.
