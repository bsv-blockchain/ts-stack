# @bsv/wallet-toolbox-client

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)

Browser build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. It provides browser-safe wallet, signer, services, monitor, local IndexedDB, and remote storage APIs without the full package's Node-only storage adapters.

Use this package in:

- Web apps that talk to a remote `StorageServer`
- Browser extensions
- Electron renderers

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For React Native / mobile, use [`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile).

## Install

Install the `@bsv/sdk` peer dependency alongside this package:

```bash
npm install @bsv/wallet-toolbox-client @bsv/sdk
```

## Package targets

The package publishes:

- an ESM browser/import target with source maps;
- a CommonJS require target with source maps;
- matching declarations for ESM and CommonJS;
- explicit `browser`, `import`, and `require` export conditions.

Use a current browser bundler such as Vite or esbuild. Node.js 22 or newer is required for the published tooling and contributor workflow; browser runtime support is determined by your application's target configuration.

## Remote storage example

```ts
import { Wallet, WalletSigner, WalletStorageManager, StorageClient, Services } from '@bsv/wallet-toolbox-client'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTPS — no SQLite/MySQL in the browser bundle.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(new StorageClient(keyDeriver, 'https://storage.example.com'))
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

// Use the BRC-100 interface as usual.
const { tx } = await wallet.createAction({
  description: 'pay alice',
  outputs: [{ satoshis: 1000, lockingScript: aliceP2PKH }]
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

### Run an in-app embedded wallet against IndexedDB

```ts
import { StorageIdb } from '@bsv/wallet-toolbox-client'
await storageManager.addWalletStorageProvider(new StorageIdb(...))
```

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded                      | Why                                     |
| ----------------------------- | --------------------------------------- |
| `StorageKnex` (SQLite, MySQL) | Pulls native bindings; not browser-safe |
| Node-only filesystem helpers  | Not available in browsers               |

The browser entry includes `Wallet`, `WalletSigner`, `WalletStorageManager`, `StorageClient`, `StorageIdb`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, and related browser-safe APIs. It does not promise every full-package or test-only export.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

## CORS, CSP, and public services

This client does not impose an origin allowlist. A remote Storage service controls its own CORS policy and should remain reachable by its intended public web, WUI, extension, and mobile clients. Operators can keep public access enabled by default or configure an explicit allowlist when their deployment requires one; deployments should not assume a single calling domain.

CSP is an application and deployment concern rather than a package-level access control. Add the service's HTTPS origin to the consuming application's `connect-src` policy. Keep authentication and authorization at the protocol/service layer instead of treating CORS as an authentication mechanism.

## Contributor checks

From the repository root, build the SDK and package before running the installed-consumer browser gate:

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/wallet-toolbox-client test:browser
```

The gate installs the packed packages in a clean project, bundles them with Vite and esbuild, checks the public export and browser-only module contracts, validates source maps, and enforces compressed and uncompressed size budgets.

## License

Open BSV License Version 6 — see [LICENSE.txt](./LICENSE.txt).
