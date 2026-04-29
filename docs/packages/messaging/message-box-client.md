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

> Toolkit for peer-to-peer messaging and Bitcoin SV payments via store-and-forward architecture. Provides `MessageBoxClient` (message inbox management) and `PeerPayClient` (higher-level P2P payments) leveraging BRC-103 mutual authentication and BRC-29 payment derivation.

## Install

```bash
npm install @bsv/message-box-client
```

## Quick start

```typescript
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

const myWallet = new WalletClient()
const msgBoxClient = new MessageBoxClient({
  host: 'https://message-box-us-1.bsvb.tech',
  walletClient: myWallet
})

await msgBoxClient.init()

// Send message to John
await msgBoxClient.sendMessage({
  recipient: '022600d2ef37d123fdcac7d25d7a464ada7acd3fb65a0daf85412140ee20884311',
  messageBox: 'demo_inbox',
  body: 'Hello John!'
})

// List messages
const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
console.log(messages[0].body)

// Acknowledge (delete)
await msgBoxClient.acknowledgeMessage({
  messageIds: messages.map(msg => msg.messageId.toString())
})
```

## What it provides

- **MessageBoxClient** — Store-and-forward message client with HTTP and WebSocket support
- **PeerPayClient** — Higher-level P2P payment client with live and HTTP modes
- **BRC-103 authentication** — All requests signed with wallet identity; server verifies sender
- **Message encryption** — AES-256-GCM by default; `skipEncryption` flag disables
- **Ephemeral storage** — Messages deleted once acknowledged by recipient
- **Live WebSocket** — Push notifications via WebSocket; HTTP for polling
- **BRC-29 derivation** — Payment addresses derived from sender+recipient identity keys
- **Overlay discovery** — Discover peers' MessageBox hosts via decentralized overlay service

## Common patterns

### Listening for live messages

```typescript
const msgBoxClient = new MessageBoxClient({
  host: 'https://message-box-us-1.bsvb.tech',
  walletClient: myWallet
})

await msgBoxClient.initializeConnection()
await msgBoxClient.joinRoom('demo_inbox')

await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => console.log('Live:', msg.body)
})
```

### Peer-to-peer payments

```typescript
import { PeerPayClient } from '@bsv/message-box-client'

const peerPay = new PeerPayClient({ walletClient: myWallet })

// Listen for incoming payments
await peerPay.listenForLivePayments({
  onPayment: async (payment) => {
    console.log('Received payment:', payment)
    await peerPay.acceptPayment(payment)
  }
})

// Send 50,000 sats
await peerPay.sendLivePayment({
  recipient: '0277a2b...e3f4',
  amount: 50000
})
```

## Key concepts

- **Store-and-forward** — Messages posted to named "inboxes" on server; recipient polls or subscribes via WebSocket
- **Ephemeral storage** — Messages deleted once acknowledged by recipient
- **Message encryption** — AES-256-GCM by default; `skipEncryption` flag disables
- **BRC-103 auth** — All requests signed with wallet identity; server verifies sender
- **BRC-29 derivation** — Payment addresses derived from sender+recipient identity keys
- **Overlay network** — Can discover peers' MessageBox hosts via decentralized overlay service
- **Live vs HTTP** — WebSocket for push notifications; HTTP for polling

## When to use this

- Building peer-to-peer messaging applications on BSV
- Sending notifications or alerts to Bitcoin identities
- Implementing private communication channels with identity verification
- Creating user-to-user messaging systems with signatures
- Building P2P payment applications with store-and-forward messaging

## When NOT to use this

- Simple text messages without encryption — use plain HTTP instead
- Only one-way notifications without delivery confirmation — consider webhooks
- Real-time chat requiring sub-second latency — use `@bsv/authsocket-client` instead
- Bulk email-style messages — integrate traditional email service instead

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): All messages signed/verified
- **BRC-29** (Payment Derivation): Payment address derivation using sender+recipient keys
- **BRC-100** (Wallet interface): Uses standard wallet methods for signing/verifying
- **MessageBox server protocol**: Custom HTTP + WebSocket endpoints for store-and-forward

## Common pitfalls

1. **Auto-init default** — `init()` is optional but recommended; first use auto-initializes if not called
2. **Encryption enabled by default** — message bodies are AES-256-GCM encrypted; set `skipEncryption: true` for raw data
3. **Live requires room subscription** — WebSocket requires explicit `joinRoom()` before `listenForLiveMessages()`
4. **Payment rejection reduces amount** — rejecting a payment sends a refund minus 1000 sats
5. **Overlay discovery takes time** — if no explicit host provided, client queries overlay; this takes ~10s per peer

## Related packages

- **@bsv/authsocket-client** — Real-time authenticated WebSocket communication
- **@bsv/auth-express-middleware** — HTTP authentication for REST endpoints
- **@bsv/paymail** — Paymail protocol for identity and payment address discovery

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/message-box-client/)
- [Source on GitHub](https://github.com/bsv-blockchain/message-box-client)
- [npm](https://www.npmjs.com/package/@bsv/message-box-client)
