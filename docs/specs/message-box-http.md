---
id: spec-message-box-http
title: MessageBox Server HTTP API
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "messaging"]
---

# MessageBox Server HTTP API

> The MessageBox Server provides a store-and-forward REST API for peer-to-peer messaging. Clients send messages to named inboxes, recipients retrieve messages later, and messages are deleted once acknowledged. All requests use BRC-31 mutual authentication so the server knows sender and recipient identity without passwords.

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/message-box-client |

## What problem this solves

**Asynchronous peer-to-peer messaging without accounts or servers**. Traditional messaging requires accounts, servers, and complex infrastructure. MessageBox enables store-and-forward: sender encrypts and posts to recipient's inbox, recipient polls or listens via WebSocket, and messages are automatically deleted after reading. Identity is cryptographic (no username/password).

**Encrypted message storage**. Messages are encrypted with AES-256-GCM before storage. Only the recipient (holder of the private key) can decrypt. The server cannot read message contents.

**Peer discovery via overlay network**. Clients can discover peers' MessageBox hosts by querying the overlay network (UHRP protocol), enabling dynamic host discovery without DNS or a central directory.

## Protocol overview

**Three-step flow** (send → store → retrieve):

1. **Sender → MessageBox** `POST /messages`
   - Recipient public key in body
   - Message body (encrypted with AES-256-GCM)
   - `x-bsv-auth-*` headers (BRC-31 mutual auth)
   - Server stores message in recipient's inbox

2. **Recipient → MessageBox** `GET /messages/{messageBox}`
   - Retrieves all pending messages in their inbox
   - `x-bsv-auth-*` headers
   - Server returns array of messages

3. **Recipient → MessageBox** `POST /acknowledge`
   - Acknowledges (deletes) messages by ID
   - `x-bsv-auth-*` headers
   - Server deletes messages

**Live subscription** (alternative to polling):

- **Recipient → MessageBox** WebSocket upgrade + BRC-103 handshake
- Server pushes new messages in real-time via WebSocket
- Recipient can `joinRoom(messageBox)` / `listenForMessages()`

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/messages` | Send message | `{ recipient, messageBox, body }` | `{ messageId }` |
| GET | `/messages/{messageBox}` | List messages | (via auth headers) | `[ { messageId, body, sender, timestamp } ]` |
| POST | `/acknowledge` | Delete messages | `{ messageIds: [...] }` | OK |
| GET | `/resolve-host` | Discover peer's MessageBox host | `{ identityKey }` | `{ host }` |
| WebSocket | `/live` | Listen for live messages | BRC-103 handshake + `joinRoom` | Real-time message push |

## Example: Send encrypted message

```typescript
import { MessageBoxClient } from '@bsv/message-box-client'
import { SetupWallet } from '@bsv/wallet-toolbox'

const wallet = await SetupWallet({ env: 'main' })

const msgBox = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messagebox.babbage.systems'
})

// 1. Send message (auto-encrypted with AES-256-GCM)
await msgBox.sendMessage({
  recipient: '02abc123...',  // Recipient's public key
  messageBox: 'general_inbox',
  body: 'Hello! This is encrypted and only you can read it.'
})
```

Example: Retrieve and acknowledge messages

```typescript
// 2. Retrieve all messages in inbox
const messages = await msgBox.listMessages({ 
  messageBox: 'general_inbox' 
})

for (const msg of messages) {
  console.log(`From ${msg.sender}: ${msg.body}`)
}

// 3. Acknowledge (delete) messages
await msgBox.acknowledgeMessage({
  messageIds: messages.map(m => m.messageId)
})
```

Example: Listen for live messages

```typescript
// 4. Subscribe to real-time messages
await msgBox.listenForLiveMessages({
  messageBox: 'general_inbox',
  onMessage: (msg) => {
    console.log('Live message:', msg.body)
  }
})
```

## Conformance vectors

MessageBox conformance is tested in `conformance/vectors/messaging/message-box/`:

- AES-256-GCM encryption/decryption
- BRC-31 authentication on all endpoints
- Message storage and retrieval
- Acknowledge/delete functionality
- WebSocket live message delivery
- Host discovery via overlay network

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/message-box-client | Client library for sending/receiving messages; WebSocket support via Socket.IO; BRC-31 auth integration |
| MessageBox Server | Infrastructure repository (not in ts-stack); HTTP + WebSocket endpoints |

## Related specs

- [BRC-31 Auth](./brc-31-auth.md) — Mutual authentication for all endpoints
- [AuthSocket](./authsocket.md) — WebSocket implementation of BRC-31
- [BRC-29 Peer Payment](./brc-29-peer-payment.md) — Payment delivery via message box
- [UHRP](./uhrp.md) — Host discovery overlay protocol

## Spec artifact

[message-box-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/messaging/message-box-http.yaml)
