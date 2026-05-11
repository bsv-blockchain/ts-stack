import { Knex } from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { KnexMigrations } from '../../src/index.all'
import { releaseLease, renewLease, tryClaimLease } from '../../src/storage/schema/v7MonitorLease'

describe('V7 monitor lease (Knex / SQLite)', () => {
  jest.setTimeout(60_000)
  let knex: Knex

  beforeAll(async () => {
    const file = await _tu.newTmpFile('v7lease.sqlite', true, false, false)
    knex = _tu.createLocalSQLite(file)
    const config = { migrationSource: new KnexMigrations('test', 'v7 lease test', '1'.repeat(64), 1000) }
    await knex.migrate.latest(config)
  })

  afterAll(async () => {
    if (knex != null) await knex.destroy()
  })

  test('first claim succeeds and second contending owner fails', async () => {
    const t0 = new Date('2026-05-11T12:00:00Z')
    const a = await tryClaimLease(knex, { taskName: 'proof', ownerId: 'A', ttlMs: 5000 }, t0)
    expect(a.acquired).toBe(true)
    expect(a.lease?.ownerId).toBe('A')

    const b = await tryClaimLease(knex, { taskName: 'proof', ownerId: 'B', ttlMs: 5000 }, t0)
    expect(b.acquired).toBe(false)
  })

  test('renew by current owner extends expiry; foreign renew fails', async () => {
    const t0 = new Date('2026-05-11T12:00:00Z')
    const r = await renewLease(knex, { taskName: 'proof', ownerId: 'A', ttlMs: 10_000 }, t0)
    expect(r.acquired).toBe(true)
    expect(r.lease?.renewCount).toBeGreaterThan(0)

    const r2 = await renewLease(knex, { taskName: 'proof', ownerId: 'B', ttlMs: 10_000 }, t0)
    expect(r2.acquired).toBe(false)
  })

  test('stale lease can be taken over by a new owner', async () => {
    const later = new Date('2026-05-11T12:00:11Z')
    const b = await tryClaimLease(knex, { taskName: 'proof', ownerId: 'B', ttlMs: 5000 }, later)
    expect(b.acquired).toBe(true)
    expect(b.lease?.ownerId).toBe('B')
    expect(b.lease?.renewCount).toBe(0)
  })

  test('release deletes the row only for current owner', async () => {
    const wrong = await releaseLease(knex, { taskName: 'proof', ownerId: 'A' })
    expect(wrong).toBe(false)
    const right = await releaseLease(knex, { taskName: 'proof', ownerId: 'B' })
    expect(right).toBe(true)
    const after = await knex('monitor_lease').where({ task_name: 'proof' }).first()
    expect(after).toBeUndefined()
  })
})
