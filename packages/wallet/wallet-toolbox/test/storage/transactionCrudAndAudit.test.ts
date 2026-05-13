import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import {
  findTransactionNew,
  findTransactionNewByTxid,
  getChainTip,
  insertTransactionNew,
  setChainTip,
  transitionProcessing
} from '../../src/storage/schema/transactionCrud'
import { appendTxAudit, listAuditForTransaction } from '../../src/storage/schema/txAudit'
import { runSchemaCutover } from '../../src/storage/schema/schemaCutover'

describe('Transaction CRUD + audit (Knex / SQLite)', () => {
  jest.setTimeout(60_000)
  let knex: Knex

  beforeAll(async () => {
    const file = await _tu.newTmpFile('crud.sqlite', true, false, false)
    knex = _tu.createLocalSQLite(file)
    const config = { migrationSource: new KnexMigrations('test', 'crud test', '1'.repeat(64), 1000) }
    await knex.migrate.latest(config)
    // CRUD module targets the post-cutover `transactions` table.
    await runSchemaCutover(knex)
  })

  afterAll(async () => {
    if (knex != null) await knex.destroy()
  })

  test('insert + findByTxid + findById round-trip', async () => {
    const id = await insertTransactionNew(knex, {
      txid: 'a'.repeat(64),
      processing: 'queued',
      processingChangedAt: new Date('2026-05-11T12:00:00Z'),
      attempts: 0,
      rebroadcastCycles: 0,
      wasBroadcast: false,
      isCoinbase: false,
      rowVersion: 0
    })
    expect(id).toBeGreaterThan(0)
    const byTxid = await findTransactionNewByTxid(knex, 'a'.repeat(64))
    expect(byTxid?.processing).toBe('queued')
    const byId = await findTransactionNew(knex, id)
    expect(byId?.txid).toBe('a'.repeat(64))
  })

  test('transitionProcessing performs CAS + writes audit row on success', async () => {
    const row = await findTransactionNewByTxid(knex, 'a'.repeat(64))
    const next = await transitionProcessing(knex, {
      transactionId: row!.transactionId,
      expectedFromState: 'queued',
      toState: 'sending',
      provider: 'arc-main'
    })
    expect(next?.processing).toBe('sending')
    expect(next?.lastProvider).toBe('arc-main')

    const audit = await listAuditForTransaction(knex, row!.transactionId)
    expect(audit).toHaveLength(1)
    expect(audit[0].event).toBe('processing.changed')
    expect(audit[0].fromState).toBe('queued')
    expect(audit[0].toState).toBe('sending')
  })

  test('transitionProcessing rejects illegal transition + writes audit row', async () => {
    const row = await findTransactionNewByTxid(knex, 'a'.repeat(64))
    const next = await transitionProcessing(knex, {
      transactionId: row!.transactionId,
      expectedFromState: 'sending',
      toState: 'reorging'
    })
    expect(next).toBeUndefined()
    const audit = await listAuditForTransaction(knex, row!.transactionId)
    expect(audit.at(-1)?.event).toBe('processing.rejected')
    expect(audit.at(-1)?.detailsJson).toMatch(/illegal transition/)
  })

  test('transitionProcessing rejects when CAS state does not match', async () => {
    const row = await findTransactionNewByTxid(knex, 'a'.repeat(64))
    const next = await transitionProcessing(knex, {
      transactionId: row!.transactionId,
      expectedFromState: 'queued',
      toState: 'sent'
    })
    expect(next).toBeUndefined()
  })

  test('chain tip is a true singleton', async () => {
    await setChainTip(knex, { height: 800001, blockHash: 'h'.repeat(64) })
    await setChainTip(knex, { height: 800002, blockHash: 'i'.repeat(64), merkleRoot: 'm'.repeat(64) })
    const tip = await getChainTip(knex)
    expect(tip?.height).toBe(800002)
    expect(tip?.merkleRoot).toBe('m'.repeat(64))
    const rows = await knex('chain_tip').select('*')
    expect(rows).toHaveLength(1)
  })

  test('appendTxAudit returns increasing ids and persists payload', async () => {
    const id1 = await appendTxAudit(knex, { event: 'test.event', details: { ok: true } })
    const id2 = await appendTxAudit(knex, { event: 'test.event' })
    expect(id2).toBeGreaterThan(id1)
    const stored = await knex('tx_audit').where({ auditId: id1 }).first()
    expect(JSON.parse(stored.details_json)).toEqual({ ok: true })
  })
})
