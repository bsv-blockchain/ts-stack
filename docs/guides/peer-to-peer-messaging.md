---
id: guide-p2p-messaging
title: "Peer-to-Peer Messaging"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, messaging, encryption, brc-31]
---

# Peer-to-Peer Messaging

Send authenticated, encrypted messages between identities using BRC-31 authentication.

## What You'll Learn

- BRC-31 mutual authentication protocol
- Establishing authenticated connections
- Sending encrypted messages
- Message-box storage and retrieval
- WebSocket communication via Authsocket

## What You'll Build

A messaging application that:
1. Discovers peer identities
2. Establishes BRC-31 authenticated connections
3. Sends encrypted messages
4. Retrieves messages from storage
5. Verifies message signatures

## Prerequisites

- Node.js 18+
- Basic cryptography concepts
- Understanding of Bitcoin keys

## Stack

- @bsv/authsocket — WebSocket with BRC-31 auth
- @bsv/message-box-client — Message storage client
- @bsv/sdk — Bitcoin primitives

## Getting Started

See full guide at `/docs/guides/peer-to-peer-messaging-full/`.

## Key Concepts

### BRC-31 Authentication

Two parties prove identity by signing nonces:

```typescript
// Party A sends identity
{
  identity: publicKeyA,
  timestamp: 1234567890
}

// Party B responds with challenge
{
  identity: publicKeyB,
  nonce: randomValue
}

// Party A signs the nonce
{
  nonce_signature: sign(nonce, privateKeyA)
}
```

### Message Format

Messages include sender, receiver, and signature:

```typescript
{
  from: senderPublicKey,
  to: recipientPublicKey,
  message: encryptedContent,
  signature: messageSignature,
  timestamp: unixTime
}
```

### Authsocket Connection

WebSocket with automatic authentication:

```typescript
const socket = new AuthSocket({
  url: 'wss://peer.example.com',
  privateKey: yourPrivateKey
});

await socket.connect();
socket.send({ message: 'Hello' });
```

## Network Flow

```
Client                Message Box         Peer
  │                       │                │
  ├──(BRC-31 auth)───────→│                │
  ├──(send message)───────→│                │
  │                        │──(deliver)───→│
  │                        │                │
  └──(retrieve)───────────→│                │
  └←─(read message)────────│                │
```

## Message Storage

Messages stored in message-box-server:

```bash
curl -X POST http://messagebox:3000/messages/send \
  -H "Authorization: Bearer <token>" \
  -d '{
    "to": "recipient_key",
    "message": "encrypted content",
    "signature": "proof"
  }'
```

## Next Steps

- [Authsocket Protocol](/docs/specs/authsocket/) — WebSocket spec
- [BRC-31 Authentication](/docs/specs/brc-31-auth/) — Authentication protocol
- [Message-box Server](/docs/infrastructure/message-box-server/) — Storage backend
