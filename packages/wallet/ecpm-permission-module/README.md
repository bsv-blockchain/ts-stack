# ECPM Permission Module

`@bsv/ecpm-permission-module` implements the BRC-229 `p ecpm` semantic module
for BRC-100 wallets. It applies or removes a BRC-42/43-derived scalar to an
arbitrary validated secp256k1 point without adding a method or wire call to the
fixed BRC-100 interface.

## Protocol

Applications call the existing `getPublicKey` method with:

```text
p ecpm <apply|remove> <pointHex> <logicalProtocolID>
```

The logical protocol ID is 5–273 ASCII bytes. The complete dispatch envelope
may be 353 bytes for `apply` or 354 bytes for `remove`; this preserves the full
BRC-43 logical protocol namespace while remaining inside BRC-100's 400-byte
protocol-string limit.

The security level remains in the normal BRC-43 tuple. The key ID,
counterparty, privileged selection, privileged reason, and permission behavior
remain in their existing `getPublicKey` fields.

```ts
const applied = await wallet.getPublicKey({
  protocolID: [2, `p ecpm apply ${pointHex} mental poker deal`],
  keyID: 'deck mask',
  counterparty: 'self'
})

const removed = await wallet.getPublicKey({
  protocolID: [2, `p ecpm remove ${applied.publicKey} mental poker deal`],
  keyID: 'deck mask',
  counterparty: 'self'
})
```

For both calls, the module derives the scalar under the canonical namespace
`p ecpm mental poker deal`. The operation and point are deliberately excluded
from the BRC-42 invoice so every point uses the same scalar and `remove`
selects the inverse of the scalar used by `apply`.

## Installation

Create the module with the wallet's ordinary `KeyDeriverApi` and an
authorization callback, then register it under the `ecpm` scheme:

```ts
import { createEcpmModule } from '@bsv/ecpm-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const ecpm = createEcpmModule({
  keyDeriver: setup.keyDeriver,
  authorize: async request => {
    return await showTrustedWalletPrompt({
      originator: request.originator,
      protocol: request.logicalProtocolID,
      counterparty: request.counterparty,
      privileged: request.privileged
    })
  },
  privilegedKeyDeriver: async reason => {
    return await acquirePrivilegedKeyDeriver(reason)
  }
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { ecpm }
})
```

Call `ecpm.dispose()` when the host tears down the wallet. The method clears
cached and pending authorization state.

Security level 0 primary-key requests do not prompt. Levels 1 and 2 require
the authorization callback, with level 2 grants scoped to the counterparty.
Every privileged request requires authorization regardless of security level,
and cached or in-flight privileged grants are scoped to the exact approved
`privilegedReason`. Changing the reason requires a separate authorization.
`seekPermission: false` fails unless an applicable grant is already cached.

## Security model

The module:

- accepts only `getPublicKey` in the `p ecpm` namespace, preventing the same
  derived key from being reused for signatures, HMACs, or BRC-2 encryption;
- rejects identity-key and `forSelf` requests;
- keeps the point and operation outside the derived-key identity;
- isolates ordinary and privileged derivation providers;
- checks the encoded x coordinate before parsing so a reducing parser cannot
  accept a non-canonical point;
- accepts only finite, on-curve, lowercase compressed secp256k1 points; and
- returns the existing `{ publicKey }` result shape, so no BRC-100 wire change
  is required.

The module is trusted wallet code. Applications never receive a key deriver or
private scalar. A privileged provider should acquire protected key material
only after its reason has been displayed and authorized, and should retain it
for no longer than the host wallet's existing privileged-key policy permits.

## Verification

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/ecpm-permission-module typecheck
pnpm --filter @bsv/ecpm-permission-module lint
pnpm --filter @bsv/ecpm-permission-module test:coverage
pnpm --filter @bsv/ecpm-permission-module test:property
pnpm --filter @bsv/ecpm-permission-module build
pnpm --filter @bsv/ecpm-permission-module pack:check
```

## License

Open BSV License version 6. See `LICENSE.txt`.
