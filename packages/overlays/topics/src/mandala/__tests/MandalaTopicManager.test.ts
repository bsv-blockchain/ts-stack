import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import type { AdmittanceInstructions, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { Bsv21Binary, encodeStrictCbor, tokenIdFromString } from '@bsv/templates'
import { MANDALA_TOPIC, MandalaTopicManager } from '../MandalaTopicManager.js'
import type { MandalaTopicManagerDeps } from '../MandalaTopicManager.js'
import docs from '../MandalaTopicDocs.md.js'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import type { MandalaStateStore } from '../MandalaStorageManager.js'
import { deployDigest } from '../deploySig.js'
import { encodeAdminDetails } from '../details.js'
import { isMandalaReject } from '../reject.js'
import type { MandalaReject } from '../reject.js'
import { InMemoryScreeningProvider, encodeEnvelope } from '../types.js'
import type {
  EngineOutputReader,
  MandalaEnvelope,
  MandalaOwnerRecord,
  MembershipProvider,
  SpecificLinkage
} from '../types.js'

// End to end through the manager: real Bsv21Binary scripts, real key linkage
// and deploy signatures, and a MongoMemoryServer-backed MandalaStorageManager.
// The engine's admitted-output store and the lookup service's index writes
// (Task 11) are simulated by `settle`, so a spend finds its owner row the way
// it would in production, and a test can take that row away.

const codec = new Bsv21Binary()
const FT: WalletProtocol = [2, 'mandala token']

const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const walletOf = (hex: string): ProtoWallet => new ProtoWallet(PrivateKey.fromHex(hex))

const overlay = walletOf('0a'.repeat(32))
const issuer = walletOf('66'.repeat(32))
const holder = walletOf('44'.repeat(32))
const receiver = walletOf('22'.repeat(32))
const rogue = walletOf('33'.repeat(32))
const OVERLAY = keyOf('0a'.repeat(32))
const ISSUER = keyOf('66'.repeat(32))
const HOLDER = keyOf('44'.repeat(32))
const RECEIVER = keyOf('22'.repeat(32))
const ROGUE = keyOf('33'.repeat(32))
// The manager only calls `decrypt` on the verifier, which ProtoWallet implements.
const verifierWallet = overlay as unknown as WalletInterface

const DEPLOY_PAYLOAD = encodeStrictCbor({ sym: 'USD', dec: 2, label: 'US Dollar' })

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

const built = (tx: Transaction, previousCoins: number[], env: MandalaEnvelope): Built => ({
  tx,
  txid: tx.id('hex'),
  previousCoins,
  env
})

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
  return built(
    tx,
    spends.map((_, i) => i),
    { inputs: [], outputs, admin }
  )
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

/** A signed deploy, locked to the deployer's own derived key (spec §5.1a). */
async function deploy(by = issuer, byKey = ISSUER, payload = DEPLOY_PAYLOAD): Promise<Built> {
  const b = await build([], [{ tokenId: null, amount: 0n, from: by, to: byKey, payload }])
  return { ...b, env: { ...b.env, deploySig: await signDeploy(by, b.txid) } }
}

const tokenOf = (d: Built): string => `${d.txid}_0`

const commitTo = (details: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(details)) })

/** Spends `authority`: output 0 is value to `to`, output 1 the authority committing `details`. */
async function issue(
  tokenId: string,
  authority: Spend,
  amount: bigint,
  details: number[] = encodeAdminDetails({ kind: 'issue' }),
  to = HOLDER
): Promise<Built> {
  return await build(
    [authority],
    [
      { tokenId, amount, from: issuer, to },
      { tokenId, amount: 0n, from: issuer, to: ISSUER, payload: commitTo(details) }
    ],
    [{ index: 1, details: Utils.toHex(details) }]
  )
}

async function transfer(
  tokenId: string,
  coin: Spend,
  from: ProtoWallet,
  to: ReadonlyArray<[string, bigint]>
): Promise<Built> {
  return await build(
    [coin],
    to.map(([key, amount]) => ({ tokenId, amount, from, to: key }))
  )
}

// ---- the engine and the lookup service, simulated ----

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let storage: MandalaStorageManager
let admitted: Map<string, { lockingScript: number[]; satoshis: number }>

const engineOutputs: EngineOutputReader = {
  findAdmittedOutput: async (txid, outputIndex, topic) =>
    topic === MANDALA_TOPIC ? (admitted.get(`${txid}.${outputIndex}`) ?? null) : null,
  listUnspentAdmittedOutputs: async () => []
}

const depsWith = (over: Partial<MandalaTopicManagerDeps> = {}): MandalaTopicManagerDeps => ({
  verifierWallet,
  trustedIssuers: [ISSUER],
  stateStore: storage,
  engineOutputs,
  screeningProvider: new InMemoryScreeningProvider(),
  ...over
})

const managerWith = (over: Partial<MandalaTopicManagerDeps> = {}): MandalaTopicManager =>
  new MandalaTopicManager(depsWith(over))

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

/** The lookup's projection of one journalled owner into the index, credit on insert. */
async function indexOwner(owner: MandalaOwnerRecord): Promise<void> {
  const { txid, outputIndex, tokenId, amount, identityKey, createdAt } = owner
  if (owner.role !== 'value') {
    const row = { txid, outputIndex, topic: MANDALA_TOPIC, tokenId, identityKey, createdAt }
    await storage.storeAuthorityIfAbsent(row)
    return
  }
  const row = { txid, outputIndex, tokenId, amount, identityKey, createdAt }
  if (await storage.storeTokenIfAbsent(row)) await storage.adjustBalance(identityKey, amount)
}

/** What the engine and the lookup do after admission: record outputs, index owners, spend coins. */
async function settle(b: Built, result: AdmittanceInstructions): Promise<void> {
  for (const i of result.outputsToAdmit) {
    admitted.set(`${b.txid}.${i}`, {
      lockingScript: b.tx.outputs[i].lockingScript.toBinary(),
      satoshis: 1
    })
    const owner = await storage.getOwnerJournal(b.txid, i, MANDALA_TOPIC)
    if (owner !== null) await indexOwner(owner)
  }
  for (const index of b.previousCoins) {
    const input = b.tx.inputs[index]
    const txid = input.sourceTransaction?.id('hex') ?? ''
    admitted.delete(`${txid}.${input.sourceOutputIndex}`)
    const spent = await storage.takeToken(txid, input.sourceOutputIndex)
    if (spent === null) await storage.takeAuthority(txid, input.sourceOutputIndex)
    else await storage.adjustBalance(spent.identityKey, -spent.amount)
  }
}

async function admit(b: Built): Promise<AdmittanceInstructions> {
  const result = await submit(b)
  await settle(b, result)
  return result
}

/** A deployed token whose 100-unit issue to the holder is admitted. */
async function issued(): Promise<{ tokenId: string; issueTx: Built }> {
  const d = await deploy()
  await admit(d)
  const tokenId = tokenOf(d)
  const issueTx = await issue(tokenId, { tx: d.tx, vout: 0 }, 100n)
  await admit(issueTx)
  return { tokenId, issueTx }
}

/** The holder's 100 split: 60 to the receiver (output 0), 40 back to the holder (output 1). */
async function transferred(): Promise<{ tokenId: string; transferTx: Built }> {
  const { tokenId, issueTx } = await issued()
  const transferTx = await transfer(tokenId, { tx: issueTx.tx, vout: 0 }, holder, [
    [RECEIVER, 60n],
    [HOLDER, 40n]
  ])
  await admit(transferTx)
  return { tokenId, transferTx }
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

const repairLog = (outpoint: string, what: 'row inserted' | 'row corrected'): string =>
  `[MandalaTopicManager] owner index repaired for ${outpoint} from the owner journal (${what})`

const journalCount = async (): Promise<number> =>
  await db.collection('mandalaOwners').countDocuments()

const journalOf = async (b: Built, outputIndex: number) =>
  await storage.getOwnerJournal(b.txid, outputIndex, MANDALA_TOPIC)

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = new MongoClient(mongo.getUri())
  await client.connect()
  db = client.db('mandala_topic_manager_test')
}, 60_000)

afterAll(async () => {
  await client.close()
  await mongo.stop()
}, 60_000)

beforeEach(async () => {
  await db.dropDatabase()
  storage = new MandalaStorageManager(db)
  admitted = new Map()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('MandalaTopicManager — admission and the owner journal', () => {
  test('admits a signed deploy and journals its owner', async () => {
    const d = await deploy()
    expect(await submit(d)).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
    const journal = await journalOf(d, 0)
    expect(journal).toMatchObject({
      txid: d.txid,
      outputIndex: 0,
      topic: 'tm_mandala',
      tokenId: tokenOf(d),
      role: 'deploy',
      amount: 0,
      identityKey: ISSUER
    })
    expect(journal?.createdAt).toBeInstanceOf(Date)
  })

  test('admits an issue: authority in, value and committed authority out', async () => {
    const d = await deploy()
    await admit(d)
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n)
    expect(await submit(issueTx)).toEqual({ outputsToAdmit: [0, 1], coinsToRetain: [0] })
    expect(await journalOf(issueTx, 0)).toMatchObject({
      role: 'value',
      amount: 100,
      identityKey: HOLDER,
      tokenId: tokenOf(d)
    })
    expect(await journalOf(issueTx, 1)).toMatchObject({
      role: 'authority',
      amount: 0,
      identityKey: ISSUER,
      tokenId: tokenOf(d)
    })
  })

  test('admits a holder transfer from its stored owner row', async () => {
    const { tokenId, issueTx } = await issued()
    const repair = jest.spyOn(storage, 'repairOwnerRow')
    const t = await transfer(tokenId, { tx: issueTx.tx, vout: 0 }, holder, [
      [RECEIVER, 60n],
      [HOLDER, 40n]
    ])
    expect(await submit(t)).toEqual({ outputsToAdmit: [0, 1], coinsToRetain: [0] })
    expect(repair).not.toHaveBeenCalled()
    expect(await journalOf(t, 0)).toMatchObject({
      role: 'value',
      amount: 60,
      identityKey: RECEIVER
    })
    expect(await journalOf(t, 1)).toMatchObject({ role: 'value', amount: 40, identityKey: HOLDER })
  })

  test('admits nothing and journals nothing for a tx without token outputs', async () => {
    const tx = txSpending([])
    tx.addOutput({ satoshis: 900, lockingScript: new P2PKH().lock(Hash.hash160([9])) })
    const plain = built(tx, [], { inputs: [], outputs: [], admin: [] })
    const none = { outputsToAdmit: [], coinsToRetain: [] }
    expect(await submit(plain)).toEqual(none)
    expect(await journalCount()).toBe(0)
    // nothing to journal, so a journal outage cannot refuse it
    expect(await submit(plain, managerWith({ stateStore: failingJournal() }))).toEqual(none)
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
      reason: 'the owner journal could not be written; retry',
      message: 'the owner journal could not be written; retry'
    })
    // the engine logs only what is thrown, so the store's own error rides along
    expect(refused.cause).toBe(fault)
    expect(await journalCount()).toBe(0)
  })
})

describe('MandalaTopicManager — Review Focus pins', () => {
  // RF1: a token-shaped output encoded non-canonically is refused, never
  // skipped while its valid siblings are admitted.
  test.each([
    [
      'amount 5 pushed as 01 05',
      (id: number[]) => [
        { op: 32, data: id },
        { op: 1, data: [5] }
      ],
      'amounts 0..16 must use OP_0/OP_1..OP_16'
    ],
    [
      'amount 0 pushed as 01 00',
      (id: number[]) => [
        { op: 32, data: id },
        { op: 1, data: [0] }
      ],
      'amount is not minimally encoded'
    ],
    [
      'the id pushed with OP_PUSHDATA1',
      (id: number[]) => [{ op: OP.OP_PUSHDATA1, data: id }, { op: OP.OP_5 }],
      'token id must be a direct 32-byte push'
    ]
  ])('RF1: refuses a token output with %s as ERR_SHAPE', async (_label, prefix, detail) => {
    const { tokenId, issueTx } = await issued()
    const t = await transfer(tokenId, { tx: issueTx.tx, vout: 0 }, holder, [
      [RECEIVER, 95n],
      [HOLDER, 5n]
    ])
    const bad = new LockingScript([
      ...prefix(tokenIdFromString(tokenId)),
      { op: OP.OP_2DROP },
      ...new P2PKH().lock(Hash.hash160([5])).chunks
    ])
    t.tx.addOutput({ lockingScript: bad, satoshis: 1 })
    expect(await rejection(submit(built(t.tx, t.previousCoins, t.env)))).toMatchObject({
      code: 'ERR_SHAPE',
      reason: `output 2: token-shaped output is not a valid BRC-162 token output (${detail})`
    })
  })

  // RF2: CBOR another decoder accepts carries no Mandala attributes.
  test('RF2: refuses a deploy whose payload carries a float as ERR_SHAPE', async () => {
    // {dec: 1.0 (float16), sym: "USD"}, keys in strict order
    const payload = [
      0xa2,
      0x63,
      ...Utils.toArray('dec', 'utf8'),
      0xf9,
      0x3c,
      0x00,
      0x63,
      ...Utils.toArray('sym', 'utf8'),
      0x63,
      ...Utils.toArray('USD', 'utf8')
    ]
    const d = await deploy(issuer, ISSUER, payload)
    expect(await rejection(submit(d))).toMatchObject({
      code: 'ERR_SHAPE',
      reason:
        'output 0: deploy payload is not a valid Mandala deploy map (simple value or float not allowed)'
    })
  })

  test('RF2: refuses a committed authority whose details carry a tag as ERR_SHAPE', async () => {
    const d = await deploy()
    await admit(d)
    // {kind: tag 42("issue")}: hashes to the commitment, but is not strict CBOR
    const tagged = [
      0xa1,
      0x64,
      ...Utils.toArray('kind', 'utf8'),
      0xd8,
      0x2a,
      0x65,
      ...Utils.toArray('issue', 'utf8')
    ]
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n, tagged)
    expect(await rejection(submit(issueTx))).toMatchObject({
      code: 'ERR_SHAPE',
      reason: 'output 1: admin details violate the schema (major type 6 not allowed)'
    })
  })

  // RF3: the lookup's write for an admitted output was lost (the row and its
  // balance credit go together). The spend repairs it from the journal and the
  // balance is credited once, however often the spend is retried.
  test('RF3: repairs a missing owner row inline and credits the balance once', async () => {
    const { tokenId, transferTx } = await transferred()
    expect(await storage.getBalance(RECEIVER)).toBe(60)
    const lost = await storage.takeToken(transferTx.txid, 0)
    await storage.adjustBalance(RECEIVER, -(lost?.amount ?? 0))
    expect(await storage.getBalance(RECEIVER)).toBe(0)

    const repair = jest.spyOn(storage, 'repairOwnerRow')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const spend = await transfer(tokenId, { tx: transferTx.tx, vout: 0 }, receiver, [[HOLDER, 60n]])
    expect(await submit(spend)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(await storage.getTokenRow(transferTx.txid, 0)).toMatchObject({
      tokenId,
      amount: 60,
      identityKey: RECEIVER
    })
    expect(await storage.getBalance(RECEIVER)).toBe(60)
    // §4.2a rule 3: the repair is logged with its outpoint (default sink)
    expect(warn.mock.calls).toEqual([[repairLog(`${transferTx.txid}.0`, 'row inserted')]])

    expect(await submit(spend)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect(repair).toHaveBeenCalledTimes(1)
    expect(await storage.getBalance(RECEIVER)).toBe(60)
    // the retry reads the repaired row, so there is no second repair to log
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('RF3: repairs a row that disagrees with its script, logs it as corrected, credits nothing', async () => {
    const { tokenId, transferTx } = await transferred()
    await db
      .collection('mandalaTokens')
      .updateOne({ txid: transferTx.txid, outputIndex: 0 }, { $set: { amount: 59 } })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const spend = await transfer(tokenId, { tx: transferTx.tx, vout: 0 }, receiver, [[HOLDER, 60n]])
    expect(await submit(spend)).toEqual({ outputsToAdmit: [0], coinsToRetain: [0] })
    expect((await storage.getTokenRow(transferTx.txid, 0))?.amount).toBe(60)
    expect(await storage.getBalance(RECEIVER)).toBe(60)
    expect(warn.mock.calls).toEqual([[repairLog(`${transferTx.txid}.0`, 'row corrected')]])
  })

  test('RF3: sends the repair log to onOwnerRepair when one is given', async () => {
    const { tokenId, transferTx } = await transferred()
    await storage.takeToken(transferTx.txid, 0)
    const onOwnerRepair = jest.fn((_outpoint: string, _inserted: boolean) => {})
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const spend = await transfer(tokenId, { tx: transferTx.tx, vout: 0 }, receiver, [[HOLDER, 60n]])
    expect(await submit(spend, managerWith({ onOwnerRepair }))).toEqual({
      outputsToAdmit: [0],
      coinsToRetain: [0]
    })
    expect(onOwnerRepair.mock.calls).toEqual([[`${transferTx.txid}.0`, true]])
    expect(warn).not.toHaveBeenCalled()
  })

  test('RF3: answers ERR_UNAVAILABLE when the row and its journal entry are both gone, on every retry', async () => {
    const { tokenId, transferTx } = await transferred()
    await storage.takeToken(transferTx.txid, 0)
    await db.collection('mandalaOwners').deleteOne({ txid: transferTx.txid, outputIndex: 0 })
    const spend = await transfer(tokenId, { tx: transferTx.tx, vout: 0 }, receiver, [[HOLDER, 60n]])
    const expected = {
      code: 'ERR_UNAVAILABLE',
      reason: `owner index unavailable for ${transferTx.txid}.0`
    }
    expect(await rejection(submit(spend))).toMatchObject(expected)
    expect(await rejection(submit(spend))).toMatchObject(expected)
    expect(await journalOf(spend, 0)).toBeNull()
  })

  // RF5: a deploy rebuilt from an issuer's published deploy (same pkh and
  // linkage, new txid) cannot reuse the signature over the old txid.
  test('RF5: refuses a replayed deploy as ERR_AUTHORITY', async () => {
    const original = await deploy()
    await admit(original)
    const tx = txSpending([])
    tx.addOutput({ lockingScript: original.tx.outputs[0].lockingScript, satoshis: 1 })
    const replay = built(tx, [], original.env)
    expect(replay.txid).not.toBe(original.txid)
    const expected = {
      code: 'ERR_AUTHORITY',
      reason: 'output 0: deploy requires a valid deploySig over this txid'
    }
    expect(await rejection(submit(replay))).toMatchObject(expected)
    const { deploySig: _dropped, ...unsigned } = original.env
    expect(await rejection(submit({ ...replay, env: unsigned }))).toMatchObject(expected)
    expect(await journalOf(replay, 0)).toBeNull()
  })

  test.each([
    [
      'an untrusted owner',
      async () => await deploy(rogue, ROGUE),
      `output 0: owner ${ROGUE} is not a trusted issuer`
    ],
    [
      'an untrusted linkage prover',
      async () => {
        const b = await build(
          [],
          [{ tokenId: null, amount: 0n, from: rogue, to: ISSUER, payload: DEPLOY_PAYLOAD }]
        )
        return { ...b, env: { ...b.env, deploySig: await signDeploy(issuer, b.txid) } }
      },
      `output 0: linkage prover ${ROGUE} is not a trusted issuer`
    ]
  ])('RF5: refuses %s as ERR_UNTRUSTED and journals nothing', async (_label, make, reason) => {
    expect(await rejection(submit(await make()))).toMatchObject({ code: 'ERR_UNTRUSTED', reason })
    expect(await journalCount()).toBe(0)
  })
})

describe('MandalaTopicManager — every layer reaches the caller as a MandalaReject', () => {
  test('refuses a malformed envelope (ERR_SHAPE)', async () => {
    const d = await deploy()
    expect(
      await rejection(managerWith().identifyAdmissibleOutputs(d.tx.toBEEF(), [], [0xff]))
    ).toMatchObject({ code: 'ERR_SHAPE', reason: 'Mandala payload must be UTF-8 JSON' })
  })

  test('refuses a token output without linkage (ERR_LINKAGE)', async () => {
    const d = await deploy()
    expect(await rejection(submit({ ...d, env: { ...d.env, outputs: [] } }))).toMatchObject({
      code: 'ERR_LINKAGE',
      reason: 'output 0: token output with no verified linkage'
    })
  })

  test('refuses a sanctioned recipient (ERR_SANCTIONED)', async () => {
    const d = await deploy()
    await admit(d)
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n)
    const screening = new InMemoryScreeningProvider([HOLDER])
    expect(
      await rejection(submit(issueTx, managerWith({ screeningProvider: screening })))
    ).toMatchObject({ code: 'ERR_SANCTIONED', reason: `identity ${HOLDER} is sanctioned` })
  })

  test('exempts trusted issuers and membershipExempt keys from membership', async () => {
    const nobody: MembershipProvider = {
      isActive: async () => true,
      isAdmitted: async () => false
    }
    const d = await deploy()
    const deployed = await submit(d, managerWith({ membership: nobody }))
    expect(deployed).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
    await settle(d, deployed)
    const issueTx = await issue(tokenOf(d), { tx: d.tx, vout: 0 }, 100n)
    expect(await rejection(submit(issueTx, managerWith({ membership: nobody })))).toMatchObject({
      code: 'ERR_MEMBERSHIP',
      reason: `identity ${HOLDER} is not an admitted registry member`
    })
    const exempt = managerWith({ membership: nobody, membershipExempt: [OVERLAY, HOLDER] })
    expect(await submit(issueTx, exempt)).toEqual({ outputsToAdmit: [0, 1], coinsToRetain: [0] })
  })

  test('lets a non-Mandala error (an unreadable BEEF) propagate unchanged', async () => {
    const garbage = [1, 2, 3]
    const sdkError = (() => {
      try {
        Transaction.fromBEEF(garbage)
      } catch (e) {
        return e as Error
      }
      throw new Error('expected the SDK to refuse the BEEF')
    })()
    const error = await managerWith()
      .identifyAdmissibleOutputs(garbage, [])
      .then(
        () => undefined,
        (e: unknown) => e
      )
    expect(isMandalaReject(error)).toBe(false)
    expect(error).toBeInstanceOf(sdkError.constructor)
    expect((error as Error).message).toBe(sdkError.message)
  })
})

describe('MandalaTopicManager — construction and metadata', () => {
  const uncompressed = PublicKey.fromString(ISSUER).encode(false, 'hex') as string
  const aboveP = `02${'ff'.repeat(32)}`
  const offCurve = `02${'00'.repeat(32)}`
  const notCanonical = (key: unknown): string =>
    `MandalaTopicManager: trusted issuer ${String(key)} is not a compressed lowercase public key`
  const NOT_A_LIST = 'MandalaTopicManager: trustedIssuers must be a non-empty array'

  test.each([
    ['an empty list', [], NOT_A_LIST],
    ['not an array', undefined as unknown as string[], NOT_A_LIST],
    ['a non-hex entry', ['issuer'], notCanonical('issuer')],
    ['a non-string entry', [42 as unknown as string], notCanonical(42)],
    ['an uncompressed key', [uncompressed], notCanonical(uncompressed)],
    ['an uppercase key', [ISSUER.toUpperCase()], notCanonical(ISSUER.toUpperCase())],
    ['an x coordinate above the field prime', [aboveP], notCanonical(aboveP)],
    ['an x coordinate with no point on the curve', [offCurve], notCanonical(offCurve)],
    [
      'a duplicate',
      [ISSUER, HOLDER, ISSUER],
      `MandalaTopicManager: trusted issuer ${ISSUER} is listed more than once`
    ]
  ])('refuses %s as trustedIssuers', (_label, trustedIssuers, message) => {
    expect(() => managerWith({ trustedIssuers })).toThrow(new Error(message))
  })

  // A bad exempt key is a configuration fault: refused once at construction, never an untyped
  // error on every token transaction.
  const notExempt = (key: unknown): string =>
    `MandalaTopicManager: membership-exempt key ${String(key)} is not a compressed lowercase public key`
  test.each([
    [
      'not an array',
      'overlay' as unknown as string[],
      'MandalaTopicManager: membershipExempt must be an array'
    ],
    ['a non-hex entry', ['overlay'], notExempt('overlay')],
    ['a non-string entry', [7 as unknown as string], notExempt(7)],
    ['an uncompressed key', [uncompressed], notExempt(uncompressed)],
    ['an uppercase key', [HOLDER.toUpperCase()], notExempt(HOLDER.toUpperCase())],
    ['an x coordinate with no point on the curve', [offCurve], notExempt(offCurve)]
  ])('refuses %s as membershipExempt', (_label, membershipExempt, message) => {
    expect(() => managerWith({ membershipExempt })).toThrow(new Error(message))
  })

  test('accepts no, an empty, or a canonical membershipExempt list, overlapping the issuers', () => {
    expect(() => managerWith({ membershipExempt: undefined })).not.toThrow()
    expect(() => managerWith({ membershipExempt: [] })).not.toThrow()
    expect(() => managerWith({ membershipExempt: [HOLDER, ISSUER, HOLDER] })).not.toThrow()
  })

  test('describes itself', async () => {
    const manager = managerWith()
    expect(MANDALA_TOPIC).toBe('tm_mandala')
    expect(await manager.getMetaData()).toEqual({
      name: 'tm_mandala',
      shortDescription:
        'Mandala regulated fungible tokens on BRC-162 (BSV-21 binary, authority supply) with identity linkage, owner-index repair and issuer controls.'
    })
    expect(await manager.getDocumentation()).toBe(docs)
    expect(docs).toContain('tm_mandala')
  })
})
