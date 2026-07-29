import path from 'node:path'
import { promises as fs } from 'node:fs'

import type { Chain } from '../../out/src'
import type { ProvenTxReqStatus } from '../../out/src/sdk/types'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { classifyProofHistory, reviewProofHistory } from '../proofHistoryReview'
import {
  booleanOption,
  environmentName,
  optionInteger,
  optionString,
  parseChain,
  readBoundedRegularFile,
  requiredEnvironment
} from '../safety'

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

type Mode = 'analyze' | 'export' | 'verify'
type EvidenceResult = Record<string, boolean | number | string>
async function loadSdk() {
  return await import('@bsv/sdk')
}
type SdkModule = Awaited<ReturnType<typeof loadSdk>>
type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type TransactionInstance = InstanceType<SdkModule['Transaction']>

interface ProofHistoryArtifact {
  exportedAt: string
  records: Array<{
    history: string
    provenTxReqId: number
    status: ProvenTxReqStatus
    txid: string
  }>
  schemaVersion: 1
}

function parseMode(value: string): Mode {
  if (value !== 'analyze' && value !== 'export' && value !== 'verify') {
    throw new Error('Operator option "--mode" must be "analyze", "export", or "verify"')
  }
  return value
}

function optionalJsonPath(options: ReadonlyMap<string, string | true>, name: string): string | undefined {
  if (options.get(name) === undefined) return undefined
  const resolved = path.resolve(optionString(options, name))
  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error(`Operator option "--${name}" must identify a JSON file`)
  }
  return resolved
}

function parseRequestIds(value: string): number[] {
  const ids = value.split(',').map(candidate => Number(candidate.trim()))
  if (
    ids.length < 1 ||
    ids.length > 1_000 ||
    ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error('Operator option "--request-ids" must contain 1 through 1,000 unique positive integer IDs')
  }
  return ids
}

function optionalRequestIds(options: ReadonlyMap<string, string | true>): number[] | undefined {
  if (options.get('request-ids') === undefined) return undefined
  return parseRequestIds(optionString(options, 'request-ids'))
}

function validateModeInputs(
  mode: Mode,
  input: string | undefined,
  output: string | undefined,
  requestIds: number[] | undefined,
  overwrite: boolean
): void {
  const invalid =
    (mode === 'export' && (output === undefined || input !== undefined || requestIds !== undefined)) ||
    (mode === 'analyze' && (input === undefined || output !== undefined || requestIds !== undefined || overwrite)) ||
    (mode === 'verify' && (requestIds === undefined || input !== undefined || output !== undefined || overwrite))
  if (invalid) {
    throw new Error(
      'Mode inputs must be exact: export needs --output; analyze needs --input; verify needs --request-ids'
    )
  }
}

function isArtifact(value: unknown): value is ProofHistoryArtifact {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { records?: unknown }).records)
  ) {
    return false
  }
  return (value as ProofHistoryArtifact).records.every(
    record =>
      Number.isSafeInteger(record.provenTxReqId) &&
      record.provenTxReqId > 0 &&
      typeof record.txid === 'string' &&
      typeof record.status === 'string' &&
      typeof record.history === 'string'
  )
}

async function analyzeProofHistory(
  plan: Parameters<OperatorCommand['execute']>[1]
): Promise<EvidenceResult> {
  const input = plan.parameters.input as string
  const maxRecords = plan.parameters.maxRecords as number
  const inputJson = await readBoundedRegularFile(
    input,
    MAX_ARTIFACT_BYTES,
    'Proof-history input must be a regular file no larger than 100 MiB'
  )
  const artifact = JSON.parse(inputJson) as unknown
  if (!isArtifact(artifact)) {
    throw new Error('Proof-history input does not match schema version 1')
  }
  if (artifact.records.length > maxRecords) {
    throw new Error(`Artifact contains ${artifact.records.length} records, exceeding --max-records ${maxRecords}`)
  }
  const classifications: Record<string, number[]> = {}
  let invalidHistories = 0
  for (const record of artifact.records) {
    try {
      const review = reviewProofHistory(record.history)
      for (const classification of classifyProofHistory(review)) {
        const classifiedRequests = (classifications[classification] ??= [])
        classifiedRequests.push(record.provenTxReqId)
      }
    } catch {
      invalidHistories++
    }
  }
  return {
    chain: plan.parameters.chain as Chain,
    mode: 'analyze',
    records: artifact.records.length,
    invalidHistories,
    classificationJson: JSON.stringify(classifications)
  }
}

async function exportProofHistory(
  plan: Parameters<OperatorCommand['execute']>[1],
  storage: StorageInstance
): Promise<EvidenceResult> {
  const maxRecords = plan.parameters.maxRecords as number
  const minRequestId = plan.parameters.minRequestId as number
  const pageSize = plan.parameters.pageSize as number
  let afterId = minRequestId - 1
  const records: ProofHistoryArtifact['records'] = []
  while (records.length < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - records.length)
    const rows = await storage
      .toDb()<ProofHistoryArtifact['records'][number]>('proven_tx_reqs')
      .where('provenTxReqId', '>', afterId)
      .whereNotNull('history')
      .orderBy('provenTxReqId', 'asc')
      .limit(limit)
      .select('provenTxReqId', 'txid', 'status', 'history')
    records.push(...rows)
    if (rows.length > 0) afterId = rows[rows.length - 1].provenTxReqId
    if (rows.length < limit) break
  }
  const artifact: ProofHistoryArtifact = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    records
  }
  const output = plan.parameters.output as string
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(artifact, null, 2), {
    encoding: 'utf8',
    flag: plan.parameters.overwrite === true ? 'w' : 'wx'
  })
  return {
    chain: plan.parameters.chain as Chain,
    mode: 'export',
    records: records.length,
    finalRequestId: afterId,
    output
  }
}

async function completeInputBeef(
  storage: StorageInstance,
  beef: InstanceType<SdkModule['Beef']>,
  transaction: TransactionInstance | undefined
): Promise<boolean> {
  if (transaction === undefined) return false
  let complete = true
  for (const input of transaction.inputs) {
    if (input.sourceTXID === undefined || beef.findTxid(input.sourceTXID) !== undefined) {
      continue
    }
    try {
      const inputBeef = await storage.getBeefForTransaction(input.sourceTXID, {})
      beef.mergeBeef(inputBeef.toBinary())
    } catch {
      complete = false
    }
  }
  return complete
}

async function verifyProofRequest(
  storage: StorageInstance,
  sdk: SdkModule,
  id: number
): Promise<'missing-inputs' | 'missing-request' | 'script-failure' | 'verified'> {
  const request = await storage.findProvenTxReqById(id)
  if (request === undefined) return 'missing-request'
  const beef = new sdk.Beef()
  beef.mergeRawTx(request.rawTx)
  if (request.inputBEEF !== undefined) beef.mergeBeef(request.inputBEEF)
  const transaction = beef.findTxid(request.txid)?.tx
  if (!(await completeInputBeef(storage, beef, transaction))) {
    return 'missing-inputs'
  }
  try {
    const atomic = beef.findAtomicTransaction(request.txid)
    if (atomic === undefined) return 'missing-inputs'
    return (await atomic.verify('scripts only')) ? 'verified' : 'script-failure'
  } catch {
    return 'script-failure'
  }
}

async function verifyProofHistory(
  plan: Parameters<OperatorCommand['execute']>[1],
  storage: StorageInstance,
  sdk: SdkModule
): Promise<Record<string, boolean | number | string>> {
  const requestIds = parseRequestIds(plan.parameters.requestIds as string)
  const counts = {
    verified: 0,
    scriptFailures: 0,
    missingInputs: 0,
    missingRequests: 0
  }
  for (const id of requestIds) {
    const outcome = await verifyProofRequest(storage, sdk, id)
    if (outcome === 'verified') counts.verified++
    else if (outcome === 'script-failure') counts.scriptFailures++
    else if (outcome === 'missing-inputs') counts.missingInputs++
    else counts.missingRequests++
  }
  return {
    chain: plan.parameters.chain as Chain,
    mode: 'verify',
    requested: requestIds.length,
    ...counts
  }
}

export const walletProofHistoryCommand: OperatorCommand = {
  name: 'wallet-proof-history',
  description: 'Export, analyze, or verify bounded proven-transaction request history.',
  allowedOptions: new Set([
    'chain',
    'database-env',
    'input',
    'max-records',
    'min-request-id',
    'mode',
    'output',
    'overwrite',
    'page-size',
    'request-ids',
    'whatsonchain-api-key-env'
  ]),
  plan(options) {
    const mode = parseMode(optionString(options, 'mode'))
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
    const input = optionalJsonPath(options, 'input')
    const output = optionalJsonPath(options, 'output')
    const requestIds = optionalRequestIds(options)
    const overwrite = booleanOption(options, 'overwrite')
    validateModeInputs(mode, input, output, requestIds, overwrite)
    const minRequestId = optionInteger(options, 'min-request-id', 1, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    })
    const pageSize = optionInteger(options, 'page-size', 100, {
      min: 1,
      max: 500
    })
    const maxRecords = optionInteger(options, 'max-records', 10_000, {
      min: 1,
      max: 100_000
    })
    if (mode !== 'export' && (options.has('min-request-id') || options.has('page-size'))) {
      throw new Error('Operator options "--min-request-id" and "--page-size" are valid only in export mode')
    }

    return {
      command: 'wallet-proof-history',
      description: `${mode} a bounded proof-history data set.`,
      effect: mode === 'export' ? 'local-write' : 'read-only',
      requiresProductionApproval: mode !== 'analyze' && chain === 'main',
      parameters: {
        mode,
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        input: input ?? '',
        output: output ?? '',
        overwrite,
        requestIds: requestIds?.join(',') ?? '',
        minRequestId,
        pageSize,
        maxRecords
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const startedAt = new Date().toISOString()
    const mode = plan.parameters.mode as Mode
    let result: Record<string, boolean | number | string>
    if (mode === 'analyze') {
      result = await analyzeProofHistory(plan)
    } else {
      const { Services, Setup, StorageKnex } = await import('../../out/src/index.js')
      const chain = plan.parameters.chain as Chain
      const databaseEnvironment = plan.parameters.databaseEnvironment as string
      const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
      const storage = new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
      })
      const servicesOptions = Services.createDefaultOptions(chain)
      servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
      const services = new Services(servicesOptions)
      storage.setServices(services)
      try {
        await storage.makeAvailable()
        result =
          mode === 'export'
            ? await exportProofHistory(plan, storage)
            : await verifyProofHistory(plan, storage, await loadSdk())
      } finally {
        await storage.destroy()
      }
    }

    return {
      command: 'wallet-proof-history',
      startedAt,
      completedAt: new Date().toISOString(),
      result
    }
  }
}
