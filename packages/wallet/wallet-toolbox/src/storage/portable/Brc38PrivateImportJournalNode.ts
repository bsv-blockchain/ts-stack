import type { Brc38PrivateCheckpointData } from './Brc38PrivateCheckpointData'
import {
  assertBrc38PrivateMergeProgramBudget,
  bindBrc38PrivateMergeProgramJournal
} from './Brc38PrivateMergeProgramNode'
import { appendBrc38PrivateMergeTargets, type Brc38PrivateActionQuarantine } from './Brc38PrivateMergeTargetsNode'
import { readBrc38PrivateMergePageCacheBefore, appendBrc38PrivateMergePage } from './Brc38PrivateMergePagesNode'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { chargeBrc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { withBrc38PreparedPrivatePackedFields } from './Brc38NativePackedFieldPreparationNode'
import { withBrc38PreparedPrivatePackedText } from './Brc38NativePackedTextPreparationNode'
import { prepareBrc38StreamedImportPage, prepareBrc38StructuredImportPage } from './Brc38ImportPage'
import { prepareBrc38StructuredEntityRestore } from './Brc38ImportStructuredEntityRestoreNode'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjectionNode'
import {
  prepareBrc38StreamedEntityRestore,
  type Brc38PreparedStreamedEntityRestore
} from './Brc38ImportStreamedEntityRestoreNode'
import { prepareBrc38ImportPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { prepareBrc38ImportEntityTargets, type Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import { prepareBrc38ImportExistingRows, type Brc38ImportExistingRow } from './Brc38ImportExistingRows'
import {
  prepareBrc38ImportEntityMerge,
  Brc38ImportAliasPageError,
  type Brc38PreparedEntityMerge
} from './Brc38ImportEntityMergeNode'
import { prepareBrc38ImportHistory, type Brc38ImportHistoryProjection } from './Brc38ImportHistory'
import { prepareBrc38ImportEntityRestore, type Brc38PreparedEntityRestore } from './Brc38ImportEntityRestoreNode'
import { prepareBrc38ImportOriginals } from './Brc38ImportProvenanceNode'
import { prepareBrc38ImportMergeCheckpoint, type Brc38PreparedMergeCheckpoint } from './Brc38ImportMergeCheckpointNode'
import type { Brc38ImportDecodedBudget } from './Brc38ImportEntityMergeNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { decodeBrc38PrivateImportPreview, type Brc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import {
  withBrc38KnexImportDestination,
  withBrc38KnexImportReadDestination,
  assertBrc38RestoreDestinationEmpty,
  type Brc38KnexDestinationFence
} from './Brc38KnexDestinationFence'
import {
  readBrc38ImportJournal,
  prepareBrc38ImportJournal,
  commitBrc38ImportJournalStep,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalStep,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournal'
import { prepareBrc38ScalarMerge } from './Brc38ImportScalarMergeNode'
import { prepareBrc38SimpleFieldMerge } from './Brc38ImportSimpleFieldMergeNode'
import { prepareBrc38ProofMerge } from './Brc38ImportProofMergeNode'
import { prepareBrc38ActionMerge } from './Brc38ImportActionMergeNode'
import { withBrc38PreparedRequestMerge } from './Brc38ImportRequestMergeNode'
import { withBrc38PrivateOperationalCheckpoint } from './Brc38PrivateOperationalCheckpointNode'
import { readBrc38PrivateCheckpointWindow } from './Brc38PrivateCheckpointWindowNode'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import type { Brc38PrivatePreparedTextInstaller } from './Brc38NativePackedTextPreparationNode'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import type { PortableRow } from './Brc38PortableRows'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'

export interface Brc38PrivateImportJournalOptions {
  readonly admission: Brc38ImportJournalAdmission
  readonly receiptPolicy: SnapshotJournalReceiptPolicy
  /** Explicit internal field-aware receiver; no legacy missing-payload relaxation. */
  readonly streamed?: boolean
  /** Separate internal structured receiver; never inferred from descriptors. */
  readonly structured?: boolean
}
export interface Brc38PrivateImportJournalStepOptions extends Brc38PrivateImportJournalOptions {
  readonly step: Brc38ImportJournalStep
  readonly apply: (trx: Knex.Transaction) => Promise<void>
  readonly signal?: AbortSignal
}
function invalid(): never {
  throw new Error('Private import owner or destination differs from its admitted journal')
}
export function brc38ImportDestinationDigest(value: Brc38KnexDestinationFence): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function ownedAdmission(input: Brc38ImportJournalAdmission): Readonly<Brc38ImportJournalAdmission> {
  return Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) })
}
function boundAdmission(
  store: KnexBrc38StagingStore,
  admission: Brc38ImportJournalAdmission,
  json: string,
  metadata: Readonly<{ rows: number }>
): Readonly<Brc38PrivateImportPreview> {
  const preview = decodeBrc38PrivateImportPreview(store, json)
  if (
    admission.previewId !== preview.previewId ||
    admission.scope.bindingSha256 !== preview.bindingSha256 ||
    admission.scope.archiveSha256 !== preview.archiveSha256 ||
    admission.originalLimitsJson !== store.binding?.limitsJson ||
    admission.expiresAt !== preview.expiresAt ||
    admission.totalRows !== metadata.rows + 1 ||
    admission.initialDestinationSha256 !== brc38ImportDestinationDigest(preview.target)
  )
    invalid()
  if (preview.target.userId !== null && preview.target.userId !== admission.scope.userId) invalid()
  return preview
}
function stableTarget(
  original: Brc38KnexDestinationFence,
  current: Brc38KnexDestinationFence,
  userId: number,
  allowAbsent: boolean
): void {
  const fixed = ['backend', 'backendSha256', 'schemaVersionSha256', 'schemaSha256', 'epoch', 'ceiling'] as const
  if (fixed.some(key => current[key] !== original[key])) invalid()
  if (original.userId === null && current.userId === null && allowAbsent) return
  if (
    current.userId !== userId ||
    current.activeStorage !== (original.activeStorage ?? '') ||
    current.primaryEpoch !== (original.primaryEpoch ?? snapshotJournalRevision('0'))
  )
    invalid()
}
/** Retains the actual authenticated private kernel owner through its actual
 * destination pool, writer, receipt and physical cleanup. The cursor includes
 * one explicit user/header operation plus all authoritative staged table rows.
 * Schema installation belongs to the source migration before preview. */
export async function prepareBrc38PrivateImportJournal(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    policy = Object.freeze({ ...options.receiptPolicy })
  const view =
    options.structured === true
      ? store.withAuthenticatedStructuredImportView.bind(store)
      : options.streamed === true
        ? store.withAuthenticatedStreamedImportView.bind(store)
        : store.withAuthenticatedImportView.bind(store)
  return await view(async (json, metadata) => {
    const preview = boundAdmission(store, admission, json, metadata)
    return await withBrc38KnexImportDestination(storage, preview.target, policy, async (trx, read) => {
      const actual = await read()
      stableTarget(preview.target, actual, admission.scope.userId, true)
      const receipt = await prepareBrc38ImportJournal(
        trx,
        admission,
        brc38ImportDestinationDigest(actual),
        async () => {
          if (preview.target.mode === 'restore') await assertBrc38RestoreDestinationEmpty(trx)
        }
      )
      await assertBrc38PrivateMergeProgramBudget(trx, admission)
      await bindBrc38PrivateMergeProgramJournal(trx, admission)
      if (brc38ImportDestinationDigest(await read()) !== receipt.destinationSha256) invalid()
      return receipt
    })
  })
}
/** apply is an internal already-prepared bounded row/header operation. Crypto,
 * parser and source I/O must finish before writer acquisition. Full natural-key
 * and thirteen-table projection/verified mapping charges precede advertisement. */
export async function commitBrc38PrivateImportJournalStep(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalStepOptions
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    step = Object.freeze({ ...options.step }),
    policy = Object.freeze({ ...options.receiptPolicy }),
    apply = options.apply,
    signal = options.signal
  signal?.throwIfAborted()
  return await store.withAuthenticatedImportView(async (json, metadata) => {
    const preview = boundAdmission(store, admission, json, metadata)
    return await commitBoundImportStep(storage, policy, admission, step, apply, signal, preview)
  })
}

async function commitBoundImportStep(
  storage: StorageKnex,
  policy: SnapshotJournalReceiptPolicy,
  admission: Brc38ImportJournalAdmission,
  step: Brc38ImportJournalStep,
  apply: (trx: Knex.Transaction) => Promise<void>,
  signal: AbortSignal | undefined,
  preview: Brc38PrivateImportPreview,
  preparedReceipt?: Readonly<Brc38ImportJournalReceipt>,
  checkpointData?: (trx: Knex.Transaction) => Readonly<Brc38PrivateCheckpointData>
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  return await withBrc38KnexImportDestination(storage, preview.target, policy, async (trx, read) => {
    const actual = await read()
    stableTarget(preview.target, actual, admission.scope.userId, true)
    const previous = await readBrc38ImportJournal(trx, admission)
    const cacheBefore = await readBrc38PrivateMergePageCacheBefore(trx)
    if (preparedReceipt !== undefined && JSON.stringify(previous) !== JSON.stringify(preparedReceipt)) invalid()
    if (preview.target.mode === 'restore' && previous.state === 'PREPARED' && previous.nextRow === 0)
      await assertBrc38RestoreDestinationEmpty(trx)
    const receipt = await commitBrc38ImportJournalStep(
      trx,
      admission,
      step,
      brc38ImportDestinationDigest(actual),
      async () => {
        await apply(trx)
        await assertBrc38PrivateMergeProgramBudget(trx, admission)
        const post = await read()
        stableTarget(preview.target, post, admission.scope.userId, false)
        return brc38ImportDestinationDigest(post)
      },
      signal
    )
    if (previous.nextRow === step.fromRow) {
      await appendBrc38PrivateMergePage(trx, admission, step, previous, receipt, cacheBefore, checkpointData?.(trx))
      await assertBrc38PrivateMergeProgramBudget(trx, admission)
    }
    if (brc38ImportDestinationDigest(await read()) !== receipt.destinationSha256) invalid()
    signal?.throwIfAborted()
    return receipt
  })
}

export interface Brc38PrivateImportPageOptions extends Brc38PrivateImportJournalOptions {
  readonly fromRow: number
  /** Internal migration-dependent preparation, never an advertised capability. */
  readonly prepareEntityTargets?: boolean
  /** Internal bounded legacy payload preparation under the same read owner. */
  readonly prepareExistingRows?: boolean
  /** Internal admitted merge mode only; restore/header/provenance stay distinct. */
  readonly prepareEntityMerge?: boolean
  /** Internal native restore with durable originals, never activation. */
  readonly prepareEntityRestore?: boolean
  /** Internal merge originals share the fixed native preparation allowance. */
  readonly prepareOriginalProvenance?: boolean
  /** Internal safe prefix cap; never increases or renews original admission. */
  readonly maximumPreparedRows?: number
  readonly apply: (
    trx: Knex.Transaction,
    data: Brc38PreparedImportData,
    references: readonly Brc38ImportIdReference[],
    history: readonly Readonly<Brc38ImportHistoryProjection>[],
    targets: readonly Brc38ImportEntityTarget[],
    existing: readonly Brc38ImportExistingRow[],
    merge?: Brc38PreparedEntityMerge,
    restore?: Brc38PreparedEntityRestore,
    originals?: Awaited<ReturnType<typeof prepareBrc38ImportOriginals>>,
    checkpoint?: Brc38PreparedMergeCheckpoint
  ) => Promise<void>
  readonly signal?: AbortSignal
}
/** Concrete bounded source preparation under the same authenticated owner as
 * its actual physical destination transaction. The full thirteen-table
 * natural-key/provenance application remains an internal independent contract. */
export async function commitBrc38PrivateImportPage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportPageOptions
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    policy = Object.freeze({ ...options.receiptPolicy }),
    fromRow = options.fromRow,
    prepareMerge = options.prepareEntityMerge === true,
    prepareRestore = options.prepareEntityRestore === true,
    prepareOriginals = options.prepareOriginalProvenance === true,
    maximumPreparedRows = options.maximumPreparedRows,
    prepareRows = options.prepareExistingRows === true,
    prepareTargets = options.prepareEntityTargets === true || prepareRows,
    apply = options.apply,
    signal = options.signal
  signal?.throwIfAborted()
  return await store.withAuthenticatedImportRead(async (json, metadata, reader) => {
    const preview = boundAdmission(store, admission, json, metadata)
    if (prepareMerge && preview.target.mode !== 'merge')
      throw new Error('Private entity merge requires an admitted merge mode')
    if (prepareRestore && preview.target.mode !== 'restore')
      throw new Error('Private native restore requires an admitted restore mode')
    if (prepareOriginals && (!prepareMerge || prepareRestore || prepareTargets))
      throw new Error('Private merge originals require one admitted native merge preparation')
    const page = await prepareBrc38ImportPage(reader, metadata, admission, fromRow, signal, maximumPreparedRows)
    const source = prepareMerge
      ? await (
          await prepareBrc38ImportPage(reader, metadata, admission, 0, signal)
        ).consume(async header => {
          if (header.kind !== 'header') invalid()
          return header.source
        })
      : undefined
    const prepared = await page.consume(
      async data =>
        await withBrc38KnexImportReadDestination(storage, preview.target, policy, async (trx, actual) => {
          signal?.throwIfAborted()
          stableTarget(preview.target, actual, admission.scope.userId, true)
          const receipt = await readBrc38ImportJournal(trx, admission)
          if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256)
            invalid()
          const newPage = receipt.nextRow <= fromRow,
            originalBudget: Brc38ImportDecodedBudget | undefined = prepareOriginals
              ? {
                  maximum: admission.maximumStepBytes,
                  remaining: admission.maximumStepBytes,
                  signal
                }
              : undefined,
            originals =
              originalBudget !== undefined && newPage
                ? await prepareBrc38ImportOriginals(trx, reader, admission, data, fromRow, originalBudget)
                : undefined
          const checkpoint =
            originalBudget !== undefined && newPage && source !== undefined
              ? await prepareBrc38ImportMergeCheckpoint(
                  trx,
                  storage,
                  admission,
                  data,
                  page.references,
                  source,
                  reader,
                  page.step.fromRow + page.step.rows === admission.totalRows ||
                    (data.kind === 'table' && data.table === 'syncStates'),
                  originalBudget
                )
              : undefined
          const history =
            prepareRestore || prepareOriginals
              ? Object.freeze([])
              : await prepareBrc38ImportHistory(trx, admission.scope, data, admission.maximumStepBytes, signal)
          const targets = prepareTargets
            ? await prepareBrc38ImportEntityTargets(
                trx,
                admission.scope.userId,
                data,
                (await loadBrc38ImportIdMap(trx, admission.scope, page.references)).map,
                admission.maximumStepBytes,
                signal
              )
            : Object.freeze([])
          const existing = prepareRows
            ? await prepareBrc38ImportExistingRows(
                trx,
                storage,
                admission.scope.userId,
                data,
                targets,
                admission.maximumStepBytes,
                signal
              )
            : Object.freeze([])
          const merge =
            source !== undefined && data.kind === 'table' && (!prepareOriginals || newPage)
              ? await prepareBrc38ImportEntityMerge(
                  trx,
                  storage,
                  admission.scope,
                  data,
                  page.references,
                  source,
                  originalBudget?.remaining ?? admission.maximumStepBytes,
                  signal
                )
              : undefined
          // The actual writer verifies exact replay bytes against its durable
          // last receipt. An already committed prefix needs no native plan or
          // repeated chain/provenance allocation; apply cannot run without it.
          const restore =
            prepareRestore && receipt.nextRow <= fromRow
              ? await prepareBrc38ImportEntityRestore(
                  trx,
                  storage,
                  reader,
                  admission,
                  data,
                  page.references,
                  fromRow,
                  admission.maximumStepBytes,
                  signal
                )
              : undefined
          if (Date.now() >= admission.expiresAt) invalid()
          return {
            data,
            history,
            targets,
            existing,
            merge,
            restore,
            originals,
            checkpoint,
            receipt
          }
        })
    )
    return await commitBoundImportStep(
      storage,
      policy,
      admission,
      page.step,
      async trx =>
        await apply(
          trx,
          prepared.data,
          page.references,
          prepared.history,
          prepared.targets,
          prepared.existing,
          prepared.merge,
          prepared.restore,
          prepared.originals,
          prepared.checkpoint
        ),
      signal,
      preview,
      prepared.receipt
    )
  })
}

/** Original native IDs/relations/history are retained; durable provenance,
 * row writes and cursor share one actual journal transaction. No activation. */
export async function commitBrc38PrivateImportRestorePage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & {
    readonly fromRow: number
    readonly signal?: AbortSignal
  }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  return await commitBrc38PrivateImportPage(store, storage, {
    ...options,
    prepareEntityRestore: true,
    apply: async (trx, _data, _references, _history, _targets, _existing, _merge, restore) => {
      if (restore === undefined) invalid()
      await restore.apply(trx)
    }
  })
}

/** Original header/raw rows remain independent from operational entity merge.
 * Existing local profile/primary bytes are preserved. Originals/counters,
 * actual native effects and receipt commit in the same owned transaction. */
export async function commitBrc38PrivateImportMergePage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & {
    readonly fromRow: number
    readonly signal?: AbortSignal
  }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const selected: Brc38PrivateImportPageOptions = {
    ...options,
    prepareEntityMerge: true,
    prepareEntityRestore: false,
    prepareEntityTargets: false,
    prepareExistingRows: false,
    prepareOriginalProvenance: true,
    apply: async (trx, data, _references, _history, _targets, _existing, merge, _restore, originals, checkpoint) => {
      if (originals === undefined || checkpoint === undefined) invalid()
      await checkpoint.assert(trx)
      await originals.apply(trx)
      if (data.kind === 'table') {
        if (merge === undefined) invalid()
        await merge.apply(trx)
      }
      await checkpoint.apply(trx)
    }
  }
  try {
    return await commitBrc38PrivateImportPage(store, storage, selected)
  } catch (error) {
    if (!(error instanceof Brc38ImportAliasPageError) || error.prefixRows < 1) throw error
    // The refused larger preparation had no writer or original insertion.
    // Reprepare the native alias-safe prefix with the same fixed admission.
    return await commitBrc38PrivateImportPage(store, storage, {
      ...selected,
      maximumPreparedRows: error.prefixRows
    })
  }
}

/** Complete table effects, mappings and cursor share the actual authenticated
 * journal transaction. Header creation and durable activation are separate. */
export async function commitBrc38PrivateImportEntityPage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & {
    readonly fromRow: number
    readonly signal?: AbortSignal
  }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const selected: Brc38PrivateImportPageOptions = {
    ...options,
    prepareEntityMerge: true,
    apply: async (trx, data, _references, _history, _targets, _existing, merge) => {
      if (data.kind !== 'table' || merge === undefined) invalid()
      await merge.apply(trx)
    }
  }
  try {
    return await commitBrc38PrivateImportPage(store, storage, selected)
  } catch (error) {
    if (!(error instanceof Brc38ImportAliasPageError) || error.prefixRows < 1) throw error
    // The first read owner has physically drained. Reprepare its distinct
    // prefix under the unchanged authenticated admission and exact receipt.
    // No writer or partial operation ran during the refused larger page.
    return await commitBrc38PrivateImportPage(store, storage, {
      ...selected,
      maximumPreparedRows: error.prefixRows
    })
  }
}

/** Actual private field-aware receiver. Source/crypto/network/proof preparation
 * and read-only target receipt inspection precede writer acquisition. Verified
 * fields, original provenance, all native IDs and cursor commit together;
 * exact replay uses the destination receipt and never reapplies effects. */
export async function commitBrc38PrivateStreamedRestorePage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & { readonly fromRow: number; readonly signal?: AbortSignal }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    policy = Object.freeze({ ...options.receiptPolicy }),
    fromRow = options.fromRow,
    signal = options.signal
  signal?.throwIfAborted()
  return await store.withAuthenticatedStreamedImportRead(async (json, metadata, reader) => {
    const preview = boundAdmission(store, admission, json, metadata)
    if (preview.target.mode !== 'restore') invalid()
    const page = await prepareBrc38StreamedImportPage(reader, metadata, admission, fromRow, signal)
    const prior = await withBrc38KnexImportReadDestination(storage, preview.target, policy, async (trx, actual) => {
      stableTarget(preview.target, actual, admission.scope.userId, true)
      const receipt = await readBrc38ImportJournal(trx, admission)
      if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256) invalid()
      return receipt
    })
    // Durable replay has no field staging or entity effects. The original
    // page fingerprint and current receipt still pass the atomic replay gate.
    if (prior.nextRow > fromRow)
      return await commitBoundImportStep(
        storage,
        policy,
        admission,
        page.step,
        async () => invalid(),
        signal,
        preview,
        prior
      )
    return await withBrc38PreparedPrivatePackedFields(store, page, admission.expiresAt, signal, async install => {
      const prepared = await withBrc38KnexImportReadDestination(
        storage,
        preview.target,
        policy,
        async (trx, actual) => {
          stableTarget(preview.target, actual, admission.scope.userId, true)
          const receipt = await readBrc38ImportJournal(trx, admission)
          if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256)
            invalid()
          const restore: Brc38PreparedStreamedEntityRestore | undefined =
            receipt.nextRow <= fromRow
              ? await prepareBrc38StreamedEntityRestore(trx, storage, reader, admission, page, signal, install)
              : undefined
          signal?.throwIfAborted()
          return { receipt, restore }
        }
      )
      return await commitBoundImportStep(
        storage,
        policy,
        admission,
        page.step,
        async trx => {
          if (prepared.restore === undefined) invalid()
          await prepared.restore.apply(trx)
        },
        signal,
        preview,
        prepared.receipt
      )
    })
  })
}

/** Complete structured page preparation retains original descriptor provenance
 * and prepares inactive history on the actual read-only target. Its one-use
 * effect plan, native field pointers, maps and exact replay receipt share the
 * final genuine private writer. No publication or activation is granted. */
export async function commitBrc38PrivateStructuredRestorePage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & {
    readonly fromRow: number
    readonly sourcePolicy: Brc38PrivateStructuredPolicy
    readonly projectionPolicy: Brc38StreamedSyncMapProjectionPolicy
    readonly signal?: AbortSignal
  }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    policy = Object.freeze({ ...options.receiptPolicy }),
    fromRow = options.fromRow,
    signal = options.signal,
    sourcePolicy = brc38PrivateStructuredPolicy(options.sourcePolicy, store.directory),
    selected = options.projectionPolicy,
    projectionPolicy = Object.freeze({
      privateParent: selected.privateParent,
      maximumTemporaryFileBytes: selected.maximumTemporaryFileBytes,
      maximumMembers: selected.maximumMembers,
      maximumOutputBytes: selected.maximumOutputBytes,
      maximumScalarBytes: selected.maximumScalarBytes,
      maximumIndexAllocationBytes: selected.maximumIndexAllocationBytes,
      maximumGrammarAllocationBytes: selected.maximumGrammarAllocationBytes,
      workingAllocation: selected.workingAllocation,
      maximumReadBytes: Math.min(sourcePolicy.maximumReadBytes ?? 65536, selected.maximumReadBytes ?? 65536),
      expiresAt: selected.expiresAt,
      signal: selected.signal
    })
  signal?.throwIfAborted()
  if (
    (sourcePolicy.signal !== undefined && sourcePolicy.signal !== signal) ||
    (projectionPolicy.signal !== undefined && projectionPolicy.signal !== signal) ||
    projectionPolicy.expiresAt !== admission.expiresAt
  )
    throw new RangeError('Structured restore policies differ from the original operation')
  const effectiveSource = Object.freeze({ ...sourcePolicy, signal }),
    effectiveProjection = Object.freeze({ ...projectionPolicy, signal })
  return await store.withAuthenticatedStructuredImportRead(async (json, metadata, reader) => {
    const preview = boundAdmission(store, admission, json, metadata)
    if (preview.target.mode !== 'restore') invalid()
    const page = await prepareBrc38StructuredImportPage(reader, metadata, admission, fromRow, signal)
    const prior = await withBrc38KnexImportReadDestination(storage, preview.target, policy, async (trx, actual) => {
      stableTarget(preview.target, actual, admission.scope.userId, true)
      const receipt = await readBrc38ImportJournal(trx, admission)
      if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256) invalid()
      return receipt
    })
    // Durable replay has no field staging or entity effects. The original
    // page fingerprint and current receipt still pass the atomic replay gate.
    if (prior.nextRow > fromRow)
      return await commitBoundImportStep(
        storage,
        policy,
        admission,
        page.step,
        async () => invalid(),
        signal,
        preview,
        prior
      )
    const projections = new Map<number, Readonly<Brc38JsonStructuredField>>()
    if (page.data.kind === 'table' && (page.data.table === 'provenTxReqs' || page.data.table === 'syncStates')) {
      const field = page.data.table === 'provenTxReqs' ? 'notify' : 'syncMap'
      for (const [index, row] of page.data.rows.entries()) {
        if (row.source.structured?.[field] === undefined) continue
        signal?.throwIfAborted()
        chargeBrc38ImportDecodedBudget(page.budget, 4096)
        const prepared =
          page.data.table === 'provenTxReqs'
            ? await store.stagePrivateNotifyProjection(
                admission,
                page.data.fromIndex + index,
                fromRow,
                effectiveSource,
                effectiveProjection
              )
            : await store.stagePrivateSyncMapProjection(
                admission,
                page.data.fromIndex + index,
                fromRow,
                effectiveSource,
                effectiveProjection
              )
        projections.set(page.data.fromIndex + index, prepared.descriptor)
      }
    }
    return await withBrc38PreparedPrivatePackedText(
      store,
      page,
      projections,
      admission.expiresAt,
      signal,
      async installText =>
        await withBrc38PreparedPrivatePackedFields(store, page, admission.expiresAt, signal, async install => {
          const prepared = await withBrc38KnexImportReadDestination(
            storage,
            preview.target,
            policy,
            async (trx, actual) => {
              stableTarget(preview.target, actual, admission.scope.userId, true)
              const receipt = await readBrc38ImportJournal(trx, admission)
              if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256)
                invalid()
              const restore =
                receipt.nextRow <= fromRow
                  ? await prepareBrc38StructuredEntityRestore(
                      trx,
                      storage,
                      reader,
                      admission,
                      page,
                      store,
                      effectiveSource,
                      effectiveProjection,
                      signal,
                      install,
                      projections,
                      installText
                    )
                  : undefined
              signal?.throwIfAborted()
              return { receipt, restore }
            }
          )
          return await commitBoundImportStep(
            storage,
            policy,
            admission,
            page.step,
            async trx => {
              if (prepared.restore === undefined) invalid()
              await prepared.restore.apply(trx)
            },
            signal,
            preview,
            prepared.receipt
          )
        })
    )
  })
}

interface PrivateStructuredMergeEffect {
  readonly checkpointMappings: readonly Readonly<{ incomingId: number; localId: number }>[]
  readonly proofChanges?: readonly boolean[]
  readonly actionQuarantines?: readonly (Readonly<Brc38PrivateActionQuarantine> | null)[]
  apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }>
  close?(): void | Promise<void>
}

/** Actual occupied private candidate page controller. It requires a separately
 * established coherent baseline and an authenticated merge preview; it never
 * copies a live wallet, activates a provider or relaxes empty restore guards.
 * All twelve entity policies, inert archived sync-state provenance, operational
 * checkpoint, import maps and durable receipt share the final primary-fenced
 * journal transaction. Every derived/field staging read drains before writes.
 * Qualification and coherent-baseline/platform cutover remain separate work. */
export async function commitBrc38PrivateStructuredMergePage(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  options: Brc38PrivateImportJournalOptions & {
    readonly fromRow: number
    readonly sourcePolicy: Brc38PrivateCurrentStructuredPolicy
    readonly projectionPolicy: Brc38StreamedHistoryProjectionPolicy
    readonly maximumPreparedRows?: number
    /** Additive private path; existing v2 receipts also select it on resume. */
    readonly incrementalCheckpoint?: boolean
    readonly signal?: AbortSignal
  }
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  const admission = ownedAdmission(options.admission),
    receiptPolicy = Object.freeze({ ...options.receiptPolicy }),
    fromRow = options.fromRow,
    signal = options.signal,
    source = Object.freeze({ ...options.sourcePolicy }),
    projection = Object.freeze({ ...options.projectionPolicy }),
    maximumRows = options.maximumPreparedRows ?? 1
  signal?.throwIfAborted()
  if (
    source.expiresAt !== admission.expiresAt ||
    projection.expiresAt !== admission.expiresAt ||
    source.signal !== signal ||
    projection.signal !== signal ||
    source.workingAllocation !== projection.workingAllocation ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > admission.maximumStepRows
  )
    invalid()
  const attempt = async (maximumPreparedRows: number): Promise<Readonly<Brc38ImportJournalReceipt>> =>
    await store.withAuthenticatedStructuredImportRead(async (json, metadata, reader) => {
      const preview = boundAdmission(store, admission, json, metadata)
      if (preview.target.mode !== 'merge' || preview.target.userId !== admission.scope.userId) invalid()
      const inspect = async <V>(work: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
          await withBrc38KnexImportReadDestination(storage, preview.target, receiptPolicy, async (trx, actual) => {
            stableTarget(preview.target, actual, admission.scope.userId, false)
            const receipt = await readBrc38ImportJournal(trx, admission)
            if (receipt.state === 'EXPIRED' || brc38ImportDestinationDigest(actual) !== receipt.destinationSha256)
              invalid()
            return await work(trx)
          }),
        prior = await inspect(async trx => await readBrc38ImportJournal(trx, admission))
      if (fromRow === admission.totalRows && prior.state === 'COMPLETE' && prior.nextRow === fromRow) return prior
      if (prior.nextRow < fromRow) invalid()
      // An acknowledged alias-safe prefix must replay its original exact shape.
      const working = brc38WorkingAllocation(source.workingAllocation)
      if (working === undefined) invalid()
      const window =
        prior.nextRow > fromRow
          ? undefined
          : await inspect(
              async trx =>
                await readBrc38PrivateCheckpointWindow(
                  store,
                  trx,
                  admission,
                  prior,
                  working,
                  options.incrementalCheckpoint ?? false,
                  maximumPreparedRows
                )
            )
      const replayRows =
          prior.nextRow > fromRow && prior.lastStep?.fromRow === fromRow
            ? prior.lastStep.rows
            : (window?.maximumPreparedRows ?? maximumPreparedRows),
        page = await prepareBrc38StructuredImportPage(reader, metadata, admission, fromRow, signal, replayRows)
      if (prior.nextRow > fromRow)
        return await commitBoundImportStep(
          storage,
          receiptPolicy,
          admission,
          page.step,
          async () => invalid(),
          signal,
          preview,
          prior
        )
      const consume = async (effect: PrivateStructuredMergeEffect): Promise<Readonly<Brc38ImportJournalReceipt>> => {
          try {
            return await withBrc38PrivateOperationalCheckpoint(
              store,
              storage,
              admission,
              page,
              reader,
              effect.checkpointMappings,
              source,
              async checkpoint =>
                await commitBoundImportStep(
                  storage,
                  receiptPolicy,
                  admission,
                  page.step,
                  async trx => {
                    await checkpoint.assert(trx)
                    await effect.apply(trx)
                    await appendBrc38PrivateMergeTargets(
                      trx,
                      admission,
                      page,
                      effect.proofChanges,
                      effect.actionQuarantines
                    )
                    await checkpoint.apply(trx)
                  },
                  signal,
                  preview,
                  prior,
                  trx => checkpoint.committedData(trx)
                ),
              window
            )
          } finally {
            await effect.close?.()
          }
        },
        effects = async (
          install: Brc38PrivatePreparedFieldInstaller,
          installText: Brc38PrivatePreparedTextInstaller
        ): Promise<Readonly<Brc38ImportJournalReceipt>> => {
          if (page.data.kind === 'table' && page.data.table === 'provenTxReqs')
            return await withBrc38PreparedRequestMerge(
              store,
              storage,
              reader,
              admission,
              page,
              install,
              source,
              projection,
              consume
            )
          const effect = await inspect<PrivateStructuredMergeEffect>(async trx => {
            if (page.data.kind === 'header' || page.data.table === 'syncStates') {
              const originalReader: Readonly<Brc38AuthenticatedImportReader> =
                  Object.freeze<Brc38AuthenticatedImportReader>({
                    header: reader.header,
                    count: reader.count,
                    row: async (table, index) => {
                      const value = await reader.row(table, index)
                      return value === undefined
                        ? undefined
                        : ({
                            protocol: 'brc38-structured-original/v1',
                            table,
                            index,
                            fields: value.fields,
                            binaries: value.binaries,
                            structured: value.structured ?? {},
                            ...(Object.keys(value.texts ?? {}).length === 0 ? {} : { texts: value.texts })
                          } as unknown as PortableRow)
                    }
                  }),
                originals = await prepareBrc38ImportStructuredOriginals(
                  trx,
                  originalReader,
                  admission,
                  page.data,
                  page.step.fromRow,
                  page.budget
                )
              return Object.freeze({
                checkpointMappings: Object.freeze([]),
                apply: async (writer: Knex.Transaction) => {
                  if (page.data.kind === 'table')
                    for (const [index, row] of page.data.rows.entries())
                      await assertBrc38NativeStreamedSourceRow(
                        writer,
                        page.data.table,
                        page.data.fromIndex + index,
                        row.source,
                        admission.maximumStepBytes
                      )
                  await originals.apply(writer)
                  return { inserts: 0, updates: 0 }
                }
              })
            }
            switch (page.data.table) {
              case 'outputBaskets':
              case 'outputTags':
              case 'txLabels':
              case 'txLabelMaps':
              case 'outputTagMaps':
                return await prepareBrc38ScalarMerge(trx, storage, reader, admission, page, signal)
              case 'certificates':
              case 'certificateFields':
              case 'commissions':
                return await prepareBrc38SimpleFieldMerge(
                  trx,
                  storage,
                  reader,
                  admission,
                  page,
                  install,
                  installText,
                  signal
                )
              case 'provenTxs':
                return await prepareBrc38ProofMerge(trx, storage, reader, admission, page, install, signal)
              case 'transactions':
              case 'outputs':
                return await prepareBrc38ActionMerge(
                  trx,
                  storage,
                  reader,
                  admission,
                  page,
                  install,
                  installText,
                  signal
                )
              default:
                return invalid()
            }
          })
          return await consume(effect)
        },
        unusedBinary: Brc38PrivatePreparedFieldInstaller = async () => invalid(),
        unusedText: Brc38PrivatePreparedTextInstaller = async () => invalid()
      // Original sync-state payloads remain archive provenance; no operational
      // map or archived init/error state is installed as an occupied provider.
      if (
        page.data.kind === 'header' ||
        ['outputBaskets', 'outputTags', 'txLabels', 'txLabelMaps', 'outputTagMaps', 'syncStates'].includes(
          page.data.table
        )
      )
        return await effects(unusedBinary, unusedText)
      return await Brc38PrivateDerivedTextLifetimes.with(
        store,
        projection,
        async lifetimes =>
          await withBrc38PreparedPrivatePackedFields(
            store,
            page,
            admission.expiresAt,
            signal,
            async install => {
              if (page.data.kind !== 'table') invalid()
              if (page.data.table === 'provenTxs' || page.data.table === 'provenTxReqs')
                return await effects(install, unusedText)
              return await withBrc38PreparedPrivatePackedText(
                store,
                page,
                new Map(),
                admission.expiresAt,
                signal,
                async installText => await effects(install, installText),
                lifetimes
              )
            },
            lifetimes
          )
      )
    })
  let width = maximumRows
  for (;;) {
    try {
      return await attempt(width)
    } catch (error) {
      // The first actual source/read/preparation owners have drained before
      // retry. A shrinking prefix keeps the captured admission and deadline;
      // no aliases are applied against one stale pre-page target view.
      if (
        !(error instanceof Brc38ImportAliasPageError) ||
        !Number.isSafeInteger(error.prefixRows) ||
        error.prefixRows < 1 ||
        error.prefixRows >= width
      )
        throw error
      width = error.prefixRows
      signal?.throwIfAborted()
    }
  }
}
