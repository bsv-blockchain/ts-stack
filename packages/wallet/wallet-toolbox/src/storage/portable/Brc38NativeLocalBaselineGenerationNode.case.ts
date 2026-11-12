import type { Knex } from 'knex'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import {
  installBrc38NativeLocalBaselineGeneration,
  copyBrc38NativeLocalBaselineBootstrapPage,
  readBrc38NativeLocalBaselineGeneration,
  readBrc38NativeLocalBaselinePhysical,
  readBrc38NativeLocalBaselineChanges
} from './Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

interface ActualController {
  readonly expiresAt: number
  readonly withRead: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>
  readonly withWriter: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>
}
function requireCase(value: boolean): asserts value {
  if (!value) throw new Error('Actual local baseline mutation journal differs from the independent oracle')
}
/** UNRUN. A finite controller supplies an independent all47-table fixture and
 * genuine native reader/writer phases. The case covers bootstrap, auxiliary
 * mutations absent from the thirteen-table journal, rollback, tombstones,
 * physical key moves, reuse generations and stale high-water refusal. It
 * grants no candidate-copy, primary-cutover or production acceptance. */
export async function verifyBrc38NativeLocalBaselineGeneration(
  controller: ActualController,
  expected: Readonly<Record<Brc38NativeLocalBaselineTable, readonly number[]>>
): Promise<void> {
  const { withRead, withWriter, expiresAt } = controller,
    deadline = performance.now() + expiresAt - Date.now(),
    check = (): void => {
      requireCase(Date.now() < expiresAt && performance.now() < deadline)
    },
    total = brc38NativeLocalBaselineTables.reduce((sum, table) => sum + expected[table].length, 0)
  requireCase(
    Number.isSafeInteger(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt <= Date.now() + 120000 &&
      total < 512 &&
      expected.monitor_events.length > 0 &&
      brc38NativeLocalBaselineTables.every(
        table => Array.isArray(expected[table]) && expected[table].every(Number.isSafeInteger)
      )
  )
  await withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000')
      })
  )
  let state = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(state.enabled && !state.complete && state.revision === '0' && state.records === 0)
  for (let pages = 0; !state.complete && pages < 220; pages++) {
    check()
    state = await withWriter(async trx => await copyBrc38NativeLocalBaselineBootstrapPage(trx, 3))
  }
  requireCase(state.complete && state.enabled && state.records === total && state.revision === '0')
  for (const table of brc38NativeLocalBaselineTables)
    for (const rowId of expected[table]) {
      check()
      const physical = await withRead(async trx => await readBrc38NativeLocalBaselinePhysical(trx, table, rowId))
      requireCase(physical?.present === true && physical.revision === '0' && physical.generation === '0')
    }
  const rowId = expected.monitor_events[0],
    movedId = -9007199254740991,
    oldArchiveRevision = await withRead(async trx =>
      String(
        (
          (await trx('snapshot_journal_clock')
            .where({ id: 1 })
            .first(trx.raw('CAST(revision AS TEXT) AS revision'))) as { revision: string }
        ).revision
      )
    )
  requireCase(rowId !== movedId && !expected.monitor_events.includes(movedId))
  await withWriter(async trx => {
    requireCase(
      (await trx('monitor_events')
        .whereRaw('rowid=?', [rowId])
        .update({ details: 'independent auxiliary local mutation' })) === 1
    )
  })
  const changed = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(changed.revision === '1' && changed.epoch === state.epoch && changed.records === total)
  requireCase(
    (await withRead(async trx =>
      String(
        (
          (await trx('snapshot_journal_clock')
            .where({ id: 1 })
            .first(trx.raw('CAST(revision AS TEXT) AS revision'))) as { revision: string }
        ).revision
      )
    )) === oldArchiveRevision
  )
  const delta = await withRead(
    async trx =>
      await readBrc38NativeLocalBaselineChanges(trx, {
        epoch: changed.epoch,
        afterRevision: snapshotJournalRevision('0'),
        highWater: changed.revision,
        maximumRows: 1
      })
  )
  requireCase(
    delta.length === 1 &&
      delta[0].table === 'monitor_events' &&
      delta[0].rowId === rowId &&
      delta[0].present &&
      delta[0].revision === '1' &&
      delta[0].generation === '0'
  )
  const rollback = new Error('Independent local journal rollback'),
    before = JSON.stringify(changed)
  let refused = false
  try {
    await withWriter(async trx => {
      await trx('monitor_events')
        .whereRaw('rowid=?', [rowId])
        .update({ details: 'must roll back both local row and mutation record' })
      throw rollback
    })
  } catch (cause) {
    refused = cause === rollback
  }
  requireCase(
    refused && JSON.stringify(await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))) === before
  )
  await withWriter(async trx => {
    requireCase((await trx('monitor_events').whereRaw('rowid=?', [rowId]).update({ id: movedId })) === 1)
  })
  const old = await withRead(async trx => await readBrc38NativeLocalBaselinePhysical(trx, 'monitor_events', rowId)),
    moved = await withRead(async trx => await readBrc38NativeLocalBaselinePhysical(trx, 'monitor_events', movedId))
  requireCase(
    old?.present === false &&
      old.revision === '2' &&
      old.generation === '0' &&
      moved?.present === true &&
      moved.revision === '2' &&
      moved.generation === '2'
  )
  await withWriter(async trx => {
    requireCase((await trx('monitor_events').whereRaw('rowid=?', [movedId]).delete()) === 1)
  })
  const deleted = await withRead(
    async trx => await readBrc38NativeLocalBaselinePhysical(trx, 'monitor_events', movedId)
  )
  requireCase(deleted?.present === false && deleted.revision === '3' && deleted.generation === '2')
  await withWriter(async trx => {
    await trx('monitor_events').insert({
      id: movedId,
      created_at: 1791331200000,
      updated_at: 1791331200000,
      event: 'independent reused physical key',
      details: null
    })
  })
  const reused = await withRead(
      async trx => await readBrc38NativeLocalBaselinePhysical(trx, 'monitor_events', movedId)
    ),
    latest = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(
    reused?.present === true && reused.revision === '4' && reused.generation === '4' && latest.records === total + 1
  )
  const ordered = await withRead(
    async trx =>
      await readBrc38NativeLocalBaselineChanges(trx, {
        epoch: latest.epoch,
        afterRevision: snapshotJournalRevision('0'),
        highWater: latest.revision,
        maximumRows: 3
      })
  )
  requireCase(
    ordered.length === 2 &&
      ordered[0].revision === '2' &&
      ordered[0].rowId === rowId &&
      !ordered[0].present &&
      ordered[1].revision === '4' &&
      ordered[1].rowId === movedId &&
      ordered[1].present
  )
  refused = false
  try {
    await withRead(
      async trx =>
        await readBrc38NativeLocalBaselineChanges(trx, {
          epoch: latest.epoch,
          afterRevision: snapshotJournalRevision('0'),
          highWater: changed.revision,
          maximumRows: 1
        })
    )
  } catch {
    refused = true
  }
  requireCase(refused)
  check()
}

/** Independently installed tiny epoch, separate actual fixture/controller.
 * Exhaustion disables baseline capture while the ordinary source write still
 * persists. It cannot be reused as proof of zero downtime or successful sync. */
export async function verifyBrc38NativeLocalBaselineRevisionExhaustion(
  controller: ActualController,
  rowId: number
): Promise<void> {
  requireCase(Number.isSafeInteger(rowId))
  await controller.withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, { maximumRows: 1024, ceiling: snapshotJournalRevision('1') })
  )
  await controller.withWriter(async trx => {
    requireCase(
      (await trx('monitor_events').whereRaw('rowid=?', [rowId]).update({ details: 'first actual revision' })) === 1
    )
  })
  requireCase((await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))).enabled)
  await controller.withWriter(async trx => {
    requireCase(
      (await trx('monitor_events')
        .whereRaw('rowid=?', [rowId])
        .update({ details: 'ordinary source persists after revision exhaustion' })) === 1
    )
  })
  const state = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx)),
    row = await controller.withRead(
      async trx => await trx('monitor_events').whereRaw('rowid=?', [rowId]).first('details')
    )
  requireCase(
    !state.enabled &&
      state.reason === 'revision-exhausted' &&
      state.revision === '1' &&
      row.details === 'ordinary source persists after revision exhaustion'
  )
}

/** Separate finite native fixture. The metadata limit is an admission limit,
 * not permission to discard the newly written ordinary source row. */
export async function verifyBrc38NativeLocalBaselineCapacityExhaustion(
  controller: ActualController,
  existingRowId: number,
  newRowId: number
): Promise<void> {
  requireCase(Number.isSafeInteger(existingRowId) && Number.isSafeInteger(newRowId) && existingRowId !== newRowId)
  await controller.withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, { maximumRows: 1, ceiling: snapshotJournalRevision('1000') })
  )
  await controller.withWriter(async trx => {
    requireCase(
      (await trx('monitor_events')
        .whereRaw('rowid=?', [existingRowId])
        .update({ details: 'one retained physical mutation record' })) === 1
    )
  })
  const first = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(first.enabled && first.records === 1 && first.revision === '1')
  await controller.withWriter(async trx => {
    requireCase((await trx('monitor_events').whereRaw('rowid=?', [newRowId]).first('id')) === undefined)
    await trx('monitor_events').insert({
      id: newRowId,
      created_at: 1791331200000,
      updated_at: 1791331200000,
      event: 'independent capacity-limit write',
      details: 'ordinary row must survive'
    })
  })
  const state = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx)),
    actualRow = await controller.withRead(
      async trx => await trx('monitor_events').whereRaw('rowid=?', [newRowId]).first('details')
    )
  requireCase(
    !state.enabled &&
      state.reason === 'capacity-exhausted' &&
      state.records === 1 &&
      state.revision === '2' &&
      actualRow.details === 'ordinary row must survive'
  )
  let refused = false
  try {
    await controller.withRead(
      async trx =>
        await readBrc38NativeLocalBaselineChanges(trx, {
          epoch: state.epoch,
          afterRevision: snapshotJournalRevision('0'),
          highWater: state.revision,
          maximumRows: 1
        })
    )
  } catch {
    refused = true
  }
  requireCase(refused)
}

/** Signed64 SQLite data may exceed the source transport's safe physical-key
 * bound. It persists, while this epoch becomes explicitly non-capturable. */
export async function verifyBrc38NativeLocalBaselineUnsafeKeyRefusal(controller: ActualController): Promise<void> {
  await controller.withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('1000')
      })
  )
  await controller.withWriter(async trx => {
    await trx('monitor_events').insert({
      id: 9007199254740992n,
      created_at: 1791331200000,
      updated_at: 1791331200000,
      event: 'independent exact unsafe transport key',
      details: null
    })
  })
  const state = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx)),
    actual = await controller.withRead(
      async trx =>
        (await trx('monitor_events').where({ id: 9007199254740992n }).first(trx.raw('CAST(id AS TEXT) AS id'))) as {
          id: string
        }
    )
  requireCase(
    !state.enabled && state.reason === 'key-out-of-range' && state.records === 0 && actual.id === '9007199254740992'
  )
}

/** Separate genuine already bootstrapped fixture, with independently populated
 * session/map/primary-epoch records. Recovery changes advance the same local
 * high water even when none of the thirteen archive tables changes. */
export async function verifyBrc38NativeLocalSnapshotRecoveryChanges(
  controller: ActualController,
  selected: Readonly<{
    sessionRowId: number
    mappingRowId: number
    epochRowId: number
    cursor: string
    localId: number
    epoch: string
  }>
): Promise<void> {
  requireCase(
    [selected.sessionRowId, selected.mappingRowId, selected.epochRowId, selected.localId].every(Number.isSafeInteger) &&
      Buffer.byteLength(selected.cursor) <= 4096 &&
      /^[1-9]\d{0,18}$/.test(selected.epoch) &&
      BigInt(selected.epoch) <= 9223372036854775807n
  )
  const before = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(before.complete && before.enabled)
  const changes = [
    { table: 'snapshot_sync_sessions' as const, rowId: selected.sessionRowId, patch: { cursor: selected.cursor } },
    { table: 'snapshot_sync_ids' as const, rowId: selected.mappingRowId, patch: { localId: selected.localId } },
    {
      table: 'snapshot_sync_primary_epochs' as const,
      rowId: selected.epochRowId,
      patch: { epoch: BigInt(selected.epoch) }
    }
  ]
  for (const change of changes)
    await controller.withWriter(async trx => {
      requireCase((await trx(change.table).whereRaw('rowid=?', [change.rowId]).update(change.patch)) === 1)
    })
  const after = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(
    after.epoch === before.epoch &&
      after.revision === String(BigInt(before.revision) + 3n) &&
      after.records === before.records
  )
  const page = await controller.withRead(
    async trx =>
      await readBrc38NativeLocalBaselineChanges(trx, {
        epoch: after.epoch,
        afterRevision: before.revision,
        highWater: after.revision,
        maximumRows: 3
      })
  )
  requireCase(
    page.length === 3 &&
      page.every(
        (point, ordinal) =>
          point.table === changes[ordinal].table &&
          point.rowId === changes[ordinal].rowId &&
          point.present &&
          point.revision === String(BigInt(before.revision) + BigInt(ordinal + 1))
      )
  )
  const actual = await controller.withRead(async trx => ({
    session: await trx('snapshot_sync_sessions').whereRaw('rowid=?', [selected.sessionRowId]).first('cursor'),
    mapping: await trx('snapshot_sync_ids').whereRaw('rowid=?', [selected.mappingRowId]).first('localId'),
    primary: await trx('snapshot_sync_primary_epochs')
      .whereRaw('rowid=?', [selected.epochRowId])
      .first(trx.raw('CAST(epoch AS TEXT) AS epoch'))
  }))
  requireCase(
    actual.session?.cursor === selected.cursor &&
      actual.mapping?.localId === selected.localId &&
      actual.primary?.epoch === selected.epoch
  )
}
