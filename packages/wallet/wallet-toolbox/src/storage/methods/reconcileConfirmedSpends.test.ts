import { MerklePath, Script, Transaction } from '@bsv/sdk'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { StorageKnex } from '../StorageKnex'
import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import {
  reconcileConfirmedSpender,
  reviewConfirmedSpendPage,
  reviewConfirmedSpendRecoveries
} from './reconcileConfirmedSpends'

function makeProof(tx: Transaction, height: number) {
  const txid = tx.id('hex')
  const path = new MerklePath(height, [[{ offset: 0, txid: true, hash: txid }]])
  const merkleRoot = path.computeRoot(txid)
  const header = toBinaryBaseBlockHeader({
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot,
    time: 1,
    bits: 0,
    nonce: 0
  })
  const now = new Date()
  return {
    header,
    proof: {
      provenTxId: 0,
      created_at: now,
      updated_at: now,
      txid,
      height,
      index: 0,
      merkleRoot,
      blockHash: asString(doubleSha256BE(header as number[])),
      rawTx: tx.toBinary(),
      merklePath: path.toBinary()
    }
  }
}

test('confirmed-spend recovery is fenced and preserves later edits, data outputs and passive copies', async () => {
  const stores = await _tu.createTestStorages({
    migrationName: 'confirmed-spend',
    databasePrefix: 'confirmedSpend'
  })
  try {
    for (const storage of stores) {
      if (!(storage instanceof StorageKnex) || !(await storage.supportsPrimaryWriteFences())) continue
      const parent = new Transaction()
      parent.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('51') })
      parent.addOutput({ satoshis: 0, lockingScript: Script.fromHex('006a') })
      const funding = makeProof(parent, 10)
      funding.proof.provenTxId = await storage.insertProvenTx(funding.proof)

      const spend = new Transaction()
      spend.addInput({
        sourceTXID: funding.proof.txid,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromHex('')
      })
      spend.addOutput({ satoshis: 999, lockingScript: Script.fromHex('51') })
      const spender = makeProof(spend, 20)
      spender.proof.provenTxId = await storage.insertProvenTx(spender.proof)
      const replacement = makeProof(parent, 20)
      let active = false
      let isUnspent = false
      storage.setServices({
        getHeaderForHeight: async (height: number) =>
          height === 10 ? funding.header : active ? spender.header : replacement.header,
        getChainTracker: async () => ({
          isValidRootForHeight: async (root: string, height: number) =>
            height === 10 ? root === funding.proof.merkleRoot : active && root === spender.proof.merkleRoot
        }),
        hashOutputScript: () => '00'.repeat(32),
        getUtxoStatus: async () => ({
          name: 'fixture',
          status: 'success',
          isUtxo: isUnspent,
          details: isUnspent ? [{ txid: funding.proof.txid, index: 0, satoshis: 1000, height: 10 }] : []
        })
      } as unknown as WalletServices)

      const findProof = storage.findProvenTxById.bind(storage)
      jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate', 'setInterval', 'setTimeout'] })
      const elapsed = jest.spyOn(storage, 'findProvenTxById').mockImplementationOnce(async (...parameters) => {
        const value = await findProof(...parameters)
        jest.advanceTimersByTime(1501)
        return value
      })
      try {
        expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({
          examined: 1,
          after: funding.proof.provenTxId,
          repaired: 0
        })
      } finally {
        elapsed.mockRestore()
        jest.useRealTimers()
      }

      const outputs = []
      const data = []
      let passiveBefore: Date | undefined
      for (const passive of [false, true, false]) {
        const user = await _tu.insertTestUser(storage)
        if (passive) await storage.updateUser(user.userId, { activeStorage: '34'.repeat(32) })
        const { tx } = await _tu.insertTestTransaction(storage, user, false, {
          status: 'completed',
          txid: funding.proof.txid,
          provenTxId: funding.proof.provenTxId
        })
        const basket = await storage.findOrInsertOutputBasket(user.userId, 'fixture')
        for (const vout of [0, 1]) {
          const output = await _tu.insertTestOutput(storage, tx, vout, vout === 0 ? 1000 : 0, basket, true, {
            txid: funding.proof.txid,
            lockingScript: vout === 0 ? [0x51] : [0, 0x6a]
          })
          if (passive && vout === 0) passiveBefore = output.updated_at
          ;(vout === 0 ? outputs : data).push({
            outputId: output.outputId,
            userId: user.userId,
            txid: funding.proof.txid,
            vout
          })
        }
      }
      expect(await reviewConfirmedSpendPage(storage, 0, 119)).toMatchObject({ repaired: 0 })
      expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({ repaired: 0, unavailable: 1 })
      active = true
      await expect(reconcileConfirmedSpender(storage, spender.proof, data, 120)).rejects.toThrow('does not consume')
      const handoff = async <T>(operation: () => Promise<T>): Promise<T> => {
        await storage.updateUser(outputs[0].userId, { activeStorage: '34'.repeat(32) })
        return await operation()
      }
      expect(await reconcileConfirmedSpender(storage, spender.proof, [outputs[0]], 120, handoff)).toBe(0)
      expect((await storage.findOutputById(outputs[0].outputId))?.spendable).toBe(true)
      await storage.updateUser(outputs[0].userId, { activeStorage: storage.getSettings().storageIdentityKey })
      expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({ repaired: 2, unavailable: 0 })
      expect((await storage.findOutputById(outputs[1].outputId))?.spendable).toBe(true)
      expect((await storage.findOutputById(outputs[1].outputId))?.updated_at).toEqual(passiveBefore)
      const original = await storage.knex('monitor_confirmed_spends').where({ outputId: outputs[0].outputId }).first()
      expect(JSON.parse(original.details).observedUpdatedAt).toBe(
        (await storage.findOutputById(outputs[0].outputId))?.updated_at.toISOString()
      )
      const now = new Date()
      await storage.insertMonitorEvent({
        id: 0,
        event: 'ConfirmedOutputSpend',
        details: original.details,
        created_at: now,
        updated_at: now
      })
      await storage.knex('monitor_confirmed_spends').where({ outputId: outputs[0].outputId }).delete()
      expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({ repaired: 0 })
      // Advance the independent target keyset even when the whole first batch
      // loses writer admission. The last target must still be examined now.
      for (let i = 0; i < 25; i++) {
        const user = await _tu.insertTestUser(storage)
        const { tx } = await _tu.insertTestTransaction(storage, user, false, {
          status: 'completed',
          txid: funding.proof.txid,
          provenTxId: funding.proof.provenTxId
        })
        const basket = await storage.findOrInsertOutputBasket(user.userId, 'fixture')
        await _tu.insertTestOutput(storage, tx, 0, 1000, basket, true, {
          txid: funding.proof.txid,
          lockingScript: [0x51]
        })
      }
      const revoked = () => Promise.reject(new WERR_NOT_ACTIVE())
      const first = await reviewConfirmedSpendPage(storage, 0, 120, revoked)
      expect(first).toMatchObject({ repaired: 0, partial: { proofId: spender.proof.provenTxId } })
      const next = await reviewConfirmedSpendPage(storage, first.after, 120, undefined, first.partial)
      expect(next).toMatchObject({ repaired: 1 })
      // Leave the paging fixture out of the subsequent recovery count.
      await storage.knex('monitor_confirmed_spends').where('outputId', '>', outputs[2].outputId).delete()
      for (const r of data) expect((await storage.findOutputById(r.outputId))?.spendable).toBe(true)
      expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 0 })
      active = false
      expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 0 })
      await storage.updateOutput(outputs[2].outputId, {
        updated_at: new Date(Date.now() + 1000),
        outputDescription: 'newer wallet edit'
      })
      isUnspent = true
      expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 1, unavailable: 0 })
      expect((await storage.findOutputById(outputs[0].outputId))?.spendable).toBe(true)
      expect((await storage.findOutputById(outputs[2].outputId))?.spendable).toBe(false)
      expect(await storage.knex('monitor_confirmed_spends')).toHaveLength(0)
    }
  } finally {
    await Promise.all(stores.map(storage => storage.destroy()))
  }
})
