# Rabin Permission Module

`@bsv/rabin-permission-module` implements the BRC-206 `p rabin` semantic module
for BRC-100 wallets. It lets an application obtain a wallet-held Rabin public
key and Rabin signatures over arbitrary data, for verification in Bitcoin
Script, without adding a method or wire call to the fixed BRC-100 interface.
The Rabin private key is derived from the wallet's BRC-42/43 root and never
leaves the wallet.

## Protocol

Applications call the existing `encrypt` method with:

```text
p rabin <key|sign> <2048|3072|4096> <logicalProtocolID>
```

The logical protocol ID is 5–272 lowercase ASCII bytes. The complete dispatch
envelope is at most 289 bytes for `key` and 290 bytes for `sign`. The security
level stays in the normal BRC-43 tuple; the key ID, counterparty, privileged
selection, privileged reason, and permission behavior stay in their existing
`encrypt` fields. `plaintext` must be empty for `key` and is the message for
`sign` (up to 1 MiB by default).

```ts
const key = await wallet.encrypt({
  protocolID: [2, 'p rabin key 3072 price oracle'],
  keyID: 'btc usd',
  plaintext: []
})

const signed = await wallet.encrypt({
  protocolID: [2, 'p rabin sign 3072 price oracle'],
  keyID: 'btc usd',
  plaintext: message
})
```

Both calls derive the seed from `p rabin price oracle`, so `key` and `sign`
address the same Rabin key. The operation and key size are not part of the
BRC-42 invoice; one derived seed produces the key of each size.

The `ciphertext` is not a BRC-2 ciphertext. It is a sequence of fields, each a
2-byte little-endian length followed by a minimally encoded non-negative
Bitcoin Script number: `[n]` for `key`, `[sig, padding]` for `sign`. The
values are exactly the Script pushes that Rúnar's `verifyRabinSig` consumes:

```ts
import { decodeKeyResult, decodeSignResult, verify } from '@bsv/rabin-permission-module'

const n = decodeKeyResult(key.ciphertext)
const { sig, padding } = decodeSignResult(signed.ciphertext)
verify(message, sig, padding, n) // (sig² + padding) mod n == LE(SHA-256(message))
```

## Installation

Create the module with the wallet's ordinary `KeyDeriverApi` and an
authorization callback, then register it under the `rabin` scheme:

```ts
import { createRabinModule } from '@bsv/rabin-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const rabin = createRabinModule({
  keyDeriver: setup.keyDeriver,
  authorize: async request => {
    return await showTrustedWalletPrompt({
      originator: request.originator,
      protocol: request.logicalProtocolID,
      operation: request.operation,
      bits: request.bits,
      keyID: request.keyID,
      messageSha256: request.messageSha256
    })
  },
  privilegedKeyDeriver: async reason => {
    return await acquirePrivilegedKeyDeriver(reason)
  }
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { rabin }
})
```

Call `rabin.dispose()` when the wallet locks or the host tears it down. The
method clears grants, pending prompts, in-flight key generations, and cached
keys.

Security level 0 ordinary requests do not prompt. Levels 1 and 2 require the
authorization callback; a grant is scoped to the originator, logical protocol,
and ordinary-versus-privileged root, and at level 2 also to the counterparty.
The key ID, operation, key size, and message do not change the grant scope;
they are passed to the callback for display. Every privileged request requires
authorization regardless of security level, and privileged grants are scoped to
the exact `privilegedReason`. Without a `privilegedKeyDeriver`, privileged
requests fail before any prompt. `seekPermission: false` fails unless an
applicable grant is already cached. Concurrent requests with the same scope
share one prompt. Grants are capped at 1,024 entries and pending prompts at 64.

## Key generation and caching

Key generation is deterministic: HKDF-SHA256 expands the 32-byte derived
scalar, and each prime is the first candidate `x, x + 4, x + 8, …` that has no
factor below 2^16 and passes Miller–Rabin for the first 32 prime bases. A
3072-bit key takes roughly a second of CPU in a JavaScript runtime, so ordinary
keys are cached in memory (32 by default, `maxCachedKeys` up to 1,024) under
the full derivation identity, and concurrent first requests for one key share a
single generation. Generation is synchronous and therefore serialized; a host
that must keep a UI thread responsive should run the wallet off that thread.
Privileged keys are never cached.

Key material is derived only after authorization succeeds.

## Security model

The module:

- accepts only `encrypt` in the `p rabin` namespace and rejects `decrypt`,
  which would be a square-root oracle that factors `n`, and every other method;
- seeds Rabin keys only from BRC-42 private-key derivation, never from a value
  a counterparty can compute;
- returns the canonical signature, the smallest valid padding with the CRT of
  the principal square roots, so repeated requests never reveal a second root;
- checks every signature before returning it;
- validates public-key counterparties canonically (lowercase, compressed,
  x below the field prime, on the curve);
- isolates ordinary and privileged derivation providers; and
- returns only `n` or `(sig, padding)`, never the seed, a prime, or a
  derivation capability.

BigInt arithmetic in JavaScript is not constant-time. Signing time depends on
the primes; avoid exposing fine-grained signing latency to untrusted callers
where that is practical.

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

The tests reproduce every BRC-206 conformance vector byte for byte
(`src/__tests__/fixtures/brc206-vectors.json`). `scripts/verify-runar.mjs`
additionally runs each signature through the `verifyRabinSig` sequence emitted
by the Rúnar compiler in Rúnar's Script VM. Rúnar is not a dependency, so the
check is opt-in:

```bash
RUNAR_NODE_MODULES=/path/to/node_modules pnpm --filter @bsv/rabin-permission-module test:runar
```

## License

Open BSV License version 6. See `LICENSE.txt`.
