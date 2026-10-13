import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { knex as makeKnex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { INTERNALIZE_RECEIPT_MIGRATION, KnexMigrations } from '../schema/KnexMigrations'

const initial = '2026-09-23-001 atomicity fixture'
const altered = '2026-09-23-002 populated alter fixture'

function open(filename: string): StorageKnex {
  return new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain: 'test',
    knex: makeKnex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  })
}

async function createParent(db: Knex): Promise<void> {
  await db.schema.createTable('migration_parent', table => {
    table.integer('id').primary()
    table.string('label').nullable()
  })
}

async function createChildAndRows(db: Knex): Promise<void> {
  await db.schema.createTable('migration_child', table => {
    table.integer('id').primary()
    table.integer('parent').references('id').inTable('migration_parent')
  })
  await db('migration_parent').insert({ id: 1, label: 'retained' })
  await db('migration_child').insert({ id: 2, parent: 1 })
}

afterEach(() => jest.restoreAllMocks())

describe('SQLite migration atomicity through StorageKnex', () => {
  test('an abruptly killed migration leaves neither partial DDL nor a stuck migration lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wallet-migration-crash-'))
    const filename = join(directory, 'wallet.sqlite')
    // Exercise the built artifact in a separate process so SIGKILL cannot run
    // Knex catch/finally cleanup. The parent reopens the same durable database.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const { knex } = require('knex')
      const { StorageKnex } = require('./out/src/storage/StorageKnex.js')
      const { KnexMigrations } = require('./out/src/storage/schema/KnexMigrations.js')
      KnexMigrations.prototype.getMigrations = async () => ['2026-09-23-001 atomicity fixture']
      KnexMigrations.prototype.getMigration = async () => ({
        down: async db => { await db.schema.dropTableIfExists('migration_parent') },
        up: async db => {
          await db.schema.createTable('migration_parent', table => { table.integer('id').primary() })
          process.send('ddl-written')
          await new Promise(() => {})
        }
      })
      const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test',
        knex: knex({ client: 'better-sqlite3', connection: { filename: process.argv[1] },
          useNullAsDefault: true, pool: { min: 1, max: 1 } }) })
      storage.migrate('fixture', '1'.repeat(64)).catch(() => process.exit(1))
    `,
        filename
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    let storage: StorageKnex | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Child migration did not reach DDL')), 10000)
        child.once('message', message => {
          clearTimeout(timer)
          if (message === 'ddl-written') resolve()
          else reject(new Error('Unexpected migration checkpoint'))
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Child exited before checkpoint'))
        })
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
      })
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      storage = open(filename)
      expect(await storage.knex.schema.hasTable('migration_parent')).toBe(false)
      expect(await storage.knex('knex_migrations').select()).toEqual([])
      expect(await storage.knex('knex_migrations_lock').pluck('is_locked')).toEqual([0])
      jest.spyOn(KnexMigrations.prototype, 'getMigrations').mockResolvedValue([initial])
      jest.spyOn(KnexMigrations.prototype, 'getMigration').mockResolvedValue({
        up: createParent,
        down: async db => {
          await db.schema.dropTableIfExists('migration_parent')
        }
      })
      await storage.migrate('fixture', '1'.repeat(64))
      expect(await storage.knex('knex_migrations').pluck('name')).toEqual([initial])
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await storage?.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each(['mid-file', 'journal-write'] as const)(
    'rolls back a %s failure and migrates successfully after reopening',
    async boundary => {
      const directory = await mkdtemp(join(tmpdir(), 'wallet-migration-'))
      const filename = join(directory, 'wallet.sqlite')
      let storage = open(filename)
      let interrupted = true
      jest.spyOn(KnexMigrations.prototype, 'getMigrations').mockResolvedValue([initial])
      jest.spyOn(KnexMigrations.prototype, 'getMigration').mockResolvedValue({
        down: async db => {
          await db.schema.dropTableIfExists('migration_child')
          await db.schema.dropTableIfExists('migration_parent')
        },
        up: async db => {
          expect((await db.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(0)
          await createParent(db)
          if (interrupted && boundary === 'mid-file') throw new Error('injected interruption')
          await createChildAndRows(db)
        }
      })
      try {
        if (boundary === 'journal-write') {
          await storage.knex.migrate.list({
            migrationSource: new KnexMigrations('test', 'fixture', '1'.repeat(64), 1024)
          })
          await storage.knex.raw(
            "CREATE TRIGGER reject_journal BEFORE INSERT ON knex_migrations BEGIN SELECT RAISE(ABORT, 'injected journal interruption'); END"
          )
        }
        await expect(storage.migrate('fixture', '1'.repeat(64))).rejects.toThrow(/interruption/)
        expect(await storage.knex.schema.hasTable('migration_parent')).toBe(false)
        expect(await storage.knex.schema.hasTable('migration_child')).toBe(false)
        expect(await storage.knex('knex_migrations').select()).toEqual([])
        expect((await storage.knex.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
        await storage.destroy()
        storage = open(filename)
        interrupted = false
        await storage.knex.raw('DROP TRIGGER IF EXISTS reject_journal')
        await storage.migrate('fixture', '1'.repeat(64))
        expect(await storage.knex('migration_parent').select()).toEqual([{ id: 1, label: 'retained' }])
        expect(await storage.knex('migration_child').select()).toEqual([{ id: 2, parent: 1 }])
        expect(await storage.knex('knex_migrations').pluck('name')).toEqual([initial])
        expect(await storage.knex.raw('PRAGMA foreign_key_check')).toEqual([])
        expect((await storage.knex.raw('PRAGMA integrity_check'))[0].integrity_check).toBe('ok')
        await storage.migrate('fixture', '1'.repeat(64))
        expect(await storage.knex('knex_migrations').pluck('name')).toEqual([initial])
      } finally {
        await storage.destroy()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('preserves populated referenced rows during an alter-table rebuild and restores enforcement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wallet-migration-'))
    const storage = open(join(directory, 'wallet.sqlite'))
    const migrations = jest.spyOn(KnexMigrations.prototype, 'getMigrations').mockResolvedValue([initial])
    jest.spyOn(KnexMigrations.prototype, 'getMigration').mockImplementation(async name => ({
      down: async db => {
        if (name === initial) {
          await db.schema.dropTableIfExists('migration_child')
          await db.schema.dropTableIfExists('migration_parent')
        } else {
          await db.schema.alterTable('migration_parent', table => {
            table.string('label').nullable().alter()
          })
        }
      },
      up: async db => {
        if (name === initial) {
          await createParent(db)
          await createChildAndRows(db)
        } else {
          await db.schema.alterTable('migration_parent', table => {
            table.string('label', 128).notNullable().alter()
          })
        }
      }
    }))
    try {
      await storage.migrate('fixture', '1'.repeat(64))
      migrations.mockResolvedValue([initial, altered])
      await storage.migrate('fixture', '1'.repeat(64))
      expect(await storage.knex('migration_parent').select()).toEqual([{ id: 1, label: 'retained' }])
      expect(await storage.knex('migration_child').select()).toEqual([{ id: 2, parent: 1 }])
      expect(await storage.knex('knex_migrations').pluck('name')).toEqual([initial, altered])
      expect(await storage.knex.raw('PRAGMA foreign_key_check')).toEqual([])
      await expect(storage.knex('migration_child').insert({ id: 3, parent: 99 })).rejects.toThrow(/FOREIGN KEY/)
      await expect(storage.knex('migration_parent').insert({ id: 4, label: null })).rejects.toThrow(/NOT NULL/)
    } finally {
      await storage.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('wallet receipt coordination migration', () => {
  test('preserves legacy duplicate rows while enforcing one durable receipt key per user and txid', async () => {
    const db = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await db.schema.createTable('users', table => table.integer('userId').primary())
      await db.schema.createTable('transactions', table => {
        table.integer('transactionId').primary()
        table.integer('userId').notNullable()
        table.string('txid', 64).nullable()
      })
      await db.schema.createTable('outputs', table => {
        table.integer('outputId').primary()
        table.integer('userId').notNullable()
        table.string('txid', 64).nullable()
        table.integer('vout').notNullable()
      })
      await db('users').insert({ userId: 1 })
      const migration = await new KnexMigrations('test', 'fixture', '1'.repeat(64), 1024).getMigration(
        INTERNALIZE_RECEIPT_MIGRATION
      )
      await db('transactions').insert([
        { transactionId: 1, userId: 1, txid: 'a'.repeat(64) },
        { transactionId: 2, userId: 1, txid: 'a'.repeat(64) }
      ])
      await db('outputs').insert([
        { outputId: 1, userId: 1, txid: 'a'.repeat(64), vout: 0 },
        { outputId: 2, userId: 1, txid: 'a'.repeat(64), vout: 0 }
      ])
      await migration.up(db)
      await migration.up(db) // MySQL DDL can be committed before its migration journal entry.
      expect(await db.schema.hasTable('internalize_receipts')).toBe(true)
      expect(await db('transactions').count({ n: '*' }).first()).toMatchObject({ n: 2 })
      expect(await db('outputs').count({ n: '*' }).first()).toMatchObject({ n: 2 })
      await db('internalize_receipts').insert({
        userId: 1,
        txid: 'a'.repeat(64),
        ownerToken: 'first',
        state: 'complete',
        leaseUntil: 0
      })
      await expect(
        db('internalize_receipts').insert({
          userId: 1,
          txid: 'a'.repeat(64),
          ownerToken: 'second',
          state: 'pending',
          leaseUntil: 1
        })
      ).rejects.toThrow(/UNIQUE constraint failed/)
    } finally {
      await db.destroy()
    }
  })
})
