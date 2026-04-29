---
id: get-started
title: Get Started
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["onboarding"]
---

# Get Started

Welcome to ts-stack. Whether you're building a wallet, running an overlay, or adding BSV payments to an app, this guide gets you from zero to your first transaction in three steps.

## Step 1: Install the SDK

The [SDK](../packages/sdk/index.md) is the foundation — it gives you private keys, signatures, and transaction building.

```bash
npm install @bsv/sdk
```

Then verify it works:

```typescript
import { PrivateKey } from '@bsv/sdk';

const key = PrivateKey.fromRandom();
console.log('Your public key:', key.publicKey.toString());
```

Continue to [Install](./install.md) for detailed setup and monorepo configuration.

## Step 2: Connect to the Network

Once you can build transactions, you need to broadcast them and read chain state. The [Network](../packages/network/index.md) packages handle this through a typed client that talks to BSV nodes.

```typescript
import { PrivateKey } from '@bsv/sdk';

const key = PrivateKey.fromRandom();

// Create a transaction, sign it, broadcast it
// (See guides for full examples)
```

## Step 3: Layer In What You Need

The real power emerges when you add packages on top. Depending on what you're building:

- **Wallet-integrated app?** Add [Wallet Toolbox](../packages/wallet/wallet-toolbox.md) to sync keys and balances with a user's wallet
- **Overlay node?** Add [Overlay](../packages/overlays/overlay.md) to index and serve data
- **Token system?** Add [BTMS](../packages/wallet/btms.md) for token transactions
- **Authenticated messaging?** Add [Authsocket](../packages/messaging/authsocket.md) for encrypted messages between identities
- **Payment-gated API?** Add [Auth Middleware](../packages/middleware/auth-express-middleware.md) and [Payment Middleware](../packages/middleware/payment-express-middleware.md)

See [Choose Your Stack](./choose-your-stack.md) for a full decision matrix.

## Next Steps

- **[Install](./install.md)** — Prerequisites and npm setup
- **[Key Concepts](./concepts.md)** — BEEF, overlays, BRC-100, identity keys
- **[Choose Your Stack](./choose-your-stack.md)** — Decision guide by use case
- **[Guides](../guides/index.md)** — Hands-on tutorials and examples
