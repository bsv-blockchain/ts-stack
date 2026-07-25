# CLAUDE.md — @bsv/message-box-client

## Purpose
Toolkit for peer-to-peer messaging and Bitcoin SV payments via store-and-forward architecture. Provides `MessageBoxClient` (message inbox management) and `PeerPayClient` (higher-level P2P payments) leveraging BRC-103 mutual authentication and BRC-29 payment derivation.

## Public API surface

### MessageBoxClient
- **Constructor**: `new MessageBoxClient(options)`
  - Options: `walletClient` (BRC-100 wallet), `host` (MessageBox server URL), `enableLogging`, `networkPreset` ('local'|'mainnet'|'testnet')
  - Auto-initializes on first use if needed

- **Methods**:
  - `init(targetHost?)` — manually initialize (optional, auto-runs)
  - `sendMessage({ recipient, messageBox, body, skipEncryption? })` — send via HTTP
  - `sendLiveMessage(...)` — send via WebSocket, fallback to HTTP
  - `listMessages({ messageBox })` — retrieve messages from inbox
  - `acknowledgeMessage({ messageIds })` — delete messages after reading
  - `listenForLiveMessages({ messageBox, onMessage })` — subscribe to push updates
  - `initializeConnection()` — establish WebSocket link
  - `joinRoom(messageBox)` / `leaveRoom(messageBox)` — room subscription
  - `resolveHostForRecipient(identityKey)` — overlay discovery for peer's MessageBox host
  - `anointHost(url)` — advertise your MessageBox host to overlay network

### PeerPayClient
- **Constructor**: `new PeerPayClient(options)`
  - Options: `walletClient`, `messageBoxHost`, `enableLogging`
  
- **Methods**:
  - `sendPayment({ recipient, amount })` — HTTP payment
  - `sendLivePayment({ recipient, amount })` — WebSocket payment
  - `listenForLivePayments({ onPayment })` — listen for incoming payments
  - `acceptPayment(payment)` — internalize into wallet
  - `rejectPayment(payment)` — send refund (minus 1000 sats)
  - `listIncomingPayments()` — list pending payments

## Real usage patterns

From README:
```ts
const { WalletClient } = require('@bsv/sdk')
const { MessageBoxClient } = require('@bsv/message-box-client')

const myWallet = new WalletClient()
const msgBoxClient = new MessageBoxClient({
  host: 'https://message-box-us-1.bsvb.tech',
  walletClient: myWallet
})

// Auto-init on first use, or manually
await msgBoxClient.init()

// Send message to John
await msgBoxClient.sendMessage({
  recipient: '022600d2ef37d123fdcac7d25d7a464ada7acd3fb65a0daf85412140ee20884311',
  messageBox: 'demo_inbox',
  body: 'Hello John!'
})

// List John's messages
const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
console.log(messages[0].body)

// Acknowledge (delete)
await msgBoxClient.acknowledgeMessage({
  messageIds: messages.map(msg => msg.messageId.toString())
})

// Listen for live messages
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => console.log('Live:', msg.body)
})
```

PeerPayClient:
```ts
import { WalletClient } from '@bsv/sdk'
import { PeerPayClient } from '@bsv/message-box-client'

const wallet = new WalletClient()
const peerPay = new PeerPayClient({ walletClient: wallet })

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

From tests:
```ts
const mockWalletClient = new WalletClient()
mockWalletClient.getPublicKey.mockResolvedValue({
  publicKey: PrivateKey.fromRandom().toPublicKey().toString()
})

const peerPayClient = new PeerPayClient({
  messageBoxHost: 'https://message-box-us-1.bsvb.tech',
  walletClient: mockWalletClient
})

const payment = { recipient: PrivateKey.fromRandom().toPublicKey().toString(), amount: 5 }
const token = await peerPayClient.createPaymentToken(payment)
expect(token).toHaveProperty('amount', 5)
```

## Key concepts

- **Store-and-forward**: Messages posted to named "inboxes" on server; recipient polls or subscribes via WebSocket
- **Ephemeral storage**: Messages deleted once acknowledged by recipient
- **Message encryption**: AES-256-GCM by default; `skipEncryption` flag disables
- **BRC-103 auth**: All requests signed with wallet identity; server verifies sender
- **Message box naming**: Arbitrary string per inbox (e.g., 'inbox', 'payment_inbox', 'notifications')
- **BRC-29 derivation**: Payment addresses derived from sender+recipient identity keys
- **Overlay network**: Can discover peers' MessageBox hosts via decentralized overlay service
- **Live vs HTTP**: WebSocket for push notifications; HTTP for polling

## Dependencies

- `@bsv/authsocket-client` ^2.0.2 — WebSocket auth
- `@bsv/sdk` ^2.0.14 — Wallet, crypto, auth
- Dev: jest, ts-jest, Oxlint, webpack, supertest

## Common pitfalls / gotchas

1. **Auto-init now default** — `init()` is optional but recommended for explicit control; first use auto-initializes
2. **Encryption on by default** — message bodies are AES-256-GCM encrypted; set `skipEncryption: true` for raw data
3. **Message ID format** — treat messageId as string; don't assume numeric
4. **Live vs HTTP tradeoff** — WebSocket faster but requires connection; HTTP more reliable for offline use
5. **Payment rejection** — rejecting a payment sends a refund minus 1000 sats; if amount < 1000, payment is just dropped
6. **Overlay discovery** — if no explicit host provided, client queries overlay network; this takes ~10s per peer
7. **Room subscription** — WebSocket requires explicit `joinRoom()` before `listenForLiveMessages()`

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): All messages signed/verified; handshake per-connection
- **BRC-29** (Payment Derivation): Payment address derivation using sender+recipient keys
- **BRC-100** (Wallet interface): Uses standard wallet methods for signing/verifying
- **MessageBox server protocol**: Custom HTTP + WebSocket endpoints for store-and-forward

## File map

```
/Users/personal/git/ts-stack/packages/messaging/message-box-client/
  src/
    index.ts              — main exports
    MessageBoxClient.ts   — store-and-forward client
    PeerPayClient.ts      — higher-level payment client
    types.ts              — interfaces (PeerMessage, SendMessageParams, etc.)
    authFetch.ts          — HTTP request signing
  tests/
    PeerPayClientUnit.test.ts
    integration/
      integrationWS.test.ts
      integrationOverlay.test.ts
```

## Integration points

- **authsocket-client** — underlying WebSocket with BRC-103 auth for live features
- **@bsv/sdk** — wallet, identity keys, crypto, AuthFetch for HTTP signing
- **MessageBox server** (infrastructure repo) — store-and-forward backend
- **Overlay network** — LARS service for peer discovery
