---
id: pkg-payment-express-middleware
title: '@bsv/payment-express-middleware'
kind: package
domain: middleware
version: '2.1.3'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-07-29'
last_verified: '2026-07-29'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/payment-express-middleware'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/payment-express-middleware'
status: stable
tags: [middleware, express, payment, '402', brc-29]
---

# @bsv/payment-express-middleware

Express middleware for the legacy authenticated `x-bsv-payment` JSON flow. It
runs after `@bsv/auth-express-middleware`, validates an Atomic BEEF payment,
atomically rejects transaction-ID reuse, internalizes output zero, and exposes
a verified receipt.

This contract is distinct from the newer BRC-121 implementation in
`@bsv/402-pay`. Their headers and clients are not interchangeable.

## Install

```bash
npm install @bsv/payment-express-middleware @bsv/auth-express-middleware @bsv/sdk express
```

Node.js 22 or newer is required. The package provides native ESM and CommonJS
entry points with matching declarations.

## Quick start

```ts
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware, type PaymentRequest } from '@bsv/payment-express-middleware'

const app = express()

app.use(express.json())
app.use(createAuthMiddleware({ wallet }))
app.use(
  createPaymentMiddleware({
    wallet,
    calculateRequestPrice(req) {
      if (req.path === '/free') return 0
      return 100
    },
    replayStore
  })
)

app.get('/paid', (req: PaymentRequest, res) => {
  res.json({
    satoshisPaid: req.payment?.satoshisPaid,
    txid: req.payment?.txid
  })
})
```

Prices must be zero or a positive safe integer. Zero-cost requests receive an
accepted zero-value receipt. Invalid pricing fails closed.

## Validated flow

1. Auth middleware supplies a valid compressed identity key.
2. Missing payment produces `402` plus the version, required satoshis, and a
   server-created derivation prefix.
3. The retry supplies `x-bsv-payment` JSON with canonical-base64
   `derivationPrefix`, `derivationSuffix`, and `transaction`.
4. The transaction must be valid Atomic BEEF whose output zero covers the
   current price.
5. The transaction ID is atomically claimed before the wallet is called.
6. Only `{ accepted: true }` from a newly internalized payment authorizes the
   route.
7. `req.payment.satoshisPaid` and the response header report the actual output
   value.

The raw header is bounded to 64 KiB by default. Duplicated, malformed,
underfunded, replayed, rejected, or ambiguous payments never call `next()`.

## Replay storage

`PaymentReplayStore` has one required operation:

```ts
interface PaymentReplayStore {
  claim(transactionId: string): boolean | Promise<boolean>
}
```

The claim must be a single atomic insert-if-absent operation. It returns true
once and false for every reuse.

The default `InMemoryPaymentReplayStore` is bounded and fail-closed, but it is
process-local and loses claims on restart. Use a shared durable implementation
for replicas and production services:

```ts
const replayStore = {
  async claim(transactionId: string) {
    return await database.insertPaymentClaimIfAbsent(transactionId)
  }
}
```

Claims are retained after ambiguous wallet errors. A derivation nonce proves
the server created a prefix; it is not an expiring single-use replay database.

## Configuration

- `wallet` — required BRC-100 wallet with `internalizeAction`
- `calculateRequestPrice` — sync or async price; defaults to 100
- `replayStore` — atomic transaction-ID claim store
- `maxPaymentHeaderBytes` — positive safe integer; defaults to 64 KiB
- `logger` — optional structured `error`/`warn` sink

The logger receives sanitized failure metadata, not exception messages,
transaction IDs, wallet objects, or payment bodies. HTTP responses are also
stable and sanitized.

## Payment receipt

```ts
interface PaymentReceipt {
  satoshisPaid: number
  accepted: true
  tx: string
  txid: string
}
```

For a free request, `satoshisPaid` is zero and `tx`/`txid` are empty.

## Browser and public-service policy

The middleware does not hard-code CORS, CSP, or origin restrictions. Public
payment services may remain cross-origin by default, with an operator opt-in
allowlist at the application or edge. Browser clients need
`x-bsv-payment-*` response headers exposed through CORS. Do not combine a
wildcard origin with credentialed CORS.

## Security and operations

- Run auth first, then payment, then protected routes.
- Use HTTPS and normal request/header/rate limits.
- Use durable atomic replay storage across processes and replicas.
- Never automatically delete a claim after an ambiguous wallet result.
- Alert on replay (`409`) and unavailable/capacity (`503`) responses.
- Keep pricing deterministic and security-reviewed.
- The wallet remains responsible for safely internalizing the BRC-29
  remittance.

## Public API

Runtime:

- `createPaymentMiddleware`
- `InMemoryPaymentReplayStore`

Types:

- `BSVPayment`
- `PaymentLogger`
- `PaymentMiddlewareOptions`
- `PaymentReceipt`
- `PaymentReplayStore`
- `PaymentRequest`

## Related packages

- `@bsv/auth-express-middleware` — required payer authentication
- `@bsv/402-pay` — separate BRC-121 payment protocol
- `@bsv/sdk` — nonce, Atomic BEEF, and wallet primitives

## References

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/payment-express-middleware)
- [npm](https://www.npmjs.com/package/@bsv/payment-express-middleware)
