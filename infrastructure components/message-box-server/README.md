# Message Box Server

A secure, peer-to-peer message routing server designed for the Bitcoin SV ecosystem. Supports both HTTP and WebSocket message transport, encrypted payloads, identity-based routing, and overlay advertisement via SHIP.

## Table of Contents
 
1. [Overview](#1-overview)  
2. [Concepts](#2-concepts)  
3. [Environment Variables](#3-environment-variables)  
4. [Quick Start](#4-quick-start)  
5. [Examples](#5-examples)  
6. [API Reference](#6-api-reference)  
   - [POST /sendMessage](#post-sendmessage)  
   - [POST /listMessages](#post-listmessages)  
   - [POST /acknowledgeMessage](#post-acknowledgemessage)  
7. [WebSocket Support](#7-websocket-support)  
8. [Authentication](#8-authentication)  
9. [Scripts](#9-scripts)  
10. [Deploying](#10-deploying)  
11. [License](#11-license)

## 1. Overview

MessageBox is a peer-to-peer messaging API that enables secure, encrypted, and authenticated communication between users on the MetaNet. This is primarily achieved through a message-box architecture combined with optional overlay routing and real-time WebSocket transport.

When a user sends a message, they must specify the messageBox type and the intended recipient (an identity key). This design allows for protocol-specific messageBox types to be defined at higher application layers, while maintaining clear separation of messages by type and recipient. Each message is routed into a box associated with a specific recipient and use case.

Security is a critical aspect of MessageBox. It relies on [AuthExpress middleware](https://github.com/bitcoin-sv/auth-express-middleware) to ensure that only the recipient can access and acknowledge their own messages. Encrypted payloads are supported automatically following [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md), using secure symmetric encryption between authenticated peers.

MessageBox also supports [@bsv/authsocket](https://www.npmjs.com/package/@bsv/authsocket) for real-time authenticated WebSocket communication. This enables clients to receive messages instantly and interact with rooms associated with their identity key and chosen messageBox.

To interact with MessageBox, use [MessageBoxClient](https://github.com/bitcoin-sv/p2p), the client-side library designed to handle authentication, encryption, WebSocket communication, and overlay resolution.

## 2. Concepts
- **Identity Key:** All messages are addressed to an identity key (a public key)
- **MessageBox:** A named message stream associated with an identity key (e.g., payment_inbox)
- **Encrypted Payloads:** Messages can be AES-encrypted and include metadata
- **Live Messaging:** Clients can join WebSocket rooms and receive messages in real-time
- **Acknowledgment:** Messages must be acknowledged to be removed from the database
________________________________________

## 3. Environment Variables
**Variables**

NODE_ENV - Set to development, staging, or production

PORT - Port for the HTTP server (default: 8080 or 3000)

ROUTING_PREFIX - (Optional) Prefix for all HTTP and WebSocket routes (e.g., /api)

HOSTING_DOMAIN - (Optional) Full domain where this server is hosted (used in overlay metadata)

SERVER_PRIVATE_KEY - Required. 256-bit hex private key used for identity, signing, and authentication

WALLET_STORAGE_URL - URL of a wallet-storage service that stores key derivation metadata

NETWORK - Target network chain (e.g., main, test, or regtest)

KNEX_DB_CONNECTION - (Optional) JSON-formatted connection string for MySQL/Knex (if not using default)

ENABLE_WEBSOCKETS - Set to 'true' to enable real-time messaging over WebSocket

LOGGING_ENABLED - Set to 'true' to enable verbose debug logging in any environment

MIGRATE_KEY - (Optional) Key used to authorize protected migration operations, if required

________________________________________

## 4. Quick Start

To run the MessageBox Server locally or in a hosted environment, follow the steps below.

1. **Clone the Repository**
```bash
git clone https://github.com/bitcoin-sv/messagebox-server.git
cd messagebox-server
```

2. **Configure Environment Variables**
Create a .env file based on the variables listed in the Environment Variables section:

```bash
cp .env.example .env
```

Then fill in or update the necessary fields in .env, including:

SERVER_PRIVATE_KEY – your root private key for identity/auth

WALLET_STORAGE_URL – points to a wallet-storage instance

(Optional) KNEX_DB_CONNECTION – if you're not using the default MySQL config

For local development, use:

```bash
.env
NODE_ENV=development
BSV_NETWORK=local
```

3. **Install Dependencies**
```bash
npm install
```

4. **Start the Server**

```bash
npm run dev
```
**Note:**  
MessageBox Server requires a MySQL database for storing messages.  
See [Deploying](#10-deploying) for instructions on setting up the required database locally or in production environments.

This launches the Express-based MessageBox Server on the configured port (default: 8080 or 3000 in production). WebSocket support will be enabled if ENABLE_WEBSOCKETS=true in your environment.

You can customize the HTTP port using the PORT variable in .env.

You're now ready to send and receive messages using the MessageBoxClient, test endpoints, and participate in the overlay network.

________________________________________

## 5. Examples

This section provides quick examples for sending, listing, and acknowledging messages using the MessageBoxClient library.

1. **Sending a Message**
```ts
import { WalletClient } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/p2p'

const wallet = new WalletClient()
const mb = new MessageBoxClient({
  walletClient: wallet,
  host: 'http://localhost:8080' // your MessageBoxServer instance
})

await mb.sendMessage({
  recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
  messageBox: 'demo_inbox',
  body: { text: 'Hello there!' }
})
```

2. **Listening for Live Messages (WebSocket)**
```ts
await mb.initializeConnection()

await mb.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('New Message:', msg)
  }
})
```

3. **Listing Messages via HTTP**
```ts
const messages = await mb.listMessages({
  messageBox: 'demo_inbox'
})

console.log('All Messages:', messages)
```

4. **Acknowledging Messages (Marking as Read)**
```ts
const toAcknowledge = messages.map(m => m.messageId.toString())

await mb.acknowledgeMessage({
  messageIds: toAcknowledge
})
```

5. **Sending a Live Message with Fallback**
```ts
await mb.sendLiveMessage({
  recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
  messageBox: 'demo_inbox',
  body: 'This will try WebSocket first, and fallback to HTTP if needed.'
})
```

________________________________________

## 6. API Reference
The MessageBox Server exposes a small set of authenticated HTTP endpoints to support secure, store-and-forward messaging. All routes require identity-based authentication using @bsv/auth-express-middleware.

### POST /sendMessage
Send a message to a specific recipient’s message box.

**Request Body**
```json
{
  "message": {
    "recipient": "IDENTITY_PUBLIC_KEY",
    "messageBox": "payment_inbox",
    "messageId": "abc123",
    "body": "{\"amount\":10000}"
  }
}
```

**Response**
```json
{
  "status": "success",
  "messageId": "abc123",
  "message": "Your message has been sent to IDENTITY_PUBLIC_KEY"
}
```

Messages are persisted in the recipient’s messageBox.

messageId must be globally unique (can be derived using HMAC).

Duplicate messageIds will be ignored.

### POST /listMessages
List all messages from a given messageBox owned by the authenticated identity.

**Request Body**
```json
{
  "messageBox": "payment_inbox"
}
```

**Response**
```json
{
  "status": "success",
  "messages": [
    {
      "messageId": "abc123",
      "body": "{\"amount\":10000}",
      "sender": "SENDER_PUBLIC_KEY",
      "created_at": "2024-12-01T12:00:00Z",
      "updated_at": "2024-12-01T12:01:00Z"
    }
  ]
}
```

Message bodies will be returned as strings (plain or encrypted).

Empty arrays are returned if no messages exist or the box is unregistered.

### POST /acknowledgeMessage
Permanently delete one or more messages after they have been processed.

**Request Body**
```json
{
  "messageIds": ["abc123", "def456"]
}
```

**Response**
```json
{
  "status": "success"
}
```

This action cannot be undone.

Only messages owned by the authenticated identity can be acknowledged.

Note: All requests must include automatically signed and verified headers following [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) authentication.
Mutual authentication is handled transparently by [@bsv/auth-express-middleware](https://www.npmjs.com/package/@bsv/auth-express-middleware).

________________________________________

## 7. WebSocket Support
The MessageBox Server supports real-time messaging over WebSocket using @bsv/authsocket. This allows clients to send and receive messages instantly without polling.

**Connection**
Clients should connect to the same host and port used by the HTTP server (e.g., ws://localhost:8080) and must authenticate using their identity key.

**Authentication**
There are two ways to authenticate:

During initial connection: Send the identityKey as part of the connection handshake.

After connecting: Emit an authenticated event with { identityKey }.

Once authenticated, the server emits authenticationSuccess. If the key is missing or invalid, authenticationFailed is returned.

**Room Format**
Each messageBox uses a room in the format:

```bash
{identityKey}-{messageBox}
```
For example:
028d37b94120...-payment_inbox

**Events**

authenticated -	Authenticate using an identity key
joinRoom	- Subscribe to a specific messageBox room
sendMessage -	Send a message to a room (triggers DB storage + broadcast)
sendMessageAck-ROOM -	Acknowledgment that the message was received by the server
sendMessage-ROOM -	Broadcasted message to all listeners in the room
leaveRoom	- Unsubscribe from a room

**Example WebSocket Usage (Client)**
```ts
import { io } from 'socket.io-client'

const socket = io('ws://localhost:8080')

// Step 1: Authenticate after connection
socket.emit('authenticated', { identityKey })

// Step 2: Join a messageBox room
socket.emit('joinRoom', '028d...-payment_inbox')

// Step 3: Send a message
socket.emit('sendMessage', {
  roomId: '028d...-payment_inbox',
  message: {
    messageId: 'abc123',
    recipient: '028d...',
    body: JSON.stringify({ hello: 'world' })
  }
})

// Step 4: Listen for acknowledgment and broadcast
socket.on('sendMessageAck-028d...-payment_inbox', (ack) => {
  console.log('Message acknowledged:', ack)
})

socket.on('sendMessage-028d...-payment_inbox', (msg) => {
  console.log('New message received:', msg)
})
```

**Notes**
Messages sent via WebSocket are also persisted in the database.

If a room is not joined or the recipient isn't online, delivery is deferred until the recipient polls via HTTP.

If ENABLE_WEBSOCKETS is not set to 'true', this functionality is disabled.

________________________________________
## 8. Authentication
All HTTP and WebSocket communications use full mutual authentication based on [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md).
- HTTP requests are authenticated using [@bsv/auth-express-middleware](https://www.npmjs.com/package/@bsv/auth-express-middleware), with automatically signed and verified headers.
- WebSocket connections are authenticated using [@bsv/authsocket](https://www.npmjs.com/package/@bsv/authsocket), signing the WebSocket handshake and room interactions.

Clients authenticate automatically when using the [MessageBoxClient](https://github.com/bitcoin-sv/p2p) library. Manual integrations must follow BRC-103 signing conventions.

________________________________________

## 9. Scripts
```bash
npm run dev      # Start with hot reloading
npm run start    # Start in production
npm run test     # Run all tests
npm run build    # Compile documentation
```
________________________________________

## 10. Deploying
See [DEPLOYING.md](./DEPLOYING.md) for tips.
________________________________________
## 11. License
This project is released under the [Open BSV License](https://www.bsvlicense.org/).

