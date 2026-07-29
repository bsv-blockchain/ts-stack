import path from 'node:path'
import { promises as fs } from 'node:fs'

import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { environmentName, optionInteger, optionString, parseChain, requiredEnvironment } from '../safety'

const TXID = /^[0-9a-fA-F]{64}$/
const MAX_RAW_TRANSACTION_BYTES = 10 * 1024 * 1024

type Report = 'downstream-spends' | 'input-utxos' | 'merged-beef' | 'recent-transactions'
async function loadSdk() {
  return await import('@bsv/sdk')
}
type SdkModule = Awaited<ReturnType<typeof loadSdk>>
type WalletModule = typeof import('../../out/src/index.js')
type ServicesInstance = InstanceType<WalletModule['Services']>
type StorageInstance = InstanceType<WalletModule['StorageKnex']>

function parseReport(value: string): Report {
  if (
    value !== 'downstream-spends' &&
    value !== 'input-utxos' &&
    value !== 'merged-beef' &&
    value !== 'recent-transactions'
  ) {
    throw new Error(
      'Operator option "--report" must be "downstream-spends", "input-utxos", "merged-beef", or "recent-transactions"'
    )
  }
  return value
}

function parseTxids(value: string): string[] {
  const values = value
    .split(',')
    .map(candidate => candidate.trim().toLowerCase())
    .filter(candidate => candidate !== '')
  if (
    values.length < 1 ||
    values.length > 100 ||
    values.some(value => !TXID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error('Operator option "--txids" must contain 1 through 100 unique hexadecimal transaction IDs')
  }
  return values
}

function optionalUserId(options: ReadonlyMap<string, string | true>): number | undefined {
  if (options.get('user-id') === undefined) return undefined
  return optionInteger(options, 'user-id', Number.NaN, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER
  })
}

function optionalTxids(options: ReadonlyMap<string, string | true>): string[] | undefined {
  if (options.get('txids') === undefined) return undefined
  return parseTxids(optionString(options, 'txids'))
}

function optionalInputPath(options: ReadonlyMap<string, string | true>): string | undefined {
  if (options.get('raw-transaction-file') === undefined) return undefined
  return path.resolve(optionString(options, 'raw-transaction-file'))
}

function validateReportInputs(
  report: Report,
  userId: number | undefined,
  txids: string[] | undefined,
  rawTransactionFile: string | undefined
): void {
  const invalid =
    (report === 'recent-transactions' &&
      (userId === undefined || txids !== undefined || rawTransactionFile !== undefined)) ||
    (report === 'merged-beef' && (userId !== undefined || txids === undefined || rawTransactionFile !== undefined)) ||
    (report === 'downstream-spends' &&
      (userId === undefined || txids === undefined || rawTransactionFile !== undefined)) ||
    (report === 'input-utxos' && (userId !== undefined || txids !== undefined || rawTransactionFile === undefined))
  if (invalid) {
    throw new Error(
      'Report inputs must be exact: recent-transactions needs --user-id; merged-beef needs --txids; downstream-spends needs both; input-utxos needs --raw-transaction-file'
    )
  }
}

async function inputUtxoReport(
  services: ServicesInstance,
  sdk: SdkModule,
  rawTransactionFile: string,
  maxRecords: number
): Promise<unknown> {
  const file = await fs.stat(rawTransactionFile)
  if (!file.isFile() || file.size > MAX_RAW_TRANSACTION_BYTES) {
    throw new Error('Raw transaction input must be a regular file no larger than 10 MiB')
  }
  const rawHex = (await fs.readFile(rawTransactionFile, 'utf8')).trim()
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(rawHex)) {
    throw new Error('Raw transaction input must contain only an even-length hexadecimal transaction')
  }
  const transaction = sdk.Transaction.fromHex(rawHex)
  if (transaction.inputs.length > maxRecords) {
    throw new Error(`Transaction has ${transaction.inputs.length} inputs, exceeding --max-records ${maxRecords}`)
  }
  const sourceTransactions = new Map<string, InstanceType<SdkModule['Transaction']>>()
  for (const input of transaction.inputs) {
    if (input.sourceTXID === undefined) {
      throw new Error('Transaction input is missing its source transaction ID')
    }
    if (sourceTransactions.has(input.sourceTXID)) continue
    const source = await services.getRawTx(input.sourceTXID)
    if (source.rawTx === undefined) {
      throw new Error(`Source transaction ${input.sourceTXID} was not available`)
    }
    sourceTransactions.set(input.sourceTXID, sdk.Transaction.fromBinary(source.rawTx))
  }
  const results = []
  for (const input of transaction.inputs) {
    const sourceTxid = input.sourceTXID as string
    const output = sourceTransactions.get(sourceTxid)?.outputs[input.sourceOutputIndex]
    if (output === undefined) {
      throw new Error(`Source output ${sourceTxid}.${input.sourceOutputIndex} was not available`)
    }
    const outpoint = `${sourceTxid}.${input.sourceOutputIndex}`
    const status = await services.getUtxoStatus(
      services.hashOutputScript(output.lockingScript.toHex()),
      undefined,
      outpoint
    )
    results.push({
      outpoint,
      isUtxo: status.isUtxo === true,
      status: status.status,
      provider: status.name
    })
  }
  return { transactionId: transaction.id('hex'), inputs: results }
}

async function recentTransactionsReport(
  storage: StorageInstance,
  userId: number,
  maxRecords: number
): Promise<unknown> {
  const transactions = await storage.findTransactions({
    partial: { userId },
    status: ['completed', 'unproven', 'failed'],
    orderDescending: true,
    noRawTx: true,
    paged: { limit: maxRecords }
  })
  return {
    userId,
    transactions: transactions.map(transaction => ({
      transactionId: transaction.transactionId,
      txid: transaction.txid ?? '',
      status: transaction.status,
      satoshis: transaction.satoshis,
      updatedAt: transaction.updated_at.toISOString()
    }))
  }
}

async function mergedBeefReport(storage: StorageInstance, txids: string[]): Promise<unknown> {
  const result = await storage.getReqsAndBeefToShareWithWorld(txids, [])
  return {
    requestedTxids: txids,
    details: result.details.map(detail => ({
      txid: detail.txid,
      status: detail.status,
      requestStatus: detail.req?.status ?? '',
      proven: detail.proven !== undefined
    })),
    beefTransactionIds: result.beef.txs.map(transaction => transaction.txid)
  }
}

async function downstreamSpendsReport(
  storage: StorageInstance,
  sdk: SdkModule,
  userId: number,
  txids: string[],
  maxRecords: number
): Promise<unknown> {
  const transactions = await storage.findTransactions({
    partial: { userId },
    status: ['completed', 'unproven', 'failed'],
    orderDescending: true,
    noRawTx: true,
    paged: { limit: maxRecords }
  })
  const walletTxids = transactions.flatMap(transaction => (transaction.txid === undefined ? [] : [transaction.txid]))
  const requests = await storage.findProvenTxReqs({
    partial: {},
    txids: walletTxids
  })
  const beef = new sdk.Beef()
  for (const request of requests) {
    if (request.rawTx !== undefined) beef.mergeRawTx(request.rawTx)
  }
  const spends: Array<{
    sourceTxid: string
    sourceVout: number
    spendingTxid: string
    vin: number
  }> = []
  for (const transaction of beef.txs) {
    if (transaction.tx === undefined) continue
    transaction.tx.inputs.forEach((input, vin) => {
      if (input.sourceTXID !== undefined && txids.includes(input.sourceTXID)) {
        spends.push({
          sourceTxid: input.sourceTXID,
          sourceVout: input.sourceOutputIndex,
          spendingTxid: transaction.txid,
          vin
        })
      }
    })
  }
  return { userId, sourceTxids: txids, spends }
}

function reportRecordCount(reportData: unknown, txidCount: number): number {
  const report = reportData as {
    inputs?: unknown[]
    spends?: unknown[]
    transactions?: unknown[]
  }
  if (Array.isArray(report.transactions)) return report.transactions.length
  if (Array.isArray(report.inputs)) return report.inputs.length
  if (Array.isArray(report.spends)) return report.spends.length
  return txidCount
}

async function databaseReport(
  storage: StorageInstance,
  sdk: SdkModule,
  report: Exclude<Report, 'input-utxos'>,
  userId: number,
  txids: string[],
  maxRecords: number
): Promise<unknown> {
  if (report === 'recent-transactions') {
    return await recentTransactionsReport(storage, userId, maxRecords)
  }
  if (report === 'merged-beef') {
    return await mergedBeefReport(storage, txids)
  }
  return await downstreamSpendsReport(storage, sdk, userId, txids, maxRecords)
}

export const walletDiagnosticsCommand: OperatorCommand = {
  name: 'wallet-diagnostics',
  description: 'Run one bounded, read-only wallet or transaction diagnostic report.',
  allowedOptions: new Set([
    'chain',
    'database-env',
    'max-records',
    'raw-transaction-file',
    'report',
    'txids',
    'user-id',
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
    const report = parseReport(optionString(options, 'report'))
    const userId = optionalUserId(options)
    const txids = optionalTxids(options)
    const rawTransactionFile = optionalInputPath(options)
    validateReportInputs(report, userId, txids, rawTransactionFile)
    const maxRecords = optionInteger(options, 'max-records', 100, {
      min: 1,
      max: 10_000
    })

    return {
      command: 'wallet-diagnostics',
      description: `Generate the bounded ${report} diagnostic report without changing state.`,
      effect: 'read-only',
      requiresProductionApproval: chain === 'main',
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        report,
        userId: userId ?? 0,
        txids: txids?.join(',') ?? '',
        rawTransactionFile: rawTransactionFile ?? '',
        maxRecords
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Services, Setup, StorageKnex } = await import('../../out/src/index.js')
    const sdk = await loadSdk()
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const report = plan.parameters.report as Report
    const userId = plan.parameters.userId as number
    const txids = plan.parameters.txids === '' ? [] : parseTxids(plan.parameters.txids as string)
    const rawTransactionFile = plan.parameters.rawTransactionFile as string
    const maxRecords = plan.parameters.maxRecords as number

    const servicesOptions = Services.createDefaultOptions(chain)
    servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
    const services = new Services(servicesOptions)
    let reportData: unknown

    if (report === 'input-utxos') {
      reportData = await inputUtxoReport(services, sdk, rawTransactionFile, maxRecords)
    } else {
      const storage = new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
      })
      storage.setServices(services)
      try {
        await storage.makeAvailable()
        reportData = await databaseReport(storage, sdk, report, userId, txids, maxRecords)
      } finally {
        await storage.destroy()
      }
    }

    return {
      command: 'wallet-diagnostics',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        report,
        records: reportRecordCount(reportData, txids.length),
        reportJson: JSON.stringify(reportData)
      }
    }
  }
}
