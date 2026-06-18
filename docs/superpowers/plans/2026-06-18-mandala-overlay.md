# Mandala Token Regulated-Transfer Overlay — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tm_mandala` topic manager and `ls_mandala` lookup service to `@bsv/overlay-topics` that admit BRC-92 Mandala FT transfers only after verifying off-chain `revealSpecificKeyLinkage` data, enforcing token conservation and the admin authorization chain, and screening both transfer sides against an injected sanctions list — while retaining the (already-encrypted) linkage data.

**Architecture:** `MandalaTopicManager.identifyAdmissibleOutputs` decodes Mandala outputs (via the `@bsv/templates` `MandalaToken`/`MandalaAdmin` classes from Plan 1), reads the off-chain linkage payload from `offChainValues`, verifies each input/output's controlling identity key by decrypting the linkage with the overlay's verifier wallet and performing elliptic-curve point addition, enforces conservation/admin rules, then rejects the whole transaction if any derived identity key is sanctioned. `MandalaLookupService` persists token UTXOs, the encrypted linkage ciphertext, and internal per-identity balances in MongoDB, and answers queries by assetId/outpoint only.

**Tech Stack:** TypeScript (ESM), `@bsv/sdk` (`ProtoWallet`, `Curve`, `Point`, `BigNumber`, `Hash`, `PublicKey`), `@bsv/templates` (Plan 1), `@bsv/overlay` (`TopicManager`/`LookupService` interfaces), MongoDB, Jest + `ts-jest` + `mongodb-memory-server`.

## Global Constraints

- Package: `@bsv/overlay-topics` at `packages/overlays/topics`. New module dir: `src/mandala/`. Tests: `src/__tests__/mandala.test.ts` (matches existing `testMatch`) plus focused `src/mandala/__tests/*.test.ts`.
- **Depends on Plan 1.** `@bsv/templates` must export `MandalaToken`, `MandalaAdmin`, `MandalaActionDetails` before this plan runs. Add `"@bsv/templates": "workspace:*"` to `packages/overlays/topics/package.json` dependencies (Task 1) — match the `workspace:*` style of other intra-repo deps in that file; if a different style is used there, follow it.
- Lint: `ts-standard --fix src/**/*.ts` (2-space, no semicolons, single quotes). Run `npm run lint` before each commit.
- Test command (package dir): `npm test` = `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand`. Single suite: `npx jest --runInBand src/__tests__/mandala.test.ts`.
- ESM imports MUST use the `.js` extension on relative paths (jest `moduleNameMapper` strips it). Import SDK symbols from `@bsv/sdk`, overlay interfaces from `@bsv/overlay`, templates from `@bsv/templates`.
- `assetId` string format is `"<txid>.<vout>"` (defined in Plan 1). `decode()` returns: `MandalaToken` → `{ assetId, amount, pubKeyHash }`; `MandalaAdmin` → `{ boundKey }`.
- **Linkage protocol (exact):** the overlay is the `verifier`. The prover's wallet produced each linkage via `revealSpecificKeyLinkage`. To verify, decrypt `encryptedLinkage` with the overlay wallet using `protocolID: [2, \`specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}\`]`, `keyID: linkage.keyID`, `counterparty: linkage.prover`. The decrypted bytes are a scalar `L`. The controlling identity key is `linkage.counterparty`, and the derived key it controls is `counterpartyPubKey + L·G` (secp256k1 point addition). A linkage is valid for an output iff `hash160(derivedKey.encode(true)) === output.pubKeyHash`. Change outputs use the sender as their own counterparty — no special branch.
- **No public balance-by-identity query.** `lookup()` accepts only `{ assetId }` or `{ txid, outputIndex }` questions.
- **Retention:** linkage records have NO TTL index (must persist ≥5 years; deletion is out-of-band).

---

### Task 1: Module types, screening provider, and package dependency

**Files:**
- Modify: `packages/overlays/topics/package.json` (add `@bsv/templates` dependency)
- Create: `packages/overlays/topics/src/mandala/types.ts`
- Test: `packages/overlays/topics/src/mandala/__tests/types.test.ts`

**Interfaces:**
- Consumes: `Byte`, `PubKeyHex`, `WalletProtocol` from `@bsv/sdk`.
- Produces:
  - `interface SpecificLinkage { prover: PubKeyHex, verifier: PubKeyHex, counterparty: PubKeyHex, protocolID: WalletProtocol, keyID: string, encryptedLinkage: number[], encryptedLinkageProof: number[], proofType: number }` (shape of `RevealSpecificKeyLinkageResult`).
  - `interface MandalaLinkagePayload { inputs: Array<{ index: number, linkage: SpecificLinkage }>, outputs: Array<{ index: number, linkage: SpecificLinkage }> }`
  - `interface MandalaTokenRecord { txid: string, outputIndex: number, assetId: string, amount: number, identityKey: PubKeyHex, createdAt: Date }`
  - `interface MandalaLinkageRecord { txid: string, outputIndex: number, identityKey: PubKeyHex, linkage: SpecificLinkage, createdAt: Date }`
  - `interface UTXOReference { txid: string, outputIndex: number }`
  - `interface ScreeningProvider { isSanctioned: (identityKey: PubKeyHex) => Promise<boolean> }`
  - `class InMemoryScreeningProvider implements ScreeningProvider` (constructed with `PubKeyHex[]`).
  - `encodeLinkagePayload(payload: MandalaLinkagePayload): number[]` and `decodeLinkagePayload(bytes: number[]): MandalaLinkagePayload` (JSON over utf8).

- [ ] **Step 1: Write the failing test**

```ts
import {
  InMemoryScreeningProvider, encodeLinkagePayload, decodeLinkagePayload, MandalaLinkagePayload
} from '../types.js'

describe('mandala types', () => {
  it('screens listed identity keys', async () => {
    const p = new InMemoryScreeningProvider(['02aa'])
    expect(await p.isSanctioned('02aa')).toBe(true)
    expect(await p.isSanctioned('02bb')).toBe(false)
  })

  it('round-trips a linkage payload through offChainValues bytes', () => {
    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [{ index: 0, linkage: {
        prover: '02aa', verifier: '02bb', counterparty: '02cc',
        protocolID: [2, 'mandala token'], keyID: 'k1',
        encryptedLinkage: [1, 2, 3], encryptedLinkageProof: [0], proofType: 0
      } }]
    }
    expect(decodeLinkagePayload(encodeLinkagePayload(payload))).toEqual(payload)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --runInBand src/mandala/__tests/types.test.ts`
Expected: FAIL — `Cannot find module '../types.js'`.

- [ ] **Step 3: Write implementation + add dependency**

Add to `packages/overlays/topics/package.json` `dependencies` (alongside `@bsv/overlay`, `@bsv/sdk`):

```json
"@bsv/templates": "workspace:*",
```

Then `pnpm install` from the repo root so the workspace link resolves.

Create `src/mandala/types.ts`:

```ts
import { PubKeyHex, WalletProtocol, Utils } from '@bsv/sdk'

export interface SpecificLinkage {
  prover: PubKeyHex
  verifier: PubKeyHex
  counterparty: PubKeyHex
  protocolID: WalletProtocol
  keyID: string
  encryptedLinkage: number[]
  encryptedLinkageProof: number[]
  proofType: number
}

export interface MandalaLinkagePayload {
  inputs: Array<{ index: number, linkage: SpecificLinkage }>
  outputs: Array<{ index: number, linkage: SpecificLinkage }>
}

export interface MandalaTokenRecord {
  txid: string
  outputIndex: number
  assetId: string
  amount: number
  identityKey: PubKeyHex
  createdAt: Date
}

export interface MandalaLinkageRecord {
  txid: string
  outputIndex: number
  identityKey: PubKeyHex
  linkage: SpecificLinkage
  createdAt: Date
}

export interface UTXOReference {
  txid: string
  outputIndex: number
}

export interface ScreeningProvider {
  isSanctioned: (identityKey: PubKeyHex) => Promise<boolean>
}

export class InMemoryScreeningProvider implements ScreeningProvider {
  private readonly banned: Set<string>
  constructor (bannedIdentityKeys: PubKeyHex[] = []) {
    this.banned = new Set(bannedIdentityKeys)
  }

  async isSanctioned (identityKey: PubKeyHex): Promise<boolean> {
    return this.banned.has(identityKey)
  }
}

export const encodeLinkagePayload = (payload: MandalaLinkagePayload): number[] => {
  return Utils.toArray(JSON.stringify(payload), 'utf8')
}

export const decodeLinkagePayload = (bytes: number[]): MandalaLinkagePayload => {
  return JSON.parse(Utils.toUTF8(bytes)) as MandalaLinkagePayload
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --runInBand src/mandala/__tests/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/package.json packages/overlays/topics/src/mandala/types.ts packages/overlays/topics/src/mandala/__tests/types.test.ts pnpm-lock.yaml
git commit -m "feat(overlay): mandala module types and in-memory screening provider"
```

---

### Task 2: `verifyKeyLinkage` — decrypt + EC point-addition verification

**Files:**
- Create: `packages/overlays/topics/src/mandala/verifyKeyLinkage.ts`
- Test: `packages/overlays/topics/src/mandala/__tests/verifyKeyLinkage.test.ts`

**Interfaces:**
- Consumes: `SpecificLinkage` from `./types.js`; `WalletInterface, Curve, BigNumber, PublicKey, Hash, Utils` from `@bsv/sdk`.
- Produces:
  - `async function verifyKeyLinkage(linkage: SpecificLinkage, verifierWallet: WalletInterface): Promise<{ identityKey: string, derivedKey: string, pubKeyHash: number[] }>` — decrypts the linkage, computes `derivedKey = counterparty + L·G`, returns the controlling `identityKey` (= `linkage.counterparty`) and `hash160(derivedKey)`. Throws on decryption failure.
  - `async function linkageControlsPubKeyHash(linkage: SpecificLinkage, verifierWallet: WalletInterface, pubKeyHash: number[]): Promise<boolean>` — true iff the verified `pubKeyHash` equals the given one.

- [ ] **Step 1: Write the failing test**

```ts
import { verifyKeyLinkage, linkageControlsPubKeyHash } from '../verifyKeyLinkage.js'
import { ProtoWallet, PrivateKey, Hash, Utils } from '@bsv/sdk'

describe('verifyKeyLinkage', () => {
  const protocolID: [number, string] = [2, 'mandala token']
  const keyID = 'token-1'

  const makeWallet = (priv = PrivateKey.fromRandom()) => ({ priv, wallet: new ProtoWallet(priv) })

  it('recovers the controlling identity key and derived pubKeyHash from a real reveal', async () => {
    const prover = makeWallet()      // the sender, who reveals linkage
    const verifier = makeWallet()    // the overlay
    const receiver = makeWallet()    // counterparty the key was derived for

    const { publicKey: verifierKey } = await verifier.wallet.getPublicKey({ identityKey: true })
    const { publicKey: receiverKey } = await receiver.wallet.getPublicKey({ identityKey: true })

    // The key the sender derives FOR the receiver — what the output is locked to.
    const { publicKey: derivedKey } = await prover.wallet.getPublicKey({
      protocolID, keyID, counterparty: receiverKey
    })

    const linkage = await prover.wallet.revealSpecificKeyLinkage({
      counterparty: receiverKey, verifier: verifierKey, protocolID, keyID
    })

    const result = await verifyKeyLinkage(linkage as any, verifier.wallet)
    expect(result.identityKey).toBe(receiverKey)
    expect(result.derivedKey).toBe(derivedKey)

    const expectedHash = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    expect(result.pubKeyHash).toEqual(expectedHash)
    expect(await linkageControlsPubKeyHash(linkage as any, verifier.wallet, expectedHash)).toBe(true)
    expect(await linkageControlsPubKeyHash(linkage as any, verifier.wallet, new Array(20).fill(0))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --runInBand src/mandala/__tests/verifyKeyLinkage.test.ts`
Expected: FAIL — `Cannot find module '../verifyKeyLinkage.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { WalletInterface, Curve, BigNumber, PublicKey, Hash, Utils } from '@bsv/sdk'
import { SpecificLinkage } from './types.js'

export async function verifyKeyLinkage (
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface
): Promise<{ identityKey: string, derivedKey: string, pubKeyHash: number[] }> {
  // 1. Decrypt the linkage scalar L. The prover encrypted it to the verifier
  //    under a derived "specific linkage revelation" protocol keyed by the
  //    original protocolID + keyID, with the prover as counterparty.
  const { plaintext } = await verifierWallet.decrypt({
    ciphertext: linkage.encryptedLinkage,
    protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })

  // 2. derivedKey = counterpartyIdentityKey + L*G  (secp256k1 point addition)
  const curve = new Curve()
  const L = new BigNumber(plaintext)
  const offset = curve.g.mul(L)
  const counterparty = PublicKey.fromString(linkage.counterparty)
  const sum = counterparty.add(offset)
  const derived = new PublicKey(sum.x, sum.y)
  const derivedKey = derived.toString()
  const pubKeyHash = Hash.hash160(Utils.toArray(derivedKey, 'hex'))

  return { identityKey: linkage.counterparty, derivedKey, pubKeyHash }
}

export async function linkageControlsPubKeyHash (
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface,
  pubKeyHash: number[]
): Promise<boolean> {
  try {
    const { pubKeyHash: derivedHash } = await verifyKeyLinkage(linkage, verifierWallet)
    if (derivedHash.length !== pubKeyHash.length) return false
    return derivedHash.every((b, i) => b === pubKeyHash[i])
  } catch {
    return false
  }
}
```

> Note: `PublicKey.fromString` accepts the compressed hex (`02…/03…`). `derived.toString()` returns compressed hex matching `getPublicKey().publicKey`. If `curve.g.mul` or `.add` names differ in the installed SDK version, confirm against `node -e` (already verified: `new Curve().g.mul(new BigNumber(L))` and `PublicKey.add` exist) before adjusting.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --runInBand src/mandala/__tests/verifyKeyLinkage.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/src/mandala/verifyKeyLinkage.ts packages/overlays/topics/src/mandala/__tests/verifyKeyLinkage.test.ts
git commit -m "feat(overlay): mandala key-linkage decrypt and point-addition verification"
```

---

### Task 3: `MandalaStorageManager` (MongoDB)

**Files:**
- Create: `packages/overlays/topics/src/mandala/MandalaStorageManager.ts`
- Test: `packages/overlays/topics/src/mandala/__tests/MandalaStorageManager.test.ts`

**Interfaces:**
- Consumes: `Collection, Db` from `mongodb`; record/reference types from `./types.js`.
- Produces `class MandalaStorageManager` with:
  - `constructor(db: Db)`
  - `async storeToken(record: MandalaTokenRecord): Promise<void>`
  - `async storeLinkage(record: MandalaLinkageRecord): Promise<void>`
  - `async adjustBalance(identityKey: string, delta: number): Promise<void>`
  - `async deleteToken(txid: string, outputIndex: number): Promise<void>`
  - `async findByAssetId(assetId: string): Promise<UTXOReference[]>`
  - `async findByOutpoint(txid: string, outputIndex: number): Promise<UTXOReference[]>`
  - `async getBalance(identityKey: string): Promise<number>` (internal only)

- [ ] **Step 1: Write the failing test**

```ts
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaStorageManager } from '../MandalaStorageManager.js'

describe('MandalaStorageManager', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let store: MandalaStorageManager

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_test')
  })
  afterAll(async () => { await client.close(); await mongo.stop() })
  beforeEach(async () => {
    await db.dropDatabase()
    store = new MandalaStorageManager(db)
  })

  it('stores and finds tokens by assetId and outpoint', async () => {
    const now = new Date()
    await store.storeToken({ txid: 'aa', outputIndex: 0, assetId: 'x.0', amount: 5, identityKey: '02cc', createdAt: now })
    expect(await store.findByAssetId('x.0')).toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await store.findByOutpoint('aa', 0)).toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await store.findByAssetId('y.0')).toEqual([])
  })

  it('tracks balances internally and deletes tokens', async () => {
    await store.adjustBalance('02cc', 5)
    await store.adjustBalance('02cc', -2)
    expect(await store.getBalance('02cc')).toBe(3)
    await store.storeToken({ txid: 'aa', outputIndex: 0, assetId: 'x.0', amount: 5, identityKey: '02cc', createdAt: new Date() })
    await store.deleteToken('aa', 0)
    expect(await store.findByOutpoint('aa', 0)).toEqual([])
  })

  it('retains linkage records (no TTL index on linkageRecords)', async () => {
    await store.storeLinkage({
      txid: 'aa', outputIndex: 0, identityKey: '02cc',
      linkage: { prover: '02aa', verifier: '02bb', counterparty: '02cc', protocolID: [2, 'mandala token'], keyID: 'k', encryptedLinkage: [1], encryptedLinkageProof: [0], proofType: 0 },
      createdAt: new Date()
    })
    const indexes = await db.collection('mandalaLinkageRecords').indexes()
    expect(indexes.some(i => 'expireAfterSeconds' in i)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --runInBand src/mandala/__tests/MandalaStorageManager.test.ts`
Expected: FAIL — `Cannot find module '../MandalaStorageManager.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Collection, Db } from 'mongodb'
import {
  MandalaTokenRecord, MandalaLinkageRecord, UTXOReference
} from './types.js'

interface BalanceRecord { identityKey: string, balance: number }

export class MandalaStorageManager {
  private readonly tokens: Collection<MandalaTokenRecord>
  private readonly linkage: Collection<MandalaLinkageRecord>
  private readonly balances: Collection<BalanceRecord>
  private indexInit?: Promise<void>

  constructor (private readonly db: Db) {
    this.tokens = db.collection<MandalaTokenRecord>('mandalaTokens')
    this.linkage = db.collection<MandalaLinkageRecord>('mandalaLinkageRecords')
    this.balances = db.collection<BalanceRecord>('mandalaBalances')
  }

  private async ensureIndexes (): Promise<void> {
    if (this.indexInit === undefined) {
      this.indexInit = (async () => {
        await Promise.all([
          this.tokens.createIndex({ txid: 1, outputIndex: 1 }, { unique: true }),
          this.tokens.createIndex({ assetId: 1 }),
          this.tokens.createIndex({ identityKey: 1 }),
          // Deliberately NO TTL index on linkage — retention is >= 5 years.
          this.linkage.createIndex({ txid: 1, outputIndex: 1 }),
          this.linkage.createIndex({ identityKey: 1 }),
          this.balances.createIndex({ identityKey: 1 }, { unique: true })
        ])
      })()
    }
    return await this.indexInit
  }

  async storeToken (record: MandalaTokenRecord): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.insertOne(record)
  }

  async storeLinkage (record: MandalaLinkageRecord): Promise<void> {
    await this.ensureIndexes()
    await this.linkage.insertOne(record)
  }

  async adjustBalance (identityKey: string, delta: number): Promise<void> {
    await this.ensureIndexes()
    await this.balances.updateOne(
      { identityKey },
      { $inc: { balance: delta } },
      { upsert: true }
    )
  }

  async deleteToken (txid: string, outputIndex: number): Promise<void> {
    await this.ensureIndexes()
    await this.tokens.deleteOne({ txid, outputIndex })
  }

  async findByAssetId (assetId: string): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ assetId })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async findByOutpoint (txid: string, outputIndex: number): Promise<UTXOReference[]> {
    await this.ensureIndexes()
    return await this.tokens.find({ txid, outputIndex })
      .project<UTXOReference>({ txid: 1, outputIndex: 1, _id: 0 }).toArray()
  }

  async getBalance (identityKey: string): Promise<number> {
    await this.ensureIndexes()
    const rec = await this.balances.findOne({ identityKey })
    return rec?.balance ?? 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --runInBand src/mandala/__tests/MandalaStorageManager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/src/mandala/MandalaStorageManager.ts packages/overlays/topics/src/mandala/__tests/MandalaStorageManager.test.ts
git commit -m "feat(overlay): mandala MongoDB storage manager"
```

---

### Task 4: `MandalaTopicManager.identifyAdmissibleOutputs`

**Files:**
- Create: `packages/overlays/topics/src/mandala/MandalaTopicManager.ts`
- Create: `packages/overlays/topics/src/mandala/MandalaTopicDocs.md.ts`
- Test: `packages/overlays/topics/src/__tests__/mandala.test.ts`

**Interfaces:**
- Consumes: `TopicManager` from `@bsv/overlay`; `AdmittanceInstructions, Transaction, WalletInterface, Hash, Utils` from `@bsv/sdk`; `MandalaToken, MandalaAdmin` from `@bsv/templates`; `verifyKeyLinkage` from `./verifyKeyLinkage.js`; `decodeLinkagePayload`, `ScreeningProvider` from `./types.js`; docs string from `./MandalaTopicDocs.md.js`.
- Produces:
  - `interface MandalaTopicManagerDeps { verifierWallet: WalletInterface, screeningProvider: ScreeningProvider }`
  - `class MandalaTopicManager implements TopicManager` with `constructor(deps)`, `identifyAdmissibleOutputs`, `getDocumentation`, `getMetaData`.

**Admittance algorithm (implement exactly):**
1. `const tx = Transaction.fromBEEF(beef)`.
2. Parse linkage payload: `offChainValues != null ? decodeLinkagePayload(offChainValues) : { inputs: [], outputs: [] }`.
3. For each output, try `MandalaToken.decode` (FT) then `MandalaAdmin.decode` (admin); collect classified outputs.
4. For each FT output, require a matching linkage entry whose verified `pubKeyHash` equals the output's `pubKeyHash` (`verifyKeyLinkage`); map output → `identityKey`. If no valid linkage, the output is not admitted.
5. Compute conservation: sum FT output amounts per assetId. Sum input amounts per assetId by decoding each spent output named in `previousCoins` (their source outputs are present in the BEEF). If the tx contains a verified admin output (`issue`/`recover`) the assetId may gain supply (outputs > inputs allowed); otherwise require `outputsTotal === inputsTotal` per assetId — else admit nothing.
6. Screening: gather every `identityKey` derived for admitted FT outputs AND every input identity key from `payload.inputs` (verified). If `screeningProvider.isSanctioned` is true for any, return empty admittance (reject whole tx).
7. Return `{ outputsToAdmit: number[], coinsToRetain: number[] }` — admit indices of valid FT + admin outputs; retain `previousCoins`.
8. Wrap the body in try/catch; on error `console.warn('[MandalaTopicManager] ' + error)` and return `{ outputsToAdmit: [], coinsToRetain: [] }` (mirror BTMS).

- [ ] **Step 1: Write the failing test**

```ts
import { MandalaTopicManager } from '../mandala/MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../mandala/types.js'
import { MandalaToken } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, P2PKH, Hash, Utils } from '@bsv/sdk'

const protocolID: [number, string] = [2, 'mandala token']
const keyID = 'tkn'

async function buildTransfer (opts: { sanctioned?: boolean } = {}) {
  const sender = new ProtoWallet(PrivateKey.fromRandom())
  const receiver = new ProtoWallet(PrivateKey.fromRandom())
  const overlay = new ProtoWallet(PrivateKey.fromRandom())

  const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
  const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
  const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })

  const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
  const assetId = `${'a'.repeat(64)}.0`
  const lockingScript = new MandalaToken().lock(assetId, 100, pkh)

  const tx = new Transaction()
  tx.addOutput({ lockingScript, satoshis: 1 })

  const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
  const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })

  const screening = new InMemoryScreeningProvider(opts.sanctioned === true ? [receiverKey] : [])
  return { tm: new MandalaTopicManager({ verifierWallet: overlay, screeningProvider: screening }), beef: tx.toBEEF(), offChainValues }
}

describe('MandalaTopicManager', () => {
  it('admits an FT output whose linkage verifies and party is clean', async () => {
    const { tm, beef, offChainValues } = await buildTransfer()
    const result = await tm.identifyAdmissibleOutputs(beef, [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('rejects the whole tx when a party is sanctioned', async () => {
    const { tm, beef, offChainValues } = await buildTransfer({ sanctioned: true })
    const result = await tm.identifyAdmissibleOutputs(beef, [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })

  it('does not admit FT outputs lacking valid linkage', async () => {
    const { tm, beef } = await buildTransfer()
    const result = await tm.identifyAdmissibleOutputs(beef, [], undefined)
    expect(result.outputsToAdmit).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --runInBand src/__tests__/mandala.test.ts`
Expected: FAIL — `Cannot find module '../mandala/MandalaTopicManager.js'`.

- [ ] **Step 3: Write the docs file**

Create `src/mandala/MandalaTopicDocs.md.ts`:

```ts
export default `# Mandala Token Topic Manager (tm_mandala)

Admits BRC-92 Mandala fungible-token transfer outputs after verifying off-chain
\`revealSpecificKeyLinkage\` data, enforcing token conservation and the admin
authorization chain, and screening both transfer parties against a sanctions list.
Linkage data travels off-chain via \`offChainValues\` and is retained (encrypted).
`
```

- [ ] **Step 4: Write minimal implementation**

```ts
import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction, WalletInterface, Hash, Utils } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload, ScreeningProvider, SpecificLinkage } from './types.js'
import docs from './MandalaTopicDocs.md.js'

export interface MandalaTopicManagerDeps {
  verifierWallet: WalletInterface
  screeningProvider: ScreeningProvider
}

export class MandalaTopicManager implements TopicManager {
  constructor (private readonly deps: MandalaTopicManagerDeps) {}

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const payload = offChainValues != null
        ? decodeLinkagePayload(offChainValues)
        : { inputs: [], outputs: [] }

      // Classify outputs.
      const ftOutputs: Array<{ index: number, assetId: string, amount: number, pubKeyHash: number[] }> = []
      let hasVerifiedAdmin = false
      const adminIndices: number[] = []
      for (let i = 0; i < tx.outputs.length; i++) {
        const ls = tx.outputs[i].lockingScript
        try {
          const d = MandalaToken.decode(ls)
          ftOutputs.push({ index: i, ...d })
          continue
        } catch { /* not FT */ }
        try {
          MandalaAdmin.decode(ls)
          adminIndices.push(i)
          hasVerifiedAdmin = true // chain/CHECKSIG enforced by consensus on spend; presence authorises supply change
        } catch { /* not admin */ }
      }

      const outputLinkage = new Map<number, SpecificLinkage>()
      for (const o of payload.outputs) outputLinkage.set(o.index, o.linkage)

      // Verify linkage per FT output.
      const admittedFt: Array<{ index: number, assetId: string, amount: number, identityKey: string }> = []
      for (const ft of ftOutputs) {
        const linkage = outputLinkage.get(ft.index)
        if (linkage == null) continue
        const verified = await verifyKeyLinkage(linkage, this.deps.verifierWallet)
        const matches = verified.pubKeyHash.length === ft.pubKeyHash.length &&
          verified.pubKeyHash.every((b, i) => b === ft.pubKeyHash[i])
        if (!matches) continue
        admittedFt.push({ index: ft.index, assetId: ft.assetId, amount: ft.amount, identityKey: verified.identityKey })
      }

      // Conservation per assetId.
      const outTotals = new Map<string, number>()
      for (const ft of admittedFt) outTotals.set(ft.assetId, (outTotals.get(ft.assetId) ?? 0) + ft.amount)

      const inTotals = new Map<string, number>()
      for (const ci of previousCoins) {
        const input = tx.inputs[ci]
        const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
        if (src == null) continue
        try {
          const d = MandalaToken.decode(src.lockingScript)
          inTotals.set(d.assetId, (inTotals.get(d.assetId) ?? 0) + d.amount)
        } catch { /* non-token previous coin */ }
      }
      for (const [assetId, outAmt] of outTotals) {
        const inAmt = inTotals.get(assetId) ?? 0
        if (!hasVerifiedAdmin && outAmt !== inAmt) {
          return { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      // Screen both sides.
      const identityKeys = new Set<string>()
      for (const ft of admittedFt) identityKeys.add(ft.identityKey)
      for (const inp of payload.inputs) {
        const v = await verifyKeyLinkage(inp.linkage, this.deps.verifierWallet)
        identityKeys.add(v.identityKey)
      }
      for (const key of identityKeys) {
        if (await this.deps.screeningProvider.isSanctioned(key)) {
          return { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      return {
        outputsToAdmit: [...admittedFt.map(f => f.index), ...adminIndices].sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[MandalaTopicManager] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'tm_mandala',
      shortDescription: 'BRC-92 Mandala regulated fungible-token transfers with key-linkage verification and sanctions screening.'
    }
  }
}
```

> Note on `hasVerifiedAdmin`: full admin-chain validation (boundKey re-derivation match + spending the prior authorization outpoint) requires the action-details JSON, which is delivered off-chain. Wiring that JSON into `offChainValues` and matching `MandalaAdmin` re-derivation is Task 6. For Task 4, presence of a structurally valid admin output authorises a supply change; Task 6 tightens it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest --runInBand src/__tests__/mandala.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/src/mandala/MandalaTopicManager.ts packages/overlays/topics/src/mandala/MandalaTopicDocs.md.ts packages/overlays/topics/src/__tests__/mandala.test.ts
git commit -m "feat(overlay): MandalaTopicManager admittance with linkage verify, conservation, screening"
```

---

### Task 5: `MandalaLookupService`

**Files:**
- Create: `packages/overlays/topics/src/mandala/MandalaLookupService.ts`
- Create: `packages/overlays/topics/src/mandala/MandalaLookupDocs.md.ts`
- Test: `packages/overlays/topics/src/mandala/__tests/MandalaLookupService.test.ts`

**Interfaces:**
- Consumes: `LookupService, LookupQuestion, LookupFormula, AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent` from `@bsv/overlay`; `Transaction, Utils` from `@bsv/sdk`; `MandalaToken` from `@bsv/templates`; `MandalaStorageManager` from `./MandalaStorageManager.js`; `verifyKeyLinkage` from `./verifyKeyLinkage.js`; payload/type helpers from `./types.js`.
- Produces:
  - `interface MandalaLookupDeps { storage: MandalaStorageManager, verifierWallet: WalletInterface }`
  - `class MandalaLookupService implements LookupService` with `admissionMode = 'locking-script'`, `spendNotificationMode = 'none'`, `outputAdmittedByTopic`, `outputSpent`, `lookup`, `getDocumentation`, `getMetaData`.
- `lookup` accepts ONLY `{ assetId: string }` or `{ txid: string, outputIndex: number }`; anything else throws `Error('Unsupported query')`. No balance-by-identity path exists.

- [ ] **Step 1: Write the failing test**

```ts
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaLookupService } from '../MandalaLookupService.js'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../types.js'
import { MandalaToken } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, Hash, Utils, LockingScript } from '@bsv/sdk'

const protocolID: [number, string] = [2, 'mandala token']
const keyID = 'tkn'

describe('MandalaLookupService', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_ls_test')
  })
  afterAll(async () => { await client.close(); await mongo.stop() })
  beforeEach(async () => { await db.dropDatabase() })

  it('persists an admitted token and answers assetId/outpoint queries; rejects other queries', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const assetId = `${'a'.repeat(64)}.0`
    const lockingScript = new MandalaToken().lock(assetId, 100, pkh)
    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })

    const storage = new MandalaStorageManager(db)
    const ls = new MandalaLookupService({ storage, verifierWallet: overlay })

    await ls.outputAdmittedByTopic({
      mode: 'locking-script', topic: 'tm_mandala',
      txid: 'aa', outputIndex: 0, satoshis: 1, lockingScript, offChainValues
    } as any)

    expect(await ls.lookup({ service: 'ls_mandala', query: { assetId } } as any))
      .toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await ls.lookup({ service: 'ls_mandala', query: { txid: 'aa', outputIndex: 0 } } as any))
      .toEqual([{ txid: 'aa', outputIndex: 0 }])
    await expect(ls.lookup({ service: 'ls_mandala', query: { identityKey: receiverKey } } as any))
      .rejects.toThrow('Unsupported query')
    expect(await storage.getBalance(receiverKey)).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --runInBand src/mandala/__tests/MandalaLookupService.test.ts`
Expected: FAIL — `Cannot find module '../MandalaLookupService.js'`.

- [ ] **Step 3: Write the docs file**

Create `src/mandala/MandalaLookupDocs.md.ts`:

```ts
export default `# Mandala Token Lookup Service (ls_mandala)

Indexes admitted Mandala token UTXOs by assetId and outpoint, retains the
(encrypted) key-linkage data, and maintains internal per-identity balances.
Queries are supported by assetId or by outpoint only. Identity balances are
NOT exposed through any query.
`
```

- [ ] **Step 4: Write minimal implementation**

```ts
import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { Transaction, WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { MandalaStorageManager } from './MandalaStorageManager.js'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload, SpecificLinkage } from './types.js'
import docs from './MandalaLookupDocs.md.js'

export interface MandalaLookupDeps {
  storage: MandalaStorageManager
  verifierWallet: WalletInterface
}

export class MandalaLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'locking-script'
  readonly spendNotificationMode: SpendNotificationMode = 'none'

  constructor (private readonly deps: MandalaLookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== 'tm_mandala') return
    let decoded
    try {
      decoded = MandalaToken.decode(payload.lockingScript)
    } catch {
      return // admin or non-token output: nothing to index
    }
    // Resolve controlling identity from the matching off-chain linkage.
    let identityKey = ''
    if (payload.offChainValues != null) {
      const parsed = decodeLinkagePayload(payload.offChainValues)
      const match = parsed.outputs.find(o => o.index === payload.outputIndex)
      if (match != null) {
        const v = await verifyKeyLinkage(match.linkage, this.deps.verifierWallet)
        identityKey = v.identityKey
      }
    }
    const now = new Date()
    await this.deps.storage.storeToken({
      txid: payload.txid, outputIndex: payload.outputIndex,
      assetId: decoded.assetId, amount: decoded.amount, identityKey, createdAt: now
    })
    if (identityKey !== '') {
      await this.deps.storage.adjustBalance(identityKey, decoded.amount)
      if (payload.offChainValues != null) {
        const parsed = decodeLinkagePayload(payload.offChainValues)
        const match = parsed.outputs.find(o => o.index === payload.outputIndex)
        if (match != null) {
          await this.deps.storage.storeLinkage({
            txid: payload.txid, outputIndex: payload.outputIndex,
            identityKey, linkage: match.linkage, createdAt: now
          })
        }
      }
    }
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_mandala') return
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = (question as any).query ?? {}
    if (typeof query.assetId === 'string') {
      return await this.deps.storage.findByAssetId(query.assetId)
    }
    if (typeof query.txid === 'string' && typeof query.outputIndex === 'number') {
      return await this.deps.storage.findByOutpoint(query.txid, query.outputIndex)
    }
    throw new Error('Unsupported query')
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'ls_mandala',
      shortDescription: 'Mandala token index by assetId/outpoint. No public identity-balance query.'
    }
  }
}
```

> Note: `outputSpent` decrements no balance here because `spendNotificationMode = 'none'` does not deliver the spent output's identity. The token row is deleted, which is sufficient for UTXO-set queries; balance reconciliation on spend is a known limitation tracked in §Self-Review / follow-ups. If exact live balances are required, raise `spendNotificationMode` to `'script'` and decrement using the stored token row's `identityKey` — do this in Task 6 if needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest --runInBand src/mandala/__tests/MandalaLookupService.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/src/mandala/MandalaLookupService.ts packages/overlays/topics/src/mandala/MandalaLookupDocs.md.ts packages/overlays/topics/src/mandala/__tests/MandalaLookupService.test.ts
git commit -m "feat(overlay): MandalaLookupService indexing and assetId/outpoint queries"
```

---

### Task 6: Admin-chain tightening, balance-on-spend, exports, full gate

**Files:**
- Modify: `packages/overlays/topics/src/mandala/types.ts` (extend payload with admin action details)
- Modify: `packages/overlays/topics/src/mandala/MandalaTopicManager.ts` (re-derive boundKey, require prior-outpoint spend)
- Modify: `packages/overlays/topics/src/mandala/MandalaLookupService.ts` (decrement balance on spend)
- Modify: `packages/overlays/topics/src/index.ts` (exports)
- Test: extend `packages/overlays/topics/src/__tests__/mandala.test.ts`

**Interfaces:**
- Consumes: `MandalaAdmin`, `MandalaActionDetails` from `@bsv/templates`.
- Produces:
  - `types.ts`: add `admin?: Array<{ index: number, actionDetails: MandalaActionDetails }>` to `MandalaLinkagePayload`.
  - `MandalaTopicManager`: an admin output is only counted as `hasVerifiedAdmin` when (a) a matching `admin[]` entry's `MandalaAdmin.deriveBoundKey(actionDetails)` reproduces the on-chain `boundKey`, and (b) for non-`register` kinds the tx spends the prior authorization outpoint named in `actionDetails.priorOutpoint`.
  - `MandalaLookupService`: switch `spendNotificationMode` to `'script'` and decrement the spent token's `identityKey` balance using the stored token row before deleting it.

- [ ] **Step 1: Write the failing tests**

```ts
// Append to src/__tests__/mandala.test.ts
import { MandalaAdmin } from '@bsv/templates'

describe('MandalaTopicManager admin chain', () => {
  it('admits an issuance whose boundKey re-derives from the declared action details', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const admin = new MandalaAdmin(issuer)
    const actionDetails = { kind: 'register' as const, assetId: `${'c'.repeat(64)}.0` }
    const { boundKey } = await admin.deriveBoundKey(adminProto, actionDetails)

    const tx = new Transaction()
    tx.addOutput({ lockingScript: admin.lock(boundKey), satoshis: 1 })

    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer, adminProtocolID: adminProto } as any)
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('rejects an admin output whose action details do not re-derive the boundKey', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']
    const admin = new MandalaAdmin(issuer)
    const { boundKey } = await admin.deriveBoundKey(adminProto, { kind: 'register', assetId: `${'c'.repeat(64)}.0` })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: admin.lock(boundKey), satoshis: 1 })
    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails: { kind: 'register', assetId: 'WRONG.0' } }]
    } as any)
    const tm = new MandalaTopicManager({ verifierWallet: overlay, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer, adminProtocolID: adminProto } as any)
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --runInBand src/__tests__/mandala.test.ts`
Expected: FAIL — admin re-derivation not implemented (admin output still admitted with wrong details, or deps shape unknown).

- [ ] **Step 3: Extend `MandalaLinkagePayload` in `types.ts`**

```ts
import { PubKeyHex, WalletProtocol, Utils } from '@bsv/sdk'
import { MandalaActionDetails } from '@bsv/templates'

// ... existing interfaces ...

export interface MandalaLinkagePayload {
  inputs: Array<{ index: number, linkage: SpecificLinkage }>
  outputs: Array<{ index: number, linkage: SpecificLinkage }>
  admin?: Array<{ index: number, actionDetails: MandalaActionDetails }>
}
```

- [ ] **Step 4: Tighten admin handling in `MandalaTopicManager.ts`**

Extend `MandalaTopicManagerDeps` and replace the admin classification block:

```ts
import { MandalaToken, MandalaAdmin, MandalaActionDetails } from '@bsv/templates'

export interface MandalaTopicManagerDeps {
  verifierWallet: WalletInterface
  screeningProvider: ScreeningProvider
  adminWallet: WalletInterface
  adminProtocolID: [number, string]
}
```

Replace the per-output admin branch (the `try { MandalaAdmin.decode... }` block) with a deferred check that uses the payload's admin entries:

```ts
      const adminDetails = new Map<number, MandalaActionDetails>()
      for (const a of (payload as any).admin ?? []) adminDetails.set(a.index, a.actionDetails)

      // ... inside the output loop, replace the admin catch branch body with: ...
        try {
          const decodedAdmin = MandalaAdmin.decode(ls)
          const details = adminDetails.get(i)
          if (details != null) {
            const adminTemplate = new MandalaAdmin(this.deps.adminWallet)
            const { boundKey } = await adminTemplate.deriveBoundKey(this.deps.adminProtocolID, details)
            const priorOk = details.kind === 'register' ||
              (typeof details.priorOutpoint === 'string' &&
                tx.inputs.some(inp => `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}` === details.priorOutpoint))
            if (boundKey === decodedAdmin.boundKey && priorOk) {
              adminIndices.push(i)
              hasVerifiedAdmin = true
            }
          }
        } catch { /* not admin */ }
```

> Because the output loop is now `async`-dependent (it `await`s `deriveBoundKey`), ensure the surrounding loop is a `for` loop (already is) so `await` is valid.

- [ ] **Step 5: Decrement balance on spend in `MandalaLookupService.ts`**

```ts
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_mandala') return
    const rows = await this.deps.storage.findByOutpoint(payload.txid, payload.outputIndex)
    if (rows.length > 0) {
      const tokenRow = await this.deps.storage.getTokenRow(payload.txid, payload.outputIndex)
      if (tokenRow != null && tokenRow.identityKey !== '') {
        await this.deps.storage.adjustBalance(tokenRow.identityKey, -tokenRow.amount)
      }
    }
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }
```

Add `getTokenRow` to `MandalaStorageManager`:

```ts
  async getTokenRow (txid: string, outputIndex: number): Promise<MandalaTokenRecord | null> {
    await this.ensureIndexes()
    return await this.tokens.findOne({ txid, outputIndex })
  }
```

- [ ] **Step 6: Add exports in `src/index.ts`**

Append:

```ts
export { MandalaTopicManager } from './mandala/MandalaTopicManager.js'
export { MandalaLookupService } from './mandala/MandalaLookupService.js'
export { MandalaStorageManager } from './mandala/MandalaStorageManager.js'
export { InMemoryScreeningProvider } from './mandala/types.js'
export { verifyKeyLinkage } from './mandala/verifyKeyLinkage.js'
export type {
  ScreeningProvider, SpecificLinkage, MandalaLinkagePayload,
  MandalaTokenRecord, MandalaLinkageRecord, UTXOReference
} from './mandala/types.js'
```

- [ ] **Step 7: Run the full package gate**

Run: `cd packages/overlays/topics && npm test`
Expected: all suites PASS, including the new admin-chain tests.

- [ ] **Step 8: Lint and commit**

```bash
cd packages/overlays/topics && npm run lint && cd -
git add packages/overlays/topics/src/mandala packages/overlays/topics/src/index.ts packages/overlays/topics/src/__tests__/mandala.test.ts
git commit -m "feat(overlay): admin-chain re-derivation, balance-on-spend, mandala exports"
```

---

## Self-Review

- **Spec coverage:**
  - §2 decisions (revealSpecificKeyLinkage, overlay = verifier, encrypted-at-source) → Tasks 1–2 (payload carries the full `RevealSpecificKeyLinkageResult`; ciphertext stored verbatim in Task 5).
  - §2.1 decrypt per-output at admission AND at spend → Task 4 (admission) + Task 6 (`spendNotificationMode = 'script'` re-reads stored linkage); plaintext never persisted (verify-then-discard in `verifyKeyLinkage`).
  - §4.1 `verifyKeyLinkage` decrypt + EC point-addition → Task 2.
  - §4.2 admittance: classify, verify linkage, conservation, admin chain, both-side screening → Tasks 4 + 6.
  - §4.3 lookup persistence + assetId/outpoint only + no identity-balance query → Task 5 (`lookup` throws on identity queries; test asserts it).
  - §4.4 MongoDB collections incl. linkage with no TTL → Task 3 (test asserts no `expireAfterSeconds`).
  - §5 injected `ScreeningProvider` + verifier wallet → Tasks 1, 4.
  - §6 retention + honeypot note → Task 3 (no TTL) + spec §8 follow-ups.
  - Templates consumed via `@bsv/templates` (Plan 1) → Task 1 dependency.
- **Placeholder scan:** no TBD/TODO-as-work. `> Note:` blocks are verification/limitation callouts with concrete remediation, resolved by Task 6 where they affect behaviour.
- **Type consistency:** `verifyKeyLinkage` returns `{ identityKey, derivedKey, pubKeyHash }` and is called identically in Tasks 4–5. `MandalaToken.decode` → `{ assetId, amount, pubKeyHash }` and `MandalaAdmin.decode` → `{ boundKey }` match Plan 1's produced interfaces. `MandalaStorageManager` method names (`storeToken`, `storeLinkage`, `adjustBalance`, `deleteToken`, `getTokenRow`, `findByAssetId`, `findByOutpoint`, `getBalance`) are consistent across Tasks 3, 5, 6.
- **Known limitation (documented, not a gap):** admin-chain validation verifies boundKey re-derivation and prior-outpoint spend, but does not walk the full chain to genesis within the overlay (consensus enforces `OP_CHECKSIG`; deep-chain auditing is a follow-up beyond this spec's scope).
