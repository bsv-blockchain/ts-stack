import fc from 'fast-check'
import createKnex from 'knex'
let installBrc38ImportJournalSchema: typeof import('./Brc38ImportJournalSchemaBody').installBrc38ImportJournalSchema
let verifyBrc38ImportJournalSchema: typeof import('./Brc38ImportJournalSchemaBody').verifyBrc38ImportJournalSchema
let readBrc38ImportSchemaFamily: typeof import('./Brc38ImportJournalSchemaBody').readBrc38ImportSchemaFamily

// Register the real cases before loading their integration graph. An invalid
// initializer must fail awaited setup instead of aborting Jest case discovery.
beforeAll(async () => {
  const actual = await import('./Brc38ImportJournalSchemaBody')
  installBrc38ImportJournalSchema = actual.installBrc38ImportJournalSchema
  verifyBrc38ImportJournalSchema = actual.verifyBrc38ImportJournalSchema
  readBrc38ImportSchemaFamily = actual.readBrc38ImportSchemaFamily
})

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

describe('private journal schema enforces durable mapping scope and accounting', () => {
  test('generated reservations charge exactly once and require owned immutable cleanup', async () => {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await db.raw('PRAGMA foreign_keys=ON')
      await db.transaction(async trx => {
        await installBrc38ImportJournalSchema(trx)
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: -16, max: 16 }),
            fc.integer({ min: 0, max: 8 }),
            async (userId, capacity) => {
              const scope = {
                importId: 'generated-owned-import',
                bindingSha256: 'b'.repeat(64),
                archiveSha256: 'a'.repeat(64),
                userId
              }
              await trx('brc38_import_journal').insert({
                ...scope,
                maximumMappedIds: capacity,
                admissionJson: '{}',
                admissionSha256: 'c'.repeat(64),
                receiptJson: '{}',
                receiptSha256: 'd'.repeat(64)
              })
              const mapping = { ...scope, entity: 'transaction', incomingId: '0', localId: 100 }
              await expect(trx('brc38_import_ids').insert({ ...mapping, userId: userId + 1 })).rejects.toThrow(
                'scope or quota differs'
              )
              for (let index = 0; index < capacity; index++) {
                await trx('brc38_import_ids').insert({
                  ...mapping,
                  incomingId: String(index),
                  localId: 100 + index
                })
                expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(
                  index + 1
                )
                expect(await trx('brc38_import_ids').where(scope).count({ count: '*' })).toEqual([{ count: index + 1 }])
                await expect(
                  trx('brc38_import_ids')
                    .where({ ...scope, incomingId: String(index) })
                    .update({ localId: 999 })
                ).rejects.toThrow('immutable')
              }
              await expect(trx('brc38_import_ids').insert({ ...mapping, incomingId: 'over-capacity' })).rejects.toThrow(
                'scope or quota differs'
              )
              if (capacity > 0) {
                await expect(trx('brc38_import_ids').where(scope).del()).rejects.toThrow('owned cleanup')
                expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(
                  capacity
                )
              }
              await trx('brc38_import_journal').where({ importId: scope.importId }).update({ cleanupAllowed: 1 })
              await expect(trx('brc38_import_ids').insert({ ...mapping, incomingId: 'after-cleanup' })).rejects.toThrow(
                'scope or quota differs'
              )
              await trx('brc38_import_ids').where(scope).del()
              expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(0)
              expect(await trx('brc38_import_ids').count({ count: '*' })).toEqual([{ count: 0 }])
              await verifyBrc38ImportJournalSchema(trx)
              await trx('brc38_import_journal').where({ importId: scope.importId }).del()
            }
          ),
          {
            interruptAfterTimeLimit: 150000,
            markInterruptAsFailure: true,
            path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
          }
        )
      })
    } finally {
      await db.destroy()
    }
  }, 30000)
})

test('genuine native family selection preserves prior physical rows and verifies compact metadata independently', async () => {
  const { withBrc38NativePrivateContractFixture } = await import('./Brc38NativePrivateContractFixture')
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      await installBrc38ImportJournalSchema(trx)
      // Prior-import custody requires actual physical row IDs even on native.
      expect(await trx.raw('SELECT rowid FROM brc38_import_journal LIMIT 1')).toEqual([])
      await verifyBrc38ImportJournalSchema(trx)
      const name = 'brc38_schema_compact_probe',
        sql = 'CREATE TABLE brc38_schema_compact_probe(id TEXT NOT NULL PRIMARY KEY)',
        error = 'Independent native schema family differs',
        legacy = new Map<string, { type: string; sql: string | null }>([
          [name, { type: 'table', sql }],
          ['sqlite_autoindex_brc38_schema_compact_probe_1', { type: 'index', sql: null }]
        ]),
        compact = new Map([[name, { type: 'table', sql: sql + ' WITHOUT ROWID' }]])
      try {
        expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error, true)).toEqual(compact)
        await trx.raw(sql + ' WITHOUT ROWID')
        expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(compact)
        await expect(trx.raw('SELECT rowid FROM brc38_schema_compact_probe LIMIT 1')).rejects.toThrow(/rowid/i)
        await trx.raw('CREATE INDEX brc38_schema_compact_extra ON brc38_schema_compact_probe(id)')
        await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
        await trx.raw('DROP INDEX brc38_schema_compact_extra')
        expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(compact)
        await trx.raw('DROP TABLE brc38_schema_compact_probe')
        await trx.raw(sql + ' WITHOUT ROWID, STRICT')
        await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
        await trx.raw('DROP TABLE brc38_schema_compact_probe')
        await trx.raw(sql)
        await trx(name).insert({ id: 'independent physical row' })
        expect(await trx.raw('SELECT rowid AS physical FROM brc38_schema_compact_probe')).toEqual([{ physical: 1 }])
        expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(legacy)
        await trx.raw('CREATE TEMP TABLE brc38_schema_compact_probe(id TEXT PRIMARY KEY)')
        await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
        await trx.raw('DROP TABLE temp.brc38_schema_compact_probe')
        expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(legacy)
      } finally {
        await trx.raw('DROP TABLE IF EXISTS temp.brc38_schema_compact_probe')
        await trx.raw('DROP TABLE IF EXISTS main.brc38_schema_compact_probe')
      }
      await verifyBrc38ImportJournalSchema(trx)
      fixture.check()
    })
  })
})

test('ordinary SQLite cannot adopt a clustered native family through matching SQL or a fresh-install flag', async () => {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  try {
    await db.transaction(async trx => {
      const name = 'brc38_schema_unowned_probe',
        sql = 'CREATE TABLE brc38_schema_unowned_probe(id TEXT NOT NULL PRIMARY KEY)',
        error = 'Independent ordinary schema family differs',
        legacy = new Map<string, { type: string; sql: string | null }>([
          [name, { type: 'table', sql }],
          ['sqlite_autoindex_brc38_schema_unowned_probe_1', { type: 'index', sql: null }]
        ])
      await trx.raw(sql + ' WITHOUT ROWID')
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error, true)).rejects.toThrow(error)
      await trx.raw('DROP TABLE brc38_schema_unowned_probe')
      await trx.raw(sql)
      expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(legacy)
      await expect(readBrc38ImportSchemaFamily(trx, legacy, ['independent_missing_anchor'], error)).rejects.toThrow(
        error
      )
    })
  } finally {
    await db.destroy()
  }
})

test('an absent family requires explicit fresh-install admission', async () => {
  const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await db.transaction(async trx => {
      const name = 'brc38_schema_absent_probe',
        legacy = new Map([[name, { type: 'table', sql: `CREATE TABLE ${name}(id INTEGER PRIMARY KEY)` }]]),
        error = 'Absent family requires explicit installation'
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
      expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error, true)).toEqual(legacy)
    })
  } finally {
    await db.destroy()
  }
})

test('temporary trigger shadows and same-count altered definitions cannot bypass complete family comparison', async () => {
  const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await db.transaction(async trx => {
      const name = 'brc38_schema_guard_probe',
        guard = name + '_guard',
        sql = `CREATE TABLE ${name}(id INTEGER PRIMARY KEY)`,
        trigger = `CREATE TRIGGER ${guard} BEFORE INSERT ON ${name} BEGIN SELECT 1; END`,
        legacy = new Map([
          [name, { type: 'table', sql }],
          [guard, { type: 'trigger', sql: trigger }]
        ]),
        error = 'Complete independent schema family differs'
      await trx.raw(sql)
      await trx.raw(trigger)
      expect(await readBrc38ImportSchemaFamily(trx, legacy, [name], error)).toEqual(legacy)
      await trx.raw('CREATE TEMP TABLE unrelated_schema_probe(id INTEGER)')
      await trx.raw(`CREATE TEMP TRIGGER ${guard} BEFORE INSERT ON unrelated_schema_probe BEGIN SELECT 1; END`)
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
      await trx.raw(`DROP TRIGGER temp.${guard}`)
      await trx.raw(`DROP TRIGGER main.${guard}`)
      await trx.raw(`CREATE TRIGGER ${guard} BEFORE INSERT ON ${name} BEGIN SELECT 2; END`)
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
      await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error, true)).rejects.toThrow(error)
    })
  } finally {
    await db.destroy()
  }
})

test.each(['temporary', 'total', 'anchor', 'matches', 'names'] as const)(
  'malformed %s catalog count DATA retains the original schema refusal',
  async fault => {
    let count = 0,
      injected = false
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      // Every original SQL query executes. Only its returned count DATA is
      // damaged; this never manufactures native membership or a passing schema.
      postProcessResponse: (response: unknown): unknown => {
        if (response !== null && typeof response === 'object' && Object.hasOwn(response, 'count')) {
          const position = count++
          if (position === { temporary: 0, total: 1, anchor: 2, matches: -1, names: -1 }[fault]) {
            injected = true
            return undefined
          }
        }
        if (
          response !== null &&
          typeof response === 'object' &&
          Object.hasOwn(response, 'matches') &&
          (fault === 'matches' || fault === 'names')
        ) {
          injected = true
          return { ...response, [fault]: 1 }
        }
        return response
      }
    })
    try {
      await db.transaction(async trx => {
        const name = 'brc38_schema_count_probe',
          sql = `CREATE TABLE ${name}(id TEXT NOT NULL PRIMARY KEY)`,
          legacy = new Map<string, { type: string; sql: string | null }>([
            [name, { type: 'table', sql }],
            [`sqlite_autoindex_${name}_1`, { type: 'index', sql: null }]
          ]),
          error = 'Malformed fresh schema counts differ'
        await trx.raw(sql)
        await expect(readBrc38ImportSchemaFamily(trx, legacy, [name], error)).rejects.toThrow(error)
        expect(injected).toBe(true)
      })
    } finally {
      await db.destroy()
    }
  }
)

test('genuine historical clustered journal tables remain exact and verification refuses a missing owned trigger', async () => {
  const { withBrc38NativePrivateContractFixture } = await import('./Brc38NativePrivateContractFixture')
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      await installBrc38ImportJournalSchema(trx)
      const definitions = (await trx('main.sqlite_schema')
        .whereIn('tbl_name', ['brc38_import_journal', 'brc38_import_ids'])
        .whereNotNull('sql')
        .select('name', 'type', 'sql')) as Array<{ name: string; type: string; sql: string }>
      const guard = definitions.find(value => value.name === 'brc38_import_ids_insert_guard')
      expect(guard).toBeDefined()
      await trx.raw('DROP TRIGGER brc38_import_ids_insert_guard')
      await expect(verifyBrc38ImportJournalSchema(trx)).rejects.toThrow(
        'Private import journal schema differs from its owned source'
      )
      await trx.raw(guard!.sql)
      await verifyBrc38ImportJournalSchema(trx)
      await trx.raw('DROP TABLE brc38_import_ids')
      await trx.raw('DROP TABLE brc38_import_journal')
      for (const name of ['brc38_import_journal', 'brc38_import_ids']) {
        const table = definitions.find(value => value.name === name && value.type === 'table')
        expect(table).toBeDefined()
        await trx.raw(table!.sql + ' WITHOUT ROWID')
        await expect(trx.raw(`SELECT rowid FROM ${name} LIMIT 1`)).rejects.toThrow(/rowid/i)
      }
      for (const definition of definitions) if (definition.type === 'trigger') await trx.raw(definition.sql)
      await verifyBrc38ImportJournalSchema(trx)
      await installBrc38ImportJournalSchema(trx)
      fixture.check()
    })
  })
})
