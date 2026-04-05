# @bsv/402-pay

[BRC-121](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0121.md) Simple 402 Payments -- server middleware and client for BSV micropayments over HTTP.

## Install

```sh
npm install @bsv/402-pay
```

Peer dependency: `@bsv/sdk >= 2.0.0`

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
const result = await validatePayment(req, wallet)
if (!result) {
  send402(res, serverIdentityKey, 100)
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

## Headers

| Header | Direction | Description |
|---|---|---|
| `x-bsv-sats` | Server → Client | Required satoshi amount |
| `x-bsv-server` | Server → Client | Server identity public key |
| `x-bsv-beef` | Client → Server | Base64-encoded BEEF transaction |
| `x-bsv-sender` | Client → Server | Client identity public key |
| `x-bsv-nonce` | Client → Server | Base64-encoded derivation prefix |
| `x-bsv-time` | Client → Server | Unix millisecond timestamp |
| `x-bsv-vout` | Client → Server | Payment output index |

## Replay Protection

Two mechanisms prevent replay attacks:

1. **Timestamp freshness** -- `x-bsv-time` must be within 30 seconds of the server's clock
2. **Transaction uniqueness** -- `internalizeAction` returns `isMerge: true` for previously seen transactions

## License

See LICENSE
