# Changelog

## [Unreleased]

### Security

- Bind route pricing and wallet internalization to the BRC-95 Atomic BEEF
  subject, reduce legacy over-inclusive envelopes to that subject's dependency
  closure, reject trailing bytes and plain BEEF, and require an affirmative
  wallet acceptance before serving paid content.

## [0.1.0] - 2026-04-04

### Added

- `create402Fetch` client wrapper — automatically handles 402 responses, constructs BRC-29 payments, and retries with `x-bsv-nonce`/`x-bsv-time` headers
- `createPaymentMiddleware` Express-compatible server middleware — validates payment headers, enforces 30s freshness window, internalizes payment via wallet
- `validatePayment` and `send402` server primitives for framework-agnostic use
- Shared `HEADERS` constants and `DEFAULT_PAYMENT_WINDOW_MS` in `constants.ts`
