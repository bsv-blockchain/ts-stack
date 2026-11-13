import { promiseFromSync } from '../../utility/promiseFromSync'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { copyBrc38ComposedProfileReceipt, type Brc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import { collectBrc38NativePackedContent } from './Brc38NativePackedTextFieldsNode'
import { inspectBrc38PrivateLocalRecovery } from './Brc38PrivateLocalInventoryNode'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { inspectBrc38PrivateCheckpointInventory } from './Brc38PrivateCheckpointInventoryNode'
import { inspectBrc38PrivateMergeHistory } from './Brc38PrivateMergeHistoryInventoryNode'
import { inspectBrc38PrivateProofInventory, type Brc38PrivateProofInventory } from './Brc38PrivateProofInventoryNode'
import { inspectBrc38PrivateScalarInventory } from './Brc38PrivateScalarInventoryNode'
import {
  inspectBrc38PrivateSimpleFieldInventory,
  inspectBrc38PrivateTransactionInventory,
  inspectBrc38PrivateOutputInventory
} from './Brc38PrivateSimpleFieldInventoryNode'
import { inspectBrc38PrivateUserInventory } from './Brc38PrivateUserInventoryNode'
import { inspectBrc38PrivateRequestInventory } from './Brc38PrivateRequestInventoryNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import { randomUUID } from 'node:crypto'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { WalletStorageManager, WalletStorageProviderTransition } from '../WalletStorageManager'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  Brc38PrivateLocalCandidate,
  Brc38PrivateCompositionRequiredError,
  type Brc38PrivateLocalCandidateOptions,
  type Brc38PrivateCompositionStatus
} from './Brc38PrivateLocalCandidateNode'
import {
  brc38StructuredRestoreResources,
  type Brc38PrivateStructuredRestoreResources
} from './Brc38StructuredRestoreResourcesNode'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { registerBrc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'
import {
  previewBrc38PrivateImport,
  readBrc38PrivateImportPreview,
  type Brc38PrivateImportPreview
} from './Brc38PrivateImportPreviewNode'
import { brc38CopiedImportDestinationDigest } from './Brc38CopiedImportDestinationNode'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateStructuredMergePage
} from './Brc38PrivateImportJournalNode'
import { assertBrc38PrivateMergeProgramBudget } from './Brc38PrivateMergeProgramNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import {
  readBrc38ComposedDatabaseImage,
  type Brc38ComposedDatabaseImage,
  type Brc38ComposedDatabaseImagePolicy
} from './Brc38ComposedDatabaseImageNode'

export interface Brc38PrivateNativeMergeOptions extends Brc38PrivateLocalCandidateOptions {
  readonly structuredResources: Brc38PrivateStructuredRestoreResources
}
export interface Brc38PrivateNativeMergeProgress {
  readonly phase: 'BASELINE' | 'PRIOR_IMPORTS' | 'PREPARED' | 'IMPORT' | 'REFOLD' | 'INVENTORY_REQUIRED'
  readonly episode: number
  readonly nextRow?: number
  readonly totalRows?: number
}
const issuer = Object.freeze({})
const actualMerges = new WeakSet<Brc38PrivateNativeMergeNode>()
function invalid(): never {
  throw new Error('Private native merge differs from its original source, resources or active composition episode')
}
/** Scoped complete baseline-to-page coordinator, never an activation grant.
 * Source and private owners remain separate. One step performs a bounded copy,
 * custody operation or import page; source changes after an incoming commit
 * require an explicit bounded refold. A final composed inventory/current-primary
 * cutover must still be supplied by the publication owner. */
export class Brc38PrivateNativeMergeNode {
  readonly #io = new Brc38OwnedImportReads()
  #live = true
  #copyTarget?: string
  #compositionImageReceipt?: Readonly<Brc38ComposedProfileReceipt>
  #compositionImageMode?: 'current' | 'retired'
  #forwardRetirementImage?: Readonly<{
    manager: WalletStorageManager
    transition: WalletStorageProviderTransition
    retirement: Awaited<ReturnType<typeof Brc38NativeLocalBaselineSource.forwardCompositionOrigin>>['retirement']
  }>
  readonly #deadline: number
  readonly #storage: StorageKnex
  readonly #store: KnexBrc38StagingStore
  readonly #source: Brc38NativeLocalBaselineSource
  readonly #options: Readonly<Brc38PrivateNativeMergeOptions>
  readonly #policyJson: string
  readonly #requestProjection: Readonly<Brc38StreamedHistoryProjectionPolicy>
  private constructor(
    token: object,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    options: Readonly<Brc38PrivateNativeMergeOptions>,
    policyJson: string,
    requestProjection: Readonly<Brc38StreamedHistoryProjectionPolicy>
  ) {
    if (token !== issuer) invalid()
    actualMerges.add(this)
    this.#store = store
    this.#source = source
    this.#options = options
    this.#policyJson = policyJson
    this.#requestProjection = requestProjection
    this.#deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
    this.#storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions(store.binding!.binding.chain),
      knex: store.knex,
      snapshotSync: false
    })
    this.#storage.setServices(options.services)
    registerBrc38PrivateDestinationLease(this.#storage, store)
  }
  #check(): void {
    this.#options.signal?.throwIfAborted()
    if (!this.#live || Date.now() >= this.#store.operationExpiresAt || performance.now() >= this.#deadline) invalid()
    this.#store.assertPrivateNativeDestination(this.#store.knex)
    Brc38NativeLocalBaselineSource.assertSharedWorking(this.#source, this.#options.workingAllocation)
  }
  async #candidate<T>(work: (candidate: Brc38PrivateLocalCandidate) => Promise<T>): Promise<T> {
    this.#check()
    return await Brc38PrivateLocalCandidate.with(this.#store, this.#source, this.#options, async candidate => {
      await candidate.prepareMergeProgram(this.#policyJson)
      const result = await work(candidate)
      this.#check()
      return result
    })
  }
  async #available(): Promise<void> {
    await this.#store.withAuthenticatedPrivateStructuredDestination(async () => {
      this.#check()
      const settings = await this.#storage.makeAvailable()
      if (settings.storageIdentityKey !== this.#store.binding!.binding.targetStorageIdentityKey) invalid()
    })
  }
  async #status(): Promise<Readonly<Brc38PrivateCompositionStatus>> {
    return await this.#candidate(async candidate => await candidate.inspectComposition())
  }
  status(): Promise<Readonly<Brc38PrivateCompositionStatus>> {
    return this.#io.run(async () => {
      this.#check()
      return await this.#status()
    })
  }
  step(): Promise<Readonly<Brc38PrivateNativeMergeProgress>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      return await this.#step(await this.#status())
    })
  }
  /** One actual runner operation: read fresh status once, then perform its
   * original bounded step or complete comparison under this owned I/O scope.
   * No caller supplies status, and no observation survives this operation. */
  advance(): Promise<
    | Readonly<{ progress: Readonly<Brc38PrivateNativeMergeProgress> }>
    | Readonly<{ inventory: Awaited<ReturnType<Brc38PrivateNativeMergeNode['inspectComposedRows']>> }>
  > {
    return this.#io.run(async () => {
      this.#check()
      const before = await this.#status()
      if (before.phase === 'IMPORT' && !before.sourceChanged && before.receipt?.state === 'COMPLETE')
        return Object.freeze({ inventory: await this.#inspectComposedRows(false) })
      this.#store.assertMutableImport()
      return Object.freeze({ progress: await this.#step(before) })
    })
  }
  async #step(before: Readonly<Brc38PrivateCompositionStatus>): Promise<Readonly<Brc38PrivateNativeMergeProgress>> {
    if (before.phase === 'IMPORT') {
      if (before.sourceChanged) {
        const rebuilt = await this.#candidate(async candidate => await candidate.beginCompositionRebuild())
        return Object.freeze({ phase: 'REFOLD', episode: rebuilt.episode })
      }
      const admission = before.admission,
        receipt = before.receipt
      if (admission === undefined || receipt === undefined) invalid()
      if (receipt.state === 'COMPLETE')
        return Object.freeze({
          phase: 'INVENTORY_REQUIRED',
          episode: before.episode,
          nextRow: receipt.nextRow,
          totalRows: admission.totalRows
        })
      await this.#available()
      const current = await commitBrc38PrivateStructuredMergePage(this.#store, this.#storage, {
        admission,
        receiptPolicy: this.#options.receiptPolicy,
        fromRow: receipt.nextRow,
        sourcePolicy: {
          ...this.#options.structuredResources.sourcePolicy,
          expiresAt: this.#store.operationExpiresAt,
          maximumCombinedTemporaryBytes: this.#options.structuredResources.maximumCombinedTemporaryBytes
        },
        projectionPolicy: this.#requestProjection,
        maximumPreparedRows: this.#options.maximumStepRows,
        incrementalCheckpoint: true,
        signal: this.#options.signal
      })
      this.#check()
      return Object.freeze({
        phase: current.state === 'COMPLETE' ? 'INVENTORY_REQUIRED' : 'IMPORT',
        episode: before.episode,
        nextRow: current.nextRow,
        totalRows: admission.totalRows
      })
    }
    const baseline = await this.#candidate(async candidate => {
      const progress = await candidate.step()
      if (!progress.recoveryRequired || !progress.garbageComplete)
        return { ready: false, prior: false, episode: progress.rebuilds }
      const prior = await candidate.copyPriorImportStep()
      if (!prior.complete) return { ready: false, prior: true, episode: progress.rebuilds }
      // Full data comparison precedes incoming effects. These inspections are
      // read-only and create no reusable verdict or activation authority.
      await candidate.inspectBaseline()
      await candidate.inspectPriorImports()
      await candidate.copySequences()
      await candidate.prepareIncomingIds()
      const prepared = await candidate.prepareCompositionRecovery()
      return { ready: true, prior: false, episode: prepared.episode }
    })
    if (!baseline.ready)
      return Object.freeze({ phase: baseline.prior ? 'PRIOR_IMPORTS' : 'BASELINE', episode: baseline.episode })
    // Candidate.with has drained its store scope before preview/journal I/O.
    // The preview can be replaced safely until the atomic journal/episode
    // bind commits; afterwards resume uses that exact actual active admission.
    await this.#available()
    const preview = await previewBrc38PrivateImport(this.#store, this.#storage, 'merge', this.#options.receiptPolicy)
    let rows = 0
    await this.#store.withAuthenticatedPrivateStructuredDestination((header, metadata) => {
      return promiseFromSync(() => {
        this.#check()
        if (header.user.identityKey !== preview.target.identityKey || preview.target.userId === null) invalid()
        rows = metadata.rows
      })
    })
    const binding = this.#store.binding!,
      admission: Readonly<Brc38ImportJournalAdmission> = Object.freeze({
        scope: Object.freeze({
          importId: randomUUID(),
          bindingSha256: binding.digest,
          archiveSha256: binding.binding.archiveSha256,
          userId: preview.target.userId!
        }),
        previewId: preview.previewId,
        originalLimitsJson: binding.limitsJson,
        expiresAt: this.#store.limits.expiresAt,
        initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
        totalRows: rows + 1,
        maximumStepRows: this.#options.maximumStepRows,
        maximumStepBytes: this.#options.maximumStepBytes,
        maximumMappedIds: this.#options.maximumMappedIds,
        maximumJournalLogicalBytes: this.#options.maximumJournalLogicalBytes
      })
    await prepareBrc38PrivateImportJournal(this.#store, this.#storage, {
      admission,
      receiptPolicy: this.#options.receiptPolicy,
      streamed: true,
      structured: true
    })
    await this.#candidate(async candidate => await candidate.bindCompositionImport(admission))
    this.#check()
    return Object.freeze({ phase: 'PREPARED', episode: baseline.episode, nextRow: 0, totalRows: admission.totalRows })
  }
  /** Re-read the active receipt and original aggregate quota against the actual
   * current private destination. This is a necessary checkpoint, not the full
   * composed semantic inventory or any current-primary/cutover permission. */
  inspectCheckpoint(): Promise<void> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (
                receipt.state !== 'COMPLETE' ||
                receipt.nextRow !== admission.totalRows ||
                receipt.destinationSha256 !== brc38ImportDestinationDigest(actual)
              )
                invalid()
              await assertBrc38PrivateMergeProgramBudget(k, admission)
            }
          )
      )
      this.#check()
    })
  }
  inspectLocalRecovery(): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status()
      if (status.phase !== 'IMPORT' || status.sourceChanged || status.receipt?.state !== 'COMPLETE') invalid()
      return await this.#candidate(async candidate => await candidate.inspectLocalRecovery())
    })
  }
  inspectRecoveryHistory(): Promise<
    Readonly<{ journals: number; originals: number; mappedIds: number; originalLogicalBytes: number; pages: number }>
  > {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateMergeHistory(this.#store, k, {
                admission,
                workingAllocation: this.#options.workingAllocation,
                maximumReadBytes: this.#options.maximumReadBytes,
                signal: this.#options.signal
              })
            }
          )
      )
      this.#check()
      return result
    })
  }
  inspectUserRows(): Promise<Readonly<{ rows: number; updated: boolean }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (
                receipt.state !== 'COMPLETE' ||
                receipt.nextRow !== admission.totalRows ||
                receipt.destinationSha256 !== brc38ImportDestinationDigest(actual)
              )
                invalid()
              await assertBrc38PrivateMergeProgramBudget(k, admission)
              return await inspectBrc38PrivateUserInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectScalarRows(): Promise<Readonly<{ rows: number; aliases: number }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateScalarInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      // Reopen the hidden current source/candidate state after the read scope;
      // no comparison survives a changed local revision as an activation grant.
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectSimpleFieldRows(): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateSimpleFieldInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                maximumReadBytes: this.#options.maximumReadBytes,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectTransactionRows(): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateTransactionInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                maximumReadBytes: this.#options.maximumReadBytes,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectOutputRows(): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateOutputInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                maximumReadBytes: this.#options.maximumReadBytes,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectProofRows(): Promise<Readonly<Brc38PrivateProofInventory>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (receipt.state !== 'COMPLETE' || receipt.destinationSha256 !== brc38ImportDestinationDigest(actual))
                invalid()
              return await inspectBrc38PrivateProofInventory(this.#store, this.#source, k, {
                admission,
                maximumRows: this.#options.maximumLocalRows,
                maximumReadBytes: this.#options.maximumReadBytes,
                workingAllocation: this.#options.workingAllocation,
                signal: this.#options.signal
              })
            }
          )
      )
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectCheckpointRows(): Promise<Readonly<{ rows: number; pages: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(async () => {
        const checkpoint = async (): Promise<void> =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (
                receipt.state !== 'COMPLETE' ||
                receipt.nextRow !== admission.totalRows ||
                receipt.destinationSha256 !== brc38ImportDestinationDigest(actual)
              )
                invalid()
              await assertBrc38PrivateMergeProgramBudget(k, admission)
            }
          )
        await checkpoint()
        const inventory = await inspectBrc38PrivateCheckpointInventory(this.#store, this.#storage, this.#source, {
          admission,
          maximumRows: this.#options.maximumLocalRows,
          maximumReadBytes: this.#options.maximumReadBytes,
          workingAllocation: this.#options.workingAllocation,
          receiptPolicy: this.#options.receiptPolicy,
          sourcePolicy: {
            ...this.#options.structuredResources.sourcePolicy,
            expiresAt: this.#store.operationExpiresAt,
            maximumCombinedTemporaryBytes: this.#options.structuredResources.maximumCombinedTemporaryBytes
          },
          signal: this.#options.signal
        })
        await checkpoint()
        return inventory
      })
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  inspectRequestRows(): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      const status = await this.#status(),
        admission = status.admission
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      await this.#available()
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(async () => {
        const checkpoint = async (): Promise<void> =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...this.#store.binding!.binding, mode: 'merge' },
            this.#options.receiptPolicy,
            async (k, actual) => {
              const receipt = await readBrc38ImportJournal(k, admission)
              if (
                receipt.state !== 'COMPLETE' ||
                receipt.nextRow !== admission.totalRows ||
                receipt.destinationSha256 !== brc38ImportDestinationDigest(actual)
              )
                invalid()
              await assertBrc38PrivateMergeProgramBudget(k, admission)
            }
          )
        await checkpoint()
        // Reconstruction performs short source reads and derived-only writes;
        // no import read transaction survives into a comparison producer.
        const inventory = await inspectBrc38PrivateRequestInventory(this.#store, this.#storage, this.#source, {
          admission,
          maximumRows: this.#options.maximumLocalRows,
          maximumReadBytes: this.#options.maximumReadBytes,
          workingAllocation: this.#options.workingAllocation,
          receiptPolicy: this.#options.receiptPolicy,
          sourcePolicy: {
            ...this.#options.structuredResources.sourcePolicy,
            expiresAt: this.#store.operationExpiresAt,
            maximumCombinedTemporaryBytes: this.#options.structuredResources.maximumCombinedTemporaryBytes
          },
          projectionPolicy: this.#requestProjection,
          signal: this.#options.signal
        })
        await checkpoint()
        return inventory
      })
      const after = await this.#status()
      if (
        after.sourceChanged ||
        after.phase !== 'IMPORT' ||
        after.admission?.scope.importId !== admission.scope.importId
      )
        invalid()
      this.#check()
      return result
    })
  }
  /** Complete all47-table postimages plus current/historical import custody.
   * One actual monotone clock and complete generation span every partition.
   * Query-only readers drain before request/checkpoint reconstruction writes.
   * Return values are statistics DATA; a publication/cutover must independently
   * retain fresh current source/primary ownership and run its own actual checks. */
  inspectComposedRows(): Promise<
    Readonly<{
      rows: number
      logicalBytes: string
      sourceRevision: string
      episode: number
      importId: string
      pages: number
      journals: number
    }>
  > {
    return this.#io.run(async () => await this.#inspectComposedRows(false))
  }
  /** Publication comparison closes semantic mutation admission in the actual
   * private kernel FIRST. A source change/failure requires physical close and
   * explicit original-reservation resume before any further importing step.
   * This statistics result remains DATA and cannot authorize a later copy. */
  inspectComposedRowsForPublication(): ReturnType<Brc38PrivateNativeMergeNode['inspectComposedRows']> {
    return this.#io.run(async () => await this.#inspectComposedRows(true))
  }
  /** Reconstruct the ENTIRE original composition after retirement, using a
   * genuine historical source and the independently authenticated original
   * private candidate. The supplied receipt only identifies expected DATA;
   * it supplies neither source membership nor target activation permission. */
  inspectComposedRowsForRetiredRecovery(
    selected: Brc38ComposedProfileReceipt
  ): ReturnType<Brc38PrivateNativeMergeNode['inspectComposedRows']> {
    const receipt = copyBrc38ComposedProfileReceipt(selected)
    return this.#io.run(async () => await this.#inspectComposedRows(true, receipt))
  }
  /** One actual reconstruction and complete typed image read, retained through
   * the consumer's independent copied-target inspection. Prior statistics or
   * matching image DATA cannot substitute for this factory operation. */
  withRetiredRecoveryImage<T>(
    selected: Brc38ComposedProfileReceipt,
    inspect: (
      image: Readonly<Brc38ComposedDatabaseImage>,
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.#withCompositionImage(selected, inspect, 'retired')
  }
  /** The live-source counterpart performs its complete comparison afresh.
   * This is a read/inspection scope; the final forward retirement controller
   * still needs its separate source writer and manager admission. */
  withCurrentCompositionImage<T>(
    selected: Brc38ComposedProfileReceipt,
    inspect: (
      image: Readonly<Brc38ComposedDatabaseImage>,
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.#withCompositionImage(selected, inspect, 'current')
  }
  static inspectCurrentCompositionImage<T>(
    merge: Brc38PrivateNativeMergeNode,
    selected: Brc38ComposedProfileReceipt,
    inspect: (
      image: Readonly<Brc38ComposedDatabaseImage>,
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void
    ) => Promise<T>
  ): Promise<T> {
    if (!actualMerges.has(merge)) invalid()
    return merge.#withCompositionImage(selected, inspect, 'current')
  }
  static inspectRetiredRecoveryImage<T>(
    merge: Brc38PrivateNativeMergeNode,
    selected: Brc38ComposedProfileReceipt,
    inspect: (
      image: Readonly<Brc38ComposedDatabaseImage>,
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void
    ) => Promise<T>
  ): Promise<T> {
    if (!actualMerges.has(merge)) invalid()
    return merge.#withCompositionImage(selected, inspect, 'retired')
  }
  #withCompositionImage<T>(
    selected: Brc38ComposedProfileReceipt,
    inspect: (
      image: Readonly<Brc38ComposedDatabaseImage>,
      receipt: Readonly<Brc38ComposedProfileReceipt>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void
    ) => Promise<T>,
    mode: 'current' | 'retired'
  ): Promise<T> {
    const receipt = copyBrc38ComposedProfileReceipt(selected),
      consumer = inspect
    if (typeof consumer !== 'function') invalid()
    return this.#io.run(async () => {
      this.#check()
      if (this.#compositionImageReceipt !== undefined || this.#copyTarget !== undefined) invalid()
      const charge = this.#options.workingAllocation.claim(1048576),
        policy = Object.freeze({
          maximumPhysicalBytes: this.#store.limits.maximumPhysicalBytes,
          maximumReadBytes: this.#options.maximumReadBytes,
          expiresAt: this.#store.operationExpiresAt,
          workingAllocation: this.#options.workingAllocation,
          signal: this.#options.signal
        })
      try {
        const checkSource = async (): Promise<string> => {
          if (mode === 'retired') return await this.#comparisonSource(receipt)
          const origin = await Brc38NativeLocalBaselineSource.compositionOrigin(this.#source)
          if (JSON.stringify(origin) !== JSON.stringify(receipt.source)) invalid()
          return JSON.stringify({ origin, current: await this.#comparisonSource() })
        }
        const sourceBefore = await checkSource()
        const status = await this.#status()
        if (
          status.phase !== 'IMPORT' ||
          status.sourceChanged ||
          status.receipt?.state !== 'COMPLETE' ||
          status.admission === undefined
        )
          invalid()
        // Reopening the original reservation creates a fresh native process.
        // Its irreversible comparison phase must be entered again through the
        // actual idle owner; a persisted receipt cannot establish kernel state.
        await this.#store.beginPrivateNativeComparison()
        await this.#store.requirePrivateNativeComparison()
        const image = await this.#store.withAuthenticatedPrivateStructuredDestination(
          async () =>
            await this.#store.withPrivateNativeDatabase(
              true,
              async database =>
                await database.transaction(async read => {
                  this.#store.assertPrivateNativeReadTransaction(read)
                  return await readBrc38ComposedDatabaseImage(read, policy, () => {
                    this.#check()
                    this.#store.assertPrivateNativeReadTransaction(read)
                  })
                })
            )
        )
        if (JSON.stringify(image) !== JSON.stringify(receipt.image)) invalid()
        // Match the exact copied image before fresh reconstruction/collection
        // advances its legitimate scratch scheduling state. The kernel already
        // freezes semantic mutations; complete row/custody comparisons still
        // run here, and the receiving owner independently reads its full image.
        let copiedPreview: Readonly<Brc38PrivateImportPreview> | undefined
        if (this.#store.recoveryComparisonOnly) {
          if (mode !== 'retired') invalid()
          // Only this actual frozen copy, after full original image equality,
          // can translate the original journal's physical destination address.
          // The freshly admitted scratch backend is still checked on each read.
          copiedPreview = await readBrc38PrivateImportPreview(this.#store)
        }
        await this.#inspectComposedRows(true, mode === 'retired' ? receipt : undefined, copiedPreview)
        if ((await checkSource()) !== sourceBefore) invalid()
        this.#compositionImageReceipt = receipt
        this.#compositionImageMode = mode
        const assertRetained = (): void => {
          if (this.#compositionImageReceipt !== receipt || this.#compositionImageMode !== mode) invalid()
          this.#check()
        }
        assertRetained()
        const value = await consumer(image, receipt, policy, assertRetained)
        assertRetained()
        await this.#store.requirePrivateNativeComparison()
        const forward = this.#forwardRetirementImage
        if (forward === undefined) {
          if ((await checkSource()) !== sourceBefore) invalid()
        } else {
          if (mode !== 'current') invalid()
          const fresh = await Brc38NativeLocalBaselineSource.forwardCompositionOrigin(
            this.#source,
            forward.manager,
            forward.transition
          )
          if (
            JSON.stringify(fresh.source) !== JSON.stringify(receipt.source) ||
            fresh.retirement.decisionId !== receipt.decisionId ||
            JSON.stringify(fresh.retirement) !== JSON.stringify(forward.retirement)
          )
            invalid()
        }
        assertRetained()
        return value
      } finally {
        this.#compositionImageReceipt = undefined
        this.#compositionImageMode = undefined
        this.#forwardRetirementImage = undefined
        charge.close()
      }
    })
  }
  static assertRetiredRecoveryImageScope(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    receipt: Readonly<Brc38ComposedProfileReceipt>
  ): void {
    if (
      !actualMerges.has(merge) ||
      merge.#store !== store ||
      merge.#source !== source ||
      merge.#compositionImageReceipt !== receipt ||
      merge.#compositionImageMode !== 'retired'
    )
      invalid()
    merge.#check()
  }
  static assertCurrentCompositionImageScope(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    receipt: Readonly<Brc38ComposedProfileReceipt>
  ): void {
    if (
      !actualMerges.has(merge) ||
      merge.#store !== store ||
      merge.#source !== source ||
      merge.#compositionImageReceipt !== receipt ||
      merge.#compositionImageMode !== 'current'
    )
      invalid()
    merge.#check()
  }
  /** Switch only this retained comparison's exit check to a freshly read
   * durable source decision. The original physical source and actual manager
   * transition remain owned; no current:true flag or saved report enters. */
  static async retainForwardRetirementImage(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    receipt: Readonly<Brc38ComposedProfileReceipt>,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition
  ): Promise<void> {
    Brc38PrivateNativeMergeNode.assertCurrentCompositionImageScope(merge, store, source, receipt)
    const actual = await Brc38NativeLocalBaselineSource.forwardCompositionOrigin(source, manager, transition)
    if (
      JSON.stringify(actual.source) !== JSON.stringify(receipt.source) ||
      actual.retirement.decisionId !== receipt.decisionId ||
      merge.#forwardRetirementImage !== undefined
    )
      invalid()
    Brc38PrivateNativeMergeNode.assertCurrentCompositionImageScope(merge, store, source, receipt)
    merge.#forwardRetirementImage = Object.freeze({ manager, transition, retirement: actual.retirement })
  }
  async #comparisonSource(retired?: Readonly<Brc38ComposedProfileReceipt>): Promise<string> {
    if (retired !== undefined) {
      const actual = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(this.#source)
      if (
        JSON.stringify(actual.source) !== JSON.stringify(retired.source) ||
        actual.retirement.decisionId !== retired.decisionId
      )
        invalid()
      return JSON.stringify(actual)
    }
    const actual = await Brc38NativeLocalBaselineSource.inspectCurrent(this.#source)
    if (!actual.current) throw new Brc38PrivateCompositionRequiredError(actual.generation.revision)
    return JSON.stringify({ fence: actual.fence, generation: actual.generation })
  }
  async #inspectComposedRows(
    freeze: boolean,
    retired?: Readonly<Brc38ComposedProfileReceipt>,
    copiedPreview?: Readonly<Brc38PrivateImportPreview>
  ): ReturnType<Brc38PrivateNativeMergeNode['inspectComposedRows']> {
    this.#check()
    if (this.#store.recoveryComparisonOnly !== (copiedPreview !== undefined)) invalid()
    const status = await this.#status(),
      admission = status.admission,
      working = this.#options.workingAllocation,
      options = this.#options,
      binding = this.#store.binding!,
      frame = working.claim(4194304)
    try {
      if (
        status.phase !== 'IMPORT' ||
        status.sourceChanged ||
        status.receipt?.state !== 'COMPLETE' ||
        admission === undefined
      )
        invalid()
      const completedSequence = status.receipt.sequence
      const sourceBefore = await this.#comparisonSource(retired)
      if (freeze) await this.#store.beginPrivateNativeComparison()
      await this.#available()
      let originalClock: string | undefined,
        rows = 0,
        logicalBytes = 0n
      const selected = {
          admission,
          maximumRows: options.maximumLocalRows,
          maximumReadBytes: options.maximumReadBytes,
          workingAllocation: working,
          signal: options.signal
        },
        sourcePolicy = {
          ...options.structuredResources.sourcePolicy,
          expiresAt: this.#store.operationExpiresAt,
          maximumCombinedTemporaryBytes: options.structuredResources.maximumCombinedTemporaryBytes
        },
        count = (value: Readonly<{ rows: number; logicalBytes?: string }>): void => {
          if (!Number.isSafeInteger(value.rows) || value.rows < 0 || value.rows > options.maximumLocalRows - rows)
            invalid()
          rows += value.rows
          if (value.logicalBytes !== undefined) {
            if (!/^(0|[1-9][0-9]{0,20})$/.test(value.logicalBytes)) invalid()
            logicalBytes += BigInt(value.logicalBytes)
          }
        },
        clock = async (k: import('knex').Knex.Transaction): Promise<void> => {
          this.#check()
          await verifyBrc38AuthenticatedSourceSeal(k)
          const receipt = await readBrc38ImportJournal(k, admission, working),
            generation = await readSnapshotJournalSqliteGeneration(k, options.receiptPolicy),
            values = (await k('snapshot_journal_clock')
              .where({ id: 1 })
              .select(
                'enabled',
                'reason',
                k.raw(
                  "CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"
                ),
                k.raw(
                  "CASE WHEN typeof(ceiling)='integer' AND ceiling>=revision THEN CAST(ceiling AS TEXT) END AS ceiling"
                )
              )
              .limit(2)) as Array<{ enabled: number; reason: unknown; revision: unknown; ceiling: unknown }>
          if (
            receipt.state !== 'COMPLETE' ||
            receipt.nextRow !== admission.totalRows ||
            !generation.complete ||
            !generation.enabled ||
            values.length !== 1 ||
            values[0].enabled !== 1 ||
            values[0].reason !== null
          )
            invalid()
          const actual = JSON.stringify({
            receipt,
            generation,
            revision: snapshotJournalRevision(values[0].revision),
            ceiling: snapshotJournalRevision(values[0].ceiling)
          })
          if (originalClock !== undefined && actual !== originalClock) invalid()
          originalClock = actual
          this.#check()
        },
        read = async <T>(operation: (k: import('knex').Knex.Transaction) => Promise<T>): Promise<T> =>
          await withBrc38KnexImportReadDestination(
            this.#storage,
            { ...binding.binding, mode: 'merge' },
            options.receiptPolicy,
            async (k, actual) => {
              await clock(k)
              const receipt = await readBrc38ImportJournal(k, admission, working)
              const destinationSha256 =
                copiedPreview === undefined
                  ? brc38ImportDestinationDigest(actual)
                  : brc38CopiedImportDestinationDigest(actual, copiedPreview, admission)
              if (receipt.destinationSha256 !== destinationSha256) invalid()
              await assertBrc38PrivateMergeProgramBudget(k, admission)
              const value = await operation(k)
              await clock(k)
              await assertBrc38PrivateMergeProgramBudget(k, admission)
              return value
            }
          )
      const result = await this.#store.withAuthenticatedPrivateStructuredDestination(async () => {
        const history = await read(
          async k =>
            await inspectBrc38PrivateMergeHistory(this.#store, k, {
              admission,
              workingAllocation: working,
              maximumReadBytes: options.maximumReadBytes,
              signal: options.signal
            })
        )
        count(await read(async k => await inspectBrc38PrivateUserInventory(this.#store, this.#source, k, selected)))
        count(await read(async k => await inspectBrc38PrivateProofInventory(this.#store, this.#source, k, selected)))
        count(await read(async k => await inspectBrc38PrivateScalarInventory(this.#store, this.#source, k, selected)))
        count(
          await read(async k => await inspectBrc38PrivateSimpleFieldInventory(this.#store, this.#source, k, selected))
        )
        count(
          await read(async k => await inspectBrc38PrivateTransactionInventory(this.#store, this.#source, k, selected))
        )
        count(await read(async k => await inspectBrc38PrivateOutputInventory(this.#store, this.#source, k, selected)))
        count(
          await read(
            async k =>
              await inspectBrc38PrivateLocalRecovery(this.#store, this.#source, k, {
                maximumRows: options.maximumLocalRows,
                maximumReadBytes: options.maximumReadBytes,
                workingAllocation: working,
                expiresAt: this.#store.operationExpiresAt,
                signal: options.signal
              })
          )
        )
        await read(() => promiseFromSync(() => undefined))
        count(
          await inspectBrc38PrivateRequestInventory(this.#store, this.#storage, this.#source, {
            ...selected,
            receiptPolicy: options.receiptPolicy,
            sourcePolicy,
            projectionPolicy: this.#requestProjection
          })
        )
        await read(() => promiseFromSync(() => undefined))
        const checkpoint = await inspectBrc38PrivateCheckpointInventory(this.#store, this.#storage, this.#source, {
          ...selected,
          receiptPolicy: options.receiptPolicy,
          sourcePolicy
        })
        count(checkpoint)
        await read(() => promiseFromSync(() => undefined))
        // Both reconstruction lifetime scopes have drained. Retire only
        // actual queued unreferenced content; current row pointers and any
        // other actual owner holds remain protected by the shared collector.
        // No semantic reader survives into these short cleanup writers.
        for (let page = 0n; ; page++) {
          this.#check()
          if (page > BigInt(this.#store.limits.maximumLogicalBytes) / 512n) invalid()
          const collected = await this.#store.withPrivateNativeDatabase(
            false,
            async database =>
              await database.transaction(async k => {
                this.#store.assertPrivateNativeWriteTransaction(k)
                await clock(k)
                await assertBrc38PrivateMergeProgramBudget(k, admission)
                const reserved = async (): Promise<number> => {
                    const values = (await k('brc38_native_binary_budget')
                      .where({ slot: 1 })
                      .select('reservedBytes')
                      .limit(2)) as Array<{ reservedBytes: unknown }>
                    const value = values[0]?.reservedBytes
                    if (
                      values.length !== 1 ||
                      typeof value !== 'number' ||
                      !Number.isSafeInteger(value) ||
                      value < 0 ||
                      value > this.#store.limits.maximumLogicalBytes
                    )
                      invalid()
                    return value
                  },
                  before = await reserved(),
                  result = await collectBrc38NativePackedContent(k, 32, options.signal),
                  after = await reserved()
                if (after > before || (!result.complete && after >= before)) invalid()
                await clock(k)
                await assertBrc38PrivateMergeProgramBudget(k, admission)
                this.#store.assertPrivateNativeWriteTransaction(k)
                return result
              })
          )
          if (collected.complete) break
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
        await read(() => promiseFromSync(() => undefined))
        // Historical original/page records are independently read again after
        // all derived writers; neither a prior history result nor clock DATA
        // serves as membership/semantic authority for this final operation.
        const finalHistory = await read(
          async k =>
            await inspectBrc38PrivateMergeHistory(this.#store, k, {
              admission,
              workingAllocation: working,
              maximumReadBytes: options.maximumReadBytes,
              signal: options.signal
            })
        )
        if (
          JSON.stringify(finalHistory) !== JSON.stringify(history) ||
          checkpoint.pages !== completedSequence ||
          finalHistory.pages < checkpoint.pages
        )
          invalid()
        return Object.freeze({ pages: checkpoint.pages, journals: finalHistory.journals })
      })
      const after = await this.#status()
      if (
        after.phase !== 'IMPORT' ||
        after.sourceChanged ||
        after.episode !== status.episode ||
        after.caughtUpRevision !== status.caughtUpRevision ||
        after.admission?.scope.importId !== admission.scope.importId ||
        JSON.stringify(after.receipt) !== JSON.stringify(status.receipt)
      )
        invalid()
      if ((await this.#comparisonSource(retired)) !== sourceBefore) invalid()
      await this.#store.withAuthenticatedPrivateStructuredDestination(
        async () => await read(() => promiseFromSync(() => undefined))
      )
      if (freeze) await this.#store.requirePrivateNativeComparison()
      this.#check()
      return Object.freeze({
        rows,
        logicalBytes: logicalBytes.toString(),
        sourceRevision: status.sourceRevision,
        episode: status.episode,
        importId: admission.scope.importId,
        ...result
      })
    } finally {
      frame.close()
    }
  }
  /** ONE original merge actor freshly runs the full frozen comparison, then
   * closes its actual SQL facades and copies while the original private kernel
   * still owns the file. No prior statistics or caller verdict may enter.
   * The target remains unqualified RECEIVING bytes, never a selected provider. */
  copyComposedDatabase(
    targetName: string,
    maximumBytes: number
  ): Promise<Readonly<{ bytes: number; sha256: string; image: Readonly<Brc38ComposedDatabaseImage> }>> {
    return this.#copyComposedDatabase(targetName, maximumBytes, copy => promiseFromSync(() => copy))
  }
  /** An independent receiving inspection stays inside the same original merge
   * operation and lifetime. Only the physical SQL facades drain for copying;
   * the actual source and private kernel continue owning the operation. */
  static receivingSignal(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    selected?: AbortSignal
  ): AbortSignal | undefined {
    if (
      !actualMerges.has(merge) ||
      merge.#store !== store ||
      (selected !== undefined && selected !== merge.#options.signal)
    )
      invalid()
    merge.#check()
    return merge.#options.signal
  }
  static async withReceivingCopy<T>(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    selectedAdmission: Brc38ImportJournalAdmission,
    target: string,
    maximumBytes: number,
    inspect: (
      copy: Readonly<{ bytes: number; sha256: string; image: Readonly<Brc38ComposedDatabaseImage> }>,
      policy: Readonly<Brc38ComposedDatabaseImagePolicy>,
      assertRetained: () => void,
      origin: Awaited<ReturnType<typeof Brc38NativeLocalBaselineSource.compositionOrigin>>
    ) => Promise<T>
  ): Promise<T> {
    if (!actualMerges.has(merge) || merge.#store !== store) invalid()
    merge.#check()
    // Copy drains the SQL facade. Retain its original clock value; the
    // receiving callback still checks the actual physical owner afresh.
    const admission = admissionCopy(selectedAdmission),
      operationExpiresAt = store.operationExpiresAt
    return await merge.#copyComposedDatabase(
      target,
      maximumBytes,
      async copy => {
        const origin = await Brc38NativeLocalBaselineSource.compositionOrigin(merge.#source)
        const assertRetained = (): void => {
            if (
              !actualMerges.has(merge) ||
              !merge.#live ||
              merge.#copyTarget !== target ||
              Date.now() >= operationExpiresAt ||
              performance.now() >= merge.#deadline
            )
              invalid()
            merge.#options.signal?.throwIfAborted()
            Brc38NativeLocalBaselineSource.assertSharedWorking(merge.#source, merge.#options.workingAllocation)
            store.assertRetainedPrivateNativeCopyOwner()
          },
          policy = Object.freeze({
            maximumPhysicalBytes: store.limits.maximumPhysicalBytes,
            maximumReadBytes: merge.#options.maximumReadBytes,
            expiresAt: operationExpiresAt,
            workingAllocation: merge.#options.workingAllocation,
            signal: merge.#options.signal
          })
        assertRetained()
        const value = await inspect(copy, policy, assertRetained, origin)
        assertRetained()
        return value
      },
      admission
    )
  }
  #copyComposedDatabase<T>(
    targetName: string,
    maximumBytes: number,
    inspect: (
      copy: Readonly<{ bytes: number; sha256: string; image: Readonly<Brc38ComposedDatabaseImage> }>
    ) => Promise<T>,
    expectedAdmission?: Readonly<Brc38ImportJournalAdmission>
  ): Promise<T> {
    const target = targetName,
      maximum = maximumBytes
    if (
      typeof target !== 'string' ||
      !target.startsWith('/') ||
      target.length > 4096 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 4096 ||
      maximum > this.#store.limits.maximumPhysicalBytes
    )
      invalid()
    return this.#io.run(async () => {
      this.#check()
      if (this.#copyTarget !== undefined) invalid()
      const charge = this.#options.workingAllocation.claim(1048576)
      try {
        await this.#inspectComposedRows(true)
        this.#check()
        if (
          expectedAdmission !== undefined &&
          JSON.stringify((await this.#status()).admission) !== JSON.stringify(expectedAdmission)
        )
          invalid()
        await this.#store.requirePrivateNativeComparison()
        const image = await this.#store.withAuthenticatedPrivateStructuredDestination(
          async () =>
            await this.#store.withPrivateNativeDatabase(
              true,
              async database =>
                await database.transaction(
                  async k =>
                    await readBrc38ComposedDatabaseImage(
                      k,
                      {
                        maximumPhysicalBytes: this.#store.limits.maximumPhysicalBytes,
                        maximumReadBytes: this.#options.maximumReadBytes,
                        expiresAt: this.#store.operationExpiresAt,
                        workingAllocation: this.#options.workingAllocation,
                        signal: this.#options.signal
                      },
                      () => {
                        this.#check()
                        this.#store.assertPrivateNativeReadTransaction(k)
                      }
                    )
                )
            )
        )
        await this.#store.requirePrivateNativeComparison()
        this.#check()
        this.#copyTarget = target
        const copy = await this.#store.copyComparedNativeMerge(
          target,
          maximum,
          this,
          this.#source,
          this.#options.signal
        )
        return await inspect(Object.freeze({ ...copy, image }))
      } finally {
        this.#copyTarget = undefined
        charge.close()
      }
    })
  }
  /** Actual current actor/copy-target membership only. The copy path calls this
   * afresh before closing the original store; hashes/reports cannot enroll it. */
  static assertCopyScope(
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    target: string,
    signal?: AbortSignal
  ): void {
    if (
      !actualMerges.has(merge) ||
      merge.#store !== store ||
      merge.#source !== source ||
      merge.#copyTarget !== target ||
      signal !== merge.#options.signal
    )
      invalid()
    merge.#check()
    Brc38NativeLocalBaselineSource.assertOwned(source)
  }
  static async with<T>(
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38PrivateNativeMergeOptions,
    work: (merge: Brc38PrivateNativeMergeNode) => Promise<T>
  ): Promise<T> {
    Brc38NativeLocalBaselineSource.assertOwned(source)
    store.assertRecoverySharedWorking(selected.workingAllocation)
    Brc38NativeLocalBaselineSource.assertSharedWorking(source, selected.workingAllocation)
    store.assertPrivateNativeDestination(store.knex)
    if (store.binding === undefined) invalid()
    const resources = brc38StructuredRestoreResources(
        store.limits,
        selected.structuredResources,
        selected.maximumStepBytes,
        store.directory
      ),
      options = Object.freeze({
        receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.receiptPolicy) }),
        maximumStepRows: selected.maximumStepRows,
        maximumStepBytes: selected.maximumStepBytes,
        maximumMappedIds: selected.maximumMappedIds,
        maximumJournalLogicalBytes: selected.maximumJournalLogicalBytes,
        maximumLocalRows: selected.maximumLocalRows,
        maximumReadBytes: selected.maximumReadBytes,
        workingAllocation: selected.workingAllocation,
        services: selected.services,
        signal: selected.signal,
        structuredResources: resources
      })
    if (
      resources.sourcePolicy.workingAllocation !== options.workingAllocation ||
      resources.projectionPolicy.workingAllocation !== options.workingAllocation ||
      resources.sourcePolicy.signal !== options.signal ||
      resources.projectionPolicy.signal !== options.signal
    )
      invalid()
    // Request merge uses six projection index banks plus the two original/
    // current source allowances. Derive its fields from the ORIGINAL resource
    // packet; never reinterpret sync-map field names or increase any quota.
    const requestProjection = Object.freeze({
      maximumTemporaryIndexBytes: resources.projectionPolicy.maximumTemporaryFileBytes,
      maximumMembers: resources.projectionPolicy.maximumMembers,
      maximumOutputBytes: resources.projectionPolicy.maximumOutputBytes,
      maximumIndexAllocationBytes: resources.projectionPolicy.maximumIndexAllocationBytes,
      maximumGrammarAllocationBytes: resources.projectionPolicy.maximumGrammarAllocationBytes,
      maximumReadBytes: Math.min(
        resources.sourcePolicy.maximumReadBytes ?? 65536,
        resources.projectionPolicy.maximumReadBytes ?? 65536
      ),
      workingAllocation: options.workingAllocation,
      expiresAt: store.limits.expiresAt,
      signal: options.signal
    })
    if (
      requestProjection.maximumTemporaryIndexBytes < 6291456 ||
      resources.sourcePolicy.maximumTemporaryIndexBytes < 2097152 ||
      requestProjection.maximumMembers > resources.sourcePolicy.maximumIndexMembers ||
      2 * resources.sourcePolicy.maximumTemporaryIndexBytes + requestProjection.maximumTemporaryIndexBytes >
        resources.maximumCombinedTemporaryBytes
    )
      invalid()
    const policyJson = JSON.stringify({
      protocol: 'brc38-private-native-merge/v1',
      maximumRebuilds: 3,
      receiptPolicy: options.receiptPolicy,
      maximumStepRows: options.maximumStepRows,
      maximumStepBytes: options.maximumStepBytes,
      maximumMappedIds: options.maximumMappedIds,
      maximumJournalLogicalBytes: options.maximumJournalLogicalBytes,
      maximumLocalRows: options.maximumLocalRows,
      maximumReadBytes: options.maximumReadBytes,
      workingBytes: options.workingAllocation.maximum,
      sourcePolicy: { ...resources.sourcePolicy, workingAllocation: undefined, signal: undefined },
      projectionPolicy: { ...resources.projectionPolicy, workingAllocation: undefined, signal: undefined },
      requestProjectionPolicy: { ...requestProjection, workingAllocation: undefined, signal: undefined },
      maximumCombinedTemporaryBytes: resources.maximumCombinedTemporaryBytes
    })
    if (Buffer.byteLength(policyJson) > 4096) invalid()
    // Preserve policyJson with ORIGINAL expiry as immutable program DATA.
    // Only derived comparison operations use the genuine store's new lifetime.
    const runtimeOptions = store.recoveryComparisonOnly
        ? Object.freeze({
            ...options,
            structuredResources: Object.freeze({
              ...resources,
              projectionPolicy: Object.freeze({ ...resources.projectionPolicy, expiresAt: store.operationExpiresAt })
            })
          })
        : options,
      runtimeRequest = store.recoveryComparisonOnly
        ? Object.freeze({ ...requestProjection, expiresAt: store.operationExpiresAt })
        : requestProjection,
      merge = new Brc38PrivateNativeMergeNode(issuer, store, source, runtimeOptions, policyJson, runtimeRequest)
    Object.freeze(merge)
    try {
      return await merge.#io.retain(async () => await work(merge))
    } finally {
      merge.#live = false
    }
  }
}
