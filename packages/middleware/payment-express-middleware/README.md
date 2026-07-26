# @bsv/payment-express-middleware

Express middleware for the legacy authenticated `x-bsv-payment` JSON flow. It
runs after `@bsv/auth-express-middleware`, issues an HTTP `402` challenge,
validates an Atomic BEEF transaction, atomically rejects reused transaction
IDs, internalizes output zero, and exposes a verified payment receipt.

This protocol is distinct from the newer BRC-121 implementation in
`@bsv/402-pay`. Choose one protocol deliberately; their headers and client
contracts are not interchangeable.

## Requirements

- Node.js 22 or newer
- Express 5
- `@bsv/auth-express-middleware` earlier in the middleware chain
- A BRC-100 wallet implementing `internalizeAction`

The package ships native ESM and CommonJS entry points with declarations for
both module systems.

## Install

```bash
npm install @bsv/payment-express-middleware @bsv/auth-express-middleware @bsv/sdk express
```

## Basic use

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
      if (req.path === '/premium') return 500
      return 100
    },
    replayStore
  })
)

app.get('/premium', (req: PaymentRequest, res) => {
  res.json({
    accepted: req.payment?.accepted,
    satoshisPaid: req.payment?.satoshisPaid,
    txid: req.payment?.txid
  })
})
```

Prices must be `0` or a positive safe integer. Zero-cost requests continue
with an accepted zero-value receipt. Invalid or failed pricing returns a stable
`500` response and never authorizes the request.

## Flow

1. Auth middleware verifies the peer and supplies a compressed
   `req.auth.identityKey`.
2. `calculateRequestPrice` returns the required satoshis.
3. If no `x-bsv-payment` header is present, the middleware returns `402` with:
   - `x-bsv-payment-version: 1.0`
   - `x-bsv-payment-satoshis-required`
   - `x-bsv-payment-derivation-prefix`
4. The client retries with one JSON header:

   ```json
   {
     "derivationPrefix": "<canonical-base64>",
     "derivationSuffix": "<canonical-base64>",
     "transaction": "<base64-atomic-beef>"
   }
   ```

5. The middleware bounds and parses the header, verifies the derivation
   prefix, parses the Atomic BEEF transaction, requires output zero to cover
   the current price, and atomically claims its transaction ID.
6. The wallet must return `{ accepted: true }` from `internalizeAction`.
   Merge/replay-like results do not authorize the route.
7. `next()` runs with `req.payment`, and
   `x-bsv-payment-satoshis-paid` reports the actual output value.

Malformed, duplicate, underfunded, rejected, or ambiguous payments never call
`next`.

## Options

```ts
const payment = createPaymentMiddleware({
  wallet,
  calculateRequestPrice,
  replayStore,
  maxPaymentHeaderBytes: 64 * 1024,
  logger
})
```

- `wallet` is required and must provide `internalizeAction`.
- `calculateRequestPrice` may be synchronous or asynchronous and defaults to
  100 satoshis.
- `replayStore` must implement an atomic
  `claim(transactionId): boolean | Promise<boolean>`. It returns `false` if
  the transaction has already been used.
- `maxPaymentHeaderBytes` defaults to 64 KiB and must be a positive safe
  integer.
- `logger` may provide `error` and `warn` methods. Internal failures are sent
  to it as structured context but are never exposed in HTTP responses.

Invalid option types fail during startup.

## Replay storage

`InMemoryPaymentReplayStore` is the safe single-process default. It:

- atomically claims each transaction ID once within one process;
- retains claims after wallet errors because the acceptance outcome may be
  ambiguous;
- refuses new claims when its fixed capacity is reached rather than evicting
  an older replay marker; and
- loses all claims when the process restarts.

Its default capacity is 100,000 claims. It is appropriate for tests and
bounded single-process services, not a horizontally scaled or durable
deployment.

Production services should inject a shared durable store backed by a database
or cache primitive with atomic insert-if-absent semantics:

```ts
const replayStore = {
  async claim(transactionId: string) {
    return await database.insertPaymentClaimIfAbsent(transactionId)
  }
}
```

Do not implement `claim` as separate read and write operations. Keep replay
claims for at least as long as a transaction could otherwise be accepted
again. A derivation nonce proves that the server created the prefix; it is not
an expiring, single-use replay database.

## Payment receipt

After authorization:

```ts
interface PaymentReceipt {
  satoshisPaid: number
  accepted: true
  tx: string
  txid: string
}
```

`satoshisPaid` is the actual value of output zero, which may be greater than
the required price. For free requests it is zero and `tx`/`txid` are empty.

## Error behavior

| Status | Code                            | Meaning                                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------------------ |
| 400    | `ERR_MALFORMED_PAYMENT`         | The header is duplicated, oversized, invalid JSON, or has invalid fields |
| 400    | `ERR_INVALID_DERIVATION_PREFIX` | The server did not create the supplied prefix                            |
| 400    | `ERR_INVALID_PAYMENT`           | Atomic BEEF is invalid or output zero is underfunded                     |
| 400    | `ERR_PAYMENT_FAILED`            | The wallet could not accept the payment                                  |
| 402    | `ERR_PAYMENT_REQUIRED`          | A payment challenge was issued                                           |
| 409    | `ERR_PAYMENT_REPLAYED`          | The transaction was claimed before or was not newly accepted             |
| 500    | `ERR_SERVER_MISCONFIGURED`      | Auth middleware did not provide a valid identity                         |
| 500    | `ERR_PAYMENT_INTERNAL`          | Pricing failed or returned an invalid value                              |
| 503    | `ERR_PAYMENT_UNAVAILABLE`       | Challenge creation or replay storage is unavailable                      |

Public errors deliberately omit wallet, replay-store, and pricing exception
messages.

## Public services and browser access

This middleware does not impose CORS or CSP. Public payment services can remain
cross-origin by default while operators optionally configure an allowlist at
the application or edge layer. Browser clients need the `x-bsv-payment-*`
response headers exposed through CORS. Never pair a wildcard origin with
credentialed CORS.

## Security notes

- Use HTTPS; payment and identity headers are not a confidentiality layer.
- Run authentication first and authorization/payment routes after both
  middleware functions.
- Use a durable atomic replay store for multiple processes or replicas.
- Do not delete a replay claim automatically after an ambiguous wallet error.
- Monitor `409` and `503` rates and replay-store capacity.
- Treat pricing as security-sensitive, deterministic request policy.
- The wallet remains responsible for validating and safely internalizing the
  supplied BRC-29 remittance.
- Apply normal request/header limits and rate limiting at the service edge.

## API

Runtime exports:

- `createPaymentMiddleware`
- `InMemoryPaymentReplayStore`

Type exports:

- `BSVPayment`
- `PaymentLogger`
- `PaymentMiddlewareOptions`
- `PaymentReceipt`
- `PaymentReplayStore`
- `PaymentRequest`

See [API.md](./API.md) for generated signatures.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm pack:check
```

The test suite is deterministic and does not call public APIs.
`pack:check` builds and validates the exact npm tarball in ESM and CommonJS
consumer probes. Tests do not rebuild the package as a side effect.

## License

See [LICENSE.txt](./LICENSE.txt).
