import { knex as makeKnex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'

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

describe('StorageKnex counts filtered rows independently of pagination', () => {
  let knex: Knex
  let storage: StorageKnex

  beforeEach(async () => {
    knex = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'ttn', knex })
    await knex.schema.createTable('certificates', table => {
      table.increments('certificateId')
      table.integer('userId')
      table.string('certifier')
      table.string('type')
    })
    await knex('certificates').insert([
      ...Array.from({ length: 5 }, () => ({ userId: 1, certifier: 'owned', type: 'credential' })),
      { userId: 2, certifier: 'owned', type: 'credential' },
      { userId: 1, certifier: 'other', type: 'credential' },
      { userId: 1, certifier: 'owned', type: 'other' }
    ])
  })

  afterEach(async () => {
    await knex.destroy()
  })

  test.each([0, 2, 5, 100])('counts all matching certificates at offset %i', async offset => {
    const query = storage.findCertificatesQuery({
      partial: { userId: 1 },
      certifiers: ['owned'],
      types: ['credential'],
      paged: { limit: 2, offset }
    })
    expect(await storage.getCount(query)).toBe(5)
  })

  test('counts an empty filtered result beyond its last page', async () => {
    const query = storage.findCertificatesQuery({ partial: { userId: 3 }, paged: { limit: 2, offset: 100 } })
    expect(await storage.getCount(query)).toBe(0)
  })
})
