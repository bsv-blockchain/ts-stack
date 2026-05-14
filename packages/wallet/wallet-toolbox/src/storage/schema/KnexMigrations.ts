/* eslint-disable @typescript-eslint/no-unused-vars */
import { Knex } from 'knex'
import { DBType } from '../StorageReader'
import { Chain } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
import { WERR_NOT_IMPLEMENTED } from '../../sdk/WERR_errors'

interface Migration {
  up: (knex: Knex) => Promise<void>
  down?: (knex: Knex) => Promise<void>
  config?: object
}

interface MigrationSource<TMigrationSpec> {
  getMigrations: (loadExtensions: readonly string[]) => Promise<TMigrationSpec[]>
  getMigrationName: (migration: TMigrationSpec) => string
  getMigration: (migration: TMigrationSpec) => Promise<Migration>
}

/**
 * v3 greenfield schema — see `docs/v3-upgrade/SCHEMA_V4.md`.
 *
 *  - `transactions` keyed by `txid` (canonical chain record).
 *  - `actions` per-user (PK actionId, FK txid nullable for unsigned drafts).
 *  - `outputs` FK actionId, with denormalised txid + `spentByActionId`.
 *  - `commissions` FK actionId. `tx_audit(txid, actionId)`. `tx_labels_map.actionId`.
 *
 * No bridge tables. No `runSchemaCutover`. Fresh installs get the canonical
 * layout from a single migration; v2 deployments perform their own ETL.
 */
export class KnexMigrations implements MigrationSource<string> {
  migrations: Record<string, Migration> = {}

  constructor (
    public chain: Chain,
    public storageName: string,
    public storageIdentityKey: string,
    public maxOutputScriptLength: number
  ) {
    this.migrations = this.setupMigrations(chain, storageName, storageIdentityKey, maxOutputScriptLength)
  }

  async getMigrations (): Promise<string[]> { return Object.keys(this.migrations).sort((a, b) => a.localeCompare(b)) }
  getMigrationName (m: string) { return m }
  async getMigration (m: string): Promise<Migration> { return this.migrations[m] }
  async getLatestMigration (): Promise<string> { return (await this.getMigrations()).at(-1)! }
  static async latestMigration (): Promise<string> {
    return await new KnexMigrations('test', 'dummy', '1'.repeat(64), 100).getLatestMigration()
  }

  setupMigrations (
    chain: string,
    storageName: string,
    storageIdentityKey: string,
    maxOutputScriptLength: number
  ): Record<string, Migration> {
    const migrations: Record<string, Migration> = {}

    const addTimeStamps = (knex: Knex<any, any[]>, table: Knex.CreateTableBuilder, dbtype: DBType) => {
      const nowFn = dbtype === 'MySQL' ? knex.fn.now(3) : knex.fn.now()
      table.timestamp('created_at', { precision: 3 }).defaultTo(nowFn).notNullable()
      table.timestamp('updated_at', { precision: 3 }).defaultTo(nowFn).notNullable()
    }

    migrations['2026-05-14-001 v3 initial schema'] = {
      async up (knex) {
        const dbtype = await determineDBType(knex)
        const nowFn = dbtype === 'MySQL' ? knex.fn.now(3) : knex.fn.now()

        await knex.schema.createTable('users', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('userId')
          table.string('identityKey', 130).notNullable().unique()
          table.string('activeStorage', 130).nullable()
        })

        await knex.schema.createTable('transactions', table => {
          addTimeStamps(knex, table, dbtype)
          table.string('txid', 64).notNullable().primary()
          table.string('processing', 16).notNullable().defaultTo('queued')
          table.timestamp('processing_changed_at', { precision: 3 }).defaultTo(nowFn).notNullable()
          table.timestamp('next_action_at', { precision: 3 }).nullable()
          table.integer('attempts').unsigned().notNullable().defaultTo(0)
          table.integer('rebroadcast_cycles').unsigned().notNullable().defaultTo(0)
          table.boolean('was_broadcast').notNullable().defaultTo(false)
          table.string('idempotency_key', 128).nullable().unique()
          table.string('batch', 64).nullable()
          table.binary('raw_tx').nullable()
          table.binary('input_beef').nullable()
          table.integer('height').unsigned().nullable()
          table.integer('merkle_index').unsigned().nullable()
          table.binary('merkle_path').nullable()
          table.string('merkle_root', 64).nullable()
          table.string('block_hash', 64).nullable()
          table.boolean('is_coinbase').notNullable().defaultTo(false)
          table.string('last_provider', 64).nullable()
          table.string('last_provider_status', 64).nullable()
          table.string('frozen_reason', 255).nullable()
          table.integer('row_version').unsigned().notNullable().defaultTo(0)
          table.index('processing')
          table.index('batch')
          table.index(['processing', 'next_action_at'], 'idx_tx_processing_next')
        })

        await knex.schema.createTable('actions', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('actionId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('txid', 64).nullable().references('txid').inTable('transactions')
          table.string('reference', 64).notNullable()
          table.string('description', 2000).notNullable().defaultTo('')
          table.boolean('isOutgoing').notNullable()
          table.bigint('satoshis_delta').notNullable().defaultTo(0)
          table.integer('version').unsigned().nullable()
          table.integer('lockTime').unsigned().nullable()
          table.boolean('user_nosend').notNullable().defaultTo(false)
          table.boolean('hidden').notNullable().defaultTo(false)
          table.boolean('user_aborted').notNullable().defaultTo(false)
          table.binary('raw_tx_draft').nullable()
          table.binary('input_beef_draft').nullable()
          table.text('notify_json', 'longtext').nullable()
          table.integer('row_version').unsigned().notNullable().defaultTo(0)
          table.unique(['userId', 'reference'])
          table.unique(['userId', 'txid'])
          table.index(['userId', 'hidden'], 'idx_actions_user_hidden')
          table.index('txid')
        })

        await knex.schema.createTable('output_baskets', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('basketId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('name', 300).notNullable()
          table.integer('numberOfDesiredUTXOs').notNullable().defaultTo(24)
          table.bigint('minimumDesiredUTXOValue').notNullable().defaultTo(1000)
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['userId', 'name'])
        })

        await knex.schema.createTable('output_tags', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('outputTagId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('tag', 300).notNullable()
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['userId', 'tag'])
        })

        await knex.schema.createTable('tx_labels', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('txLabelId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('label', 300).notNullable()
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['userId', 'label'])
        })

        await knex.schema.createTable('outputs', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('outputId')
          table.integer('actionId').unsigned().notNullable().references('actionId').inTable('actions')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.integer('basketId').unsigned().nullable().references('basketId').inTable('output_baskets')
          table.integer('vout').notNullable()
          table.bigint('satoshis').notNullable()
          table.boolean('spendable').notNullable().defaultTo(false)
          table.boolean('change').notNullable().defaultTo(false)
          table.boolean('is_coinbase').notNullable().defaultTo(false)
          table.integer('matures_at_height').unsigned().nullable()
          table.string('outputDescription', 300).notNullable().defaultTo('')
          table.string('spendingDescription', 300).nullable()
          table.string('providedBy', 16).notNullable()
          table.string('purpose', 16).notNullable().defaultTo('')
          table.string('type', 16).notNullable().defaultTo('custom')
          table.string('txid', 64).nullable()
          table.integer('spentByActionId').unsigned().nullable().references('actionId').inTable('actions')
          table.string('senderIdentityKey', 130).nullable()
          table.string('derivationPrefix', 32).nullable()
          table.string('derivationSuffix', 32).nullable()
          table.string('customInstructions', 2500).nullable()
          table.integer('sequenceNumber').unsigned().nullable()
          table.bigint('scriptLength').unsigned().nullable()
          table.bigint('scriptOffset').unsigned().nullable()
          table.binary('lockingScript').nullable()
          table.unique(['actionId', 'vout'])
          table.index(['userId', 'basketId', 'spendable', 'satoshis'], 'idx_outputs_user_basket_spendable_satoshis')
          table.index(['userId', 'spendable', 'outputId'], 'idx_outputs_user_spendable_outputid')
          table.index(['userId', 'txid'], 'idx_outputs_user_txid')
          table.index('spentByActionId', 'idx_outputs_spentbyactionid')
          table.index('matures_at_height', 'idx_outputs_matures_at_height')
        })

        await knex.schema.createTable('commissions', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('commissionId')
          table.integer('actionId').unsigned().notNullable().references('actionId').inTable('actions').unique()
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.bigint('satoshis').notNullable()
          table.string('keyOffset', 255).notNullable()
          table.boolean('isRedeemed').notNullable().defaultTo(false)
          table.binary('lockingScript').notNullable()
        })

        await knex.schema.createTable('output_tags_map', table => {
          addTimeStamps(knex, table, dbtype)
          table.integer('outputTagId').unsigned().notNullable().references('outputTagId').inTable('output_tags')
          table.integer('outputId').unsigned().notNullable().references('outputId').inTable('outputs')
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['outputTagId', 'outputId'])
          table.index('outputId')
          table.index(['outputId', 'isDeleted', 'outputTagId'], 'idx_output_tags_map_output_deleted_tag')
        })

        await knex.schema.createTable('tx_labels_map', table => {
          addTimeStamps(knex, table, dbtype)
          table.integer('txLabelId').unsigned().notNullable().references('txLabelId').inTable('tx_labels')
          table.integer('actionId').unsigned().notNullable().references('actionId').inTable('actions')
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['txLabelId', 'actionId'])
          table.index('actionId')
          table.index(['actionId', 'isDeleted'], 'idx_tx_labels_map_action_deleted')
        })

        await knex.schema.createTable('tx_audit', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('auditId')
          table.string('txid', 64).nullable().references('txid').inTable('transactions')
          table.integer('actionId').unsigned().nullable().references('actionId').inTable('actions')
          table.string('event', 64).notNullable()
          table.string('from_state', 16).nullable()
          table.string('to_state', 16).nullable()
          table.text('details_json', 'longtext').nullable()
          table.index('event')
          table.index('txid')
          table.index('actionId')
        })

        await knex.schema.createTable('chain_tip', table => {
          addTimeStamps(knex, table, dbtype)
          table.integer('id').notNullable().primary()
          table.integer('height').unsigned().notNullable()
          table.string('block_hash', 64).notNullable()
          table.string('merkle_root', 64).nullable()
          table.timestamp('observed_at', { precision: 3 }).defaultTo(nowFn).notNullable()
        })

        await knex.schema.createTable('monitor_lease', table => {
          addTimeStamps(knex, table, dbtype)
          table.string('task_name', 64).notNullable().primary()
          table.string('owner_id', 64).notNullable()
          table.timestamp('expires_at', { precision: 3 }).notNullable()
          table.integer('renew_count').unsigned().notNullable().defaultTo(0)
          table.string('note', 255).nullable()
          table.index('expires_at')
        })

        await knex.schema.createTable('monitor_events', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('id')
          table.string('event', 64).notNullable()
          table.text('details', 'longtext').nullable()
          table.index('event')
        })

        await knex.schema.createTable('certificates', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('certificateId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('serialNumber', 100).notNullable()
          table.string('type', 100).notNullable()
          table.string('certifier', 100).notNullable()
          table.string('subject', 100).notNullable()
          table.string('verifier', 100).nullable()
          table.string('revocationOutpoint', 100).notNullable()
          table.string('signature', 255).notNullable()
          table.boolean('isDeleted').notNullable().defaultTo(false)
          table.unique(['userId', 'type', 'certifier', 'serialNumber'])
        })

        await knex.schema.createTable('certificate_fields', table => {
          addTimeStamps(knex, table, dbtype)
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.integer('certificateId').unsigned().notNullable().references('certificateId').inTable('certificates')
          table.string('fieldName', 100).notNullable()
          table.string('fieldValue').notNullable()
          table.string('masterKey', 255).notNullable().defaultTo('')
          table.unique(['fieldName', 'certificateId'])
        })

        await knex.schema.createTable('settings', table => {
          addTimeStamps(knex, table, dbtype)
          table.string('storageIdentityKey', 130).notNullable()
          table.string('storageName', 128).notNullable()
          table.string('chain', 10).notNullable()
          table.string('dbtype', 10).notNullable()
          table.integer('maxOutputScript').notNullable()
        })

        await knex.schema.createTable('sync_states', table => {
          addTimeStamps(knex, table, dbtype)
          table.increments('syncStateId')
          table.integer('userId').unsigned().notNullable().references('userId').inTable('users')
          table.string('storageIdentityKey', 130).notNullable().defaultTo('')
          table.string('storageName').notNullable()
          table.string('status').notNullable().defaultTo('unknown')
          table.boolean('init').notNullable().defaultTo(false)
          table.string('refNum', 100).notNullable().unique()
          table.text('syncMap', 'longtext').notNullable()
          table.dateTime('when').nullable()
          table.bigint('satoshis').nullable()
          table.text('errorLocal', 'longtext').nullable()
          table.text('errorOther', 'longtext').nullable()
          table.index('status')
          table.index('refNum')
        })

        if (dbtype === 'MySQL') {
          await knex.raw('ALTER TABLE transactions MODIFY COLUMN raw_tx LONGBLOB')
          await knex.raw('ALTER TABLE transactions MODIFY COLUMN input_beef LONGBLOB')
          await knex.raw('ALTER TABLE transactions MODIFY COLUMN merkle_path LONGBLOB')
          await knex.raw('ALTER TABLE actions MODIFY COLUMN raw_tx_draft LONGBLOB')
          await knex.raw('ALTER TABLE actions MODIFY COLUMN input_beef_draft LONGBLOB')
          await knex.raw('ALTER TABLE outputs MODIFY COLUMN lockingScript LONGBLOB')
        }

        await knex('settings').insert({
          storageIdentityKey,
          storageName,
          chain,
          dbtype,
          maxOutputScript: maxOutputScriptLength
        })
      },
      async down (knex) {
        const tables = [
          'sync_states', 'settings', 'certificate_fields', 'certificates',
          'monitor_events', 'monitor_lease', 'chain_tip', 'tx_audit',
          'tx_labels_map', 'output_tags_map', 'commissions', 'outputs',
          'tx_labels', 'output_tags', 'output_baskets', 'actions',
          'transactions', 'users'
        ]
        for (const t of tables) await knex.schema.dropTableIfExists(t)
      }
    }

    return migrations
  }
}

export async function determineDBType (knex: Knex<any, any[]>): Promise<DBType> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: string | undefined = (knex as any).client?.config?.client ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (knex as any).client?.dialect
  if (client === 'mysql' || client === 'mysql2') return 'MySQL'
  if (client === 'pg' || client === 'postgres' || client === 'postgresql' ||
      client === 'pg-native' || client === 'pgnative') return 'Postgres'
  if (client === 'better-sqlite3' || client === 'sqlite3') return 'SQLite'

  try {
    const r: any = await knex.raw('SELECT version() AS v')
    const v = r?.rows?.[0]?.v ?? r?.[0]?.[0]?.v ?? r?.[0]?.v
    if (typeof v === 'string' && /PostgreSQL/i.test(v)) return 'Postgres'
    if (typeof v === 'string' && /MariaDB|MySQL/i.test(v)) return 'MySQL'
  } catch { /* fallthrough */ }
  try {
    await knex.raw('SELECT 1')
    return 'SQLite'
  } catch {
    throw new WERR_NOT_IMPLEMENTED('Unsupported database engine for storage.')
  }
}
