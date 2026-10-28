import { knex as createKnex, type Knex } from 'knex'
import { runInSeries } from '../../../utility/runInSeries'
import type { SnapshotArchiveRequestOwner } from './SnapshotArchiveRequest'
import {
  assertSnapshotArchiveGuardBackend,
  prepareSnapshotArchiveGuardBackend,
  SnapshotArchiveGuardBusyError,
  withSnapshotArchiveBackendGuard
} from './SnapshotArchiveGuardBackend'
import {
  assertSnapshotArchiveGuardOwner,
  bindSnapshotArchiveOwnerGuard,
  expiredSnapshotArchiveOwnerGuards,
  fenceSnapshotArchiveOwnerGuard,
  readSnapshotArchiveOwnerGuard
} from './SnapshotArchiveGuardRegistry'

/** Prepare outside the writer lock; bind and recheck the exact owner before taking its view. */
export async function readGuardedSnapshotArchive<T>(
  control: Knex,
  source: Knex,
  owner: SnapshotArchiveRequestOwner,
  read: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  const expected = await readSnapshotArchiveOwnerGuard(control, owner)
  const binding = await prepareSnapshotArchiveGuardBackend(source, expected.slot, expected.bindingJson)
  const context = await bindSnapshotArchiveOwnerGuard(control, expected, JSON.stringify(binding), trx =>
    assertSnapshotArchiveGuardBackend(trx, binding)
  )
  return await withSnapshotArchiveBackendGuard(source, binding, async trx => {
    await assertSnapshotArchiveGuardOwner(trx, context)
    return await read(trx)
  })
}

/** The provider serializes this operation; each proof pool closes before quota can be released. */
export async function recoverSnapshotArchiveGuards(control: Knex, config: Knex.Config): Promise<void> {
  const owners = await expiredSnapshotArchiveOwnerGuards(control)
  await runInSeries(owners, async context => {
    if (context.bindingJson === null) {
      // Recheck null under the capacity lock: a concurrent preparer may have
      // bound the slot since enumeration. No guard may open before that bind.
      await control.transaction(trx => fenceSnapshotArchiveOwnerGuard(trx, context, true))
      return
    }
    const proof = createKnex(config)
    let fenced = false
    try {
      const binding = await prepareSnapshotArchiveGuardBackend(proof, context.slot, context.bindingJson)
      fenced = await withSnapshotArchiveBackendGuard(proof, binding, async () => {
        return await control.transaction(async trx => {
          await assertSnapshotArchiveGuardBackend(trx, binding)
          return await fenceSnapshotArchiveOwnerGuard(trx, context)
        })
      })
      if (fenced) {
        await control.transaction(async trx => {
          await assertSnapshotArchiveGuardBackend(trx, binding)
          await fenceSnapshotArchiveOwnerGuard(trx, context, true)
        })
      }
    } catch (error) {
      if (!(error instanceof SnapshotArchiveGuardBusyError)) throw error
    } finally {
      await proof.destroy()
    }
  })
}
