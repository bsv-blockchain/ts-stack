import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
async function loadSdk() {
  return await import('@bsv/sdk')
}
type SdkModule = Awaited<ReturnType<typeof loadSdk>>
type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type StoredProvenTransaction = Awaited<ReturnType<StorageInstance['findProvenTxs']>>[number]
type ProofOutcome = 'matched' | 'mismatched' | 'repaired' | 'unavailable'

interface ProofCounts {
  mismatched: number
  repaired: number
  reviewed: number
  unavailable: number
  verified: number
}

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

export async function reviewProvenTransaction(
  storage: StorageInstance,
  services: InstanceType<WalletModule['Services']>,
  sdk: SdkModule,
  transaction: StoredProvenTransaction,
  repair: boolean
): Promise<ProofOutcome> {
  const result = await services.getMerklePath(transaction.txid)
  if (result.header === undefined || result.merklePath === undefined) {
    return 'unavailable'
  }
  const merklePath = result.merklePath
  const merkleRoot = merklePath.computeRoot(transaction.txid)
  const index = merklePath.path[0]?.find(leaf => leaf.hash === transaction.txid)?.offset
  if (
    result.header.height !== merklePath.blockHeight ||
    result.header.merkleRoot !== merkleRoot ||
    index === undefined
  ) {
    throw new Error(`External merkle proof for ${transaction.txid} failed internal validation`)
  }
  const storedPath = sdk.MerklePath.fromBinary(transaction.merklePath)
  const changed =
    transaction.merkleRoot !== merkleRoot ||
    transaction.height !== merklePath.blockHeight ||
    transaction.blockHash !== result.header.hash ||
    transaction.index !== index ||
    storedPath.blockHeight !== transaction.height ||
    storedPath.computeRoot() !== transaction.merkleRoot ||
    sdk.Utils.toHex(transaction.merklePath) !== sdk.Utils.toHex(merklePath.toBinary())
  if (!changed) return 'matched'
  if (!repair) return 'mismatched'

  const update = {
    merklePath: merklePath.toBinary(),
    merkleRoot,
    height: merklePath.blockHeight,
    blockHash: result.header.hash,
    index
  }
  await storage.updateProvenTx(transaction.provenTxId, update)
  const persisted = await storage.findProvenTxById(transaction.provenTxId)
  if (
    persisted === undefined ||
    persisted.merkleRoot !== update.merkleRoot ||
    persisted.height !== update.height ||
    persisted.blockHash !== update.blockHash ||
    persisted.index !== update.index ||
    sdk.Utils.toHex(persisted.merklePath) !== sdk.Utils.toHex(update.merklePath)
  ) {
    throw new Error(`Proof repair for provenTxId ${transaction.provenTxId} did not persist exactly`)
  }
  return 'repaired'
}

function recordProofOutcome(counts: ProofCounts, outcome: ProofOutcome): void {
  counts.reviewed++
  if (outcome === 'unavailable') {
    counts.unavailable++
    return
  }
  counts.verified++
  if (outcome === 'mismatched' || outcome === 'repaired') counts.mismatched++
  if (outcome === 'repaired') counts.repaired++
}

async function reviewProofRange(
  storage: StorageInstance,
  services: InstanceType<WalletModule['Services']>,
  sdk: SdkModule,
  heightStart: number,
  heightEnd: number,
  maxRecords: number,
  repair: boolean
): Promise<ProofCounts> {
  const counts: ProofCounts = {
    mismatched: 0,
    repaired: 0,
    reviewed: 0,
    unavailable: 0,
    verified: 0
  }
  for (let height = heightStart; height <= heightEnd && counts.reviewed < maxRecords; height++) {
    const transactions = await storage.findProvenTxs({
      partial: { height },
      paged: { limit: maxRecords - counts.reviewed }
    })
    for (const transaction of transactions) {
      const outcome = await reviewProvenTransaction(storage, services, sdk, transaction, repair)
      recordProofOutcome(counts, outcome)
    }
  }
  return counts
}

export const walletRepairProvenTransactionsCommand: OperatorCommand = {
  name: 'wallet-repair-proven-transactions',
  description: 'Review stored proven-transaction proofs and optionally repair verified metadata mismatches.',
  allowedOptions: new Set([
    'chain',
    'database-env',
    'height-end',
    'height-start',
    'max-records',
    'repair',
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
    const heightStart = optionInteger(options, 'height-start', Number.NaN, { min: 0, max: 10_000_000 })
    const heightEnd = optionInteger(options, 'height-end', heightStart, {
      min: heightStart,
      max: Math.min(10_000_000, heightStart + 999)
    })
    const maxRecords = optionInteger(options, 'max-records', 10_000, {
      min: 1,
      max: 100_000
    })
    const repair = booleanOption(options, 'repair')

    return {
      command: 'wallet-repair-proven-transactions',
      description: repair
        ? 'Verify external merkle proofs and repair exact stored metadata mismatches.'
        : 'Review external merkle proofs without changing stored metadata.',
      effect: repair ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || repair,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        heightStart,
        heightEnd,
        maxRecords,
        repair
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
    const heightStart = plan.parameters.heightStart as number
    const heightEnd = plan.parameters.heightEnd as number
    const maxRecords = plan.parameters.maxRecords as number
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

    let counts: ProofCounts
    try {
      await storage.makeAvailable()
      counts = await reviewProofRange(storage, services, sdk, heightStart, heightEnd, maxRecords, repair)
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-repair-proven-transactions',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        heightStart,
        heightEnd,
        repair,
        ...counts
      }
    }
  }
}
