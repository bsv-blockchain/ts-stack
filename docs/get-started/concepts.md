---
id: concepts
title: Key Concepts
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["concepts", "protocol"]
---

# Key Concepts

ts-stack uses several foundational concepts from the BSV protocol. Understanding them helps you choose the right packages and architecture for your app.

## The Foundation: @bsv/sdk

Everything rests on `@bsv/sdk` — a zero-dependency library containing:

- secp256k1 and secp256r1 elliptic curve operations
- Hashing utilities (SHA-256, RIPEMD-160, HMAC)
- Bitcoin Script engine (interpreter + templates)
- Transaction construction and serialization
- BEEF encoding/decoding (BRC-62)
- Merkle path computation (BRC-74)
- Key derivation (BRC-42)

Zero-dependency means no transitive supply-chain risk. The cryptographic primitives have undergone third-party security auditing.

## BEEF — Background Evaluation Extended Format (BRC-62)

BEEF is the standardized binary format for peer-to-peer transaction exchange. It bundles a transaction together with the Merkle proofs needed to prove it is mined in the chain, enabling Simplified Payment Verification (SPV) without a full node.

A BEEF package begins with the 4-byte version header **`0100BEEF`** and is ordered deliberately for streaming validation:

1. **BSV Unified Merkle Paths (BUMP / BRC-74)** — Merkle proofs linking transactions to block headers
2. **Ancestor transactions** — The minimal set of parent transactions needed to reach a mined anchor
3. **The final transaction** — The transaction being evaluated

This ordering lets a recipient begin verifying Merkle roots against a header service (such as Chaintracks) before the entire payload has arrived.

**In ts-stack:** `@bsv/sdk` has native BEEF encoding and decoding. Pass BEEF wherever you hand transactions between systems — wallets, overlays, messaging layers.

## BRC-100 — The Wallet Interface

BRC-100 is a vendor-neutral boundary that separates application business logic from wallet and key management. An app implementing BRC-100 works with any compliant wallet (BSV Desktop, BSV Browser, or a server wallet built with `@bsv/wallet-toolbox`) without modification.

### Actual method surface

The BRC-100 interface defines methods for actions, outputs, keys, encryption, and HMACs. The primary methods are:

- **`createAction()`** — Build and sign a transaction; returns a `signableTransaction` with a `.reference` handle
- **`signAction({ reference })`** — Complete signing using the `signableTransaction.reference` from `createAction`
- **`abortAction()`** — Cancel an in-progress action
- **`listActions()`** — Query transactions by **label** (transaction-level metadata)
- **`listOutputs()`** — Query outputs by **tag** (output-level metadata) and basket
- **`internalizeAction()`** — Internalize an incoming payment (BEEF) into the wallet
- **`getPublicKey()`** — Derive a public key using BRC-42
- **`encrypt()` / `decrypt()`** — Symmetric and asymmetric encryption
- **`createHmac()` / `verifyHmac()`** — HMAC operations
- **`createSignature()` / `verifySignature()`** — Raw signing and verification
- **`acquireCertificate()` / `listCertificates()` / `proveCertificate()` / `relinquishCertificate()`** — Identity certificate lifecycle

### Labels vs. tags

**Labels** are transaction-level metadata. They categorize whole Actions and are searched via `listActions`.

**Tags** are output-level metadata. They mark specific UTXOs within a basket and are searched via `listOutputs`.

Do not conflate them — they apply at different granularities.

### Batching workflows

`createAction` supports advanced chaining:

- **`noSend: true`** — Prepares a transaction for later without broadcasting. Use to assemble multiple coordinated transactions before submitting them together.
- **`sendWith: [...]`** — Couples the current transaction with a list of previously `noSend` transactions, broadcasting them atomically.

### Privileged mode

All keys are derived via BKDS (BRC-42). The interface additionally supports a secondary **Privileged Mode** keyring for highly sensitive operations (e.g., identity key signing). Privileged-mode operations require elevated permission within the wallet UX and ensure identity keys never leave the secure environment.

## The Wallet Toolbox

`@bsv/wallet-toolbox` is a modular toolkit for building BRC-100-compliant wallets. It is not a single monolithic wallet — it provides composable pieces:

- **`WalletStorageManager`** — Orchestrates multiple persistence providers (SQL/Knex, IndexedDB, or Remote) with active/backup failover and incremental synchronization
- Storage providers: `KnexWalletStorage` (SQLite/MySQL/PostgreSQL), `IndexedDBWalletStorage` (browser), `RemoteWalletStorage` (HTTPS relay)
- **`Monitor`** daemon — Polls confirmations, acquires Merkle proofs, rebroadcasts stalled transactions
- **Key managers** — `PrivilegedKeyManager`, `ShamirWalletManager` with Shamir secret sharing
- **Network services** — ARC, Chaintracks, WhatsOnChain integration

Wallet builders assemble these into a BRC-100 wallet. App developers interact only with the resulting BRC-100 interface.

## @bsv/simple — The Application Layer

`@bsv/simple` is a high-level wrapper for developers who need to move fast without deep blockchain knowledge. It abstracts script construction, key management, BEEF, and signing behind intuitive methods.

Two entry points:

- **`@bsv/simple/browser`** — Connects to browser-based wallets (BSV Browser) via the BRC-100 `WalletClient` substrate over `localhost` or `window.postMessage`. Exports: `createWallet`, `Wallet`, `Overlay`, `Certifier`, `DID`, `CredentialSchema`, `CredentialIssuer`, `MemoryRevocationStore`.
- **`@bsv/simple/server`** — Manages server-side wallets for automated agents with file-based persistence. Can be deployed as an MCP (Model Context Protocol) server. Exports: `ServerWallet`, `ServerWalletManager`, `FileRevocationStore`, handler factories, `JsonFileStore`, `IdentityRegistry`, `DIDResolverService`.

## Overlays

An overlay is a shared-context layer: servers index, store, and provide lookup for a specific subset of transactions associated with a particular topic. Multiple applications can subscribe to the same overlay topic, giving them a unified view of that on-chain data. <!-- audio: ts-stack.m4a @ 00:00 -->

**Example — a to-do topic overlay:** The topic requires transaction outputs with a specific format containing a to-do item and associated monetary value. Any application using that topic sees the same to-do list. If a user adds a to-do item in one application, it immediately appears in every other application connected to the same overlay, because they share that on-chain context. <!-- audio: ts-stack.m4a @ 00:00 -->

Inside an overlay:

- **Topic Manager** — Validates which transactions belong to a topic (admittance rules). Implements `validateTransaction` and `admitOutput`.
- **Lookup Service** — Manages the lifecycle of admitted outputs and exposes a query interface for client applications.
- **GASP (Graph-Aware Sync Protocol)** — Synchronization mechanism between overlay nodes so multiple servers stay in sync.

Discovery uses **SHIP** (Submit Host Interconnect Protocol) and **SLAP** (Service Lookup Access Protocol).

`@bsv/overlay-express` wraps the Overlay Engine as an Express server, handling database management and discovery automatically.

## Identity and Mutual Authentication

### BRC-103 / BRC-104 — Peer mutual-auth framework

BRC-103 defines the underlying mutual-authentication primitive: a `Peer` framework that operates over any transport (WebSocket, HTTP, or direct byte streams). BRC-104 is the message-layer transport option used with BRC-103.

### BRC-31 — HTTP mutual-auth handshake

BRC-31 is the HTTP variant: it specifies the `x-bsv-auth-*` request/response headers that implement the mutual-auth challenge-response over standard HTTP. BRC-31 is built on BRC-103/104.

`@bsv/auth-express-middleware` implements BRC-31 for Express servers.  
`@bsv/authsocket` implements BRC-103/104 over WebSocket.

### Identity keys

An identity key is a long-lived public key (BRC-42 derived) representing a user, service, or application. Unlike transaction keys (which rotate for privacy), identity keys are stable and reusable for authentication and message routing.

## Messaging

`@bsv/message-box-client` and the MessageBox server implement a store-and-forward substrate for encrypted peer-to-peer messages using BRC-103/104 mutual authentication.

`@bsv/authsocket` / `@bsv/authsocket-client` provide a live authenticated WebSocket channel over the same identity primitives.

## HTTP 402 Payments (BRC-121)

BRC-121 defines a stateless settlement-gated HTTP protocol. A server challenges a client with a `402 Payment Required` response; the client sends a BEEF-encoded micropayment in the next request header. No session state — the payment is self-contained in headers.

`@bsv/402-pay` implements the client side. `@bsv/payment-express-middleware` implements the server middleware.

## UHRP — Universal Hash Resolution Protocol (BRC-26)

UHRP maps file hashes to CDN URLs, enabling decentralized content-addressed storage. Files are registered by submitting a UHRP transaction to an overlay; resolvers return the URL for a given hash.

`@bsv/overlay-topics` includes the UHRP Topic Manager and Lookup Service.

## ARC and Chaintracks

**ARC (Arcade)** is the standardized interface for broadcasting transactions to miners. `@bsv/sdk` includes `ArcBroadcaster` implementing this spec.

**Chaintracks** facilitates block header management and Merkle root acquisition by listening to BSV peer-to-peer node messages. It is the header service against which BEEF Merkle proofs are validated. `@bsv/sdk` includes a Chaintracks client; the full Chaintracks Server is deployed separately.

## Conformance

The TypeScript stack is the **canonical reference implementation** for the BSV ecosystem. Conformance vectors (JSON test files in `conformance/vectors/`) are derived from this codebase and define expected behavior for every supported protocol. Implementations in Go, Python, and Rust consume the same vectors to verify cross-language compatibility.

## Next Steps

- **[Choose Your Stack](./choose-your-stack.md)** — Pick the right packages for your use case
- **[Specs](../specs/index.md)** — Machine-readable protocol contracts
- **[Guides](../guides/index.md)** — Runnable walkthroughs
