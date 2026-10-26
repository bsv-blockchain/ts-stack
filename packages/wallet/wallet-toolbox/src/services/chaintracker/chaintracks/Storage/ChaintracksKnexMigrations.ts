/* eslint-disable @typescript-eslint/no-explicit-any */
import { Knex } from 'knex'
import { Chain } from '../../../../sdk'

interface Migration {
  up: (knex: Knex) => PromiseLike<any>
  down?: (knex: Knex) => PromiseLike<any>
}

interface MigrationSource<TMigrationSpec> {
  getMigrations: (loadExtensions: readonly string[]) => Promise<TMigrationSpec[]>
  getMigrationName: (migration: TMigrationSpec) => string
  getMigration: (migration: TMigrationSpec) => Promise<Migration>
}

function isMySql(knex: Knex): boolean {
  const client = knex.client.config.client
  return client === 'mysql' || client === 'mysql2'
}

/** Builds the current Chaintracks schema. Exported so dialect DDL can be regression-tested without a live server. */
export function createChaintracksInitialSchema(knex: Knex): Knex.SchemaBuilder {
  const liveHeadersTableName = 'live_headers'
  const bulkFilesTableName = 'bulk_files'
  const stateTableName = 'chaintracks_state'
  const schema = knex.schema.createTable(liveHeadersTableName, table => {
    table.increments('headerId')
    table.integer('previousHeaderId').unsigned().references('headerId').inTable(liveHeadersTableName)
    table.string('previousHash', 64)
    table.integer('height').unsigned().notNullable()
    table.boolean('isActive').notNullable()
    table.boolean('isChainTip').notNullable()
    table.string('hash', 64).notNullable()
    table.string('chainWork', 64).notNullable()
    table.integer('version').unsigned().notNullable()
    table.string('merkleRoot', 64).notNullable()
    table.integer('time').unsigned().notNullable()
    table.integer('bits').unsigned().notNullable()
    table.integer('nonce').unsigned().notNullable()

    table.unique(['hash'])
    table.index(['previousHeaderId'])
    table.index(['height'])
    table.index(['previousHash'])
    table.index(['merkleRoot'])
    table.index(['isChainTip'])
    table.index(['isActive'])
    table.index(['isActive', 'isChainTip'])
  })

  schema.createTable(bulkFilesTableName, table => {
    table.increments('fileId')
    table.string('chain').notNullable()
    table.string('fileName').notNullable()
    table.integer('firstHeight').unsigned().notNullable()
    table.integer('count').unsigned().notNullable()
    table.string('prevHash', 64).notNullable() // hex encoded
    table.string('lastHash', 64).notNullable() // hex encoded
    table.string('prevChainWork', 64).notNullable() // hex encoded
    table.string('lastChainWork', 64).notNullable() // hex encoded
    table.string('fileHash').notNullable() // base64 encoded
    table.boolean('validated').defaultTo(false).notNullable()
    table.string('sourceUrl').nullable()
    if (isMySql(knex)) table.specificType('data', 'LONGBLOB').nullable()
    else table.binary('data').nullable()

    table.index(['firstHeight', 'chain'])
  })

  return schema.createTable(stateTableName, table => {
    table.integer('stateId').primary()
  })
}

export class ChaintracksKnexMigrations implements MigrationSource<string> {
  migrations: Record<string, Migration> = {}

  constructor(public chain: Chain) {
    this.migrations = this.setupMigrations()
  }

  async getMigrations(): Promise<string[]> {
    return Object.keys(this.migrations).sort((a, b) => a.localeCompare(b))
  }

  getMigrationName(migration: string) {
    return migration
  }

  async getMigration(migration: string): Promise<Migration> {
    return this.migrations[migration]
  }

  async getLatestMigration(): Promise<string> {
    const ms = await this.getMigrations()
    return ms.at(-1)!
  }

  static async latestMigration(): Promise<string> {
    const km = new ChaintracksKnexMigrations('test')
    return await km.getLatestMigration()
  }

  setupMigrations(): Record<string, Migration> {
    const migrations: Record<string, Migration> = {}

    const liveHeadersTableName = 'live_headers'
    const bulkFilesTableName = 'bulk_files'
    const stateTableName = 'chaintracks_state'

    migrations['2025-06-28-001 initial migration'] = {
      async up(knex) {
        await createChaintracksInitialSchema(knex)
        await knex(stateTableName).insert({ stateId: 1 })
      },
      async down(knex) {
        await knex.schema.dropTableIfExists(stateTableName)
        await knex.schema.dropTable(liveHeadersTableName)
        await knex.schema.dropTable(bulkFilesTableName)
      }
    }

    migrations['2026-09-17-001 repair MySQL live-header encodings and bulk blob'] = {
      async up(knex) {
        if (!(await knex.schema.hasTable(stateTableName))) {
          await knex.schema.createTable(stateTableName, table => {
            table.integer('stateId').primary()
          })
        }
        await knex(stateTableName).insert({ stateId: 1 }).onConflict('stateId').ignore()
        if (!isMySql(knex)) return

        // Legacy VARBINARY(32) columns received 64-byte ASCII hex strings. In
        // permissive MySQL modes those values were irreversibly truncated, so
        // the derived live-header cache must be rebuilt from authenticated bulk
        // headers after widening the columns. Strict modes rejected the writes.
        await knex(liveHeadersTableName).delete()
        await knex.schema.alterTable(liveHeadersTableName, table => {
          table.string('previousHash', 64).alter()
          table.string('hash', 64).notNullable().alter()
          table.string('chainWork', 64).notNullable().alter()
          table.string('merkleRoot', 64).notNullable().alter()
        })
        await knex.raw('ALTER TABLE ?? MODIFY ?? LONGBLOB NULL', [bulkFilesTableName, 'data'])
      },
      async down(_knex) {
        // Security migrations are intentionally not reversed to the truncating
        // legacy column types. A subsequent rollback of the initial migration
        // still removes the tables during dropAllData().
      }
    }

    return migrations
  }
}
