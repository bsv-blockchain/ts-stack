# @bsv/wallet-toolbox-client

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)

Browser build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. Same wallet, signer, services, and monitor APIs as the full package, with Node-only storage backends (Knex / SQLite / MySQL) excluded so the bundle is small and safe to ship to browsers.

Use this package in:

- Web apps that talk to a remote `StorageServer`
- Browser extensions
- Electron renderers

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For React Native / mobile, use [`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile).

## Install

```bash
npm install @bsv/wallet-toolbox-client
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
} from '@bsv/wallet-toolbox-client'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTP — no SQLite/MySQL in the browser bundle.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(
  new StorageClient(keyDeriver, 'https://storage.example.com')
)
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

// Use the BRC-100 interface as usual.
const { tx } = await wallet.createAction({
  description: 'pay alice',
  outputs: [{ satoshis: 1000, lockingScript: aliceP2PKH }],
})
```

## Use cases

### BRC-100 wallet inside a browser extension

Talk to a remote `StorageServer` over HTTP, sign locally with a key the user controls.

### Authenticated app with `WalletClient`

```ts
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient() // delegates to the user's installed wallet
// ...or build your own with the toolbox classes above
```

### Run an in-app embedded wallet against `IndexedDB`

```ts
import { StorageIdb } from '@bsv/wallet-toolbox-client'
await storageManager.addWalletStorageProvider(new StorageIdb(...))
```

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded | Why |
|----------|-----|
| `StorageKnex` (SQLite, MySQL) | Pulls native bindings; not browser-safe |
| Node-only filesystem helpers | Not available in browsers |

Everything else — `Wallet`, `WalletSigner`, `WalletStorageManager`, `StorageClient`, `StorageIdb`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, key management, MockChain — is identical to the full package.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
