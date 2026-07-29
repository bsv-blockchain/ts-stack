import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { booleanOption, environmentName, optionString, parseChain, requiredEnvironment } from '../safety'

type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type SdkNamespace = WalletModule['sdk']
type ListedOutput = Awaited<ReturnType<StorageInstance['listOutputs']>>['outputs'][number]

function parseUserIds(value: string): number[] {
  const values = value.split(',').map(candidate => Number(candidate.trim()))
  if (
    values.length === 0 ||
    values.length > 100 ||
    values.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error('Operator option "--user-ids" must contain 1 through 100 unique positive integer IDs')
  }
  return values
}

async function verifyReleasedOutputs(
  storage: StorageInstance,
  sdk: SdkNamespace,
  userId: number,
  outputs: ListedOutput[]
): Promise<void> {
  for (const output of outputs) {
    const { txid, vout } = sdk.Validation.parseWalletOutpoint(output.outpoint)
    const stored = await storage.findOutputs({
      partial: { userId, txid, vout }
    })
    if (stored.length !== 1 || stored[0].spendable !== false) {
      throw new Error(`Released output ${output.outpoint} did not persist as unspendable`)
    }
  }
}

async function reviewUserOutputs(
  storage: StorageInstance,
  sdk: SdkNamespace,
  userId: number,
  scope: 'all' | 'change',
  release: boolean
): Promise<{ invalidOutputs: number; invalidSatoshis: number }> {
  const users = await storage.findUsers({ partial: { userId } })
  if (users.length !== 1) {
    throw new Error(`Expected exactly one wallet user for userId ${userId}`)
  }
  const tags = [...(release ? ['release'] : []), ...(scope === 'all' ? ['all'] : [])]
  const result = await storage.listOutputs(
    { userId, identityKey: '' },
    {
      basket: sdk.specOpInvalidChange,
      tags,
      tagQueryMode: 'all',
      includeLockingScripts: false,
      includeTransactions: false,
      includeCustomInstructions: false,
      includeTags: false,
      includeLabels: false,
      limit: 0,
      offset: 0,
      seekPermission: false,
      knownTxids: []
    }
  )
  if (release) await verifyReleasedOutputs(storage, sdk, userId, result.outputs)
  return {
    invalidOutputs: result.totalOutputs,
    invalidSatoshis: result.outputs.reduce((sum, output) => sum + output.satoshis, 0)
  }
}

export const walletReviewOutputsCommand: OperatorCommand = {
  name: 'wallet-review-outputs',
  description: 'Review invalid wallet outputs and optionally release them.',
  allowedOptions: new Set(['chain', 'database-env', 'release', 'scope', 'user-ids', 'whatsonchain-api-key-env']),
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
    const userIds = parseUserIds(optionString(options, 'user-ids'))
    const release = booleanOption(options, 'release')
    const scope = optionString(options, 'scope', 'change')
    if (scope !== 'change' && scope !== 'all') {
      throw new Error('Operator option "--scope" must be "change" or "all"')
    }

    return {
      command: 'wallet-review-outputs',
      description: release
        ? 'Review invalid outputs and mark confirmed invalid outputs unspendable.'
        : 'Review invalid outputs without changing wallet state.',
      effect: release ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || release,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        whatsonchainApiKeyEnvironment,
        whatsonchainApiKeyConfigured: Boolean(process.env[whatsonchainApiKeyEnvironment]),
        userIds: userIds.join(','),
        userCount: userIds.length,
        scope,
        release
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Services, Setup, StorageKnex, sdk } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const whatsonchainApiKeyEnvironment = plan.parameters.whatsonchainApiKeyEnvironment as string
    const userIds = parseUserIds(plan.parameters.userIds as string)
    const scope = plan.parameters.scope as 'all' | 'change'
    const release = plan.parameters.release as boolean

    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })
    const servicesOptions = Services.createDefaultOptions(chain)
    servicesOptions.whatsOnChainApiKey = process.env[whatsonchainApiKeyEnvironment]
    const services = new Services(servicesOptions)
    storage.setServices(services)

    let invalidOutputs = 0
    let invalidSatoshis = 0
    try {
      await storage.makeAvailable()
      for (const userId of userIds) {
        const result = await reviewUserOutputs(storage, sdk, userId, scope, release)
        invalidOutputs += result.invalidOutputs
        invalidSatoshis += result.invalidSatoshis
      }
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-review-outputs',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        scope,
        release,
        reviewedUsers: userIds.length,
        invalidOutputs,
        invalidSatoshis
      }
    }
  }
}
