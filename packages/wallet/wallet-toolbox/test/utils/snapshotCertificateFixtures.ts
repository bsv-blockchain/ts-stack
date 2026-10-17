import assert from 'node:assert/strict'
import { knex, type Knex } from 'knex'
import { runInSeries } from '../../src/utility/runInSeries'

// Independently defined source graph and SQL union oracle; no migration registry
// or auxiliary trigger expression is used to derive expected membership.
export const certificateFieldNames = ['', 'A', 'a', 'é', 'e\u0301', 'Ω', '名字', '🚲', 'a ', 'A\0B', '😀'.repeat(100)]
export interface CertificateOperation {
  kind: number
  id: number
  user: number
  name: number
}

export async function createCertificateSource(k: Knex, collation = 'BINARY'): Promise<void> {
  const mysql = String(k.client.config.client).includes('mysql')
  assert.ok(['BINARY', 'NOCASE', 'RTRIM'].includes(collation))
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
}

export async function minimalCertificateDatabase(collation = 'BINARY'): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await createCertificateSource(k, collation)
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}

export async function expectCertificateMembership(k: Knex): Promise<void> {
  const result = await k.raw(
    'SELECT userId,fieldName,certificateId,SUM(bit) AS membership FROM (SELECT userId,fieldName,certificateId,1 AS bit FROM certificate_fields UNION ALL SELECT c.userId,f.fieldName,f.certificateId,2 AS bit FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId) owned_fields GROUP BY userId,fieldName,certificateId ORDER BY userId,fieldName,certificateId'
  )
  const rows: Array<{ userId: number; fieldName: string; certificateId: number; membership: number | string }> = String(
    k.client.config.client
  ).includes('mysql')
    ? result[0]
    : result
  const expected = rows.map(row => ({ ...row, membership: Number(row.membership) }))
  const actual = await k('snapshot_certificate_field_keys')
    .select({
      userId: 'snapshotUserId',
      fieldName: 'snapshotFieldName',
      certificateId: 'snapshotCertificateId',
      membership: 'snapshotMembership'
    })
    .orderBy(['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'])
  expect(actual).toEqual(expected)
}

export async function seedCertificateFields(k: Knex): Promise<void> {
  await k('certificate_fields').delete()
  await k('certificates').delete()
  await k('certificates').insert([
    { certificateId: 1, userId: 1 },
    { certificateId: 2, userId: 2 }
  ])
  await runInSeries(certificateFieldNames.entries(), async ([i, fieldName]) => {
    await k('certificate_fields')
      .insert({ userId: (i % 2) + 1, fieldName, certificateId: (i % 2) + 1, fieldValue: 'initial' })
      .onConflict(['fieldName', 'certificateId'])
      .merge(['userId', 'fieldValue'])
  })
}

export async function applyCertificateOperation(k: Knex, op: CertificateOperation): Promise<void> {
  const fieldName = certificateFieldNames[op.name],
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
        await selected().update({ fieldName: certificateFieldNames[(op.name + 1) % certificateFieldNames.length] })
      } catch (error) {
        if (!['ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_UNIQUE'].includes((error as { code: string }).code)) throw error
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
    default:
      throw new Error('Unknown certificate fixture operation')
  }
}
