---
id: architecture-layers
title: Stack Layers
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["architecture", "layers"]
---

# Stack Layers

The stack is organized in three primary layers with supporting components that connect horizontally.

```
┌─────────────────────────────────────────────────────────────────┐
│                   APPLICATION LAYER                              │
│        @bsv/simple/browser    @bsv/simple/server                │
│    (connects to browser wallet)  (self-custodial agent)         │
└────────────────────────┬────────────────────────────────────────┘
                         │ BRC-100 interface
┌────────────────────────▼────────────────────────────────────────┐
│              WALLET BUILDER TOOLKIT                              │
│                  @bsv/wallet-toolbox                             │
│   WalletStorageManager + persistence providers + Monitor        │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                   FOUNDATION: @bsv/sdk                           │
│   secp256k1/r1 · hashing · Script engine · transactions         │
│   BEEF (BRC-62) · BUMP (BRC-74) · BRC-42 key derivation         │
│   ARC broadcaster · Chaintracks client                          │
└─────────────────────────────────────────────────────────────────┘

Adjacent capabilities (use the BRC-100 interface or @bsv/sdk directly):

  DATA OVERLAYS                          P2P MESSAGING & PAYMENTS
  @bsv/overlay                           @bsv/message-box-client
  @bsv/overlay-express                   @bsv/authsocket
  @bsv/overlay-topics                    @bsv/paymail
  Topic Manager / Lookup Service         BRC-29 payment derivation
  SHIP/SLAP discovery                    BRC-103/104 mutual auth

  IDENTITY                               MONETIZATION
  @bsv/auth-express-middleware           @bsv/402-pay
  BRC-31 HTTP handshake                  @bsv/payment-express-middleware
  BRC-103/104 Peer framework             BRC-121 HTTP 402

  TOKENS                                 STORAGE
  @bsv/btms                              @bsv/overlay-topics (UHRP)
  @bsv/btms-permission-module            Universal Hash Resolution (BRC-26)
  BRC-48 PushDrop protocol
```

## Foundation: @bsv/sdk

`@bsv/sdk` is the only zero-dependency package in the stack. It provides every primitive the other layers build on:

- **Cryptography** — secp256k1 and secp256r1 ECDSA, Schnorr, ECDH; SHA-256/512, RIPEMD-160, HMAC
- **Script engine** — Full Bitcoin Script interpreter and template system
- **Transactions** — Transaction builder, serialization, fee model, UTXO handling
- **BEEF** — `Beef` class: BRC-62 encoding/decoding, streaming validation ordering
- **Merkle paths** — `MerklePath` class: BRC-74 BUMP format, compound path support
- **Key derivation** — BRC-42 BKDS, BRC-43 security levels
- **Network** — `ArcBroadcaster` for transaction submission; `ChaintracksClient` for block headers
- **BRC-100 types** — Interface definitions consumed by wallet-toolbox and wallet clients

No dependencies means no `node_modules` vulnerabilities in the cryptographic core.

## BRC-100 Boundary

The BRC-100 wallet interface is the single most important seam in the stack. It separates:

- **Above** — Application business logic. Uses `createAction`, `signAction`, `listOutputs`, `listActions`, `internalizeAction`, and cryptographic primitives. Does not manage keys or storage.
- **Below** — Wallet/key management. Implements storage, signing, key derivation, UTXO selection, Merkle proof acquisition. Does not know what the application is building.

Any BRC-100-compliant wallet can be swapped below this boundary without changing application code.

## Wallet Builder Toolkit: @bsv/wallet-toolbox

`@bsv/wallet-toolbox` is not a single monolithic wallet. It is a set of composable modules:

| Module | Role |
|--------|------|
| `WalletStorageManager` | Orchestrates persistence providers (active + backup + incremental sync) |
| `KnexWalletStorage` | SQL persistence (SQLite, MySQL, PostgreSQL) |
| `IndexedDBWalletStorage` | Browser persistence |
| `RemoteWalletStorage` | Remote storage over HTTPS (for relay setups) |
| `Monitor` | Background daemon: confirms transactions, acquires Merkle proofs, rebroadcasts stalled txs |
| `PrivilegedKeyManager` | Handles the privileged-mode keyring for identity operations |
| `ShamirWalletManager` | Shamir secret sharing for key backup |
| `WalletSigner` | Bridges BRC-100 `signAction` to `@bsv/sdk` signing internals |
| `Services` | Container wiring ARC, Chaintracks, WhatsOnChain |

Wallet builders compose these into a BRC-100 `Wallet`. The resulting object is the same interface that `@bsv/simple` and other app-layer packages use.

## Application Layer: @bsv/simple

`@bsv/simple` is the recommended entry point for most application developers. The primary interface for BSV application development is **`WalletClient`** — the object returned by `@bsv/simple/browser`. Application developers instantiate `WalletClient` in their own code; within a browser app it connects to the user's wallet over `localhost` or `window.postMessage`, discovers whichever BRC-100 wallet is available, and exposes the full wallet interface (`createAction`, `listOutputs`, etc.) without the app ever holding private keys. <!-- audio: ts-stack.m4a @ 00:00 -->

`@bsv/wallet-toolbox` is for developers building wallets, not applications. If you have a strong opinion about wallet UX or are building a competing wallet implementation, `wallet-toolbox` is where you start. <!-- audio: ts-stack.m4a @ 00:00 -->

Two entry points in `@bsv/simple`:

**`@bsv/simple/browser`** — `WalletClient` substrate. Communicates with the user's BSV Browser wallet via BRC-100 over `localhost` or `window.postMessage`. The app never holds private keys. Methods: `createWallet`, `Wallet`, `Overlay`, `Certifier`, `DID`, `CredentialSchema`, `CredentialIssuer`, `MemoryRevocationStore`.

**`@bsv/simple/server`** — Manages a self-custodial server wallet backed by file persistence. Suitable for automated agents, backend services, and MCP servers. Methods: `ServerWallet`, `ServerWalletManager`, `FileRevocationStore`, handler factories for identity registry, DID resolver, credentials.

## Direct service access

Application code can also communicate with overlays, message box servers, and UHRP storage servers **independently of the wallet**. The wallet is only required for operations that need private keys. Private keys stay on the user's device at all times; the wallet interface is the architectural boundary separating key material from application code. <!-- audio: ts-stack.m4a @ 34:30 -->

## Related

- [Key Concepts](../get-started/concepts.md) — Terminology and protocol concepts
- [BEEF (BRC-62)](./beef.md) — Transaction format details
- [BRC-100 Interface](./brc-100.md) — Full method surface, labels/tags, batching
- [Conformance Pipeline](./conformance.md) — How the TS stack drives cross-language compatibility
