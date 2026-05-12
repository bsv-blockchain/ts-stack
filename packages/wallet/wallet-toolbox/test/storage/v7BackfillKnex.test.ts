import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { runV7KnexBackfill } from '../../src/storage/schema/v7Backfill.knex'

describe('V7 backfill (Knex / SQLite)', () => {
  jest.setTimeout(60_000)

  let knex: Knex

  beforeAll(async () => {
    const file = await _tu.newTmpFile('v7backfill.sqlite', true, false, false)
    knex = _tu.createLocalSQLite(file)
    const source = new KnexMigrations('test', 'v7 backfill test', '1'.repeat(64), 1000)
    // Run every migration up to but not including the cutover. The standalone
    // backfill helpers exercised by this suite are intended to run pre-cutover,
    // while legacy table names still apply.
    const names = (await source.getMigrations()).filter(
      n => n !== '2026-05-12-001 V7 cutover (remap FKs, rename legacy tables, swap transactions_v7)'
    )
    for (const name of names) {
      const m = await source.getMigration(name)
      await m.up(knex)
    }
  })

  afterAll(async () => {
    if (knex != null) await knex.destroy()
  })

  test('backfills transactions_v7 and actions from legacy rows', async () => {
    const txidA = 'a'.repeat(64)
    const txidB = 'b'.repeat(64)

    await knex('users').insert({
      userId: 1,
      identityKey: '02'.padEnd(66, '0'),
      activeStorage: '1'.repeat(64)
    })

    const [provenId] = await knex('proven_txs').insert({
      txid: txidA,
      height: 800001,
      index: 4,
      merklePath: Buffer.from([5, 6]),
      rawTx: Buffer.from([1, 2]),
      blockHash: 'h'.repeat(64),
      merkleRoot: 'm'.repeat(64)
    })

    await knex('proven_tx_reqs').insert({
      provenTxId: provenId,
      status: 'completed',
      attempts: 2,
      notified: true,
      txid: txidA,
      history: '{}',
      notify: '{}',
      rawTx: Buffer.from([1, 2]),
      wasBroadcast: true,
      rebroadcastAttempts: 1
    })

    await knex('transactions').insert([
      {
        userId: 1,
        provenTxId: provenId,
        status: 'completed',
        reference: 'ref-A',
        isOutgoing: true,
        satoshis: 1000,
        description: 'pay A',
        txid: txidA
      },
      {
        userId: 1,
        status: 'sending',
        reference: 'ref-B',
        isOutgoing: true,
        satoshis: 2500,
        description: 'pay B',
        txid: txidB
      }
    ])

    const stats = await runV7KnexBackfill(knex, new Date('2026-05-11T12:00:00Z'))

    expect(stats.reqsBackfilled).toBe(1)
    expect(stats.legacyTxOnlyBackfilled).toBe(1)
    expect(stats.actionsBackfilled).toBe(2)
    expect(stats.labelMapsRepointed).toBe(2)

    const v7Rows = await knex('transactions_v7').select('*')
    expect(v7Rows).toHaveLength(2)
    const byTxid = Object.fromEntries(v7Rows.map(r => [r.txid, r]))
    expect(byTxid[txidA].processing).toBe('proven')
    expect(byTxid[txidA].height).toBe(800001)
    expect(byTxid[txidB].processing).toBe('sending')
    expect(byTxid[txidB].height).toBeNull()

    const actions = await knex('actions').select('*').orderBy('reference')
    expect(actions).toHaveLength(2)
    expect(actions[0].reference).toBe('ref-A')
    expect(actions[0].userId).toBe(1)
    expect(actions[1].reference).toBe('ref-B')

    const a = await knex('actions').where({ reference: 'ref-A' }).first()
    const v7A = await knex('transactions_v7').where({ txid: txidA }).first()
    expect(a.transactionId).toBe(v7A.transactionId)
  })

  test('is idempotent on a second run', async () => {
    const before = await knex('transactions_v7').count<{ c: number }>({ c: '*' }).first()
    const beforeActions = await knex('actions').count<{ c: number }>({ c: '*' }).first()
    await runV7KnexBackfill(knex)
    const after = await knex('transactions_v7').count<{ c: number }>({ c: '*' }).first()
    const afterActions = await knex('actions').count<{ c: number }>({ c: '*' }).first()
    expect(after?.c).toBe(before?.c)
    expect(afterActions?.c).toBe(beforeActions?.c)
  })
})
