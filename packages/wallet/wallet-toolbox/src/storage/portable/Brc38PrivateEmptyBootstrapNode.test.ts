import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import * as emptyBootstrap from './Brc38PrivateEmptyBootstrapNode'
import { names } from '../schema/snapshotSqliteIndexGeneration'
import { numeric } from '../schema/snapshotSqliteMembership'

describe('actual owned fresh empty private-native bootstrap quantum', () => {
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()))
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Empty bootstrap fixture cleanup remains required')
  })
  async function fixture() {
    const proof = restoreProofFixture(),
      staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    cleanup.push(async () => await staged.close())
    const store = staged.value.reservation.store
    async function initialize() {
      const restore = await Brc38PrivateNativeRestoreNode.open(store, {
        receiptPolicy: previewReceiptPolicy,
        maximumStepRows: 16,
        maximumStepBytes: 2097152,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096,
        services: proof.services
      })
      return restore
    }
    return { store, initialize }
  }
  test('one actual writer proves all18 empty tables with scalar LIMIT1 before committing the unchanged original terminal tuple', async () => {
    const { store, initialize } = await fixture(),
      actual = emptyBootstrap.completeBrc38OwnedEmptyBootstrap,
      queries: Array<{ sql: string; bindings?: unknown[] }> = []
    const observe = (query: { sql: string; bindings?: unknown[] }) => {
      queries.push(query)
    }
    let completed = false
    const shortcut = jest
      .spyOn(emptyBootstrap, 'completeBrc38OwnedEmptyBootstrap')
      .mockImplementationOnce(async (...args) => {
        expect(await store.knex('snapshot_journal_bootstrap').first()).toMatchObject({
          stream: 0,
          cursor: null,
          rowsUsed: 0,
          rowLimit: null
        })
        store.knex.on('query', observe)
        try {
          completed = await actual(...args)
        } finally {
          store.knex.removeListener('query', observe)
        }
        expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual({
          id: 1,
          stream: 17,
          cursor: null,
          rowLimit: 1000,
          rowsUsed: 0
        })
        expect((await store.knex('snapshot_journal_generation').first()).complete).toBe(0)
        return completed
      })
    try {
      await initialize()
    } finally {
      shortcut.mockRestore()
    }
    expect(completed).toBe(true)
    expect(queries.filter(query => /^BEGIN\b/i.test(query.sql))).toHaveLength(1)
    expect(queries.filter(query => /^COMMIT\b/i.test(query.sql))).toHaveLength(1)
    const tables = [
      'users',
      ...numeric.map(source => source.table),
      'tx_labels_map',
      'output_tags_map',
      'certificate_fields',
      names.profile,
      names.relation,
      names.certificate,
      names.keys
    ]
    for (const table of tables) {
      const matching = queries.filter(
        query => query.sql.includes('1 AS occupied') && query.sql.includes('from `' + table + '`')
      )
      expect(matching).toHaveLength(1)
      expect(matching[0]?.bindings).toEqual([1])
    }
    expect((await store.knex('snapshot_journal_generation').first()).complete).toBe(1)
    expect((await store.knex('snapshot_journal_clock').first()).enabled).toBe(1)
    const before = await store.knex('snapshot_journal_bootstrap').first()
    expect(await emptyBootstrap.completeBrc38OwnedEmptyBootstrap(store, previewReceiptPolicy)).toBe(true)
    expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
  })
  test.each(['membership', 'user', 'original allowance'] as const)(
    'actual %s state refuses the empty shortcut without changing data, cursor, allowance or charges',
    async kind => {
      const { store, initialize } = await fixture(),
        actual = emptyBootstrap.completeBrc38OwnedEmptyBootstrap,
        stop = new Error('synthetic known empty-proof boundary')
      const shortcut = jest
        .spyOn(emptyBootstrap, 'completeBrc38OwnedEmptyBootstrap')
        .mockImplementationOnce(async (...args) => {
          if (kind === 'membership')
            await store.knex(names.profile).insert({ snapshotTableId: 0, snapshotUserId: 7, snapshotRowId: 1 })
          if (kind === 'user')
            await store.knex('users').insert({
              userId: 7,
              identityKey: 'synthetic user',
              activeStorage: '',
              created_at: 0,
              updated_at: 0
            })
          if (kind === 'original allowance')
            await store.knex('snapshot_journal_bootstrap').where({ id: 1 }).update({ rowLimit: 999 })
          const before = await store.knex('snapshot_journal_bootstrap').first(),
            users = await store.knex('users'),
            memberships = await store.knex(names.profile)
          expect(await actual(...args)).toBe(false)
          expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
          expect(await store.knex('users')).toEqual(users)
          expect(await store.knex(names.profile)).toEqual(memberships)
          throw stop
        })
      try {
        await expect(initialize()).rejects.toThrow(stop.message)
      } finally {
        shortcut.mockRestore()
      }
      expect(store.limits.expiresAt).toBeGreaterThan(Date.now())
    }
  )
  test('valid noninitial stream, cursor and examined-row tuples retain their exact progress and original allowance', async () => {
    const { store, initialize } = await fixture(),
      actual = emptyBootstrap.completeBrc38OwnedEmptyBootstrap,
      stop = new Error('synthetic resumed empty-proof boundary')
    const shortcut = jest
      .spyOn(emptyBootstrap, 'completeBrc38OwnedEmptyBootstrap')
      .mockImplementationOnce(async (...args) => {
        for (const position of [
          { stream: 1, cursor: null, rowLimit: 1000, rowsUsed: 0 },
          { stream: 0, cursor: '[1]', rowLimit: 1000, rowsUsed: 0 },
          { stream: 0, cursor: null, rowLimit: 1000, rowsUsed: 1 }
        ]) {
          await store.knex('snapshot_journal_bootstrap').where({ id: 1 }).update(position)
          const before = await store.knex('snapshot_journal_bootstrap').first()
          expect(await actual(...args)).toBe(false)
          expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
          expect((await store.knex('snapshot_journal_generation').first()).complete).toBe(0)
        }
        throw stop
      })
    try {
      await expect(initialize()).rejects.toThrow(stop.message)
    } finally {
      shortcut.mockRestore()
    }
  })
  test('a source-owned disabled generation is refused without enabling it or changing the unfinished bookmark', async () => {
    const { store, initialize } = await fixture(),
      actual = emptyBootstrap.completeBrc38OwnedEmptyBootstrap,
      stop = new Error('synthetic disabled empty-proof boundary')
    const shortcut = jest
      .spyOn(emptyBootstrap, 'completeBrc38OwnedEmptyBootstrap')
      .mockImplementationOnce(async (...args) => {
        await store.knex('snapshot_journal_clock').where({ id: 1 }).update({ enabled: 0, reason: 'capacity-exhausted' })
        const before = await store.knex('snapshot_journal_bootstrap').first(),
          clock = await store.knex('snapshot_journal_clock').first()
        expect(await actual(...args)).toBe(false)
        expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
        expect(await store.knex('snapshot_journal_clock').first()).toEqual(clock)
        expect((await store.knex('snapshot_journal_generation').first()).complete).toBe(0)
        throw stop
      })
    try {
      await expect(initialize()).rejects.toThrow(stop.message)
    } finally {
      shortcut.mockRestore()
    }
  })
  test('an actual SQLite abort at the terminal metadata write rolls back the zero-row completion and keeps the original error', async () => {
    const { store, initialize } = await fixture(),
      actual = emptyBootstrap.completeBrc38OwnedEmptyBootstrap,
      stop = new Error('synthetic aborted empty-proof boundary')
    const shortcut = jest
      .spyOn(emptyBootstrap, 'completeBrc38OwnedEmptyBootstrap')
      .mockImplementationOnce(async (...args) => {
        const before = await store.knex('snapshot_journal_bootstrap').first()
        await store.knex.raw(
          "CREATE TEMP TRIGGER private_empty_bootstrap_abort BEFORE UPDATE OF stream ON snapshot_journal_bootstrap WHEN NEW.stream=17 BEGIN SELECT RAISE(ABORT,'synthetic empty bootstrap terminal failure'); END"
        )
        try {
          await expect(actual(...args)).rejects.toThrow('synthetic empty bootstrap terminal failure')
        } finally {
          await store.knex.raw('DROP TRIGGER private_empty_bootstrap_abort')
        }
        expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
        expect((await store.knex('snapshot_journal_generation').first()).complete).toBe(0)
        throw stop
      })
    try {
      await expect(initialize()).rejects.toThrow(stop.message)
    } finally {
      shortcut.mockRestore()
    }
  })
  test('actual original owner expiry is refused before any transaction and never renewed; a caller flag cannot create stage authority', async () => {
    const { store, initialize } = await fixture()
    await initialize()
    const before = await store.knex('snapshot_journal_bootstrap').first(),
      expiry = store.limits.expiresAt,
      queries: string[] = [],
      observe = (query: { sql: string }) => {
        queries.push(query.sql)
      }
    store.knex.on('query', observe)
    const now = jest.spyOn(Date, 'now').mockReturnValue(expiry + 1)
    try {
      await expect(emptyBootstrap.completeBrc38OwnedEmptyBootstrap(store, previewReceiptPolicy)).rejects.toThrow()
    } finally {
      now.mockRestore()
      store.knex.removeListener('query', observe)
    }
    expect(queries).toEqual([])
    expect(store.limits.expiresAt).toBe(expiry)
    expect(await store.knex('snapshot_journal_bootstrap').first()).toEqual(before)
    await expect(
      emptyBootstrap.completeBrc38OwnedEmptyBootstrap({} as KnexBrc38StagingStore, previewReceiptPolicy)
    ).rejects.toThrow('actual owned private stage')
  })
})
