// Invoked only by the verified disposable native MySQL fixture.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  createKnexWalletSnapshotPageReader: pageReader
} = require('../../out/src/storage/snapshot/KnexWalletReadSnapshot.js')

async function seedLargeFields(k, userId, otherId) {
  const date = new Date('2026-01-01T00:00:00Z')
  await runInSeries(
    Array.from({ length: 32 }, (_, i) => i * 256),
    async start => {
      await k('certificate_fields').insert(
        Array.from({ length: 256 }, (_, i) => {
          const id = start + i
          return {
            created_at: date,
            updated_at: date,
            fieldName: String(id).padStart(6, '0'),
            userId: id % 2 ? otherId : userId,
            certificateId: id % 2 ? 2 : 1,
            fieldValue: 'synthetic',
            masterKey: 'synthetic'
          }
        })
      )
    }
  )
}

async function handlerCounters(source, view) {
  return await view.read(async trx =>
    Object.fromEntries(
      (await source.toDb(trx).raw("SHOW SESSION STATUS LIKE 'Handler_read_%'"))[0].map(row => [
        row.Variable_name,
        Number(row.Value)
      ])
    )
  )
}

async function tableCounters(source, view) {
  return await view.read(async trx =>
    Object.fromEntries(
      (
        await source
          .toDb(trx)
          .raw(
            'SELECT OBJECT_NAME, COUNT_FETCH FROM performance_schema.table_io_waits_summary_by_table WHERE OBJECT_SCHEMA=DATABASE() ORDER BY OBJECT_NAME'
          )
      )[0].map(row => [row.OBJECT_NAME, Number(row.COUNT_FETCH)])
    )
  )
}

async function observePage(source, view, read, leftId) {
  const queries = []
  const listener = q => {
    if (q.sql.startsWith('select') && q.sql.includes('snapshot_certificate_field_keys') && q.sql.includes('cross join'))
      queries.push(q)
  }
  const tablesBefore = await tableCounters(source, view)
  const before = await handlerCounters(source, view)
  source.knex.on('query', listener)
  let page
  try {
    page = await read(
      'certificateFields',
      leftId === undefined
        ? undefined
        : {
            version: 1,
            snapshotId: 'large-seek-fixture',
            table: 'certificateFields',
            after: [String(leftId).padStart(6, '0'), 1]
          },
      { maxRows: 16, maxBytes: 131072 }
    )
  } finally {
    source.knex.off('query', listener)
  }
  const after = await handlerCounters(source, view)
  const tablesAfter = await tableCounters(source, view)
  const fetches = Object.fromEntries(
    Object.keys(tablesAfter).map(name => [name, tablesAfter[name] - (tablesBefore[name] ?? 0)])
  )
  const deltas = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]))
  const expectedIds = Array.from(
    { length: Math.min(16, (8190 - (leftId ?? -2)) / 2) },
    (_, i) => (leftId ?? -2) + (i + 1) * 2
  )
  assert.deepEqual(
    page.rows.map(row => Number(row.fieldName)),
    expectedIds
  )
  const plans = []
  await runInSeries(queries, async q => {
    plans.push(await view.read(async trx => (await source.toDb(trx).raw('EXPLAIN ' + q.sql, q.bindings))[0]))
  })
  // Session Handler counters can include lazy work outside the wallet tables.
  // Enforce native fetch bounds on this isolated database, including both page
  // passes and ownership guards; retain session counters as diagnostic evidence.
  assert.equal(fetches.certificate_fields, page.rows.length * 2)
  assert.equal(fetches.certificates, page.rows.length)
  assert.equal(fetches.users, 1)
  assert.ok(
    fetches.snapshot_certificate_field_keys <= page.rows.length * 2 + 4,
    'Both passes must seek bounded auxiliary keys: ' + JSON.stringify(fetches)
  )
  assert.ok(fetches.snapshot_certificate_field_keys >= page.rows.length * 2)
  const allowed = new Set(['certificate_fields', 'certificates', 'users', 'snapshot_certificate_field_keys'])
  assert.ok(
    Object.entries(fetches).every(([table, count]) => allowed.has(table) || count === 0),
    'A certificate page must not fetch unrelated wallet tables'
  )
  assert.ok(deltas.Handler_read_rnd_next <= 64, 'The page must not scan rows into a temporary table')
  assert.ok(
    plans.every(
      plan =>
        plan[0].table === 'snapshot_certificate_field_keys' &&
        plan[0].key === 'PRIMARY' &&
        (leftId === undefined ? ['ref', 'range'].includes(plan[0].type) : plan[0].type === 'range')
    ),
    'Both page passes must use the profile prefix or cursor range'
  )
  return { after: leftId ?? null, rows: page.rows.length, deltas, fetches, plans, queries }
}

async function largeSeeks(source, userId, otherId) {
  await seedLargeFields(source.knex, userId, otherId)
  const results = []
  await runInSeries(['fresh', 'refreshed'], async statistics => {
    if (statistics === 'refreshed')
      await source.knex.raw('ANALYZE TABLE snapshot_certificate_field_keys, certificate_fields')
    const view = await source.openReadSnapshot()
    const read = pageReader(source, userId, 'large-seek-fixture', view, true, true, true)
    try {
      await runInSeries([undefined, 1500, 7000, 8180], async leftId =>
        results.push({ statistics, ...(await observePage(source, view, read, leftId)) })
      )
    } finally {
      await view.close()
    }
  })
  return results
}

async function qualifyCollation(control, connection, collation) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const database = 'ts569_certificate_seeks_' + randomUUID().replaceAll('-', '')
  await control.raw(`CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE ${collation}`, [database])
  const source = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  })
  try {
    await source.migrate('synthetic certificate seek', 'synthetic-certificate-seek')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
    await runInSeries(
      [
        [1, user.userId],
        [2, other.userId]
      ],
      async ([id, userId]) => {
        await source.knex('certificates').insert({
          ...dates,
          certificateId: id,
          userId,
          serialNumber: 'certificate-' + id,
          type: 'type',
          certifier: '02' + '11'.repeat(32),
          subject: '02' + '11'.repeat(32),
          revocationOutpoint: 'a'.repeat(64) + '.0',
          signature: 'synthetic',
          isDeleted: false
        })
      }
    )
    return { collation, pages: await largeSeeks(source, user.userId, other.userId) }
  } finally {
    await source.destroy()
    await control.raw('DROP DATABASE ??', [database])
  }
}
async function qualifyMysqlCertificateIndexSeeks(control, connection) {
  const results = []
  await runInSeries(['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'], async collation =>
    results.push(await qualifyCollation(control, connection, collation))
  )
  return results
}
module.exports = { qualifyMysqlCertificateIndexSeeks }
