import fc from 'fast-check'
import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { migrateBrc38NativeCatalog, readBrc38NativeCatalog } from './Brc38NativeCatalogNode'
import {
  readRow,
  readOriginalProfileRow,
  readForwardOriginalProfileRow,
  type Row
} from './Brc38PublishedProfileReceiptNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const text = fc.array(fc.constantFrom('x', 'é', '中', '😀'), { minLength: 1, maxLength: 24 }).map(v => v.join(''))
const completedStates = ['READY', 'ACTIVATING', 'ACTIVE'] as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const extent = fc.integer({ min: 4096, max: 1048576 })
let db: Knex
beforeEach(() => {
  db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
})
afterEach(async () => await db.destroy())

function receipt(value: string, state: Row['state'], bytes: number): Row {
  const fixedJson = JSON.stringify({ original: value })
  return {
    state,
    fixedJson,
    fixedSha256: hash(fixedJson),
    copySha256: hash('copied bytes ' + value),
    copyBytes: bytes
  }
}
function originalDigest(row: Row): string {
  return hash(JSON.stringify([row.state, row.fixedJson, row.fixedSha256, row.copySha256, row.copyBytes]))
}
async function original(row: Row) {
  for (const table of ['profile_native', 'profile_original', 'profile']) {
    await db.schema.dropTableIfExists(table)
  }
  await db.schema.createTable('profile', table => {
    table.integer('slot').primary()
    table.string('state', 16).notNullable()
    table.text('fixedJson').notNullable()
    table.string('fixedSha256', 64).notNullable()
    table.string('copySha256', 64)
    table.bigInteger('copyBytes')
  })
  await db('profile').insert({ slot: 1, ...row })
}
async function namespace() {
  return await db('sqlite_schema')
    .whereIn('name', ['profile', 'profile_original', 'profile_native', 'extra_native_index'])
    .orderBy('name')
    .select('name', 'type', 'sql')
}

// Source-owned stock SQLite catalog transactions only. These receipts provide
// no native process, wallet, inventory, physical or activation authority.
test('generated migration preserves every original receipt field and independently binds initial progress', async () => {
  await fc.assert(
    fc.asyncProperty(text, fc.constantFrom(...completedStates), extent, async (value, state, bytes) => {
      const row = receipt(value, state, bytes)
      await original(row)
      expect(await readBrc38NativeCatalog(db)).toBeUndefined()
      await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))
      expect(await readForwardOriginalProfileRow(db)).toEqual(row)
      expect(await db('profile_original')).toEqual([{ slot: 1, ...row }])
      const progressState = state === 'ACTIVE' ? 'ACTIVE' : 'ACTIVATING'
      expect(await db('profile_native')).toEqual([
        { slot: 1, state: progressState, originalSha256: originalDigest(row) }
      ])
      expect(await readRow(db)).toEqual({ ...row, state: progressState })
      expect(await db.schema.hasTable('profile')).toBe(false)
      expect((await namespace()).map(v => v.name)).toEqual(['profile_native', 'profile_original'])
    }),
    controls
  )
}, 30000)
test('generated ordinary rollback restores the exact namespace and receipt even after progress advancement', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, fc.boolean(), async (value, bytes, advance) => {
      const row = receipt(value, 'READY', bytes)
      await original(row)
      const before = await namespace()
      await expect(
        db.transaction(async trx => {
          await migrateBrc38NativeCatalog(trx, row)
          if (advance) await trx('profile_native').where({ slot: 1 }).update({ state: 'ACTIVE' })
          throw new Error('ordinary before-commit rollback')
        })
      ).rejects.toThrow('ordinary before-commit rollback')
      expect(await namespace()).toEqual(before)
      expect(await readOriginalProfileRow(db)).toEqual(row)
      expect(await readRow(db)).toEqual(row)
      expect(await db('profile')).toEqual([{ slot: 1, ...row }])
    }),
    controls
  )
}, 30000)
test('generated receiving rows refuse migration while retaining their complete original catalog', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, async (value, bytes) => {
      const row = receipt(value, 'RECEIVING', bytes)
      await original(row)
      const before = await namespace()
      await expect(db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))).rejects.toThrow(
        'Original receipt changed'
      )
      expect(await namespace()).toEqual(before)
      expect(await readRow(db)).toEqual(row)
    }),
    controls
  )
}, 30000)
test('generated changes to each expected receipt field refuse before any namespace transition', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, fc.integer({ min: 0, max: 4 }), async (value, bytes, kind) => {
      const row = receipt(value, 'READY', bytes)
      await original(row)
      const before = await namespace()
      const changed = { ...row }
      if (kind === 0) changed.state = 'ACTIVATING'
      else if (kind === 1) changed.fixedJson += '!'
      else if (kind === 2) changed.fixedSha256 = hash(row.fixedSha256)
      else if (kind === 3) changed.copySha256 = hash(row.copySha256!)
      else changed.copyBytes = bytes + 1
      await expect(db.transaction(async trx => await migrateBrc38NativeCatalog(trx, changed))).rejects.toThrow(
        'Original receipt changed'
      )
      expect(await namespace()).toEqual(before)
      expect(await readRow(db)).toEqual(row)
      expect(await db('profile')).toEqual([{ slot: 1, ...row }])
    }),
    controls
  )
}, 30000)
test('generated progress-digest changes or active-state regression refuse without changing original lineage', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, fc.boolean(), async (value, bytes, regress) => {
      const row = receipt(value, 'ACTIVE', bytes)
      await original(row)
      await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))
      await db('profile_native')
        .where({ slot: 1 })
        .update(regress ? { state: 'ACTIVATING' } : { originalSha256: hash(originalDigest(row)) })
      const progress = await db('profile_native')
      await expect(readRow(db)).rejects.toThrow('progress or original receipt differs')
      expect(await db('profile_native')).toEqual(progress)
      expect(await readForwardOriginalProfileRow(db)).toEqual(row)
    }),
    controls
  )
}, 30000)
test('generated extra schema objects or legacy coexistence refuse before receipt materialization', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, fc.boolean(), async (value, bytes, coexist) => {
      const row = receipt(value, 'READY', bytes)
      await original(row)
      await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))
      if (coexist) await db.schema.createTable('profile', table => table.integer('slot').primary())
      else await db.raw('CREATE INDEX extra_native_index ON profile_native(state)')
      const before = await namespace()
      const retained = await db('profile_original')
      await expect(readRow(db)).rejects.toThrow('forward catalog layout differs')
      expect(await namespace()).toEqual(before)
      expect(await db('profile_original')).toEqual(retained)
    }),
    controls
  )
}, 30000)
test('generated duplicate migration refuses and later valid progress preserves original metadata', async () => {
  await fc.assert(
    fc.asyncProperty(text, extent, async (value, bytes) => {
      const row = receipt(value, 'READY', bytes)
      await original(row)
      await db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))
      const before = await namespace()
      await expect(db.transaction(async trx => await migrateBrc38NativeCatalog(trx, row))).rejects.toThrow(
        'already migrated'
      )
      expect(await namespace()).toEqual(before)
      expect(await readForwardOriginalProfileRow(db)).toEqual(row)
      await db('profile_native').where({ slot: 1 }).update({ state: 'ACTIVE' })
      expect(await readRow(db)).toEqual({ ...row, state: 'ACTIVE' })
      expect(await readForwardOriginalProfileRow(db)).toEqual(row)
    }),
    controls
  )
}, 30000)
