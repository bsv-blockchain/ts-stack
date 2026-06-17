# @bsv/verifast

Optional C++/WASM (BSV [BDK](https://github.com/bitcoin-sv/bdk)) backend for
transaction script verification with `@bsv/sdk`.

## Why

`@bsv/sdk` verifies transactions with a pure-TypeScript script interpreter
(`Spend`). For high-throughput verification you can offload script checks to the
BSV BDK engine compiled to WASM. This package implements the SDK's
`BdkVerifierInterface` and plugs into `Transaction.verify`:

```ts
import { Transaction } from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'
import createBdkModule from './wasm/bdk-core.mjs' // your build

const verifier = new BdkVerifier(async () => await createBdkModule())

// 4th arg routes script verification through BDK instead of the JS interpreter.
const ok = await tx.verify('scripts only', undefined, undefined, verifier)
```

Strict: the backend's verdict is authoritative; load/marshalling failures throw
(no silent fallback to the JS interpreter).

## How it hooks in

`Transaction.verify(chainTracker, feeModel, memoryLimit, verifier?)` gained an
optional 4th argument (an object implementing `BdkVerifierInterface`). When
present, the per-input `Spend` loop is skipped and the whole transaction is handed
to the backend once — BDK operates at whole-transaction granularity, not per input.

## Supplying the WASM artifact

This package ships **no** `.wasm`. The artifact in the BDK repo
(`module/typesbdk/wasm/bdk-core.{mjs,wasm}`) is a smoke-test stub whose
verification logic is unvalidated. Build a real one from the BDK C++ source
(emscripten + boost 1.85 + openssl 3.4) — see the BDK repo
`module/typesbdk/examples/README.md` — and drop the outputs into
`src/wasm/bdk-core.mjs` and `src/wasm/bdk-core.wasm` (both gitignored).

The BDK WASM exposes:

```
VerifyScript(extendedTX: VectorUInt8, utxoHeights: VectorInt32,
             blockHeight: int32, consensus: bool, customFlags: VectorUInt32) -> int
```

`BdkVerifier` marshals `tx.toEF()`, per-input source UTXO heights
(`merklePath.blockHeight`, else `943816`), and a flag bitfield (see
`src/flags.ts`), then frees the embind vectors.

## Scripts

```bash
pnpm --filter @bsv/verifast test       # unit tests (mock wasm) — no artifact needed
pnpm --filter @bsv/verifast build      # emit dist/ (src only)
pnpm --filter @bsv/verifast typecheck  # full type check (src + tests)
pnpm --filter @bsv/verifast bench      # inputs/sec; BDK path runs only if a wasm is present
```

`bench/equivalence.test.ts` asserts the BDK backend agrees with the pure-JS
interpreter across the corpus; it auto-skips when no wasm is present.

> Note: tests/benchmarks resolve `@bsv/sdk` to the **local** monorepo source (via a
> jest `moduleNameMapper` / tsx) so the new `verify(verifier)` signature is visible
> despite the repo-wide `@bsv/sdk` version pin. See the design spec's "Monorepo
> linkage constraint" section.

## Caveats to confirm against a real build

- The `extendedTX` format is assumed to be the BSV EF (BRC-30) emitted by `tx.toEF()`.
- The flag bit values in `src/flags.ts` follow canonical bsv ordering; confirm against
  the BDK headers. The equivalence corpus is the guard.
- `BDK_SUCCESS` is assumed to be `1`; confirm the success return code.
