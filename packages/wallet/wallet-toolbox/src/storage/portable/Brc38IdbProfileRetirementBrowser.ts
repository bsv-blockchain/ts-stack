import { wrap } from 'idb'
import type { PackedIdbTransaction } from '../idbPackedFields'
import { boundPackedIdbTransaction, packedIdbStores, readPackedIdbClock } from '../idbPackedFields'
import {
  idbImportJournalStores,
  isIdbRestoreDatabaseName,
  verifyIdbImportJournalSchema
} from '../idbImportJournalSchema'
import {
  admissionCopy,
  boundedJson,
  integer,
  invalid,
  read as readReceipt,
  type StoredReceipt,
  type Brc38ImportJournalAdmission
} from './Brc38ImportJournalContract'
import type { Brc38IdbImportJournalOptions } from './Brc38IdbImportJournal'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38PrivateIdbOwnership } from './Brc38PrivateIdbOwnership'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38IdbProfileRetirementOptions {
  readonly databaseName: string
  readonly admission: Brc38ImportJournalAdmission
  readonly journal: Brc38IdbImportJournalOptions
  /** Finite cleanup-operation deadline; never a renewed import deadline. */
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
const walletStores = [
  'settings',
  'users',
  'proven_txs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'commissions',
  'proven_tx_reqs',
  'sync_states',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs',
  'monitor_events'
] as const

/** Explicit ORIGINAL expired, unfinished, inactive candidate retirement only.
 * One current native writer compares original admission/policy/checkpoint and
 * profile, refuses COMPLETE/publication/activation/live leases, and persists a
 * terminal marker revoking normal actors. Only then does the actual browser
 * deletion request run. Current native metadata is rechecked on a new attempt;
 * a copied marker or name cannot delete a foreign profile. Browser deletion
 * completion does not establish forensic/physical erasure of disk or RAM. */
export async function retireExpiredBrc38BrowserProfile(selected: Brc38IdbProfileRetirementOptions): Promise<
  Readonly<{
    databaseName: string
    importId: string
    epoch: string
    revision: number
    deletedOriginalNamespace: true
  }>
> {
  const databaseName = selected.databaseName,
    admission = admissionCopy(selected.admission),
    options = Object.freeze({ ...selected.journal, profile: Object.freeze({ ...selected.journal.profile }) }),
    working = brc38WorkingAllocation(options.workingAllocation),
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    policyJson = boundedJson({
      profile: options.profile,
      maximumOriginalLogicalBytes: options.maximumOriginalLogicalBytes,
      maximumOriginalRowBytes: options.maximumOriginalRowBytes
    }),
    limits: unknown = JSON.parse(admission.originalLimitsJson)
  integer(expiresAt, 1, Number.MAX_SAFE_INTEGER)
  if (typeof IDBDatabase === 'undefined' || typeof IDBFactory === 'undefined' || typeof indexedDB === 'undefined')
    invalid()
  if (
    !isIdbRestoreDatabaseName(databaseName) ||
    !databaseName.startsWith(`wallet-toolbox-${options.profile.chain}net-restore-v1-`) ||
    working === undefined ||
    working.used !== 0 ||
    !Array.isArray(limits) ||
    working.maximum > Number(limits[4]) ||
    options.maximumOriginalLogicalBytes > Number(limits[1]) ||
    options.maximumOriginalRowBytes > Number(limits[3]) ||
    Date.now() < admission.expiresAt ||
    expiresAt <= Date.now() ||
    expiresAt - Date.now() > 30000
  )
    invalid()
  const allowance = working.claim(16384 + 32 * 65536)
  let kernel: Brc38PrivateIdbOwnership | undefined,
    native: IDBDatabase | undefined,
    opening: Promise<void> | undefined,
    work: Promise<unknown> | undefined,
    tx: PackedIdbTransaction<'readwrite'> | undefined,
    deletion: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false,
    result:
      | Readonly<{
          databaseName: string
          importId: string
          epoch: string
          revision: number
          deletedOriginalNamespace: true
        }>
      | undefined
  const close = IDBDatabase.prototype.close,
    transact = IDBDatabase.prototype.transaction,
    factory = indexedDB,
    open = IDBFactory.prototype.open,
    remove = IDBFactory.prototype.deleteDatabase,
    check = () => {
      signal?.throwIfAborted()
      kernel?.assertOwned()
      if (stopped || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
    },
    abort = () => {
      stopped = true
      try {
        tx?.abort()
      } catch {
        /* settled */
      }
    }
  async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let expiry: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          expiry = setTimeout(
            () => reject(new Error('Browser candidate retirement still owns native work')),
            Math.max(1, milliseconds)
          )
        })
      ])
    } finally {
      if (expiry !== undefined) clearTimeout(expiry)
    }
  }
  const cleanup = async () => {
    abort()
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    const causes: unknown[] = []
    for (const pending of [opening, work, tx?.done])
      if (pending !== undefined)
        try {
          await bounded(
            pending.then(
              () => undefined,
              () => undefined
            ),
            30000
          )
        } catch (cause) {
          causes.push(cause)
        }
    if (causes.length === 0 && native !== undefined) {
      close.call(native)
      native = undefined
    }
    // An uncancellable blocked deletion remains owned until actual settlement.
    if (deletion !== undefined)
      try {
        await bounded(
          deletion.then(
            () => undefined,
            () => undefined
          ),
          30000
        )
      } catch (cause) {
        causes.push(cause)
      }
    if (causes.length !== 0)
      throw new Brc38StagingCleanupError(
        causes,
        'Expired browser candidate retains actual open/writer/delete drainage',
        cleanup
      )
    await kernel?.release()
    allowance.close()
  }
  try {
    kernel = await Brc38PrivateIdbOwnership.acquire(databaseName, expiresAt, signal)
    check()
    signal?.addEventListener('abort', abort, { once: true })
    opening = new Promise<void>((resolve, reject) => {
      const request = open.call(factory, databaseName)
      request.onupgradeneeded = () => {
        try {
          request.transaction?.abort()
        } catch {
          /* never create a missing candidate */
        }
      }
      request.onerror = () => reject(request.error ?? new Error('Expired browser candidate open failed'))
      request.onsuccess = () => {
        native = request.result
        resolve()
      }
    })
    void opening.catch(() => undefined)
    await bounded(opening, Math.min(30000, expiresAt - Date.now(), deadline - performance.now()))
    check()
    if (
      native === undefined ||
      native.name !== databaseName ||
      native.version !== 7 ||
      native.objectStoreNames.length !==
        walletStores.length + Object.values(packedIdbStores).length + Object.values(idbImportJournalStores).length
    )
      invalid()
    tx = wrap(
      transact.call(
        native,
        [...walletStores, ...Object.values(packedIdbStores), ...Object.values(idbImportJournalStores)],
        'readwrite'
      )
    ) as unknown as PackedIdbTransaction<'readwrite'>
    void tx.done.catch(() => undefined)
    timer = setTimeout(abort, Math.max(1, Math.min(30000, expiresAt - Date.now(), deadline - performance.now())))
    const actual = tx
    work = (async () => {
      const cell = await actual.objectStore(packedIdbStores.clock).get('clock')
      check()
      if (cell === undefined) invalid()
      boundedJson(cell)
      integer(cell.maximumBytes as number, 1048576, 17179869184)
      integer(cell.maximumRecords as number, 1, 2000000000)
      boundPackedIdbTransaction(actual, cell.maximumBytes as number, cell.maximumRecords as number)
      const terminal = Object.hasOwn(cell, 'restoreRetirementJson') ? cell.restoreRetirementJson : undefined
      if (terminal !== undefined && typeof terminal !== 'string') invalid()
      const clock = await readPackedIdbClock(actual, terminal as string | undefined)
      check()
      verifyIdbImportJournalSchema(actual)
      const entry = await actual.objectStore(idbImportJournalStores.journal).get(1)
      if (
        entry === undefined ||
        (await actual.objectStore(idbImportJournalStores.journal).count()) !== 1 ||
        (await actual.objectStore(packedIdbStores.clock).count()) !== 1
      )
        invalid()
      boundedJson(entry)
      const receipt = readReceipt(entry as unknown as StoredReceipt, admission)
      integer(entry.originalRows as number, 0, receipt.nextRow)
      integer(entry.originalBytes as number, 0, options.maximumOriginalLogicalBytes)
      if (
        receipt.state === 'COMPLETE' ||
        receipt.nextRow >= admission.totalRows ||
        entry.publicationJson !== undefined ||
        (receipt.state !== 'EXPIRED' && entry.originalRows !== receipt.nextRow) ||
        entry.policyJson !== policyJson ||
        entry.epoch !== clock.epoch ||
        entry.revision !== clock.revision ||
        (await actual.objectStore(idbImportJournalStores.ids).count()) !== receipt.mappedIds ||
        (await actual.objectStore(idbImportJournalStores.originals).count()) !== entry.originalRows ||
        (await actual.objectStore('settings').count()) !== 1 ||
        (await actual.objectStore('users').count()) > 1
      )
        invalid()
      const settings = await actual.objectStore('settings').openCursor(),
        user = await actual.objectStore('users').openCursor()
      if (
        settings === null ||
        (user === null) !== (receipt.nextRow === 0) ||
        settings.value.chain !== options.profile.chain ||
        settings.value.storageIdentityKey !== options.profile.targetStorageIdentityKey ||
        (user !== null &&
          (user.value.userId !== admission.scope.userId ||
            user.value.identityKey !== options.profile.identityKey ||
            user.value.activeStorage !== ''))
      )
        invalid()
      let rows = 0
      for (const store of walletStores)
        if (store !== 'settings') {
          const count = await actual.objectStore(store).count()
          if (
            ['action_batches', 'action_batch_outputs', 'action_batch_blobs', 'monitor_events'].includes(store) &&
            count !== 0
          )
            invalid()
          rows += count
        }
      if (rows !== receipt.nextRow) invalid()
      for (const store of [packedIdbStores.leases, packedIdbStores.jsonStages, packedIdbStores.jsonMembers])
        if ((await actual.objectStore(store).count()) !== 0) invalid()
      check()
      const marker = {
        protocol: 'brc38-idb-expired-retirement/v1',
        databaseName,
        importId: admission.scope.importId,
        bindingSha256: admission.scope.bindingSha256,
        archiveSha256: admission.scope.archiveSha256,
        receiptSha256: entry.receiptSha256,
        epoch: clock.epoch,
        revision: clock.revision,
        originalExpiresAt: admission.expiresAt
      }
      if (terminal !== undefined) {
        if (terminal !== boundedJson(marker)) invalid()
      } else
        await actual
          .objectStore(packedIdbStores.clock)
          .put({ ...clock, restoreRetirementJson: boundedJson(marker) }, 'clock')
      check()
      await actual.done
      check()
      result = Object.freeze({
        databaseName,
        importId: admission.scope.importId,
        epoch: clock.epoch,
        revision: clock.revision,
        deletedOriginalNamespace: true as const
      })
    })()
    void work.catch(() => undefined)
    await bounded(work, Math.min(30000, expiresAt - Date.now(), deadline - performance.now()))
    check()
    clearTimeout(timer)
    timer = undefined
    close.call(native)
    native = undefined
    deletion = new Promise<void>((resolve, reject) => {
      const request = remove.call(factory, databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Expired browser candidate deletion failed'))
    })
    void deletion.catch(() => undefined)
    await bounded(deletion, Math.min(30000, expiresAt - Date.now(), deadline - performance.now()))
    if (result === undefined) invalid()
    await cleanup()
    return result
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Expired browser candidate retains concrete terminal cleanup',
        cleanup
      )
    }
    throw cause
  }
}
