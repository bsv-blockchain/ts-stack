import { runInSeries } from '../../utility/runInSeries'
import type { Knex } from 'knex'
import {
  installBrc38PrivateLocalCandidateJournal,
  readBrc38PrivateLocalCandidateJournal,
  hasBrc38PrivateLocalCandidateJournal,
  brc38PrivateLocalCandidateStateTable as state,
  brc38PrivateLocalCandidatePointTable as points
} from './Brc38PrivateLocalCandidateJournalNode'
import {
  installBrc38PrivatePriorImportSchema,
  hasBrc38PrivatePriorImportSchema
} from './Brc38PrivatePriorImportSchemaNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
interface ActualController {
  withRead<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private candidate journal case failed')
}
/** Genuine finite private candidate, explicit journal DATA fixture only. These
 * hashes and metadata never supply source/profile/primary/semantic admission.
 * The complete copier/controller must obtain that independently. */
export async function verifyBrc38PrivateLocalCandidateJournal(controller: ActualController): Promise<void> {
  const selection = Object.freeze({
    bindingSha256: '7'.repeat(64),
    sourceSha256: '8'.repeat(64),
    epoch: 'f25e56c8-0abd-48c9-bca2-7b2b8b2de39e',
    revision: snapshotJournalRevision('9007199254740993'),
    maximumRows: 2
  })
  requireCase(await controller.withRead(async trx => !(await hasBrc38PrivateLocalCandidateJournal(trx))))
  await controller.withWriter(async trx => await installBrc38PrivateLocalCandidateJournal(trx, selection))
  const initial = await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))
  requireCase(
    initial.phase === 'COPY' &&
      initial.baseRevision === '9007199254740993' &&
      initial.caughtUpRevision === initial.baseRevision &&
      initial.records === 0 &&
      initial.copyTable === 0 &&
      initial.afterRowId === null
  )
  await runInSeries(['trigger', 'index'] as const, async kind => {
    await controller.withWriter(async trx => {
      await trx.raw('SAVEPOINT independent_candidate_catalog_admission')
      try {
        if (kind === 'trigger')
          await trx.raw('CREATE TRIGGER independent_candidate_catalog_noop BEFORE DELETE ON ?? BEGIN SELECT 1; END', [
            state
          ])
        else await trx.raw('CREATE INDEX independent_candidate_catalog_index ON ??(epoch)', [state])
        let rejected = false
        try {
          await hasBrc38PrivateLocalCandidateJournal(trx)
        } catch (error_) {
          requireCase(
            error_ instanceof Error &&
              error_.message ===
                'Private local candidate journal differs from its actual owner, exact schema or original progress'
          )
          rejected = true
        }
        requireCase(rejected)
      } finally {
        await trx.raw('ROLLBACK TO independent_candidate_catalog_admission')
        await trx.raw('RELEASE independent_candidate_catalog_admission')
      }
      requireCase(await hasBrc38PrivateLocalCandidateJournal(trx))
    })
    const restored = await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))
    requireCase(JSON.stringify(restored) === JSON.stringify(initial))
  })
  await controller.withWriter(async trx => {
    await trx.raw('SAVEPOINT independent_owned_prior_guard')
    try {
      await installBrc38PrivatePriorImportSchema(trx)
      requireCase(await hasBrc38PrivatePriorImportSchema(trx))
      requireCase(await hasBrc38PrivateLocalCandidateJournal(trx))
      requireCase(JSON.stringify(await readBrc38PrivateLocalCandidateJournal(trx)) === JSON.stringify(initial))
      await trx.raw('SAVEPOINT independent_changed_prior_guard')
      try {
        await trx.raw('DROP TRIGGER brc38_local_prior_import_point_guard')
        await trx.raw('CREATE TRIGGER brc38_local_prior_import_point_guard BEFORE INSERT ON ?? BEGIN SELECT 1; END', [
          points
        ])
        let rejected = false
        try {
          await hasBrc38PrivateLocalCandidateJournal(trx)
        } catch (error_) {
          requireCase(
            error_ instanceof Error &&
              error_.message ===
                'Private local candidate journal differs from its actual owner, exact schema or original progress'
          )
          rejected = true
        }
        requireCase(rejected)
      } finally {
        await trx.raw('ROLLBACK TO independent_changed_prior_guard')
        await trx.raw('RELEASE independent_changed_prior_guard')
      }
      requireCase(await hasBrc38PrivatePriorImportSchema(trx))
      requireCase(await hasBrc38PrivateLocalCandidateJournal(trx))
    } finally {
      await trx.raw('ROLLBACK TO independent_owned_prior_guard')
      await trx.raw('RELEASE independent_owned_prior_guard')
    }
    requireCase(JSON.stringify(await readBrc38PrivateLocalCandidateJournal(trx)) === JSON.stringify(initial))
  })
  let refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ epoch: 'a25e56c8-0abd-48c9-bca2-7b2b8b2de39e' })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  const row = Object.freeze({
    tableId: 0,
    rowId: -7,
    revision: 0,
    generation: 0,
    present: 1,
    contentSha256: '9'.repeat(64)
  })
  await controller.withWriter(async trx => {
    await trx(points).insert(row)
  })
  requireCase((await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).records === 1)
  const rollback = new Error('independent candidate point/progress rollback')
  try {
    await controller.withWriter(async trx => {
      await trx(points).insert({ ...row, rowId: -6 })
      await trx(state).where({ slot: 1 }).update({ afterRowId: -7 })
      throw rollback
    })
  } catch (cause) {
    requireCase(cause === rollback)
  }
  const retained = await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))
  requireCase(retained.records === 1 && retained.afterRowId === null)
  await controller.withWriter(async trx => {
    await trx(points).insert({ ...row, rowId: -6 })
  })
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(points).insert({ ...row, rowId: -5 })
    })
  } catch {
    refused = true
  }
  requireCase(
    refused && (await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).records === 2
  )
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(points).where({ tableId: 0, rowId: -7 }).delete()
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ afterRowId: -7 })
  })
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ afterRowId: -8 })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  // A null content hash cannot masquerade as a complete present point.
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(points).where({ tableId: 0, rowId: -7 }).update({ contentSha256: null })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  // A reused key can have later updates: its physical generation need not
  // equal its latest revision. Retain that independently specified interval.
  await controller.withWriter(async trx => {
    requireCase(
      (await trx(points)
        .where({ tableId: 0, rowId: -7 })
        .update({ revision: 5, generation: 2, contentSha256: 'a'.repeat(64) })) === 1
    )
  })
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(points).where({ tableId: 0, rowId: -7 }).update({ revision: 6, generation: 3 })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  // Cursor/epoch/source hashes alone cannot advance directly to recovery.
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'RECOVERY', copyTable: 48, afterRowId: null })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  controller.check()
}

/** Independent durable two-pass cursor fixture. The controller supplies a
 * separate fresh actual owner; no hash fixture admits source or row semantics. */
export async function verifyBrc38PrivateLocalCandidateTwoPassJournal(controller: ActualController): Promise<void> {
  await controller.withWriter(
    async trx =>
      await installBrc38PrivateLocalCandidateJournal(trx, {
        bindingSha256: 'b'.repeat(64),
        sourceSha256: 'c'.repeat(64),
        epoch: '225e56c8-0abd-48c9-bca2-7b2b8b2de39e',
        revision: snapshotJournalRevision('0'),
        maximumRows: 4
      })
  )
  for (let table = 1; table <= 48; table++)
    await controller.withWriter(async trx => {
      requireCase(
        (await trx(state)
          .where({ slot: 1 })
          .update({ copyTable: table, ...(table === 48 ? { phase: 'DELTA' } : {}) })) === 1
      )
    })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ deltaPass: 'PRESENT', deltaHighWater: '7' })
  })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ deltaRevision: '3', deltaTable: 2, deltaRowId: -8 })
  })
  let refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ deltaRevision: '2' })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  // Losing a snapshot and reopening a higher water restarts the interval,
  // preserving caughtUp. It does not pretend historical row bytes survived.
  await controller.withWriter(async trx => {
    await trx(state)
      .where({ slot: 1 })
      .update({ deltaHighWater: '9', deltaPass: 'PRESENT', deltaRevision: null, deltaTable: null, deltaRowId: null })
  })
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({
        phase: 'RECOVERY',
        caughtUpRevision: '9',
        deltaPass: null,
        deltaHighWater: null,
        deltaRevision: null,
        deltaTable: null,
        deltaRowId: null
      })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    await trx(state)
      .where({ slot: 1 })
      .update({ deltaPass: 'TOMBSTONE', deltaRevision: null, deltaTable: null, deltaRowId: null })
  })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ deltaTable: 25, deltaRevision: '2', deltaRowId: -9 })
  })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ deltaTable: 25, deltaRevision: '2', deltaRowId: -8 })
  })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ deltaTable: 2, deltaRevision: '1', deltaRowId: -9 })
  })
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ deltaTable: 3 })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({
      phase: 'RECOVERY',
      caughtUpRevision: '9',
      deltaPass: null,
      deltaHighWater: null,
      deltaRevision: null,
      deltaTable: null,
      deltaRowId: null
    })
  })
  requireCase(
    (await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).caughtUpRevision === '9'
  )
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'DELTA', deltaPass: 'PRESENT', deltaHighWater: '9' })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ phase: 'DELTA', deltaPass: 'PRESENT', deltaHighWater: '10' })
  })
  const resumed = await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))
  requireCase(resumed.caughtUpRevision === '9' && resumed.deltaHighWater === '10' && resumed.deltaPass === 'PRESENT')
  controller.check()
}

/** Fresh actual empty all48 candidate. Explicit points are progress DATA only.
 * Proves cleanup cannot skip retained points or jump backwards, and bounded
 * retries cannot be silently reset when a new COPY begins. */
export async function verifyBrc38PrivateLocalCandidateClearJournal(controller: ActualController): Promise<void> {
  await controller.withWriter(
    async trx =>
      await installBrc38PrivateLocalCandidateJournal(trx, {
        bindingSha256: 'd'.repeat(64),
        sourceSha256: 'e'.repeat(64),
        epoch: '325e56c8-0abd-48c9-bca2-7b2b8b2de39e',
        revision: snapshotJournalRevision('0'),
        maximumRows: 1
      })
  )
  await controller.withWriter(async trx => {
    await trx(points).insert({
      tableId: 47,
      rowId: -9,
      revision: 0,
      generation: 0,
      present: 1,
      contentSha256: 'f'.repeat(64)
    })
  })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ phase: 'CLEAR', rebuilds: 1, clearTable: 47 })
  })
  let refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ clearTable: 46 })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  const rollback = new Error('independent private cleanup rollback')
  try {
    await controller.withWriter(async trx => {
      await trx(points).where({ tableId: 47, rowId: -9 }).delete()
      throw rollback
    })
  } catch (cause) {
    requireCase(cause === rollback)
  }
  requireCase((await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).records === 1)
  await controller.withWriter(async trx => {
    requireCase((await trx(points).where({ tableId: 47, rowId: -9 }).delete()) === 1)
  })
  requireCase((await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).records === 0)
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'COPY', clearTable: null })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  for (let table = 46; table >= -1; table--)
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ clearTable: table })
    })
  await controller.withWriter(async trx => {
    await trx(state).where({ slot: 1 }).update({ phase: 'COPY', copyTable: 0, afterRowId: null, clearTable: null })
  })
  const copied = await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))
  requireCase(copied.phase === 'COPY' && copied.rebuilds === 1 && copied.records === 0)
  for (let rebuilds = 2; rebuilds <= 3; rebuilds++) {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'CLEAR', rebuilds, clearTable: 47 })
    })
    for (let table = 46; table >= -1; table--)
      await controller.withWriter(async trx => {
        await trx(state).where({ slot: 1 }).update({ clearTable: table })
      })
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'COPY', clearTable: null })
    })
  }
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx(state).where({ slot: 1 }).update({ phase: 'CLEAR', rebuilds: 4, clearTable: 47 })
    })
  } catch {
    refused = true
  }
  requireCase(
    refused && (await controller.withRead(async trx => await readBrc38PrivateLocalCandidateJournal(trx))).rebuilds === 3
  )
  controller.check()
}
