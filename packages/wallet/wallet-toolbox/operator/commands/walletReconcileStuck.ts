import type { Chain } from '../../out/src'
import type { TransactionStatus } from '../../out/src/sdk/types'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import {
  booleanOption,
  environmentName,
  optionInteger,
  optionString,
  parseChain,
  requiredEnvironment
} from '../safety'

async function loadSdk() {
  return await import('@bsv/sdk')
}
type SdkModule = Awaited<ReturnType<typeof loadSdk>>
type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type StoredTransaction = Awaited<ReturnType<StorageInstance['findTransactions']>>[number]
type ReconcileOutcome = 'already-tracked' | 'created-request' | 'marked-failed' | 'none' | 'unresolved-raw-transaction'

interface ReconcileTransactionArguments {
  storage: StorageInstance
  services: InstanceType<WalletModule['Services']>
  runtime: WalletModule
  sdk: SdkModule
  transaction: StoredTransaction
  chainStatus: string | undefined
  cutoff: Date
  repair: boolean
}

function parseStatus(value: string): 'sending' | 'unproven' {
  if (value !== 'sending' && value !== 'unproven') {
    throw new Error('Operator option "--status" must be "sending" or "unproven"')
  }
  return value
}

export async function reconcileTransaction({
  storage,
  services,
  runtime,
  sdk,
  transaction,
  chainStatus,
  cutoff,
  repair
}: ReconcileTransactionArguments): Promise<{ eligible: boolean; outcome: ReconcileOutcome }> {
  if (transaction.updated_at > cutoff) {
    return { eligible: false, outcome: 'none' }
  }
  if (chainStatus === 'unknown') {
    if (!repair) return { eligible: true, outcome: 'none' }
    await storage.updateTransactionStatus('failed', transaction.transactionId)
    const updated = await storage.findTransactionById(transaction.transactionId)
    if (updated?.status !== 'failed') {
      throw new Error('Stale transaction did not persist with failed status')
    }
    return { eligible: true, outcome: 'marked-failed' }
  }
  if (chainStatus !== 'mined') return { eligible: true, outcome: 'none' }

  const txid = transaction.txid as string
  const existingRequests = await storage.findProvenTxReqs({
    partial: { txid }
  })
  const existing = await storage.getProvenOrReq(txid)
  if (existingRequests.length > 0 || existing.proven !== undefined) {
    return { eligible: true, outcome: 'already-tracked' }
  }

  let rawTx = transaction.rawTx
  if (rawTx === undefined) rawTx = (await services.getRawTx(txid)).rawTx
  if (rawTx === undefined || sdk.Utils.toHex(runtime.doubleSha256BE(rawTx)) !== txid) {
    return { eligible: true, outcome: 'unresolved-raw-transaction' }
  }
  if (!repair) return { eligible: true, outcome: 'none' }

  const request = runtime.EntityProvenTxReq.fromTxid(txid, rawTx)
  request.inputBEEF = new sdk.Beef().toBinary()
  request.status = 'unmined'
  request.addNotifyTransactionId(transaction.transactionId)
  await request.updateStorage(storage)
  const persisted = await storage.findProvenTxReqs({
    partial: { txid }
  })
  if (!persisted.some(candidate => candidate.status === 'unmined')) {
    throw new Error('Reconciled transaction did not create an unmined proof request')
  }
  return { eligible: true, outcome: 'created-request' }
}

export const walletReconcileStuckCommand: OperatorCommand = {
  name: 'wallet-reconcile-stuck',
  description: 'Review and optionally repair bounded stale sending or unproven transactions.',
  allowedOptions: new Set([
    'chain',
    'database-env',
    'max-records',
    'older-than-hours',
    'repair',
    'status',
    'transaction-id',
    'whatsonchain-api-key-env'
  ]),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'main'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const databaseEnvironment = environmentName(
      optionString(options, 'database-env', `${prefix}_CLOUD_MYSQL_CONNECTION`),
      'database-env'
    )
    const whatsonchainApiKeyEnvironment = environmentName(
      optionString(options, 'whatsonchain-api-key-env', `${prefix}_WHATSONCHAIN_API_KEY`),
      'whatsonchain-api-key-env'
    )
    const status = parseStatus(optionString(options, 'status'))
    const olderThanHours = optionInteger(options, 'older-than-hours', 24, {
      min: 1,
      max: 8_760
    })
    const maxRecords = optionInteger(options, 'max-records', 1_000, {
      min: 1,
      max: 100_000
    })
    const transactionId =
      options.get('transaction-id') === undefined
        ? undefined
        : optionInteger(options, 'transaction-id', Number.NaN, {
            min: 1,
            max: Number.MAX_SAFE_INTEGER
          })
    const repair = booleanOption(options, 'repair')
    return {
      command: 'wallet-reconcile-stuck',
      description: repair
        ? `Review and repair stale ${status} transactions.`
        : `Review stale ${status} transactions without changing state.`,
      effect: repair ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || repair,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        status,
        olderThanHours,
        maxRecords,
        transactionId: transactionId ?? 0,
        exactTransaction: transactionId !== undefined,
        repair
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const runtime = await import('../../out/src/index.js')
    const sdk = await loadSdk()
    const { Services, Setup, StorageKnex } = runtime
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const status = plan.parameters.status as 'sending' | 'unproven'
    const olderThanHours = plan.parameters.olderThanHours as number
    const maxRecords = plan.parameters.maxRecords as number
    const exactTransaction = plan.parameters.exactTransaction as boolean
    const transactionId = plan.parameters.transactionId as number
    const repair = plan.parameters.repair as boolean

    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })
    const servicesOptions = Services.createDefaultOptions(chain)
    servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
    const services = new Services(servicesOptions)
    storage.setServices(services)

    let reviewed = 0
    let eligible = 0
    let markedFailed = 0
    let createdRequests = 0
    let alreadyTracked = 0
    let unresolvedRawTransactions = 0
    try {
      await storage.makeAvailable()
      const transactions = await storage.findTransactions({
        partial: exactTransaction ? { transactionId } : {},
        status: [status as TransactionStatus],
        paged: { limit: maxRecords }
      })
      const withTxids = transactions.filter(transaction => transaction.txid !== undefined)
      const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1_000)
      const serviceResult =
        withTxids.length === 0
          ? { status: 'success', results: [] }
          : await services.getStatusForTxids(withTxids.map(transaction => transaction.txid as string))
      if (serviceResult.status !== 'success') {
        throw new Error('Chain services did not return a successful status review')
      }
      for (const transaction of withTxids) {
        reviewed++
        const current = serviceResult.results.find(result => result.txid === transaction.txid)
        const result = await reconcileTransaction({
          storage,
          services,
          runtime,
          sdk,
          transaction,
          chainStatus: current?.status,
          cutoff,
          repair
        })
        if (result.eligible) eligible++
        if (result.outcome === 'marked-failed') markedFailed++
        if (result.outcome === 'created-request') createdRequests++
        if (result.outcome === 'already-tracked') alreadyTracked++
        if (result.outcome === 'unresolved-raw-transaction') {
          unresolvedRawTransactions++
        }
      }
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-reconcile-stuck',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        status,
        repair,
        reviewed,
        eligible,
        markedFailed,
        createdRequests,
        alreadyTracked,
        unresolvedRawTransactions
      }
    }
  }
}
