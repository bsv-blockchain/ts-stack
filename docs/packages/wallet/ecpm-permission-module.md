---
id: ecpm-permission-module
title: '@bsv/ecpm-permission-module'
kind: package
domain: wallet
npm: '@bsv/ecpm-permission-module'
version: '0.1.0'
last_updated: '2026-08-30'
last_verified: '2026-08-30'
review_cadence_days: 30
status: experimental
tags: ['permissions', 'brc98', 'ecpm', 'cryptography']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/ecpm-permission-module'
---

# @bsv/ecpm-permission-module

`@bsv/ecpm-permission-module` is the reference `p ecpm` semantic module for
BRC-100 wallet hosts. It applies or removes a wallet-derived scalar from an
arbitrary validated secp256k1 point while retaining the standard
`getPublicKey` request and response shapes.

Use this package when a protocol needs commutative point masking or another
point operation whose base is supplied by the application. Pure BRC-43 can
name a counterparty while deriving the scalar, but ordinary `getPublicKey`
still returns that scalar times the fixed generator; it cannot select the
caller's point as the multiplication base.

## Install

```bash
npm install @bsv/ecpm-permission-module @bsv/wallet-toolbox-client @bsv/sdk
```

## Protocol

Call the existing `getPublicKey` method with this protocol name inside the
normal `[securityLevel, protocolName]` tuple:

```text
p ecpm <apply|remove> <pointHex> <logicalProtocolID>
```

The module reads `keyID`, `counterparty`, `privileged`, `privilegedReason`, and
`seekPermission` from their existing fields. It derives the scalar under
`p ecpm <logicalProtocolID>`; the operation and point are deliberately omitted
so `remove` uses the inverse of the exact scalar selected by `apply`.

```typescript
const masked = await wallet.getPublicKey({
  protocolID: [2, `p ecpm apply ${pointHex} mental poker deal`],
  keyID: 'deck mask',
  counterparty: 'self'
})

const restored = await wallet.getPublicKey({
  protocolID: [2, `p ecpm remove ${masked.publicKey} mental poker deal`],
  keyID: 'deck mask',
  counterparty: 'self'
})
```

## Wallet installation

```typescript
import { createEcpmModule } from '@bsv/ecpm-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const ecpm = createEcpmModule({
  keyDeriver: setup.keyDeriver,
  authorize: request => showTrustedWalletPrompt(request),
  privilegedKeyDeriver: reason => acquirePrivilegedKeyDeriver(reason)
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { ecpm }
})
```

The privileged provider is optional. If an application requests
`privileged: true`, the module authorizes the supplied reason before asking the
host for a privileged deriver and fails closed when no provider is available.

## Security and permissions

- Only `getPublicKey` is accepted under `p ecpm`; signing, HMAC, and encryption
  calls cannot reuse the ECPM-derived scalar.
- Identity-key and `forSelf` modes are rejected.
- Input points and public-key counterparties must be canonical lowercase,
  compressed, finite secp256k1 points.
- Security level 0 ordinary calls do not prompt. Levels 1 and 2 require the
  authorization callback; level 2 grants are scoped to the counterparty.
- Every privileged call requires authorization. Cached and concurrent grants
  are scoped to the exact approved `privilegedReason`, so a different reason
  cannot reuse the approval. `seekPermission: false` fails unless an applicable
  grant is already cached.
- The application receives only `{ publicKey }`, never the derived scalar or
  either key-derivation provider.

## Module interface

Wallet Toolbox exposes the optional
`PermissionsModule.handleRequest(request, next)` semantic hook. A module can
return the standard BRC-100 result directly, as ECPM does, or call `next` at
most once. Existing `onRequest`/`onResponse` transformation modules remain
compatible.
