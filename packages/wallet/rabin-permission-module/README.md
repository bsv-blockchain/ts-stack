# Rabin Permission Module

`@bsv/rabin-permission-module` implements the BRC-206 draft of the BRC-98
`p rabin` scheme. A wallet host registers it under the `rabin` scheme.
Applications request a modulus or a signature through the existing BRC-100
`encrypt` method. The ciphertext is an uninterpreted script-number carriage:
one push of `n` for `key`, or pushes of the signature and padding for `sign`.

## Install

```bash
npm install @bsv/rabin-permission-module @bsv/wallet-toolbox-client @bsv/sdk
```

## Protocol

```text
p rabin <key|sign> <2048|3072|4096> <logicalProtocolID>
```

The logical protocol ID is 5–382 bytes of lowercase ASCII words. The security
level, key ID, counterparty, privileged flag, and privileged reason stay in
their ordinary BRC-43 fields. `key` and `sign` for the same logical protocol,
key ID, counterparty, privilege, and modulus size share one Rabin key. The
factors come from BRC-42 followed by HKDF-SHA256 with salt `BRC-206 p rabin v1`.
Both primes are exactly half the modulus width, congruent to 3 mod 4, and pass
trial division through 4096 plus the sixteen fixed Miller-Rabin witnesses.

A signature is the principal CRT root for the smallest padding in
`0 <= padding < 65536` such that:

```text
(signature^2 + padding) mod n == LE(SHA-256(message))
```

That is the equation Rúnar checks on chain. `decrypt` is rejected: revealing a
square root of an arbitrary residue would factor `n`.

```ts
import {
  createRabinModule,
  decodeRabinKey,
  decodeRabinSignature
} from '@bsv/rabin-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const rabin = createRabinModule({
  keyDeriver: wallet.keyDeriver,
  authorize: async request => showRabinPrompt(request)
})

const manager = new WalletPermissionsManager(wallet, adminOriginator, {
  permissionModules: { rabin }
})

const key = await manager.encrypt(
  {
    protocolID: [2, 'p rabin key 2048 rabin oracle feed'],
    keyID: 'price',
    plaintext: [],
    counterparty: 'self'
  },
  'app.example'
)

const signed = await manager.encrypt(
  {
    protocolID: [2, 'p rabin sign 2048 rabin oracle feed'],
    keyID: 'price',
    plaintext: messageBytes,
    counterparty: 'self'
  },
  'app.example'
)

const modulus = decodeRabinKey(key.ciphertext)
const { signature, padding } = decodeRabinSignature(signed.ciphertext)
```

Security level 0 is implicit. Levels 1 and 2, and every privileged request,
require the `authorize` callback to return literal `true` before any key is
derived. Grants last five minutes by default, never more than 24 hours, and
are capped at 1,024 entries. At most 64 authorization prompts and 16 key
generations may be in flight, and at most 128 factorizations stay cached.
`dispose` and `lock` overwrite cached secret bytes.

The module is trusted wallet code. Applications receive `n`, the signature, and
the padding. They do not receive `p`, `q`, or the BRC-42 seed.

## Verification

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/rabin-permission-module typecheck
pnpm --filter @bsv/rabin-permission-module lint
pnpm --filter @bsv/rabin-permission-module test:coverage
pnpm --filter @bsv/rabin-permission-module test:property
pnpm --filter @bsv/rabin-permission-module build
pnpm --filter @bsv/rabin-permission-module pack:check
```

## License

Open BSV License version 6. See `LICENSE.txt`.
