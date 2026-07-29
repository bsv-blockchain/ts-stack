import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { environmentName, optionInteger, optionString, parseChain, requiredEnvironment } from '../safety'

function reference(value: string): string {
  if (value.length < 1 || value.length > 512 || /\s/.test(value)) {
    throw new Error('Operator option "--reference" must be a non-whitespace wallet reference or transaction ID')
  }
  return value
}

export const walletAbortActionCommand: OperatorCommand = {
  name: 'wallet-abort-action',
  description: 'Abort one exact in-flight wallet action for one exact user.',
  allowedOptions: new Set(['chain', 'database-env', 'reference', 'user-id']),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'main'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const databaseEnvironment = environmentName(
      optionString(options, 'database-env', `${prefix}_CLOUD_MYSQL_CONNECTION`),
      'database-env'
    )
    const userId = optionInteger(options, 'user-id', Number.NaN, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    })
    const actionReference = reference(optionString(options, 'reference'))
    return {
      command: 'wallet-abort-action',
      description: 'Abort exactly one selected wallet action.',
      effect: 'remote-write',
      requiresProductionApproval: true,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        userId,
        reference: actionReference
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Setup, StorageKnex } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const userId = plan.parameters.userId as number
    const actionReference = plan.parameters.reference as string
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })

    let previousStatus = ''
    let finalStatus = ''
    try {
      await storage.makeAvailable()
      const [referenceMatches, txidMatches] = await Promise.all([
        storage.findTransactions({
          partial: { userId, reference: actionReference }
        }),
        storage.findTransactions({
          partial: { userId, txid: actionReference }
        })
      ])
      const matching = [
        ...new Map(
          [...referenceMatches, ...txidMatches].map(transaction => [transaction.transactionId, transaction])
        ).values()
      ]
      if (matching.length !== 1) {
        throw new Error(`Expected exactly one transaction matching the supplied reference; found ${matching.length}`)
      }
      const transaction = matching[0]
      previousStatus = transaction.status
      const result = await storage.abortAction({ userId, identityKey: '' }, { reference: actionReference })
      if (result.aborted !== true) {
        throw new Error('Wallet storage did not confirm that the action was aborted')
      }
      const updated = await storage.findTransactionById(transaction.transactionId)
      if (updated === undefined || updated.status !== 'failed') {
        throw new Error('Aborted wallet action did not persist with failed status')
      }
      finalStatus = updated.status
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-abort-action',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        userId,
        previousStatus,
        finalStatus,
        aborted: true
      }
    }
  }
}
