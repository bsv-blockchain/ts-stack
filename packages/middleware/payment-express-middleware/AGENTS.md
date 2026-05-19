# CLAUDE.md — @bsv/payment-express-middleware

## Purpose
Express.js middleware for HTTP 402 Payment Required micropayment gating. Builds on top of BRC-103 auth middleware to monetize API endpoints by requiring BSV satoshi payments derived using BRC-29 key derivation.

## Public API surface

- **createPaymentMiddleware** (function): `createPaymentMiddleware(options)`
  - Options:
    - `wallet` (required): BRC-100 wallet supporting `internalizeAction()` method for transaction acceptance
    - `calculateRequestPrice` (optional, default 100): Function `(req) => number | Promise<number>` returning satoshis required; 0 = free
  - Returns Express middleware function: `async (req, res, next) => void`

- **Augmented Request** (extends Express Request)
  - `.payment` object set by middleware:
    - `satoshisPaid: number` — amount paid (matches required amount if accepted)
    - `accepted?: boolean` — whether payment was accepted by wallet
    - `tx?: string` — transaction hex (base64-encoded in request header)

- **Payment Response Headers**:
  - `x-bsv-payment-version` — payment protocol version (e.g., '1.0')
  - `x-bsv-payment-satoshis-required` — satoshis owed (if 402)
  - `x-bsv-payment-derivation-prefix` — nonce for client to derive payment address
  - `x-bsv-payment-satoshis-paid` — satoshis accepted (on success)

## Real usage patterns

From README:
```ts
import express from 'express'
import bodyParser from 'body-parser'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { Wallet } from '@your/bsv-wallet'

// 1. Create wallet that can process transactions
const wallet = new Wallet({ /* config */ })

// 2. Create auth middleware
const authMiddleware = createAuthMiddleware({ wallet })

// 3. Create payment middleware
const paymentMiddleware = createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => {
    return 50 // 50 satoshis per request
  }
})

const app = express()
app.use(bodyParser.json())

// 4. Chain auth THEN payment
app.use(authMiddleware)
app.use(paymentMiddleware)

// 5. Routes are now payment-gated
app.post('/somePaidEndpoint', (req, res) => {
  // If we reach here, payment was accepted (or amount was 0)
  res.json({
    message: 'Payment received, request authorized',
    amount: req.payment.satoshisPaid
  })
})

app.listen(3000)
```

Dynamic pricing:
```ts
const paymentMiddleware = createPaymentMiddleware({
  wallet,
  calculateRequestPrice: async (req) => {
    if (req.path === '/premium') return 500  // premium endpoint costs 500 sats
    if (req.path === '/free') return 0      // free endpoint
    return 100  // default 100 sats
  }
})
```

## Key concepts

- **402 Payment Required**: HTTP status code signaling payment is needed; client responds with BSV transaction
- **Micropayments**: Small satoshi amounts (1-1000 typical) for API access
- **BRC-29 derivation**: Payment output derived from `derivationPrefix` (server nonce) + `derivationSuffix` (client extension)
- **Nonce reuse prevention**: Each 402 response includes fresh `derivationPrefix`; client must use it to build payment
- **Wallet integration**: Server validates payment using `wallet.internalizeAction()` method
- **Auth prerequisite**: Assumes `req.auth.identityKey` set by auth middleware; fails if missing
- **Fallback allowed**: If `calculateRequestPrice` returns 0, no payment required; request proceeds
- **Transaction format**: Client sends BSV transaction as base64 in `x-bsv-payment` header as JSON

## Dependencies

- `@bsv/sdk` ^2.0.14 — BRC-29 nonce creation/verification, `createNonce()`, `verifyNonce()`, `Utils`, `AtomicBEEF`
- `@bsv/auth-express-middleware` ^2.0.5 — Auth middleware (peer dependency; must be installed)
- `express` ^5.1.0 — Web framework
- Dev: jest, ts-jest, TypeScript, ts-standard

## Common pitfalls / gotchas

1. **Auth middleware must run first** — Payment middleware expects `req.auth.identityKey` to be set; will return 500 if missing
2. **Wallet must implement `internalizeAction()`** — This is the critical method for validating and accepting payments; custom wallet needed if using non-SDK wallet
3. **Nonce verification required** — Middleware verifies `derivationPrefix` matches server's private key; client must use exact prefix from 402 response
4. **Transaction format** — Client sends `x-bsv-payment` header as JSON with `{ derivationPrefix, derivationSuffix, transaction }`
5. **Replay protection** — Wallet should reject duplicate `derivationPrefix` values; ensure wallet logic prevents replays
6. **HTTPS recommended** — No encryption; use TLS to protect payment transactions in transit
7. **Pricing must be consistent** — If `calculateRequestPrice` is async, ensure it doesn't have timing side-effects that cause inconsistency

## Spec conformance

- **HTTP 402 Payment Required** — Uses standard 402 status code; client must respond with payment
- **BRC-29** (Payment Derivation): Uses BRC-29 nonce/derivation model for payment address generation
- **BRC-100** (Wallet interface): Requires wallet implementing `internalizeAction()` method
- **BRC-104** — Builds on top of BRC-104 HTTP auth transport (handles headers, etc.)

## File map

```
/Users/personal/git/ts-stack/packages/middleware/payment-express-middleware/
  src/
    index.ts              — exports createPaymentMiddleware
    types.ts              — BSVPayment, PaymentMiddlewareOptions, PaymentResult interfaces
  tests/
    integration.test.ts   — end-to-end tests with payment flows
```

## Integration points

- **auth-express-middleware** — Required; stacks after it in middleware chain
- **@bsv/sdk** — Nonce creation/verification, wallet interface, transaction utilities
- **express** — HTTP framework; middleware plugs into standard Express pipeline
- **Custom wallet** — Must implement BRC-100 `internalizeAction()` method for payment acceptance
