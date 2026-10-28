import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { createHash } from 'node:crypto'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { installBrc38ImportJournalSchema, verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import {
  prepareBrc38ImportJournal,
  readBrc38ImportJournal,
  commitBrc38ImportJournalStep,
  expireBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournal'
import type { Knex } from 'knex'

describe('bounded destination-authoritative private import journal', () => {
  let fixture: Awaited<ReturnType<typeof importJournalFixture>>
  beforeEach(async () => {
    fixture = await importJournalFixture()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await fixture.close()
  })
  async function receipt() {
    return await fixture.observer.transaction(async trx => await readBrc38ImportJournal(trx, fixture.admission))
  }
  async function nativeState() {
    return {
      rows: await fixture.observer('native_import_rows').orderBy('rowId'),
      maps: await fixture.observer('brc38_import_ids').where(fixture.admission.scope).orderBy('localId'),
      clock: await fixture
        .observer('native_import_clock')
        .first(fixture.observer.raw('CAST(revision AS TEXT) revision'))
    }
  }

  test('original shared journal allowance refuses before JSON materialization and balances after a genuine read', async () => {
    const expected = await fixture.prepare(),
      insufficient = new Brc38WorkingAllocation(4096),
      admitted = new Brc38WorkingAllocation(65536),
      retained = admitted.claim(8192)
    let materialized = 0
    const observe = (response: unknown): void => {
      for (const row of Array.isArray(response) ? response : [response])
        if (row !== null && typeof row === 'object' && Object.hasOwn(row, 'receiptJson')) materialized++
    }
    fixture.observer.on('query-response', observe)
    try {
      await expect(
        fixture.observer.transaction(trx => readBrc38ImportJournal(trx, fixture.admission, insufficient))
      ).rejects.toThrow(SnapshotResourceLimitError)
      expect(materialized).toBe(0)
      expect(insufficient.used).toBe(0)
      const actual = await fixture.observer.transaction(trx => readBrc38ImportJournal(trx, fixture.admission, admitted))
      expect(actual).toEqual(expected)
      expect(materialized).toBeGreaterThan(0)
      expect(admitted.used).toBe(8192)
    } finally {
      fixture.observer.removeListener('query-response', observe)
      retained.close()
    }
    expect(admitted.used).toBe(0)
  })

  test('has a distinct operation/preview scope and indexed constant-size receipts', async () => {
    const initial = await fixture.prepare()
    expect(initial).toMatchObject({
      state: 'PREPARED',
      sequence: 0,
      nextRow: 0,
      logicalBytes: 4096
    })
    expect(fixture.admission.scope.importId).not.toBe(fixture.admission.previewId)
    expect(await fixture.prepare()).toEqual(initial)
    const rows = await fixture.observer('brc38_import_journal')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].admissionJson)).toEqual(fixture.admission)
    const plan = await fixture.observer.raw(
      'EXPLAIN QUERY PLAN SELECT receiptJson FROM brc38_import_journal WHERE importId = ?',
      [fixture.admission.scope.importId]
    )
    expect(plan[0].detail).toMatch(/SEARCH .* USING INDEX/)
    expect(await fixture.k.schema.hasTable('snapshot_sync_ids')).toBe(false)
    expect(await fixture.k.schema.hasTable('sync_states')).toBe(false)
  })
  test('commits active rows, canonical incoming maps, exact destination clock and cursor together', async () => {
    await fixture.prepare()
    const first = await fixture.commit(fixture.step(0, 2), index => (index === 0 ? 0 : 1e21))
    expect(first).toMatchObject({
      state: 'COMMITTED',
      sequence: 1,
      nextRow: 2,
      mappedIds: 2,
      logicalBytes: 5120
    })
    expect(await receipt()).toEqual(first)
    const state = await nativeState()
    expect(state.rows.map(row => row.rowId)).toEqual([100, 101])
    expect(state.maps.map(row => [row.incomingId, row.localId])).toEqual([
      ['0', 100],
      ['1e+21', 101]
    ])
    expect(state.clock.revision).toBe('9007199254740994')
    const last = await fixture.commit(fixture.step(2, 3))
    expect(last).toMatchObject({ state: 'COMPLETE', sequence: 2, nextRow: 5, mappedIds: 5 })
    expect(await receipt()).toEqual(last)
    expect((await nativeState()).rows).toHaveLength(5)
  })
  test('recognizes the committed page after a real transaction commits but its acknowledgement is lost', async () => {
    await fixture.prepare()
    const page = fixture.step(0, 2),
      lost = new Error('Synthetic acknowledgement lost after commit')
    await expect(
      (async () => {
        await fixture.commit(page)
        throw lost
      })()
    ).rejects.toBe(lost)
    const before = await nativeState(),
      writes = jest.fn()
    const resumed = await fixture.k.transaction(
      async trx =>
        await commitBrc38ImportJournalStep(trx, fixture.admission, page, await fixture.destinationSha256(trx), writes)
    )
    expect(writes).not.toHaveBeenCalled()
    expect(resumed.nextRow).toBe(2)
    expect(await nativeState()).toEqual(before)
    expect((await fixture.prepare()).nextRow).toBe(2)
  })
  test.each(['during apply', 'after writes before checkpoint', 'after checkpoint before commit'])(
    'rolls every imported row/map/cursor back on failure %s',
    async boundary => {
      await fixture.prepare()
      const before = await nativeState(),
        initial = await receipt(),
        failure = new Error(boundary),
        page = fixture.step(0, 2)
      await expect(
        fixture.k.transaction(async trx => {
          await commitBrc38ImportJournalStep(
            trx,
            fixture.admission,
            page,
            await fixture.destinationSha256(trx),
            async () => {
              if (boundary === 'during apply') throw failure
              const hash = await fixture.apply(trx, page)
              if (boundary === 'after writes before checkpoint') throw failure
              return hash
            }
          )
          if (boundary === 'after checkpoint before commit') throw failure
        })
      ).rejects.toBe(failure)
      expect(await nativeState()).toEqual(before)
      expect(await receipt()).toEqual(initial)
      expect((await fixture.commit(page)).nextRow).toBe(2)
    }
  )
  test('reads the actual destination fence before resume and rejects unrelated mutations', async () => {
    await fixture.prepare()
    await fixture.commit(fixture.step(0, 1))
    await fixture.observer('native_import_rows').insert({ rowId: 999, userId: 8, value: 'independent mutation' })
    const apply = jest.fn()
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            fixture.admission,
            fixture.step(1, 1),
            await fixture.destinationSha256(trx),
            apply
          )
      )
    ).rejects.toThrow('stale')
    expect(apply).not.toHaveBeenCalled()
    expect((await receipt()).nextRow).toBe(1)
  })
  test('takes the actual SQLite writer before reading its checkpoint', async () => {
    await fixture.prepare()
    const page = fixture.step(0, 1)
    await fixture.k.transaction(
      async trx =>
        await commitBrc38ImportJournalStep(
          trx,
          fixture.admission,
          page,
          await fixture.destinationSha256(trx),
          async () => {
            await expect(
              fixture.observer('native_import_rows').insert({ rowId: 999, userId: 8, value: 'other writer' })
            ).rejects.toThrow(/locked/)
            return await fixture.apply(trx, page)
          }
        )
    )
    expect((await nativeState()).rows.map(row => row.rowId)).toEqual([100])
  })
  test.each(['pageSha256', 'rows', 'bytes', 'mappedIds'] as const)(
    'rejects a changed %s on a lost-ack replay',
    async field => {
      await fixture.prepare()
      const page = fixture.step(0, 1)
      await fixture.commit(page)
      const changed = {
        ...page,
        [field]: field === 'pageSha256' ? 'c'.repeat(64) : page[field] + 1
      }
      await expect(
        fixture.k.transaction(
          async trx =>
            await commitBrc38ImportJournalStep(
              trx,
              fixture.admission,
              changed,
              await fixture.destinationSha256(trx),
              jest.fn()
            )
        )
      ).rejects.toThrow('stale')
      expect((await receipt()).nextRow).toBe(1)
    }
  )
  test.each(['previewId', 'expiresAt', 'maximumJournalLogicalBytes', 'initialDestinationSha256'] as const)(
    'refuses resetting immutable %s on resume',
    async field => {
      await fixture.prepare()
      let replacement: string | number
      if (field === 'previewId') replacement = 'cc3f7330-2e40-4bfe-9723-f69f619b7ac9'
      else if (field === 'initialDestinationSha256') replacement = 'c'.repeat(64)
      else replacement = fixture.admission[field] + 1
      const changed = { ...fixture.admission, [field]: replacement }
      await expect(fixture.prepare(changed)).rejects.toThrow()
      expect((await receipt()).nextRow).toBe(0)
    }
  )
  test.each(['bindingSha256', 'archiveSha256', 'userId'] as const)(
    'never borrows another %s admission',
    async field => {
      await fixture.prepare()
      const changed = {
        ...fixture.admission,
        scope: { ...fixture.admission.scope, [field]: field === 'userId' ? 8 : 'c'.repeat(64) }
      }
      await expect(fixture.prepare(changed)).rejects.toThrow('stale')
      expect(await fixture.observer('brc38_import_journal')).toHaveLength(1)
    }
  )
  test('refuses a skipped cursor, exhausted logical budget and invalid post-write fence without committing rows', async () => {
    const admission = { ...fixture.admission, maximumJournalLogicalBytes: 4096 }
    await fixture.prepare(admission)
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            admission,
            fixture.step(1, 1),
            await fixture.destinationSha256(trx),
            jest.fn()
          )
      )
    ).rejects.toThrow('stale')
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            admission,
            fixture.step(0, 1),
            await fixture.destinationSha256(trx),
            jest.fn()
          )
      )
    ).rejects.toThrow('quota')
    const zeroMaps = { ...fixture.step(0, 1), mappedIds: 0 }
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            admission,
            zeroMaps,
            await fixture.destinationSha256(trx),
            async () => {
              await trx('native_import_rows').insert({ rowId: 100, userId: 7, value: 'synthetic' })
              return 'invalid'
            }
          )
      )
    ).rejects.toThrow('stale')
    expect((await nativeState()).rows).toEqual([])
  })
  test('expiry during writes rolls back and cannot renew capacity or deadline', async () => {
    await fixture.prepare()
    const initial = await receipt(),
      page = fixture.step(0, 1)
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            fixture.admission,
            page,
            await fixture.destinationSha256(trx),
            async () => {
              const hash = await fixture.apply(trx, page)
              jest.spyOn(Date, 'now').mockReturnValue(fixture.admission.expiresAt)
              return hash
            }
          )
      )
    ).rejects.toThrow('expired')
    expect(await receipt()).toEqual(initial)
    expect((await nativeState()).rows).toEqual([])
    await expect(fixture.prepare()).rejects.toThrow('expired')
    const expired = await fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, fixture.admission))
    expect(expired).toMatchObject({ state: 'EXPIRED', nextRow: 0, logicalBytes: 4096 })
    expect(await receipt()).toEqual(expired)
    expect(await fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, fixture.admission))).toEqual(
      expired
    )
  })
  test.each(['before writer', 'during writes'])(
    'cancellation %s retains the prior durable cursor and rolls rows back',
    async boundary => {
      await fixture.prepare()
      const controller = new AbortController(),
        reason = new Error('Synthetic import cancellation'),
        page = fixture.step(0, 1),
        before = await nativeState(),
        initial = await receipt(),
        applied = jest.fn()
      if (boundary === 'before writer') controller.abort(reason)
      await expect(
        fixture.k.transaction(
          async trx =>
            await commitBrc38ImportJournalStep(
              trx,
              fixture.admission,
              page,
              await fixture.destinationSha256(trx),
              async () => {
                applied()
                const hash = await fixture.apply(trx, page)
                controller.abort(reason)
                return hash
              },
              controller.signal
            )
        )
      ).rejects.toBe(reason)
      expect(applied).toHaveBeenCalledTimes(boundary === 'before writer' ? 0 : 1)
      expect(await nativeState()).toEqual(before)
      expect(await receipt()).toEqual(initial)
      expect((await fixture.commit(page)).nextRow).toBe(1)
    }
  )
  test.each(['admission metadata', 'owned schema'])(
    'refuses changed %s during activation and rolls back its entire transaction',
    async boundary => {
      await fixture.prepare()
      const page = fixture.step(0, 1),
        initial = await receipt()
      await expect(
        fixture.k.transaction(
          async trx =>
            await commitBrc38ImportJournalStep(
              trx,
              fixture.admission,
              page,
              await fixture.destinationSha256(trx),
              async () => {
                const hash = await fixture.apply(trx, page)
                if (boundary === 'admission metadata') await trx('brc38_import_journal').update({ admissionJson: '{}' })
                else
                  await trx.schema.alterTable('brc38_import_journal', table => {
                    table.text('unexpected')
                  })
                return hash
              }
            )
        )
      ).rejects.toThrow()
      expect(await receipt()).toEqual(initial)
      expect((await nativeState()).rows).toEqual([])
      expect((await nativeState()).maps).toEqual([])
    }
  )
  test('expiration preserves an existing committed prefix and complete operations remain complete', async () => {
    await fixture.prepare()
    await fixture.commit(fixture.step(0, 2))
    const before = await nativeState()
    jest.spyOn(Date, 'now').mockReturnValue(fixture.admission.expiresAt)
    expect(
      await fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, fixture.admission))
    ).toMatchObject({ state: 'EXPIRED', nextRow: 2, mappedIds: 2 })
    expect(await nativeState()).toEqual(before)
  })
  test('completes a truly empty admitted archive without any activation callback', async () => {
    const admission = { ...fixture.admission, totalRows: 0 }
    const initial = await fixture.prepare(admission)
    expect(initial).toMatchObject({ state: 'COMPLETE', sequence: 0, nextRow: 0 })
    jest.spyOn(Date, 'now').mockReturnValue(admission.expiresAt)
    expect(await fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, admission))).toEqual(initial)
    expect((await nativeState()).rows).toEqual([])
  })
  test('refuses early expiration and missing journals rather than manufacturing a cursor', async () => {
    await expect(receipt()).rejects.toThrow('missing')
    await expect(
      fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, fixture.admission))
    ).rejects.toThrow('stale')
    const page = fixture.step(0, 1)
    await expect(fixture.commit(page)).rejects.toThrow('missing')
    expect((await nativeState()).rows).toEqual([])
  })
  test.each(['receiptSha256', 'receiptJson', 'admissionSha256', 'admissionJson'] as const)(
    'refuses inconsistent persisted %s before invoking activation',
    async field => {
      await fixture.prepare()
      const value = field.endsWith('Json') ? '{}' : 'c'.repeat(64)
      await fixture
        .k('brc38_import_journal')
        .where({ importId: fixture.admission.scope.importId })
        .update({ [field]: value })
      await expect(fixture.commit(fixture.step(0, 1))).rejects.toThrow('stale')
      expect((await nativeState()).rows).toEqual([])
    }
  )
  test('rejects noncanonical or semantically invalid receipt bytes even with a matching digest', async () => {
    await fixture.prepare()
    const row = await fixture.k('brc38_import_journal').first(),
      old = JSON.parse(row.receiptJson),
      json = JSON.stringify({ ...old, logicalBytes: 8192 }),
      hash = createHash('sha256').update(json).digest('hex')
    await fixture.k('brc38_import_journal').update({ receiptJson: json, receiptSha256: hash })
    await expect(receipt()).rejects.toThrow('stale')
  })
  test('requires the exact source-owned auxiliary schema before journal admission', async () => {
    await fixture.k.raw(
      'CREATE TRIGGER unexpected_import_trigger AFTER INSERT ON brc38_import_journal BEGIN SELECT 1; END'
    )
    await expect(fixture.prepare()).rejects.toThrow('schema differs')
    await expect(fixture.k.transaction(async trx => await verifyBrc38ImportJournalSchema(trx))).rejects.toThrow(
      'schema differs'
    )
    expect(await fixture.observer('brc38_import_journal')).toEqual([])
  })
  test('schema installation is idempotent and refuses a changed same-named table', async () => {
    await fixture.k.transaction(async trx => await installBrc38ImportJournalSchema(trx))
    await fixture.k.schema.alterTable('brc38_import_journal', table => {
      table.text('unexpected')
    })
    await expect(fixture.k.transaction(async trx => await installBrc38ImportJournalSchema(trx))).rejects.toThrow(
      'schema differs'
    )
  })
  test('requires actual SQLite transaction and valid original limits before querying a journal', async () => {
    await expect(
      prepareBrc38ImportJournal(
        fixture.k as Knex.Transaction,
        fixture.admission,
        fixture.admission.initialDestinationSha256
      )
    ).rejects.toThrow('actual SQLite transaction')
    const bad: Brc38ImportJournalAdmission = {
      ...fixture.admission,
      originalLimitsJson: JSON.stringify({ expiresAt: fixture.admission.expiresAt })
    }
    await expect(fixture.prepare(bad)).rejects.toThrow('stale')
    await expect(
      fixture.prepare({ ...fixture.admission, previewId: fixture.admission.scope.importId })
    ).rejects.toThrow('stale')
    expect(await fixture.observer('brc38_import_journal')).toEqual([])
  })
  test.each([
    ['totalRows', 1002],
    ['maximumMappedIds', 1001],
    ['maximumStepRows', 0],
    ['maximumStepBytes', 65537],
    ['maximumJournalLogicalBytes', 4095],
    ['expiresAt', 1.5],
    ['previewId', 'not a preview'],
    ['initialDestinationSha256', 123]
  ] as const)('refuses invalid or enlarged original %s before any journal admission', async (field, value) => {
    const selected = { ...fixture.admission, [field]: value } as Brc38ImportJournalAdmission
    await expect(fixture.prepare(selected)).rejects.toThrow('stale')
    expect(await fixture.observer('brc38_import_journal')).toEqual([])
    expect((await nativeState()).rows).toEqual([])
  })
  test.each([
    '[]',
    'null',
    '[1000,1048576,7340032,65536,65536,1]',
    '[0,1048576,7340032,65536,65536,1]',
    ' '.repeat(257)
  ])('refuses invalid or nonmatching original bound tuple %p', async originalLimitsJson => {
    await expect(fixture.prepare({ ...fixture.admission, originalLimitsJson })).rejects.toThrow('stale')
    expect(await fixture.observer('brc38_import_journal')).toEqual([])
  })
  test('requires a current initial destination and keeps a full completion idempotent', async () => {
    await expect(
      fixture.k.transaction(async trx => await prepareBrc38ImportJournal(trx, fixture.admission, 'c'.repeat(64)))
    ).rejects.toThrow('stale')
    await expect(
      fixture.k.transaction(async trx => await prepareBrc38ImportJournal(trx, fixture.admission, 'invalid'))
    ).rejects.toThrow('stale')
    await fixture.prepare()
    const page = fixture.step(0, 5),
      complete = await fixture.commit(page),
      before = await nativeState()
    expect(await fixture.commit(page)).toEqual(complete)
    expect(await nativeState()).toEqual(before)
    jest.spyOn(Date, 'now').mockReturnValue(fixture.admission.expiresAt)
    expect(await fixture.k.transaction(async trx => await expireBrc38ImportJournal(trx, fixture.admission))).toEqual(
      complete
    )
  })
  type Mutation = (value: Brc38ImportJournalReceipt) => unknown
  const corruptReceipts: Array<[string, Mutation]> = [
    ['null', () => null],
    ['array', () => []],
    ['protocol', value => ({ ...value, protocol: 'other' })],
    ['state', value => ({ ...value, state: 'other' })],
    ['destination', value => ({ ...value, destinationSha256: 'invalid' })],
    ['sequence', value => ({ ...value, sequence: 0 })],
    ['fractional cursor', value => ({ ...value, nextRow: 0.5 })],
    ['past-end cursor', value => ({ ...value, nextRow: 6 })],
    ['negative IDs', value => ({ ...value, mappedIds: -1 })],
    ['logical charge', value => ({ ...value, logicalBytes: 4096 })],
    ['missing last step', value => ({ ...value, lastStep: null })],
    ['last-step cursor', value => ({ ...value, lastStep: { ...value.lastStep, fromRow: 1 } })],
    ['last-step IDs', value => ({ ...value, lastStep: { ...value.lastStep, mappedIds: 2 } })],
    ['last-step digest', value => ({ ...value, lastStep: { ...value.lastStep, pageSha256: 'invalid' } })],
    ['prepared prefix', value => ({ ...value, state: 'PREPARED' })],
    ['early complete', value => ({ ...value, state: 'COMPLETE' })],
    ['extra field', value => ({ ...value, extra: 'not a canonical receipt' })]
  ]
  test.each(corruptReceipts)(
    'refuses persisted %s even with a matching digest and retains imported prefix',
    async (_label, change) => {
      await fixture.prepare()
      await fixture.commit(fixture.step(0, 1))
      const current = await receipt(),
        before = await nativeState(),
        json = JSON.stringify(change(current)),
        hash = createHash('sha256').update(json).digest('hex')
      await fixture.k('brc38_import_journal').update({ receiptJson: json, receiptSha256: hash })
      await expect(receipt()).rejects.toThrow('stale')
      await expect(fixture.commit(fixture.step(1, 1))).rejects.toThrow('stale')
      expect(await nativeState()).toEqual(before)
    }
  )
  test('refuses noncanonical persisted bytes and enforces the original cumulative mapping quota', async () => {
    const admission = { ...fixture.admission, maximumMappedIds: 1 }
    await fixture.prepare(admission)
    const first = fixture.step(0, 1)
    await fixture.k.transaction(
      async trx =>
        await commitBrc38ImportJournalStep(
          trx,
          admission,
          first,
          await fixture.destinationSha256(trx),
          async () => await fixture.apply(trx, first)
        )
    )
    const before = await nativeState()
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            admission,
            fixture.step(1, 1),
            await fixture.destinationSha256(trx),
            jest.fn()
          )
      )
    ).rejects.toThrow('quota')
    const row = await fixture.k('brc38_import_journal').first(),
      json = row.receiptJson + ' ',
      hash = createHash('sha256').update(json).digest('hex')
    await fixture.k('brc38_import_journal').update({ receiptJson: json, receiptSha256: hash })
    await expect(fixture.k.transaction(async trx => await readBrc38ImportJournal(trx, admission))).rejects.toThrow(
      'stale'
    )
    expect(await nativeState()).toEqual(before)
  })
})
