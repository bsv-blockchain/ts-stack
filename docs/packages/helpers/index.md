---
id: domain-helpers
title: Helpers
kind: domain
last_updated: "2026-04-28"
---

# Helpers Domain

Utility libraries and helper tools for common BSV operations. Includes high-level wallet APIs, transaction builders, script templates, DID management, and development tools.

## Packages

| Package | Purpose |
|---------|---------|
| [@bsv/simple](/docs/packages/helpers/simple.md) | High-level wallet API for browser and server — manage payments, tokens, inscriptions, DIDs, and credentials |
| [@bsv/wallet-helper](/docs/packages/helpers/bsv-wallet-helper.md) | Fluent transaction builder with BRC-29 derivation and ordinal support |
| [@bsv/templates](/docs/packages/helpers/ts-templates.md) | Low-level script templates (OpReturn, MultiPushDrop, P2MSKH) with lock/unlock patterns |
| [@bsv/did-client](/docs/packages/helpers/did-client.md) | DID client for creating, revoking, and querying on-chain DIDs with overlay broadcast |
| [@bsv/amountinator](/docs/packages/helpers/amountinator.md) | Multi-currency converter (SATS↔BSV↔15+ fiat) with exchange rate caching |
| [@bsv/fund-wallet](/docs/packages/helpers/fund-wallet.md) | CLI faucet for funding wallets from Metanet Desktop during development and testing |
