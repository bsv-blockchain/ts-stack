---
release:
  "@bsv/sdk": patch
---
Transaction.fee(..., 'random') draws its change-split digit uniformly. Bytes 252-255 are discarded, so each digit 1-9 is equally likely. The logarithmic share formula, fee total and output order are unchanged.

## Migration

No consumer migration is required.
