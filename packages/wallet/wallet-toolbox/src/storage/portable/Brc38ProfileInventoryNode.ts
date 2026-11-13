import { promiseFromSync } from '../../utility/promiseFromSync'
import {
  requirePrivatePath,
  requirePrivateDescriptor,
  createPrivateFile,
  closePrivateDescriptor,
  syncPrivateDirectory
} from './Brc38PrivateFilesystemNode'
import { Brc39RecoveryIncomingComparisonNode } from './Brc39RecoveryIncomingComparisonNode'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import {
  WalletStorageManager,
  type WalletStorageProviderTransition,
  type WalletStorageProviderTransitionPolicy
} from '../WalletStorageManager'
import { StorageKnex } from '../StorageKnex'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import createKnex, { type Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import { type KnexBrc38StagingStore, type KnexBrc38StagingLimits } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import {
  brc38StructuredRestoreResources,
  type Brc38PrivateStructuredRestoreResources
} from './Brc38StructuredRestoreResourcesNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38RetiredNativeReadNode, type Brc38RetiredNativeReadPolicy } from './Brc38RetiredNativeReadNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import {
  Brc38StagingCleanupError,
  closeBrc38UnpooledConnection,
  drainBrc38FailedConnections
} from './Brc38StagingCleanupError'
import type { Brc38NativeRecoveryScratchNode, Brc38NativeRecoveryScratchPolicy } from './Brc38NativeRecoveryScratchNode'
import {
  Brc38PublishedProfileNode,
  type Brc38ProfileInventoryBinding,
  type Brc38NativeProfileTransferClaim,
  type Brc38NativeProfileTransferReceipt,
  type Brc38ComposedTargetInspection,
  type Brc38ComposedTargetInspectionFacts,
  type Brc38PendingNativeManagerRecovery
} from './Brc38PublishedProfileNode'
import {
  createBrc38ProfileCreationGrant,
  createBrc38ProfileRetirementGrant,
  createBrc38ProfileWithdrawalGrant,
  registerBrc38InventoryPublishedProfile
} from './Brc38ProfileInventoryClaimNode'

const inventoryIssuer = Symbol('original profile inventory constructor')
const actualInventories = new WeakSet<Brc38ProfileInventoryNode>()
const reopenBrand: unique symbol = Symbol('actual native inventory reopen')
export interface Brc38NativeProfileReopenGrant {
  readonly [reopenBrand]: true
}
interface NativeReopen {
  readonly root: Brc38ProfileInventoryNode
  readonly entry: Entry
  readonly inventory: Brc38ProfileInventoryBinding
  profile?: Brc38PublishedProfileNode
  state: 'issued' | 'retained' | 'committed' | 'closed'
}
const nativeReopens = new WeakMap<Brc38NativeProfileReopenGrant, NativeReopen>()
const retiredReadBrand: unique symbol = Symbol('actual retired inventory read')
export interface Brc38RetiredNativeReadGrant {
  readonly [retiredReadBrand]: true
}
const retiredReads = new WeakMap<
  Brc38RetiredNativeReadGrant,
  {
    readonly root: Brc38ProfileInventoryNode
    readonly entry: Entry
    readonly policy: Readonly<Brc38RetiredNativeReadPolicy>
    readonly deadline: number
    live: boolean
  }
>()
const catalogName = 'profile-inventory.sqlite'
const catalogBytes = 1048576
const catalogReservation = 3 * catalogBytes
const protocol = 'brc38-profile-inventory/v1'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
type State = 'reserved' | 'published' | 'retiring' | 'withdrawing'
export interface Brc38ProfileInventoryCapacity {
  readonly maximumProfiles: number
  /** Conservative catalog/journal reservation plus all fixed profile limits. */
  readonly maximumPhysicalBytes: number
}
interface Fixed {
  inventory: Brc38ProfileInventoryBinding
  binding: Brc38StagingBinding
  bindingSha256: string
  limits: KnexBrc38StagingLimits
  admission: Brc38ImportJournalAdmission
}
interface Entry {
  id: string
  importId: string
  bindingSha256: string
  expiresAt: number
  maximumPhysicalBytes: number
  state: State
  fixedJson: string
  fixedSha256: string
}
export interface Brc38ProfileInventoryUsage {
  profiles: number
  published: number
  reservedPhysicalBytes: number
}
function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid fixed profile inventory capacity')
}
function policy(selected: Brc38ProfileInventoryCapacity): string {
  integer(selected.maximumProfiles, 1, 128)
  integer(selected.maximumPhysicalBytes, catalogReservation + 1048576)
  return JSON.stringify([selected.maximumProfiles, selected.maximumPhysicalBytes])
}
function hash(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}
function sameFile(a: Pick<BigIntStats, 'dev' | 'ino'>, b: Pick<BigIntStats, 'dev' | 'ino'>): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
async function directoryStat(directory: string): Promise<BigIntStats> {
  return await requirePrivatePath(directory, true)
}
async function fileStat(filename: string): Promise<BigIntStats> {
  const stat = await requirePrivatePath(filename, false)
  if (stat.size > BigInt(catalogBytes)) throw new Error('Profile inventory catalog bound differs')
  return stat
}
async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}
async function syncDirectory(directory: string): Promise<void> {
  await syncPrivateDirectory(directory)
}
function database(directory: string): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, catalogName) },
    useNullAsDefault: true,
    acquireConnectionTimeout: 1000,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (
        connection: { exec: (sql: string) => unknown; close: () => unknown },
        done: (error: Error | null, value?: unknown) => void
      ) => {
        try {
          connection.exec(
            'PRAGMA page_size=4096; PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON; PRAGMA max_page_count=256;'
          )
          done(null, connection)
        } catch (cause) {
          done(closeBrc38UnpooledConnection(connection, cause, 'Profile inventory setup failed'))
        }
      }
    }
  })
}

/** Prospective Node profile inventory. Fixed capacity is durably reserved before
 * directory/native creation. Actual profile kernel ownership continues after the
 * short catalog writer is released. Source copy never holds that global writer.
 * Permanent published profiles do not inherit an import-expiry deletion policy.
 * This component does not qualify concurrent WAL, migrations or total wallet resources. */
export class Brc38ProfileInventoryNode {
  #busy = false
  #closed = false
  readonly #inFlight = new Set<string>()
  readonly #profiles = new Map<string, Brc38PublishedProfileNode>()
  readonly #retiredReadCleanup = new Set<Brc38StagingCleanupError>()
  #retiredReadDraining = false
  readonly #db: Knex
  readonly #identity: BigIntStats
  readonly #catalogIdentity: BigIntStats
  private constructor(
    db: Knex,
    readonly directory: string,
    readonly capacity: Readonly<Brc38ProfileInventoryCapacity>,
    readonly rootId: string,
    identity: BigIntStats,
    catalogIdentity: BigIntStats,
    issuer: typeof inventoryIssuer
  ) {
    if (issuer !== inventoryIssuer) throw new Error('An actual profile inventory issuer is required')
    Object.defineProperties(this, {
      directory: { value: directory, enumerable: true, writable: false, configurable: false },
      capacity: { value: capacity, enumerable: true, writable: false, configurable: false },
      rootId: { value: rootId, enumerable: true, writable: false, configurable: false }
    })
    this.#db = db
    this.#identity = identity
    this.#catalogIdentity = catalogIdentity
  }
  /** Native transfer reads use the actual enrolled root and its original
   * per-import operation, physical catalog identity and committed published row. */
  static async assertNativeTransferInventory(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    inventory: Brc38ProfileInventoryBinding,
    bindingSha256: string
  ): Promise<void> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    await root.#exclusive((_trx, entries) => {
      return promiseFromSync(() => {
        const entry = entries.find(value => value.id === inventory.profileId)
        if (
          entry === undefined ||
          entry.state !== 'published' ||
          entry.bindingSha256 !== bindingSha256 ||
          root.#profiles.get(entry.id) !== profile ||
          !root.#inFlight.has(entry.importId) ||
          JSON.stringify(root.#inventory(entry.id)) !== JSON.stringify(inventory)
        )
          throw new Error('Native transfer requires the actual current published inventory operation')
      })
    })
  }
  /** Ongoing provider reads require current published membership, not a
   * transfer-operation scope that ended when activation returned. Transfer,
   * activation and physical handoff keep their stricter in-flight guard. */
  static async assertCurrentPublishedProfile(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    inventory: Brc38ProfileInventoryBinding,
    bindingSha256: string
  ): Promise<void> {
    if (!actualInventories.has(root)) throw new Error('An actual current profile inventory issuer is required')
    await root.#exclusive((_trx, entries) => {
      return promiseFromSync(() => {
        const entry = entries.find(value => value.id === inventory.profileId)
        if (
          entry === undefined ||
          entry.state !== 'published' ||
          entry.bindingSha256 !== bindingSha256 ||
          root.#profiles.get(entry.id) !== profile ||
          JSON.stringify(root.#inventory(entry.id)) !== JSON.stringify(inventory)
        )
          throw new Error('Provider read requires its actual current published inventory membership')
      })
    })
  }
  static async assertReleasedProfileAddress(
    root: Brc38ProfileInventoryNode,
    inventory: Brc38ProfileInventoryBinding,
    bindingSha256: string
  ): Promise<void> {
    if (!actualInventories.has(root)) throw new Error('Actual released current source inventory required')
    await root.#exclusive((_trx, entries) => {
      return promiseFromSync(() => {
        const entry = entries.find(value => value.id === inventory.profileId)
        if (
          entry?.state !== 'published' ||
          entry.bindingSha256 !== bindingSha256 ||
          JSON.stringify(root.#inventory(entry.id)) !== JSON.stringify(inventory) ||
          root.#profiles.get(entry.id)?.ownershipReleased === false
        )
          throw new Error('Released current source address has changed or retains a live owner')
      })
    })
  }
  async #nativeTransferEntry(profile: Brc38PublishedProfileNode): Promise<Entry> {
    return await this.#exclusive((_trx, entries) => {
      return promiseFromSync(() => {
        const entry = entries.find(value => this.#profiles.get(value.id) === profile)
        if (entry === undefined || entry.state !== 'published')
          throw new Error('Native transfer requires the actual current published inventory operation')
        return entry
      })
    })
  }
  /** Synchronous original operation membership only. Persisted published
   * entry/physical checks bracket the complete factory operation below. */
  static assertComposedTargetOperation(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    inventory: Brc38ProfileInventoryBinding,
    importId: string
  ): void {
    if (
      !actualInventories.has(root) ||
      root.#closed ||
      root.#retiredReadDraining ||
      root.#retiredReadCleanup.size !== 0 ||
      !root.#inFlight.has(importId) ||
      root.#profiles.get(inventory.profileId) !== profile ||
      JSON.stringify(root.#inventory(inventory.profileId)) !== JSON.stringify(inventory)
    )
      throw new Error('Composed target requires its actual current published inventory operation')
  }
  static withCurrentComposedTargetInspection<T>(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    work: (scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>
  ): Promise<T> {
    if (!actualInventories.has(root)) throw new Error('An actual composed profile inventory issuer is required')
    return root.#withComposedTargetInspection(profile, merge, store, source, work, 'current')
  }
  static withRetiredComposedTargetInspection<T>(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    work: (scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>
  ): Promise<T> {
    if (!actualInventories.has(root)) throw new Error('An actual composed profile inventory issuer is required')
    return root.#withComposedTargetInspection(profile, merge, store, source, work, 'retired')
  }
  static admitAndReplaceRetiredComposedTarget(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    original: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    transition: WalletStorageProviderTransition,
    executable: string,
    services: WalletServices
  ): Promise<StorageKnex> {
    if (!actualInventories.has(root)) throw new Error('Actual composed native target inventory required')
    const retain: WalletStorageManager['retainOriginalProviderTransition'] =
      WalletStorageManager.prototype.retainOriginalProviderTransition.bind(manager)
    return retain(transition, provider, async () => {
      const entry = await root.#nativeTransferEntry(profile)
      return await root.#operation(entry.importId, async () => {
        if (JSON.stringify(await root.#nativeTransferEntry(profile)) !== JSON.stringify(entry))
          throw new Error('Composed native target inventory changed before admission')
        const wallet = await Brc38PublishedProfileNode.admitAndReplaceRetiredComposedTarget(
          root,
          profile,
          merge,
          store,
          source,
          original,
          provider,
          manager,
          transition,
          executable,
          services
        )
        if (JSON.stringify(await root.#nativeTransferEntry(profile)) !== JSON.stringify(entry))
          throw new Error('Composed native target inventory changed during admission')
        return wallet
      })
    })
  }
  async #withComposedTargetInspection<T>(
    profile: Brc38PublishedProfileNode,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    work: (scope: Brc38ComposedTargetInspection, facts: Readonly<Brc38ComposedTargetInspectionFacts>) => Promise<T>,
    mode: 'current' | 'retired'
  ): Promise<T> {
    const entry = await this.#nativeTransferEntry(profile)
    return await this.#operation(entry.importId, async () => {
      if (JSON.stringify(await this.#nativeTransferEntry(profile)) !== JSON.stringify(entry))
        throw new Error('Composed target published inventory changed before inspection')
      const value =
        mode === 'current'
          ? await Brc38PublishedProfileNode.withCurrentComposedInspection(this, profile, merge, store, source, work)
          : await Brc38PublishedProfileNode.withRetiredComposedInspection(this, profile, merge, store, source, work)
      if (JSON.stringify(await this.#nativeTransferEntry(profile)) !== JSON.stringify(entry))
        throw new Error('Composed target published inventory changed during inspection')
      return value
    })
  }
  static async readNativeReopenGrant(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant
  ): Promise<
    Readonly<{
      directory: string
      bindingSha256: string
      originalFixedJson: string
      inventory: Brc38ProfileInventoryBinding
    }>
  > {
    const actual = nativeReopens.get(grant)
    if (
      !actualInventories.has(root) ||
      actual?.root !== root ||
      !['issued', 'retained', 'committed'].includes(actual.state) ||
      !root.#inFlight.has(actual.entry.importId)
    )
      throw new Error('An actual current inventory native reopen grant is required')
    const current = await root.#entry(actual.entry.importId, actual.entry.bindingSha256)
    if (current.state !== 'published' || JSON.stringify(current) !== JSON.stringify(actual.entry))
      throw new Error('Native reopen original inventory entry changed')
    root.#fixed(current)
    return Object.freeze({
      directory: join(root.directory, current.id),
      bindingSha256: current.bindingSha256,
      originalFixedJson: current.fixedJson,
      inventory: Object.freeze({ ...actual.inventory })
    })
  }
  static retainNativeReopenAttempt(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    profile: Brc38PublishedProfileNode
  ): void {
    const actual = nativeReopens.get(grant)
    if (
      !actualInventories.has(root) ||
      actual?.root !== root ||
      actual.state !== 'issued' ||
      !root.#inFlight.has(actual.entry.importId) ||
      root.#profiles.has(actual.entry.id)
    )
      throw new Error('An actual unclaimed inventory native reopen grant is required')
    Brc38PublishedProfileNode.assertNativeReopenAttempt(root, grant, profile, false)
    // Retain the actual started process even before full validation. This grants
    // no ready/activation authority; root close stays fenced by the operation.
    actual.profile = profile
    actual.state = 'retained'
    root.#profiles.set(actual.entry.id, profile)
  }
  /** Reissue the SAME actual held root operation after concrete read-copy
   * owner drainage. This grants a new physical attempt only, never semantic
   * completion, deadline renewal, current admission or old-source activation. */
  static async reissueReleasedPendingCopyGrant(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    profile: Brc38PublishedProfileNode
  ): Promise<void> {
    const actual = nativeReopens.get(grant)
    if (
      !actualInventories.has(root) ||
      actual?.root !== root ||
      actual.state !== 'retained' ||
      actual.profile !== profile ||
      root.#profiles.get(actual.entry.id) !== profile ||
      !root.#inFlight.has(actual.entry.importId)
    )
      throw new Error('Pending copy reissue requires its exact retained inventory operation')
    Brc38PublishedProfileNode.assertReleasedPendingRecoveryCopy(root, grant, profile)
    await this.readNativeReopenGrant(root, grant)
    Brc38PublishedProfileNode.assertReleasedPendingRecoveryCopy(root, grant, profile)
    root.#profiles.delete(actual.entry.id)
    actual.profile = undefined
    actual.state = 'issued'
  }
  static async commitNativeReopen(
    root: Brc38ProfileInventoryNode,
    grant: Brc38NativeProfileReopenGrant,
    profile: Brc38PublishedProfileNode
  ): Promise<void> {
    const actual = nativeReopens.get(grant)
    if (
      actual?.root !== root ||
      actual.state !== 'retained' ||
      actual.profile !== profile ||
      root.#profiles.get(actual.entry.id) !== profile
    )
      throw new Error('An actual retained inventory native reopen is required')
    await this.readNativeReopenGrant(root, grant)
    Brc38PublishedProfileNode.assertNativeReopenAttempt(root, grant, profile, true)
    await root.#acknowledge(actual.entry, profile)
    actual.state = 'committed'
  }
  async openNative(importId: string, bindingSha256: string, executable: string): Promise<Brc38PublishedProfileNode> {
    return await this.#openNative(importId, bindingSha256, executable)
  }
  /** Completed v3 runtime recovery remains separate from pending activation.
   * A genuine, independently reopened retired source must remain held through
   * this factory. Caller coordinates or a completed-record observation cannot
   * substitute for it; old ordinary v2 reopening keeps its existing contract. */
  async openCompletedComposedNative(
    importId: string,
    bindingSha256: string,
    executable: string,
    source: Brc38NativeLocalBaselineSource
  ): Promise<Brc38PublishedProfileNode> {
    await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    return await this.#openNative(importId, bindingSha256, executable, source)
  }
  /** Current restart derives source address DATA from its actual completed
   * target receipt. Both inventories still independently issue their live
   * physical scopes; matching IDs cannot provide ownership. */
  async openCompletedComposedNativeFromInventory(
    importId: string,
    bindingSha256: string,
    executable: string,
    sourceRoot: Brc38ProfileInventoryNode,
    receiptPolicy: SnapshotJournalReceiptPolicy,
    policy: Brc38RetiredNativeReadPolicy
  ): Promise<Brc38PublishedProfileNode> {
    if (!actualInventories.has(this) || !actualInventories.has(sourceRoot))
      throw new Error('Completed restart requires actual source and target profile inventories')
    return await this.#withNativeReopenGrant(
      importId,
      bindingSha256,
      async grant =>
        await Brc38PublishedProfileNode.openCompletedNativeFromInventory(
          this,
          grant,
          executable,
          sourceRoot,
          receiptPolicy,
          policy
        )
    )
  }
  /** A fresh process reconstructs pending target activation from actual retained
   * retired-source/merge/stage actors. It creates a new manager only after the
   * original target completes; it cannot reactivate the retired source. */
  async recoverPendingComposedNative(
    importId: string,
    bindingSha256: string,
    executable: string,
    merge: Brc38PrivateNativeMergeNode,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    services: WalletServices,
    replacement?: Brc38PendingNativeManagerRecovery
  ): Promise<WalletStorageManager> {
    if (!actualInventories.has(this)) throw new Error('Actual pending target inventory required')
    await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    store.assertPrivateNativeDestination(store.knex)
    return await this.#withNativeReopenGrant(
      importId,
      bindingSha256,
      async grant =>
        await Brc38PublishedProfileNode.recoverPendingComposedNative(
          this,
          grant,
          executable,
          merge,
          store,
          source,
          services,
          replacement
        )
    )
  }
  /** New finite scratch inspection of the permanent pending target. This does
   * not reopen an expired staging reservation or admit target mutations. The
   * actual retired source and inventory operation remain owned throughout. */
  async withPendingComposedRecoveryCopy<T>(
    importId: string,
    bindingSha256: string,
    executable: string,
    source: Brc38NativeLocalBaselineSource,
    policy: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>
  ): Promise<T> {
    const captured = Object.freeze({ ...policy }),
      consumer = work,
      deadline = performance.now() + Math.max(0, captured.expiresAt - Date.now())
    if (!actualInventories.has(this)) throw new Error('Actual pending recovery target inventory required')
    await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    return await this.#withNativeReopenGrant(
      importId,
      bindingSha256,
      async grant =>
        await Brc38PublishedProfileNode.withPendingComposedRecoveryCopy(
          this,
          grant,
          executable,
          source,
          captured,
          consumer,
          deadline
        )
    )
  }
  /** One root operation spans copied-target read, physical release, fresh
   * authentication/reconstruction and independent target reacquisition. The
   * continuation accepts only the genuine complete incoming comparison scope. */
  async withExpiredPendingRecoveryCopy<T>(
    importId: string,
    bindingSha256: string,
    executable: string,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (
      scratch: Brc38NativeRecoveryScratchNode,
      recover: (
        incoming: Brc39RecoveryIncomingComparisonNode,
        merge: Brc38PrivateNativeMergeNode,
        services: WalletServices,
        replacement?: Brc38PendingNativeManagerRecovery
      ) => Promise<WalletStorageManager>
    ) => Promise<T>
  ): Promise<T> {
    const policy = Object.freeze({ ...selected }),
      consumer = work,
      deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
    if (!actualInventories.has(this) || typeof consumer !== 'function')
      throw new Error('Actual expired recovery inventory operation required')
    await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(source)
    return await this.#withNativeReopenGrant(
      importId,
      bindingSha256,
      async grant =>
        await Brc38PublishedProfileNode.withReleasedPendingComposedRecoveryCopy(
          this,
          grant,
          executable,
          source,
          policy,
          async scratch => {
            let started = false
            const io = new Brc38OwnedImportReads()
            return await io.retain(
              async () =>
                await consumer(
                  scratch,
                  async (incoming, merge, services, replacement) =>
                    await io.run(async () => {
                      if (started) throw new Error('Expired pending target continuation is already owned')
                      Brc39RecoveryIncomingComparisonNode.prototype.assertRetained.call(incoming)
                      if (
                        incoming.candidate.directory !== scratch.directory ||
                        incoming.source.original.digest !== bindingSha256
                      )
                        throw new Error('Expired recovery continuation has another copied source or binding')
                      scratch.assertRetained()
                      started = true
                      return await Brc38PublishedProfileNode.recoverPendingComposedNative(
                        this,
                        grant,
                        executable,
                        merge,
                        incoming.candidate,
                        source,
                        services,
                        replacement,
                        incoming
                      )
                    })
                )
            )
          },
          deadline
        )
    )
  }
  async closeNamedRecoveryManager(
    importId: string,
    bindingSha256: string,
    manager: WalletStorageManager
  ): Promise<void> {
    if (!actualInventories.has(this)) throw new Error('Actual recovery target inventory required for cleanup')
    await this.#operation(importId, async () => {
      const entry = await this.#entry(importId, bindingSha256),
        profile = this.#profiles.get(entry.id)
      if (entry.state !== 'published' || profile === undefined)
        throw new Error('Recovery manager cleanup has no exact retained target profile')
      await Brc38PublishedProfileNode.closeNamedRecoveryManager(this, profile, manager)
    })
  }
  /** Retrieve the actual already-serving profile for a later operation. This
   * does not open, authenticate, activate or cache a semantic verdict. A future
   * source/cutover still independently acquires its own fresh live scopes. */
  async currentNativeProfile(
    importId: string,
    bindingSha256: string,
    manager: WalletStorageManager,
    selected: Brc38RetiredNativeReadPolicy
  ): Promise<Brc38PublishedProfileNode> {
    const policy = Brc38RetiredNativeReadNode.capturePolicy(selected),
      deadline = performance.now() + policy.expiresAt - Date.now()
    const check = (): void => {
      policy.signal?.throwIfAborted()
      if (!actualInventories.has(this) || Date.now() >= policy.expiresAt || performance.now() >= deadline)
        throw new Error('Current native profile lookup lost its actual inventory or finite lifetime')
    }
    check()
    return await this.#operation(importId, async () => {
      check()
      const entry = await this.#entry(importId, bindingSha256),
        profile = this.#profiles.get(entry.id),
        provider = WalletStorageManager.prototype.getActive.call(manager)
      if (entry.state !== 'published' || profile === undefined || !(provider instanceof StorageKnex))
        throw new Error('Current native profile lookup requires its exact retained serving profile')
      Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager)
      await Brc38PublishedProfileNode.assertNativeProviderInventory(profile, provider, this)
      check()
      Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager)
      if (
        WalletStorageManager.prototype.getActive.call(manager) !== provider ||
        this.#profiles.get(entry.id) !== profile
      )
        throw new Error('Current native profile selection changed during lookup')
      return profile
    })
  }
  async #openNative(
    importId: string,
    bindingSha256: string,
    executable: string,
    completedSource?: Brc38NativeLocalBaselineSource
  ): Promise<Brc38PublishedProfileNode> {
    return await this.#withNativeReopenGrant(
      importId,
      bindingSha256,
      async grant => await Brc38PublishedProfileNode.openNativeReopen(this, grant, executable, completedSource)
    )
  }
  async #withNativeReopenGrant<T>(
    importId: string,
    bindingSha256: string,
    work: (grant: Brc38NativeProfileReopenGrant) => Promise<T>
  ): Promise<T> {
    return await this.#operation(importId, async () => {
      const entry = await this.#entry(importId, bindingSha256)
      if (entry.state !== 'published') throw new Error('Native reopen requires a published inventory entry')
      const previous = this.#profiles.get(entry.id)
      if (previous !== undefined && !previous.ownershipReleased)
        throw new Error('An actual profile owner must physically close before native reopen')
      this.#profiles.delete(entry.id)
      const grant = Object.freeze(Object.create(null)) as Brc38NativeProfileReopenGrant
      const actual: NativeReopen = {
        root: this,
        entry,
        inventory: this.#inventory(entry.id),
        state: 'issued'
      }
      nativeReopens.set(grant, actual)
      try {
        return await work(grant)
      } finally {
        actual.state = 'closed'
      }
    })
  }
  static async prepareNativeProfileClaim(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode
  ): Promise<Brc38NativeProfileTransferClaim> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const entry = await root.#nativeTransferEntry(profile)
    return await root.#operation(
      entry.importId,
      async () => await Brc38PublishedProfileNode.issueNativeClaim(profile, root)
    )
  }
  /** Original inventory operation membership, never a source/schema/target
   * verdict. Read scopes cannot overlap a still-live source profile owner. */
  static assertRetiredNativeReadGrant(root: Brc38ProfileInventoryNode, grant: Brc38RetiredNativeReadGrant): void {
    const actual = retiredReads.get(grant)
    if (
      !actualInventories.has(root) ||
      actual?.root !== root ||
      !actual.live ||
      root.#closed ||
      Date.now() >= actual.policy.expiresAt ||
      performance.now() >= actual.deadline ||
      !root.#inFlight.has(actual.entry.importId) ||
      root.#retiredReadCleanup.size !== 0 ||
      root.#profiles.get(actual.entry.id)?.ownershipReleased === false
    )
      throw new Error('An actual retained retired-source inventory read is required')
    actual.policy.signal?.throwIfAborted()
  }
  static async readRetiredNativeReadGrant(
    root: Brc38ProfileInventoryNode,
    grant: Brc38RetiredNativeReadGrant
  ): Promise<
    Readonly<{
      directory: string
      inventory: Readonly<Brc38ProfileInventoryBinding>
      bindingSha256: string
      binding: Readonly<Brc38StagingBinding>
      limits: Readonly<KnexBrc38StagingLimits>
      admission: Readonly<Brc38ImportJournalAdmission>
      policy: Readonly<Brc38RetiredNativeReadPolicy>
      deadline: number
    }>
  > {
    Brc38ProfileInventoryNode.assertRetiredNativeReadGrant(root, grant)
    const actual = retiredReads.get(grant)!,
      current = await root.#entry(actual.entry.importId, actual.entry.bindingSha256)
    if (current.state !== 'published' || JSON.stringify(current) !== JSON.stringify(actual.entry))
      throw new Error('Retired-source original inventory entry changed')
    const fixed = root.#fixed(current)
    Brc38ProfileInventoryNode.assertRetiredNativeReadGrant(root, grant)
    return Object.freeze({
      directory: join(root.directory, current.id),
      inventory: Object.freeze({ ...fixed.inventory }),
      bindingSha256: current.bindingSha256,
      binding: Object.freeze({ ...fixed.binding }),
      limits: Object.freeze({ ...fixed.limits }),
      admission: admissionCopy(fixed.admission),
      policy: actual.policy,
      deadline: actual.deadline
    })
  }
  /** Separate bounded read-only recovery operation. The actual reader freshly
   * verifies retired lineage and physical identity after native claim. Pending
   * physical cleanup blocks further inventory work until explicitly drained. */
  static async withRetiredNativeRead<T>(
    root: Brc38ProfileInventoryNode,
    importId: string,
    bindingSha256: string,
    executable: string,
    policy: Brc38RetiredNativeReadPolicy,
    work: (reader: Brc38RetiredNativeReadNode) => Promise<T>
  ): Promise<T> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const captured = Brc38RetiredNativeReadNode.capturePolicy(policy),
      deadline = performance.now() + Math.max(0, captured.expiresAt - Date.now())
    return await root.#operation(importId, async () => {
      const entry = await root.#entry(importId, bindingSha256)
      if (entry.state !== 'published' || root.#profiles.get(entry.id)?.ownershipReleased === false)
        throw new Error('Retired-source reading requires its original published entry and physically closed provider')
      const grant = Object.freeze({}) as Brc38RetiredNativeReadGrant,
        actual = { root, entry, policy: captured, deadline, live: true }
      retiredReads.set(grant, actual)
      try {
        return await Brc38RetiredNativeReadNode.withInventory(root, grant, executable, captured, work)
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) root.#retiredReadCleanup.add(cause)
        throw cause
      } finally {
        actual.live = false
      }
    })
  }
  /** Derive the retired read address from this actual original profile's
   * current published inventory entry, rather than caller coordinates. */
  static async withRetiredNativeProfileRead<T>(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    executable: string,
    policy: Brc38RetiredNativeReadPolicy,
    work: (reader: Brc38RetiredNativeReadNode) => Promise<T>
  ): Promise<T> {
    if (!actualInventories.has(root)) throw new Error('Actual original retired profile inventory required')
    const entry = await root.#nativeTransferEntry(profile)
    if (!profile.ownershipReleased) throw new Error('Original retired profile still owns its physical provider')
    return await Brc38ProfileInventoryNode.withRetiredNativeRead(
      root,
      entry.importId,
      entry.bindingSha256,
      executable,
      policy,
      work
    )
  }
  /** Resolve bounded source coordinates only in the genuine inventory. The
   * resulting retired read must still prove its real kernel and retirement. */
  static async withRetiredNativeInventoryRead<T>(
    root: Brc38ProfileInventoryNode,
    inventory: Brc38ProfileInventoryBinding,
    executable: string,
    policy: Brc38RetiredNativeReadPolicy,
    work: (reader: Brc38RetiredNativeReadNode) => Promise<T>
  ): Promise<T> {
    if (!actualInventories.has(root)) throw new Error('Actual retired source inventory required')
    const selected = Object.freeze({ ...inventory }),
      entry = await root.#exclusive((_trx, entries) => {
        return promiseFromSync(() => {
          const found = entries.find(value => value.id === selected.profileId)
          if (
            found === undefined ||
            found.state !== 'published' ||
            JSON.stringify(root.#inventory(found.id)) !== JSON.stringify(selected)
          )
            throw new Error('Completed target source coordinates differ from the actual source inventory')
          return Object.freeze({ ...found })
        })
      })
    return await Brc38ProfileInventoryNode.withRetiredNativeRead(
      root,
      entry.importId,
      entry.bindingSha256,
      executable,
      policy,
      work
    )
  }
  static async acquireNativeProfileClaim(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    claim: Brc38NativeProfileTransferClaim,
    executable: string
  ): Promise<Brc38PublishedProfileNode> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const entry = await root.#nativeTransferEntry(profile)
    return await root.#operation(
      entry.importId,
      async () => await Brc38PublishedProfileNode.reacquireNativeClaim(root, profile, claim, executable)
    )
  }
  static async activateNativeProfile(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    services: WalletServices,
    policy?: Brc38RetiredNativeReadPolicy
  ): Promise<WalletStorageManager> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const entry = await root.#nativeTransferEntry(profile)
    return await root.#operation(
      entry.importId,
      async () => await Brc38PublishedProfileNode.activateNativeWithinInventory(root, profile, services, policy)
    )
  }
  static async promoteNativeProfileWal(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode
  ): Promise<void> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const entry = await root.#nativeTransferEntry(profile)
    await root.#operation(
      entry.importId,
      async () => await Brc38PublishedProfileNode.promoteNativeWalWithinInventory(root, profile)
    )
  }
  static async releaseNativeProfileClaim(
    root: Brc38ProfileInventoryNode,
    profile: Brc38PublishedProfileNode,
    claim: Brc38NativeProfileTransferClaim
  ): Promise<Brc38NativeProfileTransferReceipt> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const entry = await root.#nativeTransferEntry(profile)
    return await root.#operation(
      entry.importId,
      async () => await Brc38PublishedProfileNode.drainNativeClaim(root, profile, claim)
    )
  }

  static async create(directory: string, selected: Brc38ProfileInventoryCapacity): Promise<Brc38ProfileInventoryNode> {
    const policyJson = policy(selected),
      identity = await directoryStat(directory),
      entries = await opendir(directory)
    let entry
    try {
      entry = await entries.read()
    } finally {
      await entries.close()
    }
    if (entry !== null) throw new Error('Profile inventory root must initially be empty: ' + entry.name)
    const file = await createPrivateFile(join(directory, catalogName)),
      catalogIdentity = await requirePrivateDescriptor(file)
    await closePrivateDescriptor(file)
    const db = database(directory),
      rootId = randomUUID()
    try {
      await db.transaction(async trx => {
        await trx.schema.createTable('profile_inventory_capacity', table => {
          table.integer('slot').primary()
          table.string('protocol', 32).notNullable()
          table.string('rootId', 36).notNullable()
          table.string('policyJson', 128).notNullable()
          table.string('policySha256', 64).notNullable()
        })
        await trx.schema.createTable('profile_inventory', table => {
          table.string('id', 36).primary()
          table.string('importId', 36).notNullable().unique()
          table.string('bindingSha256', 64).notNullable()
          table.bigInteger('expiresAt').notNullable()
          table.bigInteger('maximumPhysicalBytes').notNullable()
          table.string('state', 16).notNullable()
          table.text('fixedJson').notNullable()
          table.string('fixedSha256', 64).notNullable()
          table.index(['state', 'expiresAt', 'id'])
        })
        await trx('profile_inventory_capacity').insert({
          slot: 1,
          protocol,
          rootId,
          policyJson,
          policySha256: hash(policyJson)
        })
      })
      await syncDirectory(directory)
      const root = new Brc38ProfileInventoryNode(
        db,
        directory,
        Object.freeze({ ...selected }),
        rootId,
        identity,
        catalogIdentity,
        inventoryIssuer
      )
      await root.usage()
      actualInventories.add(root)
      return root
    } catch (cause) {
      await drainBrc38FailedConnections(
        cause,
        async () => await db.destroy(),
        'Inventory initialization retains cleanup'
      )
      // Incomplete initialization is retained for explicit recovery, never replaced.
      throw cause
    }
  }
  static async reopen(directory: string, selected: Brc38ProfileInventoryCapacity): Promise<Brc38ProfileInventoryNode> {
    policy(selected)
    const identity = await directoryStat(directory),
      catalogIdentity = await fileStat(join(directory, catalogName)),
      db = database(directory)
    try {
      const rows: Array<{ rootId: string }> = await db('profile_inventory_capacity')
        .where({ slot: 1 })
        .select(db.raw('CASE WHEN length(CAST(rootId AS BLOB)) = 36 THEN rootId ELSE NULL END AS rootId'))
        .limit(2)
      if (rows.length !== 1 || !uuid.test(rows[0]!.rootId)) throw new Error('Profile inventory root identity differs')
      const root = new Brc38ProfileInventoryNode(
        db,
        directory,
        Object.freeze({ ...selected }),
        rows[0]!.rootId,
        identity,
        catalogIdentity,
        inventoryIssuer
      )
      await root.usage()
      actualInventories.add(root)
      return root
    } catch (cause) {
      await drainBrc38FailedConnections(cause, async () => await db.destroy(), 'Inventory reopen retains cleanup')
      throw cause
    }
  }
  #inventory(id: string): Brc38ProfileInventoryBinding {
    return { rootId: this.rootId, profileId: id, policySha256: hash(policy(this.capacity)) }
  }
  #fixed(entry: Entry): Fixed {
    if (
      !uuid.test(entry.id) ||
      !uuid.test(entry.importId) ||
      !['reserved', 'published', 'retiring', 'withdrawing'].includes(entry.state) ||
      typeof entry.fixedJson !== 'string' ||
      hash(entry.fixedJson) !== entry.fixedSha256
    )
      throw new Error('Profile inventory record differs')
    integer(entry.expiresAt, 1)
    integer(entry.maximumPhysicalBytes, 1048576)
    const fixed = JSON.parse(entry.fixedJson) as Fixed
    integer(fixed.limits.maximumRows, 1, 1000000000)
    integer(fixed.limits.maximumLogicalBytes, 1)
    integer(fixed.limits.maximumPhysicalBytes, 1048576)
    integer(fixed.limits.maximumRowBytes, 1, 16777216)
    integer(fixed.limits.maximumRowAllocationBytes, 1, 16777216)
    integer(fixed.limits.expiresAt, 1)
    const bound = brc38StagingBinding(fixed.binding, fixed.limits)
    if (
      JSON.stringify(fixed.inventory) !== JSON.stringify(this.#inventory(entry.id)) ||
      fixed.bindingSha256 !== entry.bindingSha256 ||
      bound.digest !== entry.bindingSha256 ||
      fixed.admission.scope.importId !== entry.importId ||
      fixed.admission.scope.bindingSha256 !== entry.bindingSha256 ||
      fixed.admission.scope.archiveSha256 !== fixed.binding.archiveSha256 ||
      fixed.admission.originalLimitsJson !== bound.limitsJson ||
      fixed.admission.expiresAt !== entry.expiresAt ||
      fixed.limits.expiresAt !== entry.expiresAt ||
      fixed.limits.maximumPhysicalBytes !== entry.maximumPhysicalBytes
    )
      throw new Error('Profile inventory immutable original binding differs')
    return fixed
  }
  async #entries(trx: Knex.Transaction): Promise<Entry[]> {
    const entries: Entry[] = await trx('profile_inventory')
      .select(
        ...['id', 'importId', 'bindingSha256', 'state', 'fixedSha256'].map(field =>
          trx.raw('CASE WHEN length(CAST(?? AS BLOB)) <= 64 THEN ?? ELSE NULL END AS ??', [field, field, field])
        ),
        trx.raw('CASE WHEN length(CAST(fixedJson AS BLOB)) <= 8192 THEN fixedJson ELSE NULL END AS fixedJson'),
        trx.raw("CASE WHEN typeof(expiresAt) = 'integer' THEN expiresAt ELSE NULL END AS expiresAt"),
        trx.raw(
          "CASE WHEN typeof(maximumPhysicalBytes) = 'integer' THEN maximumPhysicalBytes ELSE NULL END AS maximumPhysicalBytes"
        )
      )
      .orderBy('id')
      .limit(this.capacity.maximumProfiles + 1)
    if (entries.length > this.capacity.maximumProfiles)
      throw new Error('Profile inventory count exceeds its original policy')
    entries.forEach(entry => this.#fixed(entry))
    return entries
  }
  #usage(entries: Entry[]): Brc38ProfileInventoryUsage {
    const reservedPhysicalBytes = entries.reduce((sum, entry) => sum + entry.maximumPhysicalBytes, catalogReservation)
    integer(reservedPhysicalBytes, catalogReservation, this.capacity.maximumPhysicalBytes)
    return {
      profiles: entries.length,
      published: entries.filter(entry => entry.state === 'published').length,
      reservedPhysicalBytes
    }
  }
  async #verify(trx: Knex.Transaction): Promise<Entry[]> {
    if (
      !sameFile(this.#identity, await directoryStat(this.directory)) ||
      !sameFile(this.#catalogIdentity, await fileStat(join(this.directory, catalogName)))
    )
      throw new Error('Profile inventory root or catalog was replaced')
    const rows: Array<{
      protocol: string
      rootId: string
      policyJson: string
      policySha256: string
    }> = await trx('profile_inventory_capacity')
      .where({ slot: 1 })
      .select(
        ...['protocol', 'rootId', 'policyJson', 'policySha256'].map(field =>
          trx.raw('CASE WHEN length(CAST(?? AS BLOB)) <= 128 THEN ?? ELSE NULL END AS ??', [field, field, field])
        )
      )
      .limit(2)
    const actual = rows[0],
      policyJson = policy(this.capacity)
    if (
      rows.length !== 1 ||
      actual?.protocol !== protocol ||
      actual.rootId !== this.rootId ||
      actual.policyJson !== policyJson ||
      actual.policySha256 !== hash(policyJson)
    )
      throw new Error('Profile inventory original policy differs')
    const pages = (await trx.raw('PRAGMA page_size')) as Array<{ page_size: number }>,
      bound = (await trx.raw('PRAGMA max_page_count')) as Array<{ max_page_count: number }>
    if (pages[0]?.page_size !== 4096 || bound[0]?.max_page_count !== 256)
      throw new Error('Profile inventory native page bound differs')
    const entries = await this.#entries(trx)
    this.#usage(entries)
    const allowed = new Set([
      catalogName,
      catalogName + '-journal',
      ...entries.flatMap(entry => [entry.id, entry.id + '.retired'])
    ])
    const files = await opendir(this.directory)
    for await (const file of files) {
      if (!allowed.has(file.name)) throw new Error('Profile inventory contains an unregistered physical path')
      if (file.name === catalogName + '-journal') await fileStat(join(this.directory, file.name))
      else if (file.name !== catalogName) await directoryStat(join(this.directory, file.name))
    }
    return entries
  }
  async #exclusive<T>(work: (trx: Knex.Transaction, entries: Entry[]) => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy || this.#retiredReadDraining || this.#retiredReadCleanup.size !== 0)
      throw new Error('Profile inventory is unavailable or already owned')
    this.#busy = true
    try {
      return await this.#db.transaction(async trx => {
        await trx('profile_inventory_capacity').where({ slot: 1 }).update({ slot: 1 })
        return await work(trx, await this.#verify(trx))
      })
    } finally {
      this.#busy = false
    }
  }
  async usage(): Promise<Brc38ProfileInventoryUsage> {
    return await this.#exclusive((_trx, entries) => promiseFromSync(() => this.#usage(entries)))
  }
  async #entry(importId: string, bindingSha256: string): Promise<Entry> {
    return await this.#exclusive((_trx, entries) => {
      return promiseFromSync(() => {
        const entry = entries.find(value => value.importId === importId)
        if (entry === undefined || entry.bindingSha256 !== bindingSha256)
          throw new Error('Profile inventory operation binding differs')
        return entry
      })
    })
  }
  async #claim(entry: Entry): Promise<Brc38PublishedProfileNode> {
    let profile = this.#profiles.get(entry.id)
    if (profile?.ownershipReleased) {
      this.#profiles.delete(entry.id)
      profile = undefined
    }
    if (profile === undefined) {
      const original = join(this.directory, entry.id),
        retired = original + '.retired'
      if ((await exists(original)) && (await exists(retired))) throw new Error('Ambiguous profile retirement paths')
      profile = await Brc38PublishedProfileNode.open((await exists(original)) ? original : retired, entry.bindingSha256)
      this.#profiles.set(entry.id, profile)
    }
    await profile.assertInventoryBinding(this.#inventory(entry.id), entry.bindingSha256)
    return profile
  }
  async #acknowledge(entry: Entry, profile: Brc38PublishedProfileNode): Promise<void> {
    await this.#exclusive(async (trx, entries) => {
      const actual = entries.find(value => value.id === entry.id)
      if (actual?.fixedSha256 !== entry.fixedSha256 || ['retiring', 'withdrawing'].includes(actual.state))
        throw new Error('Profile inventory acknowledgement differs')
      await profile.assertInventoryBinding(this.#inventory(entry.id), entry.bindingSha256)
      if ((await profile.status()).state === 'RECEIVING')
        throw new Error('Incomplete profile has no publication acknowledgement')
      if (
        actual.state === 'reserved' &&
        (await trx('profile_inventory').where({ id: entry.id, state: 'reserved' }).update({ state: 'published' })) !== 1
      )
        throw new Error('Profile inventory acknowledgement changed')
    })
    // The above writer has committed. This independent native read also commits
    // before returning managed activation authority to the actual profile handle.
    await registerBrc38InventoryPublishedProfile(
      this.#db,
      this.directory,
      profile,
      this.#inventory(entry.id),
      entry.bindingSha256
    )
  }
  async #operation<T>(importId: string, work: () => Promise<T>): Promise<T> {
    if (
      this.#closed ||
      this.#retiredReadDraining ||
      this.#inFlight.has(importId) ||
      this.#retiredReadCleanup.size !== 0
    )
      throw new Error('Profile inventory operation is unavailable or already owned')
    this.#inFlight.add(importId)
    try {
      return await work()
    } finally {
      this.#inFlight.delete(importId)
    }
  }
  async open(importId: string, bindingSha256: string): Promise<Brc38PublishedProfileNode> {
    return await this.#operation(importId, async () => await this.#open(importId, bindingSha256))
  }
  async #open(importId: string, bindingSha256: string): Promise<Brc38PublishedProfileNode> {
    const entry = await this.#entry(importId, bindingSha256)
    if (['retiring', 'withdrawing'].includes(entry.state)) throw new Error('Profile inventory operation is retiring')
    const profile = await this.#claim(entry)
    await this.#acknowledge(entry, profile)
    return profile
  }
  async publish(
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    signal?: AbortSignal
  ): Promise<Brc38PublishedProfileNode> {
    return await Brc38ProfileInventoryNode.publishCompletedRestore(this, store, admission, signal)
  }
  /** Concrete inventory membership is required before an internal receiver
   * lends its private store. Invoke the private implementation, never an
   * arbitrary caller's replacement publish callback. */
  static async publishCompletedRestore(
    root: Brc38ProfileInventoryNode,
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    signal?: AbortSignal
  ): Promise<Brc38PublishedProfileNode> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    return await root.#publishCompletedRestore(store, admission, signal)
  }
  /** Explicit structured publication captures original bounded resource DATA;
   * the concrete issuer and fresh private/copied inventories grant the actual
   * operation. A supplied label or prior inventory result is never accepted. */
  static async publishCompletedStructuredRestore(
    root: Brc38ProfileInventoryNode,
    store: KnexBrc38StagingStore,
    selected: Brc38ImportJournalAdmission,
    resources: Brc38PrivateStructuredRestoreResources,
    signal?: AbortSignal
  ): Promise<Brc38PublishedProfileNode> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const admission = admissionCopy(selected),
      fixed = brc38StructuredRestoreResources(store.limits, resources, admission.maximumStepBytes, store.directory),
      operationSignal = signal ?? fixed.sourcePolicy.signal
    if (fixed.sourcePolicy.signal !== undefined && fixed.sourcePolicy.signal !== operationSignal)
      throw new Error('Structured publication changed its original cancellation scope')
    return await root.#publishCompletedRestore(store, admission, operationSignal, fixed)
  }
  /** Reserve actual inventory capacity and independently inspect a complete
   * occupied composition, then acknowledge its durable inactive composed
   * READY receipt. Forward source retirement and selection remain separate. */
  static async receiveComparedComposition(
    root: Brc38ProfileInventoryNode,
    store: KnexBrc38StagingStore,
    selected: Brc38ImportJournalAdmission,
    merge: Brc38PrivateNativeMergeNode,
    signal?: AbortSignal
  ): Promise<Brc38PublishedProfileNode> {
    if (!actualInventories.has(root)) throw new Error('An actual profile inventory issuer is required')
    const operationSignal = Brc38PrivateNativeMergeNode.receivingSignal(merge, store, signal)
    return await root.#publishCompletedRestore(store, admissionCopy(selected), operationSignal, undefined, merge)
  }
  async #publishCompletedRestore(
    store: KnexBrc38StagingStore,
    admission: Brc38ImportJournalAdmission,
    signal?: AbortSignal,
    structured?: Readonly<Brc38PrivateStructuredRestoreResources>,
    merge?: Brc38PrivateNativeMergeNode
  ): Promise<Brc38PublishedProfileNode> {
    const importId = admission.scope.importId,
      bindingSha256 = store.binding?.digest
    if (!uuid.test(importId) || bindingSha256 === undefined || bindingSha256 !== admission.scope.bindingSha256)
      throw new Error('Profile publication requires an original bound native import')
    if (this.#inFlight.has(importId)) throw new Error('Profile publication operation is already owned')
    this.#inFlight.add(importId)
    try {
      const entry = await this.#exclusive(async (trx, entries) => {
        const existing = entries.find(value => value.importId === importId)
        if (existing !== undefined) {
          const fixed = this.#fixed(existing)
          if (existing.bindingSha256 !== bindingSha256 || JSON.stringify(fixed.admission) !== JSON.stringify(admission))
            throw new Error('Profile inventory retry changed the original admission')
          return existing
        }
        signal?.throwIfAborted()
        store.assertPrivateNativeDestination(store.knex)
        if (Date.now() >= admission.expiresAt) throw new Error('Original profile publication deadline expired')
        const usage = this.#usage(entries)
        if (
          usage.profiles >= this.capacity.maximumProfiles ||
          store.limits.maximumPhysicalBytes > this.capacity.maximumPhysicalBytes - usage.reservedPhysicalBytes
        )
          throw new Error('Profile inventory fixed capacity exceeded before creation')
        const id = randomUUID(),
          fixed: Fixed = {
            inventory: this.#inventory(id),
            binding: { ...store.binding!.binding },
            bindingSha256,
            limits: { ...store.limits },
            admission: JSON.parse(JSON.stringify(admission)) as Brc38ImportJournalAdmission
          },
          fixedJson = JSON.stringify(fixed)
        if (Buffer.byteLength(fixedJson) > 8192) throw new Error('Profile inventory metadata exceeds its fixed bound')
        const value: Entry = {
          id,
          importId,
          bindingSha256,
          expiresAt: admission.expiresAt,
          maximumPhysicalBytes: store.limits.maximumPhysicalBytes,
          state: 'reserved',
          fixedJson,
          fixedSha256: hash(fixedJson)
        }
        this.#fixed(value)
        await trx('profile_inventory').insert(value)
        return value
      })
      if (['retiring', 'withdrawing'].includes(entry.state)) throw new Error('Profile inventory operation is retiring')
      const directory = join(this.directory, entry.id)
      let profile: Brc38PublishedProfileNode
      if (await exists(directory)) {
        profile = await this.#claim(entry)
        if ((await profile.status()).state !== 'RECEIVING') {
          if (merge !== undefined) await Brc38PublishedProfileNode.assertComposedReadyPublication(profile, admission)
          await this.#acknowledge(entry, profile)
          return profile
        }
        // An interrupted copy has immutable partial bytes. Explicit reclamation
        // is required; retry never silently deletes, renews or starts a new copy.
        throw new Error('Incomplete profile retains its original reservation for physical recovery')
      }
      if (entry.state === 'published') throw new Error('Published profile physical database is absent')
      profile = await this.#exclusive(async (trx, entries) => {
        if (entries.find(value => value.id === entry.id)?.state !== 'reserved')
          throw new Error('Profile reservation changed before creation')
        signal?.throwIfAborted()
        store.assertPrivateNativeDestination(store.knex)
        if (Date.now() >= entry.expiresAt) throw new Error('Original profile publication deadline expired')
        const grant = await createBrc38ProfileCreationGrant(
          trx,
          this.directory,
          this.#inventory(entry.id),
          bindingSha256
        )
        const owned = await Brc38PublishedProfileNode.prepareOwnedAt(grant, store, admission)
        this.#profiles.set(entry.id, owned)
        return owned
      })
      // Durable charge and independent profile kernel exist; no global writer
      // remains held across the original source database copy.
      if (merge !== undefined) {
        await Brc38PublishedProfileNode.receiveComparedComposition(profile, store, admission, merge)
        // The actual same-owner complete comparison and copied image precede
        // durable composed READY. Acknowledgement registers inactive inventory
        // ownership only; forward retirement/cutover still admits selection.
        await this.#acknowledge(entry, profile)
        return profile
      }
      await profile.copyFromCompletedRestore(store, admission, signal, structured)
      await this.#acknowledge(entry, profile)
      return profile
    } finally {
      this.#inFlight.delete(importId)
    }
  }
  /** Expiry alone never releases capacity. READY lost-ack recovery is promoted;
   * RECEIVING is removed under its actual kernel and a tracked retirement path. */
  async collect(importId: string, bindingSha256: string): Promise<boolean> {
    return await this.#operation(importId, async () => await this.#collect(importId, bindingSha256))
  }
  /** Source remains selected throughout this explicitly requested withdrawal.
   * Once withdrawing commits, this inventory can no longer activate or retire
   * the source toward that target. Capacity remains charged until cleanup. */
  async withdrawInactiveComposed(
    importId: string,
    bindingSha256: string,
    sourceProfile: Brc38PublishedProfileNode,
    provider: StorageKnex,
    manager: WalletStorageManager,
    sourceRoot: Brc38ProfileInventoryNode,
    selected: WalletStorageProviderTransitionPolicy
  ): Promise<boolean> {
    if (!actualInventories.has(this) || !actualInventories.has(sourceRoot))
      throw new Error('Actual withdrawal inventories required')
    const expiresAt = selected.expiresAt,
      signal = selected.signal,
      lifetime = expiresAt - Date.now(),
      deadline = performance.now() + lifetime
    if (!Number.isSafeInteger(expiresAt) || lifetime <= 0 || lifetime > 3600000)
      throw new Error('Inactive withdrawal requires a finite maintenance lifetime')
    const check = (): void => {
      signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Inactive target withdrawal expired')
      Brc38PublishedProfileNode.assertNativeManagedProvider(provider, manager)
    }
    return (await WalletStorageManager.prototype.runAsSync.call(manager, async active => {
      check()
      if (active !== provider) throw new Error('Withdrawal manager selected a different source')
      await Brc38PublishedProfileNode.assertNativeObserverMaintenance(sourceProfile, provider, manager, sourceRoot)
      return await this.#operation(importId, async () => {
        const entry = await this.#exclusive((_trx, entries) => {
          return promiseFromSync(() => {
            const actual = entries.find(value => value.importId === importId)
            if (actual !== undefined && actual.bindingSha256 !== bindingSha256)
              throw new Error('Inactive withdrawal binding changed')
            return actual
          })
        })
        if (entry === undefined) {
          check()
          return false
        }
        if (entry.state !== 'withdrawing') {
          if (entry.state !== 'published') throw new Error('Inactive withdrawal requires a published composed target')
          const profile = await this.#claim(entry)
          await Brc38PublishedProfileNode.assertInactiveComposedWithdrawal(
            profile,
            sourceProfile,
            provider,
            manager,
            sourceRoot
          )
          check()
          await this.#exclusive(async (trx, entries) => {
            check()
            if (
              JSON.stringify(entries.find(value => value.id === entry.id)) !== JSON.stringify(entry) ||
              (await trx('profile_inventory')
                .where({ id: entry.id, state: 'published', bindingSha256 })
                .update({ state: 'withdrawing' })) !== 1
            )
              throw new Error('Inactive target withdrawal changed before durable commit')
          })
          await syncDirectory(this.directory)
        }
        check()
        const result = await this.#collect(importId, bindingSha256)
        await Brc38PublishedProfileNode.assertNativeObserverMaintenance(sourceProfile, provider, manager, sourceRoot)
        check()
        return result
      })
    })) as boolean
  }
  async #collect(importId: string, bindingSha256: string): Promise<boolean> {
    const entry = await this.#entry(importId, bindingSha256)
    if (entry.state === 'published') return false
    if (entry.state === 'reserved' && Date.now() < entry.expiresAt)
      throw new Error('Original profile reservation has not expired')
    const original = join(this.directory, entry.id),
      retired = original + '.retired'
    let profile = this.#profiles.get(entry.id)
    if (profile?.ownershipReleased) profile = undefined
    if (profile !== undefined || (await exists(join(original, 'owner.sqlite'))) || (await exists(retired)))
      profile = await this.#claim(entry)
    if (
      entry.state !== 'withdrawing' &&
      profile !== undefined &&
      !profile.retirementStarted &&
      (await profile.status()).state !== 'RECEIVING'
    ) {
      await this.#acknowledge(entry, profile)
      return false
    }
    await this.#exclusive(async (trx, entries) => {
      const actual = entries.find(value => value.id === entry.id)
      if (actual?.fixedSha256 !== entry.fixedSha256 || actual.state === 'published')
        throw new Error('Profile collection state differs')
      if (entry.state !== 'withdrawing')
        await trx('profile_inventory').where({ id: entry.id }).update({ state: 'retiring' })
    })
    await this.#exclusive(async (trx, entries) => {
      const state = entry.state === 'withdrawing' ? 'withdrawing' : 'retiring'
      if (entries.find(value => value.id === entry.id)?.state !== state)
        throw new Error('Profile retirement state differs')
      if (profile === undefined && (await exists(original))) await this.#removeUnclaimedPartial(original)
      if (profile !== undefined) {
        const grant = await (
          state === 'withdrawing' ? createBrc38ProfileWithdrawalGrant : createBrc38ProfileRetirementGrant
        )(trx, this.directory, this.#inventory(entry.id), entry.bindingSha256)
        if (state === 'withdrawing') await profile.discardInactiveComposedOwned(grant)
        else await profile.discardIncompleteOwned(grant)
      }
      if ((await exists(original)) || (await exists(retired)))
        throw new Error('Profile physical cleanup remains required')
      await syncDirectory(this.directory)
      if ((await trx('profile_inventory').where({ id: entry.id, state }).delete()) !== 1)
        throw new Error('Profile retirement charge changed')
    })
    this.#profiles.delete(entry.id)
    return true
  }
  async #removeUnclaimedPartial(directory: string): Promise<void> {
    await directoryStat(directory)
    if (await exists(join(directory, 'owner.sqlite'))) throw new Error('An actual profile kernel claim is required')
    const entries = await opendir(directory)
    for await (const entry of entries) {
      if (!['profile.sqlite', 'profile.sqlite-journal'].includes(entry.name))
        throw new Error('Partial profile contains an unowned path')
      const stat = await requirePrivatePath(join(directory, entry.name), false)
      if (stat.size > 65536n) throw new Error('Partial profile file identity or bound differs')
    }
    await rm(directory, { recursive: true })
  }
  /** Drain only concrete failed reader owners. No grant or source lifetime is
   * restored. Inventory work remains blocked throughout physical retry; the
   * caller can then start a newly bounded read instead of closing this root. */
  async retryRetiredReadCleanup(): Promise<void> {
    if (!actualInventories.has(this) || this.#closed || this.#busy || this.#inFlight.size || this.#retiredReadDraining)
      throw new Error('Retired reader cleanup requires its idle actual profile inventory')
    this.#retiredReadDraining = true
    try {
      // Snapshot the admitted cleanup cohort before awaiting its mutable owners.
      for (const retained of Array.from(this.#retiredReadCleanup)) {
        await retained.retryCleanup()
        this.#retiredReadCleanup.delete(retained)
      }
    } finally {
      this.#retiredReadDraining = false
    }
  }
  async close(): Promise<void> {
    if (this.#busy || this.#inFlight.size || this.#retiredReadDraining)
      throw new Error('Wait for actual profile inventory work before close')
    this.#closed = true
    for (const retained of Array.from(this.#retiredReadCleanup)) {
      await retained.retryCleanup()
      this.#retiredReadCleanup.delete(retained)
    }
    await runInSeries(this.#profiles.values(), async profile => await profile.close())
    await this.#db.destroy()
  }
}
