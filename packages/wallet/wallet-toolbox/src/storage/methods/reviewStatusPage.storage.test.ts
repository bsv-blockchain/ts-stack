import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { Script, Transaction } from '@bsv/sdk'
import { StorageKnex } from '../StorageKnex'
import { reviewStatusPage } from './reviewStatus'

const args = { agedLimit: new Date(0) }

test('bounded SQL selects real repairs and skips settled terminal transactions on replay', async () => {
  const stores = await _tu.createTestStorages({ databasePrefix: 'monitorStatus', migrationName: 'review-status' })
  try {
    for (const storage of stores) {
      if (!(storage instanceof StorageKnex)) continue
      if (!(await storage.supportsPrimaryWriteFences())) {
        await expect(storage.reviewStatusPage(args, 0)).resolves.toBeUndefined()
        continue
      }
      const user = await _tu.insertTestUser(storage)
      const { tx: source } = await _tu.insertTestTransaction(storage, user, false, { status: 'completed' })
      const { tx: failed } = await _tu.insertTestTransaction(storage, user, false, { status: 'failed' })
      const input = await _tu.insertTestOutput(storage, source, 0, 100, undefined, true, {
        spentBy: failed.transactionId,
        spendable: false
      })
      const failedOutput = await _tu.insertTestOutput(storage, failed, 0, 90)
      const repairs = await Promise.all(
        (['invalid', 'doubleSpend', 'unmined'] as const).map(async status => {
          const { tx } = await _tu.insertTestTransaction(storage, user, false, { status: 'sending' })
          const req = await _tu.insertTestProvenTxReq(storage, tx.txid)
          await storage.updateProvenTxReqDynamics(req.provenTxReqId, { status })
          return { tx, status }
        })
      )
      const { tx: unlinked } = await _tu.insertTestTransaction(storage, user, false, { status: 'unproven' })
      const proof = await _tu.insertTestProvenTx(storage, unlinked.txid)

      const conflict = new Transaction()
      conflict.addInput({
        sourceTXID: source.txid!,
        sourceOutputIndex: 1,
        unlockingScript: Script.fromHex('')
      })
      conflict.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
      const { tx: terminal } = await _tu.insertTestTransaction(storage, user, false, {
        status: 'failed',
        txid: conflict.id('hex')
      })
      const unrelatedFlag = await _tu.insertTestOutput(storage, source, 1, 3, undefined, true, { txid: source.txid })
      const stalled = await _tu.insertTestProvenTxReq(storage, terminal.txid)
      await storage
        .knex('proven_tx_reqs')
        .where({ provenTxReqId: stalled.provenTxReqId })
        .update({
          rawTx: Buffer.from(conflict.toBinary()),
          status: 'invalid',
          history: JSON.stringify({
            notes: [
              {
                when: new Date().toISOString(),
                what: 'markStaleInputsAsSpent',
                outpoints: `${source.txid}.1`
              }
            ]
          })
        })

      const page = await storage.reviewStatusPage(args, 0)
      expect(page).toMatchObject({ complete: true, failed: 0, examined: 7 })
      for (const { tx, status } of repairs)
        expect((await storage.findTransactionById(tx.transactionId))?.status).toBe(
          status === 'unmined' ? 'unproven' : 'failed'
        )
      expect(await storage.findOutputById(input.outputId)).toMatchObject({ spendable: true })
      expect(await storage.findOutputById(failedOutput.outputId)).toMatchObject({ spendable: false })
      expect(await storage.findOutputById(unrelatedFlag.outputId)).toMatchObject({ spendable: false })
      expect(await storage.findTransactionById(unlinked.transactionId)).toMatchObject({
        status: 'completed',
        provenTxId: proof.provenTxId
      })
      const writer = jest.spyOn(storage, 'activeWriteTransaction')
      try {
        expect(await storage.reviewStatusPage(args, 0)).toMatchObject({ complete: true, failed: 0 })
        expect(writer).not.toHaveBeenCalled()
      } finally {
        writer.mockRestore()
      }
    }
  } finally {
    await Promise.all(stores.map(storage => storage.destroy()))
  }
})

test('an orphaned physical row advances the keyset instead of ending the pass', async () => {
  const storage = (await _tu.createFreshSQLiteStorage({
    databasePrefix: 'reviewOrphan',
    migrationName: 'review-status'
  })) as StorageKnex
  try {
    const { tx: orphan } = await _tu.insertTestTransaction(storage)
    const { tx: following } = await _tu.insertTestTransaction(storage)
    await storage.knex.raw('PRAGMA foreign_keys = OFF')
    try {
      await storage.knex('transactions').where({ transactionId: orphan.transactionId }).update({ userId: 2147483647 })
    } finally {
      await storage.knex.raw('PRAGMA foreign_keys = ON')
    }
    const first = await reviewStatusPage(storage, { ...args, pageSize: 1 }, 0)
    expect(first).toMatchObject({ examined: 1, after: orphan.transactionId, complete: false })
    const next = await reviewStatusPage(storage, { ...args, pageSize: 1 }, first.after)
    expect(next).toMatchObject({ examined: 1, after: following.transactionId, complete: false })
  } finally {
    await storage.destroy()
  }
})

test('a legacy checkpoint survives log retention once migrated and its updates replace one row', async () => {
  const storage = (await _tu.createFreshSQLiteStorage({
    databasePrefix: 'monitorCheckpoint',
    migrationName: 'monitor-checkpoint'
  })) as StorageKnex
  try {
    const now = new Date()
    const name = 'ArcadeSSECursor.fixture'
    await storage.insertMonitorEvent({ id: 0, event: name, details: '"old"', created_at: now, updated_at: now })
    expect(await storage.loadMonitorCheckpoint(name)).toEqual(['"old"'])
    await storage.saveMonitorCheckpoint(name, '"41"')
    await storage.saveMonitorCheckpoint(name, '"42"')
    await storage.knex('monitor_events').where({ event: name }).delete()
    expect(await storage.loadMonitorCheckpoint(name)).toEqual(['"42"'])
    expect(await storage.knex('monitor_checkpoints')).toHaveLength(1)
  } finally {
    await storage.destroy()
  }
})
