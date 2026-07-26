# @bsv/402-pay

[BRC-121](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0121.md) Simple 402 Payments -- server middleware and client for BSV micropayments over HTTP.

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

app.use('/articles/:slug', createPaymentMiddleware({
  wallet,  // WalletInterface from @bsv/sdk
  calculatePrice: (path) => {
    // Return price in satoshis, or undefined to skip payment
    return 100
  }
}))

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
const result = await validatePayment(req, wallet, requiredSatoshis)
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

// Clear the payment cache
fetch402.clearCache()
```

The default paid-response cache lifetime is 30 minutes. Set
`cacheTimeoutMs` explicitly when the content or authorization lifetime is
shorter. Only successful paid `GET` responses are cached; non-GET requests are
always sent to the service.

## Headers

### Server → Client

| Header | Description |
|---|---|
| `x-bsv-sats` | Required satoshi amount |
| `x-bsv-server` | Server identity public key |

### Client → Server

| Header | Description |
|---|---|
| `x-bsv-beef` | Base64-encoded BEEF transaction |
| `x-bsv-sender` | Client identity public key |
| `x-bsv-nonce` | Base64-encoded derivation prefix |
| `x-bsv-time` | Unix millisecond timestamp |
| `x-bsv-vout` | Payment output index |

## Security and Replay Protection

Two mechanisms prevent replay attacks:

1. **Timestamp freshness** -- `x-bsv-time` must be within 30 seconds of the server's clock
2. **Transaction uniqueness** -- `internalizeAction` returns `isMerge: true` for previously seen transactions

Servers should synchronize their clocks, treat payment headers as untrusted
input, retain normal request-rate/body limits around the middleware, and avoid
logging raw BEEF or identity material. Clients pay the origin derived from the
requested URL and should only call trusted HTTPS services.

For browser clients, configure the service or edge layer to expose
`x-bsv-sats` and `x-bsv-server` and to allow the five client payment headers.
The package intentionally does not set an origin policy: public services can
remain broadly accessible, while deployments that need an allowlist can apply
one without changing payment behavior.

Wallet initialization and invalid server pricing are treated as server errors
(`500`). Malformed, invalid, insufficient, or replayed payments receive a fresh
`402`, as required by BRC-121.

## License

Open BSV License Version 6. See [LICENSE.txt](./LICENSE.txt).
