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

The logical protocol ID is 5–272 lowercase ASCII bytes and the key ID 1–800
UTF-8 bytes. The complete dispatch envelope is at most 289 bytes for `key` and
290 bytes for `sign`. The security
level stays in the normal BRC-43 tuple; the key ID, counterparty, privileged
selection, privileged reason, and permission behavior stay in their existing
`encrypt` fields. `plaintext` must be empty for `key` and is the message for
`sign` (up to 1 MiB by default).

```ts
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

### Choosing a key size

Use 2048 bits, or 3072 if you want more margin against factoring. Forgery
resistance does not grow with the key: verification compares against the
unreduced 256-bit digest and allows a padding below 2^16, so a forger who
ignores the key needs about 2^112 hash evaluations whatever the size. 2048 bits
matches that bound; 4096 bits adds only factoring margin, at about 3.5 s median
key generation and twice the on-chain data.

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

The logical protocol, key ID and privileged reason in the request are chosen by
the app. A prompt that shows them should neutralise control, format and
bidirectional-override characters, truncate long values and set them apart from
the wallet's own words, so an app cannot write text that reads as the wallet's.

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
share one prompt. Grants are capped at 1,024 entries and pending prompts at 64
overall and 4 per originator.

## Scheduling, caching and resource use

Key generation is deterministic: HKDF-SHA256 expands the 32-byte derived
scalar, and each prime is the first candidate `x, x + 4, x + 8, …` that has no
factor below 2^16 and passes Miller–Rabin for the first 32 prime bases. Measured
on an Apple M-series machine with Node 24 it takes about 0.4 s median (2 s worst
seen) for 2048 bits, 1.2–1.8 s median (3.5 s) for 3072 bits and 3.5 s median
(16 s) for 4096 bits. Because a level-0 request needs no prompt, an app can ask
for fresh keys at will, so the module bounds the work:

- **Responsiveness.** Generation and signing run cooperatively: the
  arithmetic pauses every few dozen exponent bits, and control returns to the
  event loop whenever a slice has used about 4 ms (`scheduler.yield()` where
  available, `setImmediate` in Node, otherwise a `MessageChannel` message;
  never `setTimeout`). Measured slices stay under 10 ms, and the results are
  identical to synchronous generation.
- **Concurrency.** One generation runs at a time; at most 8 keys
  (`maxPendingGenerations`) are admitted, the running one included, and
  served in order. A request for a key that is already being generated or
  waiting joins it. A request that cannot be admitted fails at once, and one
  that waits longer than 60 s (`generationQueueTimeout`) fails, with
  `RABIN: key generation is busy`.
- **Signing.** A signature costs a few milliseconds per exponentiation, so
  signatures also run one at a time, in the same kind of slices; at most 16
  (`maxPendingSignatures`) are admitted and further ones fail at once with
  `RABIN: signing is busy`. This bounds responsiveness under a flood; it is not
  a rate limit, and signing is not rate-limited.
- **Rate limits.** Only cache misses count; cached keys, joined requests and
  signing are free. Each originator may start 4 generations in a burst and
  regains one every 15 s; all originators together may start 10 and regain one
  every 6 s (`originatorGenerationBurst`, `originatorGenerationInterval`,
  `globalGenerationBurst`, `globalGenerationInterval`). The limits are checked
  after authorization and before derivation, so a throttled request derives
  nothing, caches nothing and costs no prompt; it fails with
  `RABIN: key generation rate limit exceeded`.
- **Caching.** Ordinary keys are cached in memory under the full derivation
  identity: 32 keys (`maxCachedKeys`, up to 1,024), of which the keys one
  originator's requests generated may hold at most 8
  (`maxCachedKeysPerOriginator`). At that share the originator's own least
  recently used key is evicted; at capacity the overall least recently used
  key is. Evicted keys are overwritten. Privileged keys are never cached.

Per-originator limits trust the originator the host reports. Where that is an
unauthenticated claim, such as the HTTP `Origin` header on a local port, a
local process can present a new originator for every request; the global limit,
the queue and the cache share are what protect the wallet then.

Key material is derived only after authorization succeeds. `dispose()` fails
waiting generations, stops a running generation or signature at its next
slice, and overwrites and drops the cached keys.

Memory hygiene: the host's key deriver is outside the module's reach. A
`CachedKeyDeriver` keeps every derived child key, including each Rabin seed,
for the wallet session; only discarding the deriver releases them.

## Baskets and labels

The scheme defines no baskets or labels. Wallet Toolbox hands `p rabin …`
baskets and labels of `createAction`, `internalizeAction` and `listActions` to
the module's `onRequest`/`onResponse` instead of its own basket and label
permission checks, so both hooks refuse every request with
`RABIN: p rabin baskets and labels are not supported`. `listOutputs` and
`relinquishOutput` on a `p rabin` basket reach `handleRequest`, which accepts
only `encrypt`.

## Errors

Every error the module raises starts with `RABIN:` and names the rejected
field or capability without key material, and never reveals whether a key was
cached. Busy (`RABIN: key generation is busy`, `RABIN: signing is busy`) and rate-limited
(`RABIN: key generation rate limit exceeded`) are distinct from denial
(`RABIN: user denied permission`) and from invalid input, so an app can retry
the first two later. Errors thrown by the host's key deriver, privileged key
provider or authorization callback propagate unchanged.

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
