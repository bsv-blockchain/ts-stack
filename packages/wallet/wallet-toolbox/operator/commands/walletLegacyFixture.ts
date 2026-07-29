import path from 'node:path'
import { promises as fs } from 'node:fs'

import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
const IDENTITY_KEY = /^(02|03)[0-9a-fA-F]{64}$/

type Mode = 'copy' | 'purge'
type WalletModule = typeof import('../../out/src/index.js')

function environmentName(value: string, option: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error(`Operator option "--${option}" must name an uppercase environment variable`)
  }
  return value
}

function parseMode(value: string): Mode {
  if (value !== 'copy' && value !== 'purge') {
    throw new Error('Operator option "--mode" must be "copy" or "purge"')
  }
  return value
}

function identityKey(value: string): string {
  if (!IDENTITY_KEY.test(value)) {
    throw new Error('Operator option "--identity-key" must be a compressed public identity key')
  }
  return value.toLowerCase()
}

function booleanOption(options: ReadonlyMap<string, string | true>, name: string): boolean {
  const value = options.get(name)
  if (value !== undefined && value !== true) {
    throw new Error(`Operator option "--${name}" does not accept a value`)
  }
  return value === true
}

function optionalEnvironment(options: ReadonlyMap<string, string | true>, name: string): string | undefined {
  if (options.get(name) === undefined) return undefined
  return environmentName(optionString(options, name), name)
}

function optionalSqlitePath(options: ReadonlyMap<string, string | true>): string | undefined {
  if (options.get('destination-sqlite') === undefined) return undefined
  const resolved = path.resolve(optionString(options, 'destination-sqlite'))
  if (path.extname(resolved).toLowerCase() !== '.sqlite') {
    throw new Error('Operator option "--destination-sqlite" must identify a SQLite file')
  }
  return resolved
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable "${name}" is not set`)
  }
  return value
}

export async function prepareSqliteDestination(destinationSqlite: string, dropExisting: boolean): Promise<void> {
  if (destinationSqlite === '') return
  await fs.mkdir(path.dirname(destinationSqlite), { recursive: true })
  if (dropExisting) return
  try {
    await fs.access(destinationSqlite)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
  throw new Error('Destination SQLite file already exists; use --drop-existing to replace it')
}

async function copyLegacyFixture(
  plan: Parameters<OperatorCommand['execute']>[1],
  runtime: WalletModule
): Promise<Record<string, boolean | number | string>> {
  const { Setup, StorageKnex, StorageSyncReader, WalletStorageManager, randomBytesHex } = runtime
  const chain: Chain = 'test'
  const selectedIdentityKey = plan.parameters.identityKey as string
  const sourceEnvironment = plan.parameters.sourceEnvironment as string
  const destinationEnvironment = plan.parameters.destinationEnvironment as string
  const destinationSqlite = plan.parameters.destinationSqlite as string
  const dropExisting = plan.parameters.dropExisting as boolean
  const source = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain,
    knex: Setup.createMySQLKnex(requiredEnvironment(sourceEnvironment))
  })
  const destinationKnex =
    destinationSqlite === ''
      ? Setup.createMySQLKnex(requiredEnvironment(destinationEnvironment))
      : Setup.createSQLiteKnex(destinationSqlite)
  const destination = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain,
    knex: destinationKnex
  })
  try {
    await source.makeAvailable()
    await prepareSqliteDestination(destinationSqlite, dropExisting)
    if (dropExisting) await destination.dropAllData()
    await destination.migrate(plan.parameters.storageName as string, randomBytesHex(33))
    await destination.makeAvailable()
    const manager = new WalletStorageManager(selectedIdentityKey, destination)
    await manager.makeAvailable()
    const sync = await manager.syncFromReader(
      selectedIdentityKey,
      new StorageSyncReader({ identityKey: selectedIdentityKey }, source)
    )
    const destinationUser = await destination.findUserByIdentityKey(selectedIdentityKey)
    if (destinationUser === undefined) {
      throw new Error('Fixture copy completed without the selected destination user')
    }
    return {
      mode: 'copy',
      chain,
      destination: destinationSqlite === '' ? destinationEnvironment : destinationSqlite,
      inserts: sync.inserts,
      updates: sync.updates,
      destinationUserId: destinationUser.userId
    }
  } finally {
    await Promise.allSettled([source.destroy(), destination.destroy()])
  }
}

async function purgeLegacyFixture(
  plan: Parameters<OperatorCommand['execute']>[1],
  runtime: WalletModule
): Promise<Record<string, boolean | number | string>> {
  const { Monitor, Services, Setup, StorageKnex, Task, WalletStorageManager } = runtime
  const chain: Chain = 'test'
  const selectedIdentityKey = plan.parameters.identityKey as string
  const databaseEnvironment = plan.parameters.databaseEnvironment as string
  const storage = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain,
    knex: Setup.createMySQLKnex(requiredEnvironment(databaseEnvironment))
  })
  try {
    await storage.makeAvailable()
    const manager = new WalletStorageManager(selectedIdentityKey, storage)
    await manager.makeAvailable()
    const services = new Services(chain)
    manager.setServices(services)
    const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, manager, services))
    const maxAgeDays = plan.parameters.maxAgeDays as number
    const task = new Task.TaskPurge(monitor, {
      purgeCompleted: true,
      purgeFailed: true,
      purgeSpent: true,
      purgeCompletedAge: maxAgeDays,
      purgeFailedAge: maxAgeDays,
      purgeSpentAge: maxAgeDays
    })
    const log = await task.runTask()
    return {
      mode: 'purge',
      chain,
      maxAgeDays,
      changed: log !== '',
      log
    }
  } finally {
    await storage.destroy()
  }
}

export const walletLegacyFixtureCommand: OperatorCommand = {
  name: 'wallet-legacy-fixture',
  description: 'Copy or prune an explicitly selected test-chain wallet fixture.',
  allowedOptions: new Set([
    'database-env',
    'destination-env',
    'destination-sqlite',
    'drop-existing',
    'identity-key',
    'max-age-days',
    'mode',
    'source-env',
    'storage-name'
  ]),
  plan(options) {
    const mode = parseMode(optionString(options, 'mode'))
    const sourceEnvironment = optionalEnvironment(options, 'source-env')
    const databaseEnvironment = optionalEnvironment(options, 'database-env')
    const destinationEnvironment = optionalEnvironment(options, 'destination-env')
    const destinationSqlite = optionalSqlitePath(options)
    const selectedIdentityKey = identityKey(optionString(options, 'identity-key'))
    const storageName = optionString(options, 'storage-name', 'walletLegacyTestData')
    if (storageName.length > 128) {
      throw new Error('Operator option "--storage-name" must be at most 128 characters')
    }
    const dropExisting = booleanOption(options, 'drop-existing')
    const maxAgeDays = optionInteger(options, 'max-age-days', 1, {
      min: 1,
      max: 3_650
    })

    const copyInputsValid =
      mode === 'copy' &&
      sourceEnvironment !== undefined &&
      databaseEnvironment === undefined &&
      Number(destinationEnvironment !== undefined) + Number(destinationSqlite !== undefined) === 1
    const purgeInputsValid =
      mode === 'purge' &&
      databaseEnvironment !== undefined &&
      sourceEnvironment === undefined &&
      destinationEnvironment === undefined &&
      destinationSqlite === undefined &&
      !dropExisting
    if (!copyInputsValid && !purgeInputsValid) {
      throw new Error('Copy mode needs --source-env and exactly one destination; purge mode needs only --database-env')
    }

    return {
      command: 'wallet-legacy-fixture',
      description:
        mode === 'copy'
          ? 'Copy one test-chain wallet identity into an explicit fixture destination.'
          : 'Purge transient records from one explicit test-chain fixture database.',
      effect: mode === 'copy' && destinationSqlite !== undefined ? 'local-write' : 'remote-write',
      requiresProductionApproval: false,
      parameters: {
        mode,
        chain: 'test',
        sourceEnvironment: sourceEnvironment ?? '',
        sourceConfigured: Boolean(sourceEnvironment && process.env[sourceEnvironment]),
        databaseEnvironment: databaseEnvironment ?? '',
        databaseConfigured: Boolean(databaseEnvironment && process.env[databaseEnvironment]),
        destinationEnvironment: destinationEnvironment ?? '',
        destinationConfigured: Boolean(destinationEnvironment && process.env[destinationEnvironment]),
        destinationSqlite: destinationSqlite ?? '',
        identityKey: selectedIdentityKey,
        storageName,
        dropExisting,
        maxAgeDays
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const runtime = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const mode = plan.parameters.mode as Mode
    const result = mode === 'copy' ? await copyLegacyFixture(plan, runtime) : await purgeLegacyFixture(plan, runtime)

    return {
      command: 'wallet-legacy-fixture',
      startedAt,
      completedAt: new Date().toISOString(),
      result
    }
  }
}
