import { TaskCleanupActionBatches } from '../../monitor/tasks/TaskCleanupActionBatches'
import { reviewUtxoOutputs } from '../methods/reviewUtxoOutputs'
import { TaskReviewUtxos } from '../../monitor/tasks/TaskReviewUtxos'
import { TaskReviewDoubleSpends } from '../../monitor/tasks/TaskReviewDoubleSpends'
import { specOpSetWalletChangeParams } from '../../sdk/types'
import { TaskFailAbandoned } from '../../monitor/tasks/TaskFailAbandoned'
import { cleanupExpiredActionBatches } from '../methods/actionBatch'
import { captureMonitorReqWrite } from '../../monitor/tasks/WalletMonitorTask'
import { TaskReconcilePendingTransactions } from '../../monitor/tasks/TaskReconcilePendingTransactions'
import { applyCapturedTerminalFailure } from '../methods/reconcileFailedTransactionInputs'
import { getProofs, TaskCheckForProofs } from '../../monitor/tasks/TaskCheckForProofs'
import { TaskSendWaiting } from '../../monitor/tasks/TaskSendWaiting'
import { TaskUnFail } from '../../monitor/tasks/TaskUnFail'
import { markConfirmedStaleReqInputs } from '../methods/reconcileFailedTransactionInputs'
import { StorageReqWrite } from '../StorageReqWrite'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Validation } from '@bsv/sdk'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { snapshotSyncPrimaryChangeSqlite } from '../schema/snapshotSyncMigration'
import type { TableCertificateX } from '../schema/tables/TableCertificate'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'

const identityKey = '02' + '11'.repeat(32)
const storageIdentity = 'active-write-source'
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-active-writer-'))
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(config) })
  const peer = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(config) })
  const close = async () => {
    const results = await Promise.allSettled([storage.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Actual writer fixture failed to drain')
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode=WAL')
    await storage.knex.raw('PRAGMA busy_timeout=0')
    await storage.migrate('actual writer fixture', storageIdentity)
    await storage.makeAvailable()
    await peer.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    const basket = (await storage.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } }))[0]
    return { storage, peer, user, basket, auth: { identityKey, userId: user.userId }, close }
  } catch (error) {
    await close()
    throw error
  }
}

afterEach(() => jest.restoreAllMocks())

test('an actual SQL role capture retains no transaction during preparation and fences away-and-back', async () => {
  const f = await fixture()
  try {
    let begins = 0
    f.storage.knex.on('query', query => {
      if (/^begin\b/i.test(query.sql)) begins++
    })
    const old = await f.storage.activeWriteTransaction(f.auth)
    expect(begins).toBe(0)
    // A separate actual controller can complete its role changes before the
    // old operation reaches its SQL writer. No held connection blocks it.
    await f.peer.updateUser(f.user.userId, { activeStorage: 'other' })
    await f.peer.updateUser(f.user.userId, { activeStorage: storageIdentity })
    const apply = jest.fn(async () => {})
    await expect(old.transaction(apply)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(apply).not.toHaveBeenCalled()
    const current = await f.storage.activeWriteTransaction(f.auth)
    await current.transaction(
      async trx => await f.storage.updateOutputBasket(f.basket.basketId, { numberOfDesiredUTXOs: 7 }, trx)
    )
    expect(
      (await f.storage.findOutputBaskets({ partial: { basketId: f.basket.basketId } }))[0].numberOfDesiredUTXOs
    ).toBe(7)
    expect(begins).toBe(2) // One rejected writer and one successful writer.
  } finally {
    await f.close()
  }
})

test.each([false, true])('a role change within the actual writer rolls back every effect, ABA=%s', async aba => {
  const f = await fixture()
  try {
    const write = await f.storage.activeWriteTransaction(f.auth)
    await expect(
      write.transaction(async trx => {
        await f.storage.updateOutputBasket(f.basket.basketId, { numberOfDesiredUTXOs: 13 }, trx)
        await f.storage.updateUser(f.user.userId, { activeStorage: 'away' }, trx)
        if (aba) await f.storage.updateUser(f.user.userId, { activeStorage: storageIdentity }, trx)
      })
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(
      (await f.storage.findOutputBaskets({ partial: { basketId: f.basket.basketId } }))[0].numberOfDesiredUTXOs
    ).toBe(f.basket.numberOfDesiredUTXOs)
    expect((await f.storage.findUsers({ partial: { userId: f.user.userId } }))[0].activeStorage).toBe(storageIdentity)
    expect(await f.storage.knex('snapshot_sync_primary_epochs')).toEqual([])
  } finally {
    await f.close()
  }
})

test('only a live transaction issued by the same captured operation can be nested', async () => {
  const f = await fixture()
  try {
    const write = await f.storage.activeWriteTransaction(f.auth)
    let escaped: TrxToken | undefined
    await write.transaction(async trx => {
      escaped = trx
      await write.transaction(async nested => {
        expect(nested).toBe(trx)
        await f.storage.updateOutputBasket(f.basket.basketId, { numberOfDesiredUTXOs: 9 }, nested)
      }, trx)
    })
    await expect(write.transaction(async () => {}, escaped)).rejects.toMatchObject({ code: 'WERR_INVALID_OPERATION' })
    await expect(write.transaction(async () => {}, {})).rejects.toMatchObject({ code: 'WERR_INVALID_OPERATION' })
    await f.peer.transaction(async foreign => {
      await expect(write.transaction(async () => {}, foreign)).rejects.toMatchObject({ code: 'WERR_INVALID_OPERATION' })
    })
  } finally {
    await f.close()
  }
})

test('claimed active state or another user ID cannot grant a primary writer and other profiles stay independent', async () => {
  const f = await fixture()
  try {
    const other = (await f.storage.findOrInsertUser('03' + '22'.repeat(32))).user
    await expect(
      f.storage.activeWriteTransaction({ ...f.auth, userId: other.userId, isActive: true })
    ).rejects.toMatchObject({ code: 'WERR_UNAUTHORIZED' })
    const write = await f.storage.activeWriteTransaction(f.auth)
    await f.peer.updateUser(other.userId, { activeStorage: 'away' })
    await expect(write.assertCurrent()).resolves.toBeUndefined()
    await f.peer.updateUser(f.user.userId, { activeStorage: 'away' })
    await expect(f.storage.activeWriteTransaction({ ...f.auth, isActive: true })).rejects.toMatchObject({
      code: 'WERR_NOT_ACTIVE'
    })
  } finally {
    await f.close()
  }
})

test('a missing or changed actual epoch trigger rejects old and newly captured operations', async () => {
  const f = await fixture()
  try {
    const write = await f.storage.activeWriteTransaction(f.auth)
    await f.peer.knex.raw('DROP TRIGGER snapshot_sync_primary_change')
    await expect(write.transaction(async () => {})).rejects.toThrow('primary fence')
    await expect(f.storage.activeWriteTransaction(f.auth)).rejects.toThrow('primary fence')
    await f.peer.knex.raw('CREATE TRIGGER snapshot_sync_primary_change AFTER UPDATE ON users BEGIN SELECT 1; END')
    await expect(write.transaction(async () => {})).rejects.toThrow('primary fence')
    await f.peer.knex.raw('DROP TRIGGER snapshot_sync_primary_change')
    await f.peer.knex.raw(snapshotSyncPrimaryChangeSqlite)
    await expect(write.transaction(async () => {})).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

test('actual certificate relinquishment rejects a role change after its asynchronous lookup', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<number> | undefined
  try {
    const certificate: TableCertificateX = {
      certificateId: 0,
      userId: f.user.userId,
      created_at: new Date(),
      updated_at: new Date(),
      type: Buffer.alloc(32, 1).toString('base64'),
      serialNumber: Buffer.alloc(32, 2).toString('base64'),
      certifier: '03' + '33'.repeat(32),
      subject: identityKey,
      revocationOutpoint: '44'.repeat(32) + '.0',
      signature: '00',
      isDeleted: false
    }
    const id = await f.storage.insertCertificateAuth(f.auth, certificate)
    const read = f.storage.findCertificates.bind(f.storage)
    jest.spyOn(f.storage, 'findCertificates').mockImplementationOnce(async args => {
      const result = await read(args)
      entered()
      await gate
      return result
    })
    pending = f.storage.relinquishCertificate(f.auth, certificate)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    await f.peer.updateUser(f.user.userId, { activeStorage: 'other-primary' })
    release()
    await rejected
    expect((await read({ partial: { certificateId: id } }))[0].isDeleted).toBe(false)
  } finally {
    release()
    await pending?.catch(() => undefined)
    await f.close()
  }
})

test('the real createAction rejects preparation from an obsolete ABA generation before claiming financial rows', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-createAction-ABA', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<unknown> | undefined
  try {
    const before = await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()
    const read = ctx.activeStorage.findOutputBaskets.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputBaskets').mockImplementationOnce(async args => {
      const result = await read(args)
      entered()
      await gate
      return result
    })
    const args = Validation.validateCreateActionArgs({
      description: 'actual primary fence regression',
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'fenced output' }],
      options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: true }
    })
    pending = ctx.activeStorage.createAction({ identityKey: ctx.identityKey, userId: ctx.userId }, args)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    const active = ctx.activeStorage.getSettings().storageIdentityKey
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'other-primary' })
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: active })
    release()
    await rejected
    expect(await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()).toEqual(before)
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('the real internalizeAction rejects an ABA generation after proof preparation and before publishing ownership', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-internalize-ABA', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<unknown> | undefined
  try {
    const created = await ctx.wallet.createAction({
      description: 'stage actual role fence input',
      outputs: [
        { satoshis: 741, lockingScript: '51', basket: 'original-role-basket', outputDescription: 'original ownership' }
      ],
      options: { noSend: true, randomizeOutputs: false }
    })
    expect(created.tx).toBeDefined()
    jest.spyOn(ctx.services, 'getChainTracker').mockImplementationOnce(async () => {
      entered()
      await gate
      return { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }
    })
    pending = ctx.activeStorage.internalizeAction(
      { identityKey: ctx.identityKey, userId: ctx.userId },
      {
        tx: created.tx!,
        description: 'reconcile same-basket ownership',
        labels: ['stale-role-label'],
        outputs: [
          { outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'original-role-basket' } }
        ]
      }
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    const active = ctx.activeStorage.getSettings().storageIdentityKey
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'other-primary' })
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: active })
    release()
    await rejected
    expect(
      await ctx.activeStorage.findTxLabels({ partial: { userId: ctx.userId, label: 'stale-role-label' } })
    ).toEqual([])
    expect(
      await ctx.activeStorage.knex('internalize_receipts').where({ userId: ctx.userId, state: 'pending' })
    ).toEqual([])
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('provider destruction rejects captured writers before trying to acquire a closed connection', async () => {
  const f = await fixture()
  try {
    const write = await f.storage.activeWriteTransaction(f.auth)
    await f.storage.destroy()
    await expect(write.transaction(async () => {})).rejects.toMatchObject({ code: 'WERR_INVALID_OPERATION' })
    await expect(write.assertCurrent()).rejects.toMatchObject({ code: 'WERR_INVALID_OPERATION' })
  } finally {
    await f.close()
  }
})

test('an old abort cannot invalidate a signed action after its network observation crosses an ABA role change', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-abort-ABA', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<unknown> | undefined
  try {
    const created = await ctx.wallet.createAction({
      description: 'stage an actual abort race',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'protected during handoff' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid === undefined) throw new Error('The actual signed transaction must expose its txid')
    const before = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid: created.txid }
    })
    const reference = before[0].reference
    jest.spyOn(ctx.services, 'getStatusForTxids').mockImplementationOnce(async txids => {
      entered()
      await gate
      return {
        name: 'controlled-role-race',
        status: 'success' as const,
        results: txids.map(txid => ({ txid, status: 'unknown' as const, depth: undefined }))
      }
    })
    pending = ctx.activeStorage.abortAction(
      { userId: ctx.userId, identityKey: ctx.identityKey },
      { reference: reference }
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    const active = ctx.activeStorage.getSettings().storageIdentityKey
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'other-primary' })
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: active })
    release()
    await rejected
    expect(await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, reference: reference } })).toEqual(
      before
    )
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('an old batch begin cannot reserve outputs after asynchronous preparation crosses an ABA role change', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-batch-begin-ABA')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<unknown> | undefined
  try {
    const read = ctx.activeStorage.findOutputBaskets.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputBaskets').mockImplementationOnce(async args => {
      const result = await read(args)
      entered()
      await gate
      return result
    })
    pending = ctx.activeStorage.beginActionBatch(
      { userId: ctx.userId, identityKey: ctx.identityKey },
      {
        batchId: 'stale-batch-begin',
        firstAction: Validation.validateCreateActionArgs({
          description: 'actual batch role race',
          outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'batch reservation' }],
          options: { noSend: true }
        })
      }
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    const active = ctx.activeStorage.getSettings().storageIdentityKey
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'other-primary' })
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: active })
    release()
    await rejected
    expect(await ctx.activeStorage.findActionBatch(ctx.userId, 'stale-batch-begin')).toBeUndefined()
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test.each(['renew', 'resume', 'extend', 'abort'] as const)(
  'an old batch %s keeps its captured role through admission and cannot mutate later-generation state',
  async operation => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy(`active-write-batch-${operation}-ABA`)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const reached = new Promise<void>(resolve => {
      entered = resolve
    })
    let pending: Promise<unknown> | undefined
    try {
      const auth = { userId: ctx.userId, identityKey: ctx.identityKey }
      const begun = await ctx.activeStorage.beginActionBatch(auth, {
        batchId: 'actual-batch-role',
        firstAction: Validation.validateCreateActionArgs({
          description: 'reserve an actual batch',
          outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'actual reservation' }],
          options: { noSend: true }
        })
      })
      const before = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
      const capture = ctx.activeStorage.activeWriteTransaction.bind(ctx.activeStorage)
      jest.spyOn(ctx.activeStorage, 'activeWriteTransaction').mockImplementationOnce(async args => {
        const write = await capture(args)
        entered()
        await gate
        return write
      })
      if (operation === 'renew') pending = ctx.activeStorage.renewActionBatch(auth, begun.batchId)
      else if (operation === 'resume')
        pending = ctx.activeStorage.resumeActionBatch(auth, {
          batchId: begun.batchId,
          outpoints: [...begun.reservedOutputs, ...begun.explicitOutputs].map(output => ({
            txid: output.txid!,
            vout: output.vout
          }))
        })
      else if (operation === 'extend')
        pending = ctx.activeStorage.extendActionBatch(auth, {
          batchId: begun.batchId,
          targetSatoshis: 0,
          requestedOutputs: 0,
          explicitOutpoints: [],
          includeSourceTransactions: false
        })
      else pending = ctx.activeStorage.abortActionBatch(auth, begun.batchId)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
      await reached
      const active = ctx.activeStorage.getSettings().storageIdentityKey
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'other-primary' })
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: active })
      release()
      await rejected
      expect(await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)).toEqual(before)
    } finally {
      release()
      await pending?.catch(() => undefined)
      await ctx.wallet.destroy()
    }
  }
)

async function sharedRequestFixture(name: string) {
  const ctx = await _tu.createLegacyWalletSQLiteCopy(name, 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    _tu.mockPostServicesAsSuccess([ctx])
    const created = await ctx.wallet.createAction({
      description: 'real shared request role capture',
      outputs: [{ satoshis: 741, lockingScript: '51', basket: 'shared-original', outputDescription: 'shared output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null || created.tx == null) throw new Error('Missing actual signed action')
    const { user: second } = await ctx.activeStorage.findOrInsertUser('02' + '22'.repeat(32))
    await ctx.activeStorage.internalizeAction(second, {
      tx: created.tx,
      description: 'genuine second profile copy',
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'shared-second' } }]
    })
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual shared request')
    const rows = await ctx.activeStorage.findTransactions({ partial: { txid: created.txid }, noRawTx: true })
    expect(rows.map(row => row.userId).sort()).toEqual([ctx.userId, second.userId].sort())
    return { ctx, req, second, rows }
  } catch (error) {
    await ctx.wallet.destroy()
    throw error
  }
}

test('shared request profiles retain independent original epochs and never borrow an active peer', async () => {
  const { ctx, req, second } = await sharedRequestFixture('shared-request-profile-epochs')
  try {
    const storage = ctx.activeStorage
    const { user: stranger } = await storage.findOrInsertUser('03' + '44'.repeat(32))
    const unrelated = await StorageReqWrite.capture(storage, [req.txid], {
      userId: stranger.userId,
      write: await storage.activeWriteTransaction(stranger)
    })
    expect(() => unrelated.assertRequests([req])).toThrow('does not belong')
    await expect(
      unrelated.request(req, async current => {
        current.addHistoryNote({ what: 'unrelated-profile-must-not-write' })
      })
    ).rejects.toMatchObject({ code: 'WERR_UNAUTHORIZED' })
    const old = await StorageReqWrite.capture(storage, [req.txid])
    const actor = await storage.activeWriteTransaction({ identityKey: ctx.identityKey, userId: ctx.userId })
    const authenticated = await StorageReqWrite.capture(storage, [req.txid], { userId: ctx.userId, write: actor })
    const identity = storage.getSettings().storageIdentityKey
    await storage.updateUser(ctx.userId, { activeStorage: 'away' })
    await storage.updateUser(ctx.userId, { activeStorage: identity })
    const applied = jest.fn(async () => {})
    expect(await old.forUser(ctx.userId, applied)).toBe(false)
    expect(applied).not.toHaveBeenCalled()
    expect(await old.forUser(second.userId, applied)).toBe(true)
    expect(applied).toHaveBeenCalledTimes(1)
    await expect(
      authenticated.request(req, async current => {
        current.addHistoryNote({ what: 'must-not-borrow-second-profile' })
      })
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(
      await old.request(req, async current => {
        current.addHistoryNote({ what: 'still-current-monitor-peer' })
      })
    ).toBe(true)
    const stored = await EntityProvenTxReq.fromStorageId(storage, req.id)
    expect(stored.history.notes?.some(note => note.what === 'must-not-borrow-second-profile')).toBe(false)
    expect(stored.history.notes?.some(note => note.what === 'still-current-monitor-peer')).toBe(true)
  } finally {
    await ctx.wallet.destroy()
  }
})

test('shared request result commits preserve late durable notification history and ignore forged notify IDs', async () => {
  const { ctx, req, second, rows } = await sharedRequestFixture('shared-request-late-notify')
  try {
    const storage = ctx.activeStorage
    const writes = await StorageReqWrite.capture(storage, [req.txid])
    const stale = new EntityProvenTxReq(req.toApi())
    const durable = await EntityProvenTxReq.fromStorageId(storage, req.id)
    durable.addNotifyTransactionId(rows.find(row => row.userId === second.userId)!.transactionId)
    durable.addHistoryNote({ what: 'arrived-during-network' })
    await durable.updateStorageDynamicProperties(storage)
    await writes.request(stale, async current => {
      current.addHistoryNote({ what: 'network-returned' })
    })
    const stored = await EntityProvenTxReq.fromStorageId(storage, req.id)
    expect(stored.notify.transactionIds).toEqual(expect.arrayContaining(rows.map(row => row.transactionId)))
    expect(stored.history.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ what: 'arrived-during-network' }),
        expect.objectContaining({ what: 'network-returned' })
      ])
    )
    // A different real transaction's ID in comparison DATA cannot enroll its
    // profile or mutate that unrelated financial row.
    const unrelated = (await storage.findTransactions({ partial: { userId: ctx.userId }, noRawTx: true })).find(
      row => row.txid !== req.txid
    )!
    expect(unrelated).toBeDefined()
    stale.addNotifyTransactionId(unrelated.transactionId)
    const update = jest.spyOn(storage, 'updateTransactionStatus')
    await writes.request(stale, async current => {
      current.status = 'unsent'
    })
    await writes.status(stale, 'sending')
    expect(update).not.toHaveBeenCalledWith(
      'sending',
      unrelated.transactionId,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    expect(update.mock.calls.map(call => call[1]).sort()).toEqual(rows.map(row => row.transactionId).sort())
    expect(
      (await storage.findTransactions({ partial: { transactionId: unrelated.transactionId }, noRawTx: true }))[0].status
    ).toBe(unrelated.status)
  } finally {
    await ctx.wallet.destroy()
  }
})

test('shared broadcast applies a real network reply only to still-current captured profiles', async () => {
  const { ctx, req, second, rows } = await sharedRequestFixture('shared-request-broadcast-ABA')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: ReturnType<StorageProvider['attemptToPostReqsToNetwork']> | undefined
  try {
    const storage = ctx.activeStorage
    const writes = await StorageReqWrite.capture(storage, [req.txid])
    await writes.request(req, async current => {
      current.status = 'unsent'
    })
    await writes.status(req, 'sending')
    jest.spyOn(ctx.services, 'postBeef').mockImplementationOnce(async (_beef, txids) => {
      entered()
      await gate
      return [
        {
          name: 'controlled-shared-reply',
          status: 'success',
          txidResults: txids.map(txid => ({ txid, status: 'success' }))
        }
      ]
    })
    pending = storage.attemptToPostReqsToNetwork([req])
    await reached
    const identity = storage.getSettings().storageIdentityKey
    // This real controller update completes through the original one-pool
    // provider while transport is pending: no SQL writer spans the network.
    await storage.updateUser(ctx.userId, { activeStorage: 'away' })
    await storage.updateUser(ctx.userId, { activeStorage: identity })
    const late = await EntityProvenTxReq.fromStorageId(storage, req.id)
    late.addHistoryNote({ what: 'late-network-observer' })
    await late.updateStorageDynamicProperties(storage)
    release()
    const result = await pending
    expect(result.details[0].status).toBe('success')
    const current = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
    expect(current.find(row => row.userId === ctx.userId)?.status).toBe('sending')
    expect(current.find(row => row.userId === second.userId)?.status).toBe('unproven')
    expect((await EntityProvenTxReq.fromStorageId(storage, req.id)).history.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'late-network-observer' })])
    )
    expect(rows).toHaveLength(2)
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('the real processAction rejects an obsolete preparation before persisting the signed transaction', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-processAction-ABA', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: ReturnType<typeof ctx.wallet.createAction> | undefined
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    jest.spyOn(ctx.services, 'nLockTimeIsFinal').mockImplementationOnce(async () => {
      entered()
      await gate
      return true
    })
    const before = await ctx.activeStorage.countProvenTxReqs({ partial: {} })
    pending = ctx.wallet.createAction({
      description: 'actual signed commit epoch race',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'fenced signature' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    await reached
    const identity = ctx.activeStorage.getSettings().storageIdentityKey
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'away' })
    await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: identity })
    release()
    await rejected
    expect(await ctx.activeStorage.countProvenTxReqs({ partial: {} })).toBe(before)
    const rows = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, description: 'actual signed commit epoch race' }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('unsigned')
    expect(rows[0].txid).toBeUndefined()
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('positive spent evidence cannot authorize an input update after an actual profile ABA', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('active-write-stale-input-ABA', 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'genuine stale input observer',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'actual input observation' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual proof request')
    let changed = false
    jest.spyOn(ctx.services, 'getUtxoStatus').mockImplementation(async () => {
      if (!changed) {
        changed = true
        const identity = ctx.activeStorage.getSettings().storageIdentityKey
        await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'away' })
        await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: identity })
      }
      return { name: 'positive-spent-observer', status: 'success', isUtxo: false, details: [] }
    })
    const update = jest.spyOn(ctx.activeStorage, 'updateOutput')
    const result = await markConfirmedStaleReqInputs(req, ctx.activeStorage, ctx.services)
    expect(changed).toBe(true)
    expect(result.checked).toBeGreaterThan(0)
    expect(result.staleConfirmed).toBe(0)
    expect(result.staleOutpoints).toEqual([])
    expect(update).not.toHaveBeenCalled()
  } finally {
    await ctx.wallet.destroy()
  }
})

test('failed-proof recovery retains each actual profile epoch across external output observation', async () => {
  const { ctx, req, second, rows } = await sharedRequestFixture('shared-proof-recovery-ABA')
  try {
    const storage = ctx.activeStorage
    const writes = await StorageReqWrite.capture(storage, [req.txid])
    await writes.request(req, async current => {
      current.status = 'invalid'
    })
    await writes.status(req, 'failed')
    const before = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
    expect(before.every(row => row.status === 'failed')).toBe(true)
    let observed = false
    jest.spyOn(ctx.services, 'getUtxoStatus').mockImplementation(async () => {
      if (!observed) {
        observed = true
        const identity = storage.getSettings().storageIdentityKey
        await storage.updateUser(ctx.userId, { activeStorage: 'away' })
        await storage.updateUser(ctx.userId, { activeStorage: identity })
      }
      return { name: 'proof-recovery-output-observer', status: 'success', isUtxo: true, details: [] }
    })
    const log = await storage.unfailTransactionsForProof(req)
    expect(observed).toBe(true)
    const current = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
    expect(current.find(row => row.userId === ctx.userId)?.status).toBe('failed')
    expect(current.find(row => row.userId === second.userId)?.status).toBe('unproven')
    expect(log).not.toContain(`transaction ${rows.find(row => row.userId === ctx.userId)!.transactionId} status is now`)
    expect(log).toContain(`transaction ${rows.find(row => row.userId === second.userId)!.transactionId} status is now`)
  } finally {
    await ctx.wallet.destroy()
  }
})

test('a rejected unfail proof cannot invalidate a newer actual primary generation', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('unfail-proof-observation-ABA', 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'real unfail observation epoch',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'unfail observation output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing actual signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual proof request')
    await ctx.activeStorage.updateProvenTxReq(req.id, { status: 'unfail' })
    await req.refreshFromStorage(ctx.activeStorage)
    jest.spyOn(ctx.monitor.services, 'getMerklePath').mockImplementationOnce(async () => {
      const identity = ctx.activeStorage.getSettings().storageIdentityKey
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'away' })
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: identity })
      return { name: 'unavailable-proof-after-ABA' }
    })
    const task = new TaskUnFail(ctx.monitor)
    expect(await task.unfail([req.toApi()])).toMatchObject({
      deferred: 1,
      log: expect.stringContaining('deferred to its current primary')
    })
    expect((await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)).status).toBe('unfail')
  } finally {
    await ctx.wallet.destroy()
  }
})

test('a rolled-back captured request never publishes uncommitted metadata to its caller', async () => {
  const { ctx, req } = await sharedRequestFixture('request-publication-after-commit')
  try {
    const storage = ctx.activeStorage
    const write = await storage.activeWriteTransaction({ identityKey: ctx.identityKey, userId: ctx.userId })
    const captured = await StorageReqWrite.capture(storage, [req.txid], { userId: ctx.userId, write })
    await expect(
      captured.request(req, async (current, trx) => {
        current.addHistoryNote({ what: 'rolled-back-observation' })
        await storage.updateUser(ctx.userId, { activeStorage: 'away' }, trx)
        await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey }, trx)
      })
    ).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(req.history.notes?.some(note => note.what === 'rolled-back-observation')).toBe(false)
    expect(
      (await EntityProvenTxReq.fromStorageId(storage, req.id)).history.notes?.some(
        note => note.what === 'rolled-back-observation'
      )
    ).toBe(false)
  } finally {
    await ctx.wallet.destroy()
  }
})

test('the proof checker cannot persist attempts or history across an obsolete actual profile epoch', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('proof-checker-metadata-ABA', 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'real proof checker observation epoch',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'proof checker output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing actual signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual request')
    await ctx.activeStorage.updateProvenTxReq(req.id, { status: 'unmined' })
    await req.refreshFromStorage(ctx.activeStorage)
    const before = { ...req.toApi() }
    jest.spyOn(ctx.monitor.services, 'getMerklePath').mockImplementationOnce(async () => {
      const identity = ctx.activeStorage.getSettings().storageIdentityKey
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: 'away' })
      await ctx.activeStorage.updateUser(ctx.userId, { activeStorage: identity })
      return { name: 'proof-checker-delayed-no-proof', notes: [{ what: 'must-not-persist-obsolete-observation' }] }
    })
    const deferred = await getProofs(
      new TaskCheckForProofs(ctx.monitor),
      [req.toApi()],
      Number.MAX_SAFE_INTEGER,
      0,
      true
    )
    expect(deferred.log).toContain('deferred to its current primary')
    expect(deferred.proven).toEqual([])
    expect(deferred.invalid).toEqual([])
    const current = await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)
    expect(current.attempts).toBe(before.attempts)
    expect(current.apiHistory).toBe(before.history)
    expect(current.status).toBe(before.status)
  } finally {
    await ctx.wallet.destroy()
  }
})

test('a slow proof observation preserves concurrent attempts, advanced state and late history', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('proof-checker-late-metadata', 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'real concurrent proof observer',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'late observation output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing actual signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual request')
    await ctx.activeStorage.updateProvenTxReq(req.id, { status: 'unmined', attempts: 0 })
    await req.refreshFromStorage(ctx.activeStorage)
    jest.spyOn(ctx.monitor.services, 'getMerklePath').mockImplementationOnce(async () => {
      const current = await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)
      current.attempts = 3
      current.addHistoryNote({ what: 'another-live-observer' })
      await current.updateStorageDynamicProperties(ctx.activeStorage)
      return { name: 'proof-checker-no-proof', notes: [{ what: 'late-proof-observer' }] }
    })
    await getProofs(new TaskCheckForProofs(ctx.monitor), [req.toApi()], Number.MAX_SAFE_INTEGER, 0, true)
    const current = await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)
    expect(current.attempts).toBe(4)
    expect(current.status).toBe('unmined')
    expect(current.history.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ what: 'another-live-observer' }),
        expect.objectContaining({ what: 'late-proof-observer' })
      ])
    )
  } finally {
    await ctx.wallet.destroy()
  }
})

test('the actual waiting-send monitor releases manager ownership while a broadcast is pending', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('monitor-send-foreground-yield', 'legacy')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let pending: Promise<string> | undefined
  let foreground: Promise<unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'real background broadcast fairness',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'foreground yielding output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing actual signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual request')
    await ctx.activeStorage.updateProvenTxReq(req.id, { status: 'unsent', updated_at: new Date(0) })
    jest.spyOn(ctx.services, 'postBeef').mockImplementation(async (_beef, txids) => {
      entered()
      await gate
      return [
        {
          name: 'controlled-monitor-post',
          status: 'success',
          txidResults: txids.map(txid => ({ txid, status: 'success' }))
        }
      ]
    })
    const task = new TaskSendWaiting(ctx.monitor, 0, 0)
    pending = task.runTask()
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error('Monitor did not reach actual post')
      })
    ])
    const basket = (await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } }))[0]
    foreground = ctx.storage.runAsStorageProvider(async sp => {
      await sp.updateOutputBasket(basket.basketId, { numberOfDesiredUTXOs: 9 })
      return (await sp.findOutputBaskets({ partial: { userId: ctx.userId, basketId: basket.basketId } }))[0]
        .numberOfDesiredUTXOs
    })
    await expect(
      Promise.race([
        foreground,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Foreground writer blocked by pending monitor transport')), 1500)
        })
      ])
    ).resolves.toBe(9)
    release()
    await pending
    expect((await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)).status).toBe('unmined')
  } finally {
    if (timer != null) clearTimeout(timer)
    release()
    await pending?.catch(() => undefined)
    await foreground?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('a wholly invalid real request set returns validation results without posting an empty batch', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('monitor-invalid-no-empty-post', 'legacy')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const created = await ctx.wallet.createAction({
      description: 'real invalid broadcast preparation',
      outputs: [{ satoshis: 741, lockingScript: '51', outputDescription: 'invalid request metadata' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    if (created.txid == null) throw new Error('Missing actual signed action')
    const req = await EntityProvenTxReq.fromStorageTxid(ctx.activeStorage, created.txid)
    if (req == null) throw new Error('Missing actual request')
    req.inputBEEF = undefined
    const post = jest.spyOn(ctx.services, 'postBeef').mockImplementation(async () => {
      throw new Error('No valid transaction may reach transport')
    })
    const result = await ctx.activeStorage.attemptToPostReqsToNetwork([req])
    expect(post).not.toHaveBeenCalled()
    expect(result.details).toHaveLength(1)
    expect(result.details[0].status).toBe('invalid')
    expect((await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)).status).toBe('invalid')
  } finally {
    await ctx.wallet.destroy()
  }
})

test('terminal cleanup and quarantine share one actual captured profile transaction', async () => {
  const { ctx, req, rows } = await sharedRequestFixture('terminal-quarantine-atomic-writer')
  try {
    const storage = ctx.activeStorage
    const writes = await StorageReqWrite.capture(storage, [req.txid])
    await writes.request(req, async current => {
      current.status = 'doubleSpend'
    })
    const owned = rows.find(row => row.userId === ctx.userId)!
    const before = await storage.findOutputs({ partial: { userId: ctx.userId, spentBy: owned.transactionId } })
    expect(before.length).toBeGreaterThan(0)
    const stop = new Error('injected quarantine rollback')
    await expect(
      writes.status(req, 'failed', async (userId, trx) => {
        if (userId === ctx.userId) {
          await storage.updateOutput(before[0].outputId, { spendable: false }, trx)
          throw stop
        }
      })
    ).rejects.toBe(stop)
    expect(
      (await storage.findTransactions({ partial: { transactionId: owned.transactionId }, noRawTx: true }))[0].status
    ).toBe('unproven')
    expect((await storage.findOutputs({ partial: { outputId: before[0].outputId } }))[0].spentBy).toBe(
      owned.transactionId
    )
    const applied = await applyCapturedTerminalFailure(req, storage, writes, true)
    expect(applied.staleConfirmed).toBeGreaterThan(0)
    expect(
      (await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })).every(
        row => row.status === 'failed'
      )
    ).toBe(true)
    for (const output of before) {
      const current = (await storage.findOutputs({ partial: { outputId: output.outputId } }))[0]
      expect(current.spendable).toBe(false)
      expect(current.spentBy).toBeUndefined()
    }
  } finally {
    await ctx.wallet.destroy()
  }
})

test.each([false, true])(
  'proactive terminal observation and drift repair preserve primary ownership, conflict=%s',
  async inputConflict => {
    const { ctx, req, second } = await sharedRequestFixture('terminal-observation-and-review-primary')
    try {
      const storage = ctx.activeStorage
      await storage.updateProvenTxReq(req.id, { status: 'unmined', created_at: new Date(0), updated_at: new Date(0) })
      const find = ctx.storage.findProvenTxReqs.bind(ctx.storage)
      jest
        .spyOn(ctx.storage, 'findProvenTxReqs')
        .mockImplementation(async args => (await find(args)).filter(row => row.provenTxReqId === req.id))
      jest.spyOn(ctx.monitor.services, 'getStatusForTxids').mockImplementationOnce(async (...args) => {
        const [txids] = args
        expect(txids).toEqual([req.txid])
        await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
        return {
          name: 'controlled-terminal-status',
          status: 'success',
          results: [
            {
              txid: req.txid,
              status: 'unknown',
              depth: undefined,
              terminal: true,
              inputConflict,
              providerStatus: 'MISSING_INPUTS'
            }
          ]
        }
      })
      const result = JSON.parse(await new TaskReconcilePendingTransactions(ctx.monitor, 0, 100, 0).runTask())
      expect(result.reconciled).toBe(1)
      let current = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
      expect(current.find(row => row.userId === ctx.userId)?.status).toBe('unproven')
      expect(current.find(row => row.userId === second.userId)?.status).toBe('failed')
      // This service-wide repair must not undo the profile fence on its next run.
      await storage.reviewStatus({ agedLimit: new Date() })
      current = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
      expect(current.find(row => row.userId === ctx.userId)?.status).toBe('unproven')
      expect(current.find(row => row.userId === second.userId)?.status).toBe('failed')
      await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey })
      await storage.reviewStatus({ agedLimit: new Date() })
      current = await storage.findTransactions({ partial: { txid: req.txid }, noRawTx: true })
      expect(current.every(row => row.status === 'failed')).toBe(true)
    } finally {
      await ctx.wallet.destroy()
    }
  }
)

test('queued foreground SQL runs before the next captured monitor commit', async () => {
  const { ctx, req } = await sharedRequestFixture('monitor-background-commit-priority')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let entered!: () => void
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  let held: Promise<unknown> | undefined
  let foreground: Promise<unknown> | undefined
  let background: Promise<unknown> | undefined
  try {
    const writes = await captureMonitorReqWrite({ storage: ctx.storage }, [req.txid])
    if (writes == null) throw new Error('Actual migrated provider did not supply monitor captures')
    expect(writes.preparesOutsideManager).toBe(true)
    held = ctx.storage.runAsStorageProvider(async () => {
      entered()
      await gate
    })
    await reached
    const order: string[] = []
    background = writes.request(req, async current => {
      current.addHistoryNote({ what: 'background-priority-witness' })
      order.push('background')
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    const basket = (await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } }))[0]
    foreground = ctx.storage.runAsStorageProvider(async sp => {
      await sp.updateOutputBasket(basket.basketId, { numberOfDesiredUTXOs: 8 })
      expect((await sp.findOutputBaskets({ partial: { basketId: basket.basketId } }))[0].numberOfDesiredUTXOs).toBe(8)
      order.push('foreground')
    })
    release()
    await Promise.all([held, foreground, background])
    expect(order).toEqual(['foreground', 'background'])
    expect((await EntityProvenTxReq.fromStorageId(ctx.activeStorage, req.id)).history.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'background-priority-witness' })])
    )
  } finally {
    release()
    await Promise.allSettled([held, foreground, background])
    await ctx.wallet.destroy()
  }
})

test.each(['ABA', 'refreshed'] as const)(
  'abandoned cleanup rechecks the original actual role and current row, race=%s',
  async race => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('abandoned-actual-role-' + race, 'legacy')
    try {
      await _tu.installOfflineLegacyChainTracker(ctx)
      const created = await ctx.wallet.createAction({
        description: 'genuine unfinished action for abandoned cleanup',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'unfinished output' }],
        options: { noSend: true, signAndProcess: false, randomizeOutputs: false }
      })
      const reference = created.signableTransaction?.reference
      if (reference == null) throw new Error('Missing actual signable action')
      const storage = ctx.activeStorage
      const original = (
        await storage.findTransactions({ partial: { userId: ctx.userId, reference }, noRawTx: true })
      )[0]
      expect(original.status).toBe('unsigned')
      await storage.updateTransaction(original.transactionId, { updated_at: new Date(0) })
      const beforeInputs = await storage.findOutputs({
        partial: { userId: ctx.userId, spentBy: original.transactionId }
      })
      expect(beforeInputs.length).toBeGreaterThan(0)
      const capture = storage.activeWriteTransaction.bind(storage)
      const spy = jest.spyOn(storage, 'activeWriteTransaction').mockImplementationOnce(async auth => {
        const write = await capture(auth)
        if (race === 'ABA') {
          await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
          await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey })
        } else {
          await storage.updateTransaction(original.transactionId, { updated_at: new Date() })
        }
        return write
      })
      const task = new TaskFailAbandoned(ctx.monitor)
      const result = await task.runTask()
      expect(result).not.toContain(`updated tx ${original.transactionId} status to 'failed'`)
      if (race === 'ABA') expect(result).toContain('deferred to its current primary')
      expect(
        (await storage.findTransactions({ partial: { transactionId: original.transactionId }, noRawTx: true }))[0]
          .status
      ).toBe('unsigned')
      for (const output of beforeInputs) {
        expect((await storage.findOutputs({ partial: { outputId: output.outputId } }))[0].spentBy).toBe(
          original.transactionId
        )
      }
      spy.mockRestore()
      await storage.updateTransaction(original.transactionId, { updated_at: new Date(0) })
      expect(await task.runTask()).toContain(`updated tx ${original.transactionId} status to 'failed'`)
      expect(
        (await storage.findTransactions({ partial: { transactionId: original.transactionId }, noRawTx: true }))[0]
          .status
      ).toBe('failed')
      for (const output of beforeInputs) {
        expect((await storage.findOutputs({ partial: { outputId: output.outputId } }))[0].spentBy).toBeUndefined()
      }
    } finally {
      await ctx.wallet.destroy()
    }
  }
)

test('expired batch cleanup cannot release actual reservations across a primary ABA', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('batch-cleanup-original-epoch')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    await ctx.wallet.createAction({
      description: 'genuine batch reserved before expiry',
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'batched output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    const begun = await begin.mock.results[0].value
    const storage = ctx.activeStorage
    const batch = await storage.findActionBatch(ctx.userId, begun.batchId)
    if (batch == null) throw new Error('Missing actual prepared batch')
    await storage.updateActionBatch(batch.actionBatchId, { expiresAt: new Date(0) })
    const reservations = await storage.findActionBatchOutputIds(batch.actionBatchId)
    expect(reservations.length).toBeGreaterThan(0)
    const capture = storage.activeWriteTransaction.bind(storage)
    jest.spyOn(storage, 'activeWriteTransaction').mockImplementationOnce(async auth => {
      const write = await capture(auth)
      await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
      await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey })
      return write
    })
    expect(await cleanupExpiredActionBatches(storage)).toBe(0)
    expect((await storage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe(batch.status)
    expect(await storage.findActionBatchOutputIds(batch.actionBatchId)).toEqual(reservations)
    expect(await cleanupExpiredActionBatches(storage)).toBe(1)
    expect((await storage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('expired')
    expect(await storage.findActionBatchOutputIds(batch.actionBatchId)).toEqual([])
  } finally {
    await ctx.wallet.destroy()
  }
})

test.each(['atomic', 'conclusive'] as const)(
  'UTXO release retains the actual role from before provider work, mode=%s',
  async mode => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('utxo-review-original-epoch-' + mode, 'legacy')
    try {
      const storage = ctx.activeStorage
      const basket = (await storage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } }))[0]
      const outputs = await storage.findOutputs({
        partial: { userId: ctx.userId, spendable: true, basketId: basket.basketId },
        txStatus: ['completed'],
        paged: { limit: 1, offset: 0 }
      })
      expect(outputs).toHaveLength(1)
      const auth = { userId: ctx.userId, identityKey: ctx.identityKey }
      jest
        .spyOn(ctx.services, 'getUtxoStatus')
        .mockImplementationOnce(async () => {
          await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
          await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey })
          return { name: 'actual-role-race', status: 'success', details: [], isUtxo: false }
        })
        .mockResolvedValue({ name: 'fresh-spent-verdict', status: 'success', details: [], isUtxo: false })
      await expect(reviewUtxoOutputs(storage, auth, outputs, mode)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
      expect((await storage.findOutputs({ partial: { outputId: outputs[0].outputId } }))[0].spendable).toBe(true)
      const fresh = await reviewUtxoOutputs(storage, auth, outputs, mode)
      expect(fresh.diagnostics.released).toBe(1)
      expect((await storage.findOutputs({ partial: { outputId: outputs[0].outputId } }))[0].spendable).toBe(false)
    } finally {
      await ctx.wallet.destroy()
    }
  }
)

test('read-only UTXO review does not require the actual primary role', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('utxo-readonly-inactive', 'legacy')
  try {
    const storage = ctx.activeStorage
    const basket = (await storage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } }))[0]
    const outputs = await storage.findOutputs({
      partial: { userId: ctx.userId, spendable: true, basketId: basket.basketId },
      txStatus: ['completed'],
      paged: { limit: 1, offset: 0 }
    })
    expect(outputs).toHaveLength(1)
    await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
    const capture = jest.spyOn(storage, 'activeWriteTransaction')
    jest
      .spyOn(ctx.services, 'getUtxoStatus')
      .mockResolvedValue({ name: 'readonly-verdict', status: 'success', details: [], isUtxo: false })
    const review = await reviewUtxoOutputs(storage, { userId: ctx.userId, identityKey: ctx.identityKey }, outputs)
    expect(review.diagnostics).toMatchObject({ confirmedSpent: 1, released: 0 })
    expect(capture).not.toHaveBeenCalled()
    expect((await storage.findOutputs({ partial: { outputId: outputs[0].outputId } }))[0].spendable).toBe(true)
  } finally {
    await ctx.wallet.destroy()
  }
})

test.each(['full', 'page'] as const)(
  'actual UTXO monitor provider work allows foreground SQL, entry=%s',
  async entry => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('utxo-monitor-foreground-' + entry, 'legacy')
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const reached = new Promise<void>(resolve => {
      entered = resolve
    })
    let pending: Promise<unknown> | undefined
    let foreground: Promise<unknown> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      jest.spyOn(ctx.services, 'getUtxoStatus').mockImplementation(async () => {
        entered()
        await gate
        return { name: 'controlled-utxo-review', status: 'success', details: [], isUtxo: false }
      })
      const task = new TaskReviewUtxos(ctx.monitor)
      pending =
        entry === 'full'
          ? task.reviewByIdentityKey(ctx.identityKey, 'change', true)
          : task.reviewPageByIdentityKey(ctx.identityKey, 'change', true, 1)
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error('UTXO monitor never reached provider observation')
        })
      ])
      const basket = (
        await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } })
      )[0]
      foreground = ctx.storage.runAsStorageProvider(async sp => {
        await sp.updateOutputBasket(basket.basketId, { numberOfDesiredUTXOs: 8 })
        return (await sp.findOutputBaskets({ partial: { basketId: basket.basketId } }))[0].numberOfDesiredUTXOs
      })
      await expect(
        Promise.race([
          foreground,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Foreground SQL blocked by UTXO provider observation')), 1500)
          })
        ])
      ).resolves.toBe(8)
      release()
      await pending
      expect(
        (await ctx.activeStorage.findOutputBaskets({ partial: { basketId: basket.basketId } }))[0].numberOfDesiredUTXOs
      ).toBe(8)
    } finally {
      if (timer != null) clearTimeout(timer)
      release()
      await Promise.allSettled([pending, foreground])
      await ctx.wallet.destroy()
    }
  }
)

test.each(['ABA', 'late-conflict', 'advanced'] as const)(
  'double-spend review preserves original role and fresh metadata, race=%s',
  async race => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('double-spend-review-current-' + race, 'legacy')
    try {
      await _tu.installOfflineLegacyChainTracker(ctx)
      const created = await ctx.wallet.createAction({
        description: 'real double-spend review input',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'review output' }],
        options: { noSend: true, randomizeOutputs: false }
      })
      if (created.txid == null) throw new Error('Missing actual signed action')
      const storage = ctx.activeStorage
      const req = await EntityProvenTxReq.fromStorageTxid(storage, created.txid)
      if (req == null) throw new Error('Missing actual request')
      await storage.updateProvenTxReq(req.id, { status: 'doubleSpend', updated_at: new Date(0) })
      const find = ctx.storage.findProvenTxReqs.bind(ctx.storage)
      jest
        .spyOn(ctx.storage, 'findProvenTxReqs')
        .mockImplementation(async args => (await find(args)).filter(row => row.provenTxReqId === req.id))
      jest
        .spyOn(ctx.monitor.services, 'getStatusForTxids')
        .mockImplementationOnce(async () => {
          if (race === 'ABA') {
            await storage.updateUser(ctx.userId, { activeStorage: 'another-primary' })
            await storage.updateUser(ctx.userId, { activeStorage: storage.getSettings().storageIdentityKey })
          } else if (race === 'advanced') {
            await storage.updateProvenTxReq(req.id, { status: 'unmined' })
          } else {
            const current = await EntityProvenTxReq.fromStorageId(storage, req.id)
            current.addHistoryNote({ what: 'arcSSETerminalRejection', inputConflict: true })
            await current.updateStorageDynamicProperties(storage)
            await storage.updateProvenTxReq(req.id, { updated_at: new Date(0) })
          }
          return {
            name: 'controlled-double-spend-review',
            status: 'success',
            results: [{ txid: req.txid, status: 'known', depth: undefined }]
          }
        })
        .mockResolvedValue({
          name: 'fresh-double-spend-review',
          status: 'success',
          results: [{ txid: req.txid, status: 'known', depth: undefined }]
        })
      const task = new TaskReviewDoubleSpends(ctx.monitor, 0, 100, 0)
      const reviewed = JSON.parse(await task.runTask())
      expect(reviewed.unfails).toBe(0)
      expect((await EntityProvenTxReq.fromStorageId(storage, req.id)).status).toBe(
        race === 'advanced' ? 'unmined' : 'doubleSpend'
      )
      if (race === 'ABA') {
        expect(JSON.parse(await task.runTask()).unfails).toBe(1)
        expect((await EntityProvenTxReq.fromStorageId(storage, req.id)).status).toBe('unfail')
      } else if (race === 'late-conflict') {
        expect(JSON.parse(await task.runTask()).unfails).toBe(0)
        expect((await EntityProvenTxReq.fromStorageId(storage, req.id)).history.notes).toEqual(
          expect.arrayContaining([expect.objectContaining({ inputConflict: true })])
        )
      }
    } finally {
      await ctx.wallet.destroy()
    }
  }
)

test('change-parameter spec-op uses the original actual profile epoch', async () => {
  const f = await fixture()
  try {
    const args = Validation.validateListOutputsArgs({ basket: specOpSetWalletChangeParams, tags: ['7', '100'] })
    const capture = f.storage.activeWriteTransaction.bind(f.storage)
    const spy = jest.spyOn(f.storage, 'activeWriteTransaction').mockImplementationOnce(async auth => {
      const write = await capture(auth)
      await f.peer.updateUser(f.user.userId, { activeStorage: 'another-primary' })
      await f.peer.updateUser(f.user.userId, { activeStorage: storageIdentity })
      return write
    })
    await expect(f.storage.listOutputs(f.auth, args)).rejects.toMatchObject({ code: 'WERR_NOT_ACTIVE' })
    expect(
      (await f.storage.findOutputBaskets({ partial: { basketId: f.basket.basketId } }))[0].numberOfDesiredUTXOs
    ).toBe(f.basket.numberOfDesiredUTXOs)
    spy.mockRestore()
    await f.storage.listOutputs(f.auth, args)
    expect((await f.storage.findOutputBaskets({ partial: { basketId: f.basket.basketId } }))[0]).toMatchObject({
      numberOfDesiredUTXOs: 7,
      minimumDesiredUTXOValue: 100
    })
  } finally {
    await f.close()
  }
})

test('foreground batch planning avoids global expiry scans and background cleanup reads only lease metadata', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('batch-expiry-bounded-metadata')
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const storage = ctx.activeStorage
    const scan = jest.spyOn(storage, 'expiredActionBatchCandidates')
    const legacy = jest.spyOn(storage, 'findExpiredActionBatches')
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    await ctx.wallet.createAction({
      description: 'actual batch before metadata expiry',
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'batch output' }],
      options: { noSend: true, randomizeOutputs: false }
    })
    expect(scan).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
    const begun = await begin.mock.results[0].value
    const batch = await storage.findActionBatch(ctx.userId, begun.batchId)
    if (batch == null) throw new Error('Missing actual batch')
    expect((await storage.findActionBatchOutputIds(batch.actionBatchId)).length).toBeGreaterThan(0)
    await storage.updateActionBatch(batch.actionBatchId, { expiresAt: new Date(0) })
    const reads: string[] = []
    const record = (query: { sql: string }) => {
      if (/^select\b/i.test(query.sql) && /from [`"]?action_batches[`"]?/i.test(query.sql)) reads.push(query.sql)
    }
    storage.knex.on('query', record)
    try {
      expect(await new TaskCleanupActionBatches(ctx.monitor).runTask()).toContain('released 1')
    } finally {
      storage.knex.removeListener('query', record)
    }
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.some(sql => /limit \?/i.test(sql))).toBe(true)
    expect(reads.every(sql => !/\*|manifest|uploadDigests|\bresult\b|\bbytes\b/i.test(sql))).toBe(true)
    expect(legacy).not.toHaveBeenCalled()
    expect((await storage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('expired')
    expect(await storage.findActionBatchOutputIds(batch.actionBatchId)).toEqual([])
  } finally {
    await ctx.wallet.destroy()
  }
})

test('manager wallet preparation releases ownership while every actual SQL commit rejoins the original provider', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('manager-prepared-write-yield', 'legacy')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    reached = new Promise<void>(resolve => {
      entered = resolve
    })
  let pending: Promise<unknown> | undefined
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    const read = ctx.activeStorage.findOutputBaskets.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputBaskets').mockImplementationOnce(async (...args) => {
      const rows = await read(...args)
      entered()
      await gate
      return rows
    })
    pending = ctx.storage.createAction(
      Validation.validateCreateActionArgs({
        description: 'actual prepared manager action',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'actual prepared output' }],
        options: { noSend: true }
      })
    )
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error('Actual wallet preparation did not pause')
      })
    ])
    await ctx.storage.runAsStorageProvider(async active => {
      expect(active).toBe(ctx.activeStorage)
      await active.updateUser(ctx.userId, { updated_at: new Date() })
    })
    release()
    await expect(pending).resolves.toBeDefined()
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
  }
})

test('manager generation changes reject a prepared wallet write even when its SQL primary remains unchanged', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('manager-prepared-write-generation', 'legacy')
  const directory = await mkdtemp(join(tmpdir(), 'wallet-prepared-generation-'))
  const backup = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'backup.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    reached = new Promise<void>(resolve => {
      entered = resolve
    })
  let pending: Promise<unknown> | undefined
  try {
    await _tu.installOfflineLegacyChainTracker(ctx)
    await backup.migrate('actual generation peer', 'manager-generation-peer')
    const before = await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()
    const read = ctx.activeStorage.findOutputBaskets.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputBaskets').mockImplementationOnce(async (...args) => {
      const rows = await read(...args)
      entered()
      await gate
      return rows
    })
    pending = ctx.storage.createAction(
      Validation.validateCreateActionArgs({
        description: 'obsolete manager preparation',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'must not publish' }],
        options: { noSend: true }
      })
    )
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error('Actual wallet preparation did not pause')
      })
    ])
    await ctx.storage.addWalletStorageProvider(backup)
    expect((await ctx.activeStorage.findUsers({ partial: { userId: ctx.userId } }))[0].activeStorage).toBe(
      ctx.activeStorage.getSettings().storageIdentityKey
    )
    release()
    await expect(pending).rejects.toThrow('obsolete manager')
    expect(await ctx.activeStorage.knex('transactions').count({ n: '*' }).first()).toEqual(before)
  } finally {
    release()
    await pending?.catch(() => undefined)
    await ctx.wallet.destroy()
    await backup.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
