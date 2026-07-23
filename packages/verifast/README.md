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
legacy `toEF()` continues to return `number[]`.

## Spend and batch verification

Call the same backend from code that already constructs SDK `Spend` objects:

```ts
const valid = await spend.validateWith(verifier)
// Equivalent direct form:
const sameVerdict = await verifier.verifySpend(spend)
```

`validateWith` applies the same adaptive policy as transaction verification.
The Spend path serializes an ordinary transaction and supplies the active
source output separately, so it does not construct or parse EF ancestry.
Explicit `Spend.verifyFlags` are preserved; otherwise BDK calculates flags from
the configured network and heights.

Packed batch methods cross the JS/WASM boundary once per bounded chunk:

```ts
const txVerdicts = await verifier.verifyScriptsBatchFromEF(items)
const spendVerdicts = await verifier.verifySpendsBatch(
  spends.map(spend => ({ spend }))
)
```

The default limits are 256 items and 32 MiB of input data per chunk and can be
lowered with `maxBatchItems` and `maxBatchBytes`. Packing principally reduces
marshalling and orchestration overhead; ECDSA remains the dominant cost for
large signature-heavy batches.

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
For classic scripts, load `dist/wasm/bdk-core.umd.js`, then
`dist/umd/verifast.js`; both locate the package's single
`dist/wasm/bdk-core.wasm` payload. The Node, browser, and UMD loaders are built
from the same C++ ABI and their generated WASM binaries are required to have
identical SHA-256 digests.

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

The bundled module is built from BDK 1.2.2 plus `bitcoin-sv` commit
`879fc8b42168dd0e608dafd51b39c6dabad37d4d`, Emscripten 4.0.23, Boost 1.85.0,
and OpenSSL 3.4.0. BDK's `module/typesbdk/wasm/build.sh` verifies pinned inputs,
performs a clean build, runs libsecp256k1's verified, non-verified, and exhaustive
WASM tests, then validates the vector, typed, transaction-batch, Spend, and
Spend-batch ABIs through all three loaders.

```bash
pnpm --filter @bsv/verifast typecheck
pnpm --filter @bsv/verifast build
pnpm --filter @bsv/verifast test
pnpm --filter @bsv/verifast test:consumers
pnpm --filter @bsv/verifast bench
pnpm --filter @bsv/verifast bench:batch
```

The deterministic corpus compares positive and negative SDK-interpreter
verdicts with real BDK WASM for whole transactions and individual Spend objects.
Consumer tests execute the built package through Node ESM, CommonJS, browser
ESM, and browser UMD rather than substituting mocks.

On the retained Apple M3 Max baseline, BDK is 16–20x faster in Node and 12–15x
faster in Chrome for P2PKH transactions; TypeScript remains faster for trivial
non-cryptographic scripts. Typed and cached serialization materially improves
large-EF workloads, while packed signature batches show smaller gains because
curve verification dominates. See `bench/results/` for commands, environment,
hashes, and full measurements.
