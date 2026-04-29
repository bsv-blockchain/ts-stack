---
id: brc-index
title: "BRC Standards Index"
kind: reference
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: [reference, brc, standards]
---

# BRC Standards Index

All Bitcoin Request for Comments (BRC) standards referenced in ts-stack source, specs, and conformance vectors.

## Core Standards in ts-stack

| BRC | Title | Domain | Spec | Key Packages |
|-----|-------|--------|------|--------------|
| BRC-29 | Peer-to-Peer Payment Protocol | Payments | [spec](../specs/brc-29-peer-payment.md) | `@bsv/paymail`, `@bsv/message-box-client` |
| BRC-31 | HTTP Mutual Authentication Handshake | Auth | [spec](../specs/brc-31-auth.md) | `@bsv/auth-express-middleware`, `@bsv/authsocket` |
| BRC-42 | Key Derivation Scheme (BKDS) | Crypto | — | `@bsv/sdk`, `@bsv/wallet-toolbox` |
| BRC-43 | Security Levels for BKDS | Crypto | — | `@bsv/sdk` |
| BRC-48 | PushDrop Token Protocol | Tokens | — | `@bsv/overlay-topics`, `@bsv/btms` |
| BRC-62 | BEEF — Background Evaluation Extended Format | Transactions | — | `@bsv/sdk` |
| BRC-74 | BUMP — BSV Unified Merkle Path | Transactions | — | `@bsv/sdk` |
| BRC-95 | BEEF V2 | Transactions | — | `@bsv/sdk` |
| BRC-100 | BRC-100 Wallet Interface | Wallet | [spec](../specs/brc-100-wallet.md) | `@bsv/wallet-toolbox`, `@bsv/sdk` |
| BRC-101 | Wallet storage adapter | Wallet | [spec](../specs/storage-adapter.md) | `@bsv/wallet-toolbox` |
| BRC-103 | Peer Mutual Authentication Framework | Auth | — | `@bsv/authsocket`, `@bsv/auth-express-middleware` |
| BRC-104 | Message-Layer Transport | Auth | — | `@bsv/authsocket` |
| BRC-121 | HTTP 402 Payment Protocol | Payments | [spec](../specs/brc-121-402.md) | `@bsv/402-pay`, `@bsv/payment-express-middleware` |

## Additional Referenced Standards

These BRCs appear in the codebase, specs, or conformance vectors:

| BRC | Title / Purpose |
|-----|----------------|
| BRC-1 | Transaction format |
| BRC-2 | Script encoding |
| BRC-3 | Address format |
| BRC-10 | Script templates |
| BRC-18 | Message signing (BSM) |
| BRC-22 | Output description |
| BRC-24 | Derivation path metadata |
| BRC-26 | UHRP — Universal Hash Resolution Protocol |
| BRC-30 | Output script hash |
| BRC-45 | Merkle service HTTP |
| BRC-52 | Script hash encoding |
| BRC-56 | Wallet authentication protocol |
| BRC-69 | Key derivation for encryption |
| BRC-73 | HD key encoding |
| BRC-76 | Wallet relay transport |
| BRC-77 | Bitcoin Signed Message (BSM) compat |
| BRC-78 | Transaction output locking |
| BRC-87 | Overlay host discovery |
| BRC-96 | Overlay sync |
| BRC-98 | Token permission hooks |
| BRC-99 | Token permission module |
| BRC-111 | Auth certificate |
| BRC-112 | Certificate field disclosure |
| BRC-114 | Credential schema |
| BRC-115 | Wallet storage |

## Standard Details

### BRC-29: Peer-to-Peer Payment Protocol

Defines the minimum data required for passing a transaction from one person to another: a transaction derivation prefix, suffix, and sender public key. Transport-agnostic — works over Bluetooth, HTTP, WebSocket, or animated QR codes. The 402 Pay library (BRC-121) uses BRC-29 as its payment data structure. <!-- audio: ts-stack.m4a @ 22:30 -->

Implementations: `@bsv/paymail`, `@bsv/message-box-client`, `@bsv/402-pay`

Conformance vectors: `conformance/vectors/wallet/brc29/`

### BRC-31: HTTP Mutual Authentication Handshake

Specifies the `x-bsv-auth-*` HTTP headers that implement mutual-auth challenge-response over standard HTTP. Built on the BRC-103 Peer framework.

Implementations: `@bsv/auth-express-middleware`, `@bsv/authsocket`

Spec: `specs/auth/brc31-handshake.yaml`

### BRC-42: Key Derivation Scheme (BKDS)

Deterministic key derivation for BSV wallets. All BRC-100 wallet keys are derived via BRC-42.

Implementations: `@bsv/sdk` (core), `@bsv/wallet-toolbox` (wallet context)

Conformance vectors: `conformance/vectors/sdk/keys/key-derivation.json`

### BRC-48: PushDrop Token Protocol

Encodes token data in a Bitcoin output using OP_DROP followed by OP_CHECKSIG. Used by BTMS and overlay topics.

Implementations: `@bsv/overlay-topics`, `@bsv/btms`, `@bsv/btms-backend`

### BRC-62: BEEF — Background Evaluation Extended Format

Binary format for peer-to-peer transaction exchange. Begins with `0100BEEF`. Ordered: Merkle paths → ancestor transactions → final transaction, enabling streaming SPV validation.

Implementations: `@bsv/sdk` (`Beef` class)

### BRC-74: BUMP — BSV Unified Merkle Path

Optimized Merkle proof format using block height as a lookup target. Supports compounding multiple paths into one structure.

Implementations: `@bsv/sdk` (`MerklePath` class)

Conformance vectors: `conformance/vectors/sdk/transactions/merklepath.json`

### BRC-100: Wallet Interface

Standard RPC interface separating application logic from wallet/key management. Defines `createAction`, `signAction`, `listActions`, `listOutputs`, `internalizeAction`, `getPublicKey`, `encrypt`, `decrypt`, `createHmac`, `verifyHmac`, `createSignature`, `verifySignature`, certificate methods, and more.

Implementations: `@bsv/wallet-toolbox` (full implementation), `@bsv/sdk` (substrate types)

Spec: `specs/sdk/brc-100-wallet.json`

Conformance vectors: `conformance/vectors/wallet/brc100/`

### BRC-103: Peer Mutual Authentication Framework

Underlying mutual-auth primitive. Defines a `Peer` abstraction that operates over WebSocket, HTTP, or direct byte streams.

Implementations: `@bsv/authsocket`, `@bsv/auth-express-middleware`, `@bsv/message-box-client`

### BRC-104: Message-Layer Transport

Transport option for BRC-103 Peer sessions.

### BRC-121: HTTP 402 Payment Protocol

Stateless settlement-gated HTTP. Server responds `402 Payment Required`; client resends with a BEEF-encoded micropayment in headers. Single round-trip. Uses BRC-29 as its payment data structure. "Simple payments without any authentication other than HTTPS itself" — distinct from AuthExpress/PaymentExpress which require a mutual-auth handshake. <!-- audio: ts-stack.m4a @ 11:30 -->

Implementations: `@bsv/402-pay` (client), `@bsv/payment-express-middleware` (server)

Spec: `specs/payments/brc121.yaml`

## Finding Implementations

```bash
# Packages implementing BRC-100
grep -r "BRC-100" docs/packages/

# Conformance vectors for BRC-42
ls conformance/vectors/sdk/keys/
```

## Conformance Testing

Each core BRC is validated against JSON test vectors in `conformance/vectors/`. The TypeScript implementation generates these vectors; Go, Python, and Rust implementations validate against them.

| BRC | Vector path |
|-----|-------------|
| BRC-42 | `conformance/vectors/sdk/keys/` |
| BRC-74 | `conformance/vectors/sdk/transactions/` |
| BRC-29 | `conformance/vectors/wallet/brc29/` |
| BRC-31 | `conformance/vectors/messaging/brc31/` |
| BRC-100 | `conformance/vectors/wallet/brc100/` |

See [Conformance Testing](../conformance/index.md) for how to run the test suite.
