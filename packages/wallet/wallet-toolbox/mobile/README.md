# @bsv/wallet-toolbox-mobile

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)

Mobile build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. Same wallet, signer, services, and monitor APIs as the full package, trimmed for React Native and other mobile runtimes: no Knex, no SQLite/MySQL native bindings, no Node-only IO.

Use this package in:

- React Native apps
- Capacitor / Cordova mobile apps
- Any other runtime that lacks Node native modules but provides IndexedDB or remote HTTP

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For browsers, use [`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client).

## Install

```bash
npm install @bsv/wallet-toolbox-mobile
```

Peer dependency: `@bsv/sdk`.

## Quick start

```ts
import {
  Wallet,
  WalletSigner,
  WalletStorageManager,
  StorageClient,
  Services,
} from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTP is the default mobile-safe backend.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(
  new StorageClient(keyDeriver, 'https://storage.example.com')
)
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

const { tx } = await wallet.createAction({
  description: 'mobile send',
  outputs: [{ satoshis: 1000, lockingScript: recipientScript }],
})
```

## Use cases

### Self-custody BSV wallet on a phone

Run the BRC-100 wallet entirely on-device, with remote storage for cross-device sync.

### Companion-app signer for a desktop wallet

Use mobile as the signer over a paired channel while a desktop runs the heavier services.

### Receive-only mobile app

Spin up a minimal wallet that watches for inbound payments via a remote storage backend.

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded | Why |
|----------|-----|
| `StorageKnex` (SQLite, MySQL) | Native bindings unavailable on React Native / mobile WebViews |
| Node-only filesystem and `os` helpers | Not available on mobile |

`Wallet`, `WalletSigner`, `WalletStorageManager`, `StorageClient`, `StorageIdb`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, key management, and MockChain are all included.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
