---
id: specs-index
title: Specifications
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["specs"]
---

# Specifications

This section documents the protocols and standards that the ts-stack implements. Each protocol solves a specific coordination problem on BSV: from wallet identity and authentication to peer payments, overlay service management, and transaction broadcast. These specs enable interoperable applications by defining precise request/response formats and protocol flows.

![Specs to packages map: each BSV protocol specification on the left is implemented by one or more ts-stack packages on the right, with curved links showing the BRC-100 to wallet-toolbox/sdk, BRC-31 to authsocket/middleware, Overlay HTTP to overlay/overlay-express, and other relationships](../assets/diagrams/specs-package-map.svg)

## Quick Reference

| Spec | Format | Version | Implementations | Purpose |
|------|--------|---------|-----------------|---------|
| [BRC-100 Wallet](./brc-100-wallet.md) | JSON Schema | 1.0.0 | @bsv/wallet-toolbox, @bsv/sdk | Standard wallet interface for signing and key management |
| [BRC-31 Auth](./brc-31-auth.md) | AsyncAPI 3.0 | 1.0.0 | @bsv/auth-express-middleware, @bsv/authsocket | Mutual authentication handshake (BRC-103 + BRC-104) |
| [BRC-29 Peer Payment](./brc-29-peer-payment.md) | AsyncAPI 3.0 | 1.0.0 | @bsv/paymail, @bsv/message-box-client | P2P payment derivation and transmission |
| [BRC-121 / 402](./brc-121-402.md) | OpenAPI 3.1 | 1.0.0 | @bsv/402-pay, @bsv/payment-express-middleware | HTTP micropayment protocol |
| [Overlay HTTP](./overlay-http.md) | OpenAPI 3.1 | 1.0.0 | @bsv/overlay, @bsv/overlay-express | Transaction routing and topic management |
| [Message Box HTTP](./message-box-http.md) | OpenAPI 3.1 | 1.0.0 | @bsv/message-box-client | Store-and-forward messaging API |
| [AuthSocket](./authsocket.md) | AsyncAPI 3.0 | 1.0.0 | @bsv/authsocket | Authenticated WebSocket for live messaging |
| [ARC Broadcast](./arc-broadcast.md) | OpenAPI 3.1 | 1.0.0 | @bsv/sdk | Miner-facing transaction broadcast |
| [Merkle Service](./merkle-service.md) | OpenAPI 3.1 | 1.0.0 | @bsv/sdk | SPV proof delivery service |
| [Storage Adapter](./storage-adapter.md) | OpenAPI 3.1 | 1.0.0 | @bsv/wallet-toolbox | Remote wallet storage interface |
| [GASP Sync](./gasp-sync.md) | AsyncAPI 3.0 | 1.0.0 | @bsv/gasp | Transaction graph synchronization |
| [UHRP](./uhrp.md) | OpenAPI 3.1 | 1.0.0 | @bsv/overlay-topics | Content-addressed file storage |

## About BRCs

**BRC** = BSV Request for Comments. BRCs are numbered sequentially (there is no categorical grouping by number range). Each BRC solves a specific interoperability problem. Implementations reference the spec by number so different teams build compatible systems without central coordination.

The authoritative BRC repository is at [github.com/bitcoin-sv/BRCs](https://github.com/bitcoin-sv/BRCs). The machine-readable contracts for BRCs implemented in ts-stack live in the [`/specs`](https://github.com/bsv-blockchain/ts-stack/tree/main/specs) directory as OpenAPI 3.1, AsyncAPI 3.0, and JSON Schema files.

## By Use Case

**I'm building a wallet**
- Start with [BRC-100 Wallet](./brc-100-wallet.md) to understand the standard interface
- Implement cryptographic signing per [BRC-100](./brc-100-wallet.md) and key derivation per [BRC-42](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0042.md)
- Reference implementation: `@bsv/wallet-toolbox`

**I'm implementing peer-to-peer payments**
- Use [BRC-29 Peer Payment](./brc-29-peer-payment.md) for payment derivation and transmission
- Combine with [BRC-31 Auth](./brc-31-auth.md) for mutual authentication
- Implementation: `@bsv/paymail`, `@bsv/message-box-client`

**I'm monetizing an API endpoint**
- Implement [BRC-121 / 402](./brc-121-402.md) using `@bsv/402-pay` or `@bsv/payment-express-middleware`
- Gateway checks payment before serving content; wallet derives and submits satoshi transaction

**I'm running an overlay service (topic manager)**
- Deploy with [Overlay HTTP](./overlay-http.md) endpoints using `@bsv/overlay-express`
- Implement topic managers per [Overlay spec](./overlay-http.md)
- Reference implementations in `@bsv/overlay-topics`

**I'm building transaction broadcasting**
- Use [ARC Broadcast](./arc-broadcast.md) for miner-facing submission
- Implement via `@bsv/sdk` `ARC` class

**I need proof of transaction inclusion**
- Use [Merkle Service](./merkle-service.md) for SPV proof delivery
- Implement via `@bsv/sdk` or external Merkle Service

## Learning Path

1. **Foundations** — Read [Key Concepts](../get-started/concepts.md) for UTXO model, scripts, and transactions
2. **Identity & Auth** — Study [BRC-31 Auth](./brc-31-auth.md) to understand mutual authentication
3. **Wallets & Signing** — Review [BRC-100 Wallet](./brc-100-wallet.md) for standard signing interface
4. **Payments** — Learn [BRC-29 Peer Payment](./brc-29-peer-payment.md) for deriving payment addresses
5. **APIs & Services** — Explore [Overlay HTTP](./overlay-http.md) and [Message Box HTTP](./message-box-http.md) for building services
6. **Infrastructure** — Deploy with [ARC Broadcast](./arc-broadcast.md) and [Merkle Service](./merkle-service.md)

## Related Documentation

- **Implementations** — See package-specific guides in `/packages/*/CLAUDE.md`
- **Error Codes** — Reference `specs/errors.md` for standardized error responses
- **Network Services** — Consult `/docs/network-services/` for Merkle Service, ARC endpoints, and provider lists
