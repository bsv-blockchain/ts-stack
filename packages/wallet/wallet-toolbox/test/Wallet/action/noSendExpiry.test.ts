import { Beef, CachedKeyDeriver, PrivateKey, Script, Transaction, Utils, Validation } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { Wallet } from '../../../src/Wallet'
import { MockServices } from '../../../src/mockchain/MockServices'
import { Monitor } from '../../../src/monitor/Monitor'
import { TaskCheckForProofs } from '../../../src/monitor/tasks/TaskCheckForProofs'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../../src/storage/WalletStorageManager'
import { processNoSendExpiryLifecycle } from '../../../src/storage/methods/noSendExpiryLifecycle'
import { ScriptTemplateBRC29 } from '../../../src/utility/ScriptTemplateBRC29'
import { randomBytesHex, verifyOne } from '../../../src/utility/utilityHelpers'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'

function memoryKnex(_name: string): Knex {
  return makeKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
}

interface WalletHarness {
  wallet: Wallet
  storage: WalletStorageManager
  active: StorageKnex
  activeKey: string
  backup?: StorageKnex
  backupKey?: string
  monitor: Monitor
  destroy: () => Promise<void>
}

describe('BRC-177 noSend expiry reference implementation', () => {
  jest.setTimeout(120_000)

  let chainDb: Knex
  let services: MockServices

  beforeAll(async () => {
    chainDb = memoryKnex('brc177_chain')
    services = new MockServices(chainDb)
    await services.initialize()
    // Keep several mature coinbases available so each isolated wallet can be
    // funded by a transaction the mock processor validates normally.
    for (let i = 0; i < 105; i++) await services.mineBlock()
  })

  afterAll(async () => {
    await chainDb.destroy()
  })

  async function createProvider(name: string): Promise<{ provider: StorageKnex; key: string; db: Knex }> {
    const db = memoryKnex(name)
    const key = randomBytesHex(33)
    const provider = new StorageKnex({
      chain: 'mock',
      knex: db,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await provider.migrate(name, key)
    await provider.makeAvailable()
    return { provider, key, db }
  }

  async function fundWallet(wallet: Wallet): Promise<void> {
    const height = await services.getHeight()
    const [utxo] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - 100)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    expect(utxo).toBeDefined()

    const sourceRow = await services.storage.getTransaction(utxo.txid)
    const sourceRaw = asArray(sourceRow!.rawTx)
    const source = Transaction.fromBinary(sourceRaw)
    const derivationPrefix = Utils.toBase64(Array(16).fill(21))
    const derivationSuffix = Utils.toBase64(Array(16).fill(22))
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({
      derivationPrefix,
      derivationSuffix,
      keyDeriver: wallet.keyDeriver
    })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    payment.addOutput({
      satoshis: 1_000_000,
      lockingScript: template.lock(keys.privateKey, keys.publicKey)
    })

    const sourceProof = await services.getMerklePath(utxo.txid)
    const submitBeef = new Beef()
    const sourceBump = submitBeef.mergeBump(sourceProof.merklePath!)
    submitBeef.mergeRawTx(sourceRaw, sourceBump)
    submitBeef.mergeRawTx(payment.toUint8Array())
    const paymentTxid = payment.id('hex')
    const posted = await services.postBeef(submitBeef, [paymentTxid])
    expect(posted[0].status).toBe('success')

    await services.mineBlock()
    const paymentProof = await services.getMerklePath(paymentTxid)
    const atomic = new Beef()
    const paymentBump = atomic.mergeBump(paymentProof.merklePath!)
    atomic.mergeRawTx(payment.toUint8Array(), paymentBump)
    await expect(
      wallet.internalizeAction({
        tx: atomic.toBinaryAtomic(paymentTxid),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix,
              derivationSuffix,
              senderIdentityKey: wallet.identityKey
            }
          }
        ],
        description: 'Fund BRC-177 integration wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  async function createHarness(withBackup = false): Promise<WalletHarness> {
    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const identityKey = rootKey.toPublicKey().toString()
    const activeSetup = await createProvider('brc177_wallet')
    const backupSetup = withBackup ? await createProvider('brc177_backup') : undefined
    if (backupSetup != null) {
      const { user } = await backupSetup.provider.findOrInsertUser(identityKey)
      await backupSetup.provider.setActive({ identityKey, userId: user.userId }, activeSetup.key)
    }
    const storage = new WalletStorageManager(
      identityKey,
      activeSetup.provider,
      backupSetup == null ? undefined : [backupSetup.provider]
    )
    await storage.makeAvailable()
    storage.setServices(services)
    const monitor = new Monitor({
      chain: 'mock',
      storage,
      services,
      chaintracks: services.tracker as any,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 5_000,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
      startupTaskMode: 'default'
    })
    const wallet = new Wallet({ chain: 'mock', keyDeriver, storage, services, monitor })
    await fundWallet(wallet)
    return {
      wallet,
      storage,
      active: activeSetup.provider,
      activeKey: activeSetup.key,
      backup: backupSetup?.provider,
      backupKey: backupSetup?.key,
      monitor,
      async destroy() {
        await wallet.destroy()
        await activeSetup.db.destroy()
        if (backupSetup != null) await backupSetup.db.destroy()
      }
    }
  }

  function protectedArgs(seconds: number, signAndProcess = true) {
    return {
      description: 'BRC-177 protected payment',
      labels: [`p nosend expiry seconds ${seconds}`],
      outputs: [
        {
          satoshis: 5_000,
          lockingScript: '51',
          outputDescription: 'Protected recipient output'
        }
      ],
      options: {
        noSend: true,
        randomizeOutputs: false,
        signAndProcess
      }
    } as const
  }

  test('pre-funds, releases noSend, atomically reclaims, and finalizes after proof', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600))
      expect(created.txid).toBeDefined()
      expect(created.tx).toBeDefined()
      expect(await services.storage.getTransaction(created.txid!)).toBeUndefined()
      await expect(
        ctx.wallet.internalizeAction({
          tx: created.tx!,
          description: 'Inbound actions cannot claim BRC-177 protection',
          labels: ['p nosend expiry seconds 3600'],
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'inbound',
                customInstructions: 'BRC-177 rejection test',
                tags: []
              }
            }
          ]
        })
      ).rejects.toThrow('only on outgoing createAction requests')

      const target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('signed')
      expect(target.noSendExpiryReclaimRawTx).toBeDefined()
      const funding = verifyOne(await ctx.active.findTransactions({ partial: { txid: target.noSendExpiryAnchorTxid } }))
      const anchor = verifyOne(
        await ctx.active.findOutputs({
          partial: {
            txid: target.noSendExpiryAnchorTxid,
            vout: target.noSendExpiryAnchorVout
          }
        })
      )
      // The anchor is fixed managed change, not an external spend. Only the
      // already-paid funding fee is charged to the application's monthly
      // authorization; the protected action accounts for the anchor later.
      expect(funding.satoshis).toBeLessThan(0)
      expect(-funding.satoshis).toBeLessThan(anchor.satoshis)
      const targetTx = Transaction.fromAtomicBEEF(created.tx!)
      expect(targetTx.inputs).toHaveLength(1)
      expect(targetTx.outputs).toHaveLength(1)

      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      const runs = await Promise.all([
        processNoSendExpiryLifecycle(ctx.active),
        processNoSendExpiryLifecycle(ctx.active)
      ])
      expect(runs.reduce((sum, run) => sum + run.reclaimActivated, 0)).toBe(1)

      const reclaimTxid = target.noSendExpiryReclaimTxid!
      expect(await services.storage.getTransaction(reclaimTxid)).toBeDefined()
      const reclaimRows = await ctx.active.findTransactions({ partial: { txid: reclaimTxid } })
      expect(reclaimRows).toHaveLength(1)
      const pendingReclaimOutput = verifyOne(
        await ctx.active.findOutputs({
          partial: { transactionId: reclaimRows[0].transactionId, vout: 0 }
        })
      )
      expect(pendingReclaimOutput.spendable).toBe(false)

      const header = await services.mineBlock()
      ctx.monitor.processNewBlockHeader(header)
      await ctx.monitor.runTask(TaskCheckForProofs.taskName)
      await processNoSendExpiryLifecycle(ctx.active)

      const finalTarget = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      const finalReclaim = verifyOne(await ctx.active.findTransactions({ partial: { txid: reclaimTxid } }))
      expect(finalTarget.noSendExpiryState).toBe('reclaimed')
      expect(finalTarget.status).toBe('failed')
      expect(finalReclaim.status).toBe('completed')
      const reclaimOutput = verifyOne(
        await ctx.active.findOutputs({
          partial: { transactionId: finalReclaim.transactionId, vout: 0 }
        })
      )
      expect(reclaimOutput.spendable).toBe(true)
      expect(reclaimOutput.change).toBe(true)
    } finally {
      await ctx.destroy()
    }
  })

  test('observation cancels reclaim but only a validated proof finalizes the target winner', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600))
      const beef = Beef.fromBinary(created.tx!)
      const posted = await services.postBeef(beef, [created.txid!])
      expect(posted[0].status).toBe('success')

      await processNoSendExpiryLifecycle(ctx.active)
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('broadcast')
      expect(target.status).toBe('unproven')
      await expect(ctx.wallet.abortAction({ reference: target.reference })).resolves.toEqual({ aborted: false })

      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      await processNoSendExpiryLifecycle(ctx.active)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('broadcast')
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeUndefined()

      const header = await services.mineBlock()
      await processNoSendExpiryLifecycle(ctx.active)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('broadcast')

      ctx.monitor.processNewBlockHeader(header)
      await ctx.monitor.runTask(TaskCheckForProofs.taskName)
      await processNoSendExpiryLifecycle(ctx.active)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('target-won')
      expect(target.status).toBe('completed')
    } finally {
      await ctx.destroy()
    }
  })

  test('a target observed during the reclaim race still wins only after local proof', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600))
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })

      const broadcast = jest
        .spyOn(ctx.active, 'attemptToPostReqsToNetwork')
        .mockRejectedValueOnce(new Error('processor temporarily unavailable'))
      const expired = await processNoSendExpiryLifecycle(ctx.active)
      broadcast.mockRestore()
      expect(expired.reclaimActivated).toBe(1)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('reclaiming')
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeUndefined()

      const posted = await services.postBeef(Beef.fromBinary(created.tx!), [created.txid!])
      expect(posted[0].status).toBe('success')
      const header = await services.mineBlock()

      const lostObservationRace = jest.spyOn(ctx.active, 'compareAndSetNoSendExpiryState').mockResolvedValueOnce(false)
      const raced = await processNoSendExpiryLifecycle(ctx.active)
      lostObservationRace.mockRestore()
      expect(raced.observed).toBe(0)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('reclaiming')
      expect(target.status).toBe('nosend')

      const observed = await processNoSendExpiryLifecycle(ctx.active)
      expect(observed.observed).toBe(1)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('reclaiming')
      expect(target.status).toBe('unproven')
      const suppressedReclaimReq = verifyOne(
        await ctx.active.findProvenTxReqs({
          partial: { txid: target.noSendExpiryReclaimTxid }
        })
      )
      expect(suppressedReclaimReq.status).toBe('unmined')
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeUndefined()

      ctx.monitor.processNewBlockHeader(header)
      await ctx.monitor.runTask(TaskCheckForProofs.taskName)
      await processNoSendExpiryLifecycle(ctx.active)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      const reclaim = verifyOne(
        await ctx.active.findTransactions({
          partial: { txid: target.noSendExpiryReclaimTxid }
        })
      )
      expect(target.noSendExpiryState).toBe('target-won')
      expect(target.status).toBe('completed')
      expect(reclaim.status).toBe('failed')
    } finally {
      await ctx.destroy()
    }
  })

  test('contradictory proof state keeps both race outputs quarantined', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600))
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      await processNoSendExpiryLifecycle(ctx.active)

      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      const reclaim = verifyOne(
        await ctx.active.findTransactions({ partial: { txid: target.noSendExpiryReclaimTxid } })
      )
      await ctx.active.updateTransaction(target.transactionId, { status: 'completed' })
      await ctx.active.updateTransaction(reclaim.transactionId, { status: 'completed' })

      const runs = await Promise.all([
        processNoSendExpiryLifecycle(ctx.active),
        processNoSendExpiryLifecycle(ctx.active)
      ])
      expect(runs.reduce((sum, run) => sum + run.reclaimed + run.targetWon, 0)).toBe(0)
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryState).toBe('reclaiming')
      const targetOutput = verifyOne(
        await ctx.active.findOutputs({ partial: { transactionId: target.transactionId, vout: 0 } })
      )
      const reclaimOutput = verifyOne(
        await ctx.active.findOutputs({ partial: { transactionId: reclaim.transactionId, vout: 0 } })
      )
      expect(targetOutput.spendable).toBe(false)
      expect(reclaimOutput.spendable).toBe(false)
    } finally {
      await ctx.destroy()
    }
  })

  test('a rejected reclaim never releases the revocation anchor to ordinary coin selection', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600))
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      await processNoSendExpiryLifecycle(ctx.active)

      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      const reclaim = verifyOne(
        await ctx.active.findTransactions({ partial: { txid: target.noSendExpiryReclaimTxid } })
      )
      await ctx.active.updateTransactionStatus('failed', reclaim.transactionId)

      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      const anchor = verifyOne(
        await ctx.active.findOutputs({
          partial: {
            userId: target.userId,
            txid: target.noSendExpiryAnchorTxid,
            vout: target.noSendExpiryAnchorVout
          }
        })
      )
      const reclaimOutput = verifyOne(
        await ctx.active.findOutputs({ partial: { transactionId: reclaim.transactionId, vout: 0 } })
      )
      expect(target.noSendExpiryState).toBe('reclaiming')
      expect(anchor.spendable).toBe(false)
      expect(anchor.spentBy).toBe(reclaim.transactionId)
      expect(reclaimOutput.spendable).toBe(false)
    } finally {
      await ctx.destroy()
    }
  })

  test('unsigned expiry survives restart semantics and releases the anchor without broadcasting', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600, false))
      const reference = created.signableTransaction!.reference
      let target = verifyOne(await ctx.active.findTransactions({ partial: { reference } }))
      expect(target.noSendExpiryState).toBe('unsigned')

      // Simulate process loss: pending signer state disappears while durable
      // storage retains the expiry and pre-signed reclaim.
      delete ctx.wallet.pendingSignActions[reference]
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      await processNoSendExpiryLifecycle(ctx.active)

      target = verifyOne(await ctx.active.findTransactions({ partial: { reference } }))
      expect(target.noSendExpiryState).toBe('cancelled')
      expect(target.status).toBe('failed')
      const anchor = verifyOne(
        await ctx.active.findOutputs({
          partial: {
            txid: target.noSendExpiryAnchorTxid,
            vout: target.noSendExpiryAnchorVout
          }
        })
      )
      expect(anchor.spendable).toBe(true)
      expect(anchor.spentBy).toBeUndefined()
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeUndefined()
      await expect(ctx.wallet.abortAction({ reference })).resolves.toEqual({ aborted: true })
    } finally {
      await ctx.destroy()
    }
  })

  test('signAction releases the protected transaction and storage handoff leaves only the new active monitor in charge', async () => {
    const ctx = await createHarness(true)
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600, false))
      const signed = await ctx.wallet.signAction({
        reference: created.signableTransaction!.reference,
        spends: {},
        options: { noSend: true }
      })
      expect(signed.txid).toBeDefined()
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: signed.txid } }))
      expect(target.noSendExpiryState).toBe('signed')

      await ctx.storage.updateBackups()
      await ctx.storage.setActive(ctx.backupKey!)
      target = verifyOne(await ctx.backup!.findTransactions({ partial: { txid: signed.txid } }))
      await ctx.backup!.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })

      const { user: oldUser } = await ctx.active.findOrInsertUser(ctx.wallet.identityKey)
      await expect(
        ctx.active.abortAction(
          { identityKey: ctx.wallet.identityKey, userId: oldUser.userId, isActive: false },
          { reference: target.reference }
        )
      ).rejects.toThrow('BRC-177 requires the active storage provider')
      const oldProviderRun = await processNoSendExpiryLifecycle(ctx.active)
      expect(oldProviderRun.inspected).toBe(0)
      const newProviderRun = await processNoSendExpiryLifecycle(ctx.backup!)
      expect(newProviderRun.reclaimActivated).toBe(1)
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeDefined()
    } finally {
      await ctx.destroy()
    }
  })

  test('blockheight expiry and early abort both use the same guarded reclaim path', async () => {
    const ctx = await createHarness()
    try {
      const expiryHeight = (await services.getHeight()) + 1
      const created = await ctx.wallet.createAction({
        ...protectedArgs(3600),
        labels: [`p nosend expiry blockheight ${expiryHeight}`]
      })
      let target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryMode).toBe('blockheight')
      expect(target.noSendExpiryDeadline).toBe(expiryHeight)

      await services.mineBlock()
      const expired = await processNoSendExpiryLifecycle(ctx.active)
      expect(expired.reclaimActivated).toBe(1)
      expect(await services.storage.getTransaction(target.noSendExpiryReclaimTxid!)).toBeDefined()

      const second = await ctx.wallet.createAction(protectedArgs(3600))
      target = verifyOne(await ctx.active.findTransactions({ partial: { txid: second.txid } }))
      const originalDeadline = target.noSendExpiryDeadline
      await expect(ctx.wallet.abortAction({ reference: target.reference })).resolves.toEqual({ aborted: true })
      const aborted = verifyOne(await ctx.active.findTransactions({ partial: { txid: second.txid } }))
      expect(aborted.noSendExpiryState).toBe('reclaiming')
      expect(aborted.noSendExpiryDeadline).toBe(originalDeadline)
      expect(await services.storage.getTransaction(aborted.noSendExpiryReclaimTxid!)).toBeDefined()
      await expect(ctx.wallet.abortAction({ reference: aborted.reference })).resolves.toEqual({ aborted: true })
    } finally {
      await ctx.destroy()
    }
  })

  test('timestamp expiry remains the exact absolute deadline after pre-funding', async () => {
    const ctx = await createHarness()
    try {
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const created = await ctx.wallet.createAction({
        ...protectedArgs(3600),
        labels: [`p nosend expiry timestamp ${deadline}`]
      })
      const target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(target.noSendExpiryMode).toBe('timestamp')
      expect(target.noSendExpiryValue).toBe(deadline)
      expect(target.noSendExpiryDeadline).toBe(deadline)
    } finally {
      await ctx.destroy()
    }
  })

  test('signAction cannot release an armed transaction at or after its deadline', async () => {
    const ctx = await createHarness()
    try {
      const created = await ctx.wallet.createAction(protectedArgs(3600, false))
      const reference = created.signableTransaction!.reference
      const target = verifyOne(await ctx.active.findTransactions({ partial: { reference } }))
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })

      await expect(ctx.wallet.signAction({ reference, spends: {}, options: { noSend: true } })).rejects.toThrow(
        'expired'
      )
      const unchanged = verifyOne(await ctx.active.findTransactions({ partial: { reference } }))
      expect(unchanged.noSendExpiryState).toBe('unsigned')
      expect(unchanged.txid).toBeUndefined()
    } finally {
      await ctx.destroy()
    }
  })

  test('service ambiguity defers reclaim and malformed option combinations fail before pre-funding', async () => {
    const ctx = await createHarness()
    try {
      const initiallyUnmined = (await services.storage.getUnminedTransactions()).length
      const capabilities = jest.spyOn(ctx.storage, 'getCapabilities').mockResolvedValueOnce({})
      await expect(ctx.wallet.createAction(protectedArgs(3600))).rejects.toThrow(
        'Active storage does not support BRC-177'
      )
      capabilities.mockRestore()
      expect((await services.storage.getUnminedTransactions()).length).toBe(initiallyUnmined)

      await expect(
        ctx.storage.prepareNoSendExpiry(
          Validation.validateCreateActionArgs({
            description: 'not a BRC-177 action',
            outputs: [
              {
                satoshis: 5_000,
                lockingScript: '51',
                outputDescription: 'ordinary output'
              }
            ],
            options: { noSend: true }
          })
        )
      ).rejects.toThrow('BRC-177 noSend expiry label')
      expect((await services.storage.getUnminedTransactions()).length).toBe(initiallyUnmined)

      const arm = ctx.storage.armNoSendExpiry.bind(ctx.storage)
      const tamper = jest.spyOn(ctx.storage, 'armNoSendExpiry').mockImplementationOnce(async args => {
        const raw = Array.from(args.reclaimRawTx)
        raw[43] ^= 1
        return await arm({
          ...args,
          reclaimRawTx: raw,
          reclaimTxid: Transaction.fromBinary(raw).id('hex')
        })
      })
      await expect(ctx.wallet.createAction(protectedArgs(3600))).rejects.toThrow('SIGHASH_ALL')
      tamper.mockRestore()

      const unminedBefore = (await services.storage.getUnminedTransactions()).length
      await expect(
        ctx.wallet.createAction({
          ...protectedArgs(3600),
          options: { noSend: false }
        })
      ).rejects.toThrow('options.noSend')
      expect((await services.storage.getUnminedTransactions()).length).toBe(unminedBefore)

      const malformedOptions = [
        { noSend: true, sendWith: ['03'.repeat(32)] },
        { noSend: true, noSendChange: [{ txid: '04'.repeat(32), vout: 0 }] },
        { noSend: true, returnTXIDOnly: true }
      ]
      for (const options of malformedOptions) {
        await expect(
          ctx.wallet.createAction({
            ...protectedArgs(3600),
            options
          })
        ).rejects.toThrow()
      }
      expect((await services.storage.getUnminedTransactions()).length).toBe(unminedBefore)

      await expect(
        ctx.wallet.createAction({
          ...protectedArgs(3600),
          labels: [`p nosend expiry timestamp ${Math.floor(Date.now() / 1000) - 1}`]
        })
      ).rejects.toThrow('timestamp later than the current time')
      expect((await services.storage.getUnminedTransactions()).length).toBe(unminedBefore)

      await expect(
        ctx.wallet.createAction({
          ...protectedArgs(3600),
          labels: [`p nosend expiry blockheight ${await services.getHeight()}`]
        })
      ).rejects.toThrow('blockheight later than the current best-chain height')
      expect((await services.storage.getUnminedTransactions()).length).toBe(unminedBefore)

      await expect(
        ctx.wallet.createAction({
          ...protectedArgs(3600),
          labels: [`p nosend expiry seconds ${Number.MAX_SAFE_INTEGER}`]
        })
      ).rejects.toThrow('safely schedulable')
      expect((await services.storage.getUnminedTransactions()).length).toBe(unminedBefore)

      const created = await ctx.wallet.createAction(protectedArgs(3600))
      const target = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      await ctx.active.updateTransaction(target.transactionId, { noSendExpiryDeadline: 0 })
      const statusSpy = jest.spyOn(services, 'getStatusForTxids').mockResolvedValueOnce({
        status: 'error',
        results: [],
        name: 'offline'
      })
      const run = await processNoSendExpiryLifecycle(ctx.active)
      statusSpy.mockRestore()
      expect(run.deferred).toBe(1)
      expect(run.reclaimActivated).toBe(0)
      const unchanged = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(unchanged.noSendExpiryState).toBe('revocation-requested')
      expect(await services.storage.getTransaction(unchanged.noSendExpiryReclaimTxid!)).toBeUndefined()

      const utxoSpy = jest.spyOn(services, 'isUtxo').mockRejectedValueOnce(new Error('all UTXO services offline'))
      const inconclusive = await processNoSendExpiryLifecycle(ctx.active)
      utxoSpy.mockRestore()
      expect(inconclusive.deferred).toBe(1)
      expect(inconclusive.reclaimActivated).toBe(0)

      const spentSpy = jest.spyOn(services, 'isUtxo').mockResolvedValueOnce(false)
      const conflicted = await processNoSendExpiryLifecycle(ctx.active)
      spentSpy.mockRestore()
      expect(conflicted).toMatchObject({ deferred: 1, reclaimActivated: 0 })
      expect(verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } })).noSendExpiryState).toBe(
        'conflicted'
      )

      const knownSpy = jest.spyOn(services, 'getStatusForTxids').mockResolvedValueOnce({
        status: 'success',
        results: [{ txid: created.txid!, status: 'known', depth: 0 }]
      })
      const lostObservationRace = jest.spyOn(ctx.active, 'compareAndSetNoSendExpiryState').mockResolvedValueOnce(false)
      const raced = await processNoSendExpiryLifecycle(ctx.active)
      lostObservationRace.mockRestore()
      knownSpy.mockRestore()
      expect(raced.observed).toBe(0)
      expect(verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } })).noSendExpiryState).toBe(
        'conflicted'
      )

      const recovered = await processNoSendExpiryLifecycle(ctx.active)
      expect(recovered.reclaimActivated).toBe(1)
      const reclaiming = verifyOne(await ctx.active.findTransactions({ partial: { txid: created.txid } }))
      expect(reclaiming.noSendExpiryState).toBe('reclaiming')
      expect(await services.storage.getTransaction(reclaiming.noSendExpiryReclaimTxid!)).toBeDefined()
    } finally {
      await ctx.destroy()
    }
  })

  test('a malformed expiry record cannot starve later valid reclaims', async () => {
    const ctx = await createHarness()
    try {
      const malformed = await ctx.wallet.createAction(protectedArgs(3600))
      const healthy = await ctx.wallet.createAction(protectedArgs(3600))
      const malformedTarget = verifyOne(await ctx.active.findTransactions({ partial: { txid: malformed.txid } }))
      const healthyTarget = verifyOne(await ctx.active.findTransactions({ partial: { txid: healthy.txid } }))
      await ctx.active.updateTransaction(malformedTarget.transactionId, {
        noSendExpiryDeadline: 0,
        noSendExpiryReclaimRawTx: [0]
      })
      await ctx.active.updateTransaction(healthyTarget.transactionId, { noSendExpiryDeadline: 0 })

      const run = await processNoSendExpiryLifecycle(ctx.active)

      expect(run).toMatchObject({ inspected: 2, reclaimActivated: 1, deferred: 1, errors: 1 })
      expect(await services.storage.getTransaction(malformedTarget.noSendExpiryReclaimTxid!)).toBeUndefined()
      expect(await services.storage.getTransaction(healthyTarget.noSendExpiryReclaimTxid!)).toBeDefined()
    } finally {
      await ctx.destroy()
    }
  })
})
