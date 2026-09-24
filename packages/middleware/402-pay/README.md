# @bsv/402-pay

[BRC-121](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0121.md) Simple 402 Payments -- server middleware and client for BSV micropayments over HTTP.

## Protocol boundary

This package implements the BRC-121 `x-bsv-beef`/sender/nonce/time/vout contract.
BRC-118 extends the separate authenticated BRC-105 payment path in SDK AuthFetch
and `@bsv/payment-express-middleware`; it is not implicitly negotiated here.
See the [BRC-118 guide](../../../docs/guides/brc118-payments.md) when selecting an
integration. Existing 402-pay wire behavior is unchanged.

## Install

```sh
npm install @bsv/402-pay
```

Peer dependency: `@bsv/sdk ^2.1.6`. The package supports Node.js 22+ and browser
consumers, with matching ESM and CommonJS entry points and declarations for the
package root, `/server`, and `/client`.

## Server

### Express middleware

```ts
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'

const app = express()

app.use(
  '/articles/:slug',
  createPaymentMiddleware({
    wallet, // WalletInterface from @bsv/sdk
    // Required in production when more than one process can serve this route.
    replayStore: sharedAtomicReplayStore,
    calculatePrice: path => {
      // Return price in satoshis, or undefined to skip payment
      return 100
    }
  })
)

app.get('/articles/:slug', (req, res) => {
  // req.payment is set if payment was accepted
  res.send('Paid content here')
})
```

### Low-level validation

```ts
import { validatePayment, send402 } from '@bsv/402-pay/server'

// In any HTTP handler:
const requiredSatoshis = 100
const result = await validatePayment(req, wallet, requiredSatoshis, 30_000, sharedAtomicReplayStore)
if (!result) {
  send402(res, serverIdentityKey, requiredSatoshis)
  return
}
if (!result.accepted) {
  // Explicit replay rejection. Log safely and request a fresh payment.
  send402(res, serverIdentityKey, requiredSatoshis)
  return
}
// Payment accepted — serve content
```

## Client

### Fetch wrapper

```ts
import { create402Fetch } from '@bsv/402-pay/client'

const fetch402 = create402Fetch({ wallet })

// Automatically handles 402 responses with payment
const response = await fetch402('https://example.com/articles/foo')
const html = await response.text()

// Clear the optional payment cache
fetch402.clearCache()
```

Paid-response caching is disabled by default because a URL alone is not an
authorization or browser-session boundary. Opt in only for immutable,
non-user-specific content with `cacheTimeoutMs`; request credentials and header
values are hashed into the cache key, binary responses are preserved, and
`maxCachedResponseBytes` defaults to 8 MiB. Cookie state cannot be keyed safely,
so do not enable this cache for cookie-authenticated personalized responses.
Non-GET requests are never cached.

## Headers

### Server → Client

| Header         | Description                |
| -------------- | -------------------------- |
| `x-bsv-sats`   | Required satoshi amount    |
| `x-bsv-server` | Server identity public key |

### Client → Server

| Header         | Description                      |
| -------------- | -------------------------------- |
| `x-bsv-beef`   | Base64-encoded BEEF transaction  |
| `x-bsv-sender` | Client identity public key       |
| `x-bsv-nonce`  | Base64-encoded derivation prefix |
| `x-bsv-time`   | Unix millisecond timestamp       |
| `x-bsv-vout`   | Payment output index             |

## Security and Replay Protection

Replay defense has three layers:

1. **Timestamp freshness** -- `x-bsv-time` must be within 30 seconds of the server's clock, bounding the replay window and replay-record lifetime.
2. **Wallet validation** -- `internalizeAction` validates the BRC-29 remittance. Wallets that expose an exact `isMerge` value provide an additional duplicate signal, but that field is not part of the public BRC-100 result contract and is not the sole replay defense.
3. **Atomic transaction claim** -- an independent `PaymentReplayStore` permits exactly one successful claim for a transaction ID. The default store is bounded and process-local. Multi-process or multi-node services must inject one shared, durable, atomic store.

Low-level `validatePayment` calls without an explicit store reuse a process-local
store keyed to the supplied wallet object. Keep that wallet object stable for
the life of the service. Passing a new wrapper per request defeats that local
association; shared deployments must pass the same external replay store to
every call.

Servers should synchronize their clocks, treat payment headers as untrusted
input, retain normal request-rate/body limits around the middleware, and avoid
logging raw BEEF, identity material, request paths, or transaction identifiers.
The middleware emits no diagnostics unless an explicit structured logger is
supplied, and its wallet descriptions do not include attacker-controlled URLs.
Duplicate and oversized BEEF headers are rejected before wallet work. Clients require HTTPS except for exact loopback
development URLs, validate the server key before invoking the wallet, refuse
cross-origin redirect challenges, and retransmit payment headers with automatic
redirect following disabled so financial material is never forwarded to a
redirect target.

For browser clients, configure the service or edge layer to expose
`x-bsv-sats` and `x-bsv-server` and to allow the five client payment headers.
The package intentionally does not set an origin policy: public services can
remain broadly accessible, while deployments that need an allowlist can apply
one without changing payment behavior.

Wallet initialization and invalid server pricing are treated as server errors
(`500`). An unexpected failure after payment processing begins returns `503`
without a fresh challenge, because wallet or replay-store state may already
have changed and requesting another payment could induce a second spend.
Malformed, invalid, insufficient, or affirmatively replayed payments receive a
fresh `402`, as required by BRC-121. Successful middleware results preserve the
actual paid output value, including overpayment, in `satoshisPaid`.

The server requires a strictly framed BRC-95 Atomic BEEF envelope. It prices
the transaction named by the atomic subject and gives the wallet only that
transaction and its dependency closure. Legacy atomic envelopes containing
unrelated branches are reduced to that closure; plain BEEF, trailing bytes,
and a non-affirmative wallet internalization result are rejected.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under its package-specific Open BSV License Version 4 grant. Redistributors
must preserve [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the
applicable text in [`LICENSES/`](./LICENSES/).
