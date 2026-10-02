import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { Hash, P2PKH, PrivateKey } from '@bsv/sdk'
import { Bsv21Binary, encodeStrictCbor } from '@bsv/templates'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { reconcileOwnerIndex } from '../reconcile.js'
import type { EngineOutputReader, MandalaOwnerRecord } from '../types.js'

// The reconciler against a real store and a fake engine whose admitted
// outputs carry real Bsv21Binary scripts. Outpoints are listed in
// (txid, outputIndex) order, as the engine's keyset paging does.

const TOPIC = 'tm_mandala'
const codec = new Bsv21Binary()
const keyOf = (hex: string): string => PrivateKey.fromHex(hex).toPublicKey().toString()
const ISSUER = keyOf('66'.repeat(32))
const HOLDER = keyOf('44'.repeat(32))
const TOKEN = `${'ee'.repeat(32)}_0`
const PKH = Hash.hash160([1])

interface Outpoint {
  txid: string
  outputIndex: number
}

const txidOf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32)
const at = (n: number, outputIndex = 1): Outpoint => ({ txid: txidOf(n), outputIndex })
const label = (o: Outpoint): string => `${o.txid}.${o.outputIndex}`

const valueScript = (amount = 10n): number[] => codec.lock(TOKEN, amount, PKH).toBinary()
const authorityScript = (): number[] => codec.lock(TOKEN, 0n, PKH).toBinary()
const deployScript = (): number[] =>
  codec.lock(null, 0n, PKH, encodeStrictCbor({ sym: 'USD', dec: 2, label: 'Dollar' })).toBinary()

const journal = (o: Outpoint, over: Partial<MandalaOwnerRecord> = {}): MandalaOwnerRecord => ({
  txid: o.txid,
  outputIndex: o.outputIndex,
  topic: TOPIC,
  tokenId: TOKEN,
  role: 'value',
  amount: 10,
  identityKey: HOLDER,
  createdAt: new Date(),
  ...over
})

let mongo: MongoMemoryServer
let client: MongoClient
let db: Db
let storage: MandalaStorageManager
let admitted: Map<string, number[]>
let listing: Outpoint[]
let engine: EngineOutputReader
let onRepair: jest.Mock<(outpoint: string, inserted: boolean) => void>

const admit = (o: Outpoint, script: number[]): void => {
  admitted.set(label(o), script)
  listing.push(o)
  listing.sort((a, b) => label(a).localeCompare(label(b)))
}

const after = (cursor: Outpoint | null): Outpoint[] =>
  cursor === null ? listing : listing.filter(o => label(o) > label(cursor))

const reconcile = async (batchSize?: number) =>
  await reconcileOwnerIndex({ storage, engine, topic: TOPIC, batchSize, onRepair })

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  client = new MongoClient(mongo.getUri())
  await client.connect()
  db = client.db('mandala_reconcile_test')
})

afterAll(async () => {
  await client.close()
  await mongo.stop()
})

beforeEach(async () => {
  await db.dropDatabase()
  storage = new MandalaStorageManager(db)
  admitted = new Map()
  listing = []
  onRepair = jest.fn<(outpoint: string, inserted: boolean) => void>()
  engine = {
    findAdmittedOutput: async (txid, outputIndex, topic) => {
      const script = topic === TOPIC ? admitted.get(`${txid}.${outputIndex}`) : undefined
      return script === undefined ? null : { lockingScript: script, satoshis: 1 }
    },
    listUnspentAdmittedOutputs: async (topic, cursor, limit) =>
      topic === TOPIC ? after(cursor).slice(0, limit) : []
  }
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('reconcileOwnerIndex', () => {
  it('leaves a healthy row, repairs a missing row from the journal and reports one it cannot', async () => {
    const healthy = at(1)
    const missing = at(2)
    const orphan = at(3)
    for (const o of [healthy, missing, orphan]) admit(o, valueScript())
    await storage.recordOwners([journal(healthy), journal(missing)])
    await storage.repairOwnerRow(journal(healthy))

    expect(await reconcile()).toEqual({ scanned: 3, repaired: 1, unrepairable: [label(orphan)] })

    expect(await storage.getTokenRow(missing.txid, missing.outputIndex)).toMatchObject({
      tokenId: TOKEN,
      amount: 10,
      identityKey: HOLDER
    })
    expect(await storage.getBalance(HOLDER)).toBe(20)
    expect(await storage.getTokenRow(orphan.txid, orphan.outputIndex)).toBeNull()
    expect(onRepair.mock.calls).toEqual([[label(missing), true]])
  })

  it('pages through the engine listing in batches, resuming after the last outpoint', async () => {
    const outpoints = [1, 2, 3, 4, 5].map(n => at(n))
    for (const o of outpoints) {
      admit(o, valueScript())
      await storage.recordOwners([journal(o)])
    }
    const list = jest.spyOn(engine, 'listUnspentAdmittedOutputs')

    expect(await reconcile(2)).toEqual({ scanned: 5, repaired: 5, unrepairable: [] })

    expect(list.mock.calls).toEqual([
      [TOPIC, null, 2],
      [TOPIC, outpoints[1], 2],
      [TOPIC, outpoints[3], 2]
    ])
  })

  it('stops after one call when the first page is short, with 200 per page by default', async () => {
    const list = jest.spyOn(engine, 'listUnspentAdmittedOutputs')
    expect(await reconcile()).toEqual({ scanned: 0, repaired: 0, unrepairable: [] })
    expect(list.mock.calls).toEqual([[TOPIC, null, 200]])
  })

  it('corrects a row that disagrees with the script, without a second credit', async () => {
    const o = at(1)
    admit(o, valueScript(10n))
    await storage.recordOwners([journal(o)])
    await storage.storeTokenIfAbsent({ ...journal(o), amount: 7 })

    expect(await reconcile()).toEqual({ scanned: 1, repaired: 1, unrepairable: [] })

    expect(await storage.getTokenRow(o.txid, o.outputIndex)).toMatchObject({ amount: 10 })
    expect(onRepair.mock.calls).toEqual([[label(o), false]])
  })

  it.each([
    ['a non-canonical owner', { identityKey: HOLDER.toUpperCase() }],
    ['another token', { tokenId: `${'dd'.repeat(32)}_0` }]
  ])('repairs a row naming %s', async (_name, over) => {
    const o = at(1)
    admit(o, valueScript())
    await storage.recordOwners([journal(o)])
    await storage.storeTokenIfAbsent({ ...journal(o), ...over })
    expect((await reconcile()).repaired).toBe(1)
    expect(await storage.getTokenRow(o.txid, o.outputIndex)).toMatchObject({
      tokenId: TOKEN,
      identityKey: HOLDER
    })
  })

  it('repairs a missing authority row and a missing deploy row, which credit nothing', async () => {
    const authority = at(1)
    const deploy = at(2, 0)
    admit(authority, authorityScript())
    admit(deploy, deployScript())
    await storage.recordOwners([
      journal(authority, { role: 'authority', amount: 0, identityKey: ISSUER }),
      journal(deploy, {
        role: 'deploy',
        amount: 0,
        identityKey: ISSUER,
        tokenId: `${deploy.txid}_0`
      })
    ])

    expect(await reconcile()).toEqual({ scanned: 2, repaired: 2, unrepairable: [] })

    expect(await storage.getAuthorityRow(authority.txid, 1)).toMatchObject({ tokenId: TOKEN })
    expect(await storage.getAuthorityRow(deploy.txid, 0)).toMatchObject({
      tokenId: `${deploy.txid}_0`
    })
    expect(await storage.getBalance(ISSUER)).toBe(0)
  })

  it('a healthy authority row needs no repair', async () => {
    const o = at(1)
    admit(o, authorityScript())
    const row = journal(o, { role: 'authority', amount: 0, identityKey: ISSUER })
    await storage.recordOwners([row])
    await storage.repairOwnerRow(row)
    expect(await reconcile()).toEqual({ scanned: 1, repaired: 0, unrepairable: [] })
    expect(onRepair).not.toHaveBeenCalled()
  })

  it.each([
    ['token id', { tokenId: `${'dd'.repeat(32)}_0` }],
    ['role', { role: 'authority' as const }],
    ['amount', { amount: 11 }],
    ['owner', { identityKey: 'not a key' }]
  ])('reports a journal row whose %s disagrees with the script', async (_name, over) => {
    const o = at(1)
    admit(o, valueScript())
    await storage.recordOwners([journal(o, over)])
    expect(await reconcile()).toEqual({ scanned: 1, repaired: 0, unrepairable: [label(o)] })
    expect(await storage.getTokenRow(o.txid, o.outputIndex)).toBeNull()
  })

  it('reports a journal amount past 2^53-1 even when it equals the script amount', async () => {
    const o = at(1)
    admit(o, valueScript(2n ** 53n))
    await storage.recordOwners([journal(o, { amount: 2 ** 53 })])
    expect(await reconcile()).toEqual({ scanned: 1, repaired: 0, unrepairable: [label(o)] })
  })

  it('reports an admitted output that is not a token output, or a deploy off vout 0', async () => {
    const plain = at(1)
    const strayDeploy = at(2, 1)
    admit(plain, new P2PKH().lock(PKH).toBinary())
    admit(strayDeploy, deployScript())
    await storage.recordOwners([journal(plain)])
    expect(await reconcile()).toEqual({
      scanned: 2,
      repaired: 0,
      unrepairable: [label(plain), label(strayDeploy)]
    })
  })

  it('skips an output the engine no longer holds (spent or evicted since the listing)', async () => {
    const gone = at(1)
    admit(gone, valueScript())
    admitted.delete(label(gone))
    expect(await reconcile()).toEqual({ scanned: 1, repaired: 0, unrepairable: [] })
  })

  it('logs each repair with its outpoint by default', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = at(1)
    const wrong = at(2)
    admit(missing, valueScript())
    admit(wrong, valueScript())
    await storage.recordOwners([journal(missing), journal(wrong)])
    await storage.storeTokenIfAbsent({ ...journal(wrong), amount: 3 })
    await reconcileOwnerIndex({ storage, engine, topic: TOPIC })
    const line = (o: Outpoint, what: string): string =>
      `[reconcileOwnerIndex] owner index repaired for ${label(o)} from the owner journal (${what})`
    expect(warn.mock.calls).toEqual([
      [line(missing, 'row inserted')],
      [line(wrong, 'row corrected')]
    ])
  })

  it('rethrows an engine read error so the caller can retry', async () => {
    admit(at(1), valueScript())
    const fault = new Error('engine store offline')
    jest.spyOn(engine, 'findAdmittedOutput').mockRejectedValue(fault)
    await expect(reconcile()).rejects.toBe(fault)
    jest.spyOn(engine, 'listUnspentAdmittedOutputs').mockRejectedValue(fault)
    await expect(reconcile()).rejects.toBe(fault)
  })

  it('refuses a listing that does not advance instead of looping forever', async () => {
    admit(at(1), valueScript())
    jest.spyOn(engine, 'listUnspentAdmittedOutputs').mockResolvedValue([at(1)])
    await expect(reconcile(1)).rejects.toThrow(
      `reconcileOwnerIndex: the engine listing did not advance past ${label(at(1))}`
    )
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses batch size %p', async batchSize => {
    await expect(reconcile(batchSize)).rejects.toThrow(
      'reconcileOwnerIndex: batchSize must be a positive integer'
    )
  })
})
