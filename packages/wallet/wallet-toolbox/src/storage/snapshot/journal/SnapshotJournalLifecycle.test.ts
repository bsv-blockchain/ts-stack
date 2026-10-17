import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { migrateBeforeSnapshotJournal } from '../../../../test/utils/snapshotJournalHistoricalFixture'
import { KnexMigrations, SNAPSHOT_SQLITE_INDEX_MIGRATION } from '../../schema/KnexMigrations'
import {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration,
  readSnapshotJournalSqliteGeneration
} from './SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { snapshotJournalRevision, MAX_SNAPSHOT_JOURNAL_REVISION } from './SnapshotJournalRevision'
import {
  SNAPSHOT_JOURNAL_SOURCE_MIGRATION,
  SNAPSHOT_JOURNAL_DEFAULT_POLICY,
  SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS,
  readSnapshotJournalCaptureConfiguration
} from './SnapshotJournalLifecycle'

jest.setTimeout(30000)
const identity = '02' + '11'.repeat(32)
let directory: string, storage: StorageKnex
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'journal-registered-lifecycle-'))
  storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  await storage.knex.raw('PRAGMA journal_mode=WAL')
})
afterEach(async () => {
  await storage.destroy()
  await rm(directory, { recursive: true, force: true })
})

test('registered source installation completes all native bootstrap streams and freshly admits the current policy', async () => {
  await expect(storage.migrate('registered source', 'registered-source')).resolves.toBe(
    await KnexMigrations.latestMigration()
  )
  await storage.makeAvailable()
  await storage.findOrInsertUser(identity)
  expect(await storage.knex('knex_migrations').where('name', SNAPSHOT_JOURNAL_SOURCE_MIGRATION)).toHaveLength(1)
  expect(await storage.knex('snapshot_journal_bootstrap').first('stream', 'cursor', 'rowLimit')).toEqual({
    stream: 17,
    cursor: null,
    rowLimit: SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS
  })
  const config = await readSnapshotJournalCaptureConfiguration(storage.knex)
  expect(config).toEqual({ ceiling: MAX_SNAPSHOT_JOURNAL_REVISION, receiptPolicy: SNAPSHOT_JOURNAL_DEFAULT_POLICY })
  const source = await storage.openCurrentSnapshotJournalSource(identity)
  try {
    expect(source.sourceSchema).toBe(await KnexMigrations.latestMigration())
    await source.validateClosure()
  } finally {
    await closeSnapshotJournalSource(source)
  }
  // An actual migration stamp loss must refuse fresh ordinary negotiation;
  // previously successful source admission is not reused.
  await storage.knex('knex_migrations').where('name', SNAPSHOT_JOURNAL_SOURCE_MIGRATION).delete()
  await expect(storage.openCurrentSnapshotJournalSource(identity)).rejects.toThrow('owned supported backend')
})

test('an explicit historical owned capture retains custom policy and advances through actual registered migration without reset', async () => {
  await migrateBeforeSnapshotJournal(storage, 'historical source', 'historical-source')
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  await storage.insertTxLabel({
    txLabelId: 0,
    userId: user.userId,
    label: 'retained historical event',
    isDeleted: false,
    created_at: new Date(),
    updated_at: new Date()
  })
  const receiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 600000 },
    ceiling = snapshotJournalRevision('1000000')
  await installSnapshotJournalSqliteGeneration(storage.knex, ceiling, receiptPolicy)
  let complete = false
  for (let page = 0; page < 80 && !complete; page++)
    complete = (await copySnapshotJournalBootstrapPage(storage.knex, 1000000)).complete
  expect(complete).toBe(true)
  const generation = await completeSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  await expect(storage.openCurrentSnapshotJournalSource(identity)).rejects.toThrow('owned supported backend')
  const source = await storage.openSnapshotJournalSource(identity, { ceiling, receiptPolicy })
  try {
    expect(source.sourceSchema).toBe(SNAPSHOT_SQLITE_INDEX_MIGRATION)
    expect(source.receiptBinding.epoch).toBe(generation.epoch)
    await source.validateClosure()
  } finally {
    await closeSnapshotJournalSource(source)
  }
  const before = await storage.knex('snapshot_journal_clock').first()
  await expect(storage.migrate('historical source', 'historical-source')).rejects.toThrow('Drain live journal captures')
  expect(await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)).toEqual(generation)
  expect(await storage.knex('snapshot_journal_clock').first()).toEqual(before)
  // Closing the physical reader retains its receipt for destination recovery.
  // A schema addition requires the retained old admission to expire as well.
  expect(
    await storage
      .knex('snapshot_journal_receipts')
      .where({ requestId: source.receipt.requestId })
      .update({ expiresAt: 1 })
  ).toBe(1)
  await expect(storage.migrate('historical source', 'historical-source')).resolves.toBe(
    await KnexMigrations.latestMigration()
  )
  const migrated = await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  expect(migrated.epoch).not.toBe(generation.epoch)
  expect(migrated.source).not.toBe(generation.source)
  expect(migrated).toEqual({ ...generation, epoch: migrated.epoch, source: migrated.source })
  expect(await storage.knex('snapshot_journal_clock').first()).toEqual(before)
  expect(await storage.knex('snapshot_journal_bootstrap').first('rowLimit')).toEqual({ rowLimit: 1000000 })
  expect(await readSnapshotJournalCaptureConfiguration(storage.knex)).toEqual({ ceiling, receiptPolicy })
  const current = await storage.openCurrentSnapshotJournalSource(identity)
  try {
    expect(current.sourceSchema).toBe(await KnexMigrations.latestMigration())
    expect(current.receiptBinding.epoch).toBe(migrated.epoch)
  } finally {
    await closeSnapshotJournalSource(current)
  }
})

test('ordinary negotiated capture physically reclaims expired receipts without manual housekeeping', async () => {
  await storage.migrate('retention source', 'retention-source')
  await storage.makeAvailable()
  await storage.findOrInsertUser(identity)
  const first = await storage.openCurrentSnapshotJournalSource(identity)
  const requestId = first.receipt.requestId
  await closeSnapshotJournalSource(first)
  await storage.knex('snapshot_journal_receipts').where({ requestId }).update({ expiresAt: 1 })
  const second = await storage.openCurrentSnapshotJournalSource(identity)
  try {
    expect(await storage.knex('snapshot_journal_receipts').where({ requestId })).toHaveLength(0)
    expect(second.receipt.requestId).not.toBe(requestId)
    await second.validateClosure()
  } finally {
    await closeSnapshotJournalSource(second)
  }
})

test('provider destruction cancels and awaits the complete automatic-retention flight before closing storage', async () => {
  await storage.migrate('retention drain', 'retention-drain')
  await storage.makeAvailable()
  await storage.findOrInsertUser(identity)
  let entered!: () => void, release!: () => void
  const entering = new Promise<void>(yes => {
      entered = yes
    }),
    held = new Promise<void>(yes => {
      release = yes
    })
  const actual = storage.awaitSnapshotJournalMaintenanceCleanup.bind(storage)
  jest.spyOn(storage, 'awaitSnapshotJournalMaintenanceCleanup').mockImplementationOnce(async () => {
    await actual()
    entered()
    await held
  })
  const maintenance = storage.maintainCurrentSnapshotJournal().then(
    () => ({ error: undefined as unknown }),
    error => ({ error })
  )
  let closed = false
  let shutdown: Promise<void> | undefined
  try {
    await entering
    shutdown = storage.destroy().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await shutdown
    expect((await maintenance).error).toBeInstanceOf(SnapshotCancelledError)
    expect(closed).toBe(true)
  } finally {
    release()
    await maintenance
    await shutdown
    jest.restoreAllMocks()
  }
})
