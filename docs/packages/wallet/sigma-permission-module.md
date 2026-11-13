---
id: sigma-permission-module
title: '@bsv/sigma-permission-module'
kind: package
domain: wallet
npm: '@bsv/sigma-permission-module'
version: '0.1.0'
last_updated: '2026-11-13'
last_verified: '2026-11-13'
review_cadence_days: 30
status: experimental
tags: ['permissions', 'brc98', 'sigma', 'cryptography']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/sigma-permission-module'
---

# @bsv/sigma-permission-module

This source candidate declares SDK peer `^2.4.1 || ^3.0.0 || ^4.0.1`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

`@bsv/sigma-permission-module` is a BRC-98 wallet permission module for the
scheme `sigma`. A wallet host installs it under `permissionModules: { sigma }`;
applications then call the wallet's existing `encrypt` method and receive a
public point or a zero-knowledge proof in `{ ciphertext }`. The secret scalar
never leaves the wallet. This lets Bitcoin Script contracts that verify
Schnorr-style Sigma-protocol proofs ("s-puzzles") be unlocked with a
wallet-held key.

The specification is the `sigma` BRC (draft, not yet numbered).

The proof scalar is derived from the BRC-42 child key and is never the child
key itself (scalar isolation).

## Install

```bash
npm install @bsv/sigma-permission-module @bsv/wallet-toolbox-client @bsv/sdk
```

## Protocol

Applications call `encrypt` with a protocol name of this form inside the normal
BRC-43 `[securityLevel, protocolName]` tuple:

```text
p sigma <operation> <logicalProtocolID>
```

`operation` is one of `key`, `schnorr`, `dleq` or `or`. The logical protocol ID
is lowercase letters, digits and single spaces, 5 to 272 characters, and does
not end in ` protocol`. The key ID is 1 to 800 bytes of UTF-8. The counterparty,
privileged selection and privileged reason stay in their existing `encrypt`
fields. The wallet derives the BRC-42/43 child key for
`[securityLevel, "p sigma " + logicalProtocolID]`, the key ID and the
counterparty. The operation is not part of the derivation, so every operation
under one logical protocol proves statements about the same point.

```ts
const { ciphertext } = await wallet.encrypt(
  {
    protocolID: [0, 'p sigma key example payout'],
    keyID: 'member 1',
    plaintext: []
  },
  'app.example'
)
// ciphertext: the 33-byte compressed statement point P
```

The module is deterministic: the same request always returns the same bytes.

## Operations

The `plaintext` of the `encrypt` call is a byte array. The challenge is the
SHA-256 of the transcript, read as a little-endian integer, modulo the group
order.

| Operation | Plaintext                     | Result                                          | Transcript hashed for the challenge |
| --------- | ----------------------------- | ----------------------------------------------- | ----------------------------------- |
| `key`     | empty, or a 33-byte point `H` | `P` (33 bytes), or `x·H` (33 bytes); no proof   | none                                |
| `schnorr` | `ctx`                         | `R ‖ s` (96 bytes)                              | `R ‖ P ‖ ctx`                       |
| `dleq`    | `H ‖ ctx`                     | `P2 ‖ R1 ‖ R2 ‖ s` (224 bytes), with `P2 = x·H` | `R1 ‖ R2 ‖ P ‖ P2 ‖ H ‖ ctx`        |
| `or`      | `n ‖ i ‖ others ‖ ctx`        | `R_1…R_n ‖ s_1…s_n ‖ e_1…e_(n−1)`               | `R_1…R_n ‖ P_1…P_n ‖ ctx`           |

For `or`, `n` is one byte from 2 to 8 and `i` is one byte, the wallet's 1-based
position in the ring. `others` is the other `n − 1` points in ring order, and
the wallet inserts its own point `P` at position `i`. The last challenge is not
returned; the verifier derives it. A ring that already contains the wallet's
point is refused.

`ctx` is 1 to 4,096 application-chosen bytes and is opaque to the module.

### Encodings

- Points in a request are 33-byte compressed, on the curve and not the
  identity.
- Points in transcripts and in proof results are 64 bytes: x then y,
  big-endian.
- Scalars in results are 32 bytes, big-endian. They are not push-ready: an
  application converts them to script numbers before placing them in an
  unlocking script.
- `key` results are compressed. The application expands them where a contract
  takes 64 bytes.

## Wallet installation

Create the module with the wallet's ordinary `KeyDeriverApi` and an
authorization callback, then register it under the `sigma` scheme:

```ts
import { createSigmaModule } from '@bsv/sigma-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const sigma = createSigmaModule({
  keyDeriver: setup.keyDeriver,
  authorize: async request => {
    return await showTrustedWalletPrompt({
      originator: request.originator,
      protocol: request.logicalProtocolID,
      counterparty: request.counterparty,
      privileged: request.privileged,
      operation: request.operation,
      contextSha256: request.contextSha256
    })
  },
  privilegedKeyDeriver: async reason => {
    return await acquirePrivilegedKeyDeriver(reason)
  },
  authorizationTTL: 5 * 60 * 1000
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { sigma }
})
```

`authorizationTTL` is the duration of a successful grant in milliseconds and
defaults to five minutes. Call `sigma.dispose()` when the host tears down the
wallet; it clears cached and pending authorization state.

## Security and permissions

Permissions follow the same model as the ECPM module:

- Security level 0 requests that are not privileged need no prompt.
- Level 1 requires the authorization callback, scoped to the originator and
  the logical protocol.
- Level 2 adds the counterparty to the scope.
- Privileged requests always require authorization, and a privileged grant is
  scoped to the approved `privilegedReason`, separate from non-privileged
  grants.
- `seekPermission: false` fails unless an applicable grant is already cached.

A grant is not scoped by operation or context. Once granted, it covers every
operation and any context under that logical protocol until it expires. The
`operation` and `contextSha256` fields of an authorisation request are
information for the prompt, not a limit on what the grant allows.

A proof spends whatever was locked to the statement point. An application with
a grant can therefore spend those outputs.

Only `encrypt` is accepted in the `p sigma` namespace. Every other method, and
any basket or label beginning `p sigma`, is refused. Authorization precedes key
derivation. The module is trusted wallet code: applications never receive a key
deriver or a private scalar.

## Verifying proofs

The package exports the pure verifiers so that a contract author or test can
check a result off-chain. They take parsed points; `parsePoint33` and `point64`
convert between the encodings above.

```ts
import { Utils } from '@bsv/sdk'
import { parsePoint33, verifySchnorr } from '@bsv/sigma-permission-module'

const ctx = Utils.toArray('payout 7', 'utf8')

const key = await wallet.encrypt(
  { protocolID: [0, 'p sigma key example payout'], keyID: 'member 1', plaintext: [] },
  'app.example'
)
const proof = await wallet.encrypt(
  { protocolID: [0, 'p sigma schnorr example payout'], keyID: 'member 1', plaintext: ctx },
  'app.example'
)

const P = parsePoint33(key.ciphertext, 'P')
verifySchnorr(P, ctx, proof.ciphertext) // true
```

`verifyDleq(P, H, ctx, result)` and `verifyOr(ring, ctx, result)` check the
other two proofs the same way.

## Module interface

| Export                  | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `SigmaPermissionModule` | The module class; implements `PermissionsModule`.                               |
| `createSigmaModule`     | Creates a module from `SigmaPermissionModuleOptions`.                           |
| `verifySchnorr`         | Verifies a `schnorr` result against `P` and `ctx`.                              |
| `verifyDleq`            | Verifies a `dleq` result against `P`, `H` and `ctx`.                            |
| `verifyOr`              | Verifies an `or` result against the ring and `ctx`.                             |
| `parsePoint33`          | Parses a 33-byte compressed point, rejecting the identity and off-curve points. |
| `point64`               | Encodes a point as 64 bytes, x then y, big-endian.                              |

The types `SigmaPermissionModuleOptions`, `SigmaAuthorizationRequest`,
`SigmaAuthorizationHandler`, `SigmaKeyDeriver`, `SigmaPrivilegedKeyDeriver` and
`SigmaOperation` are exported too.

## Verification

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/sigma-permission-module typecheck
pnpm --filter @bsv/sigma-permission-module lint
pnpm --filter @bsv/sigma-permission-module test:coverage
pnpm --filter @bsv/sigma-permission-module test:property
pnpm --filter @bsv/sigma-permission-module build
pnpm --filter @bsv/sigma-permission-module pack:check
```

## License

Apache License 2.0. See `LICENSE`.
