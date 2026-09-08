# @bsv/wallet-toolbox-mobile

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)

Mobile build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. It provides mobile-safe wallet, signer, services, monitor, and remote storage APIs without Knex, SQLite/MySQL native bindings, IndexedDB, or Node-only IO.

Use this package in:

- React Native apps
- Capacitor / Cordova mobile apps
- Other mobile runtimes that provide `fetch`, Web Crypto, and the required web-compatible globals

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For browsers, use [`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client).

## Install

Install the `@bsv/sdk` peer dependency alongside this package:

```bash
npm install @bsv/wallet-toolbox-mobile @bsv/sdk
```

## Package targets

The package publishes:

- an ESM React Native/import target with source maps;
- a CommonJS require target with source maps;
- matching declarations for ESM and CommonJS;
- explicit `react-native`, `import`, and `require` export conditions.

The packed package is validated with Metro and compiled to optimized Hermes bytecode. Node.js 22 or newer is required for the published tooling and contributor workflow, not as an on-device runtime.

### Password derivation without WebAssembly

Argon2id password derivation uses `hash-wasm` when WebAssembly is available.
React Native engines such as Hermes that do not expose WebAssembly use an
asynchronously yielding JavaScript fallback with identical parameters and
output. Existing UMP v3 wallets remain compatible, and users do not need to
change a device setting or migrate their account.

### Optional native Argon2id backend

Import `registerArgon2idBackend`, `unregisterArgon2idBackend`, and the
`AsyncArgon2idBackend` type from this package's root export. Register a host
implementation only after verifying its interoperability; `isReady()` must
remain false until that verification succeeds. A ready backend is authoritative:
derivation errors and malformed output are surfaced without switching implementations.

Concurrent cold derivations share one background `preload()` attempt and keep
the portable path. Later calls can retry after that attempt settles. Hosts must
make `preload()` and `isReady()` reentrant and cache permanent failures or apply
backoff. Unregister the same backend object when the host no longer owns it.

## Remote storage example

```ts
import { Wallet, WalletSigner, WalletStorageManager, StorageClient, Services } from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTP is the default mobile-safe backend.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(new StorageClient(keyDeriver, 'https://storage.example.com'))
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

const { tx } = await wallet.createAction({
  description: 'mobile send',
  outputs: [{ satoshis: 1000, lockingScript: recipientScript }]
})
```

The mobile wallet includes the built-in BRC-177 `p nosend expiry` module. Its
active remote storage must run a migrated Wallet Toolbox 2.11-or-newer service
and default monitor, which owns expiry enforcement across restarts and devices.
Capability negotiation fails before prefunding against an older server. See
[the full expiry guide](../docs/no-send-expiry.md).

## Use cases

### Self-custody BSV wallet on a phone

Run the BRC-100 wallet entirely on-device, with remote storage for cross-device sync.

### Companion-app signer for a desktop wallet

Use mobile as the signer over a paired channel while a desktop runs the heavier services.

### Receive-only mobile app

Spin up a minimal wallet that watches for inbound payments via a remote storage backend.

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded                              | Why                                                           |
| ------------------------------------- | ------------------------------------------------------------- |
| `StorageKnex` (SQLite, MySQL)         | Native bindings unavailable on React Native / mobile WebViews |
| `StorageIdb`                          | IndexedDB is not a uniform React Native storage primitive     |
| Node-only filesystem and `os` helpers | Not available on mobile                                       |

The mobile entry includes `Wallet`, `WalletSigner`, `WalletStorageManager`, the mobile `StorageClient`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, `ArcSSEClient`, and related mobile-safe APIs. It does not export `StorageIdb`, `StorageKnex`, `SetupClient`, or test-only chain implementations.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

Prepared BEEF (COOK) persistence is a server-side Knex capability. Mobile
storage keeps the canonical BEEF path, while a compatible remote storage
server can enable prepared reads and writes without a mobile configuration or
wire-format change.

## CORS, CSP, and public services

This client does not impose an origin allowlist. Native mobile requests are not governed by browser CORS, while WebView and hybrid clients can be. A remote Storage service should remain reachable by its intended public apps, WUI, browser, extension, and mobile callers. Operators can keep public access enabled by default or configure an explicit allowlist when their deployment requires one; deployments should not assume a single calling domain.

CSP applies to WebViews or other embedding web applications. Add the service's HTTPS origin to the consuming application's `connect-src` policy. Keep authentication and authorization at the protocol/service layer instead of treating CORS as an authentication mechanism.

## Contributor checks

From the repository root, build the SDK and package before running the installed-consumer mobile gate:

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-mobile build
pnpm --filter @bsv/wallet-toolbox-mobile test:mobile
```

The gate installs the packed packages in a clean project, bundles them with Metro, checks the public export and mobile-safe module contracts, validates source maps, compiles the result with Hermes, and enforces compressed and uncompressed size budgets.

## License

This package is released under the [Open BSV License Version 6](./LICENSE.txt).
The accompanying [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
[LICENSES/](./LICENSES/) preserve earlier Open BSV grants compiled into the
mobile build.
