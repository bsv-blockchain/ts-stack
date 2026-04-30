---
id: guide-p2p-messaging
title: "Peer-to-Peer Messaging"
kind: guide
version: "1.0.0"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: [guide, messaging, encryption, brc-103]
---

# Peer-to-Peer Messaging

> Send authenticated, encrypted messages between peers using BRC-103 mutual authentication. Choose between store-and-forward HTTP (MessageBox) or real-time WebSocket (Authsocket) transport.

**Time:** ~25 minutes
**Prerequisites:** Node.js ≥ 20, basic TypeScript, understanding of public-key cryptography

## What you'll build

A complete messaging application that:
- Discovers peer identities via overlay network
- Sends encrypted messages over HTTP (store-and-forward)
- Listens for live messages via WebSocket
- Verifies sender identity using BRC-103 authentication
- Retrieves message history from the message box

By the end, you'll understand both HTTP and WebSocket messaging patterns.

## Prerequisites

- Node.js 20+ installed
- npm or pnpm
- A BRC-100 wallet (or WalletClient from @bsv/sdk)
- Public key of a peer you want to message
- Access to a MessageBox server (e.g., `https://message-box-us-1.bsvb.tech` for testnet)

## Step 1 — Install messaging packages

Initialize a project with messaging dependencies:

```bash
mkdir my-p2p-app && cd my-p2p-app
npm init -y
npm install @bsv/message-box-client @bsv/authsocket-client @bsv/sdk dotenv
npm install -D typescript ts-node @types/node
```

## Step 2 — Set up a wallet for identity

Create `wallet.ts` to initialize a wallet that will sign messages:

```typescript
import { WalletClient } from '@bsv/sdk'

export async function getWallet() {
  // Use the SDK's built-in WalletClient
  // In production, this would connect to a real wallet (BSV Desktop, Browser, etc.)
  const wallet = new WalletClient()
  
  // Get your identity public key
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  console.log('Your identity:', publicKey)
  
  return wallet
}
```

The wallet is used for identity: its public key identifies you in messages, and it signs all communication for BRC-103 authentication.

## Step 3 — Send a message via MessageBox (HTTP store-and-forward)

Create `sendMessage.ts` using the MessageBoxClient:

```typescript
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

export async function sendMessageToRecipient(
  wallet: WalletClient,
  recipientPublicKey: string,
  messageBody: string
) {
  // Initialize message box client
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',  // MessageBox server URL
    walletClient: wallet,
    networkPreset: 'testnet'  // 'testnet' or 'mainnet'
  })
  
  // Auto-initializes on first use; or manually:
  await msgBoxClient.init()
  
  // Send message
  const response = await msgBoxClient.sendMessage({
    recipient: recipientPublicKey,
    messageBox: 'inbox',  // Named inbox (arbitrary string)
    body: messageBody,
    skipEncryption: false  // Default: AES-256-GCM encryption
  })
  
  console.log('Message sent:', response)
  return response
}
```

This approach:
- **Encrypts** the message body with AES-256-GCM
- **Signs** the request with wallet identity (BRC-103)
- **Stores** on server; recipient retrieves whenever ready
- **Fallback**: Can retry via HTTP if WebSocket unavailable

## Step 4 — Retrieve messages from inbox

Add a function to poll the message box:

```typescript
export async function listInboxMessages(
  wallet: WalletClient,
  messageBox: string = 'inbox'
) {
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',
    walletClient: wallet,
    networkPreset: 'testnet'
  })
  
  // Fetch all messages in named inbox
  const messages = await msgBoxClient.listMessages({
    messageBox
  })
  
  console.log(`Found ${messages.length} messages`)
  messages.forEach((msg: any) => {
    console.log(`From: ${msg.sender}`)
    console.log(`Body: ${msg.body}`)
    console.log(`Timestamp: ${msg.timestamp}`)
  })
  
  return messages
}
```

`listMessages()` retrieves all stored messages. Each message includes:
- `sender`: Wallet identity of sender (verified via BRC-103)
- `body`: Decrypted message content
- `timestamp`: When message was received
- `messageId`: Used for acknowledgment

## Step 5 — Acknowledge (delete) messages after reading

Add cleanup to remove messages once processed:

```typescript
export async function acknowledgeMessages(
  wallet: WalletClient,
  messageIds: string[]
) {
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',
    walletClient: wallet,
    networkPreset: 'testnet'
  })
  
  // Delete messages by ID
  await msgBoxClient.acknowledgeMessage({
    messageIds
  })
  
  console.log(`Acknowledged ${messageIds.length} messages`)
}
```

Messages are ephemeral: acknowledged messages are deleted from server. This prevents storage bloat.

## Step 6 — Listen for live messages via WebSocket

Add real-time push notifications:

```typescript
export async function listenForLiveMessages(
  wallet: WalletClient,
  messageBox: string = 'inbox'
) {
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',
    walletClient: wallet,
    networkPreset: 'testnet'
  })
  
  // Initialize WebSocket connection
  await msgBoxClient.initializeConnection()
  
  // Subscribe to room
  await msgBoxClient.joinRoom(messageBox)
  
  // Listen for live messages (push delivery)
  await msgBoxClient.listenForLiveMessages({
    messageBox,
    onMessage: (msg: any) => {
      console.log('Live message received!')
      console.log(`From: ${msg.sender}`)
      console.log(`Body: ${msg.body}`)
    }
  })
}
```

Live messaging via WebSocket:
- **Instant delivery** when server receives message
- **Must join room** first via `joinRoom()`
- **Falls back to HTTP** if WebSocket unavailable
- **Automatic re-auth** on reconnect (BRC-103 handles it)

## Step 7 — Use Authsocket for custom WebSocket messaging

For more control, use Authsocket directly:

```typescript
import { AuthSocketClient } from '@bsv/authsocket-client'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

export async function connectViaAuthsocket(privateKeyHex: string) {
  // Create authenticated socket
  const wallet = new ProtoWallet(PrivateKey.fromHex(privateKeyHex))
  
  const socket = AuthSocketClient('wss://peer.example.com:8080', {
    wallet
  })
  
  // Standard Socket.IO API — messages auto-signed/verified
  socket.on('connect', () => {
    console.log('Connected:', socket.id)
    socket.emit('chatMessage', { text: 'Hello from client!' })
  })
  
  socket.on('chatMessage', (msg: any) => {
    console.log('Verified message from peer:', msg)
  })
  
  socket.on('disconnect', () => {
    console.log('Disconnected')
  })
}
```

Authsocket provides:
- **BRC-103 handshake** on every connect
- **Message signing** (automatic)
- **Message verification** (automatic)
- **Certificate exchange** (optional)
- **Standard Socket.IO API** for custom events

## Putting it all together

Create `main.ts` combining both approaches:

```typescript
import { WalletClient } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'

async function main() {
  // Step 1: Initialize wallet
  console.log('Step 1: Initializing wallet...')
  const wallet = new WalletClient()
  const { publicKey: myPublicKey } = await wallet.getPublicKey({ identityKey: true })
  console.log('Your identity:', myPublicKey)
  
  // Step 2: Initialize message box client
  console.log('\nStep 2: Setting up message box client...')
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',
    walletClient: wallet,
    networkPreset: 'testnet'
  })
  await msgBoxClient.init()
  
  // Step 3: Send a message to a peer
  console.log('\nStep 3: Sending message...')
  const recipientKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
  await msgBoxClient.sendMessage({
    recipient: recipientKey,
    messageBox: 'inbox',
    body: 'Hello from TypeScript!',
    skipEncryption: false
  })
  console.log('Message sent')
  
  // Step 4: Check inbox for messages
  console.log('\nStep 4: Checking inbox...')
  const messages = await msgBoxClient.listMessages({
    messageBox: 'inbox'
  })
  console.log(`Found ${messages.length} messages`)
  
  messages.forEach((msg: any) => {
    console.log(`- From ${msg.sender}: ${msg.body}`)
  })
  
  // Step 5: Acknowledge messages
  if (messages.length > 0) {
    const messageIds = messages.map((m: any) => m.messageId)
    await msgBoxClient.acknowledgeMessage({ messageIds })
    console.log(`Acknowledged ${messageIds.length} messages`)
  }
  
  // Step 6: Start listening for live messages
  console.log('\nStep 6: Listening for live messages...')
  await msgBoxClient.initializeConnection()
  await msgBoxClient.joinRoom('inbox')
  
  await msgBoxClient.listenForLiveMessages({
    messageBox: 'inbox',
    onMessage: (msg: any) => {
      console.log(`[LIVE] From ${msg.sender}: ${msg.body}`)
    }
  })
  
  console.log('\nListening for live messages... Press Ctrl+C to stop.')
  
  // Keep process alive
  await new Promise(() => {})
}

main().catch(console.error)
```

Run with:

```bash
npx ts-node main.ts
```

This complete example:
1. Initializes wallet identity
2. Sets up MessageBox client
3. Sends a message to a peer
4. Retrieves message history
5. Acknowledges (deletes) messages
6. Listens for live messages via WebSocket

## Troubleshooting

**"Auto-init now default"**
→ `init()` is optional; first use auto-initializes. Call explicitly for control

**"Encryption on by default"**
→ Message bodies are AES-256-GCM encrypted. Set `skipEncryption: true` for raw data

**"Live vs HTTP tradeoff"**
→ WebSocket (`listenForLiveMessages`) faster but requires connection. HTTP (`listMessages`) more reliable for offline use

**"Payment rejection"**
→ If using PeerPayClient for payments, rejecting sends refund minus 1000 sats. If payment < 1000, it's just dropped

**"Overlay discovery slow"**
→ If no explicit host provided, client queries overlay network for peer discovery (~10s). Provide `host` directly to skip discovery

**"Room subscription required"**
→ WebSocket requires `joinRoom()` before `listenForLiveMessages()`. Omitting this silently drops live messages

**"No peer identity"**
→ Peer's public key is required. Use overlay discovery to find it: `wallet.discoverByTopic({protocol: 'identity', ...})`

## What to read next

- **[MessageBoxClient API](../packages/messaging/message-box-client.md)** — Full store-and-forward reference
- **[AuthSocketClient API](../packages/messaging/authsocket-client.md)** — Real-time WebSocket reference
- **[BRC-103 Mutual Authentication](../specs/brc-31-auth.md)** — Authentication protocol details
- **Peer-to-Peer Payments** — Combine messaging with payments
- **[Message-box Server](../infrastructure/message-box-server.md)** — Deploy your own storage backend
