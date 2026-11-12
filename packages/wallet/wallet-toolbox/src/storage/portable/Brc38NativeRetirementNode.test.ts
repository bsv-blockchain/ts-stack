import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { migrateBrc38NativeCatalog } from './Brc38NativeCatalogNode'
import { readRow, readForwardOriginalProfileRow, type Row } from './Brc38PublishedProfileReceiptNode'
import {
  readBrc38NativeRetirement,
  writeBrc38NativeRetirement,
  type Brc38NativeRetirementRecord
} from './Brc38NativeRetirementNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

// UNRUN catalog component cases. Stock transactions are intentional here:
// these DATA checks do not claim native admission, a prepared target, manager
// cutover, publication or physical recovery. The native fixture covers the
// kernel's already-admitted writer separately.
describe('durable native source retirement data and forward namespace', () => {
  let db: Knex
  const fixedJson = JSON.stringify({ original: 'bounded source catalog fixture' }),
    hash = (v: string): string => createHash('sha256').update(v).digest('hex')
  const original: Row = {
    state: 'READY',
    fixedJson,
    fixedSha256: hash(fixedJson),
    copySha256: 'a'.repeat(64),
    copyBytes: 4096
  }
  const record: Brc38NativeRetirementRecord = {
    protocol: 'brc38-native-retirement/v1',
    decisionId: '00000000-0000-4000-8000-000000000001',
    source: {
      fixedSha256: original.fixedSha256,
      copySha256: original.copySha256!,
      copyBytes: original.copyBytes!,
      epoch: '00000000-0000-4000-8000-000000000002',
      revision: snapshotJournalRevision('9223372036854775806'),
      primaryEpoch: snapshotJournalRevision('7')
    },
    target: {
      rootId: '00000000-0000-4000-8000-000000000003',
      profileId: '00000000-0000-4000-8000-000000000004',
      fixedSha256: 'b'.repeat(64),
      copySha256: 'c'.repeat(64),
      copyBytes: 8192
    }
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
    await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, original))
    await db('profile_native').where({ slot: 1 }).update({ state: 'ACTIVE' })
  })
  afterEach(async () => await db.destroy())
  test('committed decision preserves exact original receipt, refuses activation readers and repeats without changing its target', async () => {
    expect(await readBrc38NativeRetirement(db)).toBeUndefined()
    expect(await db.transaction(async trx => await writeBrc38NativeRetirement(trx, record))).toEqual(record)
    expect(await readBrc38NativeRetirement(db)).toEqual(record)
    expect(await readForwardOriginalProfileRow(db)).toEqual(original)
    await expect(readRow(db)).rejects.toThrow('forward catalog layout differs')
    const before = await db('profile_retired').select('*')
    expect(await db.transaction(async trx => await writeBrc38NativeRetirement(trx, record))).toEqual(record)
    expect(await db('profile_retired').select('*')).toEqual(before)
    await expect(
      db.transaction(
        async trx =>
          await writeBrc38NativeRetirement(trx, { ...record, decisionId: '00000000-0000-4000-8000-000000000005' })
      )
    ).rejects.toThrow('retirement data')
    await expect(
      db.transaction(
        async trx =>
          await writeBrc38NativeRetirement(trx, { ...record, target: { ...record.target, copyBytes: 12288 } })
      )
    ).rejects.toThrow('retirement data')
    expect(await db('profile_retired').select('*')).toEqual(before)
  })
  test('ordinary rollback retains native ACTIVE and an in-progress activation cannot retire', async () => {
    await expect(
      db.transaction(async trx => {
        await writeBrc38NativeRetirement(trx, record)
        throw new Error('ordinary retirement precommit failure')
      })
    ).rejects.toThrow('ordinary retirement precommit failure')
    expect(await readBrc38NativeRetirement(db)).toBeUndefined()
    expect(await readRow(db)).toEqual({ ...original, state: 'ACTIVE' })
    await db('profile_native').where({ slot: 1 }).update({ state: 'ACTIVATING' })
    await expect(db.transaction(async trx => await writeBrc38NativeRetirement(trx, record))).rejects.toThrow(
      'retirement data'
    )
    expect(await db.schema.hasTable('profile_retired')).toBe(false)
  })
  test('changed original lineage, unknown record members and ambiguous schema refuse durable recovery', async () => {
    await db.transaction(async trx => await writeBrc38NativeRetirement(trx, record))
    await db('profile_original')
      .where({ slot: 1 })
      .update({ copySha256: 'd'.repeat(64) })
    await expect(readBrc38NativeRetirement(db)).rejects.toThrow('retirement data')
    await db('profile_original').where({ slot: 1 }).update({ copySha256: original.copySha256 })
    const changed = JSON.stringify({ ...record, unexpected: true })
    await db('profile_retired')
      .where({ slot: 1 })
      .update({ recordJson: changed, recordSha256: hash(changed) })
    await expect(readBrc38NativeRetirement(db)).rejects.toThrow('retirement data')
    await db('profile_retired')
      .where({ slot: 1 })
      .update({ recordJson: JSON.stringify(record), recordSha256: hash(JSON.stringify(record)) })
    await db.raw('CREATE INDEX retirement_extra ON profile_retired(recordSha256)')
    await expect(readBrc38NativeRetirement(db)).rejects.toThrow('retirement data')
    await db.raw('DROP INDEX retirement_extra')
    await db.raw('CREATE TABLE profile_native(slot INTEGER PRIMARY KEY)')
    await expect(readBrc38NativeRetirement(db)).rejects.toThrow('retirement data')
  })
  test('noncanonical revisions and a substituted source never create the new namespace', async () => {
    for (const source of [
      { ...record.source, revision: '07' as Brc38NativeRetirementRecord['source']['revision'] },
      {
        ...record.source,
        primaryEpoch: '9223372036854775808' as Brc38NativeRetirementRecord['source']['primaryEpoch']
      },
      { ...record.source, fixedSha256: 'e'.repeat(64) }
    ]) {
      await expect(
        db.transaction(async trx => await writeBrc38NativeRetirement(trx, { ...record, source }))
      ).rejects.toThrow()
      expect(await db.schema.hasTable('profile_retired')).toBe(false)
      expect(await readRow(db)).toEqual({ ...original, state: 'ACTIVE' })
    }
  })
})
