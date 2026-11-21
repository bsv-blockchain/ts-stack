import type { Knex } from 'knex'
import {
  installBrc38NativeLocalBaselineGeneration,
  readBrc38NativeLocalBaselineGeneration,
  copyBrc38NativeLocalBaselineBootstrapPage,
  beginBrc38NativeLocalBaselineEpochRecovery,
  retireBrc38NativeLocalBaselineEpochPage,
  activateBrc38NativeLocalBaselineRecoveredEpoch,
  readBrc38NativeLocalBaselineChanges,
  readBrc38NativeLocalBaselinePhysical
} from './Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
interface ActualController {
  withRead<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual local epoch recovery case failed')
}
/** Actual independent finite fixture, at most512 local rows and a real monitor
 * event. The old epoch is exhausted by ordinary source writes, not forged
 * clock mutation. No constructor/compatible database substitutes for ownership. */
export async function verifyBrc38NativeLocalEpochRecovery(controller: ActualController, rowId: number): Promise<void> {
  const { withWriter, withRead, check } = controller
  requireCase(Number.isSafeInteger(rowId))
  await withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, { maximumRows: 1024, ceiling: snapshotJournalRevision('1') })
  )
  let state = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  for (let pages = 0; !state.complete && pages < 220; pages++) {
    check()
    state = await withWriter(async trx => await copyBrc38NativeLocalBaselineBootstrapPage(trx, 3))
  }
  requireCase(state.complete && state.enabled && state.records > 0 && state.records <= 512)
  await withWriter(async trx => {
    requireCase(
      (await trx('monitor_events').where({ id: rowId }).update({ details: 'first finite epoch mutation' })) === 1
    )
  })
  await withWriter(async trx => {
    requireCase(
      (await trx('monitor_events')
        .where({ id: rowId })
        .update({ details: 'ordinary write exhausts capture epoch' })) === 1
    )
  })
  const disabled = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(!disabled.enabled && disabled.reason === 'revision-exhausted' && disabled.epoch === state.epoch)
  const selection = Object.freeze({
      expectedEpoch: state.epoch,
      maximumRows: 1024,
      ceiling: snapshotJournalRevision('100000')
    }),
    pending = await withWriter(async trx => await beginBrc38NativeLocalBaselineEpochRecovery(trx, selection)),
    repeated = await withWriter(async trx => await beginBrc38NativeLocalBaselineEpochRecovery(trx, selection))
  requireCase(JSON.stringify(pending) === JSON.stringify(repeated) && pending.newEpoch !== state.epoch)
  let refused = false
  try {
    await withWriter(
      async trx => await beginBrc38NativeLocalBaselineEpochRecovery(trx, { ...selection, maximumRows: 2048 })
    )
  } catch {
    refused = true
  }
  requireCase(refused)
  let ready = false,
    remaining = disabled.records
  for (let pages = 0; !ready && pages < 180; pages++) {
    check()
    const retired = await withWriter(async trx => await retireBrc38NativeLocalBaselineEpochPage(trx, state.epoch, 3))
    requireCase(
      retired.remaining <= remaining && remaining - retired.remaining <= 3 && retired.newEpoch === pending.newEpoch
    )
    remaining = retired.remaining
    ready = retired.ready
    if (pages === 0)
      await withWriter(async trx => {
        requireCase(
          (await trx('monitor_events')
            .where({ id: rowId })
            .update({ details: 'source write persists during disabled metadata retirement' })) === 1
        )
      })
  }
  requireCase(ready && remaining === 0)
  const repeatedReady = await withWriter(
    async trx => await retireBrc38NativeLocalBaselineEpochPage(trx, state.epoch, 3)
  )
  requireCase(repeatedReady.ready && repeatedReady.remaining === 0)
  const recovered = await withWriter(
    async trx => await activateBrc38NativeLocalBaselineRecoveredEpoch(trx, state.epoch)
  )
  requireCase(
    recovered.enabled &&
      !recovered.complete &&
      recovered.epoch === pending.newEpoch &&
      recovered.records === 0 &&
      recovered.revision === '0'
  )
  requireCase(
    JSON.stringify(
      await withWriter(async trx => await activateBrc38NativeLocalBaselineRecoveredEpoch(trx, state.epoch))
    ) === JSON.stringify(recovered)
  )
  refused = false
  try {
    await withRead(
      async trx =>
        await readBrc38NativeLocalBaselineChanges(trx, {
          epoch: state.epoch,
          afterRevision: snapshotJournalRevision('0'),
          highWater: snapshotJournalRevision('0'),
          maximumRows: 1
        })
    )
  } catch {
    refused = true
  }
  requireCase(refused)
  state = recovered
  for (let pages = 0; !state.complete && pages < 220; pages++) {
    check()
    state = await withWriter(async trx => await copyBrc38NativeLocalBaselineBootstrapPage(trx, 3))
  }
  requireCase(state.complete && state.enabled && state.records === disabled.records)
  requireCase(
    await withRead(
      async trx =>
        ((await trx('monitor_events').where({ id: rowId }).first('details')) as { details: string }).details ===
        'source write persists during disabled metadata retirement'
    )
  )
  const point = await withRead(async trx => await readBrc38NativeLocalBaselinePhysical(trx, 'monitor_events', rowId))
  requireCase(point?.present && point.revision === '0' && point.generation === '0')
  await withWriter(async trx => {
    requireCase(
      (await trx('monitor_events').where({ id: rowId }).update({ details: 'new epoch observes ordinary writes' })) === 1
    )
  })
  const current = await withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx)),
    changes = await withRead(
      async trx =>
        await readBrc38NativeLocalBaselineChanges(trx, {
          epoch: state.epoch,
          afterRevision: snapshotJournalRevision('0'),
          highWater: current.revision,
          maximumRows: 1
        })
    )
  requireCase(
    changes.length === 1 &&
      changes[0].rowId === rowId &&
      changes[0].table === 'monitor_events' &&
      changes[0].revision === '1'
  )
  check()
}
/** Independent fresh fixture. Recovery must leave capture disabled while an
 * actual unsafe physical key remains, then permit a new full bootstrap after
 * the ordinary application removes that key. */
export async function verifyBrc38NativeLocalEpochUnsafeActivationRefusal(controller: ActualController): Promise<void> {
  await controller.withWriter(
    async trx =>
      await installBrc38NativeLocalBaselineGeneration(trx, {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000')
      })
  )
  await controller.withWriter(async trx => {
    await trx('monitor_events').insert({
      id: 9007199254740992n,
      created_at: 1791331200000,
      updated_at: 1791331200000,
      event: 'independent unsafe recovery key',
      details: null
    })
  })
  const state = await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
  requireCase(!state.enabled && state.reason === 'key-out-of-range')
  await controller.withWriter(
    async trx =>
      await beginBrc38NativeLocalBaselineEpochRecovery(trx, {
        expectedEpoch: state.epoch,
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000')
      })
  )
  let ready = false
  for (let pages = 0; !ready && pages < 180; pages++)
    ready = (
      await controller.withWriter(async trx => await retireBrc38NativeLocalBaselineEpochPage(trx, state.epoch, 3))
    ).ready
  requireCase(ready)
  let refused = false
  try {
    await controller.withWriter(async trx => await activateBrc38NativeLocalBaselineRecoveredEpoch(trx, state.epoch))
  } catch {
    refused = true
  }
  requireCase(
    refused && !(await controller.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))).enabled
  )
  await controller.withWriter(async trx => {
    requireCase((await trx('monitor_events').where({ id: 9007199254740992n }).delete()) === 1)
  })
  requireCase(
    (await controller.withWriter(async trx => await activateBrc38NativeLocalBaselineRecoveredEpoch(trx, state.epoch)))
      .enabled
  )
  controller.check()
}
