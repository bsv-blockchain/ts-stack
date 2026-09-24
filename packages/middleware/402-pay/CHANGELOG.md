# Changelog

## [Unreleased]

### 0.3.3 candidate — protocol selection documentation

- Clarify that BRC-118 extends the separate SDK AuthFetch/BRC-105 middleware path.
  This package's BRC-121 runtime, headers and replay behavior remain unchanged.

### 0.3.2 candidate — replay-safe Atomic BEEF payments

### Maintenance

- Align the development-only Vitest runner and V8 coverage provider at 4.1.11.
  Consumer APIs and payment protocol behavior are unchanged.

### Security

- Bind route pricing and wallet internalization to the BRC-95 Atomic BEEF
  subject, reduce legacy over-inclusive envelopes to that subject's dependency
  closure, reject trailing bytes and plain BEEF, and require an affirmative
  wallet acceptance before serving paid content.
- Add an independent bounded atomic transaction replay claim so wallets that
  omit the non-public `isMerge` detail cannot authorize duplicate access.
  Multi-process and multi-node deployments must inject the same durable atomic
  `PaymentReplayStore` in every serving process.
- Preserve the actual overpayment in middleware receipts, keep diagnostics
  opt-in and redacted, and return an unchallenged HTTP 503 after ambiguous
  wallet or replay-store failures so a client is not induced to spend twice.

## [0.1.0] - 2026-04-04

### Added

- `create402Fetch` client wrapper — automatically handles 402 responses, constructs BRC-29 payments, and retries with `x-bsv-nonce`/`x-bsv-time` headers
- `createPaymentMiddleware` Express-compatible server middleware — validates payment headers, enforces 30s freshness window, internalizes payment via wallet
- `validatePayment` and `send402` server primitives for framework-agnostic use
- Shared `HEADERS` constants and `DEFAULT_PAYMENT_WINDOW_MS` in `constants.ts`
