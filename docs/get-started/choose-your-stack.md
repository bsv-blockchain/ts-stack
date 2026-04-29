---
id: choose-your-stack
title: Choose Your Stack
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["decision-guide"]
---

# Choose Your Stack

Start from what you're building and pick the right entry point.

## Primary question: who manages keys?

```
Are you building a wallet (you manage keys)?
  YES → @bsv/wallet-toolbox
  NO  → Is this a browser app or server agent?
          BROWSER → @bsv/simple/browser
          SERVER  → @bsv/simple/server
          PROTOCOL LEVEL → @bsv/sdk
```

---

## App Developer — browser or server agent

The fastest entry point for most developers.

### Browser app (connects to user's wallet)

```bash
npm install @bsv/simple
```

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
const result = await wallet.pay({ to: recipientIdentityKey, satoshis: 1000 })
console.log('Paid:', result.txid)
```

`@bsv/simple/browser` connects to the user's BSV Browser wallet over `localhost` or `window.postMessage` via the BRC-100 interface. Your app never touches private keys.

**Resources:**
- [@bsv/simple](../packages/helpers/simple.md)

### Server agent (automated, self-custodial)

```bash
npm install @bsv/simple
```

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({ storageDir: './wallet-data' })
```

`@bsv/simple/server` manages a server-side wallet with file-based persistence. Suitable for automated agents, bots, and backend funding operations. Can be deployed as an MCP server.

**Resources:**
- [@bsv/simple](../packages/helpers/simple.md)

---

## Wallet Builder

You're building a BRC-100-compliant wallet — handling key storage, signing flows, and UTXO management yourself.

```bash
npm install @bsv/wallet-toolbox
```

`@bsv/wallet-toolbox` is the modular toolkit. Use `WalletStorageManager` to assemble a wallet from persistence providers (SQL/Knex, IndexedDB, Remote) and network services (ARC, Chaintracks). The `Wallet` class it produces is BRC-100-compliant and can be used anywhere a BRC-100 interface is expected.

**Resources:**
- [@bsv/wallet-toolbox](../packages/wallet/wallet-toolbox.md)
- [Guide: Build a Wallet-Aware App](../guides/wallet-aware-app.md)

---

## Protocol Engineer

You need direct access to cryptographic primitives, transaction construction, or BEEF encoding.

```bash
npm install @bsv/sdk
```

Zero-dependency. Includes: secp256k1/r1, hashing, Script engine, transaction builder, BEEF (BRC-62), Merkle paths (BRC-74), BRC-42 key derivation, ARC broadcaster, Chaintracks client.

**Resources:**
- [@bsv/sdk](../packages/sdk/bsv-sdk.md)

---

## By Capability

### Running an Overlay Node

```bash
npm install @bsv/overlay @bsv/overlay-express
```

Index on-chain data and serve it to applications via the Overlay HTTP spec. Implement Topic Managers and Lookup Services; `@bsv/overlay-express` wraps the Engine as an Express server.

**Resources:**
- [@bsv/overlay](../packages/overlays/overlay.md)
- [@bsv/overlay-express](../packages/overlays/overlay-express.md)
- [Guide: Run an Overlay Node](../guides/run-overlay-node.md)

### Token System (BTMS / PushDrop)

```bash
npm install @bsv/btms @bsv/btms-permission-module
```

Issue, transfer, and manage UTXO-based tokens (BRC-48 PushDrop protocol). `@bsv/btms-backend` is the overlay-server-side shell; core BTMS logic lives in `@bsv/overlay-topics`.

**Resources:**
- [@bsv/btms](../packages/wallet/btms.md)
- [@bsv/btms-permission-module](../packages/wallet/btms-permission-module.md)

### Authenticated Messaging

```bash
npm install @bsv/authsocket @bsv/authsocket-client
```

Live authenticated WebSocket channel using BRC-103/104 mutual authentication. For store-and-forward messaging use `@bsv/message-box-client` against a MessageBox server.

**Resources:**
- [@bsv/authsocket](../packages/messaging/authsocket.md)
- [@bsv/authsocket-client](../packages/messaging/authsocket-client.md)
- [Guide: Peer-to-Peer Messaging](../guides/peer-to-peer-messaging.md)

### Payment-Gated HTTP API (HTTP 402 / BRC-121)

```bash
npm install @bsv/auth-express-middleware @bsv/402-pay
```

Server challenges with `402 Payment Required`; client resends with BEEF micropayment in headers. Single round-trip, stateless.

**Resources:**
- [@bsv/auth-express-middleware](../packages/middleware/auth-express-middleware.md)
- [@bsv/402-pay](../packages/middleware/402-pay.md)
- [Guide: HTTP 402 Payments](../guides/http-402-payments.md)

### Paymail

```bash
npm install @bsv/paymail
```

Paymail discovery protocol — look up payment addresses by human-readable handle.

**Resources:**
- [@bsv/paymail](../packages/messaging/paymail.md)

### File Storage (UHRP)

```bash
npm install @bsv/overlay-topics
```

Run a UHRP overlay that maps file hashes to CDN URLs (BRC-26). Includes the UHRP Topic Manager and Lookup Service.

**Resources:**
- [@bsv/overlay-topics](../packages/overlays/overlay-topics.md)
- [Spec: UHRP](../specs/uhrp.md)

---

## Decision Matrix

| What you're building | Start with | Typically adds |
|----------------------|------------|----------------|
| Browser app | `@bsv/simple/browser` | `@bsv/message-box-client` |
| Server agent | `@bsv/simple/server` | `@bsv/402-pay` |
| BRC-100 wallet | `@bsv/wallet-toolbox` | `@bsv/sdk` |
| Protocol / SDK work | `@bsv/sdk` | — |
| Overlay node | `@bsv/overlay` | `@bsv/overlay-express`, `@bsv/overlay-topics` |
| Token system | `@bsv/btms` | `@bsv/overlay`, `@bsv/btms-backend` |
| Authenticated API | `@bsv/auth-express-middleware` | `@bsv/sdk` |
| Payment-gated API | `@bsv/402-pay` | `@bsv/auth-express-middleware` |
| Paymail | `@bsv/paymail` | `@bsv/sdk` |
| File storage (UHRP) | `@bsv/overlay-topics` | `@bsv/overlay`, `@bsv/overlay-express` |

## All Packages

See [Packages](../packages/index.md) for the full list.
