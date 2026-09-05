# Changelog

## 0.2.6

- Accept SDK 3 alongside the existing SDK 2 peer range. See the shared
  [SDK 3 migration guide](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/sdk/docs/overlay-lookup-migration.md)
  when upgrading the application SDK.

## [0.1.0] - 2026-04-04

### Added

- `create402Fetch` client wrapper — automatically handles 402 responses, constructs BRC-29 payments, and retries with `x-bsv-nonce`/`x-bsv-time` headers
- `createPaymentMiddleware` Express-compatible server middleware — validates payment headers, enforces 30s freshness window, internalizes payment via wallet
- `validatePayment` and `send402` server primitives for framework-agnostic use
- Shared `HEADERS` constants and `DEFAULT_PAYMENT_WINDOW_MS` in `constants.ts`
