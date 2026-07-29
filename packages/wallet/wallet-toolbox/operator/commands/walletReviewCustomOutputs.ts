import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { findOutputWithoutScript } from '../outputLookup'
import {
  booleanOption,
  environmentName,
  optionInteger,
  optionString,
  parseChain,
  requiredEnvironment
} from '../safety'

type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type ServicesInstance = InstanceType<WalletModule['Services']>
type CustomOutputOutcome = 'not-utxo' | 'restored' | 'unavailable-script' | 'verified-utxo'

interface CustomOutputCounts {
  recoveredScripts: number
  restored: number
  reviewed: number
  unavailableScripts: number
  verifiedUtxos: number
}

export async function reviewCustomOutput(
  storage: StorageInstance,
  services: ServicesInstance,
  toHex: (value: number[]) => string,
  outputId: number,
  restore: boolean
): Promise<{ outcome: CustomOutputOutcome; recoveredScript: boolean }> {
  const output = await storage.findOutputById(outputId)
  if (output === undefined || output.txid === undefined) {
    return { outcome: 'unavailable-script', recoveredScript: false }
  }
  let lockingScript = output.lockingScript
  let recoveredScript = false
  if (lockingScript === undefined || lockingScript.length === 0) {
    lockingScript = await storage.getRawTxOfKnownValidTransaction(output.txid, output.scriptOffset, output.scriptLength)
    if (lockingScript === undefined || lockingScript.length === 0) {
      return { outcome: 'unavailable-script', recoveredScript: false }
    }
    recoveredScript = true
  }
  const outpoint = `${output.txid}.${output.vout}`
  const status = await services.getUtxoStatus(services.hashOutputScript(toHex(lockingScript)), undefined, outpoint)
  if (status.status !== 'success' || status.isUtxo !== true) {
    return { outcome: 'not-utxo', recoveredScript }
  }
  if (!restore) return { outcome: 'verified-utxo', recoveredScript }

  await storage.updateOutput(output.outputId, { spendable: true })
  const persisted = await findOutputWithoutScript(storage, output.outputId)
  if (persisted?.spendable !== true) {
    throw new Error(`Restored output ${output.outputId} did not persist as spendable`)
  }
  return { outcome: 'restored', recoveredScript }
}

function recordCustomOutput(counts: CustomOutputCounts, result: Awaited<ReturnType<typeof reviewCustomOutput>>): void {
  counts.reviewed++
  if (result.recoveredScript) counts.recoveredScripts++
  if (result.outcome === 'unavailable-script') counts.unavailableScripts++
  if (result.outcome === 'verified-utxo' || result.outcome === 'restored') counts.verifiedUtxos++
  if (result.outcome === 'restored') counts.restored++
}

async function reviewCustomOutputPages(
  storage: StorageInstance,
  services: ServicesInstance,
  toHex: (value: number[]) => string,
  initialAfterOutputId: number,
  pageSize: number,
  maxRecords: number,
  restore: boolean
): Promise<{ counts: CustomOutputCounts; finalOutputId: number }> {
  const counts: CustomOutputCounts = {
    recoveredScripts: 0,
    restored: 0,
    reviewed: 0,
    unavailableScripts: 0,
    verifiedUtxos: 0
  }
  let afterOutputId = initialAfterOutputId
  while (counts.reviewed < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - counts.reviewed)
    const rows = await storage
      .toDb()<{ outputId: number }>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where('o.outputId', '>', afterOutputId)
      .where('o.type', 'custom')
      .whereNull('o.spentBy')
      .where('o.spendable', false)
      .where('t.status', 'completed')
      .orderBy('o.outputId', 'asc')
      .limit(limit)
      .select('o.outputId')

    for (const row of rows) {
      afterOutputId = row.outputId
      const result = await reviewCustomOutput(storage, services, toHex, row.outputId, restore)
      recordCustomOutput(counts, result)
    }
    if (rows.length < limit) break
  }
  return { counts, finalOutputId: afterOutputId }
}

export const walletReviewCustomOutputsCommand: OperatorCommand = {
  name: 'wallet-review-custom-outputs',
  description: 'Review completed custom outputs marked unspendable and optionally restore verified UTXOs.',
  allowedOptions: new Set([
    'after-output-id',
    'chain',
    'database-env',
    'max-records',
    'page-size',
    'restore',
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
    const afterOutputId = optionInteger(options, 'after-output-id', 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    })
    const pageSize = optionInteger(options, 'page-size', 100, {
      min: 1,
      max: 500
    })
    const maxRecords = optionInteger(options, 'max-records', 1_000, {
      min: 1,
      max: 100_000
    })
    const restore = booleanOption(options, 'restore')

    return {
      command: 'wallet-review-custom-outputs',
      description: restore
        ? 'Verify candidate custom outputs against chain services and restore confirmed UTXOs.'
        : 'Review candidate custom outputs without changing wallet state.',
      effect: restore ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || restore,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        afterOutputId,
        pageSize,
        maxRecords,
        restore
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Services, Setup, StorageKnex } = await import('../../out/src/index.js')
    const { Utils } = await import('@bsv/sdk')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const initialAfterOutputId = plan.parameters.afterOutputId as number
    const pageSize = plan.parameters.pageSize as number
    const maxRecords = plan.parameters.maxRecords as number
    const restore = plan.parameters.restore as boolean

    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })
    const servicesOptions = Services.createDefaultOptions(chain)
    servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
    const services = new Services(servicesOptions)
    storage.setServices(services)

    let review: Awaited<ReturnType<typeof reviewCustomOutputPages>>
    try {
      await storage.makeAvailable()
      review = await reviewCustomOutputPages(
        storage,
        services,
        value => Utils.toHex(value),
        initialAfterOutputId,
        pageSize,
        maxRecords,
        restore
      )
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-review-custom-outputs',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        restore,
        initialAfterOutputId,
        finalOutputId: review.finalOutputId,
        ...review.counts
      }
    }
  }
}
