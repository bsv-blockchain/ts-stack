---
id: pkg-payment-express-middleware
title: '@bsv/payment-express-middleware'
kind: package
domain: middleware
version: '2.1.8'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-24'
last_verified: '2026-09-24'
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

Version 2.1.8 removes middleware payment-header size ceilings. A header already
received from the client is parsed and its payment validated regardless of size.
HTTP server, CDN, proxy and WAF configuration own transport budgets; configure
and validate the full route for supported payment proofs. The deprecated
`maxPaymentHeaderBytes` option remains accepted for source compatibility but is
ignored, including when an older application still supplies a value. Move any
intended transport policy to the HTTP server or edge and remove the option.

Atomic BEEF validation, canonical base64, derivation verification, payment
pricing, wallet acceptance and atomic replay protection still apply. Invalid
payment contents are rejected. SDK 2.8.5 separately raises client header capacity;
that does not constrain what this middleware accepts from other compatible
clients. No BRC100 call, wire or wallet-data migration is required. Source
publication is a separate protected release step.

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
5. Legacy overinclusive Atomic BEEF is reduced to the declared payment subject
   and dependency closure before it reaches the wallet or receipt.
6. Only an own-data `{ accepted: true }` from a newly internalized payment
   authorizes the route; inherited and accessor-backed verdicts are rejected.
7. After wallet validation, the transaction ID is atomically claimed. This
   ordering prevents invalid public BEEF/remittance pairs from poisoning a
   rightful payment's replay key.
8. `req.payment.satoshisPaid` and the response header report the actual output
   value.

The middleware does not impose a raw-header size ceiling. Duplicated, malformed,
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

Wallet errors and rejected remittances are not claimed. If the wallet accepts
but the subsequent replay claim is unavailable, the middleware returns `503`;
operators must reconcile that ambiguous transaction before asking the payer to
spend again. A derivation nonce proves the server created a prefix; it is not
an expiring single-use replay database.

## Configuration

- `wallet` — required BRC-100 wallet with `internalizeAction`
- `calculateRequestPrice` — sync or async price; defaults to 100
- `replayStore` — atomic transaction-ID claim store
- `maxPaymentHeaderBytes` — deprecated and ignored; configure transport budgets
  on the HTTP server or edge
- `logger` — optional structured `error`/`warn` sink

The logger receives sanitized failure metadata, not exception messages,
transaction IDs, wallet objects, or payment bodies. Logger failures are
contained. HTTP responses are also stable and sanitized.

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
- Reconcile a transaction after a replay-store failure that follows wallet
  acceptance; never ask the payer to spend again based only on that `503`.
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
