---
release:
  "@bsv/sdk": minor
---
Export transactionSize, transactionInputSize, transactionOutputSize and varUintSize so a fee can be estimated from script lengths before a transaction is built; SatoshisPerKilobyte sizes through the same function with identical results.

## Migration

No consumer migration is required.
