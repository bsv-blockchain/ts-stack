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
tags: ['permissions', 'brc98', 'rabin', 'cryptography']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/rabin-permission-module'
---

# @bsv/rabin-permission-module

This source candidate declares SDK peer `^2.4.1 || ^3.0.0 || ^4.0.0`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

`@bsv/rabin-permission-module` is the reference `p rabin` semantic module
(BRC-206) for BRC-100 wallet hosts. It returns a wallet-held Rabin public key,
or a Rabin signature over arbitrary data, through the standard `encrypt`
request and `{ ciphertext }` result.

Use this package when a contract must verify a signature over application data,
such as an oracle value or a game move. Bitcoin Script has no data-signature
opcode; Rabin verification is `(sig² + padding) mod n == SHA-256(message)`, a
few arithmetic opcodes. The module keeps the Rabin private key in the wallet,
derived from the BRC-42/43 root, instead of in the application.

## Install

```bash
npm install @bsv/rabin-permission-module @bsv/wallet-toolbox-client @bsv/sdk
```

## Protocol

Call the existing `encrypt` method with this protocol name inside the normal
`[securityLevel, protocolName]` tuple:

```text
p rabin <key|sign> <2048|3072|4096> <logicalProtocolID>
```

The module reads `keyID`, `counterparty`, `privileged`, `privilegedReason`, and
`seekPermission` from their existing fields. `plaintext` is empty for `key` and
is the message for `sign`. The seed is derived under `p rabin
<logicalProtocolID>`; the operation and key size are not part of the
derivation, so `key` and `sign` address the same key.

```typescript
const key = await wallet.encrypt({
  protocolID: [2, 'p rabin key 2048 price oracle'],
  keyID: 'btc usd',
  plaintext: []
})

const signed = await wallet.encrypt({
  protocolID: [2, 'p rabin sign 2048 price oracle'],
  keyID: 'btc usd',
  plaintext: message
})
```

The `ciphertext` is not a BRC-2 ciphertext. It holds length-prefixed, minimally
encoded Script numbers: `n` for `key`, and `sig` then `padding` for `sign`.
These are the exact pushes for Rúnar's `verifyRabinSig`. Use
`decodeKeyResult`, `decodeSignResult`, and `verify` to check a signature
off chain.

## Wallet installation

```typescript
import { createRabinModule } from '@bsv/rabin-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const rabin = createRabinModule({
  keyDeriver: setup.keyDeriver,
  authorize: request => showTrustedWalletPrompt(request),
  privilegedKeyDeriver: reason => acquirePrivilegedKeyDeriver(reason)
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { rabin }
})
```

The privileged provider is optional. Without one, privileged requests fail
before any prompt. With one, the module authorizes the supplied reason before
asking the host for a privileged deriver.
Call `rabin.dispose()` when the wallet locks.

## Security and permissions

- Only `encrypt` is accepted under `p rabin`. `decrypt` would compute square
  roots of caller-chosen values, which factors `n`; it and every other method
  are rejected.
- Signatures are canonical (smallest padding, CRT of the principal roots), so a
  repeated request never reveals a second square root.
- Security level 0 ordinary calls do not prompt. Levels 1 and 2 require the
  authorization callback; level 2 grants are scoped to the counterparty.
  Every privileged call requires authorization, scoped to the exact reason.
  `seekPermission: false` fails unless an applicable grant is already cached.
- Keys are derived and generated only after authorization. Generation takes
  about 0.4 s (2048), 1.2–1.8 s (3072) and 3.5 s (4096) median, with
  outliers several times longer. It runs in slices of a few milliseconds
  between which the event loop runs, one generation at a time with at most 8
  admitted; further requests fail at once with `RABIN: key generation is busy`.
- Signatures also run one at a time, at most 16 admitted
  (`RABIN: signing is busy` beyond that); this keeps the host responsive and is
  not a rate limit.
- Uncached generations are rate-limited per originator (4, then one per 15 s)
  and overall (10, then one per 6 s), after authorization and before
  derivation: `RABIN: key generation rate limit exceeded`. Cached keys and
  signing are not limited.
- Keys are cached in memory, 32 in all and at most 8 per originator, so one
  application cannot evict every other application's keys.
- Forgery resistance is about 2^112 for every key size, because verification
  uses the unreduced 256-bit digest; use 2048 or 3072 bits.
- `p rabin` baskets and labels are refused: the scheme defines none, and the
  toolbox would otherwise route them past its basket and label checks.
- The application receives only `n` or `(sig, padding)`, never the seed, a
  prime, or a key-derivation provider.

## Module interface

Wallet Toolbox exposes the optional
`PermissionsModule.handleRequest(request, next)` semantic hook. The Rabin module
returns its result directly and never calls `next`; forwarding to ordinary
`encrypt` would produce a BRC-2 ciphertext, not a Rabin value.
