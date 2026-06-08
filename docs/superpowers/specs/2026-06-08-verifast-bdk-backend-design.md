# Design: Pluggable C++/WASM script-verification backend (`@bsv/verifast` + BDK)

**Date:** 2026-06-08
**Branch:** `feat/bdk`
**Status:** Approved design, pre-implementation

## Goal

Let transaction verification optionally run through the BSV C++ Bitcoin Development
Kit ([bitcoin-sv/bdk](https://github.com/bitcoin-sv/bdk)) compiled to WASM, for
performance, while keeping the existing pure-TypeScript interpreter as the default
and sole fallback path. Deliver a benchmark harness to prove (or disprove) the
speedup against real transaction validation.

## Background / constraints discovered

- **TS `Spend`** (`packages/sdk/src/script/Spend.ts`) is a **per-input**, step-based
  script interpreter. Entry point `validate()`. It is constructed once per input in
  a loop inside `Transaction.verify()` (`packages/sdk/src/transaction/Transaction.ts:889-932`).
- **BDK WASM** exposes a single function (`module/typesbdk/wasm/txvalidator_wasm.h`):
  ```cpp
  int VerifyScriptWASM(
      const std::vector<uint8_t>& extendedTX,
      const std::vector<int32_t>& utxoHeights,
      int32_t blockHeight,
      bool consensus,
      const std::vector<uint32_t>& customFlags);
  ```
  bound to JS via embind as
  `bdk.VerifyScript(extendedTX, utxoHeights, blockHeight, consensus, customFlags)`.
  It is **whole-transaction**: it consumes an *extended* transaction (all inputs,
  with source satoshis + locking scripts inlined) and returns an int result code.
  There is **no per-input API, no step()/stack introspection.**
- Therefore BDK's natural seam is `Transaction.verify()`, **not** `Spend`.
- The prebuilt `module/typesbdk/wasm/bdk-core.{mjs,wasm}` in the BDK repo is an
  explicit **smoke-test stub** — per its README, it only confirms the module loads
  and `VerifyScript` is callable; the verification logic is *not* validated against
  real data. Real use requires building the wasm from C++
  (emscripten + boost 1.85 + openssl 3.4).
- BDK uses a `uint32` flag bitfield; TS uses string flags
  (`P2SH`, `MINIMALDATA`, `GENESIS`, …). A mapping is required.

## Decisions

| # | Decision |
|---|----------|
| 1 | Hook the backend at `Transaction.verify()`. `Spend` is untouched and remains the default pure-JS path. |
| 2 | Adapter + wasm live in a **new monorepo package `@bsv/verifast`** depending on `@bsv/sdk`. Core SDK gains only a small interface, zero new deps. |
| 3 | **Strict, no fallback.** If a backend is configured, its boolean is authoritative; a throw / load-failure propagates as an error. |
| 4 | UTXO height per input = `input.sourceTransaction.merklePath.blockHeight` if present, else **943816** (a post-Chronicle height) so consensus rules evaluate as current-network, not early-activation. |
| 5 | **Supply-your-own wasm.** This work delivers the architecture, adapter, marshalling, mock-backed tests, and benchmark harness. Building a real `bdk-core.wasm` is a documented, out-of-session step. |
| 6 | Benchmarks are a first-class deliverable: an equivalence corpus (JS vs backend, assert-equal) and a perf harness (inputs/sec). |

## Architecture

### Core SDK change (minimal)

New interface (new file `packages/sdk/src/transaction/BdkVerifierInterface.ts`,
re-exported from `mod.ts`):

```ts
export interface BdkVerifierInterface {
  /**
   * Verify ALL input scripts of a single transaction.
   * Resolves true/false for script validity; throws if the backend itself
   * fails (load error, marshalling error, unavailable).
   */
  verifyScripts (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }): Promise<boolean>
}
```

`Transaction.verify()` gains an optional trailing param:

```ts
async verify (
  chainTracker: ChainTracker | 'scripts only' = defaultChainTracker(),
  feeModel?: FeeModel,
  memoryLimit?: number,
  verifier?: BdkVerifierInterface
): Promise<boolean>
```

Behaviour change inside the per-tx body:
- The input loop still runs for **source-tx recursion** and **`inputTotal`** accumulation.
- The script-validity check changes:
  - **No backend (default):** per input, construct `Spend` and call `validate()` exactly as today.
  - **Backend present:** skip per-input `Spend`; after the loop, call
    `await verifier.verifyScripts({ tx, blockHeight, consensus, verifyFlags })` **once**.
    If it resolves `false`, `verify()` returns `false`. If it throws, the error propagates.
- `blockHeight` / `consensus` / `verifyFlags` for the backend call: default
  `consensus = true`; `verifyFlags` undefined (BDK default policy); `blockHeight`
  derived from `tx.merklePath?.blockHeight` else the 943816 fallback. (These may be
  surfaced as `verify()` options in a later iteration; not required for v1.)

No other SDK behaviour changes. `Spend` is not modified.

### `@bsv/verifast` package

```
packages/verifast/
  package.json            # name @bsv/verifast, deps: @bsv/sdk
  src/
    mod.ts                # exports BdkVerifier, flag map, types
    BdkVerifier.ts        # implements BdkVerifierInterface
    flags.ts              # TS string flags -> BDK uint32 bitfield
    wasm/                 # (gitignored) user-supplied bdk-core.{mjs,wasm}
    __tests/
      BdkVerifier.test.ts
  bench/
    corpus.ts             # builds/loads the test transaction corpus
    equivalence.test.ts   # JS Spend vs BdkVerifier, assert-equal
    benchmark.ts          # inputs/sec, JS vs backend
  README.md               # build-your-own-wasm instructions
```

`BdkVerifier`:
- Constructor takes a wasm-module factory (so tests inject a mock; prod passes the
  real `createBdkModule`). Lazy-inits the module once, memoised.
- `verifyScripts`:
  1. `extendedTX = tx.toEF()` → `VectorUInt8`.
  2. `utxoHeights`: per input, `merklePath.blockHeight ?? 943816` → `VectorInt32`.
  3. `customFlags`: map `verifyFlags` via `flags.ts` → `VectorUInt32`.
  4. `result = bdk.VerifyScript(extendedTX, utxoHeights, blockHeight, consensus, customFlags)`.
  5. Free all embind vectors (`.delete()`/`.free()`), in a `finally`.
  6. Return `result === <success code>`.

### Key mappings (correctness risk)

1. **Extended-tx format** — assume BDK `extendedTX` == BSV EF (BRC-30) emitted by
   `tx.toEF()`. **Assumption to confirm** against a real wasm build.
2. **UTXO heights** — see decision #4; fallback 943816.
3. **Flag mapping** — `flags.ts` table from TS string flags to BDK `SCRIPT_VERIFY_*`
   bits. Primary correctness risk; guarded by the equivalence corpus.

## Testing & benchmarks

- **Mock backend test** (SDK): a fake `BdkVerifierInterface` proves
  `Transaction.verify(..., backend)` routes through the backend, returns its bool,
  and propagates its throw — no wasm needed.
- **Equivalence corpus** (`bench/equivalence.test.ts`): N transactions covering
  P2PKH, bare multisig, CLTV/CSV, and large data-push scripts. Each verified by both
  pure-JS `Spend` and `BdkVerifier`; assert identical boolean. Guards the strict
  no-fallback choice and the flag mapping. Skips automatically if no real wasm is present.
- **Benchmark harness** (`bench/benchmark.ts`): same corpus, warm wasm (module load
  excluded), measure inputs/sec for pure-JS vs backend; report speedup and per-call
  marshalling overhead. Runs against any supplied backend; with the mock it measures
  marshalling only.

## Monorepo linkage constraint (discovered)

The root `package.json` sets `pnpm.overrides["@bsv/sdk"] = "2.1.3"`. This forces
**every** workspace consumer — even those declaring `"@bsv/sdk": "workspace:^"` — to
resolve to the **published** registry `@bsv/sdk@2.1.3`, not the local `packages/sdk`
source (currently `2.1.4`). Verified: `packages/wallet/wallet-toolbox` and
`packages/middleware/auth` both symlink to `.pnpm/@bsv+sdk@2.1.3`. So local SDK
source changes are NOT visible to sibling packages via `@bsv/sdk`.

Consequences for this work:

1. **Core SDK changes** (`BdkVerifierInterface`, the `Transaction.verify` param, the
   mock-backed seam test) live in `packages/sdk` and are exercised by **`packages/sdk`'s
   own jest suite**, which compiles local source directly. This works today with no
   linkage workaround.
2. **`@bsv/verifast`'s `BdkVerifier` + `flags.ts`** depend only on
   `Transaction.toEF()` (present in published 2.1.3) and the *shape* of
   `BdkVerifierInterface` (structural — `BdkVerifier` re-declares a local copy of the
   interface and `implements` it, so it does not need the unpublished export).
3. **`@bsv/verifast`'s equivalence + benchmark harness** needs the *new*
   `Transaction.verify(verifier)` signature, which only exists in local SDK source.
   To avoid touching the repo-wide override, verifast configures a **jest
   `moduleNameMapper` / tsconfig path** that maps `@bsv/sdk` → `../sdk/mod.ts` (local
   source) for its own test/bench runs only. The published dep declaration stays for
   type/publish hygiene; the mapper is dev-only and isolated to verifast.

The root override is deliberately left untouched.

## Out of scope / caveats

- Building a real, logic-validated `bdk-core.wasm` (upstream's is a stub). Documented
  in the package README; real benchmark numbers require it.
- Surfacing `consensus` / explicit `blockHeight` / `verifyFlags` as first-class
  `verify()` options (later iteration).
- Per-input/step backend execution — impossible with BDK's whole-tx-only API.

## Acceptance

- `@bsv/sdk` exposes `BdkVerifierInterface`; `Transaction.verify` accepts and
  uses it; default path (no backend) behaviour byte-for-byte unchanged; mock-backed
  tests green.
- `@bsv/verifast` builds, lints, `BdkVerifier` unit-tested against a mock wasm.
- Equivalence + benchmark harness present and runnable; documented how to supply a
  real wasm to get real numbers.
