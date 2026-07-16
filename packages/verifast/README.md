# @bsv/verifast

Real BSV BDK script verification in WebAssembly for `@bsv/sdk`, with the same
package working in Node and modern browsers.

## Use

The validated WASM module is bundled and loaded lazily. No artifact path or
factory is required:

```ts
import { Transaction } from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'

const verifier = new BdkVerifier()
const tx = Transaction.fromEF(extendedFormatBytes)

// The fourth argument replaces the SDK Spend loop with one whole-tx BDK call.
const valid = await tx.verify('scripts only', undefined, undefined, verifier)
```

`BdkVerifier` memoises the WebAssembly instance. Keep one verifier for a stream
of transactions instead of constructing one per transaction.

The same import works through browser bundlers that preserve the emitted WASM
asset. The repository's Chrome integration test exercises the built package,
not a browser-specific mock.

## Verdicts and diagnostics

`verifyScripts()` returns `true` for BDK domain `0` and `false` for script or DoS
failures (domains `1` and `2`). BDK exception responses and unknown ABI domains
throw `BdkVerificationError`; load and marshalling failures also propagate. The
adapter never silently falls back to the TypeScript interpreter.

Use the detailed API when the BDK domain and code matter:

```ts
const result = await verifier.verifyScriptsDetailed({
  tx,
  blockHeight: 943816,
  consensus: true
})
// { domain: 0, code: 0 } on success
```

An optional custom WASM factory is still supported:

```ts
const verifier = new BdkVerifier(async () => await createMyBdkModule())
```

## Data and flags

The adapter marshals `tx.toEF()`, one UTXO height per input, and either an empty
custom-flags vector (letting BDK calculate era flags) or one identical flag word
per input. Missing source heights use the post-Chronicle fallback `943816`.

Flag names in `src/flags.ts` map directly to the pinned BSV
`script_flags.h`, including `MINIMALIF`, `NULLFAIL`, compressed-key, Genesis, and
Chronicle bits. Unknown names throw instead of being ignored.

## Reproducibility and validation

The bundled module is built from BDK 1.2.2 plus `bitcoin-sv` commit
`879fc8b42168dd0e608dafd51b39c6dabad37d4d`, Emscripten 4.0.23, Boost 1.85.0,
and OpenSSL 3.4.0. BDK's `module/typesbdk/wasm/build.sh` downloads hashed inputs,
performs a clean build, and validates a real mainnet P2PKH spend plus a corrupt
signature before installing the artifacts.

The VeriFast suite then checks nine deterministic positive and negative vectors
against both the SDK interpreter and BDK in Node and Chrome.

```bash
pnpm --filter @bsv/verifast typecheck
pnpm --filter @bsv/verifast build
pnpm --filter @bsv/verifast test
pnpm --filter @bsv/verifast test:browser
pnpm --filter @bsv/verifast bench
```

The benchmark reports median and p95 end-to-end `Transaction.verify` time over
multiple samples. It deliberately includes EF serialization, WASM boundary
cost, and BDK parsing; results should be measured on the deployment hardware,
and the BDK backend should not be assumed faster for every script shape.

The retained Apple M3 Max Node and Chrome baseline is in
`bench/results/2026-07-15-m3-max.md`.
