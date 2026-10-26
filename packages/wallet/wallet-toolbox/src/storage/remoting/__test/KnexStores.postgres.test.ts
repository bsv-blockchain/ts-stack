import { PeerSession } from '@bsv/sdk'
import { Knex } from 'knex'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import {
  AUTH_MESSAGE_NONCE_MIGRATION,
  AUTH_SESSION_MIGRATION,
  KnexMigrations,
  PAYMENT_REPLAY_MIGRATION,
  SYNC_TRANSFER_MIGRATION
} from '../../schema/KnexMigrations'
import { KnexPaymentReplayStore } from '../KnexPaymentReplayStore'
import { KnexSessionManager } from '../KnexSessionManager'
import { KnexSyncTransferStore } from '../KnexSyncTransferStore'
import { encodeSyncTransfer, receiveSyncTransfer, syncTransferDigest } from '../SyncTransfer'

const env = _tu.getEnvFlags('test')
const describePostgres = env.runPostgres ? describe : describe.skip

/**
 * The SQLite suites for these stores cover their behavior. This suite covers
 * the Postgres-specific paths: bytea staging, boolean merges and duplicate-key
 * detection. Requires `RUNPOSTGRES` and `POSTGRES_CONNECTION`.
 */
describePostgres('Knex remoting stores on Postgres', () => {
  const migrations = new KnexMigrations('test', 'postgres store tests', '1'.repeat(64), 1024)
  const migrationNames = [
    SYNC_TRANSFER_MIGRATION,
    AUTH_SESSION_MIGRATION,
    AUTH_MESSAGE_NONCE_MIGRATION,
    PAYMENT_REPLAY_MIGRATION
  ]
  const tables = ['sync_transfer_parts', 'sync_transfers', 'auth_message_nonces', 'auth_sessions', 'payment_replays']
  let knexA: Knex
  let knexB: Knex
  let now: number

  beforeAll(async () => {
    knexA = await _tu.createLocalPostgres('knexstorestest')
    knexB = await _tu.createLocalPostgres('knexstorestest')
  })

  beforeEach(async () => {
    for (const table of tables) await knexA.schema.dropTableIfExists(table)
    for (const name of migrationNames) await (await migrations.getMigration(name)).up(knexA)
    now = 1_000
  })

  afterAll(async () => {
    await knexA.destroy()
    await knexB.destroy()
  })

  test('sync transfer stores and replays bytea parts', async () => {
    const store = new KnexSyncTransferStore(knexA, { version: 1, partBytes: 1024, maxBytes: 1024 * 1024 })
    const value = { bytes: Array.from({ length: 5000 }, (_, i) => i % 256) }
    const bytes = encodeSyncTransfer(value)
    const read = await store.beginRead('alice', syncTransferDigest(bytes), bytes)
    expect(await receiveSyncTransfer(read, offset => store.read('alice', read.transferId, offset))).toEqual(value)

    const write = await store.beginWrite('bob', syncTransferDigest(bytes), bytes.length)
    for (let offset = 0; offset < bytes.length; offset += write.partBytes) {
      await store.write('bob', write.transferId, offset, bytes.subarray(offset, offset + write.partBytes))
    }
    expect((await store.loadWrite('bob', write.transferId)).bytes).toEqual(bytes)
    await store.complete('bob', write.transferId, { ok: true })
    expect((await store.loadWrite('bob', write.transferId)).result).toEqual({ ok: true })
  })

  test('session manager merges equal-timestamp progress without a downgrade', async () => {
    const options = { ttlMs: 100, now: () => now }
    const managerA = new KnexSessionManager(knexA, options)
    const managerB = new KnexSessionManager(knexB, options)
    const pending = makeSession({ certificatesRequired: true, certificatesValidated: false })
    await managerA.addSession(pending)
    const authenticated = makeSession({
      peerNonce: 'peer-established',
      isAuthenticated: true,
      certificatesRequired: true,
      certificatesValidated: true
    })
    await managerB.updateSession(authenticated)
    await managerA.updateSession(pending)
    await expect(managerA.getSession('session-nonce')).resolves.toEqual(authenticated)
    await expect(managerA.getSession('identity-key')).resolves.toEqual(authenticated)

    const unvalidated = makeSession({ sessionNonce: 'other', certificatesValidated: undefined, lastUpdate: 1_010 })
    await managerA.addSession(unvalidated)
    await managerB.updateSession({ ...unvalidated, certificatesValidated: false })
    await expect(managerA.getSession('other')).resolves.toMatchObject({ certificatesValidated: false })

    await expect(managerA.claimMessageNonce('session-nonce', 'message-a')).resolves.toBe(true)
    await expect(managerB.claimMessageNonce('session-nonce', 'message-a')).resolves.toBe(false)
  })

  test('payment replay store detects duplicate claims', async () => {
    const store = new KnexPaymentReplayStore(knexA, 1)
    await expect(store.claim('transaction-id')).resolves.toBe(true)
    await expect(store.claim('transaction-id')).resolves.toBe(false)
  })
})

function makeSession(overrides: Partial<PeerSession> = {}): PeerSession {
  return {
    isAuthenticated: false,
    sessionNonce: 'session-nonce',
    peerIdentityKey: 'identity-key',
    lastUpdate: 1_000,
    certificatesRequired: false,
    certificatesValidated: true,
    ...overrides
  }
}
