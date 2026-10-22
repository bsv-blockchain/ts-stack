import fc from 'fast-check'
import knex, { type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

test('generated independent import scopes preserve exact maps across committed resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brc38-import-id-map-property-')),
    config: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: join(root, 'property.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    },
    k = knex(config),
    observer = knex(config),
    active = new Set<Promise<void>>(),
    entities = Object.keys(createSyncMap()) as Array<keyof SyncMap>
  let sequence = 0
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await k.schema.createTable('brc38_import_ids', table => {
      table.text('importId').notNullable()
      table.text('bindingSha256').notNullable()
      table.text('archiveSha256').notNullable()
      table.integer('userId').notNullable()
      table.text('entity').notNullable()
      table.text('incomingId').notNullable()
      table.bigInteger('localId').notNullable()
      table.primary(['importId', 'bindingSha256', 'archiveSha256', 'userId', 'entity', 'incomingId'])
    })
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            entity: fc.constantFrom(...entities),
            incomingId: fc.oneof(
              fc.integer({ min: -100000, max: 100000 }),
              fc.constantFrom(Number.MAX_SAFE_INTEGER + 1, 1e21, -1e21, Number.MAX_VALUE)
            ),
            localId: fc.integer({ min: -1000000, max: 1000000 })
          }),
          { maxLength: 24, selector: row => `${row.entity}:${row.incomingId}` }
        ),
        async rows => {
          const run = (async () => {
            const scope = {
                importId: `${(++sequence).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
                bindingSha256: 'a'.repeat(64),
                archiveSha256: 'b'.repeat(64),
                userId: 7
              },
              refs = rows.map(row => ({
                entity: row.entity,
                incomingId: row.incomingId,
                required: false
              }))
            await k.transaction(async trx => {
              const prepared = await loadBrc38ImportIdMap(trx, scope, refs)
              for (const row of rows) prepared.map[row.entity].idMap[row.incomingId] = row.localId
              await prepared.persist()
            })
            const actual = await observer('brc38_import_ids').where(scope).select('entity', 'incomingId', 'localId')
            const ordered = (values: typeof rows): typeof rows =>
              [...values].sort((a, b) => a.entity.localeCompare(b.entity) || a.incomingId - b.incomingId)
            const decoded = (
              values: Array<{ entity: keyof SyncMap; incomingId: string; localId: number }>
            ): typeof rows => values.map(row => ({ ...row, incomingId: Number(row.incomingId) }))
            expect(ordered(decoded(actual))).toEqual(ordered(rows))
            await k.transaction(async trx => {
              const resumed = await loadBrc38ImportIdMap(
                trx,
                scope,
                refs.map(ref => ({ ...ref, required: true }))
              )
              for (const entity of entities) {
                const expected = Object.fromEntries(
                  rows.filter(row => row.entity === entity).map(row => [row.incomingId, row.localId])
                )
                expect(resumed.map[entity].idMap).toEqual(expected)
              }
              await resumed.persist()
            })
            const again = await observer('brc38_import_ids').where(scope).select('entity', 'incomingId', 'localId')
            expect(ordered(decoded(again))).toEqual(ordered(rows))
          })()
          active.add(run)
          try {
            await run
          } finally {
            active.delete(run)
          }
        }
      ),
      {
        numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
        seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  } finally {
    await Promise.allSettled(active)
    await observer.destroy()
    await k.destroy()
    await rm(root, { recursive: true, force: true })
  }
}, 180000)
