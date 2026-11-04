// Isolated local database and public fixture key only. Never broadcasts.
const knex = require('knex')
const { KeyDeriver, PrivateKey } = require('@bsv/sdk')
const { Wallet, WalletStorageManager, StorageKnex, Services } = require('../../../../../out/src/index.js')
const { SQLiteFundingRecoveryStore } = require('../../../../../out/src/storage/fundingRecovery/SQLiteFundingRecoveryStore.js')
const { RecoverableFundingController } = require('../../../../../out/src/signer/fundingRecovery/RecoverableFundingController.js')

function hold(stage) {
  process.send({ event: 'boundary', stage })
  return new Promise(() => {})
}

process.once('message', async input => {
  let wallet
  try {
    const active = new StorageKnex({ chain: input.chain.network, knex: knex({ client: 'better-sqlite3', connection: { filename: input.database }, useNullAsDefault: true }), commissionSatoshis: 0, feeModel: { model: 'sat/kb', value: 1 } })
    await active.makeAvailable()
    const keyDeriver = new KeyDeriver(PrivateKey.fromHex(input.fixtureKey))
    const manager = new WalletStorageManager(keyDeriver.identityKey, active)
    await manager.makeAvailable()
    const services = new Services(input.chain.network)
    services.getChainTracker = async () => ({ currentHeight: async () => 1400, isValidRootForHeight: async (root, height) => root === input.root && height === 1234 })
    services.postBeef = async () => { throw new Error('Fixture must never broadcast') }
    wallet = new Wallet({ chain: input.chain.network, keyDeriver, storage: manager, services, actionBatchMode: 'legacy' })
    const store = await SQLiteFundingRecoveryStore.open(active, input.chain)
    const controller = new RecoverableFundingController(wallet, store)
    if (input.mode === 'recover') {
      const before = await controller.getInternalization(input.operation.id)
      const result = await controller.internalizeOnce(input.operation)
      const again = await controller.internalizeOnce(input.operation)
      const outputs = await active.findOutputs({ partial: { userId: (await manager.getAuth()).userId, txid: input.operation.funding.txid } })
      const transactions = await active.findTransactions({ partial: { txid: input.operation.funding.txid } })
      await wallet.destroy()
      wallet = undefined
      process.send({ event: 'recovered', before, result, again, outputs: outputs.length, satoshis: transactions[0].satoshis })
      process.disconnect()
      return
    }
    const transact = active.transaction.bind(active)
    active.transaction = async (run, trx) => await transact(async token => {
      const value = await run(token)
      if (trx === undefined) {
        const row = await active.toDb(token)('wallet_funding_recovery_v1').where({ id: input.operation.id }).first()
        if (row && input.stage === 'intent-before-commit' && row.receipt === null) await hold(input.stage)
        if (row && input.stage === 'receipt-before-commit' && row.receipt !== null) await hold(input.stage)
      }
      return value
    }, trx)
    const retain = store.retain.bind(store)
    store.retain = async (...args) => {
      const hook = await retain(...args)
      if (input.stage === 'intent-after-commit') await hold(input.stage)
      const commit = hook.commit.bind(hook)
      hook.commit = async run => {
        if (input.mode === 'race') {
          const proceed = new Promise(resolve => process.once('message', resolve))
          process.send({ event: 'boundary', stage: 'ready-to-credit' })
          await proceed
        }
        const value = await commit(run)
        if (input.stage === 'receipt-after-commit') await hold(input.stage)
        return value
      }
      return hook
    }
    const insert = active.insertOutput.bind(active)
    active.insertOutput = async (...args) => {
      const result = await insert(...args)
      if (input.stage === 'ownership-before-commit') await hold(input.stage)
      return result
    }
    const result = await controller.internalizeOnce(input.operation)
    if (input.mode === 'race') {
      await wallet.destroy()
      wallet = undefined
      process.send({ event: 'recovered', result })
      process.disconnect()
      return
    }
    throw new Error('Expected crash boundary was not reached')
  } catch (error) {
    if (wallet !== undefined) await wallet.destroy()
    process.send({ event: 'error', message: error instanceof Error ? error.message : String(error) })
    process.disconnect()
    process.exitCode = 1
  }
})
