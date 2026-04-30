---
id: home
title: ts-stack
kind: meta
version: "n/a"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 7
status: stable
tags: []
---

<HomeHero />

# ts-stack

This repository is the TypeScript reference stack for BSV application development. It contains:

- **Packages**: `@bsv/sdk`, wallet tooling, overlays, messaging, middleware, and helper APIs.
- **Infrastructure specs**: deployable services such as Wallet Infra, Message Box, overlays, UHRP, WAB, and Chaintracks.
- **Protocol references**: human-readable pages backed by JSON Schema, OpenAPI, and AsyncAPI artifacts in `specs/`.
- **Conformance assets**: vectors in `conformance/vectors/` that other implementations can run to prove compatibility.

![BRC-100 desktop and mobile request flows](./assets/diagrams/brc100-wallet-flows.svg)

## Start Here

| You are | Use first | Why |
|---------|-----------|-----|
| Web application developer | [`@bsv/simple/browser`](./get-started/index.md) | Connects to a local BRC-100 wallet without putting keys in app code. |
| Developer coming from another chain | [`@bsv/wallet-helper`](./packages/helpers/wallet-helper.md) | Builds explicit transactions with a fluent builder while the wallet keeps keys and signing. |
| Backend or automation developer | [`@bsv/simple/server`](./get-started/choose-your-stack.md#server-agent-automated-self-custodial) | Runs a self-custodial server wallet from a private key and storage endpoint. |
| Wallet developer | [`@bsv/wallet-toolbox`](./packages/wallet/wallet-toolbox.md) | Reference components for building a BRC-100 wallet. |
| Protocol engineer | [`@bsv/sdk`](./packages/sdk/bsv-sdk.md) | Core crypto, scripts, transactions, BEEF, BUMP, and wallet interface types. |
| Technical evaluator | [Architecture](./architecture/index.md) and [Conformance](./conformance/index.md) | Shows boundaries, current coverage, and what other implementations must match. |

## Minimal App Example

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log(result.txid)
```

For raw BRC-100 work, use `WalletClient` from `@bsv/sdk` and call methods such as [`createAction`](./specs/brc-100-wallet.md#createaction), [`signAction`](./specs/brc-100-wallet.md#signaction), and [`listOutputs`](./specs/brc-100-wallet.md#listoutputs) directly.

## Package Domains

| Domain | Packages | What they cover |
|--------|----------|-----------------|
| SDK | `@bsv/sdk` | Crypto, scripts, transactions, BEEF/BUMP, BRC-100 types, wallet substrates. |
| Wallet | `@bsv/wallet-toolbox`, BTMS, permission module, wallet relay | Wallet implementation, storage, signing, permissions, token flows, mobile pairing. |
| Overlays | `@bsv/overlay`, `@bsv/overlay-express`, topics, discovery, GASP | Shared on-chain context, topic validation, lookup services, sync. |
| Messaging | Message Box, Authsocket, Paymail | Store-and-forward messages, live authenticated channels, identity-based addressing. |
| Middleware | Auth, HTTP 402, payment express | Express middleware for identity and payment-gated APIs. |
| Helpers | `@bsv/simple`, `@bsv/wallet-helper`, templates, DID, amount utilities | Higher-level developer ergonomics, including wallet-aware app helpers and fluent transaction building. |

## Important References

- [BRC-100 Wallet Interface](./specs/brc-100-wallet.md) - linkable method reference with request and response shapes.
- [Choose Your Stack](./get-started/choose-your-stack.md) - which package to start with for each use case.
- [Stack Layers](./architecture/layers.md) - how packages and infrastructure fit together.
- [Infrastructure](./infrastructure/index.md) - service status and deployed endpoint names.
- [Vector Catalog](./conformance/vectors.md) - current conformance coverage and file paths.

## Source Discipline

Examples in this docs tree should be backed by one of:

- `packages/*/*/docs/` package documentation.
- `packages/sdk/src/wallet/Wallet.interfaces.ts` and `specs/sdk/brc-100-wallet.json`.
- `packages/wallet/wallet-toolbox-examples/src/` for wallet action flows.
- `conformance/META.json` and `conformance/vectors/` for compatibility claims.
- `bsva-infra-flux` deployment manifests for public infrastructure endpoint names.
