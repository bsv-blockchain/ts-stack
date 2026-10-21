// Only isolated local test databases and public fixture keys are supplied by IPC.
const knex = require('knex')
const { PrivateKey, KeyDeriver, Transaction } = require('@bsv/sdk')
const { Wallet, WalletStorageManager, StorageKnex, Services } = require('../../../../../out/src/index.js')
const { SQLiteActionRecoveryStore } = require('../../../../../out/src/storage/actionRecovery/SQLiteActionRecoveryStore.js')
const { RecoverableActionController } = require('../../../../../out/src/signer/actionRecovery/RecoverableActionController.js')

function hold(stage, evidence) {
  process.send({ event: 'boundary', stage, ...evidence })
  return new Promise(() => {})
}

process.once('message', async input => {
  let wallet
  try {
    const active = new StorageKnex({
      chain: 'test',
      knex: knex({ client: 'better-sqlite3', connection: { filename: input.database }, useNullAsDefault: true }),
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await active.makeAvailable()
    const keyDeriver = new KeyDeriver(PrivateKey.fromHex(input.fixtureKey))
    const manager = new WalletStorageManager(keyDeriver.identityKey, active)
    await manager.makeAvailable()
    wallet = new Wallet({ chain: 'test', keyDeriver, storage: manager, services: new Services('test'), actionBatchMode: 'legacy' })
    const store = await SQLiteActionRecoveryStore.open(active)
    const controller = new RecoverableActionController(wallet, store, 'recovery-fixture.local')
    if (input.mode === 'recover') {
      if (input.requireNoSigning) wallet.getClientChangeKeyPair = () => { throw new Error('Recovery must not sign') }
      const result = await controller.recover('crash-operation', input.request)
      const state = await store.metadata()
      await wallet.destroy()
      wallet = undefined
      process.send({ event: 'recovered', result, records: state.usedRecords })
      process.disconnect()
      return
    }
    const openOperation = store.operation.bind(store)
    store.operation = async binding => {
      const operation = await openOperation(binding)
      const retain = operation.retain.bind(operation)
      operation.retain = async (plan, trx) => {
        await retain(plan, trx)
        if (input.stage === 'allocation-before-commit') await hold(input.stage, { reference: plan.result.reference })
      }
      const complete = operation.complete.bind(operation)
      operation.complete = async result => {
        if (input.stage === 'allocation-after-commit') await hold(input.stage, { reference: result.reference })
        return await complete(result)
      }
      const prepare = operation.retainPrepared.bind(operation)
      operation.retainPrepared = async bytes => {
        const result = await prepare(bytes)
        if (input.stage === 'prepared-before-response') await hold(input.stage, { reference: (await operation.read()).completed.reference, tx: result })
        return result
      }
      const finalize = operation.retainFinal.bind(operation)
      operation.retainFinal = async (digest, bytes) => {
        const result = await finalize(digest, bytes)
        if (input.stage === 'final-before-processing') await hold(input.stage, { txid: Transaction.fromAtomicBEEF(result).id('hex'), tx: result })
        return result
      }
      return operation
    }
    const processAction = active.processAction.bind(active)
    active.processAction = async (...args) => {
      const result = await processAction(...args)
      if (input.stage === 'processed-before-response') await hold(input.stage, { txid: args[1].txid, rawTx: args[1].rawTx })
      return result
    }
    const prepared = await controller.prepare('crash-operation', input.request)
    await controller.finalize('crash-operation', input.request, { reference: prepared.signableTransaction.reference, spends: {} })
    throw new Error('Expected crash boundary was not reached')
  } catch (error) {
    if (wallet !== undefined) await wallet.destroy()
    process.send({ event: 'error', message: error instanceof Error ? error.message : String(error) })
    process.disconnect()
    process.exitCode = 1
  }
})
