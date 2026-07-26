# @bsv/message-box-client

Authenticated, optionally encrypted store-and-forward messaging for BSV
applications. The package supports browser and Node.js consumers, HTTP polling,
live authenticated WebSockets, overlay-based host discovery, peer payments,
token-settlement adapters, permissions, quotes, and push-device registration.

## Install

```bash
npm install @bsv/message-box-client @bsv/sdk
```

`@bsv/sdk` is a required peer dependency. The package supports Node.js 22 and
newer and publishes module-correct ESM and CommonJS entry points.

## Basic messaging

```ts
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient()
const messages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://message-box-us-1.bsvb.tech'
})

const recipient = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'

await messages.sendMessage({
  recipient,
  messageBox: 'general_inbox',
  body: { text: 'Hello' }
})

const pending = await messages.listMessages({
  messageBox: 'general_inbox'
})

await messages.acknowledgeMessage({
  messageIds: pending.map(message => message.messageId)
})
```

Explicit `init()` is optional. Public methods initialize the wallet identity
when needed:

```ts
await messages.init()
```

Encryption is enabled by default through the wallet protocol. Plaintext is an
explicit interoperability choice:

```ts
await messages.sendMessage({
  recipient,
  messageBox: 'public_payloads',
  body: 'This payload is intentionally plaintext.',
  skipEncryption: true
})
```

The server authenticates and routes ciphertext but does not hold the wallet
keys required to decrypt it.

## Live messages

```ts
await messages.listenForLiveMessages({
  messageBox: 'general_inbox',
  onMessage: message => {
    console.log(message.sender, message.body)
  }
})

await messages.sendLiveMessage({
  recipient,
  messageBox: 'general_inbox',
  body: 'Live when possible, store-and-forward when needed.'
})
```

`sendLiveMessage()` uses an authenticated WebSocket and falls back to the HTTP
send route when the socket is unavailable or does not acknowledge delivery.
Call `disconnectWebSocket()` when a long-lived client shuts down.

## Host selection and public-service access

An explicitly configured host may use HTTP or HTTPS so local development and
operator-controlled private networks remain possible. It must be an absolute
URL without credentials, a query, or a fragment. Route prefixes are supported:

```ts
const messages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messaging.example.com/api'
})
```

Overlay advertisements are untrusted network input. Discovered destinations
must use public HTTPS addresses; loopback, private, link-local, reserved, and
documentation-only hosts are rejected before a request is made. If no valid
advertisement exists, the configured host is used.

Message Box is a public protocol service. Compatible servers should remain
browser-accessible by default with credential-free wildcard CORS, including
opaque `Origin: null` callers such as mobile webviews. Operators may opt into
an exact-origin allowlist or disable browser CORS. CSP governs served documents
and is not API authorization. BRC-103 authentication, recipient ownership,
permissions, payments, quotas, and message encryption remain the security
boundaries.

## Permissions and delivery quotes

```ts
await messages.setMessageBoxPermission({
  messageBox: 'notifications',
  sender: recipient,
  recipientFee: 10
})

const quote = await messages.getMessageBoxQuote({
  recipient,
  messageBox: 'notifications'
})
```

Permission fees use these values:

- `-1`: blocked
- `0`: allowed without a recipient fee
- positive integer: required satoshi amount

Set `checkPermissions: true` on `sendMessage()` when the client should quote
and construct the required payment before sending.

## Peer payments

```ts
import { PeerPayClient } from '@bsv/message-box-client'

const payments = new PeerPayClient({ walletClient: wallet })

await payments.sendPayment({
  recipient,
  amount: 50_000
})

const incoming = await payments.listIncomingPayments()
for (const payment of incoming) {
  await payments.acceptPayment(payment)
}
```

`PeerPayClient` uses BRC-29 wallet-payment derivation and the same authenticated
Message Box transport. It also supports live delivery, payment requests,
responses, cancellations, and explicit rejection/refund flows.

## Token settlement

`PeerTokenClient` routes token transfers and requests through Message Box while
delegating token-standard-specific transaction work to registered
`TokenSettlementAdapter` implementations:

```ts
import { PeerTokenClient } from '@bsv/message-box-client'

const tokens = new PeerTokenClient({
  walletClient: wallet,
  adapters: [myTokenAdapter]
})
```

The library does not assume a token wire format. Adapters own construction,
acceptance, termination, and receipt data for their protocol.

`RemittanceAdapter` exposes Message Box as an SDK remittance communication
layer.

## HTTP and WebSocket contract

The client uses these authenticated HTTP routes:

| Method | Route                 | Purpose                                              |
| ------ | --------------------- | ---------------------------------------------------- |
| POST   | `/sendMessage`        | Send to one or up to 100 recipients                  |
| POST   | `/listMessages`       | Read a named box owned by the authenticated identity |
| POST   | `/acknowledgeMessage` | Delete acknowledged messages owned by the identity   |
| POST   | `/registerDevice`     | Register a Firebase push token                       |
| GET    | `/devices`            | List the identity's registered devices               |
| POST   | `/permissions/set`    | Set a sender-specific or box-wide permission         |
| GET    | `/permissions/get`    | Read a permission                                    |
| GET    | `/permissions/list`   | List permissions                                     |
| GET    | `/permissions/quote`  | Quote one or up to 100 recipients                    |

The corresponding OpenAPI source is
[`specs/messaging/message-box-http.yaml`](../../../specs/messaging/message-box-http.yaml).
Live delivery uses authenticated Socket.IO events and identity-owned rooms.

## Public exports

- `MessageBoxClient`
- `PeerPayClient`
- `PeerTokenClient`
- `RemittanceAdapter`
- `TokenSettlementAdapter` and its supporting types
- messaging, payment, token, device, permission, quote, and batch-send types
- standard message-box name constants

## Development

From the repository root:

```bash
pnpm --filter @bsv/message-box-client typecheck
pnpm --filter @bsv/message-box-client lint
pnpm --filter @bsv/message-box-client test
pnpm --filter @bsv/message-box-client test:coverage
pnpm --filter @bsv/message-box-client pack:check
pnpm --filter @bsv/message-box-client test:browser
```

The unit suite is deterministic and does not contact a deployed service.
`test:integration` is explicitly opt-in because it requires configured wallet,
Message Box, database, WebSocket, and overlay services:

```bash
MESSAGE_BOX_RUN_INTEGRATION=true \
MESSAGE_BOX_INTEGRATION_HOST=http://127.0.0.1:8080 \
MESSAGE_BOX_WALLET_ORIGINATOR=localhost \
pnpm --filter @bsv/message-box-client test:integration
```

Targets under `*.bsvb.tech` require an additional explicit
`MESSAGE_BOX_ALLOW_PRODUCTION_INTEGRATION=true` acknowledgement because the
suite creates and acknowledges real messages.

The release tarball contains compiled ESM/CommonJS JavaScript, matching
declarations and source maps, the UMD browser bundle, this README, and the
license. It does not publish TypeScript source, tests, coverage, editor files,
or package-manager locks.

## License

See [LICENSE.txt](./LICENSE.txt).
