import { knex as makeKnex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import type { TableSettings } from '../schema/tables'

describe('StorageKnex paged queries order by key', () => {
  let knex: Knex
  let storage: StorageKnex

  beforeEach(() => {
    knex = makeKnex({ client: 'pg' })
    storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test', knex })
  })

  afterEach(async () => {
    await knex.destroy()
  })

  test.each([
    ['getProvenTxsForUserQuery', 'order by "proven_txs"."provenTxId" asc'],
    ['getProvenTxReqsForUserQuery', 'order by "proven_tx_reqs"."provenTxReqId" asc'],
    ['getTxLabelMapsForUserQuery', 'order by "tx_labels_map"."txLabelId" asc, "tx_labels_map"."transactionId" asc'],
    ['getOutputTagMapsForUserQuery', 'order by "output_tags_map"."outputTagId" asc, "output_tags_map"."outputId" asc']
  ] as const)('%s orders paged rows', (method, orderBy) => {
    expect(storage[method]({ userId: 1, paged: { limit: 10, offset: 20 } }).toSQL().sql).toContain(orderBy)
    expect(storage[method]({ userId: 1 }).toSQL().sql).not.toContain('order by')
  })

  test('find queries order paged rows by primary key', () => {
    const paged = { limit: 10, offset: 20 }
    expect(storage.findOutputsQuery({ partial: { userId: 1 }, paged }).toSQL().sql).toContain(
      'order by "outputs"."outputId" asc'
    )
    expect(storage.findCertificateFieldsQuery({ partial: { userId: 1 }, paged }).toSQL().sql).toContain(
      'order by "certificate_fields"."certificateId" asc, "certificate_fields"."fieldName" asc'
    )
    expect(storage.findOutputsQuery({ partial: { userId: 1 } }).toSQL().sql).not.toContain('order by')
  })

  test('orderDescending keeps its descending order', () => {
    const sql = storage
      .findOutputsQuery({ partial: { userId: 1 }, paged: { limit: 10 }, orderDescending: true })
      .toSQL().sql
    expect(sql).toContain('order by "outputId" desc')
    expect(sql).not.toContain('asc')
  })
})

describe('StorageKnex MySQL pages outputs and transactions by key first', () => {
  let knex: Knex
  let storage: StorageKnex

  beforeEach(() => {
    knex = makeKnex({ client: 'mysql2' })
    storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test', knex })
    storage._settings = { dbtype: 'MySQL' } as TableSettings
  })

  afterEach(async () => {
    await knex.destroy()
  })

  test.each([
    ['outputs', 'outputId'],
    ['transactions', 'transactionId']
  ] as const)('reads only the requested page of %s rows', (table, key) => {
    const since = new Date('2026-01-01T00:00:00.000Z')
    const args = { partial: { userId: 1 }, since, paged: { limit: 80, offset: 160 } }
    const query = table === 'outputs'
      ? storage.findOutputsQuery({ ...args, noScript: true, txStatus: ['completed'] })
      : storage.findTransactionsQuery({ ...args, noRawTx: true, status: ['completed'] })
    const { sql, bindings } = query.toSQL()
    const page =
      `select \`${table}\`.\`${key}\` from \`${table}\` where \`userId\` = ? and \`updated_at\` >= ? and `
    expect(sql).toContain(`where \`${table}\`.\`${key}\` in (select \`${key}\` from (${page}`)
    expect(sql).toContain(`order by \`${table}\`.\`${key}\` asc limit ? offset ?) as \`page\`) order by \`${table}\`.\`${key}\` asc`)
    expect(sql.endsWith('asc')).toBe(true)
    expect(sql).not.toContain('lockingScript')
    expect(sql.startsWith('select *')).toBe(false)
    expect(bindings.slice(0, 1)).toEqual([1])
    expect(bindings.slice(-2)).toEqual([80, 160])
  })

  test('leaves counts, unpaged and descending queries unchanged', () => {
    const paged = { limit: 10, offset: 20 }
    expect(storage.findOutputsQuery({ partial: { userId: 1 }, paged }, true).toSQL().sql).toBe(
      'select * from `outputs` where `userId` = ? order by `outputs`.`outputId` asc limit ? offset ?'
    )
    expect(storage.findTransactionsQuery({ partial: { userId: 1 }, paged }, true).toSQL().sql).toBe(
      'select * from `transactions` where `userId` = ? order by `transactions`.`transactionId` asc limit ? offset ?'
    )
    expect(storage.findTransactionsQuery({ partial: { userId: 1 } }).toSQL().sql).toBe(
      'select * from `transactions` where `userId` = ?'
    )
    expect(
      storage.findOutputsQuery({ partial: { userId: 1 }, paged, orderDescending: true }).toSQL().sql
    ).toBe('select * from `outputs` where `userId` = ? order by `outputId` desc limit ? offset ?')
  })

  test('other databases keep a single paged query', () => {
    storage._settings = { dbtype: 'SQLite' } as TableSettings
    expect(storage.findOutputsQuery({ partial: { userId: 1 }, paged: { limit: 10, offset: 20 } }).toSQL().sql).toBe(
      'select * from `outputs` where `userId` = ? order by `outputs`.`outputId` asc limit ? offset ?'
    )
  })
})
