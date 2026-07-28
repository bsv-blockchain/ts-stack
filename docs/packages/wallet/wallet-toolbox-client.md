---
id: pkg-wallet-toolbox-client
title: '@bsv/wallet-toolbox-client'
kind: package
domain: wallet
version: '2.4.11'
last_updated: '2026-07-28'
last_verified: '2026-07-28'
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
