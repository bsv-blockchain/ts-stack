# BSV Peer-to-Peer Messaging & Payment Tools

**@bsv/message-box-client** is a toolkit for **peer-to-peer messaging and payments** on the BSV blockchain. It leverages a server-side **store-and-forward** system for message delivery (via `MessageBoxClient`) and also includes a higher-level **peer-to-peer payment** flow (via `PeerPayClient`). Both functionalities build on [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) for mutual authentication and identity key management, allowing secure and  authenticated exchanges of data and BSV.

## Table of Contents

1. [Introduction](#1-introduction)  
2. [Installation](#2-installation) 
   - [Running Integration Tests](#21-running-integration-tests)
3. [Overview](#3-overview)  
   - [MessageBoxClient](#31-messageboxclient-overview)  
   - [PeerPayClient](#32-peerpayclient-overview)  
4. [Quick Start Examples](#4-quick-start-examples)  
   - [Using MessageBoxClient](#41-using-messageboxclient)  
   - [Using PeerPayClient](#42-using-peerpayclient)  
5. [API Reference](#5-api-reference)  
   - [MessageBoxClient API](#51-messageboxclient-api)  
   - [PeerPayClient API](#52-peerpayclient-api)  
6. [Contributing](#6-contributing)  
7. [License](#7-license)

---

## 1. Introduction

The **@bsv/message-box-client** library provides two main tools for peer-to-peer interaction:

1. **MessageBoxClient** – A store-and-forward messaging system backed by a "message box" server. It supports authenticated sending, listing, and acknowledging (deleting) messages with a mutual-auth approach.  
2. **PeerPayClient** – A higher-level payment client built on top of `MessageBoxClient`, enabling real-time, peer-to-peer Bitcoin payments on the BSV blockchain.

Both clients use the [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md)-based authentication model. By integrating with a [WalletClient](https://github.com/bitcoin-sv), they can sign and verify messages, ensuring only authorized parties can send and receive.

The examples below use the public BSV Blockchain Association MessageBox endpoint where a concrete host is useful. This is a service default, not a protocol requirement; applications can use their own MessageBox server or another compatible provider.

---

## 2. Installation

```bash
npm install @bsv/message-box-client
```

The package exports both `MessageBoxClient` and `PeerPayClient`. You can import them individually in your JavaScript/TypeScript applications.

---

### 2.1. Running Integration Tests
The P2P integration tests verify live communication between the MessageBoxClient and a running instance of the MessageBox Server. To run them, make sure the following are set up:

**Prerequisites**
1.	MessageBox Server Running Locally
You must have a local instance of the [MessageBox Server](https://github.com/bitcoin-sv/messagebox-server.git) running.
Follow these steps inside the messagebox-server project:
```bash
git clone https://github.com/bitcoin-sv/messagebox-server.git
cd messagebox-server
cp .env.example .env
npm install
npm run start    # Starts LARS (overlay service on http://localhost:8080)
npm run dev      # Starts MessageBox Server (HTTP API on http://localhost:5001)
```

2.	Ensure Environment Configuration
Your .env file in the MessageBox Server must have:
```bash
NODE_ENV=development
BSV_NETWORK=local
ENABLE_WEBSOCKETS=true
```
and valid values for:
  - SERVER_PRIVATE_KEY
  - WALLET_STORAGE_URL
  - MONGO_URI and MONGO_DB
  - (Optional) If using MySQL locally, ensure KNEX_DB_CONNECTION is properly set.

3.	Wallet Storage Running (optional)
If your .env points to a local wallet-storage instance, make sure it is also running.

________________________________________

**Running the Tests**
Once the MessageBox Server and overlay service are running:
```bash
npm run test:integration
```

This will execute all integration tests under src/__tests__/integration/, including HTTP, WebSocket, encryption, and overlay scenarios.

________________________________________

**Notes**
- If the server is not running, tests will fail with network or timeout errors.
- Integration tests use the local network preset (networkPreset: 'local') and assume the default MessageBox API endpoints (e.g., http://localhost:8080).
- Some tests may require clearing the database manually between runs if data conflicts occur.
- Unit tests (non-integration) still run by default with npm test. Integration tests are separated.

________________________________________

**Quick Summary**
- npm run test → unit tests only
- npm run test:integration → integration tests against a running MessageBox server

________________________________________

## 3. Overview

### 3.1. MessageBoxClient Overview

`MessageBoxClient` uses a **store-and-forward** architecture for Peer-to-Peer messages:

- **Store-and-forward:** Messages are posted to a MessageBoxServer under a named "message box" (like an inbox).  
- **Ephemeral storage:** Once the recipient acknowledges the messages, they are removed from the server.  
- **Mutual authentication:** Ensures only authorized peers can read or post messages, using [AuthFetch](https://github.com/bitcoin-sv/authfetch) and [AuthSocketClient](https://github.com/bitcoin-sv/authsocket).  
- **Flexible transport:** Supports both **WebSockets** (for live, push-style delivery) and **HTTP** (for polling or fallback).  
- **Extensible:** Can be the foundation for more advanced workflows (e.g., token-based messaging, invoice/ticket systems, etc.).

#### Key Features

1. **Secure by default** using Auth libraries for signing/verification.  
2. **Real-time or delayed** delivery with sockets or HTTP.  
3. **Easy integration** with higher-level protocols and services.  

---

#### Important: Initialization Requirement

**Important:**  
Starting with version `@bsv/message-box-client@1.2.0`, `MessageBoxClient` **automatically initializes itself** if needed.

- If you provide a host during construction, the client will auto-initialize on first use.
- If no host is provided, the client will anoint a host from the overlay network automatically during initialization.

You may still **manually call** `await init()` if you want to control when initialization happens.

Example:

```ts
const client = new MessageBoxClient({ walletClient, host: process.env.MESSAGEBOX_HOST || 'https://message-box-us-1.bsvb.tech' })

// Manual init (optional but supported)
await client.init()

// Or just start sending — init will auto-run if needed
await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
```

Example:

```ts
const client = new MessageBoxClient({ walletClient, host: process.env.MESSAGEBOX_HOST || 'https://message-box-us-1.bsvb.tech' })
await client.init() // Must always call init() before using the client
await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
```
The `init()` method will:

- Anoint your messagebox host onto the overlay network if necessary.

- Initialize the client’s internal identity and network information.

- Ensure that your client can receive messages securely from peers.

---

### 3.2. PeerPayClient Overview

`PeerPayClient` builds on `MessageBoxClient` to enable **peer-to-peer Bitcoin payments**:

- **Secure Payment Delivery:** Utilizes the same store-and-forward or live WebSocket approach for delivering payment instructions.  
- **Derivation & Signing:** Creates a unique output script for each payment, derived from sender + recipient keys.  
- **Live or Delayed:** Works with web sockets for immediate notifications, or HTTP for an asynchronous flow.  
- **Wallet Integration:** Accept or reject incoming payments. If accepted, the payment is “internalized” into your [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) compatible wallet automatically.

#### Key Features

1. **Deterministic derivation** of payment information using the SPV-compliant [BRC-29](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0029.md) protocol.  
2. **Secure transaction passing** using the `MessageBoxClient` infrastructure.  
3. **Live or offline** support for receiving payments.  
4. **Easy acceptance/refunds** with built-in methods.  

---

## 4. Quick Start Examples

Below are two condensed examples: one for basic messaging (MessageBoxClient) and another for peer-to-peer payments (PeerPayClient).

### 4.1. Using MessageBoxClient

```js
const { WalletClient } = require('@bsv/sdk')
const { MessageBoxClient } = require('@bsv/message-box-client')

// Example identity key of the recipient (public key in hex)
const johnSmithKey = '022600d2ef37d123fdcac7d25d7a464ada7acd3fb65a0daf85412140ee20884311'

async function main() {
  // 1) Create your WalletClient (this obtains your identity key)
  const myWallet = new WalletClient()

  // 2) Create a MessageBoxClient, pointing to a MessageBoxServer
  const msgBoxClient = new MessageBoxClient({
    host: 'https://message-box-us-1.bsvb.tech',
    walletClient: myWallet
  })

  // 3) (Optional) Initialize the client manually
  await msgBoxClient.init()

  // (Optional) Initialize a WebSocket connection (for real-time listening)
  await msgBoxClient.initializeConnection()

  // 4) Send a message to John's "demo_inbox"
  await msgBoxClient.sendMessage({
    recipient: johnSmithKey,
    messageBox: 'demo_inbox',
    body: 'Hello John! This is a test message.'
  })

  // 5) List messages in "demo_inbox"
  const messages = await msgBoxClient.listMessages({ messageBox: 'demo_inbox' })
  console.log(messages[0].body) // --> "Hello John! This is a test message."

  // 6) Acknowledge (and delete) them from the server
  await msgBoxClient.acknowledgeMessage({
    messageIds: messages.map(msg => msg.messageId.toString())
  })
}

main().catch(console.error)
```
Note:
- If you do not manually call `await init()`, the client will automatically initialize itself when you use it.
- You can still call `await init()` manually if you want explicit control.
- `init()` ensures your identity is properly registered and discoverable via overlay advertisement if necessary.

**Listening for Live Messages**  
If you want push-style message notifications instead of polling:

```ts
await msgBoxClient.listenForLiveMessages({
  messageBox: 'demo_inbox',
  onMessage: (msg) => {
    console.log('Received live message in "demo_inbox":', msg.body)
  }
})
```

---

### 4.2. Using PeerPayClient

```ts
import { WalletClient } from '@bsv/sdk'
import { PeerPayClient } from '@bsv/message-box-client'

async function paymentDemo() {
  // 1) Create your wallet instance
  const wallet = new WalletClient()

  // 2) Create a PeerPayClient
  const peerPay = new PeerPayClient({
    walletClient: wallet
  })

  // 3) (Optional) Listen for incoming payments
  await peerPay.listenForLivePayments({
    onPayment: async (payment) => {
      console.log('Received payment:', payment)
      // Accept it into the wallet
      await peerPay.acceptPayment(payment)
    }
  })

  // 4) Send a payment of 50,000 sats to the recipient
  await peerPay.sendLivePayment({
    recipient: '0277a2b...e3f4', // recipient's public key
    amount: 50000
  })
}

paymentDemo().catch(console.error)
```

**Note:** `sendLivePayment` will try WebSocket first and fall back to HTTP if unavailable.

---

## 5. API Reference

```md
### 5.1. MessageBoxClient API
<!--#region ts2md-api-merged-here-->

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

##### Interfaces

| |
| --- |
| [AcknowledgeMessageParams](#interface-acknowledgemessageparams) |
| [EncryptedMessage](#interface-encryptedmessage) |
| [ListMessagesParams](#interface-listmessagesparams) |
| [MessageBoxClientOptions](#interface-messageboxclientoptions) |
| [PeerMessage](#interface-peermessage) |
| [SendMessageParams](#interface-sendmessageparams) |
| [SendMessageResponse](#interface-sendmessageresponse) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

###### Interface: AcknowledgeMessageParams

Defines the structure of a request to acknowledge messages.

Example

```ts
{
  messageIds: ["abc123", "def456"]
}
```

```ts
export interface AcknowledgeMessageParams {
    messageIds: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: EncryptedMessage

Encapsulates an AES-256-GCM encrypted message body.

Used when transmitting encrypted payloads to the MessageBox server.

```ts
export interface EncryptedMessage {
    encryptedMessage: Base64String;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: ListMessagesParams

Defines the structure of a request to list messages.

Example

```ts
{
  messageBox: "payment_inbox"
}
```

```ts
export interface ListMessagesParams {
    messageBox: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: MessageBoxClientOptions

Configuration options for initializing a MessageBoxClient.

```ts
export interface MessageBoxClientOptions {
    walletClient?: WalletClient;
    host?: string;
    enableLogging?: boolean;
    networkPreset?: "local" | "mainnet" | "testnet";
}
```

<details>

<summary>Interface MessageBoxClientOptions Details</summary>

####### Property enableLogging

If true, enables detailed logging to the console.

```ts
enableLogging?: boolean
```

####### Property host

Base URL of the MessageBox server.

```ts
host?: string
```

####### Property networkPreset

Overlay network preset for routing resolution.

```ts
networkPreset?: "local" | "mainnet" | "testnet"
```

####### Property walletClient

Wallet instance used for auth, identity, and encryption.
If not provided, a new WalletClient will be created.

```ts
walletClient?: WalletClient
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: PeerMessage

Represents a decrypted message received from a MessageBox.
Includes metadata such as sender identity, timestamps, and optional acknowledgment status.

Used in both HTTP and WebSocket message retrieval responses.

```ts
export interface PeerMessage {
    messageId: string;
    body: string;
    sender: string;
    created_at: string;
    updated_at: string;
    acknowledged?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: SendMessageParams

Parameters required to send a message.
Message content may be a string or object, and encryption is enabled by default.

Example

```ts
{
  recipient: "03abc...",
  messageBox: "payment_inbox",
  body: { type: "ping" },
  skipEncryption: false
}
```

```ts
export interface SendMessageParams {
    recipient: string;
    messageBox: string;
    body: string | object;
    messageId?: string;
    skipEncryption?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Interface: SendMessageResponse

Server response structure for successful message delivery.

Returned by both `sendMessage` and `sendLiveMessage`.

```ts
export interface SendMessageResponse {
    status: string;
    messageId: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
##### Classes

| |
| --- |
| [Logger](#class-logger) |
| [MessageBoxClient](#class-messageboxclient) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

###### Class: Logger

```ts
export class Logger {
    static enable(): void 
    static disable(): void 
    static log(...args: unknown[]): void 
    static warn(...args: unknown[]): void 
    static error(...args: unknown[]): void 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
###### Class: MessageBoxClient

Example

```ts
const client = new MessageBoxClient({ walletClient, enableLogging: true })
// Manual init is optional — client will auto-initialize if needed
await client.init()
await client.sendMessage({ recipient, messageBox: 'payment_inbox', body: 'Hello world' })
```

```ts
export class MessageBoxClient {
    public readonly authFetch: AuthFetch;
    constructor(options: MessageBoxClientOptions = {}) 
    async init(targetHost: string = this.host): Promise<void> 
    public getJoinedRooms(): Set<string> 
    public async getIdentityKey(): Promise<string> 
    public get testSocket(): ReturnType<typeof AuthSocketClient> | undefined 
    async initializeConnection(): Promise<void> 
    async resolveHostForRecipient(identityKey: string): Promise<string> 
    async joinRoom(messageBox: string): Promise<void> 
    async listenForLiveMessages({ onMessage, messageBox }: {
        onMessage: (message: PeerMessage) => void;
        messageBox: string;
    }): Promise<void> 
    async sendLiveMessage({ recipient, messageBox, body, messageId, skipEncryption }: SendMessageParams): Promise<SendMessageResponse> 
    async leaveRoom(messageBox: string): Promise<void> 
    async disconnectWebSocket(): Promise<void> 
    async sendMessage(message: SendMessageParams, overrideHost?: string): Promise<SendMessageResponse> 
    async anointHost(host: string): Promise<{
        txid: string;
    }> 
    async listMessages({ messageBox }: ListMessagesParams): Promise<PeerMessage[]> 
    async acknowledgeMessage({ messageIds }: AcknowledgeMessageParams): Promise<string> 
}
```

See also: [AcknowledgeMessageParams](#interface-acknowledgemessageparams), [ListMessagesParams](#interface-listmessagesparams), [MessageBoxClientOptions](#interface-messageboxclientoptions), [PeerMessage](#interface-peermessage), [SendMessageParams](#interface-sendmessageparams), [SendMessageResponse](#interface-sendmessageresponse)

<details>

<summary>Class MessageBoxClient Details</summary>

####### Constructor

```ts
constructor(options: MessageBoxClientOptions = {}) 
```
See also: [MessageBoxClientOptions](#interface-messageboxclientoptions)

Argument Details

+ **options**
  + Initialization options for the MessageBoxClient.

Example

```ts
const client = new MessageBoxClient({
  host: 'https://messagebox.example',
  walletClient,
  enableLogging: true,
  networkPreset: 'testnet'
})
await client.init()
```

####### Method acknowledgeMessage

```ts
async acknowledgeMessage({ messageIds }: AcknowledgeMessageParams): Promise<string> 
```
See also: [AcknowledgeMessageParams](#interface-acknowledgemessageparams)

Returns

- A string indicating the result, typically `'success'`.

Argument Details

+ **params**
  + An object containing an array of message IDs to acknowledge.

Throws

If the message ID array is missing or empty, or if the request to the server fails.

Example

```ts
await client.acknowledgeMessage({ messageIds: ['msg123', 'msg456'] })
```

####### Method anointHost

```ts
async anointHost(host: string): Promise<{
    txid: string;
}> 
```

Returns

- The transaction ID of the advertisement broadcast to the overlay network.

Argument Details

+ **host**
  + The full URL of the server you want to designate as your MessageBox host (e.g., "https://mybox.com").

Throws

If the URL is invalid, the PushDrop creation fails, or the overlay broadcast does not succeed.

Example

```ts
const { txid } = await client.anointHost('https://my-messagebox.io')
```

####### Method disconnectWebSocket

```ts
async disconnectWebSocket(): Promise<void> 
```

Returns

Resolves when the WebSocket connection is successfully closed.

Example

```ts
await client.disconnectWebSocket()
```

####### Method getIdentityKey

```ts
public async getIdentityKey(): Promise<string> 
```

Returns

The identity public key of the user

####### Method getJoinedRooms

```ts
public getJoinedRooms(): Set<string> 
```

Returns

A set of currently joined WebSocket room IDs

####### Method init

```ts
async init(targetHost: string = this.host): Promise<void> 
```

Argument Details

+ **targetHost**
  + Optional host to set or override the default host.

Throws

If no valid host is provided, or anointing fails.

Example

```ts
const client = new MessageBoxClient({ host: 'https://mybox.example', walletClient })
await client.init()
await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
```

####### Method initializeConnection

```ts
async initializeConnection(): Promise<void> 
```

Throws

If the identity key is unavailable or authentication fails

Example

```ts
const mb = new MessageBoxClient({ walletClient })
await mb.initializeConnection()
// WebSocket is now ready for use
```

####### Method joinRoom

```ts
async joinRoom(messageBox: string): Promise<void> 
```

Argument Details

+ **messageBox**
  + The name of the WebSocket room to join (e.g., "payment_inbox").

Example

```ts
await client.joinRoom('payment_inbox')
// Now listening for real-time messages in room '028d...-payment_inbox'
```

####### Method leaveRoom

```ts
async leaveRoom(messageBox: string): Promise<void> 
```

Argument Details

+ **messageBox**
  + The name of the WebSocket room to leave (e.g., `payment_inbox`).

Example

```ts
await client.leaveRoom('payment_inbox')
```

####### Method listMessages

```ts
async listMessages({ messageBox }: ListMessagesParams): Promise<PeerMessage[]> 
```
See also: [ListMessagesParams](#interface-listmessagesparams), [PeerMessage](#interface-peermessage)

Returns

- Returns an array of decrypted `PeerMessage` objects.

Argument Details

+ **params**
  + Contains the name of the messageBox to read from.

Throws

If no messageBox is specified, the request fails, or the server returns an error.

Example

```ts
const messages = await client.listMessages({ messageBox: 'inbox' })
messages.forEach(msg => console.log(msg.sender, msg.body))
```

####### Method listenForLiveMessages

```ts
async listenForLiveMessages({ onMessage, messageBox }: {
    onMessage: (message: PeerMessage) => void;
    messageBox: string;
}): Promise<void> 
```
See also: [PeerMessage](#interface-peermessage)

Argument Details

+ **params**
  + Configuration for the live message listener.

Example

```ts
await client.listenForLiveMessages({
  messageBox: 'payment_inbox',
  onMessage: (msg) => console.log('Received live message:', msg)
})
```

####### Method resolveHostForRecipient

```ts
async resolveHostForRecipient(identityKey: string): Promise<string> 
```

Returns

- A fully qualified host URL for the recipient's MessageBox server.

Argument Details

+ **identityKey**
  + The public identity key of the intended recipient.

Example

```ts
const host = await resolveHostForRecipient('028d...') // → returns either overlay host or this.host
```

####### Method sendLiveMessage

```ts
async sendLiveMessage({ recipient, messageBox, body, messageId, skipEncryption }: SendMessageParams): Promise<SendMessageResponse> 
```
See also: [SendMessageParams](#interface-sendmessageparams), [SendMessageResponse](#interface-sendmessageresponse)

Returns

A success response with the generated messageId.

Argument Details

+ **param0**
  + The message parameters including recipient, box name, body, and options.

Throws

If message validation fails, HMAC generation fails, or both WebSocket and HTTP fail to deliver.

Example

```ts
await client.sendLiveMessage({
  recipient: '028d...',
  messageBox: 'payment_inbox',
  body: { amount: 1000 }
})
```

####### Method sendMessage

```ts
async sendMessage(message: SendMessageParams, overrideHost?: string): Promise<SendMessageResponse> 
```
See also: [SendMessageParams](#interface-sendmessageparams), [SendMessageResponse](#interface-sendmessageresponse)

Returns

- Resolves with `{ status, messageId }` on success.

Argument Details

+ **message**
  + Contains recipient, messageBox name, message body, optional messageId, and skipEncryption flag.
+ **overrideHost**
  + Optional host to override overlay resolution (useful for testing or private routing).

Throws

If validation, encryption, HMAC, or network request fails.

Example

```ts
await client.sendMessage({
  recipient: '03abc...',
  messageBox: 'notifications',
  body: { type: 'ping' }
})
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

<!--#endregion ts2md-api-merged-here-->
---

### 5.2. PeerPayClient API

```ts
import { PeerPayClient } from '@bsv/message-box-client'
```

#### Constructor

```ts
new PeerPayClient({
  walletClient: WalletClient,
  messageBoxHost?: string,
  enableLogging?: boolean
})
```

- **walletClient**: (Required) Your identity/signing wallet.  
- **messageBoxHost**: (Optional) Base URL of the MessageBoxServer. Defaults to `https://message-box-us-1.bsvb.tech`.
- **enableLogging**: (Optional) Enables verbose debug output.

---

#### `sendPayment({ recipient, amount })`

```ts
await peerPay.sendPayment({
  recipient: '0277a2b...',
  amount: 10000
})
```

- Sends a payment using HTTP.  
- Internally derives a public key for the recipient and builds a transaction.

---

#### `sendLivePayment({ recipient, amount })`

```ts
await peerPay.sendLivePayment({
  recipient: '0277a2b...',
  amount: 15000
})
```

- Sends a payment using WebSockets, falling back to HTTP if needed.

---

#### `listenForLivePayments({ onPayment })`

```ts
await peerPay.listenForLivePayments({
  onPayment: (payment) => {
    console.log('New live payment:', payment)
  }
})
```

- Subscribes to live payments in the `payment_inbox`.
- Invokes `onPayment` callback with an `IncomingPayment` object:

```ts
interface IncomingPayment {
  messageId: number;
  sender: string;
  token: {
    customInstructions: {
      derivationPrefix: string;
      derivationSuffix: string;
    };
    transaction: any; // typically your BSV transaction format
    amount: number;
  };
}
```

---

#### `acceptPayment(payment)`

```ts
await peerPay.acceptPayment(payment)
```

- Accepts (and "internalizes") the payment into your wallet.  
- Acknowledges the message, removing it from the inbox.

---

#### `rejectPayment(payment)`

```ts
await peerPay.rejectPayment(payment)
```

- Rejects the payment, returning a **refund** to the sender (minus a small fee, e.g. 1000 sats).  
- If the amount is too small to refund, the payment is simply acknowledged and dropped.

---

#### `listIncomingPayments()`

```ts
const payments = await peerPay.listIncomingPayments()
```

- Lists all incoming payments in the `payment_inbox`.  
- Returns an array of `IncomingPayment` objects.

---

## 6. Contributing

1. Clone this repository.  
2. Install dependencies with `npm install`.  
3. Make your changes, write tests, and open a PR.  

We welcome bug reports, feature requests, and community contributions!

---

## 7. License

This code is licensed under the [Open BSV License](https://www.bsvlicense.org/). See [LICENSE](./LICENSE) for details.
