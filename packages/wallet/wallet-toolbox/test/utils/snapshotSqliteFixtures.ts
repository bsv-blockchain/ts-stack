import { knex, type Knex } from 'knex'
import { installMembershipDraft } from './snapshotSqliteMaintenanceFixture'
import { addSnapshotProfileIndexes } from '../../src/storage/schema/snapshotProfileIndexMigration'
import { addSnapshotRelationIndexes } from '../../src/storage/schema/snapshotRelationIndexMigration'
import { addSnapshotCertificateIndexes } from '../../src/storage/schema/snapshotCertificateIndexMigration'
import { addSnapshotGlobalIndexes } from '../../src/storage/schema/snapshotGlobalIndexMigration'
import { expectRelationMembership } from './snapshotRelationFixtures'
import { expectCertificateMembership } from './snapshotCertificateFixtures'
import { expectGlobalMembership } from './snapshotGlobalFixtures'

export const profiles = [
  ['transactions', 'transactionId'],
  ['outputs', 'outputId'],
  ['certificates', 'certificateId'],
  ['tx_labels', 'txLabelId'],
  ['output_baskets', 'basketId'],
  ['output_tags', 'outputTagId'],
  ['commissions', 'commissionId'],
  ['sync_states', 'syncStateId']
]
export const numeric = [...profiles, ['proven_txs', 'provenTxId'], ['proven_tx_reqs', 'provenTxReqId']]
export const tables = [...numeric.map(([table]) => table), 'tx_labels_map', 'output_tags_map', 'certificate_fields']

export async function fixture(collation: string, recursive: boolean, corrected = true, filename = ':memory:') {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const schema = [
    'proven_txs(provenTxId INTEGER PRIMARY KEY,txid VARCHAR(64) NOT NULL UNIQUE)',
    'proven_tx_reqs(provenTxReqId INTEGER PRIMARY KEY,txid VARCHAR(64) NOT NULL UNIQUE,provenTxId INTEGER)',
    'transactions(transactionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,reference VARCHAR(64) NOT NULL UNIQUE,txid VARCHAR(64),provenTxId INTEGER)',
    'outputs(outputId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,transactionId INTEGER NOT NULL,vout INTEGER NOT NULL,UNIQUE(transactionId,vout,userId))',
    'certificates(certificateId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,type VARCHAR(100) NOT NULL,certifier VARCHAR(130) NOT NULL,serialNumber VARCHAR(100) NOT NULL,UNIQUE(userId,type,certifier,serialNumber))',
    'tx_labels(txLabelId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,label VARCHAR(300) NOT NULL,UNIQUE(label,userId))',
    'output_tags(outputTagId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,tag VARCHAR(150) NOT NULL,UNIQUE(tag,userId))',
    'output_baskets(basketId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,name VARCHAR(300) NOT NULL,UNIQUE(name,userId))',
    'commissions(commissionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,transactionId INTEGER NOT NULL UNIQUE)',
    'sync_states(syncStateId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,refNum VARCHAR(100) NOT NULL UNIQUE)',
    'tx_labels_map(txLabelId INTEGER NOT NULL,transactionId INTEGER NOT NULL,UNIQUE(txLabelId,transactionId))',
    'output_tags_map(outputTagId INTEGER NOT NULL,outputId INTEGER NOT NULL,UNIQUE(outputTagId,outputId))',
    'certificate_fields(userId INTEGER NOT NULL,fieldName VARCHAR(100) NOT NULL,certificateId INTEGER NOT NULL,fieldValue VARCHAR(255) NOT NULL,UNIQUE(fieldName,certificateId))'
  ]
  try {
    await k.raw('PRAGMA recursive_triggers=' + Number(recursive))
    if (filename !== ':memory:') await k.raw('PRAGMA journal_mode=WAL')
    for (const sql of schema)
      await k.raw('CREATE TABLE ' + sql.replaceAll(/VARCHAR\(\d+\)/g, type => type + ' COLLATE ' + collation))
    await k.schema.alterTable('transactions', table => {
      void table.index('txid')
    })
    await k.schema.alterTable('tx_labels_map', table => {
      void table.index('transactionId')
    })
    await k.schema.alterTable('output_tags_map', table => {
      void table.index('outputId')
    })
    await addSnapshotProfileIndexes(k)
    await addSnapshotRelationIndexes(k)
    await addSnapshotCertificateIndexes(k)
    await addSnapshotGlobalIndexes(k)
    await k.schema.createTable('knex_migrations', table => {
      table.increments('id')
      table.string('name').unique().notNullable()
      table.integer('batch').notNullable()
      table.timestamp('migration_time').notNullable()
    })
    await k('knex_migrations').insert(
      [
        '2026-10-01-003 add snapshot profile key indexes',
        '2026-10-01-004 add snapshot relation key indexes',
        '2026-10-01-005 add snapshot certificate field key indexes',
        '2026-10-01-006 add snapshot global reference indexes'
      ].map(name => ({ name, batch: 1, migration_time: new Date('2026-01-01') }))
    )
    if (corrected) await installMembershipDraft(k)
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}

export async function exact(k: Knex) {
  const expected: Array<{
    snapshotTableId: number
    snapshotUserId: number
    snapshotRowId: number
  }> = []
  for (const [id, [table, key]] of profiles.entries())
    for (const row of await k(table))
      expected.push({ snapshotTableId: id, snapshotUserId: row.userId, snapshotRowId: row[key] })
  expected.sort(
    (a, b) =>
      a.snapshotTableId - b.snapshotTableId || a.snapshotUserId - b.snapshotUserId || a.snapshotRowId - b.snapshotRowId
  )
  expect(await k('snapshot_profile_keys').orderBy(['snapshotTableId', 'snapshotUserId', 'snapshotRowId'])).toEqual(
    expected
  )
  await expectRelationMembership(k)
  await expectCertificateMembership(k)
  await expectGlobalMembership(k)
}

export function value(table: string, id: number, other: number, userId: number): Record<string, unknown> {
  const key = numeric.find(([name]) => name === table)?.[1]
  const row = key ? { [key]: id, ...(profiles.some(([name]) => name === table) ? { userId } : {}) } : {}
  switch (table) {
    case 'transactions':
      return { ...row, reference: 'r' + other, txid: 't' + other, provenTxId: other }
    case 'outputs':
      return { ...row, transactionId: other, vout: id % 2 }
    case 'certificates':
      return { ...row, type: 'a', certifier: 'b', serialNumber: 's' + other }
    case 'tx_labels':
      return { ...row, label: 'l' + other }
    case 'output_tags':
      return { ...row, tag: 'g' + other }
    case 'output_baskets':
      return { ...row, name: 'b' + other }
    case 'commissions':
      return { ...row, transactionId: other }
    case 'sync_states':
      return { ...row, refNum: 'r' + other }
    case 'proven_txs':
      return { ...row, txid: 't' + other }
    case 'proven_tx_reqs':
      return { ...row, txid: 't' + other, provenTxId: other }
    case 'tx_labels_map':
      return { txLabelId: id, transactionId: other }
    case 'output_tags_map':
      return { outputTagId: id, outputId: other }
    case 'certificate_fields':
      return {
        userId,
        fieldName: ['a', 'A', 'a ', 'é', 'A\0B', '名字'][id - 1],
        certificateId: other,
        fieldValue: 'p'
      }
    default:
      throw new Error('Unknown fixture table')
  }
}
export function keyOf(table: string, id: number, other: number) {
  const key = numeric.find(([name]) => name === table)?.[1]
  if (key) return { [key]: id }
  const result = value(table, id, other, 1)
  delete result.userId
  delete result.fieldValue
  return result
}
export async function replace(k: Knex, table: string, row: Record<string, unknown>) {
  const query = k(table).insert(row).toSQL()
  await k.raw(query.sql.replace(/^insert/i, 'INSERT OR REPLACE'), query.bindings)
}
