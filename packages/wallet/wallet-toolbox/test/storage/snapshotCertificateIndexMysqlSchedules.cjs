const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const fc = require('fast-check')
const helper = require('../../out/src/storage/schema/snapshotCertificateIndexMigration.js')
const names = ['', 'A', 'a', 'é', 'e\u0301', 'Ω', '名字', '🚲', 'a ', 'A\0B', '😀'.repeat(100)]
async function oracle(k) {
  const result = await k.raw(
    'SELECT userId,fieldName,certificateId,SUM(bit) AS membership FROM (SELECT userId,fieldName,certificateId,1 AS bit FROM certificate_fields UNION ALL SELECT c.userId,f.fieldName,f.certificateId,2 AS bit FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId) owned_fields GROUP BY userId,fieldName,certificateId ORDER BY userId,fieldName,certificateId'
  )
  const expected = (k.client.config.client === 'mysql2' ? result[0] : result).map(row => ({
    ...row,
    membership: Number(row.membership)
  }))
  const actual = await k('snapshot_certificate_field_keys')
    .select({
      userId: 'snapshotUserId',
      fieldName: 'snapshotFieldName',
      certificateId: 'snapshotCertificateId',
      membership: 'snapshotMembership'
    })
    .orderBy(['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'])
  assert.deepEqual(actual, expected)
}
async function seed(k) {
  await k('certificate_fields').delete()
  await k('certificates').delete()
  await k('certificates').insert([
    { certificateId: 1, userId: 1 },
    { certificateId: 2, userId: 2 }
  ])
  await runInSeries(names.entries(), async ([i, fieldName]) => {
    await k('certificate_fields')
      .insert({ userId: (i % 2) + 1, fieldName, certificateId: (i % 2) + 1, fieldValue: 'initial' })
      .onConflict(['fieldName', 'certificateId'])
      .merge(['userId', 'fieldValue'])
  })
}
async function operation(k, op, counts) {
  counts[op.kind]++
  const fieldName = names[op.name],
    certificateId = op.id
  const selected = () => k('certificate_fields').where({ fieldName, certificateId })
  switch (op.kind) {
    case 0:
      await k('certificates').insert({ certificateId, userId: op.user }).onConflict('certificateId').merge(['userId'])
      break
    case 1:
      await k('certificates').where({ certificateId }).delete()
      break
    case 2:
      await k('certificate_fields')
        .insert({ userId: op.user, fieldName, certificateId, fieldValue: 'value-' + op.user })
        .onConflict(['fieldName', 'certificateId'])
        .merge(['userId', 'fieldValue'])
      break
    case 3:
      await selected().delete()
      break
    case 4:
      await selected().update({ userId: op.user })
      break
    case 5:
      if (
        !(await k('certificates')
          .where({ certificateId: certificateId + 4 })
          .first())
      )
        await k('certificates')
          .where({ certificateId })
          .update({ certificateId: certificateId + 4 })
      break
    case 6:
      try {
        await selected().update({ fieldName: names[(op.name + 1) % names.length] })
      } catch (error) {
        if (!['ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_UNIQUE'].includes(error.code)) throw error
      }
      break
    case 7:
      await assert.rejects(
        k.transaction(async trx => {
          await trx('certificate_fields').where({ fieldName, certificateId }).delete()
          throw new Error('synthetic operation rollback')
        }),
        /synthetic operation rollback/
      )
      break
    case 8:
      await k('certificates')
        .where({ certificateId })
        .update({ isDeleted: k.raw('1-isDeleted') })
      break
  }
}
async function qualify(k, collation) {
  const mysql = k.client.config.client === 'mysql2'
  await k.raw(
    mysql
      ? 'CREATE TABLE certificates(certificateId INT UNSIGNED PRIMARY KEY,userId INT UNSIGNED NOT NULL,isDeleted TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB'
      : 'CREATE TABLE certificates(certificateId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,isDeleted INTEGER NOT NULL DEFAULT 0)'
  )
  await k.raw(
    mysql
      ? 'CREATE TABLE certificate_fields(userId INT UNSIGNED NOT NULL,fieldName VARCHAR(100) NOT NULL,certificateId INT UNSIGNED NOT NULL,fieldValue VARCHAR(255) NOT NULL,UNIQUE(fieldName,certificateId)) ENGINE=InnoDB'
      : `CREATE TABLE certificate_fields(userId INTEGER NOT NULL,fieldName VARCHAR(100) COLLATE ${collation} NOT NULL,certificateId INTEGER NOT NULL,fieldValue VARCHAR(255) NOT NULL,UNIQUE(fieldName,certificateId))`
  )
  await seed(k)
  assert.equal(await helper.readSnapshotCertificateIndexState(k), false)
  await helper.addSnapshotCertificateIndexes(k)
  await oracle(k)
  await helper.addSnapshotCertificateIndexes(k)
  await oracle(k)
  assert.equal(await helper.readSnapshotCertificateIndexState(k), false)
  await k.schema.createTable('knex_migrations', t => t.string('name'))
  await k('knex_migrations').insert({ name: helper.SNAPSHOT_CERTIFICATE_INDEX_MIGRATION })
  assert.equal(await helper.readSnapshotCertificateIndexState(k), true)
  const generated = fc.record({
    kind: fc.integer({ min: 0, max: 8 }),
    id: fc.integer({ min: 1, max: 4 }),
    user: fc.integer({ min: 1, max: 3 }),
    name: fc.integer({ min: 0, max: names.length - 1 })
  })
  const counts = Array.from({ length: 9 }, () => 0)
  await fc.assert(
    fc.asyncProperty(fc.array(generated, { minLength: 1, maxLength: 24 }), async schedule => {
      await seed(k)
      await runInSeries(schedule, async op => {
        await operation(k, op, counts)
        await oracle(k)
      })
    }),
    { numRuns: 300, seed: 3242026 }
  )
  const sourceRows = await k('certificate_fields').orderBy(['fieldName', 'certificateId'])
  await helper.removeSnapshotCertificateIndexes(k)
  assert.deepEqual(await k('certificate_fields').orderBy(['fieldName', 'certificateId']), sourceRows)
  await assert.rejects(helper.readSnapshotCertificateIndexState(k), /incomplete/)
  await helper.addSnapshotCertificateIndexes(k)
  await oracle(k)
  assert.equal(await helper.readSnapshotCertificateIndexState(k), true)
  return {
    dialect: mysql ? 'mysql' : 'sqlite',
    collation,
    runs: 300,
    seed: 3242026,
    counts,
    repeatedInstall: true,
    journalAdoption: true,
    removalPreservesSource: true
  }
}
async function qualifyMysqlCertificateIndexSchedules(control, connection) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const results = []
  await runInSeries(['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'], async collation => {
    const database = 'ts569_certificate_schedules_' + randomUUID().replaceAll('-', '')
    await control.raw(`CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE ${collation}`, [database])
    const k = knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
    try {
      results.push(await qualify(k, collation))
    } finally {
      await k.destroy()
      await control.raw('DROP DATABASE ??', [database])
    }
  })
  return results
}
module.exports = { oracle, qualifyMysqlCertificateIndexSchedules }
