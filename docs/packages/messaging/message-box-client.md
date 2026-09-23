---
id: pkg-message-box-client
title: '@bsv/message-box-client'
kind: package
domain: messaging
version: '2.5.3'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/message-box-client'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client'
status: stable
tags: [messaging, message-box, brc-103, brc-29]
---

# @bsv/message-box-client

> Browser- and Node-compatible authenticated store-and-forward messaging,
> live WebSockets, peer payments, token settlement, permissions, quotes, and
> push-device registration.

The 2.5.3 source candidate fixes the CommonJS build (`new MessageBoxClient()` failed with `LookupResolver.default is not a constructor` under `require()`). `sendMessage()` HTTP failures now append the server's well-formed failure code, for example `Message Box send failed with HTTP 400 (ERR_DUPLICATE_MESSAGE).`; free-text server descriptions are never copied into errors.

## Install

```bash
npm install @bsv/message-box-client @bsv/sdk
```

`@bsv/sdk` is a required peer. Node.js 22 or newer is supported.
Use SDK 2.4.1 or newer so BRC-29 sends accept both historical `number[]` and
binary Wallet Wire `Uint8Array` transaction results. Payment receipt also
recovers pending typed-array tokens serialized through JSON as numeric-key
objects.

## Quick start

```ts
import { MessageBoxClient } from '@bsv/message-box-client'
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient()
const client = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://message-box-us-1.bsvb.tech'
})

await client.sendMessage({
  recipient: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366',
  messageBox: 'general_inbox',
  body: { text: 'Hello' }
})

const messages = await client.listMessages({ messageBox: 'general_inbox' })
await client.acknowledgeMessage({
  messageIds: messages.map(message => message.messageId)
})
```

Initialization is automatic. Call `init()` only when explicit startup control
is useful.

## What it provides

- `MessageBoxClient` — authenticated HTTP polling and live WebSocket delivery,
  with selectable socket transports
- encryption through the BRC-100 wallet protocol, enabled by default
- overlay host advertisement and public-HTTPS discovery
- sender-specific and box-wide permissions with fee quotes
- Firebase push-device registration
- `PeerPayClient` — BRC-29 payments, requests, responses, and refunds
- `PeerTokenClient` — token transport through pluggable settlement adapters
- `RemittanceAdapter` — SDK remittance communication integration

## Security and interoperability

Configured hosts require HTTPS except on loopback and must be exact absolute
URLs without whitespace, credentials, query strings, fragments, or control
characters. Every HTTP result must carry a canonical server identity proven by
BRC-103 mutual authentication; ordinary AuthFetch fallback is rejected. The
first authenticated identity remains authoritative per origin for the client
instance, or applications can supply durable, independently validated
`serverIdentityKeysByHost` pins.

Untrusted overlay destinations require public HTTPS and cannot target local,
private, link-local, reserved, or documentation-only hosts. Returned BEEF,
output indexes, canonical PushDrop fields, the requested identity, and the
advertisement signature are independently bounded and verified. A lookup
provider proposes routing candidates but is not itself routing authority.

The client snapshots outgoing send authority before its first asynchronous
operation. Recipients must be canonical public keys; message-box names,
caller-supplied IDs, bodies, recipient arrays, and JSON object graphs are
bounded and accessor-free. Authenticated send results must correlate their
recipient and message ID to the request.

Delivery quotes are untrusted financial input even though their transport is
authenticated. Each requested recipient and message-box name must appear
exactly once, fee/status/block fields must agree, and only bounded safe-integer
amounts enter arithmetic. `maximumPayment` is an optional independent ceiling
for `sendMessage` and shared plaintext batches. Before returning a payment
envelope, the client parses the wallet's Atomic BEEF and binds every requested
script and satoshi amount at the exact remittance output index. The Message Box
states its price; the wallet remains the final spending authority.

Message Box remains accessible from arbitrary deployed browser origins by
default. Server-side exact-origin allowlists or disabled CORS are operator
opt-ins. CORS and CSP do not replace BRC-103 identity authentication,
recipient-owned boxes, permissions, payment checks, quotas, or end-to-end
message encryption.

## Distribution and verification

The package publishes ESM, CommonJS, declarations, source maps, and a UMD
browser bundle. Exact-tarball validation exercises clean ESM/CommonJS
consumers, strict declaration resolution, `publint`, browser bundling through
Vite and esbuild, and bundle budgets. Source and tests are not published.

## Related

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client#readme)
- [Message Box HTTP API](../../specs/message-box-http.md)
- [Peer-to-peer messaging guide](../../guides/peer-to-peer-messaging.md)
- [Message Box Server](../../infrastructure/message-box-server.md)
- [npm](https://www.npmjs.com/package/@bsv/message-box-client)

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

`acceptPayment` also requires affirmative wallet acceptance before acknowledgment.
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

Payment and token request fulfillment is not cross-process or cross-crash
exactly once. Persist each authenticated request ID and sender together with
every attempted or completed settlement transaction ID. Before fulfillment or
retry, reject a transaction ID already associated with a different request and
reject a different transaction ID for a request whose outcome is still
uncertain. Reconcile the wallet and peer first; in-memory serialization does
not prevent another service process from replaying the same request.
