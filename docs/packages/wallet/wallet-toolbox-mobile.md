---
id: pkg-wallet-toolbox-mobile
title: '@bsv/wallet-toolbox-mobile'
kind: package
domain: wallet
version: '2.6.5'
last_updated: '2026-08-09'
last_verified: '2026-08-09'
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
`WalletStorageManager.getStores()` retains each remote provider's configured
`endpointURL` after production bundlers minify class names, so backup selection
and make-primary flows remain stable.
Immediate mobile actions can chain wallet-managed change from a delayed parent;
the child broadcast includes the parent BEEF so background delivery cannot
temporarily strand the wallet balance.
Durable permission grants finish broadcasting their internal token transaction
before the waiting mobile request resumes, keeping the grant's funding change
available to the following wallet action.
Opt-in remote-storage timing spans retain trace and parent-span correlation in
the telemetry sink without adding headers to authenticated requests.
Mobile authentication accepts one verified matching UMP token as an existing
account. When no token verifies, one clean empty overlay response establishes a
new account even if other hosts fail or return malformed records.

The mobile build includes the fetch-based, credential-free ChainTracks v2
client and reconnecting SSE adapter without Node-only modules. Public defaults
cover mainnet, testnet, and TerraTestNet; STN/TSTN use an injected or configured
endpoint.

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
