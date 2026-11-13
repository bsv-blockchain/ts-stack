import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import {
  readRow,
  readOriginalProfileRow,
  readForwardOriginalProfileRow,
  type Row
} from './Brc38PublishedProfileReceiptNode'
import { migrateBrc38NativeCatalog } from './Brc38NativeCatalogNode'

describe('native forward catalog preserves original receipt and rejects earlier readers', () => {
  let db: Knex
  const fixedJson = JSON.stringify({ original: 'ordinary bounded receipt fixture' })
  const original: Row = {
    state: 'READY',
    fixedJson,
    fixedSha256: createHash('sha256').update(fixedJson).digest('hex'),
    copySha256: 'a'.repeat(64),
    copyBytes: 4096
  }
  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await db.schema.createTable('profile', table => {
      table.integer('slot').primary()
      table.string('state', 16).notNullable()
      table.text('fixedJson').notNullable()
      table.string('fixedSha256', 64).notNullable()
      table.string('copySha256', 64)
      table.bigInteger('copyBytes')
    })
    await db('profile').insert({ slot: 1, ...original })
  })
  afterEach(async () => await db.destroy())
  test('migration refuses legacy catalog reads before any wallet connection and retains exact original fields', async () => {
    await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, original))
    await expect(readOriginalProfileRow(db)).rejects.toThrow('no such table: profile')
    expect(await readForwardOriginalProfileRow(db)).toEqual(original)
    expect(await readRow(db)).toEqual({ ...original, state: 'ACTIVATING' })
    await db('profile_native').where({ slot: 1 }).update({ state: 'ACTIVE' })
    expect(await readRow(db)).toEqual({ ...original, state: 'ACTIVE' })
    expect(await readForwardOriginalProfileRow(db)).toEqual(original)
  })
  test('ordinary transaction failure rolls back the entire namespace and retains legacy READY', async () => {
    await expect(
      db.transaction(async trx => {
        await migrateBrc38NativeCatalog(trx, original)
        throw new Error('ordinary precommit failure')
      })
    ).rejects.toThrow('ordinary precommit failure')
    expect(await readOriginalProfileRow(db)).toEqual(original)
    expect(await readRow(db)).toEqual(original)
    expect(await db('sqlite_schema').whereIn('name', ['profile_original', 'profile_native']).select('name')).toEqual([])
  })
  test('retained original state and progress digest are bound independently of wallet activation', async () => {
    await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, original))
    await db('profile_original').where({ slot: 1 }).update({ state: 'ACTIVATING' })
    await expect(readRow(db)).rejects.toThrow('progress or original receipt differs')
    await db('profile_original').where({ slot: 1 }).update({ state: 'READY' })
    await db('profile_native')
      .where({ slot: 1 })
      .update({ originalSha256: 'b'.repeat(64) })
    await expect(readRow(db)).rejects.toThrow('progress or original receipt differs')
  })
  test('ambiguous legacy coexistence and extra schema objects refuse before materializing receipt data', async () => {
    await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, original))
    await db.raw('CREATE INDEX extra_native_index ON profile_native(state)')
    await expect(readRow(db)).rejects.toThrow('forward catalog layout differs')
    await db.raw('DROP INDEX extra_native_index')
    await db.raw('CREATE TABLE profile(slot INTEGER PRIMARY KEY)')
    await expect(readRow(db)).rejects.toThrow('forward catalog layout differs')
  })
})
