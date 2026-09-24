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

TerraTestNet clients select the isolated overlay network and provide the
dedicated TTN Message Box deployment explicitly:

```ts
const ttnMessages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messagebox.ttn.example',
  networkPreset: 'teratestnet'
})
```

The explicit host is required until the dedicated TTN Message Box service has
been deployed. This prevents TTN clients from silently using a testnet service.

`listMessages()` preserves its historical fetch-all behavior by following
bounded server pages. Limit aggregate client memory when appropriate:

```ts
const firstTwoPages = await messages.listMessages({
  messageBox: 'general_inbox',
  pageSize: 250,
  maxPages: 2
})

const nextThousand = await messages.listMessages({
  messageBox: 'general_inbox',
  offset: 1000,
  limit: 1000
})
```

The client uses AuthFetch for BRC-105 challenges. It intentionally does not add
a second Message Box-specific cost-approval mechanism because BRC-100 wallet
permissions already govern payment authorization.

The UMD bundle includes SDK 2.5.0 support for the optional
`x-bsv-payment-known-txids` response header; module consumers can enable it by
using SDK 2.5.0 or later. This SDK extension lets recipients advertise already
validated payment ancestors so compatible wallets can omit them from payment
BEEF. It is not a standardized BRC-105 header. Existing compatible SDK peers
remain supported, and services that omit the header retain existing payment
behavior. No consumer migration is required.

Explicit `init()` is optional. Public methods initialize the wallet identity
when needed:

```ts
await messages.init()
```

Client diagnostics, including errors, are disabled by default. Set
`enableLogging: true` only when fixed lifecycle events are useful to a trusted
local operator. Diagnostics intentionally omit message bodies and IDs,
identity keys, hosts and query parameters, wallet exceptions, settlement
artifacts, transactions, payment amounts, device tokens, and server response
objects. Applications should record their own correlation identifier when
they need to connect a fixed client event to an application request; do not
reintroduce wallet or message data into console logs.

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
It captures and validates the same immutable recipient, message-box, body,
message-ID, permission, and payment-ceiling authority as `sendMessage()` before
opening or joining a socket. Room names are exact, control-free strings rather
than values the client or server silently trims.
Call `disconnectWebSocket()` when a long-lived client shuts down.

### Socket options

`socketOptions` is forwarded to the underlying `AuthSocketClient` when the live
socket is created. Use it to select Socket.IO transports when a deployment's
fronting infrastructure does not carry Engine.IO HTTP polling:

```ts
const messages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messagebox.example',
  socketOptions: { managerOptions: { transports: ['websocket'] } }
})

await messages.listenForLiveMessages({
  messageBox: 'general_inbox',
  onMessage: message => {
    console.log(message.sender, message.body)
  }
})
```

It also carries `requestedCertificates`, `sessionManager`,
`maxPendingAuthMessages`, and `onError`.

Four fields are excluded from the type. `wallet` and `originator` are owned by
the client, which always uses its own values. `managerOptions.autoConnect` is
excluded because the socket connects when it is created and `AuthSocketClient`
exposes no way to start one later, so disabling auto-connect could never
connect; the constructor throws if it is passed as `false`.

`managerOptions.retries` is also excluded: AuthSocket does not send the raw
Socket.IO acknowledgements that message retries require, so enabling retries
would block subsequent authentication and application messages. The constructor
rejects nonzero retries. Connection reconnection settings such as `reconnection`
and `reconnectionAttempts` remain supported.

`socketOptions` applies **only to the live socket path** — `initializeConnection()`,
`listenForLiveMessages()`, and `sendLiveMessage()`. It has no effect on
`sendMessage()`, `listMessages()`, or `acknowledgeMessage()`, which use
authenticated HTTP.

## Host selection and public-service access

An explicitly configured host must use HTTPS except on loopback (`localhost`,
`*.localhost`, `127.0.0.0/8`, or `[::1]`). It must be an exact absolute URL
without surrounding whitespace, credentials, a query, a fragment, or control
characters. Route prefixes are supported:

```ts
const messages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messaging.example.com/api'
})
```

Every Message Box HTTP response must be the result of successful BRC-103 mutual
authentication. The client rejects AuthFetch's ordinary-HTTP compatibility
fallback, requires a canonical curve-valid server identity, and keeps the first
authenticated identity for each origin authoritative for that client instance.
For durable independent trust, pin expected server identities by base URL:

```ts
const messages = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://messaging.example.com/api',
  serverIdentityKeysByHost: {
    'https://messaging.example.com': '02…'
  }
})
```

Pins are per URL origin, so two route prefixes on the same origin cannot name
different identities. Different overlay hosts may authenticate with different
identities. A server-key change requires creating a new client with an updated,
independently validated pin; it is never accepted silently within an instance.

Overlay advertisements are untrusted network input. Discovered destinations
must use public HTTPS addresses; loopback, private, link-local, reserved, and
documentation-only hosts are rejected before a request is made. If no valid
advertisement exists, the configured host is used. Each returned transaction,
output index, canonical PushDrop envelope, advertised identity, and signature is
bounded and independently verified against the requested identity. The lookup
provider therefore supplies candidates, not routing authority.

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
and construct the required payment before sending. The mutually authenticated
Message Box is authoritative for its own price, while the wallet remains the
final spending authority. Applications can add an independent ceiling with
`maximumPayment`; the client rejects a larger quote before requesting a wallet
action:

```ts
await messages.sendMessage({
  recipient,
  messageBox: 'notifications',
  body: { title: 'Bounded-cost alert' },
  checkPermissions: true,
  maximumPayment: 25
})
```

Quote rows must bind every requested recipient and message-box name exactly
once. Fees are bounded integers, blocked-recipient and status fields must agree,
and aggregate arithmetic must stay in the safe-integer domain. Before a payment
is transmitted, the client independently parses the wallet's Atomic BEEF and
requires every delivery and recipient output to retain its requested script,
amount, and remittance index. A custom wallet response is never treated as
payment evidence merely because it returned transaction bytes.

Outgoing recipients are canonical compressed public keys. Message-box names,
caller-supplied message IDs, and serialized bodies are exact and bounded; body
objects and request records must contain only plain own data. The client
captures the complete send authority before its first asynchronous operation,
so later caller mutation cannot change the recipient, message box, body, flags,
or payment ceiling. Server send results are accepted only when their recipient
and message ID match the submitted message.
Permission and device responses are also treated as untrusted protocol input:
records, canonical identity keys, fees, timestamps, masked tokens, platform
values, identifiers, and pagination arguments must match their bounded schema.

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
Its SDK peer accepts both historical `number[]` and binary Wallet Wire
`Uint8Array` transaction results, while payment messages retain a portable JSON
byte-array representation. Receipt remains compatible with pending messages
whose typed-array bytes were already serialized as contiguous numeric keys.
PeerPay receipt also accepts the canonical standard-base64 Atomic BEEF string
described by BRC-29. This receive-only compatibility applies to inbox lists,
indexed reloads, and live payments; senders keep the existing portable JSON
byte array. Empty, unpadded, URL-safe, whitespace-bearing, noncanonical pad-bit,
and malformed base64 strings are rejected before wallet work. Both encodings
retain the 64 MiB decoded transaction ceiling; base64 length is checked before
decoding. This does not raise relay request limits or provide delivery-limit
discovery, pre-broadcast sizing, or a durable retry/refund journal.
The same compatibility contract covers paid-message fees, batch delivery,
token settlements, live-message fallback, and generic remittance transport.
In a multi-recipient send, the quoted server delivery fee applies to every
allowed recipient. The client checks the aggregate against `maximumPayment`
and places it in the batch's single server remittance output.
Malformed, sparse, or out-of-range byte records are rejected before wallet
internalization and the source message remains available for retry or recovery.
Incoming-payment reads are capped at 1,000 messages and validate canonical
sender keys, transaction bytes, derivation metadata, positive integer amounts,
output indexes, and message IDs. Live callbacks apply the same validation.
`acceptPayment` and `rejectPayment` use the caller's message ID only, reload the
authenticated inbox, require one unique match, and use the fresh record for all
wallet, acknowledgement, and refund decisions.
Payment-request lists and live callbacks likewise require a canonical
body/envelope identity match, bounded fields, an unexpired request, and an
affirmative 32-byte HMAC proof. Replayed request IDs from one sender fail
closed. Fulfill and decline calls use only the selected message ID, reload the
authenticated inbox, and reject concurrent processing of that ID by the same
client instance. Response reads are bounded and preserve the authenticated
`sender` and `messageId`; always bind both `requestId` and `sender` to the
original request recipient.

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

The library does not assume a token-standard wire format. Adapters own the
standard-specific construction, acceptance, termination, and receipt data for
their protocol, while the client enforces common authority boundaries:
canonical peer keys, bounded transaction/message fields, canonical positive
integer amounts, exact adapter action verdicts, and unchanged requested
protocol/asset/amount fields. Incoming reads are capped at 1,000 records.
`acceptToken()` uses only the supplied message ID, reloads the authenticated
inbox, requires one unique fresh match, and acknowledges only after the adapter
returns the literal `accept` action. An acknowledgement outage after accepted
custody is recoverable and does not turn the result into a truthy error string.
Token requests apply the same bounded authenticated-envelope model. Live and
listed requests require a canonical body/envelope sender match, an unexpired
bounded schema, and an affirmative 32-byte HMAC proof. Fulfillment and decline
operations reload the inbox by message ID and use only the unique fresh request;
fulfillment also requires the selected source's protocol and asset to match it.
Outgoing requests, cancellations, and response listings validate and bound all
common fields before wallet or transport work. One client instance rejects
concurrent fulfill/decline processing for the same token-request message.

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

TS Stack first-party material is under the [Open BSV License Version 6](./LICENSE.txt).
The UMD bundle incorporates separately licensed SDK material; keep
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSES/](./LICENSES/)
with the bundle.

## Payment acceptance and acknowledgment ordering

`acknowledgeNotification` checks the original notification envelope, internalizes
a present recipient payment with the configured originator, and acknowledges
only after the wallet returns `accepted: true`. A notification without a
payment can be acknowledged immediately. Failures, incomplete envelopes and payments with no wallet-payment outputs
remain queued. Its boolean return contract is unchanged: `false` can
mean no payment or a retained failed payment.

Incoming payment envelopes accept Atomic BEEF up to 32 MiB and at most 101
payment outputs, matching the existing 100-recipient batch plus delivery-fee
output contract. The client snapshots those fields independently so a valid
large transaction is not rejected by the smaller generic JSON-graph limit;
sparse arrays, accessors, non-byte values, and oversized fields still fail
closed before wallet work.

`acceptPayment` also requires affirmative wallet acceptance before acknowledgment;
validation and internalization failures reject instead of returning a truthy
error string. An acknowledgement failure after accepted custody is recoverable
and does not change the successful result.
For refundable amounts, `rejectPayment` internalizes first, sends the refund,
and then acknowledges. A failed internalization prevents both refund and
acknowledgment; a failed refund send leaves the message queued. The existing
small-payment policy is unchanged.

This is the initial ordering remediation for [issue #503](https://github.com/bsv-blockchain/ts-stack/issues/503).
It does not provide a durable refund journal or exactly-once delivery. Reconcile
uncertain refund-send outcomes before retrying, since a send may have completed
before its response was lost. Payment-envelope retention and outcome reporting
through `listMessages`/`listMessagesLite`, basket-insertion policy, and resumable
refund semantics remain open. Use the original envelope for notification payment
processing; a plain acknowledgment is not evidence that a payment was accepted.

Payment- and token-request fulfillment also cannot provide cross-process or
cross-crash exactly-once settlement with the current protocol. If settlement
succeeds but its response fails or is lost, the request remains queued and an
automatic retry can pay twice. Do not retry an uncertain fulfillment until the
wallet and peer have been reconciled. Persist each authenticated request ID and
sender together with every attempted or completed settlement transaction ID.
Before fulfilling or retrying, reject a transaction ID already associated with
a different request and reject a different transaction ID for a request whose
outcome has not been reconciled. Apply the same durable correlation in every
service process; in-memory serialization is not cross-process replay
protection.
