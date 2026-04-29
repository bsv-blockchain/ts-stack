---
id: brc-index
title: "BRC Standards Index"
kind: reference
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [reference, brc, standards]
---

# BRC Standards Index

Quick reference for all Bitcoin Request for Comments (BRC) standards implemented in ts-stack.

## Implemented Standards

| BRC | Title | Domain | Spec Page | Key Packages | Status |
|-----|-------|--------|-----------|--------------|--------|
| BRC-29 | Peer-to-Peer Payment | Payments | [spec](/docs/specs/brc-29-peer-payment/) | @bsv/paymail, @bsv/wallet-toolbox | Stable |
| BRC-31 | Mutual Authentication | Auth | [spec](/docs/specs/brc-31-auth/) | @bsv/authsocket, @bsv/auth-express-middleware | Stable |
| BRC-42 | Key Derivation | Crypto | [SDK docs](/docs/packages/sdk/) | @bsv/sdk, @bsv/wallet-toolbox | Stable |
| BRC-74 | Merkle Path | Crypto | [SDK docs](/docs/packages/sdk/) | @bsv/sdk | Stable |
| BRC-100 | Wallet Interface | Wallet | [spec](/docs/specs/brc-100-wallet/) | @bsv/wallet-toolbox, @bsv/wab-server | Stable |
| BRC-121 | HTTP 402 Payment | Payments | [spec](/docs/specs/brc-121-402/) | @bsv/payment-express-middleware, @bsv/402-pay | Stable |

## Standard Details

### BRC-29: Peer-to-Peer Payment

Enables two parties to derive the same payment key without sharing it directly.

**Use case**: Paymail, payment address derivation

**Implementations**:
- @bsv/paymail — Paymail protocol
- @bsv/wallet-toolbox — Wallet key management

### BRC-31: Mutual Authentication

Two parties prove identity by signing each other's nonces using Bitcoin keys.

**Use case**: WebSocket connections, API authentication, peer-to-peer communication

**Implementations**:
- @bsv/authsocket — WebSocket with authentication
- @bsv/auth-express-middleware — Express API middleware

### BRC-42: Key Derivation

Deterministic key derivation using BIP-32 paths and optional protocol-specific derivation.

**Use case**: Wallet key generation, protocol-specific keys

**Implementations**:
- @bsv/sdk — Core implementation
- @bsv/wallet-toolbox — Wallet key management

### BRC-74: Merkle Path

Standard format for merkle proofs enabling Simple Payment Verification (SPV).

**Use case**: Light clients, proof verification

**Implementations**:
- @bsv/sdk — Merkle proof computation and verification

### BRC-100: Wallet Interface

Standard RPC interface for wallets, defining 29 methods for key management, transaction creation, signing, and encryption.

**Use case**: Wallet abstraction, DApp integration, wallet plugins

**Implementations**:
- @bsv/wallet-toolbox — Full wallet implementation
- @bsv/wab-server — HTTP wallet service

**Key methods**:
- `getPublicKey()` — Retrieve public key
- `createAction()` — Build transaction
- `signAction()` — Sign transaction
- `encrypt()` / `decrypt()` — Encryption operations

### BRC-121: HTTP 402 Payment

HTTP protocol for requiring and verifying payments before API access.

**Use case**: Monetization, payment-gated APIs, micropayments

**Implementations**:
- @bsv/payment-express-middleware — Express middleware
- @bsv/402-pay — Client SDK

## Reference Standards

These standards are referenced but not fully implemented in core:

| Standard | Title | Purpose | Reference |
|----------|-------|---------|-----------|
| BIP-32 | Hierarchical Deterministic Wallets | Key derivation | [BIP-32](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki) |
| BIP-39 | Mnemonic Code | Seed phrases | [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) |
| BIP-44 | Multi-Account Hierarchy | Key paths | [BIP-44](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki) |

## Finding Implementations

Search for a standard:

```bash
# Find packages implementing BRC-100
grep -r "BRC-100" docs/packages/*/

# Find conformance vectors for BRC-100
ls conformance/vectors/wallet/brc100/
```

## Conformance Testing

Each BRC is tested against conformance vectors:

| BRC | Vectors | Coverage |
|-----|---------|----------|
| BRC-29 | 20 | Complete |
| BRC-31 | 15 | Complete |
| BRC-42 | 25 | Complete |
| BRC-74 | 10 | Complete |
| BRC-100 | 50 | Complete |
| BRC-121 | 5 | Complete |

View vectors at [Conformance Vectors](/docs/conformance/vectors/).

## Next Steps

- [Specifications Index](/docs/specs/) — Full specification details
- [Conformance Testing](/docs/conformance/) — Test vectors and runners
- [Guides](/docs/guides/) — Implementation tutorials
