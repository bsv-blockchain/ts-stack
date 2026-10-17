import fc from 'fast-check'
import createKnex from 'knex'
import {
  installBrc38ImportTargetIndexes,
  verifyBrc38ImportTargetIndexes,
  brc38ImportTargetIndexName,
  brc38ImportTargetIndexStatements
} from './Brc38ImportTargetIndexes'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

// The external query identities are fixed independently of production exports.
const required = [
  ['provenTxs', 'proven_txs', ['txid']],
  ['outputBaskets', 'output_baskets', ['userId', 'name']],
  ['outputTags', 'output_tags', ['userId', 'tag']],
  ['txLabels', 'tx_labels', ['userId', 'label']],
  ['transactions', 'transactions', ['userId', 'txid']],
  ['transactionReference', 'transactions', ['userId', 'reference']],
  ['transactionReclaim', 'transactions', ['userId', 'noSendExpiryReclaimTxid']],
  ['outputs', 'outputs', ['userId', 'transactionId', 'vout']],
  ['reclaimOutput', 'outputs', ['userId', 'txid', 'vout']],
  ['txLabelMaps', 'tx_labels_map', ['txLabelId', 'transactionId']],
  ['outputTagMaps', 'output_tags_map', ['outputTagId', 'outputId']],
  ['certificates', 'certificates', ['userId', 'certifier', 'serialNumber']],
  ['certificateFields', 'certificate_fields', ['userId', 'certificateId', 'fieldName']],
  ['commissions', 'commissions', ['userId', 'transactionId']],
  ['provenTxReqs', 'proven_tx_reqs', ['txid']],
  ['preparedBeefReady', 'prepared_beefs', ['state', 'preparedBeefId']],
  ['syncStates', 'sync_states', ['userId', 'storageIdentityKey', 'storageName']]
] as const

describe('destination indexes retain their external query identities', () => {
  test('unique point trees retain complete equality and owner residuals', async () => {
    // Independent actual SQL semantics; ordinary fixture membership cannot
    // authorize native index selection or native schema admission.
    const candidates = [
      ['output_baskets', ['userId', 'name'], ['name', 'userId']],
      ['output_tags', ['userId', 'tag'], ['tag', 'userId']],
      ['tx_labels', ['userId', 'label'], ['label', 'userId']],
      ['outputs', ['userId', 'transactionId', 'vout'], ['transactionId', 'vout', 'userId']],
      ['transactions', ['userId', 'reference'], ['reference']],
      ['certificate_fields', ['userId', 'certificateId', 'fieldName'], ['fieldName', 'certificateId']],
      ['commissions', ['userId', 'transactionId'], ['transactionId']]
    ] as const
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      for (const [table, keys, indexed] of candidates) {
        await db.schema.createTable(table, definition => {
          for (const key of keys) definition.text(key).notNullable()
        })
        await db.raw(`CREATE UNIQUE INDEX source_point_${table} ON ${table} (${indexed.join(',')})`)
      }
      await db.transaction(async trx => {
        await fc.assert(
          fc.asyncProperty(fc.constantFrom(...candidates), fc.string(), async ([table, keys, indexed], value) => {
            const key = Object.fromEntries(keys.map(name => [name, name === 'userId' ? 'owner' : value])),
              other = { ...key, userId: 'another owner' },
              query = (where: Record<string, string>) =>
                trx
                  .from(trx.raw('?? INDEXED BY ??', [table, `source_point_${table}`]))
                  .where(where)
                  .select('rowid')
            await trx(table).delete()
            await trx(table).insert(key)
            const found = await query(key)
            expect(found).toHaveLength(1)
            expect(await query(other)).toEqual([])
            if (indexed.some(name => name === 'userId')) {
              await trx(table).insert(other)
              const otherFound = await query(other)
              expect(otherFound).toHaveLength(1)
              expect(otherFound[0].rowid).not.toBe(found[0].rowid)
            } else await expect(trx(table).insert(other)).rejects.toThrow('UNIQUE constraint failed')
            const sql = query(key).toSQL(),
              plan = await trx.raw('EXPLAIN QUERY PLAN ' + sql.sql, [...sql.bindings])
            expect(plan).toHaveLength(1)
            expect(plan[0].detail.startsWith(`SEARCH ${table} USING `)).toBe(true)
            expect(plan[0].detail).toContain(`INDEX source_point_${table} (`)
            for (const name of indexed)
              await expect(trx(table).insert({ ...key, [name]: null })).rejects.toThrow('NOT NULL constraint failed')
          }),
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
  })

  test('ordinary catalog reordering is harmless and a missing or altered owned index fails', async () => {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      const tables = new Map<string, Set<string>>()
      for (const [, table, columns] of required) {
        const names = tables.get(table) ?? new Set<string>()
        for (const column of columns) names.add(column)
        tables.set(table, names)
      }
      for (const [table, columns] of tables) {
        await db.schema.createTable(table, definition => {
          for (const column of columns) definition.text(column)
        })
      }
      await db.transaction(async trx => {
        await installBrc38ImportTargetIndexes(trx)
        await installBrc38ImportTargetIndexes(trx)
        expect(await brc38ImportTargetIndexStatements(trx)).toHaveLength(17)
        for (const [key, table, columns] of required) {
          const name = `brc38_import_target_${key}`
          expect(brc38ImportTargetIndexName(key, trx)).toBe(name)
          const query = await trx.raw(
            `EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY ${name} WHERE ${columns.map(column => `${column}=?`).join(' AND ')}`,
            columns.map(() => 'probe')
          )
          expect(query).toHaveLength(1)
          expect(query[0].detail.startsWith(`SEARCH ${table} USING `)).toBe(true)
          expect(query[0].detail).toContain(`INDEX ${name} (`)
        }
        const inventory = await trx('sqlite_schema').where({ type: 'index' }).select('name')
        expect(inventory.map(row => row.name).sort()).toEqual(
          required.map(([key]) => `brc38_import_target_${key}`).sort()
        )
        await fc.assert(
          fc.asyncProperty(fc.constantFrom(...required), fc.boolean(), async ([key, table, columns], replace) => {
            const name = `brc38_import_target_${key}`
            await verifyBrc38ImportTargetIndexes(trx)
            await trx.raw('DROP INDEX ??', [name])
            if (replace) await trx.raw(`CREATE INDEX ${name} ON ${table} (${columns[0]})`)
            if (!replace || columns.length !== 1)
              await expect(verifyBrc38ImportTargetIndexes(trx)).rejects.toThrow('owned source')
            else await expect(verifyBrc38ImportTargetIndexes(trx)).resolves.toBeUndefined()
            if (replace) await trx.raw('DROP INDEX ??', [name])
            await trx.raw(`CREATE INDEX ${name} ON ${table} (${columns.join(', ')})`)
            await verifyBrc38ImportTargetIndexes(trx)
          }),
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
  })
})
