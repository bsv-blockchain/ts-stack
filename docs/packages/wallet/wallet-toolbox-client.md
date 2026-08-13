---
id: pkg-wallet-toolbox-client
title: '@bsv/wallet-toolbox-client'
kind: package
domain: wallet
version: '2.9.1'
last_updated: '2026-08-12'
last_verified: '2026-08-12'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/wallet-toolbox-client'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/client'
status: stable
tags: [wallet, browser, indexeddb, storage, brc-100]
---

# @bsv/wallet-toolbox-client

`@bsv/wallet-toolbox-client` is the browser-safe Wallet Toolbox distribution.
It includes the BRC-100 wallet, signer, services, IndexedDB storage, and remote
storage client without Node-only Knex, SQLite, MySQL, or filesystem adapters.
Related browser `noSend` chains retain local action batching, while unrelated
actions cannot join or commit the active workspace. Supported remote providers
can resume a soft-expired workspace using its exact persisted inputs.
`WalletStorageManager.getStores()` retains each remote provider's configured
`endpointURL` after production bundlers minify class names, so backup selection
and make-primary flows remain stable.
Immediate browser actions can chain wallet-managed change from a delayed
parent only after completed and unproven liquidity is exhausted or exact
serialized-cost comparison proves that a pathological settled plan is larger.
Pending funds are never hidden. IndexedDB wallets migrate exact untouched
144-output / 32-satoshi defaults to a progressive 5,000-satoshi preference.
Durable permission tokens retain delayed broadcast so permission approval does
not inherit network latency.
Opt-in remote-storage timing spans retain trace and parent-span correlation in
the telemetry sink without adding headers to authenticated requests.
Browser authentication accepts one verified matching UMP token as an existing
account. When no token verifies, one clean empty overlay response establishes a
new account even if other hosts fail or return malformed records.

The browser build includes the fetch-based, credential-free ChainTracks v2
client and reconnecting SSE adapter without Node-only modules. Public defaults
cover mainnet, testnet, and TerraTestNet; STN/TSTN use an injected or configured
endpoint.

The portable local controller coalesces stale height refresh and immutable
object loads, applies failed-load backoff, and validates through the asynchronous
`InlineBulkFileDataValidator` without importing Node worker or filesystem code.

## Install

```bash
npm install @bsv/wallet-toolbox-client @bsv/sdk
```

## Use

```ts
import {
  Services,
  StorageClient,
  Wallet,
  WalletSigner,
  WalletStorageManager
} from '@bsv/wallet-toolbox-client'
```

The package publishes browser/import ESM and CommonJS conditions with matching
declarations. Its installed-consumer gate bundles the exact tarball with Vite
and esbuild, rejects Node-only modules, validates source maps, and enforces
compressed and uncompressed size budgets.

Remote Wallet Storage often serves public web, extension, WUI, and mobile
clients from origins unknown at build time. The client imposes no origin
allowlist. Operators may explicitly configure one at the service edge, but
CORS is not authentication; storage authorization and identity isolation
remain mandatory in either mode.

See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/client#readme)
for complete remote and IndexedDB setup.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/client/LICENSE.txt).
