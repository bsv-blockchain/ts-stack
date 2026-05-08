---
id: reference-overview
title: "Reference"
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: [reference, api, index]
---

# Reference

Quick reference material for API details and protocol indices.

## Contents

- **[BRC Standards Index](./brc-index.md)** — All BRC standards with links to implementations
- **TypeDoc API docs** — Per-package generated reference (see links below)

## Packages by Domain

All 27 packages in the monorepo, with published npm names.

### SDK

| Package | npm | Purpose |
|---------|-----|---------|
| SDK | `@bsv/sdk` | Zero-dependency crypto primitives, script engine, BEEF, BRC-100 wallet interface |

### Wallet

| Package | npm | Purpose |
|---------|-----|---------|
| wallet-toolbox | `@bsv/wallet-toolbox` | Modular toolkit for building BRC-100-compliant wallets |
| btms | `@bsv/btms` | UTXO-based token client (BTMS) |
| btms-permission-module | `@bsv/btms-permission-module` | Permission hooks for BTMS token operations |
| ts-wallet-relay | `@bsv/wallet-relay` | ECDH-encrypted WebSocket tunnel between desktop and mobile wallets |
| wallet-toolbox-examples | `@bsv/wallet-toolbox-examples` | Reference wallet implementations using wallet-toolbox |

### Overlays

| Package | npm | Purpose |
|---------|-----|---------|
| overlay | `@bsv/overlay` | Overlay Engine: Topic Manager and Lookup Service framework |
| overlay-express | `@bsv/overlay-express` | Express server wrapping the Overlay Engine |
| overlay-topics | `@bsv/overlay-topics` | Built-in Topic Managers and Lookup Services (UHRP, BTMS) |
| overlay-discovery-services | `@bsv/overlay-discovery-services` | SHIP/SLAP discovery for overlay networks |
| gasp-core | `@bsv/gasp` | Graph-Aware Sync Protocol for inter-node synchronization |
| btms-backend | `@bsv/btms-backend` | Overlay-server-side shell for BTMS; core logic now in `@bsv/overlay-topics` |

### Messaging

| Package | npm | Purpose |
|---------|-----|---------|
| message-box-client | `@bsv/message-box-client` | Client for the MessageBox store-and-forward server |
| authsocket | `@bsv/authsocket` | BRC-103/104 authenticated WebSocket server |
| authsocket-client | `@bsv/authsocket-client` | Client for authsocket servers |
| ts-paymail | `@bsv/paymail` | Paymail protocol (discovery + address lookup) |

### Middleware

| Package | npm | Purpose |
|---------|-----|---------|
| auth-express-middleware | `@bsv/auth-express-middleware` | BRC-31 mutual-auth middleware for Express |
| payment-express-middleware | `@bsv/payment-express-middleware` | BRC-121 payment-gated middleware for Express |
| 402-pay | `@bsv/402-pay` | BRC-121 HTTP 402 client |

### Helpers

| Package | npm | Purpose |
|---------|-----|---------|
| simple | `@bsv/simple` | High-level wrapper for app developers (`./browser` and `./server` entry points) |
| did | `@bsv/did` | SD-JWT VC and optional `did:key` helpers |
| did-client | `@bsv/did-client` | DID creation and resolution client |
| wallet-helper | `@bsv/wallet-helper` | Fluent transaction builder |
| amountinator | `@bsv/amountinator` | BSV amount formatting and conversion |
| fund-wallet | `@bsv/fund-wallet` | CLI tool for funding wallets on testnet |
| ts-templates | `@bsv/templates` | Low-level script templates |

### Network

| Package | npm | Purpose |
|---------|-----|---------|
| ts-p2p | `@bsv/teranode-listener` | BSV peer-to-peer node listener |

## Quick Navigation

- [Specifications](../specs/) — Protocol details and machine-readable contracts
- [Guides](../guides/) — Step-by-step tutorials
- [Infrastructure](../infrastructure/) — Deployment guides
- [Conformance](../conformance/) — Test vectors and cross-language validation
