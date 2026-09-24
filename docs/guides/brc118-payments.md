---
id: guide-brc118-payments
title: 'BRC-118 Authenticated Multipart Payments'
kind: guide
version: '1.0.0'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
review_cadence_days: 30
status: beta
tags: [guide, payments, authentication, brc-105, brc-118]
---

# BRC-118 authenticated multipart payments

BRC-118 carries a BRC-105 payment in an authenticated multipart request when
the payment BEEF would exceed a header budget. Small payments continue to use
`x-bsv-payment`. Deploy receiver support before enabling multipart clients.
The SDK, auth middleware and payment middleware must all support this profile.

## Enable the receiver

Install raw-byte authentication before any body parser. The middleware verifies
the complete transmitted body and the exact multipart Content-Type, including
its boundary, before extracting payment or application data.

```ts
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import type { WalletInterface } from '@bsv/sdk'

export function paidApp(wallet: WalletInterface) {
  const app = express()
  app.use(createAuthMiddleware({ wallet, captureRawBody: true }))
  app.use(
    createPaymentMiddleware({
      wallet,
      enableMultipart: true,
      calculateRequestPrice: () => 1
    })
  )
  app.post('/paid', (req, res) => res.json({ received: req.body }))
  return app
}
```

`captureRawBody` and `enableMultipart` are opt-in. A verified 402 advertises
`x-bsv-payment-transports: header,multipart` only when both are active. With
either absent, the payment middleware advertises header support only. An older
server with no advertisement is also treated as header-only.

The existing amount, BRC-29 derivation, BEEF validation, wallet internalization
and transaction-ID replay checks apply to either transport. Configure a shared,
durable atomic replay store across server processes; the default store is
bounded and process-local. A wallet exception retains the released 400 `ERR_PAYMENT_FAILED` response; a
replay-store failure returns 503. Neither proves that wallet work was rolled
back, and neither carries a new payment challenge. Reconcile the submitted
transaction before paying again. Payment transport is not durable result redelivery.

## Preserve application bytes

The wrapper contains one JSON `x-bsv-payment` part and at most one `body` part.
The latter holds the original bytes and media type. The route receives the
inner Content-Type and `req.rawBody`; `req.body` is decoded for JSON, text and
URL-encoded media types, and remains bytes for binary or nested multipart data.
JSON whitespace and UTF-8 bytes survive in `rawBody`. An empty part is distinct
from an absent part. The route never receives the outer payment in its body.

Boundaries may be quoted or unquoted, but must be a single 1–70 character MIME
token. Framing uses CRLF. Duplicate parts or part headers, conflicting header
and body payments, unexpected paid-wrapper parts, unsupported part headers,
truncation and epilogues are rejected. An original multipart application payload
is an opaque inner body, not recursively parsed. Its initial unpaid request must
fit the receiver's bounded multipart profile (at most 128 parts, ASCII part
headers); applications needing a broader upload format should use a separate
upload route and pay for its resulting resource.

Existing nonempty non-multipart signature preimages retain their released normalization.
Empty byte requests now consistently use BRC-104's `-1` sentinel in AuthFetch
and auth middleware, including the existing `express.raw` integration without
raw capture. SDK clients and auth receivers that previously signed/reconstructed
length `0` for empty byte arrays must adopt SDK 2.9.0 and auth middleware 2.3.0
together for those requests. This correction does not change nonempty bodies or
multipart payload-part bytes; an empty multipart payload part remains distinct
from a missing part.
Multipart authenticates the exact Content-Type value. There is no second,
weaker verification attempt with the boundary removed.

## Prepare a payment before broadcasting

`AuthFetch` snapshots the original request, creates a payment with
`noSend: true`, validates its actual Atomic BEEF/output and serializes the final
authenticated request before submitting it with `sendWith`. The wallet must
honor the BRC-100 prepare/submit contract and implement `abortAction`; wallets
that cannot do so must not use this automatic payment path. There is no fallback
to creating and immediately broadcasting a replacement transaction.

```ts
import { AuthFetch, WalletClient } from '@bsv/sdk'

const client = new AuthFetch(new WalletClient())
const response = await client.fetch('https://example.com/paid', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: '{ "message": "hello" }',
  paymentTransport: { maxPaymentHeaderBytes: 4096 },
  signal: new AbortController().signal
})
```

Small payments use a header when advertised. Larger payments require multipart
support. The original method, URL and query are preserved. Fetch forbids bodies
on GET/HEAD, so payments that require multipart on those methods fail before
broadcast; choose a server-supported POST route explicitly. Oversized
header-only attempts are refused, rather than relying on the standard's
recommended header fallback to deliver an already broadcast payment.

Pass replayable, owned bytes for binary and original multipart bodies. Serialize
native FormData once with a Request, retain its generated Content-Type and read
its arrayBuffer before calling AuthFetch. Text-only FormData retains the legacy
URL-encoded behavior; file-bearing FormData and streams are rejected instead of
silently dropping files or changing signed bytes.

Transport changes and bounded delivery retries reuse the same transaction.
A changed amount, derivation prefix or authenticated recipient stops automatic
payment and requires reconciliation. Prepared reservations are aborted on
refusal or cancellation where the wallet allows it. Once submission starts, a
lost acknowledgement is uncertain: it is not safe to abort or create another
payment automatically. Cancellation stops waiting and pending listeners;
already dispatched network or wallet work can still complete.

`PaymentTransportError` has a permanent `code`, `retryable: false` and, when
available, a payment transaction ID and `prepared`, `submitted` or `uncertain`
state. A prepared refusal can additionally report `aborted`. HTTP 413/431 errors
are terminal and distinguish authenticated server replies from unsigned proxy
failures through `authenticated` and `httpStatus`. Reconcile uncertain outcomes
using the wallet and service before starting a new payment. No durable refund or
paid-result journal is implied.

## Bound resource use and expose negotiation to browsers

| Bound                                              | Default                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| SDK payment header selection                       | 8,192 bytes                                    |
| SDK aggregate request headers                      | 16 KiB, including a 4 KiB auth/framing reserve |
| SDK and payment middleware payment JSON            | 4 MiB                                          |
| SDK and payment middleware complete body           | 7 MiB                                          |
| Auth middleware complete request encoding          | 8 MiB                                          |
| Raw receiver retained bodies                       | 64 MiB aggregate per middleware instance       |
| Raw receiver pending requests / collection timeout | 1,000 / 30 seconds                             |
| Multipart part headers                             | 2,048 bytes per part                           |

These are bounds, not promises about an intermediary. Set lower client budgets
for a known proxy, and align proxy, auth and payment middleware limits. The raw
collector rejects compressed bodies, malformed lengths, premature disconnects,
slow input, exhausted capacity and oversized streams before authentication.
Body collection cannot be disabled or made unbounded in raw mode. Multipart
removes header pressure, not body limits.

Keep the service's credential-free cross-origin access policy. Handle OPTIONS
before authentication, allow the request Content-Type and `x-bsv-auth-*`/
`x-bsv-payment` headers, and expose the existing authentication response headers
plus `x-bsv-payment-transports`, `x-bsv-payment-version`,
`x-bsv-payment-satoshis-required`, `x-bsv-payment-derivation-prefix` and the optional
`x-bsv-payment-known-txids`. Multipart requires no credentialed browser mode or
new origin allowlist. Use explicit names in CORS libraries that do not support
header-prefix matching.

## Compatibility and evidence

The profile pins BRC-104/105/118 at BRCs revision
[`2b959b13f1f73040d13cc4eb14edbfc376f8010b`](https://github.com/bsv-blockchain/BRCs/tree/2b959b13f1f73040d13cc4eb14edbfc376f8010b).
Six shared wire/preimage fixtures under `conformance/vectors/payments/brc118.json`
are independently generated and read by Python's standard-library MIME parser.
The SDK writer, auth verifier and payment parser check the same fixtures. Run
`python3 conformance/runner/scripts/brc118-vectors.py` to verify the independent
oracle. Composed HTTP tests use two independent wallet identities, real mutual
authentication and enforced proxy header/body limits; they do not spend funds.

External implementation availability is not an interoperability claim. The
reviewed [Python implementation](https://github.com/Calgooon/codex-x402/tree/2f9f89b7769bb05a3dc81c9e287e16f925773f5b)
has a multipart writer but strips Content-Type parameters in its signing path
and omits empty body parts. Its complete authenticated path therefore does not
match these boundary-binding vectors. No live Rust/Workers peer or external
owner sign-off is claimed.

`@bsv/402-pay` implements the separate BRC-121 header protocol
(`x-bsv-beef`, sender, nonce, time and vout); it does not use BRC-105 AuthFetch
negotiation. Its [guide](./http-402-payments.md) and wire contract remain separate.
PeerPay MessageBox receive compatibility likewise does not increase a relay's
encrypted-envelope limit or make an already broadcast oversized message safe.

The native Chromium gate exercises credential-free cross-origin preflights,
large binary and exact-JSON payments, and a header-only server. Hiding the signed
negotiation header through CORS invalidates the response signature before any
payment preparation; expose the complete signed response header set.

Published SDK 2.8.0 was also tested in the same native-browser fixture against
both new receiver configurations (multipart enabled and disabled). Its small
header payment is accepted once with the exact application body. This uses the
registry tarball after SHA-512 integrity verification, independently from the
workspace SDK build. To repeat the additional historical-client probe, extract
that verified package and point `BRC118_LEGACY_SDK_MODULE` at its
`dist/esm/mod.js` when running the payment package's `test:browser`; the complete
current-client gate still runs first. This does not claim that a legacy client
can send payments above the legacy header limit.
