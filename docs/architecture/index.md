---
id: architecture-overview
title: Architecture
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["architecture"]
---

# Architecture

The BSV TypeScript stack is organized as a foundation-to-application hierarchy. Each layer is a clean boundary that can be consumed independently.

## Layers

| Layer | Package(s) | Who uses it |
|-------|-----------|-------------|
| Foundation | `@bsv/sdk` | Protocol engineers — direct access to cryptographic primitives and script engine |
| Wallet Interface | BRC-100 boundary | All layers above communicate with wallets through this standard interface |
| Application wrapper | `@bsv/simple` | App developers — high-level payments, tokens, inscriptions, credentials |
| Wallet builder toolkit | `@bsv/wallet-toolbox` | Wallet developers — assemble BRC-100-compliant wallets from modular pieces |
| Overlay network | `@bsv/overlay`, `@bsv/overlay-express` | Service operators — index and serve on-chain data |
| Messaging | `@bsv/authsocket`, `@bsv/message-box-client` | Apps needing encrypted P2P communication |
| Monetization | `@bsv/402-pay`, `@bsv/payment-express-middleware` | APIs requiring micropayment access control |
| Identity | `@bsv/auth-express-middleware`, `@bsv/authsocket` | Apps requiring mutual authentication |

## Key Design Documents

- **[Stack Layers](./layers.md)** — Detailed layer diagram and component map
- **[BEEF (BRC-62)](./beef.md)** — Binary transaction exchange format, wire format, SPV validation
- **[BRC-100 Wallet Interface](./brc-100.md)** — Vendor-neutral wallet boundary, method surface, advanced workflows
- **[Identity & Auth](./identity.md)** — BRC-103/104, BRC-31, identity keys
- **[Conformance Pipeline](./conformance.md)** — How TS generates vectors; Go/Python/Rust runners

## Cross-Cutting Concerns

**Zero-dependency SDK** — `@bsv/sdk` has no npm dependencies. This eliminates supply-chain risk in the cryptographic foundation and makes it suitable for embedding in constrained environments.

**Audited cryptography** — The @bsv/sdk primitives and transaction validation logic have undergone third-party security auditing by Trail of Bits.

**BRC-100 as the seam** — The wallet interface is the most important architectural boundary. Applications above it are wallet-agnostic; implementations below it are application-agnostic. This is what makes the ecosystem composable.
