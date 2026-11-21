import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import {
  packedIdbStores,
  readPackedIdbClock,
  unpackPackedIdbMetadata,
  packedIdbVersionCharge,
  verifyPackedIdbReferences
} from '../idbPackedFields'
import { idbImportJournalStores, verifyIdbImportJournalSchema } from '../idbImportJournalSchema'
import { readBrc38IdbRestorePublication, type Brc38IdbRestorePublication } from './Brc38IdbRestorePublication'
import {
  admissionCopy,
  boundedJson,
  integer,
  invalid,
  read as readReceipt,
  type StoredReceipt
} from './Brc38ImportJournalContract'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38IdbProfileSelectionOptions {
  readonly workingAllocation: Brc38WorkingAllocation
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
/** A new finite READ admission for durable operational selection metadata.
 * It cannot renew an import, authenticate an archive, resume a checkpoint,
 * activate a candidate, or claim unchanged restored data after wallet writes.
 * Native user/settings/head/version and transition coordinates are re-read in
 * ONE actual readonly transaction. A pending publication remains inactive. */
export async function readBrc38IdbProfileSelection(
  owner: PackedIdbConnection,
  selected: Brc38IdbProfileSelectionOptions
): Promise<
  Readonly<{
    publication: Readonly<Brc38IdbRestorePublication>
    userId: number
    revision: number
    epoch: string
  }>
> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  integer(expiresAt, 1, Number.MAX_SAFE_INTEGER)
  if (working === undefined || getPackedIdbConnection(owner.database) !== owner) invalid()
  let stopped = false
  const check = () => {
    owner.assertOpen()
    signal?.throwIfAborted()
    if (stopped || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
  }
  check()
  // Reserve before Native clones of the fixed cell, settings, user and one
  // current version. No large field hydration or wallet-sized scan is allowed.
  const allowance = working.claim(16384 + 32 * 65536)
  let tx: ReturnType<PackedIdbConnection['rawTransaction']> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined
  let operation:
      | Promise<
          Readonly<{
            publication: Readonly<Brc38IdbRestorePublication>
            userId: number
            revision: number
            epoch: string
          }>
        >
      | undefined,
    rejectStop!: (cause: unknown) => void
  const stop = new Promise<never>((_resolve, reject) => {
    rejectStop = reject
  })
  void stop.catch(() => undefined)
  const abort = () => {
    stopped = true
    try {
      tx?.abort()
    } catch {
      /* already settled */
    }
    rejectStop(
      signal?.aborted ? signal.reason : new SnapshotResourceLimitError('Native profile selection read stopped')
    )
  }
  const cleanup = async (): Promise<void> => {
    abort()
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const pending: Promise<unknown>[] = []
      if (operation !== undefined) pending.push(operation)
      if (tx !== undefined) pending.push(tx.done)
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(
            () => reject(new Error('Native profile selection retains actual read drainage')),
            30000
          )
        })
      ])
      allowance.close()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        [cause],
        'Native profile selection retains its original allocation until actual drainage',
        cleanup
      )
    } finally {
      if (drainTimer !== undefined) clearTimeout(drainTimer)
    }
  }
  try {
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, Math.max(1, Math.min(30000, expiresAt - Date.now(), deadline - performance.now())))
    operation = (async () => {
      const actual = owner.rawTransaction(['settings', 'users', ...Object.values(idbImportJournalStores)], 'readonly')
      tx = actual
      void actual.done.catch(() => undefined)
      check()
      verifyIdbImportJournalSchema(actual)
      const clock = await readPackedIdbClock(actual)
      if (
        (await actual.objectStore('settings').count()) !== 1 ||
        (await actual.objectStore('users').count()) !== 1 ||
        (await actual.objectStore(idbImportJournalStores.journal).count()) !== 1 ||
        (await actual.objectStore(packedIdbStores.clock).count()) !== 1
      )
        invalid()
      const settings = await actual.objectStore('settings').openCursor(),
        userCursor = await actual.objectStore('users').openCursor(),
        entry = await actual.objectStore(idbImportJournalStores.journal).get(1)
      check()
      if (settings === null || userCursor === null || entry === undefined || typeof entry.admissionJson !== 'string')
        invalid()
      boundedJson(entry)
      const admission = admissionCopy(JSON.parse(entry.admissionJson)),
        receipt = readReceipt(entry as unknown as StoredReceipt, admission),
        publication = readBrc38IdbRestorePublication(entry.publicationJson),
        user = unpackPackedIdbMetadata(userCursor.value),
        expectedRevision =
          publication.state === 'ACTIVATED' ? publication.activatedRevision! : publication.publishedRevision
      if (
        receipt.state !== 'COMPLETE' ||
        receipt.nextRow !== admission.totalRows ||
        entry.originalRows !== receipt.nextRow ||
        entry.epoch !== clock.epoch ||
        entry.revision !== expectedRevision ||
        publication.epoch !== clock.epoch ||
        clock.revision < expectedRevision ||
        (publication.state === 'PUBLISHED' && clock.revision !== expectedRevision) ||
        publication.databaseName !== owner.database.name ||
        publication.importId !== admission.scope.importId ||
        publication.previewId !== admission.previewId ||
        publication.bindingSha256 !== admission.scope.bindingSha256 ||
        publication.archiveSha256 !== admission.scope.archiveSha256 ||
        publication.publishedAt >= admission.expiresAt ||
        (publication.activatedAt !== undefined && publication.activatedAt >= admission.expiresAt) ||
        settings.value.chain !== publication.chain ||
        settings.value.storageIdentityKey !== publication.targetStorageIdentityKey ||
        Object.keys(user.extents).length !== 0 ||
        user.fields.userId !== admission.scope.userId ||
        user.fields.identityKey !== publication.identityKey ||
        user.fields.activeStorage !== (publication.state === 'ACTIVATED' ? publication.targetStorageIdentityKey : '') ||
        userCursor.primaryKey !== admission.scope.userId ||
        (await actual.objectStore(idbImportJournalStores.ids).count()) !== receipt.mappedIds ||
        (await actual.objectStore(idbImportJournalStores.originals).count()) !== entry.originalRows
      )
        invalid()
      const head = await actual.objectStore(packedIdbStores.heads).get(['users', admission.scope.userId])
      if (
        head === undefined ||
        head.store !== 'users' ||
        head.key !== admission.scope.userId ||
        head.portableKey !== admission.scope.userId ||
        head.replicaKey !== admission.scope.userId
      )
        invalid()
      integer(head.revision as number, publication.state === 'ACTIVATED' ? expectedRevision : 1, clock.revision)
      const version = await actual
        .objectStore(packedIdbStores.versions)
        .get(['users', admission.scope.userId, head.revision as number])
      if (
        version === undefined ||
        version.store !== 'users' ||
        version.key !== admission.scope.userId ||
        version.revision !== head.revision ||
        version.deleted !== false ||
        version.obsoleteAt !== undefined ||
        version.deletedAt !== undefined
      )
        invalid()
      const current = unpackPackedIdbMetadata(version.value)
      verifyPackedIdbReferences(version.references, current)
      if (
        Object.keys(current.extents).length !== 0 ||
        version.charge !== packedIdbVersionCharge(current) ||
        boundedJson(current.fields) !== boundedJson(user.fields)
      )
        invalid()
      check()
      await actual.done
      check()
      return Object.freeze({
        publication,
        userId: admission.scope.userId,
        revision: clock.revision,
        epoch: clock.epoch
      })
    })()
    void operation.catch(() => undefined)
    const result = await Promise.race([operation, stop])
    await cleanup()
    return result
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Native profile selection requires concrete read cleanup',
        cleanup
      )
    }
    throw cause
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
