import { randomUUID } from 'node:crypto'
import { Beef, MerklePath, Script, Transaction } from '@bsv/sdk'
import { deleteDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletServices } from '../../sdk/WalletServices.interfaces'

describe('StorageIdb internalization with an existing stored proof', () => {
  let storage: StorageIdb

  beforeEach(async () => {
    storage = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
    storage.dbName = `internalize-known-proof-${randomUUID()}`
    await storage.migrate('known proof intake', 'ac'.repeat(32))
  })

  afterEach(async () => {
    const name = storage.dbName
    await storage.destroy()
    await deleteDB(name)
  })

  test('credits ownership when real storage finds a proof omitted from incoming BEEF', async () => {
    const height = 800001
    const parent = new Transaction()
    parent.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('51') })
    const parentId = parent.id('hex')
    const parentProof = new MerklePath(height, [[{ offset: 0, hash: parentId, txid: true }]])
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(''),
      sequence: 0xffffffff
    })
    tx.addOutput({ satoshis: 500, lockingScript: Script.fromHex('51') })
    const txid = tx.id('hex')
    const storedProof = new MerklePath(height + 1, [[{ offset: 0, hash: txid, txid: true }]])
    const now = new Date()
    const provenTxId = await storage.insertProvenTx({
      provenTxId: 0,
      created_at: now,
      updated_at: now,
      txid,
      height: height + 1,
      index: 0,
      merklePath: storedProof.toBinary(),
      rawTx: tx.toBinary(),
      blockHash: '42'.repeat(32),
      merkleRoot: storedProof.computeRoot(txid)
    })
    const beef = new Beef()
    beef.mergeBump(parentProof)
    beef.mergeTransaction(parent)
    beef.mergeTransaction(tx)
    expect(beef.findBump(txid)).toBeUndefined()
    const header = jest.fn(async () => {
      throw new Error('stored proof must not fetch a header')
    })
    const broadcast = jest.fn(async () => {
      throw new Error('stored proof must not broadcast')
    })
    storage.setServices({
      getChainTracker: async () => ({
        isValidRootForHeight: async (root: string, actualHeight: number) =>
          root === parentProof.computeRoot(parentId) && actualHeight === height
      }),
      getHeaderForHeight: header,
      postBeef: broadcast
    } as unknown as WalletServices)
    // These spies call the actual implementations; the proof lookup is never mocked.
    const lookup = jest.spyOn(storage, 'getProvenOrReq')
    const newRequest = jest.spyOn(storage, 'upsertProvenTxReq')
    const { user } = await storage.findOrInsertUser(`02${'12'.repeat(32)}`)
    await storage.internalizeAction(
      { userId: user.userId, identityKey: user.identityKey },
      {
        tx: beef.toBinaryAtomic(txid),
        description: 'Stored proof recipient intake',
        outputs: [
          { outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'known-proof-recipient' } }
        ]
      }
    )
    expect(lookup).toHaveBeenCalledTimes(1)
    const lookupResult = lookup.mock.results[0]
    if (lookupResult == null) throw new Error('Expected the actual stored-proof lookup result')
    expect((await lookupResult.value).proven?.provenTxId).toBe(provenTxId)
    expect(newRequest).not.toHaveBeenCalled()
    expect(header).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(await storage.findProvenTxReqs({ partial: { txid } })).toEqual([])
    expect(await storage.findProvenTxs({ partial: { txid } })).toHaveLength(1)
    const outputs = await storage.findOutputs({ partial: { txid, userId: user.userId } })
    expect(outputs).toEqual([expect.objectContaining({ vout: 0, satoshis: 500, spendable: true })])
    const baskets = await storage.findOutputBaskets({ partial: { userId: user.userId, name: 'known-proof-recipient' } })
    expect(baskets).toHaveLength(1)
    expect(outputs[0]?.basketId).toBe(baskets[0]?.basketId)
    expect(await storage.findTransactions({ partial: { txid, userId: user.userId } })).toHaveLength(1)
  })
})
