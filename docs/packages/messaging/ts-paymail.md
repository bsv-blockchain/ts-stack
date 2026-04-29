---
id: pkg-paymail
title: "@bsv/paymail"
kind: package
domain: messaging
version: "2.3.0"
source_repo: "bsv-blockchain/paymail"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/paymail"
repo: "https://github.com/bsv-blockchain/paymail"
status: stable
tags: [paymail, messaging, brc-29, identity]
---

# @bsv/paymail

Paymail protocol implementation — capability discovery, PKI, P2P payment destinations, and public profiles for BSV.

## Install

```bash
npm install @bsv/paymail
```

## Quick start

```typescript
import { PaymailClient } from '@bsv/paymail';

const client = new PaymailClient();

// Discover capabilities for a paymail address
const capabilities = await client.getCapabilities('user@example.com');
console.log('Supports:', capabilities);

// Get public key for a paymail user
const pubkey = await client.getPublicKey('user@example.com');
console.log('Public Key:', pubkey);

// Request payment destination for sending money
const dest = await client.getPaymentDestination('user@example.com', 1000);
console.log('Send to:', dest.outputs);
```

## What it provides

- **Capability discovery** — Query paymail servers for supported operations
- **PKI (Public Key Infrastructure)** — Retrieve and verify public keys
- **Payment destinations** — Get addresses for sending payments
- **Public profiles** — Retrieve user metadata and avatar
- **BRFC support** — Handle various Bitmail Request For Comments standards
- **Signature verification** — Verify paymail server responses
- **Avatar retrieval** — Get user profile pictures
- **Domain validation** — Verify paymail domain authenticity

## When to use

- Building payment applications that need paymail integration
- Discovering user capabilities (payments, messaging, profiles)
- Verifying user identities via paymail
- Implementing P2P payment flows
- Building user directories or address books
- Implementing identity-based routing

## When not to use

- For simple HTTP APIs without paymail requirement — use direct APIs
- If users don't have paymail addresses — use raw Bitcoin addresses
- For non-payment identity — use @bsv/did-client instead
- For on-chain identity — use overlay-based DID

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/paymail/)

## Related packages

- @bsv/did-client — Decentralized identifier resolution
- @bsv/message-box-client — Messaging to paymail addresses
- @bsv/wallet-toolbox — Wallet for payment operations
- @bsv/sdk — Transaction building for payments
