import { awaitFromSync, mapAwaitFromSync } from '../../utility/promiseFromSync'
import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection } from '../idbPackedConnection'
import {
  stageAuthenticatedBrc39StreamBrowserImport,
  copyBrc38AuthenticatedStreamBrowserOptions,
  type Brc38AuthenticatedStreamBrowserOptions
} from './Brc38AuthenticatedStreamStageBrowser'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38IdbImportJournal, type Brc38IdbImportJournalOptions } from './Brc38IdbImportJournal'
import {
  prepareBrc38IdbRestoreRow,
  type Brc38IdbPreparedRestoreRow,
  type Brc38IdbRestoreRowPolicy
} from './Brc38IdbPreparedRestoreRow'
import { inspectBrc38IdbRestoreInventory } from './Brc38IdbRestoreInventory'
import { inspectBrc38IdbPackedReferenceInventory } from './Brc38IdbPackedReferenceInventory'
import { inspectBrc38PrivateIdbStreamedProof } from './Brc38IdbStreamedProof'
import {
  admissionCopy,
  boundedJson,
  digest,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournalContract'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import { decodePortableRow } from './Brc38PortableRows'
import { brc38Utf8ByteLength } from './Brc38Utf8Length'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { EntityTimeStamp } from '../../sdk/types'
import type { Brc38WorkingCharge } from './Brc38WorkingAllocation'
import type { Brc38IdbRestorePublication } from './Brc38IdbRestorePublication'

export interface Brc38AuthenticatedIdbRestoreOptions {
  readonly storage: StorageIdb
  readonly source: Brc38AuthenticatedStreamBrowserOptions
  readonly admission: Brc38ImportJournalAdmission
  readonly journal: Brc38IdbImportJournalOptions
  readonly row: Omit<Brc38IdbRestoreRowPolicy, 'source'> & {
    readonly source: Omit<Brc38IdbRestoreRowPolicy['source'], 'databaseName'>
  }
  /** Finite optional pause after committed rows. Resume always supplies and
   * freshly authenticates the COMPLETE original envelope, including its EOF. */
  readonly maximumRowsThisInvocation?: number
  /** Synchronous progress observation only. A throw can lose an ACK but never
   * undo a committed checkpoint. No asynchronous UI callback owns the writer. */
  readonly progress?: (progress: Readonly<{ nextRow: number; totalRows: number; sequence: number }>) => void
  /** Synchronous observation after a durable publication/activation commit.
   * Throws may lose an ACK; recovery freshly authenticates the full source. */
  readonly publicationProgress?: (publication: Readonly<Brc38IdbRestorePublication>) => void
}
function invalid(): never {
  throw new Error('Authenticated browser restore differs from its original admission or isolated profile')
}

/** Complete authenticated envelope -> all-thirteen isolated rows.
 * Each call/resume performs fresh full cipher/EOF/semantic authentication,
 * then bounded serial preparations and atomic row/map/provenance/checkpoints.
 * Full current proof, destination/source-field and global packed-reference
 * inventory runs at COMPLETE.
 * The actual source namespace is discarded before success delivery. Receipt
 * and inventory are DATA. Profile publication and manager activation are
 * separate required steps, not implied by COMPLETE.
 * Never writes to the active wallet or changes negotiated provider capability. */
export interface Brc38AuthenticatedIdbRestoreResult {
  receipt: Readonly<Brc38ImportJournalReceipt>
  inventory?: Awaited<ReturnType<typeof inspectBrc38IdbRestoreInventory>>
  packedInventory?: Awaited<ReturnType<typeof inspectBrc38IdbPackedReferenceInventory>>
  publication?: Readonly<Brc38IdbRestorePublication>
  inactive: boolean
}
async function runAuthenticatedBrc39BrowserRestore(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedIdbRestoreOptions,
  target?: 'PUBLISHED' | 'ACTIVATED'
): Promise<Readonly<Brc38AuthenticatedIdbRestoreResult>> {
  const storage = selected.storage,
    admission = admissionCopy(selected.admission),
    sourceOptions = copyBrc38AuthenticatedStreamBrowserOptions(selected.source),
    journalOptions: Brc38IdbImportJournalOptions = Object.freeze({
      ...selected.journal,
      profile: Object.freeze({ ...selected.journal.profile }),
      allowActivatedProfile: target !== undefined
    }),
    rowPolicy: Brc38AuthenticatedIdbRestoreOptions['row'] = Object.freeze({
      ...selected.row,
      source: Object.freeze({ ...selected.row.source }),
      projection: Object.freeze({ ...selected.row.projection }),
      proof: Object.freeze({ ...selected.row.proof })
    }),
    maximumRows = selected.maximumRowsThisInvocation ?? admission.totalRows,
    progress = selected.progress,
    publicationProgress = selected.publicationProgress,
    working = journalOptions.workingAllocation,
    expiresAt = admission.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > admission.totalRows ||
    sourceOptions.streamedFields === undefined ||
    sourceOptions.streamedStructuredFields === undefined ||
    expiresAt !== sourceOptions.limits.expiresAt ||
    sourceOptions.binding.archiveSha256 !== admission.scope.archiveSha256 ||
    journalOptions.profile.identityKey !== sourceOptions.binding.identityKey ||
    journalOptions.profile.chain !== sourceOptions.binding.chain ||
    journalOptions.profile.targetStorageIdentityKey !== sourceOptions.binding.targetStorageIdentityKey ||
    rowPolicy.projection.workingAllocation !== working ||
    rowPolicy.proof.workingAllocation !== working ||
    rowPolicy.projection.expiresAt !== expiresAt ||
    working.maximum > sourceOptions.limits.maximumRowAllocationBytes ||
    (target !== undefined && (!['PUBLISHED', 'ACTIVATED'].includes(target) || maximumRows !== admission.totalRows)) ||
    (progress !== undefined && typeof progress !== 'function') ||
    (publicationProgress !== undefined && typeof publicationProgress !== 'function')
  )
    invalid()
  const check = () => {
    sourceOptions.signal?.throwIfAborted()
    journalOptions.signal?.throwIfAborted()
    rowPolicy.projection.signal?.throwIfAborted()
    rowPolicy.proof.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline) invalid()
  }
  let stage: Brc38PrivateIdbStage | undefined,
    journal: Brc38IdbImportJournal | undefined,
    prepared: Brc38IdbPreparedRestoreRow | undefined,
    metadataCharge: Brc38WorkingCharge | undefined
  const failures = new Set<Brc38StagingCleanupError>(),
    cleanup = async () => {
      const causes: unknown[] = []
      for (const close of [
        () =>
          mapAwaitFromSync(
            () => prepared?.close(),
            () => {
              prepared = undefined
            }
          ),
        () =>
          mapAwaitFromSync(
            () => journal?.close(),
            () => {
              journal = undefined
            }
          ),
        () =>
          mapAwaitFromSync(
            () => stage?.discard(new Error('Authenticated browser restore source retirement')),
            () => {
              stage = undefined
            }
          )
      ])
        try {
          await close()
        } catch (cause) {
          causes.push(cause)
        }
      for (const failure of failures)
        try {
          await failure.retryCleanup()
          failures.delete(failure)
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(
          causes,
          'Authenticated browser restore retains actual source/destination preparation cleanup',
          cleanup
        )
      metadataCharge?.close()
    }
  const observe = (receipt: Readonly<Brc38ImportJournalReceipt>) => {
    if (progress !== undefined) {
      const returned: unknown = progress(
        Object.freeze({ nextRow: receipt.nextRow, totalRows: admission.totalRows, sequence: receipt.sequence })
      )
      if (returned !== undefined) throw new Error('Browser restore progress must be a synchronous observer')
    }
    check()
  }
  const observePublication = (publication: Readonly<Brc38IdbRestorePublication>) => {
    if (publicationProgress !== undefined) {
      const returned: unknown = publicationProgress(publication)
      if (returned !== undefined) throw new Error('Browser publication progress must be a synchronous observer')
    }
    check()
  }
  try {
    check()
    // This invocation actually owns the encrypted source/KDF/GCM/complete EOF,
    // not a caller-created seal, previous preview or cached semantic result.
    stage = (await stageAuthenticatedBrc39StreamBrowserImport(source, password, sourceOptions)).stage
    check()
    metadataCharge = working.claim(16384 + 32 * sourceOptions.limits.maximumRowBytes)
    try {
      let metadata: Awaited<ReturnType<Brc38PrivateIdbStage['sealedMetadata']>> | undefined =
        await stage.sealedMetadata()
      if (
        metadata.bindingSha256 !== admission.scope.bindingSha256 ||
        metadata.originalLimitsJson !== admission.originalLimitsJson ||
        metadata.rows + 1 !== admission.totalRows
      )
        invalid()
      const owner = getPackedIdbConnection(await storage.verifyDB())
      if (owner === undefined || !/^wallet-toolbox-(main|test)net-restore-v1-[0-9a-f]{32}$/.test(owner.database.name))
        invalid()
      journal = await Brc38IdbImportJournal.open(owner, admission, journalOptions)
      let receipt = await journal.readExisting()
      if (receipt === undefined) {
        if ((await journal.emptyDestinationSha256()) !== admission.initialDestinationSha256) invalid()
        receipt = await journal.prepare(admission.initialDestinationSha256)
      }
      if (receipt.state === 'EXPIRED') invalid()
      const counts = Object.freeze({ ...metadata.counts })
      let committed = 0
      if (receipt.nextRow === 0) {
        const payload = JSON.stringify(metadata.header),
          user = decodePortableRow<Record<string, unknown>>('user', metadata.header.user),
          bytes = brc38Utf8ByteLength(payload),
          captured = receipt,
          receiptSha256 = digest(boundedJson(receipt))
        if (bytes > admission.maximumStepBytes || bytes > journalOptions.maximumOriginalRowBytes) invalid()
        user.userId = admission.scope.userId
        user.activeStorage = ''
        const normalized: Record<string, unknown> = await storage.validateEntityForInsert(
          user as unknown as EntityTimeStamp & Record<string, unknown>
        )
        check()
        receipt = await journal.commit(
          { fromRow: 0, rows: 1, bytes, mappedIds: 0, pageSha256: digest(payload) },
          captured.destinationSha256,
          async writer => {
            check()
            const key = await storage.writeStagedStorageRow('users', normalized, {}, 'add', writer.transaction)
            if (key !== admission.scope.userId) invalid()
            await writer.original('header', 0, payload, key)
            check()
            return digest(
              JSON.stringify(['browser-restore-header/v1', captured.destinationSha256, payload, key, normalized])
            )
          },
          receiptSha256
        )
        committed++
        observe(receipt)
      }
      // Drop the decoded header before row plans. Only fixed thirteen counts
      // remain; the source inventory later reads its current header afresh.
      metadata = undefined
      metadataCharge.resize(8192)
      let position = 1
      const actualPolicy = { ...rowPolicy, source: { ...rowPolicy.source, databaseName: stage.databaseName } }
      for (const table of brc38ImportTableOrder) {
        for (let index = 0; index < counts[table]; index++, position++) {
          check()
          if (position < receipt.nextRow) continue
          if (position !== receipt.nextRow) invalid()
          if (committed >= maximumRows) break
          prepared = await prepareBrc38IdbRestoreRow(stage, storage, journal, receipt, table, index, actualPolicy)
          check()
          receipt = await prepared.commit()
          await prepared.close()
          prepared = undefined
          committed++
          observe(receipt)
        }
        if (committed >= maximumRows && receipt.nextRow < admission.totalRows) break
      }
      let inventory: Awaited<ReturnType<typeof inspectBrc38IdbRestoreInventory>> | undefined,
        packedInventory: Awaited<ReturnType<typeof inspectBrc38IdbPackedReferenceInventory>> | undefined,
        publication: Readonly<Brc38IdbRestorePublication> | undefined
      if (receipt.state === 'COMPLETE') {
        // Current chain checks repeat before final inventory; earlier row
        // preparation is not a current proof/activation verdict.
        for (let index = 0; index < counts.provenTxs; index++) {
          check()
          await inspectBrc38PrivateIdbStreamedProof(stage, storage, index, actualPolicy.proof, expiresAt)
        }
        const receiptSha256 = digest(boundedJson(receipt))
        publication = await journal.readPublication(receiptSha256)
        inventory = await inspectBrc38IdbRestoreInventory(
          stage,
          journal,
          receipt,
          actualPolicy,
          publication?.state === 'ACTIVATED' ? journalOptions.profile.targetStorageIdentityKey : ''
        )
        packedInventory = await inspectBrc38IdbPackedReferenceInventory(journal, receipt)
        if (target !== undefined) {
          // Fresh authentication/proofs/complete inventories were performed
          // within THIS actual source-owning invocation. No saved report may
          // enter here. Retire and drain its plaintext before publication.
          check()
          await stage.discard(new Error('Authenticated browser profile publication source retirement'))
          stage = undefined
          check()
          const coordinates = await journal.readPackedInventoryCounts(receiptSha256)
          publication = await journal.publishCurrent(receiptSha256, coordinates)
          observePublication(publication)
          if (target === 'ACTIVATED') {
            publication = await journal.activatePublished(receiptSha256, coordinates)
            observePublication(publication)
            // The one new user version is ordinary MVCC garbage. Its current
            // references and counters are independently reconciled and drained.
            packedInventory = await inspectBrc38IdbPackedReferenceInventory(journal, receipt)
          }
        }
      }
      check()
      await cleanup()
      check()
      return Object.freeze({
        receipt,
        ...(inventory === undefined ? {} : { inventory }),
        ...(packedInventory === undefined ? {} : { packedInventory }),
        ...(publication === undefined ? {} : { publication }),
        inactive: publication?.state !== 'ACTIVATED'
      })
    } finally {
      // On failed drainage these objects/callbacks retain their original
      // metadata allowance. cleanup() releases it only after all owners close.
      if (stage === undefined && journal === undefined && prepared === undefined && failures.size === 0)
        metadataCharge.close()
    }
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Browser authenticated restore retains original concrete cleanup',
        cleanup
      )
    }
    throw cause
  }
}

/** Original inactive-only entry point remains additive and cannot read or
 * rewrite an activated profile. Complete reports confer no activation grant. */
export function restoreAuthenticatedBrc39BrowserInactive(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedIdbRestoreOptions
): Promise<Readonly<Brc38AuthenticatedIdbRestoreResult & { inactive: true }>> {
  return mapAwaitFromSync(
    () => runAuthenticatedBrc39BrowserRestore(source, password, selected),
    result => {
      if (!result.inactive) invalid()
      return Object.freeze({ ...result, inactive: true as const })
    }
  )
}

/** Explicit publication/activation, including restart and lost ACK. EVERY
 * call owns a fresh complete authenticated envelope, semantic replay, current
 * proofs and all13/global inventory under the original finite admission.
 * Existing activated profiles are inspected, never reinserted or overwritten.
 * This local transition does not select a different existing manager primary. */
export function publishAuthenticatedBrc39BrowserProfile(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedIdbRestoreOptions,
  target: 'PUBLISHED' | 'ACTIVATED'
): Promise<Readonly<Brc38AuthenticatedIdbRestoreResult>> {
  return awaitFromSync(() => {
    if (!['PUBLISHED', 'ACTIVATED'].includes(target)) invalid()
    return runAuthenticatedBrc39BrowserRestore(source, password, selected, target)
  })
}
