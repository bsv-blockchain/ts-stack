import type { Chain } from '../../out/src'
import type { ProvenTxReqStatus } from '../../out/src/sdk/types.js'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
type ReviewStatus = 'doubleSpend' | 'invalid'
type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type ServicesInstance = InstanceType<WalletModule['Services']>
type StoredRequest = Awaited<ReturnType<StorageInstance['findProvenTxReqs']>>[number]

function parseChain(value: string): Chain {
  if (value !== 'main' && value !== 'test') {
    throw new Error('Operator option "--chain" must be "main" or "test"')
  }
  return value
}

function environmentName(value: string, option: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error(`Operator option "--${option}" must name an uppercase environment variable`)
  }
  return value
}

function parseStatus(value: string): ReviewStatus {
  if (value !== 'doubleSpend' && value !== 'invalid') {
    throw new Error('Operator option "--status" must be "doubleSpend" or "invalid"')
  }
  return value
}

function booleanOption(options: ReadonlyMap<string, string | true>, name: string): boolean {
  const value = options.get(name)
  if (value !== undefined && value !== true) {
    throw new Error(`Operator option "--${name}" does not accept a value`)
  }
  return value === true
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable "${name}" is not set`)
  }
  return value
}

async function isUnfailCandidate(
  services: ServicesInstance,
  request: StoredRequest,
  status: ReviewStatus
): Promise<boolean> {
  if (status === 'invalid' && (request.txid === undefined || request.rawTx === undefined)) {
    return false
  }
  const serviceResult = await services.getStatusForTxids([request.txid])
  return serviceResult.results[0]?.status !== 'unknown'
}

async function findUnfailCandidates(
  storage: StorageInstance,
  services: ServicesInstance,
  status: ReviewStatus,
  initialOffset: number,
  pageSize: number,
  maxRecords: number
): Promise<{ candidates: number[]; reviewed: number }> {
  const candidates: number[] = []
  let reviewed = 0
  let offset = initialOffset
  while (reviewed < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - reviewed)
    const requests = await storage.findProvenTxReqs({
      partial: { status: status as ProvenTxReqStatus },
      paged: { limit, offset },
      orderDescending: true
    })
    for (const request of requests) {
      reviewed++
      if (await isUnfailCandidate(services, request, status)) {
        candidates.push(request.provenTxReqId)
      }
    }
    if (requests.length < limit) break
    offset += requests.length
  }
  return { candidates, reviewed }
}

async function unfailCandidates(storage: StorageInstance, candidates: number[]): Promise<void> {
  for (const id of candidates) {
    await storage.updateProvenTxReq(id, { status: 'unfail' })
    const updated = await storage.findProvenTxReqById(id)
    if (updated?.status !== 'unfail') {
      throw new Error(`Proof request ${id} did not persist as unfail`)
    }
  }
}

export const walletReviewProofRequestsCommand: OperatorCommand = {
  name: 'wallet-review-proof-requests',
  description: 'Review failed proof requests and optionally return false failures to processing.',
  allowedOptions: new Set([
    'chain',
    'database-env',
    'max-records',
    'offset',
    'page-size',
    'status',
    'unfail',
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
    const offset = optionInteger(options, 'offset', 0, {
      min: 0,
      max: 100_000_000
    })
    const pageSize = optionInteger(options, 'page-size', 100, {
      min: 1,
      max: 500
    })
    const maxRecords = optionInteger(options, 'max-records', 1_000, {
      min: 1,
      max: 100_000
    })
    const unfail = booleanOption(options, 'unfail')

    return {
      command: 'wallet-review-proof-requests',
      description: unfail
        ? `Review ${status} proof requests and persist verified false failures as unfail.`
        : `Review ${status} proof requests without changing request state.`,
      effect: unfail ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || unfail,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        status,
        offset,
        pageSize,
        maxRecords,
        unfail
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Services, Setup, StorageKnex } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const status = plan.parameters.status as ReviewStatus
    const initialOffset = plan.parameters.offset as number
    const pageSize = plan.parameters.pageSize as number
    const maxRecords = plan.parameters.maxRecords as number
    const unfail = plan.parameters.unfail as boolean

    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })
    const servicesOptions = Services.createDefaultOptions(chain)
    servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
    const services = new Services(servicesOptions)
    storage.setServices(services)

    let review: Awaited<ReturnType<typeof findUnfailCandidates>>
    try {
      await storage.makeAvailable()
      review = await findUnfailCandidates(storage, services, status, initialOffset, pageSize, maxRecords)
      if (unfail) await unfailCandidates(storage, review.candidates)
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-review-proof-requests',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        status,
        initialOffset,
        reviewed: review.reviewed,
        candidates: review.candidates.length,
        unfail,
        updated: unfail ? review.candidates.length : 0
      }
    }
  }
}
