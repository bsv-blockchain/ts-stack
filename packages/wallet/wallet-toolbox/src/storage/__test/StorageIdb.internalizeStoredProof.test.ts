import { randomUUID } from 'node:crypto'
import { Beef, MerklePath, Script, Transaction } from '@bsv/sdk'
import { deleteDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { blockHash } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'

test('internalizes recipient ownership when storage already knows a proof omitted from the incoming BEEF', async () => {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
  storage.dbName = `internalize-stored-proof-${randomUUID()}`
  try {
    await storage.migrate('stored proof internalize', 'ab'.repeat(32))
    const { user } = await storage.findOrInsertUser(`02${'11'.repeat(32)}`)

    const parent = new Transaction()
    parent.addOutput({ satoshis: 500, lockingScript: Script.fromHex('51') })
    const parentProof = new MerklePath(800000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]])
    const recipient = new Transaction()
    recipient.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script() })
    recipient.addOutput({ satoshis: 500, lockingScript: Script.fromHex('51') })
    const txid = recipient.id('hex')
    const recipientProof = new MerklePath(800001, [[{ offset: 0, hash: txid, txid: true }]])
    const merkleRoot = recipientProof.computeRoot(txid)
    const header = toBinaryBaseBlockHeader({
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot,
      time: 1,
      bits: 0,
      nonce: 0
    })
    const now = new Date()
    const provenTxId = await storage.insertProvenTx({
      created_at: now,
      updated_at: now,
      provenTxId: 0,
      txid,
      height: 800001,
      index: 0,
      merklePath: recipientProof.toBinary(),
      rawTx: recipient.toBinary(),
      blockHash: blockHash(header),
      merkleRoot
    })
    const incoming = new Beef()
    incoming.mergeBump(parentProof)
    incoming.mergeTransaction(parent)
    incoming.mergeTransaction(recipient)
    expect(incoming.findBump(txid)).toBeUndefined()
    const getProvenOrReq = jest.spyOn(storage, 'getProvenOrReq')
    const getHeaderForHeight = jest.fn(async () => {
      throw new Error('The existing proof must not require another header lookup')
    })
    const postBeef = jest.fn(async () => {
      throw new Error('A proven recipient transaction must not be broadcast')
    })
    storage.setServices({
      getChainTracker: async () => ({ isValidRootForHeight: async () => true }),
      getHeaderForHeight,
      postBeef
    } as unknown as WalletServices)

    await storage.internalizeAction(
      { userId: user.userId, identityKey: user.identityKey },
      {
        tx: incoming.toBinaryAtomic(txid),
        description: 'Recipient proof already in storage',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'stored-proof-recipient' }
          }
        ]
      }
    )

    expect(getProvenOrReq).toHaveBeenCalledTimes(1)
    const resolved = await getProvenOrReq.mock.results[0].value
    expect(resolved.proven?.provenTxId).toBe(provenTxId)
    expect(getHeaderForHeight).not.toHaveBeenCalled()
    expect(postBeef).not.toHaveBeenCalled()
    const outputs = await storage.findOutputs({ partial: { txid, userId: user.userId } })
    expect(outputs).toEqual([expect.objectContaining({ vout: 0, satoshis: 500, spendable: true })])
    const baskets = await storage.findOutputBaskets({ partial: { userId: user.userId } })
    const basket = baskets.find(value => value.name === 'stored-proof-recipient')
    expect(basket).toBeDefined()
    expect(outputs[0].basketId).toBe(basket?.basketId)
    expect(await storage.findProvenTxReqs({ partial: { txid } })).toEqual([])
  } finally {
    await storage.destroy()
    await deleteDB(storage.dbName)
  }
}, 20000)
