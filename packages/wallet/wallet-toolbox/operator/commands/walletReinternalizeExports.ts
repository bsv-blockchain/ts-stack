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

interface Brc29Instructions {
  type?: unknown
  derivationPrefix?: unknown
  derivationSuffix?: unknown
  payee?: unknown
}

interface ValidBrc29Instructions {
  derivationPrefix: string
  derivationSuffix: string
  payee: string
}

type WalletModule = typeof import('../../out/src/index.js')
type StorageInstance = InstanceType<WalletModule['StorageKnex']>
type StoredUser = Awaited<ReturnType<StorageInstance['findUsers']>>[number]
type ExportOutcome =
  'already-present' | 'candidate' | 'ignored' | 'internalized' | 'invalid-instructions' | 'missing-proof'

interface ExportCounts {
  alreadyPresent: number
  candidates: number
  internalized: number
  invalidInstructions: number
  missingProofs: number
}

interface ReviewExportPagesArguments {
  storage: StorageInstance
  sourceUser: StoredUser
  destinationUsers: StoredUser[]
  fromUserId: number
  initialAfterOutputId: number
  pageSize: number
  maxRecords: number
  internalize: boolean
}

function parseUserIds(value: string): number[] {
  const values = value.split(',').map(candidate => Number(candidate.trim()))
  if (
    values.length < 1 ||
    values.length > 100 ||
    values.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error('Operator option "--to-user-ids" must contain 1 through 100 unique positive integer IDs')
  }
  return values
}

export function parseInstructions(value: string): ValidBrc29Instructions | undefined {
  let instructions: Brc29Instructions
  try {
    instructions = JSON.parse(value) as Brc29Instructions
  } catch {
    return undefined
  }
  if (
    instructions.type !== 'BRC29' ||
    typeof instructions.derivationPrefix !== 'string' ||
    instructions.derivationPrefix === '' ||
    typeof instructions.derivationSuffix !== 'string' ||
    instructions.derivationSuffix === '' ||
    typeof instructions.payee !== 'string'
  ) {
    return undefined
  }
  return {
    derivationPrefix: instructions.derivationPrefix,
    derivationSuffix: instructions.derivationSuffix,
    payee: instructions.payee
  }
}

async function internalizeExport(
  storage: StorageInstance,
  sourceUser: StoredUser,
  destinationUser: StoredUser,
  output: NonNullable<Awaited<ReturnType<typeof findOutputWithoutScript>>>,
  instructions: ValidBrc29Instructions
): Promise<void> {
  const txid = output.txid as string
  const beef = await storage.getBeefForTransaction(txid, {})
  const result = await storage.internalizeAction(
    {
      userId: destinationUser.userId,
      identityKey: destinationUser.identityKey
    },
    {
      tx: beef.toBinaryAtomic(txid),
      outputs: [
        {
          outputIndex: output.vout,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: instructions.derivationPrefix,
            derivationSuffix: instructions.derivationSuffix,
            senderIdentityKey: sourceUser.identityKey
          }
        }
      ],
      description: 'Internalizing export funds into destination wallet'
    }
  )
  if (result.txid !== txid) {
    throw new Error(`Internalized transaction did not return expected txid ${txid}`)
  }
  const persisted = await storage.findOutputs({
    partial: {
      userId: destinationUser.userId,
      txid,
      vout: output.vout
    },
    noScript: true
  })
  if (persisted.length !== 1) {
    throw new Error(`Internalized output ${txid}.${output.vout} did not persist exactly once`)
  }
}

export async function reviewExportOutput(
  storage: StorageInstance,
  outputId: number,
  sourceUser: StoredUser,
  destinationUsers: StoredUser[],
  internalize: boolean
): Promise<ExportOutcome> {
  const output = await findOutputWithoutScript(storage, outputId)
  if (output === undefined || output.txid === undefined || output.customInstructions === undefined) {
    return 'invalid-instructions'
  }
  const instructions = parseInstructions(output.customInstructions)
  if (instructions === undefined) return 'invalid-instructions'
  const destinationUser = destinationUsers.find(user => user.identityKey === instructions.payee)
  if (destinationUser === undefined) return 'ignored'

  const existing = await storage.findOutputs({
    partial: {
      userId: destinationUser.userId,
      txid: output.txid,
      vout: output.vout
    },
    noScript: true
  })
  if (existing.length > 0) return 'already-present'
  const requests = await storage.findProvenTxReqs({
    partial: { txid: output.txid, status: 'completed' }
  })
  if (requests.length !== 1) return 'missing-proof'
  if (!internalize) return 'candidate'
  await internalizeExport(storage, sourceUser, destinationUser, output, instructions)
  return 'internalized'
}

async function findExactUser(
  storage: StorageInstance,
  userId: number,
  role: 'destination' | 'source'
): Promise<StoredUser> {
  const users = await storage.findUsers({ partial: { userId } })
  if (users.length !== 1) {
    throw new Error(`Expected exactly one ${role} wallet user for userId ${userId}`)
  }
  return users[0]
}

function recordExportOutcome(counts: ExportCounts, outcome: ExportOutcome): void {
  switch (outcome) {
    case 'already-present':
      counts.alreadyPresent++
      break
    case 'candidate':
      counts.candidates++
      break
    case 'internalized':
      counts.candidates++
      counts.internalized++
      break
    case 'invalid-instructions':
      counts.invalidInstructions++
      break
    case 'missing-proof':
      counts.missingProofs++
      break
  }
}

async function reviewExportPages({
  storage,
  sourceUser,
  destinationUsers,
  fromUserId,
  initialAfterOutputId,
  pageSize,
  maxRecords,
  internalize
}: ReviewExportPagesArguments): Promise<{ counts: ExportCounts; finalOutputId: number; reviewed: number }> {
  const counts: ExportCounts = {
    alreadyPresent: 0,
    candidates: 0,
    internalized: 0,
    invalidInstructions: 0,
    missingProofs: 0
  }
  let reviewed = 0
  let afterOutputId = initialAfterOutputId
  while (reviewed < maxRecords) {
    const limit = Math.min(pageSize, maxRecords - reviewed)
    const rows = await storage
      .toDb()<{ outputId: number }>('outputs')
      .where('outputId', '>', afterOutputId)
      .where('userId', fromUserId)
      .whereNotNull('customInstructions')
      .orderBy('outputId', 'asc')
      .limit(limit)
      .select('outputId')

    for (const row of rows) {
      afterOutputId = row.outputId
      reviewed++
      const outcome = await reviewExportOutput(storage, row.outputId, sourceUser, destinationUsers, internalize)
      recordExportOutcome(counts, outcome)
    }
    if (rows.length < limit) break
  }
  return { counts, finalOutputId: afterOutputId, reviewed }
}

export const walletReinternalizeExportsCommand: OperatorCommand = {
  name: 'wallet-reinternalize-exports',
  description: 'Review and optionally internalize exact BRC-29 export outputs into intended destination wallets.',
  allowedOptions: new Set([
    'after-output-id',
    'chain',
    'database-env',
    'from-user-id',
    'internalize',
    'max-records',
    'page-size',
    'to-user-ids'
  ]),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'main'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const databaseEnvironment = environmentName(
      optionString(options, 'database-env', `${prefix}_CLOUD_MYSQL_CONNECTION`),
      'database-env'
    )
    const fromUserId = optionInteger(options, 'from-user-id', Number.NaN, { min: 1, max: Number.MAX_SAFE_INTEGER })
    const toUserIds = parseUserIds(optionString(options, 'to-user-ids'))
    if (toUserIds.includes(fromUserId)) {
      throw new Error('Operator options must not include --from-user-id in --to-user-ids')
    }
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
    const internalize = booleanOption(options, 'internalize')

    return {
      command: 'wallet-reinternalize-exports',
      description: internalize
        ? 'Review exact BRC-29 export candidates and internalize verified missing outputs.'
        : 'Review exact BRC-29 export candidates without changing wallet state.',
      effect: internalize ? 'remote-write' : 'read-only',
      requiresProductionApproval: chain === 'main' || internalize,
      parameters: {
        chain,
        databaseEnvironment,
        databaseConfigured: Boolean(process.env[databaseEnvironment]),
        fromUserId,
        toUserIds: toUserIds.join(','),
        destinationUsers: toUserIds.length,
        afterOutputId,
        pageSize,
        maxRecords,
        internalize
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { Setup, StorageKnex } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const databaseEnvironment = plan.parameters.databaseEnvironment as string
    const fromUserId = plan.parameters.fromUserId as number
    const toUserIds = parseUserIds(plan.parameters.toUserIds as string)
    const initialAfterOutputId = plan.parameters.afterOutputId as number
    const pageSize = plan.parameters.pageSize as number
    const maxRecords = plan.parameters.maxRecords as number
    const internalize = plan.parameters.internalize as boolean

    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
    })

    let review: Awaited<ReturnType<typeof reviewExportPages>>
    try {
      await storage.makeAvailable()
      const sourceUser = await findExactUser(storage, fromUserId, 'source')
      const destinationUsers = await Promise.all(
        toUserIds.map(async userId => await findExactUser(storage, userId, 'destination'))
      )
      review = await reviewExportPages({
        storage,
        sourceUser,
        destinationUsers,
        fromUserId,
        initialAfterOutputId,
        pageSize,
        maxRecords,
        internalize
      })
    } finally {
      await storage.destroy()
    }

    return {
      command: 'wallet-reinternalize-exports',
      startedAt,
      completedAt: new Date().toISOString(),
      result: {
        chain,
        fromUserId,
        destinationUsers: toUserIds.length,
        internalize,
        initialAfterOutputId,
        finalOutputId: review.finalOutputId,
        reviewed: review.reviewed,
        ...review.counts
      }
    }
  }
}
