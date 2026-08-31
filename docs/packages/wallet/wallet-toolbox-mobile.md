---
id: pkg-wallet-toolbox-mobile
title: '@bsv/wallet-toolbox-mobile'
kind: package
domain: wallet
version: '2.11.0'
last_updated: '2026-08-30'
last_verified: '2026-08-30'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile'
status: stable
tags: [wallet, react-native, mobile, storage, brc-100]
---

# @bsv/wallet-toolbox-mobile

`@bsv/wallet-toolbox-mobile` is the React Native and mobile-safe Wallet
Toolbox distribution. It includes wallet, signer, services, monitoring, and
remote storage surfaces without Knex, SQLite/MySQL, IndexedDB, or Node-only IO.
The built-in BRC-177 `p nosend expiry` module delegates durable expiry
monitoring and pre-signed reclaim submission to its 2.11-compatible active
remote storage service, so mobile process suspension does not restart or lose
an expiry.
Related mobile `noSend` chains retain local action batching, while unrelated
actions cannot join or commit the active workspace. Supported remote providers
can resume a soft-expired workspace using its exact persisted inputs.
`WalletStorageManager.getStores()` retains each remote provider's configured
`endpointURL` after production bundlers minify class names, so backup selection
and make-primary flows remain stable.
Immediate mobile actions can chain wallet-managed change from a delayed parent;
the wallet first exhausts completed and unproven liquidity and uses exact
serialized-cost comparison only for pathological settled plans. Pending funds
are never hidden. New and migrated wallets progressively prefer useful
5,000-satoshi liquidity units without gathering inputs merely to create them.
Durable permission tokens retain delayed broadcast so permission approval does
not inherit network latency.
Opt-in remote-storage timing spans retain trace and parent-span correlation in
the telemetry sink without adding headers to authenticated requests.

The mobile distribution also exposes the WAB UMP ambiguity fallback and
OTP-verified `startPhoneNumberChange` / `completePhoneNumberChange` flow. A
settings UI may submit the current number to force a fresh presentation hash;
it must persist the wallet snapshot immediately after success.
Mobile authentication accepts one verified matching UMP token as an existing
account. When no token verifies, one clean empty overlay response establishes a
new account even if other hosts fail or return malformed records.

The mobile build includes the fetch-based, credential-free ChainTracks v2
client and reconnecting SSE adapter without Node-only modules. Public defaults
cover mainnet, testnet, and TerraTestNet; STN/TSTN use an injected or configured
endpoint.

The portable local controller coalesces stale height refresh and immutable
object loads, applies failed-load backoff, and validates through the asynchronous
`InlineBulkFileDataValidator` without importing Node worker or filesystem code.

## Install

```bash
npm install @bsv/wallet-toolbox-mobile @bsv/sdk
```

## Use

```ts
import {
  Services,
  StorageClient,
  Wallet,
  WalletSigner,
  WalletStorageManager
} from '@bsv/wallet-toolbox-mobile'
```

The package publishes `react-native`, import ESM, and CommonJS conditions with
matching declarations. Its installed-consumer gate bundles the exact tarball
with Metro, checks the mobile-safe module boundary, compiles optimized Hermes
bytecode, validates source maps, and enforces size budgets.

Native requests are not governed by browser CORS, while WebView and hybrid
clients can be. Remote Storage should remain reachable by intended public
clients unless an operator explicitly configures an allowlist. Authentication
and authorization remain service-layer controls.

See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile#readme)
for remote storage setup and supported runtime assumptions.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/mobile/LICENSE.txt).
