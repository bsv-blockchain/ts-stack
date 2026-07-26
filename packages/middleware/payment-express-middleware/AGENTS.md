# AGENTS.md — @bsv/payment-express-middleware

## Purpose and protocol boundary

This package implements the legacy authenticated `x-bsv-payment` JSON flow for
Express. It must run after `@bsv/auth-express-middleware`. It is distinct from
the BRC-121 client/server contract in `@bsv/402-pay`; do not silently mix their
headers or claim conformance to one based on behavior from the other.

## Public API

- Runtime: `createPaymentMiddleware`, `InMemoryPaymentReplayStore`
- Types: `BSVPayment`, `PaymentLogger`, `PaymentMiddlewareOptions`,
  `PaymentReceipt`, `PaymentReplayStore`, `PaymentRequest`

Changing header names, error codes, output selection, replay semantics, receipt
fields, or exported types is a public/protocol change.

## Security invariants

- Require a valid compressed identity key supplied by auth middleware.
- Prices are `0` or positive safe integers. Invalid or failed pricing must not
  authorize a route.
- Bound the raw header before JSON or transaction parsing.
- Require canonical base64 for the prefix, suffix, and Atomic BEEF.
- Verify the server-created prefix, parse Atomic BEEF, and require output zero
  to cover the current price before wallet internalization.
- Claim the transaction ID atomically before calling the wallet.
- Never automatically release a claim after an ambiguous wallet error.
- Only `{ accepted: true }` from a newly internalized transaction authorizes
  the request. Reject merge/replay-like results.
- Never expose wallet, store, pricing, or parser exception messages in HTTP
  responses.
- Use a shared durable replay store for multiple processes or replicas. A
  derivation nonce is not an expiring single-use replay store.
- Do not impose a hard-coded CORS/CSP policy. Public services must remain
  configurable and may be cross-origin by default.

## Replay-store contract

`claim(transactionId)` must be one atomic insert-if-absent operation. It returns
`true` only for the first accepted claim and `false` thereafter.

The in-memory implementation is process-local, bounded, and fail-closed at
capacity. It is for tests and bounded single-process deployments. Do not add
automatic eviction or restart-based assumptions to its security model.

## Build and verification

Node.js 22+ is required. `tsdown` emits native ESM, CommonJS, and matching
declarations. The published file allowlist is `dist`, `README.md`, and
`LICENSE.txt`.

Before handing off a change, run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm pack:check
```

Coverage must remain at least 85% lines/statements/functions and 80% branches
over production source. Tests must be deterministic and must not call public
APIs or rebuild as a side effect. `pack:check` must validate the exact tarball
in both ESM and CommonJS consumer probes.

## File map

- `mod.ts` — package entry point and export contract
- `src/index.ts` — validation, replay claim, wallet acceptance, middleware
- `src/types.ts` — public request, receipt, store, logger, and option types
- `src/__tests/PaymentMiddleware.test.ts` — deterministic security and behavior
  coverage
- `tsdown.config.ts` — ESM/CommonJS build
- `tsconfig.typecheck.json` — strict source and test checking
- `README.md` — user contract and deployment guidance
- `BASELINE.md` — verified repository health snapshot

## Integration points

- `@bsv/auth-express-middleware` provides authenticated payer identity.
- `@bsv/sdk` supplies nonce utilities, Atomic BEEF parsing, and wallet types.
- Express provides the request/response middleware lifecycle.
