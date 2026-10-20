---
id: rabin-permission-module
title: '@bsv/rabin-permission-module'
kind: package
domain: wallet
npm: '@bsv/rabin-permission-module'
version: '0.1.0'
last_updated: '2026-10-20'
last_verified: '2026-10-20'
review_cadence_days: 30
status: experimental
tags: ['permissions', 'brc98', 'brc206', 'rabin']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/rabin-permission-module'
---

# @bsv/rabin-permission-module

`@bsv/rabin-permission-module` is the reference BRC-206 `p rabin` wallet module.
A `WalletPermissionsManager` routes every `p rabin` protocol to it. The only
accepted BRC-100 method is `encrypt`, used as a byte carriage for a modulus or
a Rabin signature.

## Install

```bash
npm install @bsv/rabin-permission-module @bsv/wallet-toolbox-client @bsv/sdk
```

## Setup

```ts
import { createRabinModule } from '@bsv/rabin-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const rabin = createRabinModule({
  keyDeriver: wallet.keyDeriver,
  authorize: async request => await showRabinPrompt(request)
})

const manager = new WalletPermissionsManager(wallet, adminOriginator, {
  permissionModules: { rabin }
})
```

`key` returns one minimal script-number push of the modulus. `sign` returns
two pushes: the principal CRT signature and the smallest padding below 65536.
Verification is Rúnar's equation
`(signature^2 + padding) mod n == LE(SHA-256(message))`. `decrypt` is rejected
because a square-root oracle would factor the modulus.

Keys are deterministic: BRC-42 under `p rabin <logicalProtocolID>`, then
HKDF-SHA256 with salt `BRC-206 p rabin v1`. Supported widths are 2048, 3072,
and 4096 bits. Authorization for levels 1 and 2, and for every privileged
request, happens before derivation. `dispose` and `lock` clear cached factors.

## License

Open BSV License version 6. See the package `LICENSE.txt`.
