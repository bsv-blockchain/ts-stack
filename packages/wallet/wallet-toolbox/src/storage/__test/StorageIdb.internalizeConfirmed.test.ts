import { randomUUID } from 'node:crypto'
import { Beef, MerklePath, Script, Transaction } from '@bsv/sdk'
import { deleteDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletServices } from '../../sdk/WalletServices.interfaces'
import { TableProvenTx } from '../schema/tables/TableProvenTx'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { blockHash } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'

const HEIGHT = 800000
const BASKET = 'historical-proof-fixture'
const DESCRIPTION = 'Historical proof storage reproduction'

/**
 * IndexedDB finishes a transaction on the next event-loop turn when that
 * transaction has no pending request. A header lookup must take at least one
 * macrotask so this reproduces the browser failure from issue #917.
 */
function delay<T>(value: T, milliseconds = 30): Promise<T> {
  return new Promise(resolve => {
    setTimeout(() => resolve(value), milliseconds)
  })
}

function confirmedPayment(): { atomicBeef: number[]; txid: string; merkleRoot: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 500, lockingScript: Script.fromHex('51') })
  const txid = tx.id('hex')
  const bump = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]])
  const beef = new Beef()
  beef.mergeBump(bump)
  beef.mergeTransaction(tx)
  return { atomicBeef: beef.toBinaryAtomic(txid), txid, merkleRoot: bump.computeRoot(txid) }
}

function headerForRoot(merkleRoot: string): number[] {
  return toBinaryBaseBlockHeader({
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot,
    time: 1,
    bits: 0,
    nonce: 0
  })
}

describe('StorageIdb confirmed internalizeAction', () => {
  jest.setTimeout(20000)

  let storage: StorageIdb

  beforeEach(async () => {
    storage = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
    storage.dbName = `internalize-confirmed-${randomUUID()}`
    await storage.migrate('confirmed internalize', 'ab'.repeat(32))
    await storage.findOrInsertUser(`02${'11'.repeat(32)}`)
  })

  afterEach(async () => {
    const dbName = storage.dbName
    await storage.destroy()
    await deleteDB(dbName)
  })

  async function storedRecords(txid?: string): Promise<{
    proven: TableProvenTx[]
    transactions: TableTransaction[]
    outputs: number
    requests: number
    baskets: string[]
  }> {
    const partial = txid == null ? {} : { txid }
    const [proven, transactions, outputs, requests, baskets] = await Promise.all([
      storage.findProvenTxs({ partial }),
      storage.findTransactions({ partial }),
      storage.findOutputs({ partial }),
      storage.findProvenTxReqs({ partial }),
      storage.findOutputBaskets({ partial: {} })
    ])
    return {
      proven,
      transactions,
      outputs: outputs.length,
      requests: requests.length,
      baskets: baskets.map(basket => basket.name).sort()
    }
  }

  function installServices(options: { header: () => Promise<number[] | undefined>; rootValid?: boolean }): void {
    const services = {
      getChainTracker: async () => ({
        isValidRootForHeight: async () => options.rootValid !== false
      }),
      getHeaderForHeight: async (height: number) => {
        if (height !== HEIGHT) throw new Error(`unexpected header height ${height}`)
        return (await options.header()) as number[]
      }
    }
    storage.setServices(services as unknown as WalletServices)
  }

  async function internalize(atomicBeef: number[]): Promise<void> {
    const { user } = await storage.findOrInsertUser(`02${'11'.repeat(32)}`)
    await storage.internalizeAction(
      { userId: user.userId, identityKey: user.identityKey },
      {
        tx: atomicBeef,
        description: DESCRIPTION,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: BASKET }
          }
        ]
      }
    )
  }

  test('stores a confirmed transaction when the header lookup yields the event loop', async () => {
    const payment = confirmedPayment()
    const header = headerForRoot(payment.merkleRoot)
    let lookups = 0
    installServices({
      header: async () => {
        lookups += 1
        return await delay(header)
      }
    })

    await internalize(payment.atomicBeef)

    const stored = await storedRecords(payment.txid)
    expect(lookups).toBe(1)
    expect(stored.proven).toEqual([
      expect.objectContaining({
        txid: payment.txid,
        height: HEIGHT,
        index: 0,
        merkleRoot: payment.merkleRoot,
        blockHash: blockHash(header)
      })
    ])
    expect(stored.transactions).toEqual([
      expect.objectContaining({
        txid: payment.txid,
        status: 'completed',
        provenTxId: stored.proven[0]?.provenTxId,
        description: DESCRIPTION
      })
    ])
    expect(stored.outputs).toBe(1)
    expect(stored.requests).toBe(0)
    expect(stored.baskets).toEqual(['default', BASKET].sort())
    const [output] = await storage.findOutputs({ partial: { txid: payment.txid } })
    expect(output).toMatchObject({ vout: 0, satoshis: 500, spendable: true })
  })

  test('rejects an invalid proof before writing and does not ask for a header', async () => {
    const payment = confirmedPayment()
    let lookups = 0
    installServices({
      rootValid: false,
      header: async () => {
        lookups += 1
        return await delay(headerForRoot(payment.merkleRoot))
      }
    })

    await expect(internalize(payment.atomicBeef)).rejects.toThrow('valid AtomicBEEF')

    const stored = await storedRecords()
    expect(lookups).toBe(0)
    expect(stored.proven).toEqual([])
    expect(stored.transactions).toEqual([])
    expect(stored.outputs).toBe(0)
    expect(stored.requests).toBe(0)
    expect(stored.baskets).toEqual(['default'])
  })

  test('rejects a missing or malformed header after the lookup and stores nothing', async () => {
    const missing = confirmedPayment()
    installServices({
      header: async () => await delay(undefined)
    })
    await expect(internalize(missing.atomicBeef)).rejects.toThrow('Block header not found')
    expect(await storedRecords()).toMatchObject({
      proven: [],
      transactions: [],
      outputs: 0,
      requests: 0,
      baskets: ['default']
    })

    const malformed = confirmedPayment()
    installServices({
      header: async () => await delay([1, 2, 3])
    })
    await expect(internalize(malformed.atomicBeef)).rejects.toThrow('Block header must be 80 bytes long.')
    expect(await storedRecords()).toMatchObject({
      proven: [],
      transactions: [],
      outputs: 0,
      requests: 0,
      baskets: ['default']
    })
  })

  test('rolls back the confirmed writer when storing an output fails', async () => {
    const payment = confirmedPayment()
    installServices({
      header: async () => await delay(headerForRoot(payment.merkleRoot))
    })
    jest.spyOn(storage, 'insertOutput').mockRejectedValue(new Error('output insert failed'))

    await expect(internalize(payment.atomicBeef)).rejects.toThrow('output insert failed')

    expect(await storedRecords()).toMatchObject({
      proven: [],
      transactions: [],
      outputs: 0,
      requests: 0,
      baskets: ['default']
    })
  })

  test('completes a no-send merge when the mining header is fetched asynchronously', async () => {
    const payment = confirmedPayment()
    const { user } = await storage.findOrInsertUser(`02${'11'.repeat(32)}`)
    const now = new Date()
    await storage.insertTransaction({
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: user.userId,
      status: 'nosend',
      reference: 'nosend-ref',
      isOutgoing: true,
      satoshis: 500,
      description: 'pending no-send payment',
      txid: payment.txid
    })
    installServices({
      header: async () => await delay(headerForRoot(payment.merkleRoot))
    })

    await internalize(payment.atomicBeef)

    const stored = await storedRecords(payment.txid)
    expect(stored.proven).toHaveLength(1)
    expect(stored.transactions).toEqual([
      expect.objectContaining({
        txid: payment.txid,
        status: 'completed',
        provenTxId: stored.proven[0]?.provenTxId
      })
    ])
    expect(stored.outputs).toBe(1)
    expect(stored.requests).toBe(0)
  })
})
