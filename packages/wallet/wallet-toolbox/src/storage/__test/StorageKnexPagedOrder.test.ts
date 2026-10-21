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
