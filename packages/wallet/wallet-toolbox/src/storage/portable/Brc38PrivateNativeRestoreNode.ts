import {
  compactBrc38NativeTargetIndexes,
  brc38NativeTargetIndexCompactionMigration
} from './Brc38NativeTargetIndexCompactionNode'
import {
  brc38NativeLocalPackedLayoutMigration,
  installBrc38NativeLocalPackedLayout
} from './Brc38NativeLocalPackedLayoutNode'
import {
  nativeSnapshotSyncMappingMigration,
  installNativeSnapshotSyncMappingSchema
} from '../snapshot/NativeSnapshotSyncMappingSchemaNode'
import {
  brc38NativePreparedFieldsMigration,
  installBrc38NativePreparedFieldsSchema
} from './Brc38NativePreparedFieldSchemaNode'
import {
  brc38NativePackedMigration,
  installBrc38NativePackedSchema,
  hasBrc38NativePackedSchema
} from './Brc38NativePackedSchemaNode'
import {
  brc38StructuredNativeReceiverMigration,
  installBrc38StructuredNativeReceiverSchema,
  verifyBrc38StructuredNativeReceiverSchema
} from './Brc38StructuredNativeReceiverSchemaNode'
import {
  brc38NativeTailLayoutMigration,
  installBrc38NativeTailLayout,
  verifyBrc38NativeTailLayout
} from './Brc38NativeTailLayoutNode'
import { inspectBrc38PrivateStreamedNativeInventory } from './Brc38StreamedNativeInventoryNode'
import { inspectBrc38PrivateStructuredNativeInventory } from './Brc38StructuredNativeInventoryNode'
import {
  brc38StructuredRestoreResources,
  brc38StructuredRestoreResourceData,
  type Brc38PrivateStructuredRestoreResources
} from './Brc38StructuredRestoreResourcesNode'
export type { Brc38PrivateStructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import {
  installBrc38ImportStreamedProvenanceSchema,
  verifyBrc38ImportStreamedProvenanceSchema
} from './Brc38ImportStreamedProvenanceNode'
import {
  commitBrc38PrivateStreamedRestorePage,
  commitBrc38PrivateStructuredRestorePage
} from './Brc38PrivateImportJournalNode'
import { randomUUID, createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { KnexMigrations, SNAPSHOT_JOURNAL_SOURCE_MIGRATION } from '../schema/KnexMigrations'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { registerBrc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'
import { installBrc38ImportTargetIndexes, verifyBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { installBrc38ImportJournalSchema, verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { installBrc38ImportProvenanceSchema, verifyBrc38ImportProvenanceSchema } from './Brc38ImportProvenanceNode'
import {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from '../snapshot/journal/SnapshotJournalBootstrap'
import { MAX_SNAPSHOT_JOURNAL_REVISION, snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { runInSeries } from '../../utility/runInSeries'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportRestorePage
} from './Brc38PrivateImportJournalNode'
import {
  readBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournal'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { completeBrc38OwnedEmptyBootstrap } from './Brc38PrivateEmptyBootstrapNode'
import { createBrc38PrivateSchemaMigrationSource } from './Brc38PrivateSchemaMigrationNode'

export interface Brc38PrivateNativeRestoreOptions {
  readonly receiptPolicy: SnapshotJournalReceiptPolicy
  readonly maximumStepRows: number
  readonly maximumStepBytes: number
  readonly maximumMappedIds: number
  readonly maximumJournalLogicalBytes: number
  readonly services: WalletServices
}
export interface Brc38PrivateStructuredNativeRestoreOptions extends Brc38PrivateNativeRestoreOptions {
  readonly structuredResources: Brc38PrivateStructuredRestoreResources
}
const protocol = 'brc38-private-native-restore/v1'
// Fresh private schema only: auxiliary indexes precede the immutable October 2
// source-generation seal. This is not an existing-wallet forward migration.
const migration = '2026-10-01-999 private native restore candidate'
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function fixedOptions(value: Brc38PrivateNativeRestoreOptions) {
  return Object.freeze({
    receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(value.receiptPolicy) }),
    maximumStepRows: value.maximumStepRows,
    maximumStepBytes: value.maximumStepBytes,
    maximumMappedIds: value.maximumMappedIds,
    maximumJournalLogicalBytes: value.maximumJournalLogicalBytes
  })
}
function validateOptions(options: ReturnType<typeof fixedOptions>, store: KnexBrc38StagingStore): void {
  for (const [value, minimum, maximum] of [
    [options.maximumStepRows, 1, 4096],
    [options.maximumStepBytes, 1, Math.min(16777216, store.limits.maximumRowAllocationBytes)],
    [options.maximumMappedIds, 0, store.limits.maximumRows],
    [options.maximumJournalLogicalBytes, 4096, Number.MAX_SAFE_INTEGER]
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new RangeError('Invalid fixed private native restore policy')
  }
}
export async function installBrc38PrivateNativeCandidateSchema(
  storage: StorageKnex,
  store: KnexBrc38StagingStore,
  targetIdentity: string,
  options: ReturnType<typeof fixedOptions>,
  streamed = false,
  structured = false,
  localBaseline = false,
  beforeJournal?: (storage: StorageKnex) => Promise<void>
): Promise<void> {
  store.assertPrivateNativeDestination(store.knex)
  if (
    !(storage instanceof StorageKnex) ||
    storage.knex !== store.knex ||
    store.binding === undefined ||
    targetIdentity !== store.binding.binding.targetStorageIdentityKey ||
    storage.chain !== store.binding.binding.chain ||
    typeof streamed !== 'boolean' ||
    typeof structured !== 'boolean' ||
    typeof localBaseline !== 'boolean'
  )
    throw new Error('Private candidate schema requires its original stage and explicit profile')
  options = Object.freeze({
    receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(options.receiptPolicy) }),
    maximumStepRows: options.maximumStepRows,
    maximumStepBytes: options.maximumStepBytes,
    maximumMappedIds: options.maximumMappedIds,
    maximumJournalLogicalBytes: options.maximumJournalLogicalBytes
  })
  validateOptions(options, store)
  if ((structured && !streamed) || (localBaseline && !structured))
    throw new Error('Local/structured bootstrap requires its explicit field-aware receiver')
  const source = new KnexMigrations(storage.chain, 'Private authenticated restore', targetIdentity, 1024)
  if (streamed)
    source.migrations[brc38NativeTailLayoutMigration] = {
      up: async token => await installBrc38NativeTailLayout(token as Knex.Transaction),
      down: async () => {
        throw new Error('Private streamed layout requires owned forward recovery')
      }
    }
  if (streamed)
    source.migrations[brc38NativeTargetIndexCompactionMigration] = {
      up: async token => await compactBrc38NativeTargetIndexes(token as Knex.Transaction),
      down: async () => {
        throw new Error('Fresh private target indexes require owned forward recovery')
      }
    }
  if (streamed)
    source.migrations[brc38NativePackedMigration] = {
      up: async token => await installBrc38NativePackedSchema(token as Knex.Transaction),
      down: async () => {
        throw new Error('Private packed native fields require owned forward recovery')
      }
    }
  source.migrations[structured ? migration + ' structured-v5' : streamed ? migration + ' streamed-v4' : migration] = {
    up: async token => {
      const trx = token as Knex.Transaction
      await installBrc38ImportTargetIndexes(trx)
      await installBrc38ImportJournalSchema(trx)
      await installBrc38ImportProvenanceSchema(trx)
      if (streamed) await installBrc38ImportStreamedProvenanceSchema(trx)
      await trx.schema.createTable('private_native_restore', table => {
        table.integer('slot').primary()
        table.string('protocol', 64).notNullable()
        table.string('bindingSha256', 64).notNullable()
        table.text('policyJson').notNullable()
        table.text('admissionJson').nullable()
        table.string('admissionSha256', 64).nullable()
      })
    },
    down: async () => {
      throw new Error('Private native restore requires owned forward recovery')
    }
  }
  if (structured)
    source.migrations[brc38StructuredNativeReceiverMigration] = {
      up: async token => await installBrc38StructuredNativeReceiverSchema(token as Knex.Transaction),
      down: async () => {
        throw new Error('Private structured receiver requires owned forward recovery')
      }
    }
  if (structured)
    source.migrations[brc38NativePreparedFieldsMigration] = {
      up: async token => await installBrc38NativePreparedFieldsSchema(token as Knex.Transaction),
      down: async () => {
        throw new Error('Native prepared field lifetimes require owned profile retirement')
      }
    }
  if (structured)
    source.migrations[nativeSnapshotSyncMappingMigration] = {
      up: async token => await installNativeSnapshotSyncMappingSchema(token as Knex.Transaction),
      down: async () => {
        throw new Error('Native sync mapping fences require owned forward recovery')
      }
    }
  if (localBaseline)
    source.migrations[brc38NativeLocalPackedLayoutMigration] = {
      up: async token => await installBrc38NativeLocalPackedLayout(token as Knex.Transaction),
      down: async () => {
        throw new Error('Private local packed receiver requires owned forward recovery')
      }
    }
  // Private candidates retain the caller's original receipt policy and finite
  // empty bootstrap after every optional layout is installed. Ordinary source
  // migrations keep their original callback, policy and chronological order.
  source.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION] = {
    config: { transaction: false },
    up: async token => {
      if (token !== storage.knex || token !== store.knex)
        throw new Error('Private native journal requires its original candidate root')
      // Earlier table migrations need FK enforcement disabled for their DDL.
      // This final step is nontransactional and runs real content operations;
      // their declared cascades must be active before any callback or bootstrap.
      await storage.knex.raw('PRAGMA foreign_keys=ON')
      const foreignKeys = (await storage.knex.raw('PRAGMA foreign_keys')) as Array<{ foreign_keys: number }>
      if (foreignKeys.length !== 1 || foreignKeys[0].foreign_keys !== 1)
        throw new Error('Private native runtime requires actual foreign-key enforcement')
      // Internal qualification fixtures exercise the genuine fresh receiver
      // before its source generation is sealed. A failed callback leaves an
      // unfinished private candidate; it cannot publish or activate a profile.
      if (beforeJournal !== undefined) await beforeJournal(storage)
      await completePrivateNativeCandidateJournal(storage, store, options.receiptPolicy)
    },
    down: async () => {
      throw new Error('Private native journal requires owned forward recovery')
    }
  }
  await storage.knex.raw('PRAGMA foreign_keys=OFF')
  let migrationFailed = false,
    migrationFailure: unknown
  try {
    await storage.knex.migrate.latest({
      migrationSource: createBrc38PrivateSchemaMigrationSource(store, source, true),
      disableTransactions: false
    })
  } catch (cause) {
    migrationFailed = true
    migrationFailure = cause
  }
  try {
    await storage.knex.raw('PRAGMA foreign_keys=ON')
  } catch (error_) {
    if (migrationFailed)
      throw new AggregateError(
        [migrationFailure, error_],
        'Private native migration retains foreign-key restoration failure',
        { cause: migrationFailure }
      )
    throw error_
  }
  if (migrationFailed) throw migrationFailure
  await storage.knex.transaction(async trx => {
    await verifyBrc38ImportTargetIndexes(trx)
    await verifyBrc38ImportJournalSchema(trx)
    await verifyBrc38ImportProvenanceSchema(trx)
    if (streamed) {
      await verifyBrc38ImportStreamedProvenanceSchema(trx)
      await verifyBrc38NativeTailLayout(trx)
      if (!(await hasBrc38NativePackedSchema(trx))) throw new Error('Private packed native schema is unavailable')
      if (structured) await verifyBrc38StructuredNativeReceiverSchema(trx)
    }
  })
  await storage.makeAvailable()
  await completePrivateNativeCandidateJournal(storage, store, options.receiptPolicy)
}

async function completePrivateNativeCandidateJournal(
  storage: StorageKnex,
  store: KnexBrc38StagingStore,
  receiptPolicy: SnapshotJournalReceiptPolicy
): Promise<void> {
  await installSnapshotJournalSqliteGeneration(
    storage.knex,
    snapshotJournalRevision(MAX_SNAPSHOT_JOURNAL_REVISION),
    receiptPolicy
  )
  const maximumRecords = 1000
  let complete = await completeBrc38OwnedEmptyBootstrap(store, receiptPolicy)
  // Every nonempty page consumes at least one of the original 1000 records;
  // each of the original seventeen streams also needs its terminal empty page.
  // Keep that exact row allowance and the native owner's original deadline.
  function* remainingPages() {
    for (let remaining = maximumRecords + 17; !complete && remaining > 0; remaining--) yield undefined
  }
  await runInSeries(remainingPages(), async () => {
    store.assertPrivateNativeDestination(store.knex)
    const page = await copySnapshotJournalBootstrapPage(storage.knex, maximumRecords)
    if (page.invalidated) throw new Error('Private empty native destination bootstrap did not finish')
    complete = page.complete
    store.assertPrivateNativeDestination(store.knex)
  })
  if (!complete) throw new Error('Private empty native destination bootstrap did not finish')
  // Use the actual validated native completion receipt after its transaction
  // commits. Do not repeat a separate schema read or infer completion locally.
  const generation = await completeSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  if (!generation.complete || !generation.enabled)
    throw new Error('Private native destination generation is unavailable')
}

/** Isolated RESTORE component. Native wallet tables live inside the existing
 * claimed private stage, under its original hard page limit and deadline.
 * The facade deliberately has no WalletStorageProvider or activation method.
 * A separate explicit publication component owns the durable copied profile.
 * Full inventory publication, occupied-target MERGE isolation, registered migration,
 * owned cleanup/process-loss and complete program qualification remain required. */
export class Brc38PrivateNativeRestoreNode {
  readonly #store: KnexBrc38StagingStore
  readonly #storage: StorageKnex
  readonly #options: ReturnType<typeof fixedOptions>
  readonly admission: Readonly<Brc38ImportJournalAdmission>
  private constructor(
    store: KnexBrc38StagingStore,
    storage: StorageKnex,
    options: ReturnType<typeof fixedOptions>,
    admission: Brc38ImportJournalAdmission,
    private readonly streamed = false,
    private readonly structured?: Readonly<Brc38PrivateStructuredRestoreResources>
  ) {
    this.#store = store
    this.#storage = storage
    this.#options = options
    this.admission = Object.freeze({ ...admission, scope: Object.freeze({ ...admission.scope }) })
  }
  static async open(
    store: KnexBrc38StagingStore,
    selected: Brc38PrivateNativeRestoreOptions
  ): Promise<Brc38PrivateNativeRestoreNode> {
    return await this.openOwned(store, selected, false)
  }
  /** Explicit actual native field-aware path; ordinary/legacy open retains its
   * whole-row fence. This facade never activates or advertises a provider. */
  static async openStreamed(
    store: KnexBrc38StagingStore,
    selected: Brc38PrivateNativeRestoreOptions
  ): Promise<Brc38PrivateNativeRestoreNode> {
    return await this.openOwned(store, selected, true)
  }
  /** Explicit v5 receiver: source and resource policies are captured before
   * I/O and persisted as replay DATA. Genuine current source/owner/schema/
   * destination checks still run independently for each operation. */
  static async openStructured(
    store: KnexBrc38StagingStore,
    selected: Brc38PrivateStructuredNativeRestoreOptions
  ): Promise<Brc38PrivateNativeRestoreNode> {
    const options = { ...fixedOptions(selected), services: selected.services },
      structured = brc38StructuredRestoreResources(
        store.limits,
        selected.structuredResources,
        options.maximumStepBytes,
        store.directory
      )
    return await this.openOwned(store, options, true, structured)
  }
  private static async openOwned(
    store: KnexBrc38StagingStore,
    selected: Brc38PrivateNativeRestoreOptions,
    streamed: boolean,
    structured?: Readonly<Brc38PrivateStructuredRestoreResources>
  ): Promise<Brc38PrivateNativeRestoreNode> {
    const receiverProtocol =
        structured !== undefined
          ? 'brc38-private-native-restore/v5'
          : streamed
            ? 'brc38-private-native-restore/v4'
            : protocol,
      destination =
        structured !== undefined
          ? store.withAuthenticatedPrivateStructuredDestination.bind(store)
          : streamed
            ? store.withAuthenticatedPrivateStreamedDestination.bind(store)
            : store.withAuthenticatedPrivateDestination.bind(store),
      options = Object.freeze({
        ...fixedOptions(selected),
        ...(structured === undefined
          ? {}
          : {
              structuredResources: brc38StructuredRestoreResourceData(structured)
            })
      }),
      services = selected.services,
      bound = store.binding
    if (bound === undefined) throw new Error('Private native restore requires an owned source binding')
    validateOptions(options, store)
    // Resource paths and bounds are replay DATA, but still must fit the
    // bounded policy cell before any destination DDL or pool work begins.
    if (Buffer.byteLength(JSON.stringify(options), 'utf8') > 4096)
      throw new RangeError('Private native restore policy exceeds its fixed metadata bound')
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions(bound.binding.chain),
      knex: store.knex,
      snapshotSync: false
    })
    storage.setServices(services)
    let userId = 0,
      rows = 0
    await destination(async (source, metadata) => {
      const sourceUserId = source.user.userId
      if (typeof sourceUserId !== 'number' || !Number.isSafeInteger(sourceUserId))
        throw new Error('Private native restore source user ID differs')
      userId = sourceUserId
      rows = metadata.rows
      // The destination is the owned stage itself, never the configured main.
      if (await store.knex.schema.hasTable('private_native_restore'))
        await loadNativeAdmission(store.knex, bound.digest, JSON.stringify(options), receiverProtocol)
      await installBrc38PrivateNativeCandidateSchema(
        storage,
        store,
        bound.binding.targetStorageIdentityKey,
        options,
        streamed,
        structured !== undefined
      )
      if ((await storage.makeAvailable()).storageIdentityKey !== bound.binding.targetStorageIdentityKey)
        throw new Error('Private native destination identity differs')
      const policyJson = JSON.stringify(options)
      await store
        .knex('private_native_restore')
        .insert({
          slot: 1,
          protocol: receiverProtocol,
          bindingSha256: bound.digest,
          policyJson,
          admissionJson: null,
          admissionSha256: null
        })
        .onConflict('slot')
        .ignore()
      await loadNativeAdmission(store.knex, bound.digest, policyJson, receiverProtocol)
    })
    registerBrc38PrivateDestinationLease(storage, store)
    const policyJson = JSON.stringify(options),
      existing = await loadNativeAdmission(store.knex, bound.digest, policyJson, receiverProtocol)
    let admission: Brc38ImportJournalAdmission
    if (existing?.admissionJson != null) {
      admission = JSON.parse(existing.admissionJson) as Brc38ImportJournalAdmission
    } else {
      const preview = await previewBrc38PrivateImport(store, storage, 'restore', options.receiptPolicy)
      admission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: bound.digest,
          archiveSha256: bound.binding.archiveSha256,
          userId
        },
        previewId: preview.previewId,
        originalLimitsJson: bound.limitsJson,
        expiresAt: preview.expiresAt,
        initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
        totalRows: rows + 1,
        maximumStepRows: options.maximumStepRows,
        maximumStepBytes: options.maximumStepBytes,
        maximumMappedIds: options.maximumMappedIds,
        maximumJournalLogicalBytes: options.maximumJournalLogicalBytes
      }
      const json = JSON.stringify(admission)
      if (Buffer.byteLength(json) > 4096) throw new Error('Private native admission exceeds its fixed receipt bound')
      await destination(async () => {
        await store
          .knex('private_native_restore')
          .where({ slot: 1, admissionJson: null })
          .update({ admissionJson: json, admissionSha256: digest(json) })
        if ((await loadNativeAdmission(store.knex, bound.digest, policyJson, receiverProtocol))?.admissionJson !== json)
          throw new Error('Private native restore admission differs')
      })
    }
    await prepareBrc38PrivateImportJournal(store, storage, {
      admission,
      receiptPolicy: options.receiptPolicy,
      streamed,
      structured: structured !== undefined
    })
    return new Brc38PrivateNativeRestoreNode(store, storage, options, admission, streamed, structured)
  }
  async step(fromRow: number, signal?: AbortSignal): Promise<Readonly<Brc38ImportJournalReceipt>> {
    if (this.structured !== undefined) {
      const operationSignal = signal ?? this.structured.sourcePolicy.signal
      if (this.structured.sourcePolicy.signal !== undefined && this.structured.sourcePolicy.signal !== operationSignal)
        throw new RangeError('Structured restore operation changed its captured cancellation scope')
      return await commitBrc38PrivateStructuredRestorePage(this.#store, this.#storage, {
        admission: this.admission,
        receiptPolicy: this.#options.receiptPolicy,
        fromRow,
        signal: operationSignal,
        sourcePolicy: { ...this.structured.sourcePolicy, signal: operationSignal },
        projectionPolicy: { ...this.structured.projectionPolicy, signal: operationSignal }
      })
    }
    const commit = this.streamed ? commitBrc38PrivateStreamedRestorePage : commitBrc38PrivateImportRestorePage
    return await commit(this.#store, this.#storage, {
      admission: this.admission,
      receiptPolicy: this.#options.receiptPolicy,
      fromRow,
      signal
    })
  }
  async status(): Promise<Readonly<Brc38ImportJournalReceipt>> {
    const view =
      this.structured !== undefined
        ? this.#store.withAuthenticatedStructuredImportView.bind(this.#store)
        : this.streamed
          ? this.#store.withAuthenticatedStreamedImportView.bind(this.#store)
          : this.#store.withAuthenticatedImportView.bind(this.#store)
    return await view(
      async () =>
        await withBrc38KnexImportReadDestination(
          this.#storage,
          { ...this.#store.binding!.binding, mode: 'restore' },
          this.#options.receiptPolicy,
          async trx => await readBrc38ImportJournal(trx, this.admission)
        )
    )
  }
  /** Complete private inventory inspection DATA; no publication grant or
   * reusable inventory verdict. Actual destination/source fences are retained. */
  async inspectInventory(
    signal?: AbortSignal
  ): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
    if (!this.streamed) throw new Error('Field-aware inventory requires the explicit streamed receiver')
    const destination =
      this.structured !== undefined
        ? this.#store.withAuthenticatedPrivateStructuredDestination.bind(this.#store)
        : this.#store.withAuthenticatedPrivateStreamedDestination.bind(this.#store)
    return await destination(
      async () =>
        await withBrc38KnexImportReadDestination(
          this.#storage,
          { ...this.#store.binding!.binding, mode: 'restore' },
          this.#options.receiptPolicy,
          async (trx, actual) => {
            const receipt = await readBrc38ImportJournal(trx, this.admission)
            if (brc38ImportDestinationDigest(actual) !== receipt.destinationSha256)
              throw new Error('Streamed native inventory destination checkpoint differs')
            if (this.structured !== undefined) {
              const operationSignal = signal ?? this.structured.sourcePolicy.signal
              if (
                this.structured.sourcePolicy.signal !== undefined &&
                this.structured.sourcePolicy.signal !== operationSignal
              )
                throw new RangeError('Structured inventory changed its captured cancellation scope')
              return await inspectBrc38PrivateStructuredNativeInventory(
                trx,
                this.admission,
                {
                  sourcePolicy: { ...this.structured.sourcePolicy, signal: operationSignal },
                  projectionPolicy: { ...this.structured.projectionPolicy, signal: operationSignal },
                  maximumCombinedTemporaryBytes: this.structured.maximumCombinedTemporaryBytes,
                  inspectionExpiresAt: this.admission.expiresAt,
                  privateSource: this.#store
                },
                operationSignal
              )
            }
            return await inspectBrc38PrivateStreamedNativeInventory(trx, this.admission, signal)
          }
        )
    )
  }
  async close(): Promise<void> {
    await this.#store.close()
  }
  async publish(parentDirectory: string, signal?: AbortSignal): Promise<Brc38PublishedProfileNode> {
    if (this.streamed)
      throw new Error('Streamed native publication requires publishManaged with a durable profile inventory')
    return await Brc38PublishedProfileNode.publish(parentDirectory, this.#store, this.admission, signal)
  }
  /** Publish into an actual durable managed inventory. The independently
   * copied all13 packed inventory must validate before READY commits. This
   * does not activate the wallet: callers subsequently acquire the actual
   * native profile claim and explicitly select that managed profile. */
  async publishManaged(root: Brc38ProfileInventoryNode, signal?: AbortSignal): Promise<Brc38PublishedProfileNode> {
    if (this.structured !== undefined)
      return await Brc38ProfileInventoryNode.publishCompletedStructuredRestore(
        root,
        this.#store,
        this.admission,
        this.structured,
        signal
      )
    return await Brc38ProfileInventoryNode.publishCompletedRestore(root, this.#store, this.admission, signal)
  }
  /** Dispose the actual claimed file, including native rows and originals.
   * The catalog verifies scope and releases capacity only after physical removal.
   * A handed-off closed claim must be reclaimed before it can be disposed. */
  async discard(root: Brc38StagingAdmissionNode, reservationId: string, cause: unknown): Promise<void> {
    await root.discard({ id: reservationId, store: this.#store }, cause)
  }
}
async function loadNativeAdmission(k: Knex, bindingSha256: string, policyJson: string, expectedProtocol = protocol) {
  const values: Array<{
    protocol: string
    bindingSha256: string
    policyJson: string
    admissionJson: string | null
    admissionSha256: string | null
  }> = await k('private_native_restore')
    .where({ slot: 1 })
    .select(
      ...['protocol', 'bindingSha256', 'policyJson', 'admissionJson', 'admissionSha256'].map(field =>
        k.raw('CASE WHEN length(CAST(?? AS BLOB)) <= 4096 THEN ?? ELSE NULL END AS ??', [field, field, field])
      )
    )
    .limit(2)
  const value = values.at(0)
  if (
    values.length !== 1 ||
    value?.protocol !== expectedProtocol ||
    value.bindingSha256 !== bindingSha256 ||
    value.policyJson !== policyJson ||
    (value.admissionJson === null
      ? value.admissionSha256 !== null
      : digest(value.admissionJson) !== value.admissionSha256)
  )
    throw new Error('Private native restore binding, policy or admission differs')
  return value
}
