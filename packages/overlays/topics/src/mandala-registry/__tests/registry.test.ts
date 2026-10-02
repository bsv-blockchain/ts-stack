import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import {
  Hash,
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import type { AdmittanceInstructions, WalletInterface, WalletProtocol } from '@bsv/sdk'
import type { OutputAdmittedByTopic, OutputSpent } from '@bsv/overlay'
import { Bsv21Binary, encodeStrictCbor } from '@bsv/templates'
import { MANDALA_TOPIC } from '../../mandala/MandalaTopicManager.js'
import { MandalaStorageManager } from '../../mandala/MandalaStorageManager.js'
import type { MandalaStateStore } from '../../mandala/MandalaStorageManager.js'
import { deployDigest } from '../../mandala/deploySig.js'
import { encodeAdminDetails } from '../../mandala/details.js'
import type { AdminDetails } from '../../mandala/details.js'
import { isMandalaReject } from '../../mandala/reject.js'
import type { MandalaReject } from '../../mandala/reject.js'
import { encodeEnvelope } from '../../mandala/types.js'
import type { EngineOutputReader, MandalaEnvelope, SpecificLinkage } from '../../mandala/types.js'
import { RegistryStorage, registryMembership } from '../RegistryStorage.js'
import { REGISTRY_TOPIC, RegistryTopicManager } from '../RegistryTopicManager.js'
import type { RegistryTopicManagerDeps } from '../RegistryTopicManager.js'
import {
  REGISTRY_LOOKUP,
  RegistryLookupService,
  createRegistryLookupService
} from '../RegistryLookupService.js'
import docs from '../RegistryDocs.md.js'

// End to end through the registry topic manager and lookup service: real
// Bsv21Binary scripts, real key linkage and deploy signatures, and a
// MongoMemoryServer-backed store. The engine's admitted-output store is
// simulated by `record`; the real RegistryLookupService is the notified lookup.

const codec = new Bsv21Binary()
const FT: WalletProtocol = [2, 'mandala token']

const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const walletOf = (hex: string): ProtoWallet => new ProtoWallet(PrivateKey.fromHex(hex))

const overlay = walletOf('0a'.repeat(32))
const issuer = walletOf('66'.repeat(32))
const rogue = walletOf('33'.repeat(32))
const OVERLAY = keyOf('0a'.repeat(32))
const ISSUER = keyOf('66'.repeat(32))
const ROGUE = keyOf('33'.repeat(32))
const ALICE = keyOf('44'.repeat(32))
const BOB = keyOf('22'.repeat(32))
// The manager only calls `decrypt` on the verifier, which ProtoWallet implements.
const verifierWallet = overlay as unknown as WalletInterface

const DEPLOY_PAYLOAD = encodeStrictCbor({ sym: 'KYC', dec: 0, label: 'Mandala registry' })
const REGISTRY_EXISTS =
  'tm_mandala_registry: registration chain already exists; register is genesis-only'

// ---- transactions ----

interface TokenOut {
  /** null: a deploy. */
  tokenId: string | null
  amount: bigint
  /** Reveals the linkage; the output is locked to `to`'s key derived by `from`. */
  from: ProtoWallet
  to: string
  payload?: number[]
}

interface Spend {
  tx: Transaction
  vout: number
}

interface Built {
  tx: Transaction
  txid: string
  previousCoins: number[]
  env: MandalaEnvelope
}

let nonce = 0
let keyCounter = 0

// Roots every chain in a funding tx with no inputs, so BEEF needs no proofs.
function funding(): Transaction {
  const source = new Transaction()
  source.lockTime = ++nonce
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160([nonce])) })
  return source
}

async function linkedLock(
  out: TokenOut
): Promise<{ script: LockingScript; linkage: SpecificLinkage }> {
  const keyID = `out-${++keyCounter}`
  const { publicKey } = await out.from.getPublicKey({ protocolID: FT, keyID, counterparty: out.to })
  const linkage = (await out.from.revealSpecificKeyLinkage({
    counterparty: out.to,
    verifier: OVERLAY,
    protocolID: FT,
    keyID
  })) as SpecificLinkage
  const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  return { script: codec.lock(out.tokenId, out.amount, pkh, out.payload), linkage }
}

/** Token spends first (they are the previous coins), then one funding input. */
function txSpending(spends: readonly Spend[]): Transaction {
  const tx = new Transaction()
  for (const { tx: sourceTransaction, vout } of [...spends, { tx: funding(), vout: 0 }]) {
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: vout,
      unlockingScript: new UnlockingScript()
    })
  }
  return tx
}

async function build(
  spends: readonly Spend[],
  outs: readonly TokenOut[],
  admin: MandalaEnvelope['admin'] = []
): Promise<Built> {
  const tx = txSpending(spends)
  const outputs: MandalaEnvelope['outputs'] = []
  for (const [index, out] of outs.entries()) {
    const { script, linkage } = await linkedLock(out)
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    outputs.push({ index, linkage })
  }
  return {
    tx,
    txid: tx.id('hex'),
    previousCoins: spends.map((_, i) => i),
    env: { inputs: [], outputs, admin }
  }
}

async function signDeploy(wallet: ProtoWallet, txid: string): Promise<string> {
  const { signature } = await wallet.createSignature({
    data: deployDigest(txid),
    protocolID: [2, 'mandala deploy'],
    keyID: '1',
    counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

/** A signed registry deploy, locked to the issuer's own derived key. */
async function deploy(): Promise<Built> {
  const b = await build(
    [],
    [{ tokenId: null, amount: 0n, from: issuer, to: ISSUER, payload: DEPLOY_PAYLOAD }]
  )
  return { ...b, env: { ...b.env, deploySig: await signDeploy(issuer, b.txid) } }
}

const tokenOf = (d: Built): string => `${d.txid}_0`

const commitTo = (details: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(details)) })

const admitting = (identityKey: string): AdminDetails => ({ kind: 'admitIdentity', identityKey })
const revoking = (identityKey: string): AdminDetails => ({ kind: 'revokeIdentity', identityKey })

interface ActOptions {
  /** Value outputs created ahead of the authority output. */
  values?: ReadonlyArray<[string, bigint]>
  /** Owner of the new authority output. */
  to?: string
}

/** Spends `authority` and re-creates it, committing `details` (an admin action of the registry). */
async function act(
  tokenId: string,
  authority: Spend,
  details: AdminDetails,
  { values = [], to = ISSUER }: ActOptions = {}
): Promise<Built> {
  const bytes = encodeAdminDetails(details)
  return await build(
    [authority],
    [
      ...values.map(([key, amount]): TokenOut => ({ tokenId, amount, from: issuer, to: key })),
      { tokenId, amount: 0n, from: issuer, to, payload: commitTo(bytes) }
    ],
    [{ index: values.length, details: Utils.toHex(bytes) }]
  )
}

// ---- the store, the engine and the lookup, simulated ----

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let storage: MandalaStorageManager
let registry: RegistryStorage
let service: RegistryLookupService
let admitted: Map<string, { lockingScript: number[]; satoshis: number }>

const engineOutputs: EngineOutputReader = {
  findAdmittedOutput: async (txid, outputIndex, topic) =>
    topic === REGISTRY_TOPIC ? (admitted.get(`${txid}.${outputIndex}`) ?? null) : null,
  listUnspentAdmittedOutputs: async () => []
}

const depsWith = (over: Partial<RegistryTopicManagerDeps> = {}): RegistryTopicManagerDeps => ({
  verifierWallet,
  trustedIssuers: [ISSUER],
  stateStore: storage,
  engineOutputs,
  registry,
  ...over
})

const managerWith = (over: Partial<RegistryTopicManagerDeps> = {}): RegistryTopicManager =>
  new RegistryTopicManager(depsWith(over))

async function submit(
  b: Built,
  manager = managerWith(),
  context?: { dryRun?: boolean }
): Promise<AdmittanceInstructions> {
  return await manager.identifyAdmissibleOutputs(
    b.tx.toBEEF(),
    b.previousCoins,
    encodeEnvelope(b.env),
    'current-tx',
    context
  )
}

const admittedPayload = (
  b: Built,
  outputIndex: number,
  over: Partial<{ topic: string; offChainValues: number[] | undefined }> = {}
): OutputAdmittedByTopic => ({
  mode: 'whole-tx',
  atomicBEEF: b.tx.toAtomicBEEF(),
  outputIndex,
  topic: REGISTRY_TOPIC,
  offChainValues: encodeEnvelope(b.env),
  ...over
})

const spentPayload = (txid: string, outputIndex: number, topic = REGISTRY_TOPIC): OutputSpent => ({
  mode: 'none',
  txid,
  outputIndex,
  topic
})

/** What the engine does after admission: remember the outputs, forget the spent coins. */
async function record(b: Built, result: AdmittanceInstructions): Promise<void> {
  for (const i of result.outputsToAdmit) {
    admitted.set(`${b.txid}.${i}`, {
      lockingScript: b.tx.outputs[i].lockingScript.toBinary(),
      satoshis: 1
    })
  }
  for (const index of b.previousCoins) {
    const input = b.tx.inputs[index]
    const txid = input.sourceTransaction?.id('hex') ?? ''
    admitted.delete(`${txid}.${input.sourceOutputIndex}`)
    await service.outputSpent(spentPayload(txid, input.sourceOutputIndex))
  }
}

/** Notifies the lookup of every admitted output, in index order. */
async function notify(b: Built, result: AdmittanceInstructions): Promise<void> {
  for (const i of result.outputsToAdmit) await service.outputAdmittedByTopic(admittedPayload(b, i))
}

async function admit(b: Built): Promise<AdmittanceInstructions> {
  const result = await submit(b)
  await record(b, result)
  await notify(b, result)
  return result
}

/** A deployed (claimed) registry, and its first authority output as a spend. */
async function deployed(): Promise<{ tokenId: string; d: Built; head: Spend }> {
  const d = await deploy()
  await admit(d)
  return { tokenId: tokenOf(d), d, head: { tx: d.tx, vout: 0 } }
}

async function rejection(work: Promise<unknown>): Promise<MandalaReject> {
  try {
    await work
  } catch (error) {
    if (isMandalaReject(error)) return error
    throw error
  }
  throw new Error('expected a MandalaReject')
}

const journalCount = async (): Promise<number> =>
  await db.collection('mandalaOwners').countDocuments()

const journalOf = async (b: Built, outputIndex: number) =>
  await storage.getOwnerJournal(b.txid, outputIndex, REGISTRY_TOPIC)

/** The real store, except that every journal write fails with `fault`. */
const failingJournal = (fault = new Error('write concern timeout')): MandalaStateStore => ({
  getAssetState: async (...a) => await storage.getAssetState(...a),
  getTokenRow: async (...a) => await storage.getTokenRow(...a),
  getAuthorityRow: async (...a) => await storage.getAuthorityRow(...a),
  getOwnerJournal: async (...a) => await storage.getOwnerJournal(...a),
  repairOwnerRow: async (...a) => await storage.repairOwnerRow(...a),
  takeToken: async (...a) => await storage.takeToken(...a),
  takeAuthority: async (...a) => await storage.takeAuthority(...a),
  adjustBalance: async (...a) => await storage.adjustBalance(...a),
  circulatingSupply: async (...a) => await storage.circulatingSupply(...a),
  recordOwners: async () => {
    throw fault
  }
})

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = new MongoClient(mongo.getUri())
  await client.connect()
  db = client.db('mandala_registry_test')
}, 60_000)

afterAll(async () => {
  await client.close()
  await mongo.stop()
}, 60_000)

beforeEach(async () => {
  await db.dropDatabase()
  storage = new MandalaStorageManager(db)
  registry = new RegistryStorage(db)
  service = new RegistryLookupService({ registry, storage })
  admitted = new Map()
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('RegistryStorage', () => {
  const ref = (txid: string, outputIndex = 0) => ({ txid, outputIndex })
  const T1 = 'a1'.repeat(32)
  const T2 = 'b2'.repeat(32)
  const T3 = 'c3'.repeat(32)

  test('registryTokenId is null until claimed; the first claim wins and stays', async () => {
    expect(await registry.registryTokenId()).toBeNull()
    expect(await registry.claimRegistryTokenId(`${T1}_0`)).toBe(true)
    expect(await registry.claimRegistryTokenId(`${T2}_0`)).toBe(false)
    expect(await registry.claimRegistryTokenId(`${T1}_0`)).toBe(false)
    expect(await registry.registryTokenId()).toBe(`${T1}_0`)
  })

  test('concurrent claims produce exactly one winner', async () => {
    const claims = await Promise.all(
      [T1, T2, T3].map(async t => ({
        id: `${t}_0`,
        won: await registry.claimRegistryTokenId(`${t}_0`)
      }))
    )
    const winners = claims.filter(c => c.won)
    expect(winners).toHaveLength(1)
    expect(await registry.registryTokenId()).toBe(winners[0].id)
  })

  test('a claim alone does not make the registry active, and is not a listed row', async () => {
    await registry.claimRegistryTokenId(`${T1}_0`)
    expect(await registry.isActive()).toBe(false)
    expect(await registry.list()).toEqual([])
    expect(await registry.isAdmitted(ALICE)).toBe(false)
  })

  test('apply folds admit then revoke into one row per identity', async () => {
    await registry.apply(ALICE, 'admitted', ref(T1))
    expect(await registry.isActive()).toBe(true)
    expect(await registry.isAdmitted(ALICE)).toBe(true)
    expect(await registry.list()).toEqual([
      { identityKey: ALICE, status: 'admitted', txid: T1, outputIndex: 0, admitSeq: 1 }
    ])
    await registry.apply(ALICE, 'revoked', ref(T2, 3))
    expect(await registry.isAdmitted(ALICE)).toBe(false)
    expect(await registry.isActive()).toBe(true)
    expect(await registry.list()).toEqual([
      { identityKey: ALICE, status: 'revoked', txid: T2, outputIndex: 3, admitSeq: 2 }
    ])
  })

  test('apply of the row’s own outpoint is a no-op: no new admitSeq, nothing re-written', async () => {
    await registry.apply(ALICE, 'admitted', ref(T1))
    await registry.apply(ALICE, 'admitted', ref(T1))
    await registry.apply(BOB, 'admitted', ref(T2))
    expect(await registry.list()).toEqual([
      { identityKey: BOB, status: 'admitted', txid: T2, outputIndex: 0, admitSeq: 2 },
      { identityKey: ALICE, status: 'admitted', txid: T1, outputIndex: 0, admitSeq: 1 }
    ])
  })

  test('a revoked identity that was never admitted still makes the registry active', async () => {
    await registry.apply(ALICE, 'revoked', ref(T1))
    expect(await registry.isActive()).toBe(true)
    expect(await registry.isAdmitted(ALICE)).toBe(false)
  })

  test('list is newest first and carries exactly the persisted fields', async () => {
    await registry.apply(ALICE, 'admitted', ref(T1))
    await registry.apply(BOB, 'revoked', ref(T2, 1))
    const rows = await registry.list()
    expect(rows.map(r => r.identityKey)).toEqual([BOB, ALICE])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['admitSeq', 'identityKey', 'outputIndex', 'status', 'txid'].sort()
    )
  })

  test('persists to mandalaRegistry with the registryAdmitSeq counter and a unique identityKey index', async () => {
    await registry.claimRegistryTokenId(`${T1}_0`)
    await registry.apply(ALICE, 'admitted', ref(T1))
    const raw = await db.collection('mandalaRegistry').find({}).toArray()
    expect(raw).toHaveLength(2)
    expect(raw.find(r => r._id === ('registryTokenId' as unknown))).toMatchObject({
      tokenId: `${T1}_0`
    })
    const row = raw.find(r => r.identityKey === ALICE)
    expect(row).toMatchObject({ status: 'admitted', txid: T1, outputIndex: 0, admitSeq: 1 })
    expect(row?.createdAt).toBeInstanceOf(Date)
    expect(
      await db.collection('mandalaCounters').findOne({ _id: 'registryAdmitSeq' as never })
    ).toMatchObject({
      seq: 1
    })
    const indexes = await db.collection('mandalaRegistry').indexes()
    expect(indexes.find(i => i.key.identityKey === 1)).toMatchObject({ unique: true })
    expect(indexes.find(i => i.key.status === 1)).toBeDefined()
  })
})

describe('registryMembership', () => {
  test('is inactive while the registry is empty, whatever the identity', async () => {
    const membership = registryMembership(registry)
    expect(await membership.isActive()).toBe(false)
    expect(await membership.isAdmitted(ALICE)).toBe(false)
  })

  test('is active once it has a row, and admits exactly the admitted identities', async () => {
    const membership = registryMembership(registry)
    await registry.apply(ALICE, 'admitted', { txid: 'a1'.repeat(32), outputIndex: 0 })
    await registry.apply(BOB, 'revoked', { txid: 'b2'.repeat(32), outputIndex: 0 })
    expect(await membership.isActive()).toBe(true)
    expect(await membership.isAdmitted(ALICE)).toBe(true)
    expect(await membership.isAdmitted(BOB)).toBe(false)
    expect(await membership.isAdmitted(ROGUE)).toBe(false)
  })
})

describe('RegistryTopicManager — admission and the owner journal', () => {
  test('admits a signed registry deploy and journals its owner under tm_mandala_registry', async () => {
    const d = await deploy()
    expect(await submit(d)).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
    const journal = await journalOf(d, 0)
    expect(journal).toMatchObject({
      txid: d.txid,
      outputIndex: 0,
      topic: 'tm_mandala_registry',
      tokenId: tokenOf(d),
      role: 'deploy',
      amount: 0,
      identityKey: ISSUER
    })
    expect(journal?.createdAt).toBeInstanceOf(Date)
    // the Mandala topic's journal is a separate key space
    expect(await storage.getOwnerJournal(d.txid, 0, MANDALA_TOPIC)).toBeNull()
  })

  test('admits an admitIdentity then a revokeIdentity, each spending the previous authority', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    expect(await submit(a1)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(await journalOf(a1, 0)).toMatchObject({
      role: 'authority',
      amount: 0,
      identityKey: ISSUER,
      topic: 'tm_mandala_registry',
      tokenId
    })
    await admit(a1)
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    expect(await submit(a2)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
  })

  test('does not read the registry for a transaction without a deploy', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    const unreadable = {
      registryTokenId: async () => {
        throw new Error('mongo down')
      }
    }
    const manager = managerWith({ registry: unreadable as unknown as RegistryStorage })
    expect(await submit(a1, manager)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
  })

  test('refuses a second registry deploy once the first is claimed, and journals nothing for it', async () => {
    await deployed()
    const before = await journalCount()
    const second = await deploy()
    expect(await rejection(submit(second))).toMatchObject({
      code: 'ERR_SHAPE',
      reason: REGISTRY_EXISTS
    })
    expect(await journalCount()).toBe(before)
  })

  test('admits a replay of the claimed deploy itself', async () => {
    const d = await deploy()
    await admit(d)
    expect(await submit(d)).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  test('judges deploy shape and trust before the registry: an unsigned second deploy is ERR_AUTHORITY', async () => {
    await deployed()
    const second = await deploy()
    const unsigned = { ...second, env: { ...second.env, deploySig: undefined } }
    expect(await rejection(submit(unsigned))).toMatchObject({ code: 'ERR_AUTHORITY' })
  })

  test('answers ERR_UNAVAILABLE for a deploy when the registry cannot be read, keeping the cause', async () => {
    const fault = new Error('mongo down')
    const manager = managerWith({
      registry: {
        registryTokenId: async () => {
          throw fault
        }
      } as unknown as RegistryStorage
    })
    const refused = await rejection(submit(await deploy(), manager))
    expect(refused).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: 'the registry could not be read; retry'
    })
    expect(refused.cause).toBe(fault)
    expect(await journalCount()).toBe(0)
  })

  test('refuses a value output as ERR_SHAPE and journals nothing', async () => {
    const { tokenId, head } = await deployed()
    const before = await journalCount()
    const withValue = await act(tokenId, head, admitting(ALICE), { values: [[ALICE, 5n]] })
    expect(await rejection(submit(withValue))).toMatchObject({
      code: 'ERR_SHAPE',
      reason: 'output 0: tm_mandala_registry does not admit value outputs'
    })
    expect(await journalCount()).toBe(before)
  })

  test.each([
    ['issue', { kind: 'issue' } as AdminDetails],
    ['pause', { kind: 'pause' } as AdminDetails],
    ['blockIdentity', { kind: 'blockIdentity', identityKey: ALICE } as AdminDetails]
  ])('refuses the Mandala kind %s on the registry as ERR_SHAPE', async (kind, details) => {
    const { tokenId, head } = await deployed()
    expect(await rejection(submit(await act(tokenId, head, details)))).toMatchObject({
      code: 'ERR_SHAPE',
      reason: `output 0: admin details violate the schema (kind ${kind} is not allowed)`
    })
  })

  test('refuses an authority output owned by an untrusted key as ERR_UNTRUSTED, never journalled', async () => {
    const { tokenId, head } = await deployed()
    const before = await journalCount()
    const handover = await act(tokenId, head, admitting(ALICE), { to: ROGUE })
    expect(await rejection(submit(handover))).toMatchObject({
      code: 'ERR_UNTRUSTED',
      reason: `output 0: owner ${ROGUE} is not a trusted issuer`
    })
    expect(await journalCount()).toBe(before)
  })

  test('refuses a deploy owned by an untrusted key as ERR_UNTRUSTED', async () => {
    const b = await build(
      [],
      [{ tokenId: null, amount: 0n, from: rogue, to: ROGUE, payload: DEPLOY_PAYLOAD }]
    )
    const d = { ...b, env: { ...b.env, deploySig: await signDeploy(rogue, b.txid) } }
    expect(await rejection(submit(d))).toMatchObject({ code: 'ERR_UNTRUSTED' })
  })

  test('refuses spending the authority without creating one as ERR_AUTHORITY', async () => {
    const { tokenId, head } = await deployed()
    const burn = await build([head], [])
    expect(await rejection(submit(burn))).toMatchObject({
      code: 'ERR_AUTHORITY',
      reason: `token ${tokenId}: spends an authority but creates none`
    })
  })

  test('refuses an authority output with no authority input as ERR_AUTHORITY', async () => {
    const { tokenId } = await deployed()
    const forged = await build([], [{ tokenId, amount: 0n, from: issuer, to: ISSUER }])
    expect(await rejection(submit(forged))).toMatchObject({
      code: 'ERR_AUTHORITY',
      reason: `output 0: authority output without an admitted authority input of token ${tokenId}`
    })
  })

  test('has no issuer controls: an action is admitted while the registry is active and its issuer is no member', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    expect(await registryMembership(registry).isActive()).toBe(true)
    expect(await registry.isAdmitted(ISSUER)).toBe(false)
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, admitting(BOB))
    expect(await submit(a2)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
  })

  test('writes no journal on a dryRun (GASP), and does on the real admission', async () => {
    const d = await deploy()
    const manager = managerWith()
    expect(await submit(d, manager, { dryRun: true })).toEqual({
      outputsToAdmit: [0],
      coinsToRetain: []
    })
    expect(await journalCount()).toBe(0)
    await submit(d, manager, { dryRun: false })
    expect(await journalOf(d, 0)).toMatchObject({ role: 'deploy', identityKey: ISSUER })
  })

  test('answers ERR_UNAVAILABLE when the journal write fails, with the store error as its cause', async () => {
    const fault = new Error('document failed validation')
    const manager = managerWith({ stateStore: failingJournal(fault) })
    const refused = await rejection(submit(await deploy(), manager))
    expect(refused).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: 'the owner journal could not be written; retry'
    })
    expect(refused.cause).toBe(fault)
    expect(await journalCount()).toBe(0)
  })

  test('admits nothing and journals nothing for a tx without token outputs', async () => {
    const tx = txSpending([])
    tx.addOutput({ satoshis: 900, lockingScript: new P2PKH().lock(Hash.hash160([9])) })
    const plain: Built = {
      tx,
      txid: tx.id('hex'),
      previousCoins: [],
      env: { inputs: [], outputs: [], admin: [] }
    }
    expect(await submit(plain)).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
    expect(await journalCount()).toBe(0)
  })

  test('is configured like the Mandala manager: trusted issuers are validated, naming this class', () => {
    const named = (trustedIssuers: unknown) => () =>
      managerWith({ trustedIssuers: trustedIssuers as string[] })
    expect(named([])).toThrow('RegistryTopicManager: trustedIssuers must be a non-empty array')
    expect(named([ISSUER.toUpperCase()])).toThrow(
      `RegistryTopicManager: trusted issuer ${ISSUER.toUpperCase()} is not a compressed lowercase public key`
    )
    expect(named([ISSUER, ISSUER])).toThrow(
      `RegistryTopicManager: trusted issuer ${ISSUER} is listed more than once`
    )
  })

  test('reports its name and documentation', async () => {
    const manager = managerWith()
    expect(REGISTRY_TOPIC).toBe('tm_mandala_registry')
    expect(await manager.getMetaData()).toMatchObject({ name: 'tm_mandala_registry' })
    expect((await manager.getMetaData()).shortDescription).toEqual(expect.any(String))
    expect(await manager.getDocumentation()).toBe(docs)
  })
})

describe('RegistryTopicManager — owner-index repair on the registry topic', () => {
  const repairLog = (outpoint: string): string =>
    `[RegistryTopicManager] owner index repaired for ${outpoint} from the owner journal (row inserted)`

  test('repairs a missing authority row from the registry journal, logs it, and admits', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    await storage.takeAuthority(a1.txid, 0)
    const repair = jest.spyOn(storage, 'repairOwnerRow')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    expect(await submit(a2)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair.mock.calls[0][0]).toMatchObject({ topic: 'tm_mandala_registry' })
    expect(warn).toHaveBeenCalledWith(repairLog(`${a1.txid}.0`))
    expect(await storage.getAuthorityRow(a1.txid, 0)).toMatchObject({
      topic: 'tm_mandala_registry',
      tokenId,
      identityKey: ISSUER
    })
  })

  test('passes every repair to onOwnerRepair instead when one is given', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    await storage.takeAuthority(a1.txid, 0)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const onOwnerRepair = jest.fn<(outpoint: string, inserted: boolean) => void>()
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    await submit(a2, managerWith({ onOwnerRepair }))
    expect(onOwnerRepair).toHaveBeenCalledWith(`${a1.txid}.0`, true)
    expect(warn).not.toHaveBeenCalled()
  })

  test('answers ERR_UNAVAILABLE when the row and its journal entry are both gone', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    await storage.takeAuthority(a1.txid, 0)
    await db.collection('mandalaOwners').deleteMany({ txid: a1.txid })
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    expect(await rejection(submit(a2))).toMatchObject({
      code: 'ERR_UNAVAILABLE',
      reason: `owner index unavailable for ${a1.txid}.0`
    })
  })

  test('does not repair from a journal row of the Mandala topic', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    await storage.takeAuthority(a1.txid, 0)
    await db
      .collection('mandalaOwners')
      .updateMany({ txid: a1.txid }, { $set: { topic: MANDALA_TOPIC } })
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    expect(await rejection(submit(a2))).toMatchObject({ code: 'ERR_UNAVAILABLE' })
  })
})

describe('RegistryLookupService', () => {
  test('claims the registry token on the deploy and stores its authority row', async () => {
    const d = await deploy()
    const result = await submit(d)
    await service.outputAdmittedByTopic(admittedPayload(d, 0))
    expect(result.outputsToAdmit).toEqual([0])
    expect(await registry.registryTokenId()).toBe(tokenOf(d))
    expect(await registry.isActive()).toBe(false)
    expect(await storage.getAuthorityRow(d.txid, 0)).toMatchObject({
      txid: d.txid,
      outputIndex: 0,
      topic: 'tm_mandala_registry',
      tokenId: tokenOf(d),
      identityKey: ISSUER
    })
  })

  test('folds admit then revoke from the committed authority outputs', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    expect(await registry.isActive()).toBe(true)
    expect(await registry.isAdmitted(ALICE)).toBe(true)
    expect(await registry.list()).toEqual([
      { identityKey: ALICE, status: 'admitted', txid: a1.txid, outputIndex: 0, admitSeq: 1 }
    ])
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, revoking(ALICE))
    await admit(a2)
    expect(await registry.isAdmitted(ALICE)).toBe(false)
    expect(await registry.list()).toEqual([
      { identityKey: ALICE, status: 'revoked', txid: a2.txid, outputIndex: 0, admitSeq: 2 }
    ])
  })

  test('keeps only the head authority: a spend takes the previous row', async () => {
    const { tokenId, d, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    expect(await storage.getAuthorityRow(d.txid, 0)).toBeNull()
    expect(
      (await storage.listAuthorities('tm_mandala_registry', tokenId)).map(r => r.txid)
    ).toEqual([a1.txid])
  })

  test('an authority output with no commitment moves no membership', async () => {
    const { tokenId, head } = await deployed()
    const plain = await build([head], [{ tokenId, amount: 0n, from: issuer, to: ISSUER }])
    await admit(plain)
    expect(await registry.isActive()).toBe(false)
    expect(await storage.getAuthorityRow(plain.txid, 0)).not.toBeNull()
  })

  test('a replayed notification changes nothing: same row, same admitSeq', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    const result = await admit(a1)
    await notify(a1, result)
    const a2 = await act(tokenId, { tx: a1.tx, vout: 0 }, admitting(BOB))
    await admit(a2)
    expect((await registry.list()).map(r => [r.identityKey, r.admitSeq])).toEqual([
      [BOB, 2],
      [ALICE, 1]
    ])
  })

  test('still folds the action when an inline repair inserted the authority row first', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    const result = await submit(a1)
    await record(a1, result)
    await storage.storeAuthorityIfAbsent({
      txid: a1.txid,
      outputIndex: 0,
      topic: REGISTRY_TOPIC,
      tokenId,
      identityKey: ISSUER,
      createdAt: new Date()
    })
    await notify(a1, result)
    expect(await registry.isAdmitted(ALICE)).toBe(true)
  })

  test('folds the action without an authority row when the journal is gone', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    const result = await submit(a1)
    await db.collection('mandalaOwners').deleteMany({ txid: a1.txid })
    await notify(a1, result)
    expect(await registry.isAdmitted(ALICE)).toBe(true)
    expect(await storage.getAuthorityRow(a1.txid, 0)).toBeNull()
  })

  test('leaves the authority row to the reconciler when the journal disagrees with the script', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    const result = await submit(a1)
    await db.collection('mandalaOwners').updateMany({ txid: a1.txid }, { $set: { amount: 7 } })
    await notify(a1, result)
    expect(await storage.getAuthorityRow(a1.txid, 0)).toBeNull()
    expect(await registry.isAdmitted(ALICE)).toBe(true)
  })

  test('a rival registry admitted before the claim moves no membership', async () => {
    const first = await deploy()
    const rival = await deploy()
    // both reach the topic manager before either reaches the lookup
    const firstResult = await submit(first)
    const rivalResult = await submit(rival)
    await record(first, firstResult)
    await record(rival, rivalResult)
    await notify(first, firstResult)
    await notify(rival, rivalResult)
    expect(await registry.registryTokenId()).toBe(tokenOf(first))
    const onRival = await act(tokenOf(rival), { tx: rival.tx, vout: 0 }, admitting(BOB))
    expect(await submit(onRival)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    await admit(onRival)
    expect(await registry.isActive()).toBe(false)
    expect(await registry.isAdmitted(BOB)).toBe(false)
    const onFirst = await act(tokenOf(first), { tx: first.tx, vout: 0 }, admitting(ALICE))
    await admit(onFirst)
    expect((await registry.list()).map(r => r.identityKey)).toEqual([ALICE])
  })

  test('claims the registry from its first action when the deploy’s claim was lost', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = await deploy()
    await record(d, await submit(d))
    expect(await registry.registryTokenId()).toBeNull()
    const a1 = await act(tokenOf(d), { tx: d.tx, vout: 0 }, admitting(ALICE))
    await admit(a1)
    expect(await registry.registryTokenId()).toBe(tokenOf(d))
    expect(await registry.isAdmitted(ALICE)).toBe(true)
  })

  test('ignores a value output, even one with a journal row', async () => {
    const { tokenId, head } = await deployed()
    const withValue = await act(tokenId, head, admitting(ALICE), { values: [[ALICE, 5n]] })
    await storage.recordOwners([
      {
        txid: withValue.txid,
        outputIndex: 0,
        topic: REGISTRY_TOPIC,
        tokenId,
        role: 'value',
        amount: 5,
        identityKey: ALICE,
        createdAt: new Date()
      }
    ])
    await service.outputAdmittedByTopic(admittedPayload(withValue, 0))
    expect(await storage.getTokenRow(withValue.txid, 0)).toBeNull()
    expect(await storage.getAuthorityRow(withValue.txid, 0)).toBeNull()
    expect(await registry.isActive()).toBe(false)
  })

  test('ignores another topic, locking-script mode and an output that is not a token', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await submit(a1)
    await service.outputAdmittedByTopic(admittedPayload(a1, 0, { topic: MANDALA_TOPIC }))
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: a1.txid,
      outputIndex: 0,
      topic: REGISTRY_TOPIC,
      satoshis: 1,
      lockingScript: a1.tx.outputs[0].lockingScript
    })
    await service.outputAdmittedByTopic(admittedPayload(a1, 5))
    expect(await registry.isActive()).toBe(false)
    expect(await storage.getAuthorityRow(a1.txid, 0)).toBeNull()
  })

  test('a spend of the registry topic takes the authority row; another topic does not', async () => {
    const { d } = await deployed()
    await service.outputSpent(spentPayload(d.txid, 0, MANDALA_TOPIC))
    expect(await storage.getAuthorityRow(d.txid, 0)).not.toBeNull()
    await service.outputSpent(spentPayload(d.txid, 0))
    expect(await storage.getAuthorityRow(d.txid, 0)).toBeNull()
    await service.outputSpent(spentPayload(d.txid, 0))
    expect(await storage.getAuthorityRow(d.txid, 0)).toBeNull()
  })

  test('an eviction takes the authority row and leaves membership alone', async () => {
    const { tokenId, head } = await deployed()
    const a1 = await act(tokenId, head, admitting(ALICE))
    await admit(a1)
    await service.outputEvicted(a1.txid, 0)
    expect(await storage.getAuthorityRow(a1.txid, 0)).toBeNull()
    expect(await registry.isAdmitted(ALICE)).toBe(true)
  })

  test('lookup answers nothing: the registry is served by the overlay routes', async () => {
    expect(await service.lookup({ service: REGISTRY_LOOKUP, query: {} })).toEqual([])
  })

  test('declares whole-tx admission and script spend notifications', () => {
    expect(service.admissionMode).toBe('whole-tx')
    expect(service.spendNotificationMode).toBe('script')
  })

  test('reports its name and documentation', async () => {
    expect(REGISTRY_LOOKUP).toBe('ls_mandala_registry')
    expect(await service.getMetaData()).toMatchObject({ name: 'ls_mandala_registry' })
    expect((await service.getMetaData()).shortDescription).toEqual(expect.any(String))
    expect(await service.getDocumentation()).toBe(docs)
  })

  test('the factory builds a service over the given stores', async () => {
    const created = createRegistryLookupService(registry, storage)(db)
    expect(created).toBeInstanceOf(RegistryLookupService)
    const d = await deploy()
    await created.outputAdmittedByTopic(admittedPayload(d, 0))
    expect(await registry.registryTokenId()).toBe(tokenOf(d))
  })
})
