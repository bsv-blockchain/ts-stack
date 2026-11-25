---
release:
  "@bsv/overlay": patch
---
Stores an ancestor's Merkle proof when a descendant output's stored BEEF already ends at a proven transaction that spends the ancestor or a bound descendant of it, skipping that descendant instead of throwing and leaving the ancestor's proof unstored; a BEEF that carries the ancestor is updated as before and other incomplete BEEFs still fail without writing.

## Migration

No consumer migration is required.
