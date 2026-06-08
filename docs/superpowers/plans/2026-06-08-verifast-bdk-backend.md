# @bsv/verifast BDK WASM Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, pluggable C++/WASM (BDK) backend to BSV transaction verification, keeping the pure-TS interpreter as default, plus an equivalence + benchmark harness to prove the speedup.

**Architecture:** Core `@bsv/sdk` gains a tiny `BdkVerifierInterface` and an optional `verifier` param on `Transaction.verify()`; when present, the per-input `Spend` loop is bypassed and the whole tx is handed to the backend once. A new `@bsv/verifast` package implements that interface as `BdkVerifier`, marshalling `tx.toEF()` + per-input UTXO heights + a flag bitfield into BDK's `VerifyScript`. Strict: backend result is authoritative, failures throw.

**Tech Stack:** TypeScript (ESM), Jest + ts-jest, ts-standard lint, pnpm workspace, emscripten/embind WASM (user-supplied), tsx for benchmark scripts.

**Spec:** `docs/superpowers/specs/2026-06-08-verifast-bdk-backend-design.md`

---

## Key reference facts (read before starting)

- `Transaction.verify` signature today (`packages/sdk/src/transaction/Transaction.ts:833-836`):
  `async verify(chainTracker = defaultChainTracker(), feeModel?, memoryLimit?): Promise<boolean>`
- The per-input loop is `Transaction.ts:889-932`; the line to bypass is `const spendValid = spend.validate()` at `:927`.
- `tx.toEF(): number[]` exists (`Transaction.ts:721`). `tx.merklePath?.blockHeight` exists (`MerklePath.ts:36`).
- `@bsv/sdk` has **zero runtime deps**. Tests live in `__tests/` dirs, jest via `npm run build && jest`.
- SDK exports flow through `packages/sdk/mod.ts` → `src/transaction/index.ts` (`export { default as Transaction }`).
- **UTXO height fallback when unobtainable: `943816`** (post-Chronicle).
- **Monorepo linkage:** root override pins `@bsv/sdk` to registry `2.1.3` for all siblings. Therefore: SDK changes are tested *inside* `packages/sdk`; verifast's equivalence/benchmark map `@bsv/sdk` → local `../sdk/mod.ts` via jest `moduleNameMapper` (dev-only). See spec "Monorepo linkage constraint".

---

## File Structure

**Core SDK (`packages/sdk`):**
- Create: `src/transaction/BdkVerifierInterface.ts` — the interface type.
- Modify: `src/transaction/index.ts` — export the interface type.
- Modify: `src/transaction/Transaction.ts` — add `verifier` param + bypass logic.
- Create: `src/transaction/__tests/Transaction.verifier.test.ts` — mock-backend seam tests.

**New package (`packages/verifast`):**
- Create: `package.json`, `tsconfig.json`, `tsconfig.cjs.json`, `jest.config.js`, `mod.ts`, `README.md`, `.gitignore`.
- Create: `src/BdkVerifierInterface.ts` — local structural copy of the interface (impl target).
- Create: `src/flags.ts` — TS string flags → BDK uint32 bitfield.
- Create: `src/BdkVerifier.ts` — the adapter.
- Create: `src/__tests/flags.test.ts`, `src/__tests/BdkVerifier.test.ts`.
- Create: `bench/corpus.ts`, `bench/equivalence.test.ts`, `bench/benchmark.ts`.

---

## Task 1: `BdkVerifierInterface` type in SDK

**Files:**
- Create: `packages/sdk/src/transaction/BdkVerifierInterface.ts`
- Modify: `packages/sdk/src/transaction/index.ts`

- [ ] **Step 1: Create the interface file**

`packages/sdk/src/transaction/BdkVerifierInterface.ts`:

```ts
import type Transaction from './Transaction.js'

/**
 * A pluggable backend that verifies ALL input scripts of a single transaction.
 *
 * Implementations (e.g. @bsv/verifast's BdkVerifier) typically delegate to a
 * native/WASM engine. The backend operates at whole-transaction granularity,
 * not per input.
 */
export default interface BdkVerifierInterface {
  /**
   * Verify all input scripts of `params.tx`.
   * @returns Promise resolving true if every input script is valid, false otherwise.
   * @throws If the backend itself fails (load error, marshalling error, unavailable).
   */
  verifyScripts: (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }) => Promise<boolean>
}
```

- [ ] **Step 2: Export it from the transaction index**

In `packages/sdk/src/transaction/index.ts`, add after the existing `Transaction` export:

```ts
export type { default as BdkVerifierInterface } from './BdkVerifierInterface.js'
```

- [ ] **Step 3: Verify it compiles and is exported**

Run: `cd packages/sdk && npx tsc -b`
Expected: builds with no errors.

Run: `cd packages/sdk && node -e "import('./dist/esm/mod.js').then(m => console.log(typeof m))"`
Expected: prints `object` (no throw; type-only export means no runtime symbol, that's fine — the build succeeding is the check).

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/transaction/BdkVerifierInterface.ts packages/sdk/src/transaction/index.ts
git commit -m "feat(sdk): add BdkVerifierInterface for pluggable script verification"
```

---

## Task 2: `verifier` param + bypass logic in `Transaction.verify`

**Files:**
- Modify: `packages/sdk/src/transaction/Transaction.ts:833-932`
- Test: `packages/sdk/src/transaction/__tests/Transaction.verifier.test.ts`

- [ ] **Step 1: Write the failing seam tests**

Create `packages/sdk/src/transaction/__tests/Transaction.verifier.test.ts`:

```ts
import Transaction from '../Transaction'
import Script from '../../script/Script'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import MerklePath from '../MerklePath'
import type BdkVerifierInterface from '../BdkVerifierInterface'

// Build a tx whose single P2PKH input is genuinely valid under the pure-JS interpreter.
async function buildValidTx (): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  await source.sign()
  source.merklePath = new MerklePath(1000, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('Transaction.verify with a pluggable verifier', () => {
  it('routes to the verifier and returns its false result, bypassing Spend', async () => {
    const tx = await buildValidTx()
    let called = 0
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => { called++; return false }
    }
    // Pure-JS would return true; verifier says false -> proves bypass + routing.
    const result = await tx.verify('scripts only', undefined, undefined, verifier)
    expect(called).toBe(1)
    expect(result).toBe(false)
  })

  it('returns true when the verifier approves', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = { verifyScripts: async () => true }
    const result = await tx.verify('scripts only', undefined, undefined, verifier)
    expect(result).toBe(true)
  })

  it('propagates a verifier throw (strict, no fallback)', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => { throw new Error('wasm unavailable') }
    }
    await expect(tx.verify('scripts only', undefined, undefined, verifier))
      .rejects.toThrow('wasm unavailable')
  })

  it('passes blockHeight from merklePath, else 943816 fallback', async () => {
    const tx = await buildValidTx() // source has merklePath height 1000, but THIS tx has none
    let seenHeight = -1
    const verifier: BdkVerifierInterface = {
      verifyScripts: async ({ blockHeight }) => { seenHeight = blockHeight; return true }
    }
    await tx.verify('scripts only', undefined, undefined, verifier)
    expect(seenHeight).toBe(943816) // tx itself has no merklePath -> fallback
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && npx jest src/transaction/__tests/Transaction.verifier.test.ts`
Expected: FAIL — `verify` ignores the 4th arg / signature mismatch (TS error or all assertions on `called`/`seenHeight` fail).

- [ ] **Step 3: Add the import and the constant**

At the top of `packages/sdk/src/transaction/Transaction.ts`, add to the imports:

```ts
import type BdkVerifierInterface from './BdkVerifierInterface.js'
```

Just above the `verify` method (near `:831`), add the module-level constant:

```ts
/** Post-Chronicle height used when an input's source UTXO mined-height is unobtainable. */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816
```

(Place the constant at module scope, not inside the class — put it next to the other module constants at the top of the file if the file has them; otherwise immediately above the class declaration.)

- [ ] **Step 4: Add the `verifier` parameter**

Change the `verify` signature (`Transaction.ts:833-837`) from:

```ts
  async verify (
    chainTracker: ChainTracker | 'scripts only' = defaultChainTracker(),
    feeModel?: FeeModel,
    memoryLimit?: number
  ): Promise<boolean> {
```

to:

```ts
  async verify (
    chainTracker: ChainTracker | 'scripts only' = defaultChainTracker(),
    feeModel?: FeeModel,
    memoryLimit?: number,
    verifier?: BdkVerifierInterface
  ): Promise<boolean> {
```

- [ ] **Step 5: Bypass the per-input Spend when a verifier is present**

In the input loop, the block at `Transaction.ts:913-931` currently is:

```ts
        const spend = new Spend({
          sourceTXID: input.sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          lockingScript: sourceOutput.lockingScript,
          sourceSatoshis: sourceOutput.satoshis ?? 0,
          transactionVersion: tx.version,
          otherInputs,
          unlockingScript: input.unlockingScript,
          inputSequence: input.sequence ?? 0xffffffff, // default to max sequence
          inputIndex: i,
          outputs: tx.outputs,
          lockTime: tx.lockTime,
          memoryLimit
        })
        const spendValid = spend.validate()

        if (!spendValid) {
          return false
        }
```

Wrap the `Spend` construction + validation so it only runs when there is no verifier (the loop still runs for `inputTotal` accumulation and source-tx recursion above this block):

```ts
        if (verifier === undefined) {
          const spend = new Spend({
            sourceTXID: input.sourceTXID,
            sourceOutputIndex: input.sourceOutputIndex,
            lockingScript: sourceOutput.lockingScript,
            sourceSatoshis: sourceOutput.satoshis ?? 0,
            transactionVersion: tx.version,
            otherInputs,
            unlockingScript: input.unlockingScript,
            inputSequence: input.sequence ?? 0xffffffff, // default to max sequence
            inputIndex: i,
            outputs: tx.outputs,
            lockTime: tx.lockTime,
            memoryLimit
          })
          const spendValid = spend.validate()

          if (!spendValid) {
            return false
          }
        }
```

- [ ] **Step 6: Call the verifier once after the input loop**

Immediately after the input `for` loop closes (after `Transaction.ts:932`, before the "Total the outputs" block at `:934`), insert:

```ts
      if (verifier !== undefined) {
        const blockHeight = tx.merklePath?.blockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
        const scriptsValid = await verifier.verifyScripts({
          tx,
          blockHeight,
          consensus: true
        })
        if (!scriptsValid) {
          return false
        }
      }
```

(Note: `verifyFlags` is intentionally omitted for v1 — backend uses its default policy. `otherInputs` is still computed at `:910` for the no-verifier path; leave it.)

- [ ] **Step 7: Run the seam tests**

Run: `cd packages/sdk && npx jest src/transaction/__tests/Transaction.verifier.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the full existing transaction suite (no regressions)**

Run: `cd packages/sdk && npm run build && npx jest src/transaction/__tests/Transaction.test.ts`
Expected: PASS — default-path behaviour unchanged.

- [ ] **Step 9: Lint**

Run: `cd packages/sdk && npx ts-standard --fix src/transaction/Transaction.ts src/transaction/BdkVerifierInterface.ts "src/transaction/__tests/Transaction.verifier.test.ts"`
Expected: no remaining errors.

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src/transaction/Transaction.ts packages/sdk/src/transaction/__tests/Transaction.verifier.test.ts
git commit -m "feat(sdk): optional verifier backend in Transaction.verify, bypasses Spend"
```

---

## Task 3: Scaffold the `@bsv/verifast` package

**Files:**
- Create: `packages/verifast/package.json`, `tsconfig.json`, `tsconfig.cjs.json`, `jest.config.js`, `mod.ts`, `.gitignore`

- [ ] **Step 1: Create `package.json`**

`packages/verifast/package.json`:

```json
{
  "name": "@bsv/verifast",
  "version": "0.1.0",
  "type": "module",
  "description": "Optional C++/WASM (BDK) transaction script-verification backend for @bsv/sdk",
  "main": "dist/cjs/mod.js",
  "module": "dist/esm/mod.js",
  "types": "dist/types/mod.d.ts",
  "files": ["dist", "src", "mod.ts", "README.md"],
  "exports": {
    ".": {
      "types": "./dist/types/mod.d.ts",
      "import": "./dist/esm/mod.js",
      "require": "./dist/cjs/mod.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "jest",
    "bench": "tsx bench/benchmark.ts",
    "lint": "ts-standard --fix \"src/**/*.ts\" \"bench/**/*.ts\"",
    "lint:ci": "ts-standard \"src/**/*.ts\" \"bench/**/*.ts\""
  },
  "dependencies": {
    "@bsv/sdk": "^2.1.4"
  },
  "devDependencies": {
    "@jest/globals": "^30.0.0",
    "@types/jest": "^30.0.0",
    "@types/node": "^25.9.1",
    "jest": "^30.0.0",
    "ts-jest": "^29.2.0",
    "ts-standard": "^12.0.2",
    "tsx": "^4.22.3",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`packages/verifast/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist/esm",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "declarationDir": "dist/types",
    "rootDir": "."
  },
  "include": ["mod.ts", "src/**/*.ts"],
  "exclude": ["bench/**", "src/**/__tests/**", "dist", "node_modules"]
}
```

(If `tsconfig.base.json` lacks the needed options, mirror the `compilerOptions` from `packages/sdk/tsconfig.json` instead — open it to confirm `target`, `lib`, `strict` settings, and match them.)

- [ ] **Step 3: Create `jest.config.js` with the local-SDK mapper**

`packages/verifast/jest.config.js`:

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/src', '<rootDir>/bench'],
  moduleNameMapper: {
    // Dev-only: use LOCAL sdk source so the new Transaction.verify(verifier)
    // signature is visible despite the repo-wide @bsv/sdk:2.1.3 override.
    '^@bsv/sdk$': '<rootDir>/../sdk/mod.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { allowJs: true } }]
  }
}
```

- [ ] **Step 4: Create `.gitignore` and `mod.ts` stub**

`packages/verifast/.gitignore`:

```
dist
node_modules
src/wasm/*.wasm
src/wasm/*.mjs
```

`packages/verifast/mod.ts`:

```ts
export { default as BdkVerifier } from './src/BdkVerifier.js'
export { mapVerifyFlags, BDK_FLAG_BITS } from './src/flags.js'
export type { BdkWasmModule, BdkWasmFactory } from './src/BdkVerifier.js'
```

- [ ] **Step 5: Install workspace deps**

Run: `cd /Users/personal/git/ts-stack && pnpm install`
Expected: `@bsv/verifast` picked up by `packages/**` glob; install completes.

- [ ] **Step 6: Commit**

```bash
git add packages/verifast/package.json packages/verifast/tsconfig.json packages/verifast/jest.config.js packages/verifast/.gitignore packages/verifast/mod.ts pnpm-lock.yaml
git commit -m "chore(verifast): scaffold @bsv/verifast package"
```

---

## Task 4: Flag mapping (`flags.ts`)

**Files:**
- Create: `packages/verifast/src/flags.ts`
- Test: `packages/verifast/src/__tests/flags.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/verifast/src/__tests/flags.test.ts`:

```ts
import { mapVerifyFlags, BDK_FLAG_BITS } from '../flags'

describe('mapVerifyFlags', () => {
  it('returns 0 for undefined', () => {
    expect(mapVerifyFlags(undefined)).toBe(0)
  })

  it('maps a single string flag to its bit', () => {
    expect(mapVerifyFlags('P2SH')).toBe(BDK_FLAG_BITS.P2SH)
  })

  it('ORs comma-separated string flags', () => {
    expect(mapVerifyFlags('P2SH,MINIMALDATA')).toBe(
      BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.MINIMALDATA
    )
  })

  it('ORs an array of flags and trims whitespace', () => {
    expect(mapVerifyFlags([' P2SH ', 'LOW_S'])).toBe(
      BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.LOW_S
    )
  })

  it('ignores unknown flags', () => {
    expect(mapVerifyFlags('P2SH,NOT_A_REAL_FLAG')).toBe(BDK_FLAG_BITS.P2SH)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/verifast && npx jest src/__tests/flags.test.ts`
Expected: FAIL — `Cannot find module '../flags'`.

- [ ] **Step 3: Implement `flags.ts`**

`packages/verifast/src/flags.ts`:

```ts
/**
 * BDK SCRIPT_VERIFY_* flag bits.
 *
 * NOTE: These values mirror Bitcoin SV's script verification flag bitfield. The
 * exact numeric assignments MUST be confirmed against the BDK C++ headers when a
 * real bdk-core.wasm is supplied; the equivalence corpus (bench/equivalence.test.ts)
 * is the guard that this mapping matches engine behaviour. Values below follow the
 * canonical bsv ordering.
 */
export const BDK_FLAG_BITS = {
  P2SH: 1 << 0,
  STRICTENC: 1 << 1,
  DERSIG: 1 << 2,
  LOW_S: 1 << 3,
  NULLDUMMY: 1 << 4,
  SIGPUSHONLY: 1 << 5,
  MINIMALDATA: 1 << 6,
  DISCOURAGE_UPGRADABLE_NOPS: 1 << 7,
  CLEANSTACK: 1 << 8,
  CHECKLOCKTIMEVERIFY: 1 << 9,
  CHECKSEQUENCEVERIFY: 1 << 10,
  SIGHASH_FORKID: 1 << 16,
  GENESIS: 1 << 18,
  UTXO_AFTER_GENESIS: 1 << 19
} as const

export type BdkFlagName = keyof typeof BDK_FLAG_BITS

/**
 * Map @bsv/sdk string verify flags to the BDK uint32 bitfield.
 * Accepts a comma-separated string or an array; unknown flags are ignored.
 */
export function mapVerifyFlags (verifyFlags?: string | string[]): number {
  if (verifyFlags === undefined) return 0
  const names = Array.isArray(verifyFlags) ? verifyFlags : verifyFlags.split(',')
  let bits = 0
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const bit = BDK_FLAG_BITS[name as BdkFlagName]
    if (bit !== undefined) bits |= bit
  }
  return bits
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/verifast && npx jest src/__tests/flags.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/verifast/src/flags.ts packages/verifast/src/__tests/flags.test.ts
git commit -m "feat(verifast): flag string -> BDK uint32 bitfield mapping"
```

---

## Task 5: `BdkVerifier` adapter

**Files:**
- Create: `packages/verifast/src/BdkVerifier.ts`
- Test: `packages/verifast/src/__tests/BdkVerifier.test.ts`

- [ ] **Step 1: Write the failing test (with a mock WASM module)**

`packages/verifast/src/__tests/BdkVerifier.test.ts`:

```ts
import { Transaction, Script, P2PKH, PrivateKey, MerklePath } from '@bsv/sdk'
import BdkVerifier, { type BdkWasmModule } from '../BdkVerifier'

// Minimal embind-style vector mock that records what was pushed.
class MockVector {
  items: number[] = []
  push_back (v: number): void { this.items.push(v) }
  delete (): void { /* freed */ }
}

interface MockCall {
  extendedTX: number[]
  utxoHeights: number[]
  blockHeight: number
  consensus: boolean
  customFlags: number[]
}

function makeMockModule (returnCode: number, calls: MockCall[]): BdkWasmModule {
  return {
    VectorUInt8: MockVector as any,
    VectorInt32: MockVector as any,
    VectorUInt32: MockVector as any,
    VerifyScript: (extendedTX: any, utxoHeights: any, blockHeight: number, consensus: boolean, customFlags: any) => {
      calls.push({
        extendedTX: [...extendedTX.items],
        utxoHeights: [...utxoHeights.items],
        blockHeight,
        consensus,
        customFlags: [...customFlags.items]
      })
      return returnCode
    }
  }
}

async function buildTx (): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  await source.sign()
  source.merklePath = new MerklePath(777, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('BdkVerifier', () => {
  it('marshals tx.toEF, utxo heights, flags and returns true on success code', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(1, calls))
    const tx = await buildTx()

    const ok = await verifier.verifyScripts({ tx, blockHeight: 800000, consensus: true, verifyFlags: 'P2SH' })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].extendedTX).toEqual(tx.toEF())
    expect(calls[0].blockHeight).toBe(800000)
    expect(calls[0].consensus).toBe(true)
    expect(calls[0].customFlags).toEqual([1]) // P2SH bit
    // one input, its source has merklePath height 777
    expect(calls[0].utxoHeights).toEqual([777])
  })

  it('returns false on a non-success code', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(0, calls))
    const tx = await buildTx()
    const ok = await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(ok).toBe(false)
  })

  it('uses 943816 height fallback for inputs whose source lacks a merklePath', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(1, calls))
    const tx = await buildTx()
    delete tx.inputs[0].sourceTransaction!.merklePath
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(calls[0].utxoHeights).toEqual([943816])
  })

  it('initialises the wasm module only once across calls', async () => {
    let factoryCalls = 0
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => { factoryCalls++; return makeMockModule(1, calls) })
    const tx = await buildTx()
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(factoryCalls).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/verifast && npx jest src/__tests/BdkVerifier.test.ts`
Expected: FAIL — `Cannot find module '../BdkVerifier'`.

- [ ] **Step 3: Implement `BdkVerifier.ts`**

`packages/verifast/src/BdkVerifier.ts`:

```ts
import type { Transaction, BdkVerifierInterface } from '@bsv/sdk'
import { mapVerifyFlags } from './flags.js'

/** Height used when an input's source UTXO mined-height is unobtainable (post-Chronicle). */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816

/** Return code from BDK VerifyScript that denotes "all scripts valid". */
const BDK_SUCCESS = 1

/** Minimal embind vector surface used by the adapter. */
interface EmbindVector<T> {
  push_back: (value: T) => void
  delete: () => void
}

interface EmbindVectorCtor<T> {
  new (): EmbindVector<T>
}

/** The subset of the BDK WASM module this adapter uses. */
export interface BdkWasmModule {
  VectorUInt8: EmbindVectorCtor<number>
  VectorInt32: EmbindVectorCtor<number>
  VectorUInt32: EmbindVectorCtor<number>
  VerifyScript: (
    extendedTX: EmbindVector<number>,
    utxoHeights: EmbindVector<number>,
    blockHeight: number,
    consensus: boolean,
    customFlags: EmbindVector<number>
  ) => number
}

/** Async factory that loads/instantiates the BDK WASM module (e.g. `createBdkModule`). */
export type BdkWasmFactory = () => Promise<BdkWasmModule>

function toVector<T> (ctor: EmbindVectorCtor<T>, values: T[]): EmbindVector<T> {
  const vec = new ctor()
  for (const v of values) vec.push_back(v)
  return vec
}

/**
 * BdkVerifierInterface implementation backed by the BSV BDK engine compiled to WASM.
 * Strict: a non-success return code => false; any thrown error propagates.
 */
export default class BdkVerifier implements BdkVerifierInterface {
  private module: BdkWasmModule | undefined
  private loading: Promise<BdkWasmModule> | undefined

  /** @param factory loads the WASM module; invoked once, memoised. */
  constructor (private readonly factory: BdkWasmFactory) {}

  private async getModule (): Promise<BdkWasmModule> {
    if (this.module !== undefined) return this.module
    if (this.loading === undefined) {
      this.loading = this.factory().then((m) => { this.module = m; return m })
    }
    return await this.loading
  }

  async verifyScripts (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }): Promise<boolean> {
    const bdk = await this.getModule()

    const heights = params.tx.inputs.map(
      (input) => input.sourceTransaction?.merklePath?.blockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    )

    const extendedTX = toVector(bdk.VectorUInt8, params.tx.toEF())
    const utxoHeights = toVector(bdk.VectorInt32, heights)
    const customFlags = toVector(bdk.VectorUInt32, [mapVerifyFlags(params.verifyFlags)].filter((f) => f !== 0))

    try {
      const result = bdk.VerifyScript(
        extendedTX,
        utxoHeights,
        params.blockHeight,
        params.consensus,
        customFlags
      )
      return result === BDK_SUCCESS
    } finally {
      extendedTX.delete()
      utxoHeights.delete()
      customFlags.delete()
    }
  }
}
```

Note on `customFlags`: when no flags are set we pass an empty vector (`.filter(f => f !== 0)` drops the lone `0`), matching BDK's "no custom flags" default. The test passes `'P2SH'` → `[1]`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/verifast && npx jest src/__tests/BdkVerifier.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Build the package**

Run: `cd packages/verifast && npx tsc -b`
Expected: builds (the `mod.ts` re-exports resolve). If `BdkVerifierInterface` import from `@bsv/sdk` fails at build (registry 2.1.3 lacks it), change the import in `BdkVerifier.ts` to a local structural copy: create `src/BdkVerifierInterface.ts` mirroring Task 1's interface and import `implements BdkVerifierInterface` from there instead. (Build uses the published dep; only jest uses local source via the mapper.)

- [ ] **Step 6: Lint + commit**

Run: `cd packages/verifast && npx ts-standard --fix "src/**/*.ts"`
Expected: clean.

```bash
git add packages/verifast/src/BdkVerifier.ts packages/verifast/src/__tests/BdkVerifier.test.ts packages/verifast/mod.ts
git commit -m "feat(verifast): BdkVerifier adapter marshalling tx.toEF + heights + flags"
```

---

## Task 6: Test-transaction corpus

**Files:**
- Create: `packages/verifast/bench/corpus.ts`

- [ ] **Step 1: Implement the corpus builder**

`packages/verifast/bench/corpus.ts`:

```ts
import { Transaction, Script, P2PKH, PrivateKey, MerklePath } from '@bsv/sdk'

export interface CorpusEntry {
  name: string
  tx: Transaction
}

/** A funded source tx paying `count` P2PKH outputs to `key`, with a mock merklePath. */
async function fundedSource (key: PrivateKey, count: number): Promise<Transaction> {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let i = 0; i < count; i++) {
    source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toAddress()) })
  }
  await source.sign()
  source.merklePath = new MerklePath(800000, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  return source
}

/** Build a P2PKH spend with `nInputs` inputs and one output. */
async function p2pkhTx (nInputs: number): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = await fundedSource(key, nInputs)
  const tx = new Transaction()
  for (let i = 0; i < nInputs; i++) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: i, unlockingScriptTemplate: new P2PKH().unlock(key) })
  }
  tx.addOutput({ satoshis: 500, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

/**
 * Build the benchmark/equivalence corpus. Deterministic in shape; keys are random
 * (signatures vary run-to-run but validity does not).
 */
export async function buildCorpus (): Promise<CorpusEntry[]> {
  return [
    { name: 'p2pkh-1in', tx: await p2pkhTx(1) },
    { name: 'p2pkh-5in', tx: await p2pkhTx(5) },
    { name: 'p2pkh-20in', tx: await p2pkhTx(20) }
  ]
}
```

(The corpus is intentionally P2PKH-only for v1: these spends are known-valid under the pure-JS interpreter, giving a clean equivalence baseline. Multisig/CLTV vectors can be added later once a real wasm validates them.)

- [ ] **Step 2: Smoke-check the corpus builds valid txs (pure JS)**

Add a temporary check — run:

```bash
cd packages/verifast && npx tsx -e "import('./bench/corpus.ts').then(async ({buildCorpus}) => { const c = await buildCorpus(); for (const e of c) console.log(e.name, await e.tx.verify('scripts only')); })"
```

Expected: prints `p2pkh-1in true`, `p2pkh-5in true`, `p2pkh-20in true`.

(If `tsx` cannot resolve `@bsv/sdk` to local source the way jest does, this prints `true` anyway because published 2.1.3's `verify('scripts only')` works for the default path — the new signature isn't exercised here.)

- [ ] **Step 3: Commit**

```bash
git add packages/verifast/bench/corpus.ts
git commit -m "test(verifast): deterministic P2PKH transaction corpus for bench/equivalence"
```

---

## Task 7: Equivalence test (JS vs backend)

**Files:**
- Create: `packages/verifast/bench/equivalence.test.ts`

- [ ] **Step 1: Write the equivalence test (skips without a real wasm)**

`packages/verifast/bench/equivalence.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import BdkVerifier from '../src/BdkVerifier'
import { buildCorpus } from './corpus'

const here = dirname(fileURLToPath(import.meta.url))
const wasmEntry = resolve(here, '../src/wasm/bdk-core.mjs')
const hasWasm = existsSync(wasmEntry)

const maybe = hasWasm ? describe : describe.skip

maybe('JS Spend vs BdkVerifier equivalence', () => {
  it('produces identical validity verdicts for every corpus tx', async () => {
    // @ts-expect-error dynamic import of a user-supplied artifact (not present in CI)
    const { default: createBdkModule } = await import('../src/wasm/bdk-core.mjs')
    const verifier = new BdkVerifier(async () => await createBdkModule())
    const corpus = await buildCorpus()

    for (const { name, tx } of corpus) {
      const jsResult = await tx.verify('scripts only')
      const bdkResult = await tx.verify('scripts only', undefined, undefined, verifier)
      expect({ name, bdkResult }).toEqual({ name, bdkResult: jsResult })
    }
  })
})

describe('equivalence harness availability', () => {
  it('reports whether a real wasm artifact is present', () => {
    // Always-on sentinel so CI shows the suite ran; logs guidance when skipping.
    if (!hasWasm) {
      console.log('[verifast] No src/wasm/bdk-core.mjs — equivalence test skipped. See README to supply a build.')
    }
    expect(typeof hasWasm).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run it (no wasm present → skip + sentinel passes)**

Run: `cd packages/verifast && npx jest bench/equivalence.test.ts`
Expected: PASS — the `maybe` block is skipped; the availability sentinel passes and logs the guidance line.

- [ ] **Step 3: Commit**

```bash
git add packages/verifast/bench/equivalence.test.ts
git commit -m "test(verifast): JS-vs-BDK equivalence corpus (skips without real wasm)"
```

---

## Task 8: Benchmark harness

**Files:**
- Create: `packages/verifast/bench/benchmark.ts`

- [ ] **Step 1: Implement the benchmark script**

`packages/verifast/bench/benchmark.ts`:

```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { BdkVerifierInterface } from '@bsv/sdk'
import BdkVerifier from '../src/BdkVerifier'
import { buildCorpus, type CorpusEntry } from './corpus'

const ITERATIONS = Number(process.env.VERIFAST_ITERATIONS ?? 200)

function countInputs (corpus: CorpusEntry[]): number {
  return corpus.reduce((n, e) => n + e.tx.inputs.length, 0)
}

async function timeRun (
  corpus: CorpusEntry[],
  verifier: BdkVerifierInterface | undefined
): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    for (const { tx } of corpus) {
      await tx.verify('scripts only', undefined, undefined, verifier)
    }
  }
  return performance.now() - start
}

async function loadVerifier (): Promise<BdkVerifier | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))
  const wasmEntry = resolve(here, '../src/wasm/bdk-core.mjs')
  if (!existsSync(wasmEntry)) return undefined
  const { default: createBdkModule } = await import('../src/wasm/bdk-core.mjs')
  const v = new BdkVerifier(async () => await createBdkModule())
  // Warm the module so load time is excluded from timings.
  const warm = await buildCorpus()
  await v.verifyScripts({ tx: warm[0].tx, blockHeight: 943816, consensus: true })
  return v
}

async function main (): Promise<void> {
  const corpus = await buildCorpus()
  const inputsPerPass = countInputs(corpus)
  const totalInputs = inputsPerPass * ITERATIONS

  const jsMs = await timeRun(corpus, undefined)
  console.log(`pure-JS Spend:   ${jsMs.toFixed(1)} ms  (${(totalInputs / (jsMs / 1000)).toFixed(0)} inputs/s)`)

  const verifier = await loadVerifier()
  if (verifier === undefined) {
    console.log('BDK backend:     SKIPPED — no src/wasm/bdk-core.mjs. See README to supply a build.')
    console.log('(Without a real wasm, only the pure-JS baseline is meaningful.)')
    return
  }

  const bdkMs = await timeRun(corpus, verifier)
  console.log(`BDK wasm:        ${bdkMs.toFixed(1)} ms  (${(totalInputs / (bdkMs / 1000)).toFixed(0)} inputs/s)`)
  console.log(`speedup:         ${(jsMs / bdkMs).toFixed(2)}x`)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Run the benchmark (pure-JS baseline only, no wasm)**

Run: `cd packages/verifast && npx tsx bench/benchmark.ts`
Expected: prints the `pure-JS Spend: ... inputs/s` line, then the `BDK backend: SKIPPED` line. No crash.

(Note: under `tsx`, `@bsv/sdk` resolves to published 2.1.3, whose `verify` ignores the 4th arg — so the baseline number is valid, and the backend path is correctly skipped. Real comparative numbers require the local-source build + a real wasm; documented in README.)

- [ ] **Step 3: Commit**

```bash
git add packages/verifast/bench/benchmark.ts
git commit -m "test(verifast): inputs/sec benchmark harness, JS vs BDK"
```

---

## Task 9: README + final package verification

**Files:**
- Create: `packages/verifast/README.md`

- [ ] **Step 1: Write the README**

`packages/verifast/README.md`:

````markdown
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

## Supplying the WASM artifact

This package ships **no** `.wasm`. The artifact in the BDK repo
(`module/typesbdk/wasm/bdk-core.{mjs,wasm}`) is a smoke-test stub whose
verification logic is unvalidated. Build a real one from the BDK C++ source
(emscripten + boost 1.85 + openssl 3.4) — see the BDK repo
`module/typesbdk/examples/README.md` — and drop the outputs into
`src/wasm/bdk-core.mjs` and `src/wasm/bdk-core.wasm` (gitignored).

The BDK WASM exposes:

```
VerifyScript(extendedTX: VectorUInt8, utxoHeights: VectorInt32,
             blockHeight: int32, consensus: bool, customFlags: VectorUInt32) -> int
```

`BdkVerifier` marshals `tx.toEF()`, per-input source UTXO heights
(`merklePath.blockHeight`, else `943816`), and a flag bitfield (see `flags.ts`).

## Tests & benchmarks

```bash
pnpm --filter @bsv/verifast test     # unit tests (mock wasm) — no artifact needed
pnpm --filter @bsv/verifast bench    # inputs/sec; BDK path runs only if a wasm is present
```

`bench/equivalence.test.ts` asserts the BDK backend agrees with the pure-JS
interpreter across the corpus; it auto-skips when no wasm is present.

## Caveats to confirm against a real build

- The `extendedTX` format is assumed to be the BSV EF (BRC-30) emitted by `tx.toEF()`.
- The flag bit values in `flags.ts` follow canonical bsv ordering; confirm against
  the BDK headers. The equivalence corpus is the guard.
- `BDK_SUCCESS` is assumed to be `1`; confirm the success return code.
````

- [ ] **Step 2: Run the full verifast suite**

Run: `cd packages/verifast && npx jest`
Expected: PASS — flags (5), BdkVerifier (4), equivalence availability sentinel (1), equivalence block skipped.

- [ ] **Step 3: Build + lint the whole package**

Run: `cd packages/verifast && npx tsc -b && npx ts-standard "src/**/*.ts" "bench/**/*.ts"`
Expected: build clean, lint clean.

- [ ] **Step 4: Confirm SDK suite still green (no core regression)**

Run: `cd packages/sdk && npm run build && npx jest src/transaction/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/verifast/README.md
git commit -m "docs(verifast): usage, supply-your-own-wasm, and caveats"
```

---

## Final verification checklist

- [ ] `packages/sdk` builds, `BdkVerifierInterface` exported, `Transaction.verify` accepts `verifier`.
- [ ] Seam tests prove: routing, true/false passthrough, throw propagation, 943816 fallback.
- [ ] Default (no-verifier) SDK behaviour unchanged — full `src/transaction/` jest green.
- [ ] `@bsv/verifast` builds, lints, unit tests green against mock wasm.
- [ ] Equivalence harness present, auto-skips without wasm; benchmark prints pure-JS baseline.
- [ ] README documents the supply-your-own-wasm step and the unconfirmed assumptions.
- [ ] All work committed on `feat/bdk`; PR #186 updated on push.
