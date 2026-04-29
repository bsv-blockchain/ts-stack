---
id: choose-your-stack
title: Choose Your Stack
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["decision-guide"]
---

# Choose Your Stack

Based on what you're building, here are the recommended starting packages.

## By Use Case

### Building BSV Transactions from Scratch

```bash
npm install @bsv/sdk
```

You have everything you need:
- Private keys and signatures
- Transaction building and serialization
- BEEF encoding and SPV proof validation
- No wallet or overlay required

**Resources:**
- [SDK Package](../packages/sdk/index.md)
- [Guide: Transactions 101](../guides/index.md)

### Wallet-Integrated App

```bash
npm install @bsv/wallet-toolbox
```

Your app lets users sign in with their wallet and approve transactions.

**Includes:**
- BRC-100 wallet interface implementation
- Key management (if you're building a wallet)
- Balance sync and UTXO selection
- Transaction signing with wallet approval

**Resources:**
- [Wallet Toolbox](../packages/wallet/wallet-toolbox.md)
- [Guide: Build a Wallet-Aware App](../guides/wallet-aware-app.md)

### Running an Overlay Node

```bash
npm install @bsv/overlay @bsv/overlay-express
```

You want to index on-chain data and serve it to applications.

**Includes:**
- Overlay core (transaction validation, topic management)
- Express HTTP server for the Overlay spec
- Built-in topic managers for common protocols

**Resources:**
- [Overlay Package](../packages/overlays/overlay.md)
- [Overlay Express](../packages/overlays/overlay-express.md)
- [Guide: Run an Overlay Node](../guides/run-overlay-node.md)

### Building a Token System (BTMS)

```bash
npm install @bsv/btms @bsv/btms-permission-module
```

You want to issue, transfer, and manage tokens on BSV.

**Includes:**
- BTMS token protocol implementation
- Permission checking (who can transfer which tokens)
- Backend support if you're running an overlay

**Resources:**
- [BTMS](../packages/wallet/btms.md)
- [BTMS Permission Module](../packages/wallet/btms-permission-module.md)
- [Spec: BTMS Protocol](../specs/index.md)

### Authenticated Messaging Between Users

```bash
npm install @bsv/authsocket @bsv/authsocket-client
```

Users send encrypted messages to each other using identity keys.

**Includes:**
- WebSocket protocol for authenticated messaging
- Encryption with recipient's public key
- Message routing by identity key

**Resources:**
- [Authsocket](../packages/messaging/authsocket.md)
- [Authsocket Client](../packages/messaging/authsocket-client.md)
- [Guide: Peer-to-Peer Messaging](../guides/peer-to-peer-messaging.md)

### Payment-Gated HTTP API (HTTP 402)

```bash
npm install @bsv/auth-express-middleware @bsv/payment-express-middleware
```

Your API requires users to prove identity or pay before accessing endpoints.

**Includes:**
- Authentication middleware (verify identity keys)
- Payment middleware (require payment to access routes)
- BRC-121 / HTTP 402 protocol support

**Resources:**
- [Auth Middleware](../packages/middleware/auth-express-middleware.md)
- [Payment Middleware](../packages/middleware/payment-express-middleware.md)
- [Guide: HTTP 402 Payments](../guides/http-402-payments.md)

### Adding Paymail to Your App

```bash
npm install @bsv/paymail
```

Users can discover each other by Paymail handle and send payments.

**Includes:**
- Paymail discovery protocol
- Payment address lookup
- Integration with wallet and overlay

**Resources:**
- [Paymail Package](../packages/messaging/ts-paymail.md)

### Storing Files on BSV (UHRP)

```bash
npm install @bsv/overlay-topics
```

You're running an overlay and want to store and retrieve files.

**Includes:**
- UHRP topic manager (validates file inscriptions)
- File storage and retrieval protocol
- Integration with overlay core

**Resources:**
- [Overlay Topics](../packages/overlays/topics.md)
- [Spec: UHRP](../specs/uhrp.md)

## Decision Matrix

| Use Case | Start With | Likely Adds |
|----------|------------|-------------|
| Transactions | @bsv/sdk | @bsv/teranode-listener |
| Wallet app | @bsv/wallet-toolbox | @bsv/sdk, auth middleware |
| Overlay node | @bsv/overlay | @bsv/overlay-express, @bsv/overlay-topics |
| Token system | @bsv/btms | @bsv/overlay, @bsv/btms-backend |
| Authenticated app | @bsv/authsocket | @bsv/wallet-toolbox, @bsv/sdk |
| Payment API | @bsv/payment-express-middleware | @bsv/auth-express-middleware, @bsv/sdk |
| Paymail | @bsv/paymail | @bsv/sdk, @bsv/teranode-listener |
| File storage | @bsv/overlay-topics | @bsv/overlay, @bsv/overlay-express |

## All Packages by Domain

For a complete list of all 27 packages, see [Packages](../packages/index.md).

## Domain Specialization

Each domain serves a specific purpose in the stack:

- **[SDK](../packages/sdk/index.md)** — Always the foundation
- **[Wallet](../packages/wallet/index.md)** — If you're managing keys or integrating with wallets
- **[Network](../packages/network/index.md)** — If you're broadcasting or querying the chain
- **[Overlays](../packages/overlays/index.md)** — If you're indexing data or running a service
- **[Messaging](../packages/messaging/index.md)** — If you're authenticating or routing messages
- **[Middleware](../packages/middleware/index.md)** — If you're building an Express API
- **[Helpers](../packages/helpers/index.md)** — Shared utilities and adapters

## Next Steps

1. Pick your starting package from the decision matrix
2. Read that package's documentation in [Packages](../packages/index.md)
3. Follow the relevant [Guide](../guides/index.md)
4. Refer to [Specs](../specs/index.md) for protocol details
