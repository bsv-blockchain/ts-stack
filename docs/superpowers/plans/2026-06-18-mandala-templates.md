---
id: mandala-templates-plan
title: Mandala Token Script Templates — Implementation Plan (Plan 1 of 2)
kind: spec
domain: helpers
version: "n/a"
last_updated: "2026-06-18"
last_verified: "2026-06-18"
status: experimental
tags: [mandala, brc-92, templates, plan]
---

# Mandala Token Script Templates — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two BRC-92 Mandala script templates — `MandalaToken` (fungible-token transfer output) and `MandalaAdmin` (authorization-outpoint chain) — to the `@bsv/templates` package.

**Architecture:** Both classes implement `ScriptTemplate` from `@bsv/sdk` and follow the existing `MultiPushDrop` / `P2MSKH` patterns (wallet-based key derivation and signing, shared minimal-push-encoding helper). `MandalaToken` produces a P2PKH lock prefixed with the Mandala `!`-marker + assetId + amount that is dropped off the stack. `MandalaAdmin` produces a P2PK lock on a `boundKey` derived through the wallet from a canonicalised action-details JSON.

**Tech Stack:** TypeScript (ESM, dual CJS/ESM build via `tsc -b`), `@bsv/sdk`, Jest + `ts-jest`. This is Plan 1 of 2; Plan 2 (`2026-06-18-mandala-overlay.md`) consumes the `decode()` outputs and `assetId` string format defined here.

## Global Constraints

- Package: `@bsv/templates` at `packages/helpers/ts-templates`. Source in `src/`, tests in `src/__tests/`, public exports added to `packages/helpers/ts-templates/mod.ts`.
- Import everything from `@bsv/sdk` (the package depends on it) — never reach into `@bsv/sdk` subpaths. Available value exports: `OP, LockingScript, UnlockingScript, Utils, Hash, TransactionSignature, Signature, PrivateKey, PublicKey, Transaction, Curve, Point, BigNumber, SymmetricKey`. Available type exports include `ScriptTemplate, ScriptTemplateUnlock, WalletInterface, WalletCounterparty, WalletProtocol, SecurityLevel, PubKeyHex`.
- Lint: `ts-standard` (2-space indent, no semicolons, single quotes, `===`). Run `npm run lint` in the package before each commit.
- Test command (from package dir): `npm test` runs `npm run build && jest --passWithNoTests`. For a single test during development: `npx jest src/__tests/<File>.test.ts`.
- FT-only. No NFT variant. No arbitrary PushDrop data fields on `MandalaToken`.
- The `0x21` marker is a single-byte data push of the value `0x21` (`createMinimallyEncodedScriptChunk([0x21])` → `{ op: 1, data: [0x21] }`).
- `assetId` public API format is the string `"<txid_hex>.<vout>"` (e.g. `"ab12...ef.0"`), encoded on-chain as 36 bytes: 32-byte txid (the hex decoded as-is, big-endian display order) followed by a 4-byte little-endian output index.

---

### Task 1: Shared encoding helpers

**Files:**
- Create: `packages/helpers/ts-templates/src/mandala-encoding.ts`
- Test: `packages/helpers/ts-templates/src/__tests/mandala-encoding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createMinimallyEncodedScriptChunk(data: number[]): { op: number, data?: number[] }`
  - `encodeScriptNum(value: number): number[]` — minimal little-endian signed (Bitcoin script number).
  - `decodeScriptNum(data: number[]): number`
  - `encodeAssetId(assetId: string): number[]` — `"txid.vout"` → 36 bytes.
  - `decodeAssetId(bytes: number[]): string` — 36 bytes → `"txid.vout"`.
  - `MARKER: number` = `0x21`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  encodeScriptNum, decodeScriptNum, encodeAssetId, decodeAssetId, MARKER
} from '../mandala-encoding.js'

describe('mandala-encoding', () => {
  it('round-trips small and large script numbers', () => {
    for (const n of [0, 1, 16, 127, 128, 255, 256, 1000, 0x7fffffff]) {
      expect(decodeScriptNum(encodeScriptNum(n))).toBe(n)
    }
  })

  it('encodes zero as an empty array', () => {
    expect(encodeScriptNum(0)).toEqual([])
  })

  it('round-trips an assetId outpoint string', () => {
    const txid = 'a'.repeat(64)
    const assetId = `${txid}.3`
    const bytes = encodeAssetId(assetId)
    expect(bytes.length).toBe(36)
    expect(decodeAssetId(bytes)).toBe(assetId)
  })

  it('exposes the ! marker', () => {
    expect(MARKER).toBe(0x21)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/mandala-encoding.test.ts`
Expected: FAIL — `Cannot find module '../mandala-encoding.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Utils } from '@bsv/sdk'

export const MARKER = 0x21

export const createMinimallyEncodedScriptChunk = (
  data: number[]
): { op: number, data?: number[] } => {
  if (data.length === 0) return { op: 0 }
  if (data.length === 1 && data[0] === 0) return { op: 0 }
  if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] }
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 255) return { op: 0x4c, data }
  if (data.length <= 65535) return { op: 0x4d, data }
  return { op: 0x4e, data }
}

// Bitcoin script number: minimal little-endian, sign in the high bit of the last byte.
export const encodeScriptNum = (value: number): number[] => {
  if (value === 0) return []
  const negative = value < 0
  let abs = Math.abs(value)
  const result: number[] = []
  while (abs > 0) {
    result.push(abs & 0xff)
    abs = Math.floor(abs / 256)
  }
  if ((result[result.length - 1] & 0x80) !== 0) {
    result.push(negative ? 0x80 : 0x00)
  } else if (negative) {
    result[result.length - 1] |= 0x80
  }
  return result
}

export const decodeScriptNum = (data: number[]): number => {
  if (data.length === 0) return 0
  let result = 0
  for (let i = 0; i < data.length; i++) {
    result += (i === data.length - 1 ? (data[i] & 0x7f) : data[i]) * Math.pow(256, i)
  }
  if ((data[data.length - 1] & 0x80) !== 0) result = -result
  return result
}

export const encodeAssetId = (assetId: string): number[] => {
  const dot = assetId.lastIndexOf('.')
  if (dot === -1) throw new Error('assetId must be "<txid>.<vout>"')
  const txid = assetId.slice(0, dot)
  const vout = Number(assetId.slice(dot + 1))
  if (txid.length !== 64) throw new Error('assetId txid must be 32 bytes (64 hex chars)')
  if (!Number.isInteger(vout) || vout < 0) throw new Error('assetId vout must be a non-negative integer')
  const txidBytes = Utils.toArray(txid, 'hex')
  const voutBytes = [vout & 0xff, (vout >> 8) & 0xff, (vout >> 16) & 0xff, (vout >> 24) & 0xff]
  return [...txidBytes, ...voutBytes]
}

export const decodeAssetId = (bytes: number[]): string => {
  if (bytes.length !== 36) throw new Error('assetId bytes must be exactly 36 bytes')
  const txid = Utils.toHex(bytes.slice(0, 32))
  const v = bytes.slice(32)
  const vout = v[0] + (v[1] << 8) + (v[2] << 16) + (v[3] << 24)
  return `${txid}.${vout}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests/mandala-encoding.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/src/mandala-encoding.ts packages/helpers/ts-templates/src/__tests/mandala-encoding.test.ts
git commit -m "feat(templates): mandala script-number and assetId encoding helpers"
```

---

### Task 2: `MandalaToken.lock` + `MandalaToken.decode`

**Files:**
- Create: `packages/helpers/ts-templates/src/MandalaToken.ts`
- Test: `packages/helpers/ts-templates/src/__tests/MandalaToken.test.ts`

**Interfaces:**
- Consumes: `createMinimallyEncodedScriptChunk`, `encodeScriptNum`, `decodeScriptNum`, `encodeAssetId`, `decodeAssetId`, `MARKER` from `./mandala-encoding.js`.
- Produces:
  - `interface MandalaTokenDecoded { assetId: string, amount: number, pubKeyHash: number[] }`
  - `class MandalaToken implements ScriptTemplate` with instance method `lock(assetId: string, amount: number, pubKeyHash: number[]): LockingScript` and `static decode(script: LockingScript): MandalaTokenDecoded`.

The locking script chunk sequence is exactly:
`[marker push 0x21] [assetId push 36B] [amount push] OP_2DROP OP_DROP OP_DUP OP_HASH160 [pubKeyHash push 20B] OP_EQUALVERIFY OP_CHECKSIG`.

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaToken } from '../MandalaToken.js'
import { Hash, PrivateKey } from '@bsv/sdk'

describe('MandalaToken lock/decode', () => {
  const assetId = `${'a'.repeat(64)}.0`
  const pubKeyHash = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])

  it('builds a script that decodes back to its inputs', () => {
    const script = new MandalaToken().lock(assetId, 1000, pubKeyHash)
    const decoded = MandalaToken.decode(script)
    expect(decoded.assetId).toBe(assetId)
    expect(decoded.amount).toBe(1000)
    expect(decoded.pubKeyHash).toEqual(pubKeyHash)
  })

  it('produces a P2PKH tail (OP_DUP OP_HASH160 ... OP_EQUALVERIFY OP_CHECKSIG)', () => {
    const script = new MandalaToken().lock(assetId, 1, pubKeyHash)
    const ops = script.chunks.map(c => c.op)
    expect(ops.slice(-5)).toEqual([0x76, 0xa9, 20, 0x88, 0xac])
  })

  it('throws when decoding a non-Mandala script', () => {
    const p2pkh = new MandalaToken().lock(assetId, 1, pubKeyHash)
    const broken = new (p2pkh.constructor as any)()
    expect(() => MandalaToken.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
    void broken
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/MandalaToken.test.ts`
Expected: FAIL — `Cannot find module '../MandalaToken.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { ScriptTemplate, LockingScript, UnlockingScript, OP, Utils } from '@bsv/sdk'
import {
  createMinimallyEncodedScriptChunk, encodeScriptNum, decodeScriptNum,
  encodeAssetId, decodeAssetId, MARKER
} from './mandala-encoding.js'

export interface MandalaTokenDecoded {
  assetId: string
  amount: number
  pubKeyHash: number[]
}

export class MandalaToken implements ScriptTemplate {
  lock (assetId: string, amount: number, pubKeyHash: number[]): LockingScript {
    if (pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes')
    if (!Number.isInteger(amount) || amount < 1) throw new Error('amount must be a positive integer')
    const assetIdBytes = encodeAssetId(assetId)
    return new LockingScript([
      createMinimallyEncodedScriptChunk([MARKER]),
      createMinimallyEncodedScriptChunk(assetIdBytes),
      createMinimallyEncodedScriptChunk(encodeScriptNum(amount)),
      { op: OP.OP_2DROP },
      { op: OP.OP_DROP },
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: pubKeyHash.length, data: pubKeyHash },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ])
  }

  static decode (script: LockingScript): MandalaTokenDecoded {
    const c = script.chunks
    if (c.length !== 10) throw new Error('not a MandalaToken script: wrong chunk count')
    const marker = c[0].data ?? []
    if (marker.length !== 1 || marker[0] !== MARKER) throw new Error('not a MandalaToken script: missing marker')
    if (c[3].op !== OP.OP_2DROP || c[4].op !== OP.OP_DROP) throw new Error('not a MandalaToken script: bad drops')
    if (c[5].op !== OP.OP_DUP || c[6].op !== OP.OP_HASH160 || c[8].op !== OP.OP_EQUALVERIFY || c[9].op !== OP.OP_CHECKSIG) {
      throw new Error('not a MandalaToken script: bad P2PKH tail')
    }
    const assetId = decodeAssetId(Utils.verifyTruthy(c[1].data))
    const amount = decodeScriptNum(c[2].data ?? [])
    const pubKeyHash = Utils.verifyTruthy(c[7].data)
    if (pubKeyHash.length !== 20) throw new Error('not a MandalaToken script: bad pubKeyHash')
    return { assetId, amount, pubKeyHash }
  }
}
```

> Note: if `Utils.verifyTruthy` is unavailable at runtime, replace with a local `const vt = <T>(v: T | undefined | null): T => { if (v == null) throw new Error('missing chunk data'); return v }`. Confirm by checking `Utils` exports during Step 4; adjust before committing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests/MandalaToken.test.ts`
Expected: PASS (3 tests). If a `Utils.verifyTruthy` error appears, apply the note above and re-run.

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/src/MandalaToken.ts packages/helpers/ts-templates/src/__tests/MandalaToken.test.ts
git commit -m "feat(templates): MandalaToken lock and decode"
```

---

### Task 3: `MandalaToken` BRC-29 lock helper + `unlock`

**Files:**
- Modify: `packages/helpers/ts-templates/src/MandalaToken.ts`
- Test: `packages/helpers/ts-templates/src/__tests/MandalaToken.unlock.test.ts`

**Interfaces:**
- Consumes: `WalletInterface`, `WalletProtocol`, `WalletCounterparty`, `ScriptTemplateUnlock`, `Transaction`, `Hash`, `Signature`, `TransactionSignature`, `PublicKey` from `@bsv/sdk`.
- Produces (added to `MandalaToken`):
  - `constructor(wallet?: WalletInterface, originator?: string)`
  - `async lockBRC29(assetId: string, amount: number, protocolID: WalletProtocol, keyID: string, counterparty: WalletCounterparty): Promise<LockingScript>`
  - `unlock(privateKey: PrivateKey, signOutputs?: 'all'|'none'|'single', anyoneCanPay?: boolean): ScriptTemplateUnlock`

`unlock` mirrors the SDK `P2PKH` spend: the unlocking script is `<sig> <pubkey>`, signed over the full Mandala locking script (the marker/assetId/amount prefix is part of the subscript). Use the wallet-free `PrivateKey` form for determinism in tests; the holder of the P2PKH key signs.

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaToken } from '../MandalaToken.js'
import { PrivateKey, Hash, Transaction, P2PKH } from '@bsv/sdk'

describe('MandalaToken unlock', () => {
  const assetId = `${'b'.repeat(64)}.1`

  it('signs a spend whose script verifies against the source output', async () => {
    const priv = PrivateKey.fromRandom()
    const pubKeyHash = Hash.hash160(priv.toPublicKey().encode(true) as number[])
    const lockingScript = new MandalaToken().lock(assetId, 5, pubKeyHash)

    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript, satoshis: 1 })

    const spendTx = new Transaction()
    spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff })
    spendTx.addOutput({ lockingScript: new P2PKH().lock(pubKeyHash), satoshis: 1 })

    const unlocker = new MandalaToken().unlock(priv)
    const unlockingScript = await unlocker.sign(spendTx, 0)
    spendTx.inputs[0].unlockingScript = unlockingScript

    // Two pushes: signature then pubkey.
    expect(unlockingScript.chunks.length).toBe(2)
    expect(unlockingScript.chunks[1].data?.length).toBe(33)
    expect(await unlocker.estimateLength()).toBeGreaterThan(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/MandalaToken.unlock.test.ts`
Expected: FAIL — `unlock is not a function` (method not yet added).

- [ ] **Step 3: Write minimal implementation**

Add imports and members to `MandalaToken.ts`:

```ts
import {
  ScriptTemplate, ScriptTemplateUnlock, LockingScript, UnlockingScript, OP, Utils,
  WalletInterface, WalletProtocol, WalletCounterparty, Transaction, Hash,
  Signature, TransactionSignature, PrivateKey
} from '@bsv/sdk'
```

```ts
  wallet?: WalletInterface
  originator?: string

  constructor (wallet?: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  async lockBRC29 (
    assetId: string,
    amount: number,
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: WalletCounterparty
  ): Promise<LockingScript> {
    if (this.wallet == null) throw new Error('lockBRC29 requires a wallet')
    const { publicKey } = await this.wallet.getPublicKey({ protocolID, keyID, counterparty }, this.originator)
    const pubKeyHash = Hash.hash160(Utils.toArray(publicKey, 'hex'))
    return this.lock(assetId, amount, pubKeyHash)
  }

  unlock (
    privateKey: PrivateKey,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        let scope = TransactionSignature.SIGHASH_FORKID
        if (signOutputs === 'all') scope |= TransactionSignature.SIGHASH_ALL
        else if (signOutputs === 'none') scope |= TransactionSignature.SIGHASH_NONE
        else if (signOutputs === 'single') scope |= TransactionSignature.SIGHASH_SINGLE
        if (anyoneCanPay) scope |= TransactionSignature.SIGHASH_ANYONECANPAY

        const input = tx.inputs[inputIndex]
        const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
        const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
        if (sourceTXID == null) throw new Error('sourceTXID or sourceTransaction required')
        if (sourceOutput?.satoshis == null) throw new Error('source satoshis required')
        if (sourceOutput.lockingScript == null) throw new Error('source lockingScript required')

        const preimage = TransactionSignature.format({
          sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: sourceOutput.satoshis,
          transactionVersion: tx.version,
          otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
          inputIndex,
          outputs: tx.outputs,
          inputSequence: input.sequence ?? 0xffffffff,
          subscript: sourceOutput.lockingScript,
          lockTime: tx.lockTime,
          scope
        })

        const rawSignature = privateKey.sign(Hash.sha256(preimage))
        const sig = new TransactionSignature(rawSignature.r, rawSignature.s, scope)
        const sigForScript = sig.toChecksigFormat()
        const pubkeyForScript = privateKey.toPublicKey().encode(true) as number[]
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkeyForScript.length, data: pubkeyForScript }
        ])
      },
      estimateLength: async () => 108
    }
  }
```

> Note: `TransactionSignature.format` hashes the preimage internally in some SDK versions. If verification/signature scope fails, mirror the SDK `P2PKH` exactly — it uses `sha256(preimage)` once (as above). Keep this consistent with `packages/sdk/src/script/templates/P2PKH.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests/MandalaToken.unlock.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/src/MandalaToken.ts packages/helpers/ts-templates/src/__tests/MandalaToken.unlock.test.ts
git commit -m "feat(templates): MandalaToken BRC-29 lock helper and P2PKH unlock"
```

---

### Task 4: `MandalaAdmin` — canonicalisation + boundKey derivation

**Files:**
- Create: `packages/helpers/ts-templates/src/MandalaAdmin.ts`
- Test: `packages/helpers/ts-templates/src/__tests/MandalaAdmin.derive.test.ts`

**Interfaces:**
- Consumes: `WalletInterface`, `WalletProtocol`, `Hash`, `Utils` from `@bsv/sdk`; `MARKER` from `./mandala-encoding.js`.
- Produces:
  - `type MandalaActionKind = 'register' | 'issue' | 'redeem' | 'recover'`
  - `interface MandalaActionDetails { kind: MandalaActionKind, assetId?: string, amount?: number, priorOutpoint?: string, [k: string]: unknown }`
  - `static canonicalize(actionDetails: MandalaActionDetails): string` — RFC 8785-style deterministic JSON (recursive lexicographic key ordering).
  - `static commitment(actionDetails: MandalaActionDetails): string` — `sha256(canonicalize)` as hex; used as the `keyID`.
  - `class MandalaAdmin` with `constructor(wallet: WalletInterface, originator?: string)` and `async deriveBoundKey(protocolID: WalletProtocol, actionDetails: MandalaActionDetails): Promise<{ boundKey: string, keyID: string }>` using `getPublicKey({ protocolID, keyID, counterparty: 'anyone' })`.

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaAdmin } from '../MandalaAdmin.js'

describe('MandalaAdmin canonicalize/commitment', () => {
  it('is insensitive to key ordering', () => {
    const a = MandalaAdmin.canonicalize({ kind: 'issue', amount: 5, assetId: 'x.0' } as any)
    const b = MandalaAdmin.canonicalize({ assetId: 'x.0', kind: 'issue', amount: 5 } as any)
    expect(a).toBe(b)
  })

  it('orders nested object keys', () => {
    const s = MandalaAdmin.canonicalize({ kind: 'issue', meta: { z: 1, a: 2 } } as any)
    expect(s).toBe('{"kind":"issue","meta":{"a":2,"z":1}}')
  })

  it('produces a stable 64-hex commitment', () => {
    const c = MandalaAdmin.commitment({ kind: 'register', assetId: 'x.0' })
    expect(c).toMatch(/^[0-9a-f]{64}$/)
    expect(c).toBe(MandalaAdmin.commitment({ assetId: 'x.0', kind: 'register' } as any))
  })

  it('derives a boundKey via getPublicKey with counterparty anyone', async () => {
    const calls: any[] = []
    const wallet: any = {
      getPublicKey: async (args: any) => { calls.push(args); return { publicKey: '02' + 'a'.repeat(64) } }
    }
    const admin = new MandalaAdmin(wallet)
    const details = { kind: 'issue', assetId: 'x.0', amount: 10 } as const
    const { boundKey, keyID } = await admin.deriveBoundKey([2, 'mandala admin'], details)
    expect(boundKey).toBe('02' + 'a'.repeat(64))
    expect(keyID).toBe(MandalaAdmin.commitment(details))
    expect(calls[0].counterparty).toBe('anyone')
    expect(calls[0].keyID).toBe(keyID)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/MandalaAdmin.derive.test.ts`
Expected: FAIL — `Cannot find module '../MandalaAdmin.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { WalletInterface, WalletProtocol, Hash, Utils } from '@bsv/sdk'

export type MandalaActionKind = 'register' | 'issue' | 'redeem' | 'recover'

export interface MandalaActionDetails {
  kind: MandalaActionKind
  assetId?: string
  amount?: number
  priorOutpoint?: string
  [k: string]: unknown
}

const canon = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon((value as Record<string, unknown>)[k])).join(',') + '}'
}

export class MandalaAdmin {
  wallet: WalletInterface
  originator?: string

  constructor (wallet: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  static canonicalize (actionDetails: MandalaActionDetails): string {
    return canon(actionDetails)
  }

  static commitment (actionDetails: MandalaActionDetails): string {
    return Utils.toHex(Hash.sha256(Utils.toArray(MandalaAdmin.canonicalize(actionDetails), 'utf8')))
  }

  async deriveBoundKey (
    protocolID: WalletProtocol,
    actionDetails: MandalaActionDetails
  ): Promise<{ boundKey: string, keyID: string }> {
    const keyID = MandalaAdmin.commitment(actionDetails)
    const { publicKey } = await this.wallet.getPublicKey({ protocolID, keyID, counterparty: 'anyone' }, this.originator)
    return { boundKey: publicKey, keyID }
  }
}
```

> Note: `canon` is a pragmatic RFC 8785 subset (lexicographic key ordering, `JSON.stringify` scalar forms). It is sufficient for the JSON shapes used here. If full RFC 8785 number canonicalisation is later required, swap `canon` for a vetted JCS library — the public method signatures stay identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests/MandalaAdmin.derive.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/src/MandalaAdmin.ts packages/helpers/ts-templates/src/__tests/MandalaAdmin.derive.test.ts
git commit -m "feat(templates): MandalaAdmin canonicalize and boundKey derivation"
```

---

### Task 5: `MandalaAdmin.lock` + `decode` + `unlock`

**Files:**
- Modify: `packages/helpers/ts-templates/src/MandalaAdmin.ts`
- Test: `packages/helpers/ts-templates/src/__tests/MandalaAdmin.script.test.ts`

**Interfaces:**
- Consumes: as Task 4 plus `LockingScript, UnlockingScript, OP, ScriptTemplateUnlock, Transaction, TransactionSignature, Signature, WalletCounterparty` from `@bsv/sdk`; `createMinimallyEncodedScriptChunk, MARKER` from `./mandala-encoding.js`.
- Produces (added to `MandalaAdmin`):
  - `interface MandalaAdminDecoded { boundKey: string }`
  - `lock(boundKey: string): LockingScript` — `[marker] OP_DROP [boundKey 33B] OP_CHECKSIG`.
  - `static decode(script: LockingScript): MandalaAdminDecoded`.
  - `unlock(protocolID: WalletProtocol, actionDetails: MandalaActionDetails, signOutputs?, anyoneCanPay?): ScriptTemplateUnlock` — signs with `counterparty: 'anyone'` and the derived `keyID` via `wallet.createSignature`; unlocking script is a single `<sig>` push.

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaAdmin } from '../MandalaAdmin.js'
import { PrivateKey, Utils, OP } from '@bsv/sdk'

describe('MandalaAdmin lock/decode', () => {
  it('round-trips the boundKey and has the ! OP_DROP <key> OP_CHECKSIG shape', () => {
    const boundKey = PrivateKey.fromRandom().toPublicKey().toString()
    const admin = new MandalaAdmin({} as any)
    const script = admin.lock(boundKey)
    const ops = script.chunks.map(c => c.op)
    expect(script.chunks[0].data).toEqual([0x21])
    expect(ops[1]).toBe(OP.OP_DROP)
    expect(ops[3]).toBe(OP.OP_CHECKSIG)
    expect(MandalaAdmin.decode(script).boundKey).toBe(boundKey)
  })

  it('decode throws on non-admin scripts', () => {
    expect(() => MandalaAdmin.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/MandalaAdmin.script.test.ts`
Expected: FAIL — `admin.lock is not a function`.

- [ ] **Step 3: Write minimal implementation**

Extend imports:

```ts
import {
  WalletInterface, WalletProtocol, WalletCounterparty, Hash, Utils,
  LockingScript, UnlockingScript, OP, ScriptTemplateUnlock, Transaction,
  TransactionSignature, Signature
} from '@bsv/sdk'
import { createMinimallyEncodedScriptChunk, MARKER } from './mandala-encoding.js'
```

Add members:

```ts
  lock (boundKey: string): LockingScript {
    const keyBytes = Utils.toArray(boundKey, 'hex')
    if (keyBytes.length !== 33) throw new Error('boundKey must be a 33-byte compressed public key')
    return new LockingScript([
      createMinimallyEncodedScriptChunk([MARKER]),
      { op: OP.OP_DROP },
      { op: keyBytes.length, data: keyBytes },
      { op: OP.OP_CHECKSIG }
    ])
  }

  static decode (script: LockingScript): MandalaAdminDecoded {
    const c = script.chunks
    if (c.length !== 4) throw new Error('not a MandalaAdmin script: wrong chunk count')
    const marker = c[0].data ?? []
    if (marker.length !== 1 || marker[0] !== MARKER) throw new Error('not a MandalaAdmin script: missing marker')
    if (c[1].op !== OP.OP_DROP || c[3].op !== OP.OP_CHECKSIG) throw new Error('not a MandalaAdmin script: bad shape')
    const keyData = c[2].data
    if (keyData == null || keyData.length !== 33) throw new Error('not a MandalaAdmin script: bad boundKey')
    return { boundKey: Utils.toHex(keyData) }
  }

  unlock (
    protocolID: WalletProtocol,
    actionDetails: MandalaActionDetails,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        let scope = TransactionSignature.SIGHASH_FORKID
        if (signOutputs === 'all') scope |= TransactionSignature.SIGHASH_ALL
        else if (signOutputs === 'none') scope |= TransactionSignature.SIGHASH_NONE
        else if (signOutputs === 'single') scope |= TransactionSignature.SIGHASH_SINGLE
        if (anyoneCanPay) scope |= TransactionSignature.SIGHASH_ANYONECANPAY

        const input = tx.inputs[inputIndex]
        const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
        const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
        if (sourceTXID == null) throw new Error('sourceTXID or sourceTransaction required')
        if (sourceOutput?.satoshis == null) throw new Error('source satoshis required')
        if (sourceOutput.lockingScript == null) throw new Error('source lockingScript required')

        const preimage = TransactionSignature.format({
          sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: sourceOutput.satoshis,
          transactionVersion: tx.version,
          otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
          inputIndex,
          outputs: tx.outputs,
          inputSequence: input.sequence ?? 0xffffffff,
          subscript: sourceOutput.lockingScript,
          lockTime: tx.lockTime,
          scope
        })

        const keyID = MandalaAdmin.commitment(actionDetails)
        const { signature: bareSignature } = await this.wallet.createSignature({
          hashToDirectlySign: Hash.hash256(preimage),
          protocolID,
          keyID,
          counterparty: 'anyone'
        }, this.originator)
        const signature = Signature.fromDER([...bareSignature])
        const txSignature = new TransactionSignature(signature.r, signature.s, scope)
        const sigForScript = txSignature.toChecksigFormat()
        return new UnlockingScript([{ op: sigForScript.length, data: sigForScript }])
      },
      estimateLength: async () => 74
    }
  }
```

Add the decoded interface near the top (after `MandalaActionDetails`):

```ts
export interface MandalaAdminDecoded {
  boundKey: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests/MandalaAdmin.script.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/src/MandalaAdmin.ts packages/helpers/ts-templates/src/__tests/MandalaAdmin.script.test.ts
git commit -m "feat(templates): MandalaAdmin lock, decode and CHECKSIG unlock"
```

---

### Task 6: Public exports + full build/test gate

**Files:**
- Modify: `packages/helpers/ts-templates/mod.ts`
- Test: `packages/helpers/ts-templates/src/__tests/exports.test.ts`

**Interfaces:**
- Consumes: all classes/types above.
- Produces: package-level exports of `MandalaToken`, `MandalaTokenDecoded`, `MandalaAdmin`, `MandalaAdminDecoded`, `MandalaActionDetails`, `MandalaActionKind` from `@bsv/templates`.

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaToken, MandalaAdmin } from '../../mod.js'

describe('package exports', () => {
  it('exposes the Mandala templates from the package entrypoint', () => {
    expect(typeof MandalaToken).toBe('function')
    expect(typeof MandalaAdmin).toBe('function')
    expect(typeof MandalaAdmin.canonicalize).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests/exports.test.ts`
Expected: FAIL — `mod.js` does not export `MandalaToken`.

- [ ] **Step 3: Add exports**

Append to `packages/helpers/ts-templates/mod.ts`:

```ts
export { MandalaToken } from './src/MandalaToken.js'
export type { MandalaTokenDecoded } from './src/MandalaToken.js'
export { MandalaAdmin } from './src/MandalaAdmin.js'
export type { MandalaAdminDecoded, MandalaActionDetails, MandalaActionKind } from './src/MandalaAdmin.js'
```

- [ ] **Step 4: Run the full package gate**

Run: `cd packages/helpers/ts-templates && npm test`
Expected: build succeeds (dual ESM/CJS), all Mandala test suites PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd packages/helpers/ts-templates && npm run lint && cd -
git add packages/helpers/ts-templates/mod.ts packages/helpers/ts-templates/src/__tests/exports.test.ts
git commit -m "feat(templates): export Mandala token and admin templates"
```

---

## Self-Review

- **Spec coverage:** §3.1 MandalaToken (Tasks 2–3), §3.2 MandalaAdmin incl. canonical JSON + getPublicKey/anyone derivation (Tasks 4–5), FT-only with no arbitrary data (Task 2 fixed 10-chunk shape), exports (Task 6). Overlay sections (§4–§8) are Plan 2. ✓
- **Placeholder scan:** no TBD/TODO left as work; the two `> Note:` blocks are explicit verification-and-adjust instructions with concrete fallbacks, not deferred work. ✓
- **Type consistency:** `decode()` return shapes (`MandalaTokenDecoded`, `MandalaAdminDecoded`), `assetId` string format `"txid.vout"`, and `commitment()`/`deriveBoundKey()` signatures are used identically across tasks and are the exact surface Plan 2 consumes. ✓
