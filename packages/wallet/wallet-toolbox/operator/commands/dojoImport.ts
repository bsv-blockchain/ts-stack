import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

import type { Chain } from '../../out/src'
import { OperatorCommand, OperatorEvidence } from '../contracts'
import { explicitOutputPath, optionInteger, optionString } from '../safety'

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/

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

export const dojoImportCommand: OperatorCommand = {
  name: 'dojo-import',
  description: 'Import an explicitly selected Dojo database into Wallet Toolbox storage.',
  allowedOptions: new Set([
    'chain',
    'database-name',
    'destination-env',
    'destination-sqlite',
    'drop-existing',
    'identity-key-env',
    'max-chunks',
    'source-env'
  ]),
  plan(options) {
    const chain = parseChain(optionString(options, 'chain', 'test'))
    const prefix = chain === 'main' ? 'MAIN' : 'TEST'
    const sourceEnvironment = environmentName(
      optionString(options, 'source-env', `${prefix}_DOJO_CONNECTION`),
      'source-env'
    )
    const identityKeyEnvironment = environmentName(
      optionString(options, 'identity-key-env', chain === 'main' ? 'MY_MAIN_IDENTITY' : 'MY_TEST_IDENTITY'),
      'identity-key-env'
    )
    const destinationEnvironmentOption = options.get('destination-env')
    const destinationSqliteOption = options.get('destination-sqlite')
    if ((destinationEnvironmentOption === undefined) === (destinationSqliteOption === undefined)) {
      throw new Error('Choose exactly one of "--destination-env" or "--destination-sqlite"')
    }

    const destinationEnvironment =
      destinationEnvironmentOption === undefined
        ? undefined
        : environmentName(optionString(options, 'destination-env'), 'destination-env')
    const destinationSqlite =
      destinationSqliteOption === undefined ? undefined : explicitOutputPath(options, 'destination-sqlite')
    const dropExisting = booleanOption(options, 'drop-existing')
    const maxChunks = optionInteger(options, 'max-chunks', 10_000, {
      min: 1,
      max: 100_000
    })
    const databaseName = optionString(options, 'database-name', `dojo-import-${chain}`)

    return {
      command: 'dojo-import',
      description: 'Synchronize bounded Dojo chunks into an explicit destination.',
      effect: destinationEnvironment === undefined ? 'local-write' : 'remote-write',
      requiresProductionApproval: chain === 'main' || destinationEnvironment !== undefined,
      parameters: {
        chain,
        sourceEnvironment,
        sourceConfigured: Boolean(process.env[sourceEnvironment]),
        identityKeyEnvironment,
        identityKeyConfigured: Boolean(process.env[identityKeyEnvironment]),
        destinationKind: destinationEnvironment === undefined ? 'sqlite' : 'mysql-environment',
        destination: destinationEnvironment ?? (destinationSqlite as string),
        destinationConfigured:
          destinationEnvironment === undefined ? true : Boolean(process.env[destinationEnvironment]),
        databaseName,
        dropExisting,
        maxChunks
      }
    }
  },
  async execute(_options, plan): Promise<OperatorEvidence> {
    const { EntitySyncState, Setup, StorageKnex, sync } = await import('../../out/src/index.js')
    const startedAt = new Date().toISOString()
    const chain = plan.parameters.chain as Chain
    const sourceEnvironment = plan.parameters.sourceEnvironment as string
    const identityKeyEnvironment = plan.parameters.identityKeyEnvironment as string
    const destinationKind = plan.parameters.destinationKind as string
    const destination = plan.parameters.destination as string
    const databaseName = plan.parameters.databaseName as string
    const dropExisting = plan.parameters.dropExisting as boolean
    const maxChunks = plan.parameters.maxChunks as number

    if (
      destinationKind === 'sqlite' &&
      fs.existsSync(destination) &&
      fs.statSync(destination).size > 0 &&
      !dropExisting
    ) {
      throw new Error(`Refusing to import into existing SQLite database "${destination}" without "--drop-existing"`)
    }

    const sourceKnex = Setup.createMySQLKnex(requiredEnvironment(sourceEnvironment))
    const destinationKnex =
      destinationKind === 'sqlite'
        ? Setup.createSQLiteKnex(destination)
        : Setup.createMySQLKnex(requiredEnvironment(destination), databaseName)
    const reader = new sync.StorageMySQLDojoReader({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: sourceKnex
    })
    const writer = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: destinationKnex
    })

    let chunks = 0
    let inserts = 0
    let updates = 0
    try {
      if (dropExisting) await writer.dropAllData()
      await writer.migrate(databaseName, randomBytes(33).toString('hex'))
      await writer.makeAvailable()

      const readerSettings = await reader.getSettings()
      const writerSettings = await writer.getSettings()
      const identityKey = requiredEnvironment(identityKeyEnvironment)
      const syncState = await EntitySyncState.fromStorage(writer, identityKey, readerSettings)

      let done = false
      while (chunks < maxChunks && !done) {
        const args = syncState.makeRequestSyncChunkArgs(identityKey, writerSettings.storageIdentityKey)
        const chunk = await reader.getSyncChunk(args)
        const result = await syncState.processSyncChunk(writer, args, chunk)
        chunks++
        inserts += result.inserts
        updates += result.updates
        done = result.done
      }
      if (!done) {
        throw new Error(`Dojo import exceeded the configured ${maxChunks} chunk limit`)
      }

      return {
        command: 'dojo-import',
        startedAt,
        completedAt: new Date().toISOString(),
        result: {
          chain,
          destinationKind,
          databaseName,
          chunks,
          inserts,
          updates
        }
      }
    } finally {
      await reader.destroy()
      await writer.destroy()
    }
  }
}
