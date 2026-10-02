# CHANGELOG for `@bsv/message-box-client`

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [2.1.1 - 2026-04-24](#211---2026-04-24)
- [2.1.0 - 2026-04-20](#210---2026-04-20)
- [2.0.7 - 2026-04-08](#207---2026-04-08)
- [2.0.0 - 2026-02-06](#200---2026-02-06)
- [Template for New Releases](#template-for-new-releases)

## [Unreleased]

### 2.6.0 candidate — live socket reconnection, room restoration and reported status

- **New: `onLiveStatus(listener)`.** Reports what the live socket is doing:
  `connecting`, `live` with the rooms joined on it, `reconnecting` after a drop
  something will recover from, or `closed` with nothing coming. Returns an
  unsubscribe function and calls the listener once immediately with the current
  status; `liveStatus` reads it without subscribing. A consumer previously had
  to send a message to find out, which is why one downstream package kept a
  self-addressed ping purely to manufacture that traffic. A listener that throws
  is reported and does not stop the others. The status describes the socket
  only: `listMessages` polling stays required for correctness whatever it says.

- Keep a socket Socket.IO is still reconnecting. A transient `disconnect` used
  to drop the client's reference without closing the socket, leaving an orphan
  that kept reconnecting, re-sent `authenticated` down whichever socket had
  replaced it, and cleared that healthy socket on its own next drop. Every
  handler is now bound to the socket it belongs to.
- Track rooms the consumer asked for separately from rooms joined on the
  current socket, and re-emit them after each `authenticationSuccess` — not on
  `connect`, because the server refuses joins from an unauthenticated socket.
  Membership is cleared on a drop, since it belongs to the server-side socket
  that joined.
- Rebuild after `io server disconnect`, which Socket.IO never retries, so a
  subscriber that makes no calls of its own recovers. Only a socket that
  authenticated is rebuilt, so a server refusing authentication is not retried
  in a loop. The first rebuild is immediate and each further one doubles from
  one second to a thirty-second cap. The count resets once a socket holds its
  authentication for as long as the next delay would have been, so a relay that
  drops its sockets a little after that window still gets an immediate rebuild
  each time; the backoff bites when drops come faster than the current delay.
  `disconnectWebSocket` cancels a rebuild in flight.
- Read `socketOptions.managerOptions.reconnection` and honour `false` by
  disposing on a drop. Nothing rebuilds on its own under that setting, which is
  the host's choice and is documented on the option.
- `leaveRoom` releases its room before the connected guard, so leaving while
  disconnected no longer leaves a claim that the next connection rejoins.
  `disconnectWebSocket` clears rooms and handlers, as deliberate teardown.
- `getJoinedRooms()` reports the rooms joined on the current socket. Mutating
  the returned set no longer cancels a rejoin; use `leaveRoom`.
- Read the server's answer to a join. `joinedRoom` and `joinFailed` have always
  been emitted and were never listened for, so a refused join left the client
  certain it was subscribed to a room it had never been given. The record is
  still made optimistically on emit, so a server that answers nothing behaves
  exactly as before. **Correcting it needs a server that names the room on
  `joinFailed`**, which is new alongside this release: without a room the event
  cannot be attributed to any of the joins that may be in flight, and it is
  logged and otherwise ignored.
- One live-message listener per room per socket, reading its subscribers at
  delivery time. `leaveRoom` followed by another `listenForLiveMessages` used
  to attach a second listener — there is no `off` — and every message after
  that arrived twice for the life of the socket. A message is decrypted once
  however many subscribers a room has, and a subscriber that throws no longer
  costs the rest of the room its message.
- One acknowledgement listener per room, with sends queued behind it. Each
  `sendLiveMessage` used to attach its own and rely on an `off` the socket
  wrapper does not have, so they accumulated for the life of the socket and
  every acknowledgement walked all of them. A refusal carries no `messageId`,
  so the oldest send in flight still takes the acknowledgement, as before.
- **A live message is delivered a tick after it arrives.** It already was for
  an encrypted message; now it always is, because the body is read before any
  subscriber is called. A consumer asserting synchronous delivery in a test
  needs to let the microtask run.

### 2.5.4 candidate — require the BRC-29 acceptance fix

- Raise the `@bsv/sdk` peer floor from `^2.8.0` to `^2.8.6`. SDK 2.8.0 through
  2.8.5 derive the wrong recipient key in `Brc29RemittanceModule.acceptSettlement`,
  so `PeerPayClient.acceptPayment()` and `rejectPayment()` fail for every valid
  incoming payment. No source change; SDK 2.8.6 fixes acceptance.

### 2.5.3 candidate — CommonJS SDK interop and send failure codes

- Fix the CommonJS build so `new MessageBoxClient()` no longer fails with
  `LookupResolver.default is not a constructor`; SDK classes are imported by
  name from the SDK barrels.
- `sendMessage()` HTTP failures now include the server's well-formed failure
  code, for example `Message Box send failed with HTTP 400
(ERR_DUPLICATE_MESSAGE).`, so callers can recognise an already-delivered
  message. Free-text server descriptions are still never copied into errors.
- Raise the `@bsv/sdk` peer floor to `^2.8.0`. The package already required
  SDK modules that first shipped in 2.8.0, so earlier 2.x SDKs never loaded it.

### 2.5.2 candidate — authenticated transport and payment hardening

- Internalize notification payments with the configured originator before acknowledgment.
- Require affirmative wallet acceptance in notification and PeerPay paths.
- For refundable payments, internalize, send the refund, then acknowledge.
- Keep issue #503 open for envelope/outcome handling and durable refund semantics.

### Added

- Added an optional `socketOptions` client option, forwarded to
  `AuthSocketClient` when the live socket is created. It carries the
  `AuthSocketClient` options other than `wallet` and `originator`, which the
  client owns, so callers can select Socket.IO transports (for example
  `{ managerOptions: { transports: ['websocket'] } }`) to reach deployments that
  do not carry Engine.IO's HTTP polling transport, and can also supply
  `requestedCertificates`, `sessionManager`, `maxPendingAuthMessages`, and
  `onError`. `managerOptions.autoConnect` is excluded and `false` is rejected:
  the socket is started when it is created, so disabling auto-connect could
  never connect. `managerOptions.retries` is excluded and nonzero values are
  rejected because AuthSocket does not send the Socket.IO acknowledgements
  needed to advance its message retry queue. Connection reconnection options
  remain supported.
  Nothing is forwarded when unset, so default transport negotiation and all HTTP
  code paths are unchanged.

- Added the `teratestnet` overlay preset. TTN clients must provide an explicit
  Message Box host until a dedicated TTN deployment is available, preventing
  accidental use of the existing testnet staging service.

### Changed

- Rebuild the UMD bundle with SDK 2.5.0 support for the optional
  `x-bsv-payment-known-txids` payment-ancestry extension. Compatible wallets can
  omit recipient-declared known ancestors from payment BEEF; absent headers
  preserve existing behavior. No consumer migration is required, and module
  consumers can enable the same extension with SDK 2.5.0 or later.

### Deprecated

### Removed

### Fixed

- Require the SDK patch that accepts binary Wallet Wire `Uint8Array`
  transaction results in BRC-29 payment construction, and rebuild the browser
  bundle with that correction. Historical `number[]` wallet results remain
  unchanged. PeerPay receipt also recovers the numeric-key object produced when
  a typed array crosses JSON transport, preserving pending cross-version
  payments.
- Normalize and validate BRC-100 transaction bytes at every Message Box JSON
  boundary: PeerPay, token settlements, paid-message delivery, batch delivery,
  remittance adaptation, live fallback, and receipt. Current typed-array,
  historical number-array, and numeric-key JSON representations now converge
  before wallet or adapter dispatch; malformed bytes are never acknowledged.

### Security

- Require every Message Box HTTP response to remain BRC-103 mutually
  authenticated, pin one curve-valid server identity per origin, restrict
  plaintext HTTP to loopback, and support independently provisioned durable
  `serverIdentityKeysByHost` pins.
- Validate and bound overlay advertisements, PushDrop envelopes, BEEF,
  identities, room, box, message, device, permission, and token values before
  wallet or application use.
- Snapshot outgoing send authority, bind quote and send rows to exact
  recipients and message IDs, enforce safe-integer fees and optional
  `maximumPayment` ceilings, and verify that returned Atomic BEEF preserves
  every requested script, amount, and remittance index.
- Make client diagnostics opt-in and event-only so wallet, message, payment,
  host, identity, token, transaction, and response data are not logged.

---

## [2.1.1] - 2026-04-24

### Changed

- Updated the default MessageBox host to `https://message-box-us-1.bsvb.tech`.
- Updated documentation and tests to stop referring to legacy hosted endpoints as defaults.

---

## [2.1.0] - 2026-04-20

### Changed

- `init()` no longer automatically calls `anointHost()`. Applications that want to advertise their host on the overlay network must now call `anointHost()` explicitly. The client still initializes correctly and all send/receive/acknowledge operations work without anointing.
- `sendLiveMessage()` HTTP fallback paths now pass the caller's `overrideHost` through to `sendMessage()` rather than independently resolving the recipient's host. Behavior is equivalent for most callers; the change ensures explicit host overrides are respected end-to-end through fallback paths.

### Security

- Removed automatic overlay advertisement broadcast on client initialization, giving applications explicit control over when their host identity is published to the network.

---

## [2.0.7] - 2026-04-08

### Added

- Payment request methods on PeerPayClient:
  - `requestPayment()` — send a payment request with HMAC-based authorization proof
  - `cancelPaymentRequest()` — cancel a pending request (requires original requestProof)
  - `listIncomingPaymentRequests()` — list requests with HMAC verification, expiry, cancellation, and amount filtering (defaults: min 1000, max 10M sats)
  - `fulfillPaymentRequest()` — pay a request and send status response
  - `declinePaymentRequest()` — decline a request with optional note
  - `listPaymentRequestResponses()` — list responses to outgoing requests
  - `listenForLivePaymentRequests()` — WebSocket listener for incoming requests
  - `listenForLivePaymentRequestResponses()` — WebSocket listener for responses
- Permission management for payment requests:
  - `allowPaymentRequestsFrom()` — whitelist an identity
  - `blockPaymentRequestsFrom()` — block an identity
  - `listPaymentRequestPermissions()` — list whitelisted/blocked identities
- New message box constants: `PAYMENT_REQUESTS_MESSAGEBOX`, `PAYMENT_REQUEST_RESPONSES_MESSAGEBOX`
- New types: `PaymentRequestMessage` (discriminated union), `PaymentRequestResponse`, `IncomingPaymentRequest`, `PaymentRequestLimits`
- Default limit constants: `DEFAULT_PAYMENT_REQUEST_MIN_AMOUNT`, `DEFAULT_PAYMENT_REQUEST_MAX_AMOUNT`
- Unit and integration tests for all payment request methods

### Security

- Payment request cancellations are now authorized via HMAC proof — only the original sender can cancel a request
- Malformed message bodies are validated and discarded instead of silently becoming ghost entries
- Cancellation sender verification prevents cross-sender cancellation spoofing

---

## [2.0.1] - 2026-02-16

### Changed

- Promise.all()!!

## [2.0.0] - 2026-02-06

### Changed

- Updated `@bsv/sdk` dependency to v2.0.0

---

### Template for New Releases

Replace `X.X.X` with the new version number and `YYYY-MM-DD` with the release date:

```
## [X.X.X] - YYYY-MM-DD

### Added
-

### Changed
-

### Deprecated
-

### Removed
-

### Fixed
-

### Security
-
```

Use this template as the starting point for each new version. Always update the "Unreleased" section with changes as they're implemented, and then move them under the new version header when that version is released.
