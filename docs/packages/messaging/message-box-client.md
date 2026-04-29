---
id: pkg-message-box-client
title: "@bsv/message-box-client"
kind: package
domain: messaging
version: "2.1.1"
source_repo: "bsv-blockchain/message-box-client"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/message-box-client"
repo: "https://github.com/bsv-blockchain/message-box-client"
status: stable
tags: [messaging, message-box, authrite]
---

# @bsv/message-box-client

Client for sending and receiving authenticated messages via MessageBox overlay hosts — encrypted message delivery with proof-of-identity.

## Install

```bash
npm install @bsv/message-box-client
```

## Quick start

```typescript
import { MessageBoxClient } from '@bsv/message-box-client';
import { WalletToolbox } from '@bsv/wallet-toolbox';

const wallet = new WalletToolbox();
const client = new MessageBoxClient({
  overlayHost: 'https://messagebox.example.com'
});

// Send a message
await client.sendMessage({
  to: 'recipient@example.com',
  subject: 'Hello',
  body: 'This is an encrypted message',
  wallet: wallet
});

// Receive messages
const messages = await client.getMessages(wallet.getIdentity());
messages.forEach(msg => {
  console.log('From:', msg.from, 'Body:', msg.body);
});
```

## What it provides

- **Message sending** — Send encrypted messages to other identities
- **Message retrieval** — Query and retrieve messages from overlay
- **Encryption** — Automatic ECIES encryption of message content
- **Authentication** — Sign messages with wallet identity
- **Host discovery** — Automatically discover message-box hosts via SHIP/SLAP
- **Batch operations** — Send multiple messages efficiently
- **Message deletion** — Remove messages from overlay
- **Folder support** — Organize messages into custom folders

## When to use

- Building messaging applications on BSV
- Sending notifications or alerts to identities
- Implementing private communication channels
- Creating user-to-user messaging systems
- Storing off-chain messages with on-chain proofs

## When not to use

- For simple text messages without encryption — use plain HTTP instead
- If you only need one-way notifications — consider webhooks
- For real-time chat — use @bsv/authsocket instead
- For bulk email-style messages — integrate a traditional email service

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/message-box-client/)

## Related packages

- @bsv/wallet-toolbox — Wallet for signing messages
- @bsv/overlay-topics — MessageBox topic manager implementation
- @bsv/authsocket-client — Real-time authenticated communication
- @bsv/paymail — Identity and payment address discovery
