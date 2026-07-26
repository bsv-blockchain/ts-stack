# @bsv/verifast

Real BSV BDK script verification in WebAssembly for `@bsv/sdk`. One package
supports Node ESM, CommonJS, browser/worker ESM, and classic-script/UMD clients.

## Transaction verification

The validated WASM module is bundled and loaded lazily. Keep one verifier for a
stream or batch so module initialization is paid once. Transaction integration
defaults to adaptive routing: a cold module never delays verification, scripts
strictly larger than 100 bytes and scripts containing `CHECKSIG` or
`CHECKMULTISIG` variants use WASM once it is ready, and smaller non-cryptographic
scripts retain the SDK's JavaScript interpreter.

SDK transaction-graph verification supplies explicit consensus context, so
transaction version never selects policy versus consensus rules. Direct Spend
calls that omit context retain compatibility policy routing: version-1
non-standard scripts stay on the TypeScript interpreter. Calls with an explicit
SDK script-memory limit also stay on the TypeScript interpreter because this
WASM ABI cannot enforce that caller-supplied resource budget.

```ts
import { Transaction } from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'

const verifier = new BdkVerifier()
const tx = Transaction.fromEF(extendedFormatBytes)

// Start this during application or wallet initialization when first-call WASM
// performance matters. Auto routing otherwise warms in the background.
await verifier.preload()
const valid = await tx.verify('scripts only', undefined, undefined, verifier)
```

`isReady()` is synchronous, so latency-sensitive code can inspect readiness
without awaiting initialization. Adaptive selection happens before backend
execution; after WASM is selected, errors remain strict and never retry through
the JavaScript interpreter. Use `{ mode: 'always' }` when every call must await
and use WASM regardless of script shape or cold-start state.

When EF bytes are already available, bypass transaction serialization entirely:

```ts
const valid = await verifier.verifyScriptsFromEF({
  extendedTransaction: efBytes,
  utxoHeights: [800000],
  blockHeight: 943816,
  consensus: true
})
```

`Transaction.toEFBinary()` memoizes a typed EF representation and automatically
invalidates it when transaction or referenced source-output state changes.
Treat that returned view as immutable and call `.slice()` when independently
mutable bytes are required. `toEFUint8Array()` is an equivalent typed alias;
legacy `toEF()` continues to return `number[]`. Script changes should use the
SDK's mutation methods or replace `script.chunks`; mutating a returned
`ScriptChunk` object in place bypasses the Script layer's serialization-cache
invalidation.

## Spend and batch verification

Call the same backend from code that already constructs SDK `Spend` objects:

```ts
const valid = await spend.validateWith(verifier, { consensus: true })
// Equivalent direct form:
const sameVerdict = await verifier.verifySpend(spend, { consensus: true })
```

`validateWith` applies the same adaptive policy as transaction verification.
The Spend path serializes an ordinary transaction and supplies the active
source output separately, so it does not construct or parse EF ancestry.
Explicit `Spend.verifyFlags` are preserved; otherwise BDK calculates flags from
the configured network and heights. Pass `{ consensus: true }` when validity is
being established and `{ consensus: false }` for policy checks; omitting the
context preserves compatibility behavior only.

Packed batch methods cross the JS/WASM boundary once per bounded chunk:

```ts
const txVerdicts = await verifier.verifyScriptsBatchFromEF(items)
const spendVerdicts = await verifier.verifySpendsBatch(
  spends.map(spend => ({ spend }))
)
```

On machines with enough logical cores, batches of at least 32 items can use a
fixed pool of up to four workers. Workers are created lazily and are never used
for a single verification. Explicitly warm the batch lane before a
latency-sensitive workload:

```ts
const verifier = new BdkVerifier({ batchWorkers: 4 })
await verifier.preloadBatch()
const verdicts = await verifier.verifyScriptsBatchFromEF(items)
```

The main instance generates libsecp256k1's 1 MiB W15 verification tables once.
Workers import that snapshot instead of regenerating it. `SharedArrayBuffer` is
used opportunistically when available; ordinary structured cloning remains the
browser-compatible fallback and does not require cross-origin isolation. Call
`dispose()` when a short-lived verifier no longer needs its warm pool. Disposal
is final; later calls reject instead of silently creating new workers.

The default limits are 256 items and 32 MiB of input data per chunk and can be
lowered with `maxBatchItems` and the soft aggregate `maxBatchBytes` target.
An individual item larger than that target is processed alone rather than
rejected. Packing principally reduces
marshalling and orchestration overhead; ECDSA remains the dominant cost for
large signature-heavy batches. Spend items sharing the same transaction input
and output arrays serialize that transaction once before packing. The soft byte
target then prevents a multi-input, multi-megabyte transaction from being
duplicated into one unbounded packed allocation.

## Generic cryptography and SDK integration

The same compact module exposes generic, direct-byte secp256k1 operations:

```ts
const signature = await verifier.signDigest(privateKey32, digest32)
const valid = await verifier.verifyDigest(publicKey, digest32, signature)
const verdicts = await verifier.verifyDigestBatch(items)
const publicKey = await verifier.publicKeyFromPrivate(privateKey32)
const sharedPoint = await verifier.multiplyPublicKey(publicKey, scalar32)
const tweakedPublic = await verifier.tweakPublicKeyAdd(publicKey, tweak32)
const tweakedPrivate = await verifier.tweakPrivateKeyAdd(privateKey32, tweak32)
```

These operations accept and return `Uint8Array` values without JSON, `number[]`,
or per-item JS/WASM calls. Importing and constructing the default verifier also
registers a warm-only optional backend with `@bsv/sdk`. Existing synchronous
primitive APIs do not change. Existing asynchronous wallet, BRC-42, P2PKH, and
authentication composition uses a supported WASM operation only after the
module is ready; the current call retains JavaScript while a cold module warms
in the background. Scalar-only private BRC-42 derivation deliberately remains
in TypeScript because it is already faster than a WASM boundary.

## Networks

Select a network once when constructing the verifier:

```ts
const verifier = new BdkVerifier({ network: 'ttn' })
```

Supported names are `main`, `test`, `stn`, `regtest`, `tstn`, and TeraTestNet
under `ttn`, `teratestnet`, or the commonly used `terratestnet` spelling.
TeraTestNet and Tera Scaling Test Network (`tstn`) have distinct BDK network
IDs and activation parameters.

## Runtime formats

Package conditional exports select Node or browser glue automatically:

```js
// Node ESM
import { BdkVerifier } from '@bsv/verifast'

// Node CommonJS; methods remain asynchronous
const { BdkVerifier } = require('@bsv/verifast')
```

Browser ESM contains no Node imports and works in window and worker targets.
For classic scripts, load `dist/src/wasm/bdk-core.umd.js`, then
`dist/umd/verifast.js`; the slim classic loader locates
`dist/src/wasm/bdk-core.umd.wasm`. The wrapper uses SDK types without rebundling
the SDK implementation. Worker scheduling and its internal table-snapshot ABI
remain in the full ESM/worker artifact, so the classic path ships only the
public typed verifier and cryptography APIs. The build rejects a complete
classic-script payload over 300,000 bytes, counting both loaders and WASM; the
current payload is 298,567 bytes.

An optional custom WASM factory remains supported:

```ts
const verifier = new BdkVerifier(async () => await createMyBdkModule())
```

## Verdicts and diagnostics

Direct boolean methods return `true` for BDK domain `0` and `false` for script or DoS
failures (domains `1` and `2`). BDK exception responses, malformed results, and
unknown ABI domains throw `BdkVerificationError`; loading and marshalling errors
also propagate. Automatic SDK/Spend routing may decline the backend before it
starts; the selected backend itself never silently falls back to the TypeScript
interpreter.

Detailed methods return the underlying `{ domain, code }` pair:

```ts
const result = await verifier.verifyScriptsDetailed({
  tx,
  blockHeight: 943816,
  consensus: true
})
```

Flag names map directly to the pinned BSV `script_flags.h`, including
`MINIMALIF`, `NULLFAIL`, compressed-key, Genesis, and Chronicle bits. Unknown
names throw rather than being ignored.

## Reproducibility and validation

The bundled module is built from BDK 1.2.2 at `bitcoin-sv/bdk` commit
`6d1e8092e8a9917d2544cddc9e20c6dc38242d93`, plus `bitcoin-sv` commit
`879fc8b42168dd0e608dafd51b39c6dabad37d4d`, Emscripten 4.0.23, and Boost
1.85.0. The verifier-only target does not link OpenSSL. The main and classic
WASM binaries have SHA-256 hashes
`35bb36ee9732ff0432ca3b194f69b132aa4d555ba81fc28c6d922b38cd914189` and
`a840c115b4f9297d33423712983ee95e294adf1056a946dd27c94f93253ceb75`;
the build verifies every pinned generated artifact before copying it. BDK's
`module/typesbdk/wasm/build.sh` verifies pinned inputs, performs a clean build,
runs libsecp256k1's verified, non-verified, and exhaustive WASM tests, then
validates the vector, typed, transaction-batch, Spend, and Spend-batch ABIs
through all three loaders.

```bash
pnpm --filter @bsv/verifast typecheck
pnpm --filter @bsv/verifast build
pnpm --filter @bsv/verifast test
pnpm --filter @bsv/verifast test:consumers
pnpm --filter @bsv/verifast bench
pnpm --filter @bsv/verifast bench:batch
pnpm --filter @bsv/verifast bench:crypto
pnpm --filter @bsv/verifast bench:warmup
```

The deterministic corpus compares positive and negative SDK-interpreter
verdicts with real BDK WASM for whole transactions and individual Spend objects.
Consumer tests execute the built package through Node ESM, CommonJS, browser
ESM, and browser UMD rather than substituting mocks.

On the retained Apple M3 Max baseline, BDK is 16–20x faster in Node and 12–15x
faster in Chrome for P2PKH transactions; TypeScript remains faster for trivial
non-cryptographic scripts. Generic signing and verification measured 28.3x and
19.1x faster. Existing `ProtoWallet` signing and verification measured 26.0x
and 16.8x faster, while public and symmetric BRC-42 derivation measured 2.9x and
9.3x faster. A packed 250-signature batch fell from 224.1 ms in SDK JavaScript
to 12.1 ms in one WASM instance and 3.34 ms across four warm workers. A real
250-transaction dependent graph verified 3.61x faster across four workers.
Typed and cached serialization materially improves large-EF workloads. See
`bench/results/` for commands, environment, hashes, and full measurements.
