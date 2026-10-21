import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { Hash, P2PKH, PrivateKey, ProtoWallet, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'
import type { OutputAdmittedByTopic, OutputSpent } from '@bsv/overlay'
import { Bsv21Binary, encodeStrictCbor } from '@bsv/templates'
import { MandalaLookupService, createMandalaLookupService } from '../MandalaLookupService.js'
import docs from '../MandalaLookupDocs.md.js'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { AssetAdminState } from '../AssetStateReducer.js'
import { encodeAdminDetails } from '../details.js'
import type { AdminDetails } from '../details.js'
import { encodeEnvelope } from '../types.js'
import type {
  AdminHistoryEntry,
  MandalaEnvelope,
  MandalaOwnerRecord,
  SpecificLinkage
} from '../types.js'

// Real Bsv21Binary transactions and a MongoMemoryServer-backed store. The
// manager is not run: each test journals the owners itself, as the manager
// does before admittance (spec §4.2a rule 1), then notifies the lookup the way
// the engine does in whole-tx mode, one output at a time in index order.

const TOPIC = 'tm_mandala'
const UNMINED = Number.MAX_SAFE_INTEGER
const codec = new Bsv21Binary()
const FT: WalletProtocol = [2, 'mandala token']

const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const walletOf = (hex: string): ProtoWallet => new ProtoWallet(PrivateKey.fromHex(hex))

const overlay = walletOf('0a'.repeat(32))
const issuer = walletOf('66'.repeat(32))
const OVERLAY = keyOf('0a'.repeat(32))
const ISSUER = keyOf('66'.repeat(32))
const HOLDER = keyOf('44'.repeat(32))
const RECEIVER = keyOf('22'.repeat(32))
// The service only calls `decrypt` on the verifier, which ProtoWallet implements.
const verifierWallet = overlay as unknown as WalletInterface

const DEPLOY_PAYLOAD = encodeStrictCbor({
  sym: 'USD',
  dec: 2,
  label: 'US Dollar',
  feeRatePerKb: 50
})

// ---- transactions ----

interface TokenOut {
  /** null: a deploy. */
  tokenId: string | null
  amount: bigint
  /** The journalled owner; the output is locked to hash160 of this key. */
  owner: string
  payload?: number[]
}

interface Spend {
  tx: Transaction
  vout: number
}

interface Built {
  tx: Transaction
  txid: string
  outs: TokenOut[]
  env: MandalaEnvelope
}

let nonce = 0

// Roots every chain in a funding tx with no inputs, so BEEF needs no proofs.
function funding(): Transaction {
  const source = new Transaction()
  source.lockTime = ++nonce
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160([nonce])) })
  return source
}

const pkhOf = (key: string): number[] => Hash.hash160(Utils.toArray(key, 'hex'))

/** Token spends first, then one funding input. */
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

function build(
  spends: readonly Spend[],
  outs: TokenOut[],
  admin: MandalaEnvelope['admin'] = []
): Built {
  const tx = txSpending(spends)
  for (const out of outs) {
    tx.addOutput({
      satoshis: 1,
      lockingScript: codec.lock(out.tokenId, out.amount, pkhOf(out.owner), out.payload)
    })
  }
  return { tx, txid: tx.id('hex'), outs, env: { inputs: [], outputs: [], admin } }
}

const deployTx = (payload = DEPLOY_PAYLOAD): Built =>
  build([], [{ tokenId: null, amount: 0n, owner: ISSUER, payload }])

const commitTo = (details: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(details)) })

/** Spends `spends`: the value outputs first, then the authority committing `details`. */
function adminTx(
  tokenId: string,
  spends: readonly Spend[],
  details: AdminDetails,
  values: ReadonlyArray<[string, bigint]> = []
): Built {
  const bytes = encodeAdminDetails(details)
  const outs: TokenOut[] = [
    ...values.map(([owner, amount]) => ({ tokenId, amount, owner })),
    { tokenId, amount: 0n, owner: ISSUER, payload: commitTo(bytes) }
  ]
  return build(spends, outs, [{ index: values.length, details: Utils.toHex(bytes) }])
}

const roleOf = (out: TokenOut): MandalaOwnerRecord['role'] => {
  if (out.tokenId === null) return 'deploy'
  return out.amount === 0n ? 'authority' : 'value'
}

const journalRow = (b: Built, index: number): MandalaOwnerRecord => {
  const out = b.outs[index]
  return {
    txid: b.txid,
    outputIndex: index,
    topic: TOPIC,
    tokenId: out.tokenId ?? `${b.txid}_0`,
    role: roleOf(out),
    amount: Number(out.amount),
    identityKey: out.owner,
    createdAt: new Date()
  }
}

// ---- the store and the service ----

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let storage: MandalaStorageManager
let service: MandalaLookupService

const payloadOf = (
  b: Built,
  outputIndex: number,
  over: Partial<{ topic: string; offChainValues: number[] | undefined }> = {}
): OutputAdmittedByTopic => ({
  mode: 'whole-tx',
  atomicBEEF: b.tx.toAtomicBEEF(),
  outputIndex,
  topic: TOPIC,
  offChainValues: encodeEnvelope(b.env),
  ...over
})

/** Journal every output, then notify the lookup of each in index order. */
async function settle(b: Built): Promise<void> {
  await storage.recordOwners(b.outs.map((_, i) => journalRow(b, i)))
  for (const i of b.outs.keys()) await service.outputAdmittedByTopic(payloadOf(b, i))
}

async function deployed(payload = DEPLOY_PAYLOAD): Promise<{ tokenId: string; deploy: Built }> {
  const deploy = deployTx(payload)
  await settle(deploy)
  return { tokenId: `${deploy.txid}_0`, deploy }
}

async function issued(
  values: ReadonlyArray<[string, bigint]> = [[HOLDER, 100n]]
): Promise<{ tokenId: string; deploy: Built; issue: Built }> {
  const { tokenId, deploy } = await deployed()
  const issue = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'issue' }, values)
  await settle(issue)
  return { tokenId, deploy, issue }
}

const historyOf = async (tokenId: string): Promise<AdminHistoryEntry[]> =>
  await storage.findAdminHistory(tokenId)

const sha256Hex = (hex: string): string => Utils.toHex(Hash.sha256(Utils.toArray(hex, 'hex')))

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = new MongoClient(mongo.getUri())
  await client.connect()
  db = client.db('mandala_lookup_service_test')
}, 60_000)

afterAll(async () => {
  await client.close()
  await mongo.stop()
}, 60_000)

beforeEach(async () => {
  await db.dropDatabase()
  storage = new MandalaStorageManager(db)
  service = new MandalaLookupService({ storage, verifierWallet })
})

describe('MandalaLookupService admission', () => {
  it('indexes a deploy: metadata, authority row and the default state with its fee rate', async () => {
    const { tokenId, deploy } = await deployed()

    expect(await storage.findMetadata(tokenId)).toEqual({
      tokenId,
      txid: deploy.txid,
      outputIndex: 0,
      sym: 'USD',
      dec: 2,
      label: 'US Dollar',
      feeRatePerKb: 50
    })
    expect(await storage.getAuthorityRow(deploy.txid, 0)).toEqual({
      txid: deploy.txid,
      outputIndex: 0,
      topic: TOPIC,
      tokenId,
      identityKey: ISSUER,
      createdAt: expect.any(Date)
    })
    const persisted = await db
      .collection('mandalaAssetStates')
      .findOne({ tokenId }, { projection: { _id: 0 } })
    expect(persisted).toEqual(defaultAssetState(tokenId, 50))
    expect(await storage.getTokenRow(deploy.txid, 0)).toBeNull()
    expect(await historyOf(tokenId)).toEqual([])
  })

  it('a deploy without a fee rate starts with fees off', async () => {
    const { tokenId } = await deployed(encodeStrictCbor({ sym: 'EUR', dec: 2, label: 'Euro' }))
    expect(await storage.getAssetState(tokenId)).toEqual(defaultAssetState(tokenId, null))
  })

  it('a replayed deploy notification never resets the state', async () => {
    const { tokenId, deploy } = await deployed()
    await storage.putAssetState({ ...defaultAssetState(tokenId, 50), isPaused: true })
    await service.outputAdmittedByTopic(payloadOf(deploy, 0))
    expect((await storage.getAssetState(tokenId)).isPaused).toBe(true)
    expect(await db.collection('mandalaAuthorities').countDocuments()).toBe(1)
  })

  it('an issue indexes the value row from the journal and folds a history row with its delta', async () => {
    const { tokenId, issue } = await issued()

    expect(await storage.getTokenRow(issue.txid, 0)).toEqual({
      txid: issue.txid,
      outputIndex: 0,
      tokenId,
      amount: 100,
      identityKey: HOLDER,
      createdAt: expect.any(Date)
    })
    expect(await storage.getBalance(HOLDER)).toBe(100)
    expect(await storage.getAuthorityRow(issue.txid, 1)).toMatchObject({
      tokenId,
      identityKey: ISSUER
    })
    const detailsHex = issue.env.admin[0].details
    expect(await historyOf(tokenId)).toEqual([
      {
        tokenId,
        txid: issue.txid,
        outputIndex: 1,
        kind: 'issue',
        detailsHex,
        commitment: sha256Hex(detailsHex),
        delta: 100,
        height: UNMINED,
        offset: 0,
        admitSeq: 1,
        createdAt: expect.any(Date)
      }
    ])
    expect(await storage.getAssetState(tokenId)).toEqual({
      ...defaultAssetState(tokenId, 50),
      lastProcessedHeight: UNMINED,
      lastProcessedOffset: 0,
      lastAdmitSeq: 1
    })
  })

  it('a redeem records value out minus value in as a negative delta', async () => {
    const { tokenId, issue } = await issued()
    const redeem = adminTx(
      tokenId,
      [
        { tx: issue.tx, vout: 1 },
        { tx: issue.tx, vout: 0 }
      ],
      { kind: 'redeem' },
      [[HOLDER, 30n]]
    )
    await settle(redeem)
    const rows = await historyOf(tokenId)
    expect(rows.map(r => [r.kind, r.delta, r.admitSeq])).toEqual([
      ['issue', 100, 1],
      ['redeem', -70, 2]
    ])
  })

  it('folds a pause into the asset state', async () => {
    const { tokenId, deploy } = await deployed()
    await settle(adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' }))
    expect((await storage.getAssetState(tokenId)).isPaused).toBe(true)
  })

  it('folds a freeze with the frozen row amount and owner', async () => {
    const { tokenId, issue } = await issued()
    const outpoint = `${issue.txid}.0`
    await settle(adminTx(tokenId, [{ tx: issue.tx, vout: 1 }], { kind: 'freezeOutput', outpoint }))
    expect((await storage.getAssetState(tokenId)).frozenOutpoints).toEqual([
      { outpoint, amount: 100, owner: HOLDER }
    ])
  })

  it('a replayed committed authority output adds no second history row and no second fold', async () => {
    const { tokenId, deploy } = await deployed()
    const pause = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
    await settle(pause)
    await storage.putAssetState({ ...(await storage.getAssetState(tokenId)), isPaused: false })
    await service.outputAdmittedByTopic(payloadOf(pause, 0))
    expect(await historyOf(tokenId)).toHaveLength(1)
    expect((await storage.getAssetState(tokenId)).isPaused).toBe(false)
  })

  it('records the action even when the authority row was already repaired from the journal', async () => {
    const { tokenId, deploy } = await deployed()
    const pause = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
    await storage.recordOwners([journalRow(pause, 0)])
    // A spend of the new authority was validated before the lookup ran (spec §4.2a rule 3).
    await storage.repairOwnerRow(journalRow(pause, 0))
    await service.outputAdmittedByTopic(payloadOf(pause, 0))
    expect(await historyOf(tokenId)).toHaveLength(1)
    expect((await storage.getAssetState(tokenId)).isPaused).toBe(true)
  })

  it('a replayed value output credits the balance once', async () => {
    const { issue } = await issued()
    await service.outputAdmittedByTopic(payloadOf(issue, 0))
    expect(await storage.getBalance(HOLDER)).toBe(100)
  })

  it('a committed output whose details are not in the envelope records no history', async () => {
    const { tokenId, deploy } = await deployed()
    const pause = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
    pause.env.admin = []
    await settle(pause)
    expect(await storage.getAuthorityRow(pause.txid, 0)).not.toBeNull()
    expect(await historyOf(tokenId)).toEqual([])
    expect(await storage.getAssetState(tokenId)).toEqual(defaultAssetState(tokenId, 50))
  })

  it('an authority output with no commitment is indexed with no history', async () => {
    const { tokenId, deploy } = await deployed()
    const split = build(
      [{ tx: deploy.tx, vout: 0 }],
      [
        { tokenId, amount: 0n, owner: ISSUER },
        { tokenId, amount: 0n, owner: ISSUER }
      ]
    )
    await settle(split)
    expect(await storage.listAuthorities(TOPIC, tokenId)).toHaveLength(3)
    expect(await historyOf(tokenId)).toEqual([])
    expect(await storage.getAssetState(tokenId)).toEqual(defaultAssetState(tokenId, 50))
  })

  it('stores the linkage record of an output beside its journalled owner', async () => {
    const { tokenId, deploy } = await deployed()
    const linkage = { prover: ISSUER, counterparty: HOLDER } as unknown as SpecificLinkage
    const issue = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'issue' }, [
      [HOLDER, 100n]
    ])
    issue.env.outputs = [{ index: 0, linkage }]
    await settle(issue)
    const rows = await db
      .collection('mandalaLinkageRecords')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    expect(rows).toEqual([
      {
        txid: issue.txid,
        outputIndex: 0,
        identityKey: HOLDER,
        linkage,
        createdAt: expect.any(Date)
      }
    ])
  })

  it('ignores another topic, the locking-script mode and a non-token output', async () => {
    const TOKEN = `${'ab'.repeat(32)}_0`
    const tx = txSpending([])
    tx.addOutput({ satoshis: 1, lockingScript: codec.lock(TOKEN, 5n, pkhOf(HOLDER)) })
    tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(pkhOf(HOLDER)) })
    const b: Built = {
      tx,
      txid: tx.id('hex'),
      outs: [{ tokenId: TOKEN, amount: 5n, owner: HOLDER }],
      env: { inputs: [], outputs: [], admin: [] }
    }
    await storage.recordOwners([journalRow(b, 0)])
    await service.outputAdmittedByTopic(payloadOf(b, 0, { topic: 'tm_other' }))
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: b.txid,
      outputIndex: 0,
      topic: TOPIC,
      satoshis: 1,
      lockingScript: tx.outputs[0].lockingScript
    })
    await service.outputAdmittedByTopic(payloadOf(b, 1))
    expect(await db.collection('mandalaTokens').countDocuments()).toBe(0)
    expect(await db.collection('mandalaAuthorities').countDocuments()).toBe(0)
  })
})

// The engine notifies each output once and only logs a throw, so a lost write is never retried.
describe('MandalaLookupService lost writes', () => {
  /** Notifies every output, as the engine does, and returns what each notification threw. */
  async function settleCatching(b: Built): Promise<unknown[]> {
    await storage.recordOwners(b.outs.map((_, i) => journalRow(b, i)))
    const thrown: unknown[] = []
    for (const i of b.outs.keys()) {
      await service.outputAdmittedByTopic(payloadOf(b, i)).catch((e: unknown) => thrown.push(e))
    }
    return thrown
  }

  const fault = new Error('write concern timeout')

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([['storeAuthorityIfAbsent'], ['storeLinkage']] as const)(
    'records and folds a committed action even when %s fails for its output',
    async method => {
      const { tokenId, deploy } = await deployed()
      const freeze = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
      freeze.env.outputs = [{ index: 0, linkage: { prover: ISSUER } as unknown as SpecificLinkage }]
      jest.spyOn(storage, method).mockRejectedValueOnce(fault)
      expect(await settleCatching(freeze)).toEqual([fault])
      expect(await historyOf(tokenId)).toHaveLength(1)
      expect((await storage.getAssetState(tokenId)).isPaused).toBe(true)
      // the other owner record of the output is still written
      const other = method === 'storeLinkage' ? 'mandalaAuthorities' : 'mandalaLinkageRecords'
      expect(await db.collection(other).countDocuments({ txid: freeze.txid })).toBe(1)
    }
  )

  it('keeps a deploy metadata and first state with its fee rate when its authority row fails', async () => {
    const deploy = deployTx()
    const tokenId = `${deploy.txid}_0`
    jest.spyOn(storage, 'storeAuthorityIfAbsent').mockRejectedValueOnce(fault)
    expect(await settleCatching(deploy)).toEqual([fault])
    expect(await storage.findMetadata(tokenId)).toMatchObject({ sym: 'USD', feeRatePerKb: 50 })
    expect(await storage.getAssetState(tokenId)).toEqual(defaultAssetState(tokenId, 50))
    expect(await storage.getAuthorityRow(deploy.txid, 0)).toBeNull()
  })

  it('still indexes the owner when the history append fails, and rethrows the fault', async () => {
    const { tokenId, deploy } = await deployed()
    const pause = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
    jest.spyOn(storage, 'appendAdminHistory').mockRejectedValueOnce(fault)
    expect(await settleCatching(pause)).toEqual([fault])
    expect(await storage.getAuthorityRow(pause.txid, 0)).not.toBeNull()
    expect(await historyOf(tokenId)).toEqual([])
  })

  it('rethrows the first fault when several writes fail', async () => {
    const { tokenId, deploy } = await deployed()
    const pause = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], { kind: 'pause' })
    const later = new Error('second fault')
    jest.spyOn(storage, 'appendAdminHistory').mockRejectedValueOnce(fault)
    jest.spyOn(storage, 'storeAuthorityIfAbsent').mockRejectedValueOnce(later)
    expect(await settleCatching(pause)).toEqual([fault])
  })

  it('keeps the action when the freeze context cannot be read, for the refold to fold', async () => {
    const { tokenId, issue } = await issued()
    const outpoint = `${issue.txid}.0`
    const freeze = adminTx(tokenId, [{ tx: issue.tx, vout: 1 }], { kind: 'freezeOutput', outpoint })
    jest.spyOn(storage, 'getTokenRow').mockRejectedValueOnce(fault)
    expect(await settleCatching(freeze)).toEqual([fault])
    const [, row] = await historyOf(tokenId)
    expect(row).toMatchObject({ kind: 'freezeOutput' })
    expect(row).not.toHaveProperty('frozenAmount')
    expect((await storage.getAssetState(tokenId)).frozenOutpoints).toEqual([])
    await service.rebuildState(tokenId)
    expect((await storage.getAssetState(tokenId)).frozenOutpoints).toEqual([
      { outpoint, amount: 100, owner: HOLDER }
    ])
  })
})

describe('MandalaLookupService freeze fold context', () => {
  async function frozenAfter(target: (issue: Built) => string) {
    const { tokenId, issue } = await issued()
    const outpoint = target(issue)
    const freeze = adminTx(tokenId, [{ tx: issue.tx, vout: 1 }], { kind: 'freezeOutput', outpoint })
    await settle(freeze)
    const [, row] = await historyOf(tokenId)
    return { tokenId, issue, outpoint, row }
  }

  it('records the frozen amount and owner on the history row', async () => {
    const { row } = await frozenAfter(issue => `${issue.txid}.0`)
    expect(row).toMatchObject({ kind: 'freezeOutput', frozenAmount: 100, frozenOwner: HOLDER })
  })

  it('refolds with the recorded context, whatever happened to the frozen row since', async () => {
    const { tokenId, issue, outpoint } = await frozenAfter(i => `${i.txid}.0`)
    const live = await storage.getAssetState(tokenId)
    await storage.takeToken(issue.txid, 0)
    await service.rebuildState(tokenId)
    expect(await storage.getAssetState(tokenId)).toEqual(live)
    expect(live.frozenOutpoints).toEqual([{ outpoint, amount: 100, owner: HOLDER }])
  })

  it('freezes a coin with no row at 0 and keeps it at 0 when the row appears later', async () => {
    const { tokenId, issue, row } = await frozenAfter(i => `${i.txid}.7`)
    expect(row).toMatchObject({ frozenAmount: 0, frozenOwner: '' })
    // the row is repaired after the freeze was folded: a refold must not read it now
    await storage.storeTokenIfAbsent({
      txid: issue.txid,
      outputIndex: 7,
      tokenId,
      amount: 55,
      identityKey: RECEIVER,
      createdAt: new Date()
    })
    await service.rebuildState(tokenId)
    expect((await storage.getAssetState(tokenId)).frozenOutpoints).toEqual([
      { outpoint: `${issue.txid}.7`, amount: 0, owner: '' }
    ])
  })

  it('freezes a coin of another token at 0, so a reissue can never mint its amount', async () => {
    const other = await issued([[RECEIVER, 900n]])
    const { tokenId, issue } = await issued()
    const outpoint = `${other.issue.txid}.0`
    await settle(adminTx(tokenId, [{ tx: issue.tx, vout: 1 }], { kind: 'freezeOutput', outpoint }))
    expect((await storage.getAssetState(tokenId)).frozenOutpoints).toEqual([
      { outpoint, amount: 0, owner: '' }
    ])
  })

  it('records no fold context for any other kind', async () => {
    const { tokenId } = await issued()
    expect(await historyOf(tokenId)).toEqual([
      expect.not.objectContaining({ frozenAmount: expect.anything() })
    ])
  })
})

describe('MandalaLookupService tokenIdsWithHistory', () => {
  it('lists every token with admin history once, and none without', async () => {
    const first = await issued()
    const second = await issued()
    await deployed()
    const pause = adminTx(first.tokenId, [{ tx: first.issue.tx, vout: 1 }], { kind: 'pause' })
    await settle(pause)
    expect((await service.tokenIdsWithHistory()).sort()).toEqual(
      [first.tokenId, second.tokenId].sort()
    )
  })
})

describe('MandalaLookupService owner fallback (no journal row)', () => {
  const TOKEN = `${'ab'.repeat(32)}_0`

  /** A value output to HOLDER whose linkage the issuer reveals to the overlay. */
  async function linkedValue(keyID: string): Promise<Built> {
    const { publicKey } = await issuer.getPublicKey({ protocolID: FT, keyID, counterparty: HOLDER })
    const linkage = (await issuer.revealSpecificKeyLinkage({
      counterparty: HOLDER,
      verifier: OVERLAY,
      protocolID: FT,
      keyID
    })) as SpecificLinkage
    const tx = txSpending([])
    tx.addOutput({
      satoshis: 1,
      lockingScript: codec.lock(TOKEN, 25n, Hash.hash160(Utils.toArray(publicKey, 'hex')))
    })
    return {
      tx,
      txid: tx.id('hex'),
      outs: [{ tokenId: TOKEN, amount: 25n, owner: HOLDER }],
      env: { inputs: [], outputs: [{ index: 0, linkage }], admin: [] }
    }
  }

  it('verifies the output linkage and stores the row it proves', async () => {
    const b = await linkedValue('fallback-1')
    await service.outputAdmittedByTopic(payloadOf(b, 0))
    expect(await storage.getTokenRow(b.txid, 0)).toMatchObject({
      tokenId: TOKEN,
      amount: 25,
      identityKey: HOLDER
    })
    expect(await storage.getBalance(HOLDER)).toBe(25)
    expect(
      await db.collection('mandalaLinkageRecords').countDocuments({ identityKey: HOLDER })
    ).toBe(1)
  })

  it('skips the output when the linkage proves another key', async () => {
    const b = await linkedValue('fallback-2')
    b.env.outputs = (await linkedValue('fallback-3')).env.outputs
    await service.outputAdmittedByTopic(payloadOf(b, 0))
    expect(await storage.getTokenRow(b.txid, 0)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(0)
  })

  it('skips the output when neither a journal row nor a linkage exists', async () => {
    const b = build([], [{ tokenId: TOKEN, amount: 5n, owner: RECEIVER }])
    await service.outputAdmittedByTopic(payloadOf(b, 0, { offChainValues: undefined }))
    expect(await db.collection('mandalaTokens').countDocuments()).toBe(0)
    expect(await db.collection('mandalaLinkageRecords').countDocuments()).toBe(0)
  })

  it('does not take the owner from a journal row that disagrees with the script', async () => {
    const b = build([], [{ tokenId: TOKEN, amount: 5n, owner: RECEIVER }])
    await storage.recordOwners([{ ...journalRow(b, 0), amount: 6 }])
    await service.outputAdmittedByTopic(payloadOf(b, 0))
    expect(await storage.getTokenRow(b.txid, 0)).toBeNull()
  })
})

describe('MandalaLookupService spends and evictions', () => {
  const spent = (txid: string, outputIndex: number, topic = TOPIC): OutputSpent => ({
    mode: 'none',
    txid,
    outputIndex,
    topic
  })

  it('a spent value row is removed and its balance debited once', async () => {
    const { issue } = await issued()
    await service.outputSpent(spent(issue.txid, 0))
    expect(await storage.getTokenRow(issue.txid, 0)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(0)
    await service.outputSpent(spent(issue.txid, 0))
    expect(await storage.getBalance(HOLDER)).toBe(0)
  })

  it('a spent authority row is removed', async () => {
    const { issue } = await issued()
    await service.outputSpent(spent(issue.txid, 1))
    expect(await storage.getAuthorityRow(issue.txid, 1)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(100)
  })

  it('a spend on another topic changes nothing', async () => {
    const { issue } = await issued()
    await service.outputSpent(spent(issue.txid, 0, 'tm_other'))
    expect(await storage.getTokenRow(issue.txid, 0)).not.toBeNull()
  })

  it('an evicted value row is removed and debited', async () => {
    const { tokenId, issue } = await issued()
    await service.outputEvicted(issue.txid, 0)
    expect(await storage.getTokenRow(issue.txid, 0)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(0)
    expect(await storage.circulatingSupply(tokenId)).toBe(0n)
  })

  it('an evicted deploy takes its authority row and its metadata', async () => {
    const { tokenId, deploy } = await deployed()
    await service.outputEvicted(deploy.txid, 0)
    expect(await storage.getAuthorityRow(deploy.txid, 0)).toBeNull()
    expect(await storage.findMetadata(tokenId)).toBeNull()
  })

  it('evicting a non-deploy output leaves every metadata row alone', async () => {
    const { tokenId, issue } = await issued()
    await service.outputEvicted(issue.txid, 1)
    expect(await storage.getAuthorityRow(issue.txid, 1)).toBeNull()
    await service.outputEvicted(issue.txid, 0)
    expect(await storage.findMetadata(tokenId)).not.toBeNull()
  })

  it('purgeAndRefold drops the evicted transaction from the state and the history', async () => {
    const { tokenId, deploy } = await deployed()
    const block = adminTx(tokenId, [{ tx: deploy.tx, vout: 0 }], {
      kind: 'blockIdentity',
      identityKey: RECEIVER
    })
    await settle(block)
    const pause = adminTx(tokenId, [{ tx: block.tx, vout: 0 }], { kind: 'pause' })
    await settle(pause)
    expect((await storage.getAssetState(tokenId)).isPaused).toBe(true)

    expect(await service.purgeAndRefold(pause.txid)).toEqual([tokenId])

    expect(await storage.getAssetState(tokenId)).toEqual({
      ...defaultAssetState(tokenId, 50),
      blockedIdentities: [RECEIVER],
      lastProcessedHeight: UNMINED,
      lastAdmitSeq: 1
    })
    expect((await historyOf(tokenId)).map(r => r.txid)).toEqual([block.txid])
    expect(await service.purgeAndRefold(pause.txid)).toEqual([])
  })

  it('restoreInputRow puts back a live input row, crediting once', async () => {
    const { issue } = await issued()
    await service.outputSpent(spent(issue.txid, 0))
    const journal = await storage.getOwnerJournal(issue.txid, 0, TOPIC)
    if (journal === null) throw new Error('no journal row')
    expect(await service.restoreInputRow(journal)).toBe(true)
    expect(await service.restoreInputRow(journal)).toBe(false)
    expect(await storage.getTokenRow(issue.txid, 0)).toMatchObject({ amount: 100 })
    expect(await storage.getBalance(HOLDER)).toBe(100)
  })
})

describe('MandalaLookupService rebuildState', () => {
  const TOKEN = `${'cd'.repeat(32)}_0`
  const FROZEN_TXID = 'f0'.repeat(32)
  const FROZEN = `${FROZEN_TXID}.3`

  const row = (
    txid: string,
    details: AdminDetails,
    height: number,
    offset: number,
    admitSeq: number
  ): AdminHistoryEntry => {
    const detailsHex = Utils.toHex(encodeAdminDetails(details))
    return {
      tokenId: TOKEN,
      txid,
      outputIndex: 1,
      kind: details.kind,
      detailsHex,
      commitment: sha256Hex(detailsHex),
      delta: 0,
      height,
      offset,
      admitSeq,
      createdAt: new Date()
    }
  }

  const FEE_TXID = '44'.repeat(32)
  const ROWS: AdminHistoryEntry[] = [
    row('11'.repeat(32), { kind: 'unpause' }, 101, 0, 2),
    row('22'.repeat(32), { kind: 'pause' }, 100, 2, 1),
    row('33'.repeat(32), { kind: 'blockIdentity', identityKey: HOLDER }, 100, 1, 5),
    row(FEE_TXID, { kind: 'setFeeRate', feeRatePerKb: 7 }, 99, 4, 9),
    row('55'.repeat(32), { kind: 'freezeOutput', outpoint: FROZEN }, 102, 0, 3),
    row('66'.repeat(32), { kind: 'pause' }, UNMINED, 0, 4)
  ]

  async function rebuiltFrom(rows: readonly AdminHistoryEntry[]): Promise<AssetAdminState> {
    await db.dropDatabase()
    storage = new MandalaStorageManager(db)
    service = new MandalaLookupService({ storage, verifierWallet })
    await storage.storeMetadata({
      tokenId: TOKEN,
      txid: 'cd'.repeat(32),
      outputIndex: 0,
      sym: 'USD',
      dec: 2,
      label: 'US Dollar',
      feeRatePerKb: 50
    })
    await storage.storeTokenIfAbsent({
      txid: FROZEN_TXID,
      outputIndex: 3,
      tokenId: TOKEN,
      amount: 40,
      identityKey: RECEIVER,
      createdAt: new Date()
    })
    for (const r of rows) await storage.appendAdminHistory(r)
    await service.rebuildState(TOKEN)
    return await storage.getAssetState(TOKEN)
  }

  it('folds the history in (height, offset, admitSeq) order whatever the insert order', async () => {
    const forward = await rebuiltFrom(ROWS)
    const backward = await rebuiltFrom([...ROWS].reverse())
    const shuffled = await rebuiltFrom([ROWS[3], ROWS[0], ROWS[5], ROWS[1], ROWS[4], ROWS[2]])
    expect(backward).toEqual(forward)
    expect(shuffled).toEqual(forward)
    expect(forward).toEqual({
      ...defaultAssetState(TOKEN, 7),
      isPaused: true,
      blockedIdentities: [HOLDER],
      frozenOutpoints: [{ outpoint: FROZEN, amount: 40, owner: RECEIVER }],
      lastProcessedHeight: UNMINED,
      lastProcessedOffset: 0,
      lastAdmitSeq: 4
    })
  })

  it('leaves the excluded transaction out and starts from the deploy fee rate', async () => {
    await rebuiltFrom(ROWS)
    await service.rebuildState(TOKEN, FEE_TXID)
    expect((await storage.getAssetState(TOKEN)).feeRatePerKb).toBe(50)
  })

  it('a token with no metadata and no history rebuilds to the default with fees off', async () => {
    await service.rebuildState(TOKEN)
    expect(await storage.getAssetState(TOKEN)).toEqual(defaultAssetState(TOKEN, null))
  })
})

describe('MandalaLookupService lookup', () => {
  const VALID = `${'ab'.repeat(32)}_0`

  const ask = async (query: Record<string, unknown>) =>
    await service.lookup({ service: 'ls_mandala', query })

  const populated = async () =>
    await issued([
      [HOLDER, 60n],
      [RECEIVER, 40n]
    ])

  it('answers each key', async () => {
    const { tokenId, deploy, issue } = await populated()

    expect(await ask({ metadataTokenId: tokenId })).toEqual([{ txid: deploy.txid, outputIndex: 0 }])
    expect(await ask({ assetStateTokenId: tokenId })).toEqual([
      await storage.getAssetState(tokenId)
    ])
    expect(await ask({ adminHistoryTokenId: tokenId })).toEqual(await historyOf(tokenId))
    expect(await ask({ authoritiesTokenId: tokenId })).toEqual(
      await storage.listAuthorities(TOPIC, tokenId)
    )
    expect((await ask({ tokenId })).map(r => `${r.txid}.${r.outputIndex}`)).toEqual([
      `${issue.txid}.0`,
      `${issue.txid}.1`
    ])
    expect(await ask({ txid: issue.txid.toUpperCase(), outputIndex: 1 })).toEqual([
      await storage.getTokenRow(issue.txid, 1)
    ])
    expect(await ask({ txid: issue.txid, outputIndex: 2 })).toEqual([
      await storage.getAuthorityRow(issue.txid, 2)
    ])
    expect(await ask({ txid: issue.txid, outputIndex: 3 })).toEqual([])
    expect(await ask({ metadataTokenId: `${issue.txid}_0` })).toEqual([])
  })

  it('pages the token, history and authority answers', async () => {
    const { tokenId } = await populated()
    expect((await ask({ tokenId, limit: 1, skip: 1 })).map(r => r.outputIndex)).toEqual([1])
    expect(await ask({ adminHistoryTokenId: tokenId, skip: 1 })).toEqual([])
    const authorities = await storage.listAuthorities(TOPIC, tokenId)
    expect(await ask({ authoritiesTokenId: tokenId, limit: 1, skip: 1 })).toEqual(
      authorities.slice(1, 2)
    )
  })

  it('dispatches the first key in catalog order', async () => {
    const { tokenId, deploy } = await populated()
    expect(await ask({ tokenId, metadataTokenId: tokenId })).toEqual([
      { txid: deploy.txid, outputIndex: 0 }
    ])
  })

  it.each([
    [{ metadataTokenId: `${'AB'.repeat(32)}_0` }, 'metadataTokenId must be a token id'],
    [{ assetStateTokenId: `${'ab'.repeat(32)}.0` }, 'assetStateTokenId must be a token id'],
    [{ adminHistoryTokenId: `${'ab'.repeat(32)}_1` }, 'adminHistoryTokenId must be a token id'],
    [{ authoritiesTokenId: 7 }, 'authoritiesTokenId must be a token id'],
    [{ tokenId: `${'ab'.repeat(31)}_0` }, 'tokenId must be a token id'],
    [{ tokenId: VALID, metadataTokenId: 'x' }, 'metadataTokenId must be a token id'],
    [{ txid: 'zz', outputIndex: 0 }, 'txid must be a transaction ID'],
    [{ txid: 'ab'.repeat(32), outputIndex: -1 }, 'outputIndex must be an integer'],
    [{ tokenId: VALID, limit: 0 }, 'limit must be an integer from 1 to 100'],
    [{ tokenId: VALID, limit: 101 }, 'limit must be an integer from 1 to 100'],
    [{ tokenId: VALID, skip: 100001 }, 'skip must be an integer from 0 to 100000'],
    [{ assetId: `${'ab'.repeat(32)}.0` }, 'unexpected field assetId']
  ])('rejects %j', async (query, message) => {
    await expect(ask(query)).rejects.toThrow(message)
  })

  it.each([[{}], [{ txid: 'ab'.repeat(32) }], [{ outputIndex: 0 }], [{ limit: 5 }]])(
    'refuses a query with no answerable key: %j',
    async query => {
      await expect(ask(query)).rejects.toThrow('Unsupported query')
    }
  )

  it('refuses another service', async () => {
    await expect(service.lookup({ service: 'ls_other', query: {} })).rejects.toThrow(
      'Lookup service not supported!'
    )
  })
})

describe('MandalaLookupService documentation and factory', () => {
  it('serves its documentation and metadata', async () => {
    expect(await service.getDocumentation()).toBe(docs)
    expect(docs).toContain('metadataTokenId')
    expect(await service.getMetaData()).toEqual({
      name: 'ls_mandala',
      shortDescription: expect.stringContaining('tokenId')
    })
    expect(service.admissionMode).toBe('whole-tx')
    expect(service.spendNotificationMode).toBe('script')
  })

  it('builds a service on the given storage or on a new one over the database', async () => {
    expect(createMandalaLookupService(verifierWallet, storage)(db)).toBeInstanceOf(
      MandalaLookupService
    )
    const fresh = createMandalaLookupService(verifierWallet)(db)
    const { tokenId } = await deployed()
    expect(
      await fresh.lookup({ service: 'ls_mandala', query: { metadataTokenId: tokenId } })
    ).toHaveLength(1)
  })
})
