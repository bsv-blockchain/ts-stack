import {
  hasBrc38NativeIncomingIdReservationSchema,
  brc38NativeIncomingIdReservations
} from './Brc38NativeIncomingIdReservationSchemaNode'
import { brc38NativeIncomingIdTables } from './Brc38NativeIncomingIdReservationNode'
import { brc38PrivatePageIdForms } from './Brc38PrivatePageIdsNode'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { realpath, lstat } from 'node:fs/promises'
import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import type { Brc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import type { Brc38NativeRetirementRecord } from './Brc38NativeRetirementNode'
import {
  bindSnapshotJournalDestinationBackend,
  type SnapshotJournalCaptureBackend
} from '../snapshot/journal/SnapshotJournalCaptureBackend'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import { readBrc38NativePackedTextDescriptor, readBrc38NativePackedTextExtent } from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { WalletStorageManager, WalletStorageProviderTransition } from '../WalletStorageManager'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import {
  brc38DestinationSelection,
  withBrc38KnexImportReadDestination,
  readBrc38KnexRetainedSourceFence,
  type Brc38DestinationSelection,
  type Brc38KnexDestinationFence
} from './Brc38KnexDestinationFence'
import { requireBrc38NativeProfileTransaction, Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { readBrc38NativeTextBytes, readBrc38NativeTextExtent } from './Brc38NativeTextReadNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'
import { readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'
import { readBrc38NativeLocalFieldBytes, withBrc38NativeLocalFieldExtent } from './Brc38NativeLocalFieldReadNode'
import type { Brc38NativeBlobRead, Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import type { Brc38NativeLocalFieldCoordinate } from './Brc38NativeLocalFieldProtocol'
import {
  brc38NativeLocalBaselineTables,
  brc38NativeLocalBaselineTableCount as tableCount,
  type Brc38NativeLocalBaselineTable
} from './Brc38NativeLocalBaselineTables'
import {
  readBrc38NativeLocalBaselineGeneration,
  readBrc38NativeLocalBaselineGenerationData,
  readBrc38NativeLocalBaselineChanges,
  readBrc38NativeLocalBaselineTombstones,
  readBrc38NativeLocalBaselinePhysical,
  type Brc38NativeLocalBaselineGeneration,
  type Brc38NativeLocalBaselineChange
} from './Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  SNAPSHOT_JOURNAL_SHARED_QUOTA,
  verifySnapshotJournalSharedQuota
} from '../snapshot/journal/SnapshotJournalSharedQuota'
import { verifySnapshotJournalDestinationSchema } from '../snapshot/journal/SnapshotJournalDestinationSchema'
import {
  brc38NativePriorImportTables,
  brc38NativePriorImportPayload,
  type Brc38NativePriorImportTable
} from './Brc38NativePriorImportTables'
import {
  brc38PrivatePriorImportRows,
  brc38PrivatePriorImportChunks,
  brc38PrivatePriorImportBudget,
  hasBrc38PrivatePriorImportSchema
} from './Brc38PrivatePriorImportSchemaNode'
import { inspectBrc38NativePriorImportFamily } from './Brc38NativePriorImportSchemaNode'
export { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'

type Field = Readonly<{
  field: string
  kind: 'blob' | 'text'
  binary?: Brc38NativeBlobRead['table']
  text?: Brc38NativeTextRead['table']
  local?: Brc38NativeLocalFieldCoordinate['table']
}>
const binarySources: Readonly<
  Record<string, Readonly<{ table: Brc38NativeBlobRead['table']; fields: readonly string[] }>>
> = Object.freeze({
  transactions: { table: 'transactions', fields: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'] },
  proven_txs: { table: 'provenTxs', fields: ['rawTx', 'merklePath'] },
  proven_tx_reqs: { table: 'provenTxReqs', fields: ['rawTx', 'inputBEEF'] },
  outputs: { table: 'outputs', fields: ['lockingScript'] },
  commissions: { table: 'commissions', fields: ['lockingScript'] }
})
const localSources: Readonly<Record<string, Readonly<{ kind: 'blob' | 'text'; fields: readonly string[] }>>> =
  Object.freeze({
    prepared_beefs: { kind: 'blob', fields: ['beef'] },
    action_batch_blobs: { kind: 'blob', fields: ['bytes'] },
    sync_transfer_parts: { kind: 'blob', fields: ['bytes'] },
    action_batches: { kind: 'text', fields: ['uploadDigests', 'result', 'manifest'] },
    sync_transfers: { kind: 'text', fields: ['result'] },
    monitor_events: { kind: 'text', fields: ['details'] },
    snapshot_reconciliation_stage_pages: { kind: 'blob', fields: ['payload'] },
    snapshot_reconciliation_provenance: { kind: 'blob', fields: ['payload'] }
  })
function fields(table: Brc38NativeLocalBaselineTable): readonly Field[] {
  const binary = binarySources[table],
    text = nativePackedTextSources.find(source => source.sql === table),
    local = localSources[table]
  return Object.freeze([
    ...(binary?.fields.map(field => Object.freeze({ field, kind: 'blob' as const, binary: binary.table })) ?? []),
    ...(text?.fields.map(field => Object.freeze({ field, kind: 'text' as const, text: text.table })) ?? []),
    ...(local?.fields.map(field =>
      Object.freeze({ field, kind: local.kind, local: table as Brc38NativeLocalFieldCoordinate['table'] })
    ) ?? [])
  ])
}
export interface Brc38NativeLocalBaselinePolicy {
  readonly workingAllocation: Brc38WorkingAllocation
  readonly maximumMetadataBytes: number
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
export interface Brc38NativeLocalBaselineField {
  readonly field: string
  readonly kind: 'blob' | 'text'
  readonly bytes: number | null
}
/** Complete row metadata and separate logical field lengths. It is deliberately
 * not a WalletStorageProvider DTO, BRC-38 row or field-read authority object. */
export interface Brc38NativeLocalBaselineRow {
  readonly table: Brc38NativeLocalBaselineTable
  readonly rowId: number
  readonly revision: SnapshotJournalRevision
  readonly generation: SnapshotJournalRevision
  readonly metadata: Readonly<Record<string, unknown>>
  readonly fields: readonly Readonly<Brc38NativeLocalBaselineField>[]
  withFieldExtent<T>(field: string, offset: number, length: number, work: (bytes: Uint8Array) => Promise<T>): Promise<T>
}
export interface Brc38NativePriorImportRow {
  readonly table: Brc38NativePriorImportTable
  readonly rowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly field: Readonly<{ field: 'originalJson' | 'payload'; kind: 'text' | 'blob'; bytes: number }> | undefined
  withFieldExtent<T>(offset: number, length: number, work: (bytes: Uint8Array) => Promise<T>): Promise<T>
}
export interface Brc38NativeRetainedPriorImportRow {
  readonly copyRowId: number
  readonly sourceLineageSha256: string
  readonly tableId: number
  readonly sourceRowId: number
  readonly metadataJson: string
  readonly metadataSha256: string
  readonly field: Readonly<{ kind: 'text' | 'blob'; bytes: number; sha256: string }> | undefined
  withFieldExtent<T>(offset: number, length: number, work: (bytes: Uint8Array) => Promise<T>): Promise<T>
}
const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Coherent local baseline source differs from its actual native view')
}
/** Actual scoped coherent source. The factory retains one query-only native
 * snapshot across every selected operational table, including pending actions
 * and auxiliary fields. It never copies rows, mutates the source or publishes
 * a candidate. Cleanup drains actual pending row/field work before the read
 * transaction and physical slot3 facade can close. */
export class Brc38NativeLocalBaselineSource {
  readonly #io = new Brc38OwnedImportReads()
  #live = true
  readonly #deadline: number
  readonly #trx: Knex.Transaction
  readonly #current?: Readonly<{
    storage: StorageKnex
    root: Knex
    receiptPolicy: Readonly<SnapshotJournalReceiptPolicy>
  }>
  readonly #retired?: Brc38RetiredNativeReadNode
  readonly #policy: Readonly<Brc38NativeLocalBaselinePolicy>
  readonly #fence: Readonly<Brc38KnexDestinationFence>
  readonly #generation: Readonly<Brc38NativeLocalBaselineGeneration>
  #finalWriter?: Readonly<{
    writer: Knex.Transaction
    transition?: WalletStorageProviderTransition
    read: () => Promise<Readonly<Brc38KnexDestinationFence>>
    fence: Readonly<Brc38KnexDestinationFence>
    generation: Readonly<Brc38NativeLocalBaselineGeneration>
    io: Brc38OwnedImportReads
    lineage: Brc38OwnedImportReads
  }>
  private constructor(
    token: object,
    fence: Readonly<Brc38KnexDestinationFence>,
    generation: Readonly<Brc38NativeLocalBaselineGeneration>,
    trx: Knex.Transaction,
    policy: Readonly<Brc38NativeLocalBaselinePolicy>,
    deadline: number,
    owner:
      | Readonly<{ storage: StorageKnex; receiptPolicy: Readonly<SnapshotJournalReceiptPolicy> }>
      | Readonly<{ retired: Brc38RetiredNativeReadNode }>
  ) {
    if (token !== issuer) invalid()
    if ('retired' in owner) this.#retired = owner.retired
    else
      this.#current = Object.freeze({
        storage: owner.storage,
        root: owner.storage.knex,
        receiptPolicy: owner.receiptPolicy
      })
    this.#trx = trx
    this.#policy = policy
    this.#deadline = deadline
    this.#fence = fence
    this.#generation = generation
  }
  #writerOwner(): Readonly<{
    storage: StorageKnex
    root: Knex
    receiptPolicy: Readonly<SnapshotJournalReceiptPolicy>
  }> {
    this.#assert()
    if (this.#current === undefined || this.#retired !== undefined) invalid()
    return this.#current
  }
  static assertOwned(source: Brc38NativeLocalBaselineSource): void {
    source.#assert()
  }
  static assertManagedSource(
    source: Brc38NativeLocalBaselineSource,
    manager: WalletStorageManager,
    selectedProvider?: unknown,
    transition?: WalletStorageProviderTransition
  ): void {
    const owner = source.#writerOwner()
    if (
      owner.storage.knex !== owner.root ||
      owner.storage.toDb() !== owner.root ||
      (selectedProvider !== undefined && selectedProvider !== owner.storage)
    )
      invalid()
    Brc38PublishedProfileNode.assertNativeManagedProvider(owner.storage, manager, transition)
    source.#assert()
  }
  /** Live resource ownership only. Source reads and consumer buffers must
   * debit the same original allowance rather than separate equal ceilings. */
  static assertSharedWorking(source: Brc38NativeLocalBaselineSource, working: Brc38WorkingAllocation): void {
    source.#assert()
    if (source.#policy.workingAllocation !== working) invalid()
  }
  /** Capture the actual source's unchanged resource DATA for a dependent read.
   * It conveys no source or profile admission and cannot renew its lifetime. */
  static readPolicy(source: Brc38NativeLocalBaselineSource): Readonly<Brc38NativeLocalBaselinePolicy> {
    Brc38NativeLocalBaselineSource.assertOwned(source)
    return Object.freeze({ ...source.#policy })
  }
  static maximumReadBytes(source: Brc38NativeLocalBaselineSource): number {
    source.#assert()
    return source.#policy.maximumReadBytes
  }
  static facts(
    source: Brc38NativeLocalBaselineSource
  ): Promise<
    Readonly<{ fence: Readonly<Brc38KnexDestinationFence>; generation: Readonly<Brc38NativeLocalBaselineGeneration> }>
  > {
    return source.#io.run(async () => {
      await source.#currentGeneration()
      return Object.freeze({ fence: source.#fence, generation: source.#generation })
    })
  }
  /** Fresh original composition coordinates, not a cutover or semantic
   * capability. The active provider still owns its original physical profile;
   * generation/profile/primary are independently read on this coherent view. */
  static compositionOrigin(
    source: Brc38NativeLocalBaselineSource,
    transition?: WalletStorageProviderTransition
  ): Promise<
    Readonly<{
      inventory: import('./Brc38PublishedProfileNode').Brc38ProfileInventoryBinding
      fixedSha256: string
      copySha256: string
      copyBytes: number
      epoch: string
      revision: SnapshotJournalRevision
      primaryEpoch: SnapshotJournalRevision
      userId: number
      activeStorage: string
    }>
  > {
    const owner = source.#writerOwner()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const lineage = await Brc38PublishedProfileNode.readNativeSourceLineage(owner.storage, transition),
        fence = source.#fence
      if (
        fence.userId === null ||
        fence.primaryEpoch === null ||
        fence.activeStorage !== fence.targetStorageIdentityKey
      )
        invalid()
      await source.#currentGeneration()
      return Object.freeze({
        ...lineage,
        epoch: source.#generation.epoch,
        revision: source.#generation.revision,
        primaryEpoch: fence.primaryEpoch,
        userId: fence.userId,
        activeStorage: fence.activeStorage
      })
    })
  }
  /** Recovery lineage DATA from the actual retired reader, freshly reread on
   * its original inventory/catalog/kernel and coherent all48 wallet view.
   * This variant cannot grant a live writer or current-provider permission. */
  static retiredCompositionOrigin(source: Brc38NativeLocalBaselineSource): Promise<
    Readonly<{
      source: Brc38ComposedProfileReceipt['source']
      retirement: Readonly<Brc38NativeRetirementRecord>
    }>
  > {
    source.#assert()
    const reader = source.#retired
    if (reader === undefined || source.#current !== undefined) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const lineage = await Brc38RetiredNativeReadNode.readSourceLineageInWalletScope(reader, source.#trx),
        fence = source.#fence,
        generation = source.#generation,
        original = lineage.retirement.source
      if (
        fence.userId === null ||
        fence.primaryEpoch === null ||
        fence.activeStorage !== fence.targetStorageIdentityKey ||
        original.epoch !== generation.epoch ||
        original.revision !== generation.revision ||
        original.primaryEpoch !== fence.primaryEpoch ||
        original.fixedSha256 !== lineage.fixedSha256 ||
        original.copySha256 !== lineage.copySha256 ||
        original.copyBytes !== lineage.copyBytes
      )
        invalid()
      await source.#currentGeneration()
      return Object.freeze({
        source: Object.freeze({
          inventory: lineage.inventory,
          fixedSha256: lineage.fixedSha256,
          copySha256: lineage.copySha256,
          copyBytes: lineage.copyBytes,
          epoch: generation.epoch,
          revision: generation.revision,
          primaryEpoch: fence.primaryEpoch,
          userId: fence.userId,
          activeStorage: fence.activeStorage
        }),
        retirement: lineage.retirement
      })
    })
  }
  /** Fresh LIVE source observation on its actual root writer, distinct from
   * facts() on this retained historical snapshot. The complete all48 mutation
   * generation and original profile/backend/schema/primary fence must still
   * match. No bytes/crypto/network/index work runs under this short writer.
   * A true result is DATA only; final cutover needs its own retained ownership. */
  static inspectCurrent(
    source: Brc38NativeLocalBaselineSource,
    transition?: WalletStorageProviderTransition
  ): Promise<
    Readonly<{
      current: boolean
      fence: Readonly<Brc38KnexDestinationFence>
      generation: Readonly<Brc38NativeLocalBaselineGeneration>
    }>
  > {
    return Brc38NativeLocalBaselineSource.withCurrentDataFence(source, async () => undefined, transition)
  }
  /** Internal final-commit scope. The caller must acquire its manager's commit
   * queue BEFORE entering this method. The actual original root writer then
   * retains source data/primary exclusion through ONE bounded destination
   * commit. All copy, payload, proof, parser, network, observer and retry work
   * must be prepared outside this scope. A changed source invokes no commit.
   * No saved current:true observation, fence or generation may enter instead
   * of this genuine retained source factory. */
  static withCurrentDataFence<T>(
    source: Brc38NativeLocalBaselineSource,
    selectedCommit: (writer: Knex.Transaction) => Promise<T>,
    transition?: WalletStorageProviderTransition
  ): Promise<
    | Readonly<{
        current: false
        fence: Readonly<Brc38KnexDestinationFence>
        generation: Readonly<Brc38NativeLocalBaselineGeneration>
      }>
    | Readonly<{
        current: true
        fence: Readonly<Brc38KnexDestinationFence>
        generation: Readonly<Brc38NativeLocalBaselineGeneration>
        value: T
      }>
  > {
    const commit = selectedCommit,
      owner = source.#writerOwner()
    if (typeof commit !== 'function') invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const check = (): void => {
          source.#assert()
          if (owner.storage.knex !== owner.root || owner.storage.toDb() !== owner.root) invalid()
        },
        charge = source.#policy.workingAllocation.claim(1048576)
      try {
        check()
        return await source.#withImmediateWriter(async (k, read) => {
          check()
          requireBrc38NativeProfileTransaction(k)
          const fence = await read(),
            generation = await readBrc38NativeLocalBaselineGeneration(k)
          if (
            !generation.complete ||
            !generation.enabled ||
            generation.epoch !== source.#generation.epoch ||
            BigInt(generation.revision) < BigInt(source.#generation.revision)
          )
            invalid()
          await verifySnapshotJournalDestinationSchema(k)
          const current =
            JSON.stringify(fence) === JSON.stringify(source.#fence) &&
            JSON.stringify(generation) === JSON.stringify(source.#generation)
          if (
            JSON.stringify(await read()) !== JSON.stringify(fence) ||
            JSON.stringify(await readBrc38NativeLocalBaselineGeneration(k)) !== JSON.stringify(generation)
          )
            invalid()
          check()
          requireBrc38NativeProfileTransaction(k)
          if (!current) return Object.freeze({ current: false as const, fence, generation })
          // This actual source writer remains owned across the destination
          // operation and its physical cleanup. No boolean or report supplies
          // the source exclusion, and no source operation joins a manager queue.
          if (source.#finalWriter !== undefined) invalid()
          const io = new Brc38OwnedImportReads(),
            lineage = new Brc38OwnedImportReads(),
            final = Object.freeze({ writer: k, transition, read, fence, generation, io, lineage })
          source.#finalWriter = final
          let value: T
          try {
            value = await lineage.retain(async () => await io.retain(async () => await commit(k)))
          } finally {
            source.#finalWriter = undefined
          }
          check()
          requireBrc38NativeProfileTransaction(k)
          if (
            JSON.stringify(await read()) !== JSON.stringify(fence) ||
            JSON.stringify(await readBrc38NativeLocalBaselineGeneration(k)) !== JSON.stringify(generation)
          )
            invalid()
          check()
          requireBrc38NativeProfileTransaction(k)
          return Object.freeze({ current: true as const, fence, generation, value })
        }, transition)
      } finally {
        charge.close()
      }
    })
  }
  /** Retain the genuine source Root0 BEGIN IMMEDIATE without modifying the
   * wallet or clock. Backend/source/primary reads stay on that exact physical
   * transaction; the original coherent snapshot remains separately owned. */
  async #withImmediateWriter<T>(
    work: (writer: Knex.Transaction, read: () => Promise<Readonly<Brc38KnexDestinationFence>>) => Promise<T>,
    transition?: WalletStorageProviderTransition
  ): Promise<T> {
    const owner = this.#writerOwner()
    return await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
      owner.storage,
      async writer => {
        this.#assert()
        requireBrc38NativeProfileTransaction(writer)
        const files = (await writer.raw('PRAGMA database_list')) as Array<{ name: unknown; file: unknown }>,
          main = files.filter(value => value.name === 'main')
        if (
          main.length !== 1 ||
          typeof main[0].file !== 'string' ||
          !main[0].file.startsWith('/') ||
          main[0].file.length > 4096
        )
          invalid()
        const path = await realpath(main[0].file),
          info = await lstat(path, { bigint: true }),
          expected: SnapshotJournalCaptureBackend = {
            kind: 'sqlite',
            file: { path, device: info.dev.toString(), inode: info.ino.toString() }
          },
          connection = await writer.client.acquireConnection()
        if (!info.isFile()) invalid()
        const read = async (): Promise<Readonly<Brc38KnexDestinationFence>> => {
          this.#assert()
          requireBrc38NativeProfileTransaction(writer)
          if (
            owner.storage.knex !== owner.root ||
            owner.storage.toDb() !== owner.root ||
            (await bindSnapshotJournalDestinationBackend(writer, connection, expected)) !== this.#fence.backendSha256
          )
            invalid()
          const fence = await readBrc38KnexRetainedSourceFence(
            writer,
            this.#fence.backendSha256,
            this.#fence,
            owner.receiptPolicy,
            owner.root.client.config.migrations,
            false
          )
          this.#assert()
          requireBrc38NativeProfileTransaction(writer)
          return fence
        }
        const value = await work(writer, read)
        this.#assert()
        requireBrc38NativeProfileTransaction(writer)
        return value
      },
      transition
    )
  }
  static async requireManagedRetirementWriter(
    source: Brc38NativeLocalBaselineSource,
    manager: WalletStorageManager,
    writer: Knex.Transaction,
    transition?: WalletStorageProviderTransition
  ): Promise<void> {
    source.#assert()
    Brc38NativeLocalBaselineSource.assertManagedSource(source, manager, undefined, transition)
    await Brc38PublishedProfileNode.requireNativeRetirementWriter(
      source.#writerOwner().storage,
      manager,
      writer,
      transition
    )
    source.#assert()
    Brc38NativeLocalBaselineSource.assertManagedSource(source, manager, undefined, transition)
  }
  /** Retain only the writer issued by this source's final unchanged-data
   * factory. A generic native transaction, copied handle or earlier current
   * observation cannot join it. Nested retirement work drains before COMMIT. */
  static withFinalRetirementWriter<T>(
    source: Brc38NativeLocalBaselineSource,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    writer: Knex.Transaction,
    work: (
      storage: StorageKnex,
      fence: Readonly<Brc38KnexDestinationFence>,
      generation: Readonly<Brc38NativeLocalBaselineGeneration>
    ) => Promise<T>
  ): Promise<T> {
    const actual = source.#finalWriter,
      owner = source.#writerOwner()
    if (
      actual === undefined ||
      actual.writer !== writer ||
      actual.transition !== transition ||
      typeof work !== 'function'
    )
      invalid()
    return actual.io.run(async () => {
      const check = async (): Promise<void> => {
        if (source.#finalWriter !== actual) invalid()
        await Brc38NativeLocalBaselineSource.requireManagedRetirementWriter(source, manager, writer, transition)
        if (
          JSON.stringify(await actual.read()) !== JSON.stringify(actual.fence) ||
          JSON.stringify(await readBrc38NativeLocalBaselineGeneration(writer)) !== JSON.stringify(actual.generation) ||
          JSON.stringify(actual.fence) !== JSON.stringify(source.#fence) ||
          JSON.stringify(actual.generation) !== JSON.stringify(source.#generation)
        )
          invalid()
        if (source.#finalWriter !== actual) invalid()
      }
      await check()
      const value = await work(owner.storage, actual.fence, actual.generation)
      await check()
      return value
    })
  }
  /** Fresh forward decision DATA on the original held source. This is used
   * only to settle a genuine composed inspection after retirement; it cannot
   * create a new source writer or resume ordinary manager availability. */
  static forwardCompositionOrigin(
    source: Brc38NativeLocalBaselineSource,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition
  ): Promise<
    Readonly<{
      source: Brc38ComposedProfileReceipt['source']
      retirement: Readonly<Brc38NativeRetirementRecord>
    }>
  > {
    const owner = source.#writerOwner()
    const reads = source.#finalWriter?.lineage ?? source.#io
    return reads.run(async () => {
      await source.#currentGeneration()
      const lineage = await Brc38PublishedProfileNode.readNativeRetirementLineage(owner.storage, manager, transition),
        fence = source.#fence,
        generation = source.#generation,
        original = lineage.retirement.source
      if (
        fence.userId === null ||
        fence.primaryEpoch === null ||
        fence.activeStorage !== fence.targetStorageIdentityKey ||
        original.epoch !== generation.epoch ||
        original.revision !== generation.revision ||
        original.primaryEpoch !== fence.primaryEpoch ||
        original.fixedSha256 !== lineage.fixedSha256 ||
        original.copySha256 !== lineage.copySha256 ||
        original.copyBytes !== lineage.copyBytes
      )
        invalid()
      await source.#currentGeneration()
      return Object.freeze({
        source: Object.freeze({
          inventory: lineage.inventory,
          fixedSha256: lineage.fixedSha256,
          copySha256: lineage.copySha256,
          copyBytes: lineage.copyBytes,
          epoch: generation.epoch,
          revision: generation.revision,
          primaryEpoch: fence.primaryEpoch,
          userId: fence.userId,
          activeStorage: fence.activeStorage
        }),
        retirement: lineage.retirement
      })
    })
  }
  get fence(): Readonly<Brc38KnexDestinationFence> {
    return this.#fence
  }
  get generation(): Readonly<Brc38NativeLocalBaselineGeneration> {
    return this.#generation
  }
  async #currentGeneration(): Promise<void> {
    this.#assert()
    // The current-source factory verifies this exact query-only snapshot
    // before issuing the facade. Its private transaction never escapes; read
    // and validate the actual clock on each operation within that same view.
    // Retired reads, new views and mutable transactions retain full verification.
    const current =
      this.#retired === undefined
        ? await readBrc38NativeLocalBaselineGenerationData(this.#trx)
        : await readBrc38NativeLocalBaselineGeneration(this.#trx)
    if (!current.complete || !current.enabled || JSON.stringify(current) !== JSON.stringify(this.#generation)) invalid()
    this.#assert()
  }
  static ownedChanges(
    source: Brc38NativeLocalBaselineSource,
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ revision: SnapshotJournalRevision; tableId: number; rowId: number }> | undefined,
    maximumRows: number,
    presentOnly = false
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    return source.#changes(afterRevision, cursor, maximumRows, presentOnly)
  }
  changes(
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ revision: SnapshotJournalRevision; tableId: number; rowId: number }> | undefined,
    maximumRows: number,
    presentOnly = false
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    return this.#changes(afterRevision, cursor, maximumRows, presentOnly)
  }
  #changes(
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ revision: SnapshotJournalRevision; tableId: number; rowId: number }> | undefined,
    maximumRows: number,
    presentOnly = false
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    const low = snapshotJournalRevision(afterRevision),
      after =
        cursor === undefined
          ? undefined
          : Object.freeze({ ...cursor, revision: snapshotJournalRevision(cursor.revision) }),
      width = maximumRows,
      present = presentOnly
    if (
      typeof present !== 'boolean' ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > 128 ||
      (after !== undefined &&
        (!Number.isSafeInteger(after.tableId) ||
          after.tableId < 0 ||
          after.tableId >= tableCount ||
          !Number.isSafeInteger(after.rowId)))
    )
      invalid()
    return this.#io.run(async () => {
      await this.#currentGeneration()
      const charge = this.#policy.workingAllocation.claim(4096 + 1024 * width)
      try {
        return await readBrc38NativeLocalBaselineChanges(this.#trx, {
          epoch: this.#generation.epoch,
          afterRevision: low,
          highWater: this.#generation.revision,
          after,
          maximumRows: width,
          presentOnly: present
        })
      } finally {
        charge.close()
      }
    })
  }
  static ownedTombstones(
    source: Brc38NativeLocalBaselineSource,
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ tableId: number; revision: SnapshotJournalRevision; rowId: number }> | undefined,
    maximumRows: number
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    return source.#tombstones(afterRevision, cursor, maximumRows)
  }
  tombstones(
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ tableId: number; revision: SnapshotJournalRevision; rowId: number }> | undefined,
    maximumRows: number
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    return this.#tombstones(afterRevision, cursor, maximumRows)
  }
  #tombstones(
    afterRevision: SnapshotJournalRevision,
    cursor: Readonly<{ tableId: number; revision: SnapshotJournalRevision; rowId: number }> | undefined,
    maximumRows: number
  ): Promise<readonly Readonly<Brc38NativeLocalBaselineChange>[]> {
    const low = snapshotJournalRevision(afterRevision),
      after =
        cursor === undefined
          ? undefined
          : Object.freeze({ ...cursor, revision: snapshotJournalRevision(cursor.revision) }),
      width = maximumRows
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > 128 ||
      (after !== undefined &&
        (!Number.isSafeInteger(after.tableId) ||
          after.tableId < 0 ||
          after.tableId >= tableCount ||
          !Number.isSafeInteger(after.rowId)))
    )
      invalid()
    return this.#io.run(async () => {
      await this.#currentGeneration()
      const charge = this.#policy.workingAllocation.claim(4096 + 1024 * width)
      try {
        return await readBrc38NativeLocalBaselineTombstones(this.#trx, {
          epoch: this.#generation.epoch,
          afterRevision: low,
          highWater: this.#generation.revision,
          after,
          maximumRows: width
        })
      } finally {
        charge.close()
      }
    })
  }
  #assert(): void {
    if (
      !this.#live ||
      this.#trx.isCompleted() ||
      this.#policy.expiresAt <= Date.now() ||
      performance.now() >= this.#deadline
    )
      invalid()
    this.#policy.signal?.throwIfAborted()
    if (this.#retired !== undefined)
      Brc38RetiredNativeReadNode.assertReadOwner(
        this.#retired,
        this.#trx,
        this.#policy.workingAllocation,
        this.#policy.expiresAt,
        this.#policy.maximumReadBytes,
        this.#policy.signal
      )
    else requireBrc38NativeProfileTransaction(this.#trx)
  }
  /** Keyset coordinates only, on the actual table's rowid index. No OFFSET,
   * high-water restart, tombstone inference or portable-ID substitution. */
  static ownedPage(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativeLocalBaselineTable,
    afterRowId: number | null,
    maximumRows: number
  ): Promise<readonly number[]> {
    return source.#page(table, afterRowId, maximumRows)
  }
  page(
    table: Brc38NativeLocalBaselineTable,
    afterRowId: number | null,
    maximumRows: number
  ): Promise<readonly number[]> {
    return this.#page(table, afterRowId, maximumRows)
  }
  #page(
    table: Brc38NativeLocalBaselineTable,
    afterRowId: number | null,
    maximumRows: number
  ): Promise<readonly number[]> {
    const selected = table,
      after = afterRowId,
      width = maximumRows
    if (
      !brc38NativeLocalBaselineTables.includes(selected) ||
      (after !== null && !Number.isSafeInteger(after)) ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > 128
    )
      invalid()
    return this.#io.run(async () => {
      await this.#currentGeneration()
      const charge = this.#policy.workingAllocation.claim(4096 + 512 * width)
      try {
        const query = this.#trx(selected).select(this.#trx.raw('rowid AS physicalRowId')).orderBy('rowid').limit(width)
        if (after !== null) query.where('rowid', '>', after)
        const rows = (await query.options({ safeIntegers: true })) as Array<{ physicalRowId: bigint }>
        this.#assert()
        if (
          rows.length > width ||
          rows.some(
            (row, index) =>
              typeof row.physicalRowId !== 'bigint' ||
              row.physicalRowId < -9007199254740991n ||
              row.physicalRowId > 9007199254740991n ||
              (index === 0
                ? after !== null && row.physicalRowId <= BigInt(after)
                : row.physicalRowId <= rows[index - 1].physicalRowId)
          )
        )
          invalid()
        return Object.freeze(rows.map(row => Number(row.physicalRowId)))
      } finally {
        charge.close()
      }
    })
  }
  /** Foreign-parent coordinates from the SAME real coherent source view.
   * This supplies indexed dependency DATA only. The candidate's real FK checks
   * and final inventory still enforce complete relationships independently. */
  static ownedParents(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativeLocalBaselineTable,
    rowId: number
  ): Promise<readonly Readonly<{ table: Brc38NativeLocalBaselineTable; rowId: number }>[]> {
    return source.#parents(table, rowId)
  }
  parents(
    table: Brc38NativeLocalBaselineTable,
    rowId: number
  ): Promise<readonly Readonly<{ table: Brc38NativeLocalBaselineTable; rowId: number }>[]> {
    return this.#parents(table, rowId)
  }
  #parents(
    table: Brc38NativeLocalBaselineTable,
    rowId: number
  ): Promise<readonly Readonly<{ table: Brc38NativeLocalBaselineTable; rowId: number }>[]> {
    const selected = table,
      physical = rowId
    if (!brc38NativeLocalBaselineTables.includes(selected) || !Number.isSafeInteger(physical)) invalid()
    return this.#io.run(async () => {
      await this.#currentGeneration()
      const k = this.#trx,
        charge = this.#policy.workingAllocation.claim(131072)
      let metadata: Record<string, unknown> | undefined
      try {
        const foreign = (await k.raw(
          'SELECT id,seq,"table" AS parent,"from" AS child,"to" AS parentColumn FROM pragma_foreign_key_list(?) ORDER BY id,seq LIMIT 65',
          [selected]
        )) as Array<{ id: number; seq: number; parent: string; child: string; parentColumn: string }>
        if (
          foreign.length > 64 ||
          foreign.some(
            row =>
              !Number.isSafeInteger(row.id) ||
              row.id < 0 ||
              !Number.isSafeInteger(row.seq) ||
              row.seq < 0 ||
              row.seq > 15 ||
              !brc38NativeLocalBaselineTables.includes(row.parent as Brc38NativeLocalBaselineTable) ||
              brc38NativeLocalBaselineTables.indexOf(row.parent as Brc38NativeLocalBaselineTable) >=
                brc38NativeLocalBaselineTables.indexOf(selected) ||
              !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.child) ||
              !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.parentColumn)
          )
        )
          invalid()
        const ids = [...new Set(foreign.map(row => row.id))],
          names = [...new Set(foreign.map(row => row.child))]
        if (ids.length > 16) invalid()
        if (names.length === 0) return Object.freeze([])
        const extents = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(
            k.raw(
              '(' +
                names
                  .map(
                    () =>
                      "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                  )
                  .join('+') +
                ') AS bytes',
              names.flatMap(name => [name, name])
            )
          )
          .limit(2)) as Array<{ bytes: number }>
        if (
          extents.length !== 1 ||
          !Number.isSafeInteger(extents[0].bytes) ||
          extents[0].bytes < 0 ||
          extents[0].bytes > this.#policy.maximumMetadataBytes
        )
          invalid()
        charge.resize(131072 + 32 * extents[0].bytes)
        const rows = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(names)
          .limit(2)
          .options({ safeIntegers: true })) as Array<Record<string, unknown>>
        if (rows.length !== 1) invalid()
        metadata = rows[0]
        const result: Readonly<{ table: Brc38NativeLocalBaselineTable; rowId: number }>[] = []
        for (const id of ids) {
          const group = foreign.filter(row => row.id === id),
            parent = group[0].parent as Brc38NativeLocalBaselineTable,
            values: Record<string, string | bigint | number> = {}
          if (group.some((row, index) => row.seq !== index || row.parent !== parent)) invalid()
          if (group.some(row => metadata![row.child] === null)) continue
          for (const row of group) {
            const value = metadata[row.child]
            if (
              typeof value !== 'string' &&
              typeof value !== 'bigint' &&
              (typeof value !== 'number' || !Number.isFinite(value))
            )
              invalid()
            values[row.parentColumn] = value
          }
          // Referenced FK columns have an actual unique/primary index under
          // the declared wallet schema. This is a bounded exact-key lookup.
          const matches = (await k(parent)
            .where(values)
            .select(k.raw('rowid AS physicalRowId'))
            .limit(2)
            .options({ safeIntegers: true })) as Array<{ physicalRowId: bigint }>
          if (
            matches.length !== 1 ||
            typeof matches[0].physicalRowId !== 'bigint' ||
            matches[0].physicalRowId < -9007199254740991n ||
            matches[0].physicalRowId > 9007199254740991n
          )
            invalid()
          const rowId = Number(matches[0].physicalRowId),
            point = await readBrc38NativeLocalBaselinePhysical(k, parent, rowId)
          if (point?.present !== true) invalid()
          if (!result.some(value => value.table === parent && value.rowId === rowId))
            result.push(Object.freeze({ table: parent, rowId }))
        }
        this.#assert()
        return Object.freeze(result)
      } finally {
        for (const value of Object.values(metadata ?? {})) if (value instanceof Uint8Array) value.fill(0)
        charge.close()
      }
    })
  }
  static physical(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativeLocalBaselineTable,
    rowId: number
  ): Promise<Readonly<Brc38NativeLocalBaselineChange> | undefined> {
    const selected = table,
      physical = rowId
    if (!brc38NativeLocalBaselineTables.includes(selected) || !Number.isSafeInteger(physical)) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const charge = source.#policy.workingAllocation.claim(4096)
      try {
        return await readBrc38NativeLocalBaselinePhysical(source.#trx, selected, physical)
      } finally {
        charge.close()
      }
    })
  }
  /** Complete bounded AUTOINCREMENT metadata from this SAME real view. Deleted
   * high IDs must not be silently reused after copying only present rows. */
  static withOwnedSequences<T>(
    source: Brc38NativeLocalBaselineSource,
    work: (rows: readonly Readonly<{ table: Brc38NativeLocalBaselineTable; sequence: string | null }>[]) => Promise<T>
  ): Promise<T> {
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const charge = source.#policy.workingAllocation.claim(1048576)
      try {
        const schema = (await source
          .#trx('sqlite_schema')
          .where({ type: 'table' })
          .whereIn('name', brc38NativeLocalBaselineTables)
          .select(
            'name',
            source.#trx.raw(
              "CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN instr(lower(sql),'autoincrement')>0 ELSE NULL END AS incremented"
            )
          )
          .limit(tableCount + 1)) as Array<{ name: Brc38NativeLocalBaselineTable; incremented: number | null }>
        if (
          schema.length !== tableCount ||
          schema.some(
            row =>
              !brc38NativeLocalBaselineTables.includes(row.name) || (row.incremented !== 0 && row.incremented !== 1)
          ) ||
          new Set(schema.map(row => row.name)).size !== tableCount
        )
          invalid()
        const values = (await source
          .#trx('sqlite_sequence')
          .select(
            source.#trx.raw(
              "CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name,CASE WHEN typeof(seq)='integer' AND seq>=0 THEN CAST(seq AS TEXT) ELSE NULL END AS sequence"
            )
          )
          .limit(513)) as Array<{ name: string | null; sequence: string | null }>
        if (
          values.length > 512 ||
          values.some(
            row =>
              typeof row.name !== 'string' ||
              !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.name) ||
              typeof row.sequence !== 'string' ||
              !/^(?:0|[1-9]\d{0,18})$/.test(row.sequence) ||
              BigInt(row.sequence) > 9223372036854775807n
          ) ||
          new Set(values.map(row => row.name)).size !== values.length
        )
          invalid()
        const result = Object.freeze(
          brc38NativeLocalBaselineTables
            .filter(table => schema.find(row => row.name === table)!.incremented === 1)
            .map(table => Object.freeze({ table, sequence: values.find(row => row.name === table)?.sequence ?? null }))
        )
        source.#assert()
        const resultValue = await work(result)
        source.#assert()
        return resultValue
      } finally {
        charge.close()
      }
    })
  }
  /** Reconstructed candidate quota must equal the actual logical source charge.
   * Its control bit is not operational data and is deliberately not copied. */
  static withOwnedJournalQuota<T>(
    source: Brc38NativeLocalBaselineSource,
    work: (value: Readonly<{ bytes: string; rows: number }>) => Promise<T>
  ): Promise<T> {
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const charge = source.#policy.workingAllocation.claim(4096)
      try {
        await verifySnapshotJournalSharedQuota(source.#trx)
        const values = (await source
          .#trx(SNAPSHOT_JOURNAL_SHARED_QUOTA)
          .where({ id: 0 })
          .select(source.#trx.raw('CAST(bytes AS TEXT) AS bytes'), 'rows')
          .limit(2)) as Array<{ bytes: string; rows: number }>
        if (
          values.length !== 1 ||
          typeof values[0].bytes !== 'string' ||
          !/^(?:0|[1-9]\d{0,10})$/.test(values[0].bytes) ||
          !Number.isSafeInteger(values[0].rows)
        )
          invalid()
        source.#assert()
        const result = await work(Object.freeze({ ...values[0] }))
        source.#assert()
        return result
      } finally {
        charge.close()
      }
    })
  }
  /** Historical local import families from this SAME coherent source view.
   * Presence/cursor/receipt values are DATA, not old import/write admission. */
  static ownedIncomingIdRanges(
    source: Brc38NativeLocalBaselineSource,
    bindingSha256: string
  ): Promise<
    readonly Readonly<{ tableId: number; sourceEpoch: string; first: number; count: number; expiresAt: number }>[]
  > {
    if (!/^[0-9a-f]{64}$/.test(bindingSha256)) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const k = source.#trx,
        charge = source.#policy.workingAllocation.claim(1048576)
      try {
        if (
          !(await hasBrc38NativeIncomingIdReservationSchema(k)) ||
          source.#fence.userId === null ||
          source.#fence.primaryEpoch === null ||
          source.#fence.activeStorage !== source.#fence.targetStorageIdentityKey
        )
          invalid()
        const values = (await k(brc38NativeIncomingIdReservations)
          .where({ bindingSha256 })
          .orderBy('tableId')
          .select('tableId', 'sourceEpoch', 'primaryEpoch', 'userId', 'first', 'count', 'expiresAt')
          .limit(11)) as Array<{
          tableId: number
          sourceEpoch: string
          primaryEpoch: string
          userId: number
          first: number
          count: number
          expiresAt: number
        }>
        if (values.length < 1 || values.length > 10) invalid()
        for (const [at, value] of values.entries()) {
          if (
            !Number.isSafeInteger(value.tableId) ||
            value.tableId < 0 ||
            value.tableId >= brc38NativeIncomingIdTables.length ||
            (at > 0 && value.tableId <= values[at - 1].tableId) ||
            value.sourceEpoch !== source.#generation.epoch ||
            value.primaryEpoch !== source.#fence.primaryEpoch ||
            value.userId !== source.#fence.userId ||
            !Number.isSafeInteger(value.first) ||
            value.first < 1 ||
            !Number.isSafeInteger(value.count) ||
            value.count < 1 ||
            value.count > 40000000 ||
            !Number.isSafeInteger(value.first + value.count - 1) ||
            !Number.isSafeInteger(value.expiresAt) ||
            value.expiresAt <= Date.now()
          )
            invalid()
          const [sql] = brc38PrivatePageIdForms[brc38NativeIncomingIdTables[value.tableId]],
            counter = (await k('sqlite_sequence').where({ name: sql }).select('seq').limit(2)) as Array<{ seq: number }>
          if (
            counter.length !== 1 ||
            !Number.isSafeInteger(counter[0].seq) ||
            counter[0].seq < value.first + value.count - 1
          )
            invalid()
        }
        source.#assert()
        return Object.freeze(
          values.map(({ tableId, sourceEpoch, first, count, expiresAt }) =>
            Object.freeze({ tableId, sourceEpoch, first, count, expiresAt })
          )
        )
      } finally {
        charge.close()
      }
    })
  }
  static ownedPriorImportLineage(source: Brc38NativeLocalBaselineSource): Promise<string> {
    return source.#io.run(async () => {
      await source.#currentGeneration()
      // Stable DATA lineage across source views and primary revisions. The
      // actual retained source/profile and original epoch remain required.
      const fence = source.#fence
      return createHash('sha256')
        .update(
          JSON.stringify([
            'brc38-prior-lineage/v1',
            fence.backendSha256,
            fence.targetStorageIdentityKey,
            source.#generation.epoch
          ])
        )
        .digest('hex')
    })
  }
  static ownedPriorImportPage(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativePriorImportTable,
    afterRowId: number | null,
    maximumRows: number
  ): Promise<Readonly<{ present: boolean; rows: readonly number[] }>> {
    const selected = table,
      after = afterRowId,
      width = maximumRows
    if (
      !brc38NativePriorImportTables.includes(selected) ||
      (after !== null && !Number.isSafeInteger(after)) ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      width > 128
    )
      invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const charge = source.#policy.workingAllocation.claim(1048576 + 1024 * width)
      try {
        const present = await inspectBrc38NativePriorImportFamily(source.#trx, selected)
        if (!present) return Object.freeze({ present: false, rows: Object.freeze([]) })
        const query = source.#trx(selected).select(source.#trx.raw('rowid AS physical')).orderBy('rowid').limit(width)
        if (after !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(after).toString()])
        const rows = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (
          rows.length > width ||
          rows.some(
            (value, at) =>
              typeof value.physical !== 'bigint' ||
              value.physical < -9007199254740991n ||
              value.physical > 9007199254740991n ||
              (at > 0 && value.physical <= rows[at - 1].physical)
          )
        )
          invalid()
        source.#assert()
        return Object.freeze({ present: true, rows: Object.freeze(rows.map(row => Number(row.physical))) })
      } finally {
        charge.close()
      }
    })
  }
  /** Exact typed metadata and raw original bytes. No full original JSON/chunk
   * payload crosses the metadata query; extent ownership is scoped and drained. */
  static withOwnedPriorImportRow<T>(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativePriorImportTable,
    rowId: number,
    work: (row: Readonly<Brc38NativePriorImportRow>) => Promise<T>
  ): Promise<T> {
    const selected = table,
      physical = rowId
    if (!brc38NativePriorImportTables.includes(selected) || !Number.isSafeInteger(physical)) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const k = source.#trx,
        payload = brc38NativePriorImportPayload(selected),
        reads = new Brc38OwnedImportReads(),
        charge = source.#policy.workingAllocation.claim(1048576)
      let live = true,
        retained = false,
        metadata: Record<string, unknown> | undefined
      try {
        if (!(await inspectBrc38NativePriorImportFamily(k, selected))) invalid()
        const columns = (await k.raw(
          'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 129',
          [selected]
        )) as Array<{ name: string | null }>
        if (
          columns.length < 1 ||
          columns.length > 128 ||
          columns.some(column => column.name === null || !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.name)) ||
          (payload !== undefined && !columns.some(column => column.name === payload.field))
        )
          invalid()
        const names = columns.map(column => column.name!).filter(name => name !== payload?.field)
        if (names.length < 1) invalid()
        const sizes = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(
            k.raw(
              '(' +
                names
                  .map(
                    () =>
                      "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                  )
                  .join('+') +
                ') AS bytes',
              names.flatMap(name => [name, name])
            )
          )
          .limit(2)) as Array<{ bytes: number }>
        if (
          sizes.length !== 1 ||
          !Number.isSafeInteger(sizes[0].bytes) ||
          sizes[0].bytes < 0 ||
          sizes[0].bytes > source.#policy.maximumMetadataBytes
        )
          invalid()
        charge.resize(1048576 + 32 * sizes[0].bytes)
        const values = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(names)
          .limit(2)
          .options({ safeIntegers: true })) as Array<Record<string, unknown>>
        if (values.length !== 1) invalid()
        metadata = values[0]
        const coordinate =
            payload === undefined
              ? undefined
              : ({ table: selected, field: payload.field, rowId: physical } as Brc38NativeLocalFieldCoordinate),
          bytes =
            coordinate === undefined
              ? undefined
              : await readBrc38NativeLocalFieldBytes(k, coordinate, source.#policy.signal)
        if (
          payload !== undefined &&
          (bytes === undefined ||
            bytes === null ||
            bytes < 1 ||
            bytes > payload.maximumBytes ||
            (payload.kind === 'blob' && metadata.bytes !== BigInt(bytes)) ||
            (payload.kind === 'text' && metadata.logicalBytes !== 512n + BigInt(bytes)))
        )
          invalid()
        source.#assert()
        const field =
            payload === undefined
              ? undefined
              : Object.freeze({ field: payload.field, kind: payload.kind, bytes: bytes! }),
          row: Readonly<Brc38NativePriorImportRow> = Object.freeze({
            table: selected,
            rowId: physical,
            metadata: Object.freeze(metadata),
            field,
            withFieldExtent: <V>(
              offset: number,
              length: number,
              consumer: (bytes: Uint8Array) => Promise<V>
            ): Promise<V> => {
              const start = offset,
                amount = length
              if (
                !live ||
                coordinate === undefined ||
                field === undefined ||
                !Number.isSafeInteger(start) ||
                start < 0 ||
                !Number.isSafeInteger(amount) ||
                amount < 1 ||
                amount > source.#policy.maximumReadBytes ||
                start > field.bytes - amount
              )
                invalid()
              return reads.run(async () => {
                source.#assert()
                if (!live) invalid()
                return await withBrc38NativeLocalFieldExtent(
                  k,
                  { ...coordinate, offset: start, length: amount, totalBytes: field.bytes },
                  source.#policy.workingAllocation,
                  async actual => {
                    source.#assert()
                    if (!live) invalid()
                    const result = await consumer(actual)
                    source.#assert()
                    return result
                  },
                  source.#policy.signal
                )
              })
            }
          })
        retained = true
        return await reads.retain(async () => await work(row))
      } finally {
        live = false
        try {
          if (!retained) await reads.finish()
        } finally {
          for (const value of Object.values(metadata ?? {})) if (value instanceof Uint8Array) value.fill(0)
          charge.close()
        }
      }
    })
  }
  static ownedRetainedPriorImportPage(
    source: Brc38NativeLocalBaselineSource,
    afterRowId: number | null
  ): Promise<readonly number[]> {
    if (afterRowId !== null && !Number.isSafeInteger(afterRowId)) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      if (!(await hasBrc38PrivatePriorImportSchema(source.#trx))) return Object.freeze([])
      const budgets = (await source
        .#trx(brc38PrivatePriorImportBudget)
        .where({ slot: 1 })
        .select('copyTable', 'afterRowId')
        .limit(2)) as Array<{ copyTable: number; afterRowId: number | null }>
      if (
        budgets.length !== 1 ||
        budgets[0].copyTable !== brc38NativePriorImportTables.length + 1 ||
        budgets[0].afterRowId !== null ||
        (await source.#trx(brc38PrivatePriorImportRows).whereNot({ state: 'SEALED' }).select('sourceRowId').limit(1))
          .length
      )
        invalid()

      const query = source
        .#trx(brc38PrivatePriorImportRows)
        .select(source.#trx.raw('rowid AS physical'))
        .orderBy('rowid')
        .limit(1)
      if (afterRowId !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterRowId).toString()])
      const values = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
      if (
        values.length > 1 ||
        values.some(
          value =>
            typeof value.physical !== 'bigint' ||
            value.physical < -9007199254740991n ||
            value.physical > 9007199254740991n
        )
      )
        invalid()
      source.#assert()
      return Object.freeze(values.map(value => Number(value.physical)))
    })
  }
  /** Flatten previous custody without wrapping its metadata again. Original
   * lineage, table and physical source key survive every later import. */
  static withOwnedRetainedPriorImportRow<T>(
    source: Brc38NativeLocalBaselineSource,
    physical: number,
    work: (row: Readonly<Brc38NativeRetainedPriorImportRow>) => Promise<T>
  ): Promise<T> {
    if (!Number.isSafeInteger(physical)) invalid()
    return source.#io.run(async () => {
      await source.#currentGeneration()
      const k = source.#trx,
        reads = new Brc38OwnedImportReads(),
        charge = source.#policy.workingAllocation.claim(2097152)
      let live = true,
        retained = false
      try {
        if (!(await hasBrc38PrivatePriorImportSchema(k))) invalid()
        const extents = (await k(brc38PrivatePriorImportRows)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(k.raw('length(CAST(metadataJson AS BLOB)) AS bytes'))
          .limit(2)) as Array<{ bytes: number }>
        if (
          extents.length !== 1 ||
          !Number.isSafeInteger(extents[0].bytes) ||
          extents[0].bytes < 2 ||
          extents[0].bytes > 1048576
        )
          invalid()
        charge.resize(2097152 + 32 * extents[0].bytes)
        const values = (await k(brc38PrivatePriorImportRows)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(
            'sourceLineageSha256',
            'tableId',
            'sourceRowId',
            'metadataJson',
            'metadataSha256',
            'fieldKind',
            'bytes',
            'sha256',
            'accepted',
            'chunks',
            'state'
          )
          .limit(2)) as Array<{
          sourceLineageSha256: string
          tableId: number
          sourceRowId: number
          metadataJson: string
          metadataSha256: string
          fieldKind: 'none' | 'blob' | 'text'
          bytes: number
          sha256: string | null
          accepted: number
          chunks: number
          state: string
        }>
        if (values.length !== 1) invalid()
        const value = values[0],
          key = {
            sourceLineageSha256: value.sourceLineageSha256,
            tableId: value.tableId,
            sourceRowId: value.sourceRowId
          }
        if (
          !/^[0-9a-f]{64}$/.test(value.sourceLineageSha256) ||
          !Number.isSafeInteger(value.tableId) ||
          value.tableId < 0 ||
          value.tableId >= brc38NativePriorImportTables.length ||
          !Number.isSafeInteger(value.sourceRowId) ||
          value.state !== 'SEALED' ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < 0 ||
          value.bytes > 16777216 ||
          value.accepted !== value.bytes ||
          !Number.isSafeInteger(value.chunks) ||
          value.chunks < 0 ||
          value.chunks > value.bytes ||
          typeof value.metadataJson !== 'string' ||
          Buffer.byteLength(value.metadataJson) > 1048576 ||
          createHash('sha256').update(value.metadataJson).digest('hex') !== value.metadataSha256 ||
          (value.fieldKind === 'none' && (value.bytes !== 0 || value.sha256 !== null)) ||
          (value.fieldKind !== 'none' &&
            (!['blob', 'text'].includes(value.fieldKind) ||
              value.bytes < 1 ||
              !/^[0-9a-f]{64}$/.test(value.sha256 ?? '')))
        )
          invalid()
        // Verify the complete retained chunk keyset before offering extents;
        // indexed reads alone could otherwise miss trailing or hidden chunks.
        const full = createHash('sha256')
        let position = 0,
          chunkCount = 0
        while (position < value.bytes) {
          source.#assert()
          const cells = (await k(brc38PrivatePriorImportChunks)
            .where({ ...key, offset: position })
            .select('bytes', 'payload', 'sha256')
            .limit(2)) as Array<{ bytes: number; payload: Uint8Array; sha256: string }>
          try {
            if (
              cells.length !== 1 ||
              !Number.isSafeInteger(cells[0].bytes) ||
              cells[0].bytes < 1 ||
              cells[0].bytes > 16384 ||
              !(cells[0].payload instanceof Uint8Array) ||
              cells[0].payload.byteLength !== cells[0].bytes ||
              cells[0].bytes > value.bytes - position ||
              createHash('sha256').update(cells[0].payload).digest('hex') !== cells[0].sha256
            )
              invalid()
            full.update(cells[0].payload)
            position += cells[0].bytes
            chunkCount++
          } finally {
            for (const cell of cells) cell.payload?.fill(0)
          }
        }
        const allChunks = (await k(brc38PrivatePriorImportChunks).where(key).count({ count: '*' }).first()) as
          { count: number } | undefined
        if (
          chunkCount !== value.chunks ||
          allChunks?.count !== chunkCount ||
          (value.bytes > 0 && full.digest('hex') !== value.sha256)
        )
          invalid()
        const field =
            value.fieldKind === 'none'
              ? undefined
              : Object.freeze({ kind: value.fieldKind, bytes: value.bytes, sha256: value.sha256! }),
          row: Readonly<Brc38NativeRetainedPriorImportRow> = Object.freeze({
            ...key,
            copyRowId: physical,
            metadataJson: value.metadataJson,
            metadataSha256: value.metadataSha256,
            field,
            withFieldExtent: <V>(
              offset: number,
              length: number,
              consumer: (bytes: Uint8Array) => Promise<V>
            ): Promise<V> => {
              if (
                !live ||
                field === undefined ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                !Number.isSafeInteger(length) ||
                length < 1 ||
                length > source.#policy.maximumReadBytes ||
                offset > field.bytes - length
              )
                invalid()
              return reads.run(async () => {
                source.#assert()
                if (!live) invalid()
                const frame = source.#policy.workingAllocation.claim(1048576 + 32 * length),
                  output = Buffer.alloc(length)
                try {
                  let accepted = 0
                  while (accepted < length) {
                    source.#assert()
                    if (!live) invalid()
                    const at = offset + accepted,
                      cells = (await k(brc38PrivatePriorImportChunks)
                        .where(key)
                        .where('offset', '<=', at)
                        .orderBy('offset', 'desc')
                        .select('offset', 'bytes', 'payload', 'sha256')
                        .limit(1)) as Array<{ offset: number; bytes: number; payload: Uint8Array; sha256: string }>
                    if (cells.length !== 1) invalid()
                    const cell = cells[0]
                    try {
                      if (
                        !Number.isSafeInteger(cell.offset) ||
                        cell.offset < 0 ||
                        !Number.isSafeInteger(cell.bytes) ||
                        cell.bytes < 1 ||
                        cell.bytes > 16384 ||
                        !(cell.payload instanceof Uint8Array) ||
                        cell.payload.byteLength !== cell.bytes ||
                        cell.offset > at ||
                        cell.offset + cell.bytes <= at ||
                        cell.offset + cell.bytes > field.bytes ||
                        createHash('sha256').update(cell.payload).digest('hex') !== cell.sha256
                      )
                        invalid()
                      const amount = Math.min(length - accepted, cell.offset + cell.bytes - at)
                      output.set(cell.payload.subarray(at - cell.offset, at - cell.offset + amount), accepted)
                      accepted += amount
                    } finally {
                      cell.payload?.fill(0)
                    }
                  }
                  const result = await consumer(output)
                  source.#assert()
                  return result
                } finally {
                  output.fill(0)
                  frame.close()
                }
              })
            }
          })
        retained = true
        return await reads.retain(async () => await work(row))
      } finally {
        live = false
        try {
          if (!retained) await reads.finish()
        } finally {
          charge.close()
        }
      }
    })
  }
  static withOwnedRow<T>(
    source: Brc38NativeLocalBaselineSource,
    table: Brc38NativeLocalBaselineTable,
    rowId: number,
    work: (row: Readonly<Brc38NativeLocalBaselineRow>) => Promise<T>
  ): Promise<T> {
    return source.#withRow(table, rowId, work)
  }
  withRow<T>(
    table: Brc38NativeLocalBaselineTable,
    rowId: number,
    work: (row: Readonly<Brc38NativeLocalBaselineRow>) => Promise<T>
  ): Promise<T> {
    return this.#withRow(table, rowId, work)
  }
  #withRow<T>(
    table: Brc38NativeLocalBaselineTable,
    rowId: number,
    work: (row: Readonly<Brc38NativeLocalBaselineRow>) => Promise<T>
  ): Promise<T> {
    const selected = table,
      physical = rowId
    if (!brc38NativeLocalBaselineTables.includes(selected) || !Number.isSafeInteger(physical)) invalid()
    return this.#io.run(async () => {
      await this.#currentGeneration()
      const reservation = this.#policy.workingAllocation.claim(131072),
        k = this.#trx,
        payloads = fields(selected),
        reads = new Brc38OwnedImportReads()
      let rowLive = true,
        retained = false,
        metadata: Record<string, unknown> | undefined
      try {
        const physicalState = await readBrc38NativeLocalBaselinePhysical(k, selected, physical)
        if (physicalState?.present !== true) invalid()
        const columns = (await k.raw(
          'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 129',
          [selected]
        )) as Array<{ name: string | null }>
        if (
          columns.length < 1 ||
          columns.length > 128 ||
          columns.some(column => typeof column.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.name)) ||
          payloads.some(field => !columns.some(column => column.name === field.field))
        )
          invalid()
        const names = columns.map(column => column.name!).filter(name => !payloads.some(field => field.field === name))
        if (names.length < 1) invalid()
        const extents = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(
            k.raw(
              '(' +
                names
                  .map(
                    () =>
                      "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                  )
                  .join('+') +
                ') AS bytes',
              names.flatMap(name => [name, name])
            )
          )
          .limit(2)) as Array<{ bytes: number }>
        if (
          extents.length !== 1 ||
          !Number.isSafeInteger(extents[0].bytes) ||
          extents[0].bytes < 0 ||
          extents[0].bytes > this.#policy.maximumMetadataBytes
        )
          invalid()
        reservation.resize(131072 + 32 * extents[0].bytes)
        const rows = (await k(selected)
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
          .select(names)
          .limit(2)
          .options({ safeIntegers: true })) as Array<Record<string, unknown>>
        this.#assert()
        if (rows.length !== 1) invalid()
        metadata = rows[0]
        const lengths: Brc38NativeLocalBaselineField[] = []
        for (const field of payloads) {
          const bytes = await this.#fieldBytes(selected, physical, field)
          if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1000000000)) invalid()
          lengths.push(Object.freeze({ field: field.field, kind: field.kind, bytes }))
        }
        this.#assert()
        const row: Readonly<Brc38NativeLocalBaselineRow> = Object.freeze({
          table: selected,
          rowId: physical,
          revision: physicalState.revision,
          generation: physicalState.generation,
          metadata: Object.freeze(metadata),
          fields: Object.freeze(lengths),
          withFieldExtent: <V>(
            name: string,
            offset: number,
            length: number,
            consumer: (bytes: Uint8Array) => Promise<V>
          ): Promise<V> => {
            const field = payloads.find(value => value.field === name),
              descriptor = lengths.find(value => value.field === name),
              start = offset,
              amount = length
            if (
              !rowLive ||
              field === undefined ||
              descriptor?.bytes === null ||
              descriptor?.bytes === undefined ||
              !Number.isSafeInteger(start) ||
              start < 0 ||
              !Number.isSafeInteger(amount) ||
              amount < 1 ||
              amount > this.#policy.maximumReadBytes ||
              start > descriptor.bytes - amount
            )
              invalid()
            const total = descriptor.bytes
            return reads.run(async () => {
              this.#assert()
              if (!rowLive || (await this.#fieldBytes(selected, physical, field)) !== total) invalid()
              return await this.#withField(selected, physical, field, start, total, amount, consumer)
            })
          }
        })
        retained = true
        return await reads.retain(async () => await work(row))
      } finally {
        rowLive = false
        try {
          if (!retained) await reads.finish()
        } finally {
          for (const value of Object.values(metadata ?? {})) if (value instanceof Uint8Array) value.fill(0)
          reservation.close()
        }
      }
    })
  }
  async #localPackedKey(
    rowId: number,
    field: Field
  ): Promise<Brc38NativePackedBinaryCoordinate | Brc38NativePackedTextCoordinate | undefined> {
    this.#assert()
    if (field.local === undefined || !(await hasBrc38NativeLocalPackedLayout(this.#trx))) return undefined
    const source = brc38NativeLocalPackedSources.find(
      source => source.table === field.local && source.fields.includes(field.field)
    )
    if (source === undefined) invalid()
    const actual = (await this.#trx(source.table)
      .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
      .select(source.key)
      .limit(2)
      .options({ safeIntegers: true })) as Array<Record<string, unknown>>
    if (
      actual.length !== 1 ||
      typeof actual[0][source.key] !== 'bigint' ||
      (actual[0][source.key] as bigint) < -9007199254740991n ||
      (actual[0][source.key] as bigint) > 9007199254740991n
    )
      invalid()
    this.#assert()
    return Object.freeze({ table: source.table, field: field.field, rowId: Number(actual[0][source.key]) }) as
      Brc38NativePackedBinaryCoordinate | Brc38NativePackedTextCoordinate
  }
  async #fieldBytes(table: Brc38NativeLocalBaselineTable, rowId: number, field: Field): Promise<number | null> {
    this.#assert()
    const local = await this.#localPackedKey(rowId, field)
    if (local !== undefined)
      return (
        (field.kind === 'blob'
          ? await readBrc38NativePackedDescriptor(this.#trx, local as Brc38NativePackedBinaryCoordinate)
          : await readBrc38NativePackedTextDescriptor(this.#trx, local as Brc38NativePackedTextCoordinate)
        )?.bytes ?? null
      )
    if (field.local !== undefined)
      return await readBrc38NativeLocalFieldBytes(
        this.#trx,
        { table: field.local, field: field.field, rowId } as Brc38NativeLocalFieldCoordinate,
        this.#policy.signal
      )
    if (field.text !== undefined)
      return await readBrc38NativeTextBytes(
        this.#trx,
        { table: field.text, field: field.field as Brc38NativeTextRead['field'], rowId },
        this.#policy.signal
      )
    if (field.binary === undefined) invalid()
    if (await hasBrc38NativePackedSchema(this.#trx))
      return (
        (
          await readBrc38NativePackedDescriptor(this.#trx, {
            table: field.binary,
            field: field.field as Brc38NativeBlobRead['field'],
            rowId
          })
        )?.bytes ?? null
      )
    return await readBrc38NativeLocalFieldBytes(
      this.#trx,
      { table, field: field.field, rowId } as Brc38NativeLocalFieldCoordinate,
      this.#policy.signal
    )
  }
  async #withField<T>(
    table: Brc38NativeLocalBaselineTable,
    rowId: number,
    field: Field,
    offset: number,
    totalBytes: number,
    length: number,
    work: (bytes: Uint8Array) => Promise<T>
  ): Promise<T> {
    const local = await this.#localPackedKey(rowId, field)
    if (field.local !== undefined && local === undefined)
      return await withBrc38NativeLocalFieldExtent(
        this.#trx,
        {
          table: field.local,
          field: field.field,
          rowId,
          offset,
          totalBytes,
          length
        } as Brc38NativeLocalFieldCoordinate & { offset: number; totalBytes: number; length: number },
        this.#policy.workingAllocation,
        async bytes => {
          this.#assert()
          const value = await work(bytes)
          this.#assert()
          return value
        },
        this.#policy.signal
      )
    if (local === undefined && field.text === undefined && !(await hasBrc38NativePackedSchema(this.#trx)))
      return await withBrc38NativeLocalFieldExtent(
        this.#trx,
        { table, field: field.field, rowId, offset, totalBytes, length } as Brc38NativeLocalFieldCoordinate & {
          offset: number
          totalBytes: number
          length: number
        },
        this.#policy.workingAllocation,
        async bytes => {
          this.#assert()
          const value = await work(bytes)
          this.#assert()
          return value
        },
        this.#policy.signal
      )
    const charge = this.#policy.workingAllocation.claim(4096 + 32 * length)
    let bytes: Uint8Array | undefined
    try {
      bytes =
        local !== undefined
          ? field.kind === 'blob'
            ? await readBrc38NativePackedExtent(
                this.#trx,
                { ...(local as Brc38NativePackedBinaryCoordinate), offset, totalBytes, length },
                this.#policy.signal
              )
            : await readBrc38NativePackedTextExtent(
                this.#trx,
                { ...(local as Brc38NativePackedTextCoordinate), offset, totalBytes, length },
                this.#policy.signal
              )
          : field.text !== undefined
            ? await readBrc38NativeTextExtent(
                this.#trx,
                {
                  table: field.text,
                  field: field.field as Brc38NativeTextRead['field'],
                  rowId,
                  offset,
                  totalBytes,
                  length
                },
                this.#policy.signal
              )
            : await readBrc38NativePackedExtent(
                this.#trx,
                {
                  table: field.binary!,
                  field: field.field as Brc38NativeBlobRead['field'],
                  rowId,
                  offset,
                  totalBytes,
                  length
                },
                this.#policy.signal
              )
      this.#assert()
      if (bytes.byteLength !== length || (await this.#fieldBytes(table, rowId, field)) !== totalBytes) invalid()
      const result = await work(bytes)
      this.#assert()
      return result
    } finally {
      bytes?.fill(0)
      charge.close()
    }
  }
  /** Full historical source after durable retirement. Actual inventory/kernel
   * membership and the original readonly transaction supply lifecycle. Fresh
   * schema, physical backend, profile, primary and all48 generation reads must
   * match the immutable retirement coordinates; no report can enroll a source.
   * This variant has no StorageProvider and cannot inspectCurrent, acquire a
   * source writer, assert a manager or retire the original provider again. */
  static async withRetired<T>(
    reader: Brc38RetiredNativeReadNode,
    selectedReceipt: SnapshotJournalReceiptPolicy,
    selected: Brc38NativeLocalBaselinePolicy,
    work: (source: Brc38NativeLocalBaselineSource) => Promise<T>
  ): Promise<T> {
    const policy = Object.freeze({ ...selected }),
      receipt = Object.freeze({ ...snapshotJournalReceiptPolicy(selectedReceipt) })
    if (
      brc38WorkingAllocation(policy.workingAllocation) === undefined ||
      typeof work !== 'function' ||
      !Number.isSafeInteger(policy.maximumMetadataBytes) ||
      policy.maximumMetadataBytes < 1 ||
      policy.maximumMetadataBytes > 131072 ||
      !Number.isSafeInteger(policy.maximumReadBytes) ||
      policy.maximumReadBytes < 1 ||
      policy.maximumReadBytes > 16384 ||
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.expiresAt <= Date.now()
    )
      invalid()
    policy.signal?.throwIfAborted()
    const charge = policy.workingAllocation.claim(1048576)
    try {
      return await Brc38RetiredNativeReadNode.withWalletRead(reader, async (trx, original) => {
        const check = (): void =>
          Brc38RetiredNativeReadNode.assertReadOwner(
            reader,
            trx,
            policy.workingAllocation,
            policy.expiresAt,
            policy.maximumReadBytes,
            policy.signal
          )
        check()
        const selected: Readonly<Brc38DestinationSelection> = Object.freeze({ ...original.binding, mode: 'merge' }),
          path = await realpath(join(original.directory, 'wallet.sqlite')),
          backend: SnapshotJournalCaptureBackend = {
            kind: 'sqlite',
            file: { path, device: original.wallet.device, inode: original.wallet.inode }
          },
          connection = await trx.client.acquireConnection(),
          backendSha256 = await bindSnapshotJournalDestinationBackend(trx, connection, backend),
          fence = await readBrc38KnexRetainedSourceFence(trx, backendSha256, selected, receipt),
          generation = await readBrc38NativeLocalBaselineGeneration(trx),
          retired = original.retirement.source
        check()
        if (
          !generation.enabled ||
          !generation.complete ||
          generation.epoch !== retired.epoch ||
          generation.revision !== retired.revision ||
          fence.userId === null ||
          fence.activeStorage !== selected.targetStorageIdentityKey ||
          fence.primaryEpoch !== retired.primaryEpoch
        )
          invalid()
        const users = (await trx('users').select('userId').limit(2)) as Array<{ userId: number }>
        if (users.length !== 1 || users[0].userId !== fence.userId) invalid()
        await verifySnapshotJournalDestinationSchema(trx)
        if (
          JSON.stringify(await readBrc38KnexRetainedSourceFence(trx, backendSha256, selected, receipt)) !==
            JSON.stringify(fence) ||
          JSON.stringify(await readBrc38NativeLocalBaselineGeneration(trx)) !== JSON.stringify(generation)
        )
          invalid()
        check()
        const source = new Brc38NativeLocalBaselineSource(issuer, fence, generation, trx, policy, original.deadline, {
          retired: reader
        })
        Object.freeze(source)
        try {
          const result = await source.#io.retain(async () => {
            source.#assert()
            return await work(source)
          })
          await source.#currentGeneration()
          check()
          return result
        } finally {
          source.#live = false
        }
      })
    } finally {
      charge.close()
    }
  }
  static async with<T>(
    storage: StorageKnex,
    selection: Brc38DestinationSelection,
    receiptPolicy: SnapshotJournalReceiptPolicy,
    selected: Brc38NativeLocalBaselinePolicy,
    work: (source: Brc38NativeLocalBaselineSource) => Promise<T>
  ): Promise<T> {
    const policy = Object.freeze({ ...selected }),
      destination = brc38DestinationSelection(selection),
      receipt = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) }),
      deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
    brc38WorkingAllocation(policy.workingAllocation)
    if (
      destination.mode !== 'merge' ||
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.expiresAt <= Date.now() ||
      !Number.isSafeInteger(policy.maximumMetadataBytes) ||
      policy.maximumMetadataBytes < 1 ||
      policy.maximumMetadataBytes > 131072 ||
      !Number.isSafeInteger(policy.maximumReadBytes) ||
      policy.maximumReadBytes < 1 ||
      policy.maximumReadBytes > 16384
    )
      invalid()
    policy.signal?.throwIfAborted()
    // The original shared allowance owns schema/observer construction and
    // metadata framing before any read facade or generation inspection starts.
    const charge = policy.workingAllocation.claim(1048576)
    try {
      return await withBrc38KnexImportReadDestination(storage, destination, receipt, async (trx, fence) => {
        requireBrc38NativeProfileTransaction(trx)
        if (fence.userId === null) invalid()
        const generation = await readBrc38NativeLocalBaselineGeneration(trx)
        if (!generation.enabled || !generation.complete) invalid()
        await verifySnapshotJournalDestinationSchema(trx)
        const source = new Brc38NativeLocalBaselineSource(issuer, fence, generation, trx, policy, deadline, {
          storage,
          receiptPolicy: receipt
        })
        Object.freeze(source)
        try {
          const value = await source.#io.retain(async () => {
            source.#assert()
            return await work(source)
          })
          await source.#currentGeneration()
          return value
        } finally {
          source.#live = false
        }
      })
    } finally {
      charge.close()
    }
  }
}
