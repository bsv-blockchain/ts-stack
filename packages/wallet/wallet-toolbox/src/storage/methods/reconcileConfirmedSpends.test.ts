import { MerklePath, Script, Transaction } from '@bsv/sdk'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { StorageKnex } from '../StorageKnex'
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

test('proven spend repair covers replicas, survives replay and reverses only untouched state after a reorg', async () => {
  const storage = (await _tu.createFreshSQLiteStorage({
    migrationName: 'confirmed-spend',
    databasePrefix: 'confirmedSpend'
  })) as StorageKnex
  try {
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

    const outputs = []
    const data = []
    for (const passive of [false, true]) {
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
    expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({ repaired: 2, unavailable: 0 })
    expect(await reviewConfirmedSpendPage(storage, 0, 120)).toMatchObject({ repaired: 0 })
    for (const r of data) expect((await storage.findOutputById(r.outputId))?.spendable).toBe(true)
    expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 0 })
    active = false
    expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 0 })
    await storage.updateOutput(outputs[1].outputId, {
      updated_at: new Date(Date.now() + 1000),
      outputDescription: 'newer wallet edit'
    })
    isUnspent = true
    expect(await reviewConfirmedSpendRecoveries(storage, 0)).toMatchObject({ restored: 1, unavailable: 0 })
    expect((await storage.findOutputById(outputs[0].outputId))?.spendable).toBe(true)
    expect((await storage.findOutputById(outputs[1].outputId))?.spendable).toBe(false)
  } finally {
    await storage.destroy()
  }
})
