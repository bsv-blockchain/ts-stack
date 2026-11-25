---
release:
  "@bsv/amountinator": patch
---
Converts BSV and satoshis without fiat rates, preserves whole satoshis, rounds up genuine fractions, and rejects fiat quotes when the requested rate is unavailable.

## Migration

No consumer migration is required. Wallets can continue using the existing conversion methods and should display an unavailable quote when a requested fiat rate is missing.
