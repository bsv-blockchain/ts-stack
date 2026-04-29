---
id: pkg-payment-express-middleware
title: "@bsv/payment-express-middleware"
kind: package
domain: middleware
version: "2.0.2"
source_repo: "bsv-blockchain/payment-express-middleware"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/payment-express-middleware"
repo: "https://github.com/bsv-blockchain/payment-express-middleware"
status: stable
tags: [middleware, express, payment, brc-121, "402"]
---

# @bsv/payment-express-middleware

> Express.js middleware for HTTP 402 Payment Required micropayment gating. Builds on top of BRC-103 auth middleware to monetize API endpoints by requiring BSV satoshi payments derived using BRC-29 key derivation.

## Install

```bash
npm install @bsv/payment-express-middleware
```

## Quick start

```typescript
import express from 'express'
import bodyParser from 'body-parser'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'

const wallet = new Wallet({ /* config */ })
const authMiddleware = createAuthMiddleware({ wallet })
const paymentMiddleware = createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => {
    return 50 // 50 satoshis per request
  }
})

const app = express()
app.use(bodyParser.json())
app.use(authMiddleware)
app.use(paymentMiddleware)

app.post('/somePaidEndpoint', (req, res) => {
  res.json({
    message: 'Payment received, request authorized',
    amount: req.payment.satoshisPaid
  })
})

app.listen(3000)
```

## What it provides

- **createPaymentMiddleware** — Express middleware factory for 402 payment gating
- **HTTP 402 Payment Required** — Responds with 402 when payment needed
- **BRC-29 derivation** — Payment output derived from `derivationPrefix` + `derivationSuffix`
- **Nonce reuse prevention** — Each 402 response includes fresh `derivationPrefix`
- **Wallet integration** — Validates payment using `wallet.internalizeAction()` method
- **Dynamic pricing** — `calculateRequestPrice` function per endpoint/request
- **Payment object** — `req.payment` with `satoshisPaid`, `accepted`, `tx` fields
- **Response headers** — `x-bsv-payment-*` headers with invoice details

## Common patterns

### Basic payment gating

```typescript
import express from 'express'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'

const paymentMiddleware = createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => {
    return 100 // 100 satoshis per request
  }
})

const app = express()
app.use(authMiddleware)
app.use(paymentMiddleware)

app.get('/content', (req, res) => {
  if (req.payment.accepted) {
    res.json({ content: 'Premium content here' })
  }
})
```

### Dynamic pricing

```typescript
const paymentMiddleware = createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => {
    if (req.path === '/premium') return 500  // premium costs 500 sats
    if (req.path === '/free') return 0      // free content
    return 100  // default 100 sats
  }
})
```

### Chained with auth middleware

```typescript
const app = express()
app.use(bodyParser.json())

// Auth first
app.use(createAuthMiddleware({ wallet }))

// Then payment
app.use(createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => 100
}))

// Routes now require both auth AND payment
app.post('/api/paid-endpoint', (req, res) => {
  // req.auth.identityKey is authenticated
  // req.payment.satoshisPaid was received
  res.json({ result: 'success' })
})
```

## Key concepts

- **402 Payment Required** — HTTP status code signaling payment is needed
- **Micropayments** — Small satoshi amounts (1-1000 typical) for API access
- **BRC-29 derivation** — Payment output derived from `derivationPrefix` + `derivationSuffix`
- **Nonce reuse prevention** — Each 402 response includes fresh `derivationPrefix`
- **Wallet integration** — Server validates payment using `wallet.internalizeAction()` method
- **Auth prerequisite** — Assumes `req.auth.identityKey` set by auth middleware
- **Transaction format** — Client sends BSV transaction as base64 in header

## When to use this

- Monetizing API endpoints with micropayments
- Creating pay-per-request services
- Building content that requires payment to access
- Implementing dynamic pricing based on request
- Creating subscription-like services with per-use charges

## When NOT to use this

- Traditional subscription billing — use Stripe or similar
- Complex payment workflows — use a payment processor
- Free public APIs — skip this middleware
- Offline payment tracking — use a database instead

## Spec conformance

- **HTTP 402 Payment Required** — Uses standard 402 status code
- **BRC-29** (Payment Derivation): Uses BRC-29 nonce/derivation model for payment address generation
- **BRC-100** (Wallet interface): Requires wallet implementing `internalizeAction()` method
- **BRC-104** — Builds on top of BRC-104 HTTP auth transport

## Common pitfalls

1. **Auth middleware must run first** — Payment middleware expects `req.auth.identityKey`
2. **Wallet must implement `internalizeAction()`** — Critical method for validating and accepting payments
3. **Nonce verification required** — Middleware verifies `derivationPrefix` matches server's private key
4. **Transaction format strict** — Client sends `x-bsv-payment` header as JSON with transaction
5. **Replay protection essential** — Wallet should reject duplicate `derivationPrefix` values
6. **HTTPS recommended** — No encryption; use TLS to protect payment transactions
7. **Pricing consistency** — If `calculateRequestPrice` is async, ensure no timing side-effects

## Related packages

- **@bsv/402-pay** — Client-side handler for paying 402 responses
- **@bsv/auth-express-middleware** — Required for authentication before payment
- **@bsv/sdk** — Nonce creation/verification, wallet interface, transaction utilities

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/payment-express-middleware/)
- [Source on GitHub](https://github.com/bsv-blockchain/payment-express-middleware)
- [npm](https://www.npmjs.com/package/@bsv/payment-express-middleware)
