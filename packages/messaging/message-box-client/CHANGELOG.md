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

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

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
