import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import {
  assertRemoteSnapshotJournalFieldFrame,
  type RemoteSnapshotJournalFieldArchive,
  type RemoteSnapshotJournalFieldFrame
} from './journal/openRemoteSnapshotJournalFieldArchive'
import type {
  SnapshotJournalDestinationBinding,
  SnapshotJournalDestinationCheckpoint
} from './journal/SnapshotJournalTypes'
import type { SnapshotJournalWriterAdmission } from './journal/SnapshotJournalProvider'
import { snapshotJournalReceiptBinding } from './journal/SnapshotJournalReceipt'
import { withSnapshotJournalDestinationWindowFence } from './journal/SnapshotJournalDestinationWindow'
import { verifySnapshotJournalDestinationSchema } from './journal/SnapshotJournalDestinationSchema'
import { readSnapshotJournalCaptureConfiguration } from './journal/SnapshotJournalLifecycle'
import {
  readSnapshotJournalDestinationFieldPromotionPage,
  type SnapshotJournalDestinationStageReceipt
} from './journal/SnapshotJournalDestinationStage'
import { requireSnapshotJournalCapturedFrame } from './journal/SnapshotJournalCapturedIdentities'
import { encodeSnapshotJournalFieldFrame } from './journal/SnapshotJournalDeltaFrame'
import { readNativeSnapshotJournalMappingRevision } from './NativeSnapshotSyncMappingSchemaNode'
import { readNativeSnapshotTransactionMembershipRevision } from './NativeSnapshotSyncRequestsCurrentNode'
import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import type { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import { copySnapshotCursor } from './SnapshotCursor'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

const issued = new WeakSet<NativeSnapshotSyncStructuredSource>()
function invalid(): never {
  throw new Error('Native structured source differs from its actual producer, source or session')
}
/** Original concrete preparation owner. It holds no read pool and stores no
 * schema, backend or semantic verdict. Every fresh operation opens and drains
 * the destination's current session/profile/primary view. Derived JSON content
 * is provisional DATA; it does not authorize a row, map or checkpoint effect. */
export class NativeSnapshotSyncStructuredSource {
  readonly #root
  readonly #origin
  readonly #binding
  readonly #deadline
  readonly #checkpoint: SnapshotSyncCheckpoint
  private constructor(
    readonly storage: StorageKnex,
    readonly destination: KnexSnapshotSyncDestination,
    readonly source: WalletReadSnapshot,
    checkpoint: SnapshotSyncCheckpoint,
    readonly working: Brc38WorkingAllocation,
    readonly expiresAt: number,
    readonly checkComponent: () => void,
    readonly signal?: AbortSignal
  ) {
    this.#root = storage.knex
    this.#origin = ownedNativeRootIdentity(this.#root)
    this.#binding = Object.freeze({
      snapshotId: source.snapshotId,
      userId: source.user.userId,
      identityKey: source.user.identityKey,
      storageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    })
    this.#checkpoint = Object.freeze({ ...checkpoint, cursor: copySnapshotCursor(checkpoint.cursor) })
    this.#deadline = performance.now() + expiresAt - Date.now()
    issued.add(this)
  }
  static async open(
    storage: StorageKnex,
    destination: KnexSnapshotSyncDestination,
    source: WalletReadSnapshot,
    checkpoint: SnapshotSyncCheckpoint,
    working: Brc38WorkingAllocation,
    expiresAt: number,
    checkComponent: () => void,
    signal?: AbortSignal
  ): Promise<NativeSnapshotSyncStructuredSource> {
    if (brc38WorkingAllocation(working) !== working || !Number.isSafeInteger(expiresAt) || expiresAt > source.expiresAt)
      invalid()
    const actual = new NativeSnapshotSyncStructuredSource(
      storage,
      destination,
      source,
      checkpoint,
      working,
      expiresAt,
      checkComponent,
      signal
    )
    await actual.fresh()
    return actual
  }
  readonly check = (): void => {
    this.signal?.throwIfAborted()
    this.checkComponent()
    const b = this.#binding,
      s = this.source,
      c = this.#checkpoint
    if (
      !issued.has(this) ||
      this.#origin?.slot !== 0 ||
      this.storage.knex !== this.#root ||
      ownedNativeRootIdentity(this.#root)?.token !== this.#origin.token ||
      !s.isOpen ||
      s.fieldReader === undefined ||
      s.snapshotId !== b.snapshotId ||
      s.user.userId !== b.userId ||
      s.user.identityKey !== b.identityKey ||
      s.sourceStorage.storageIdentityKey !== b.storageIdentityKey ||
      s.sourceStorage.chain !== b.chain ||
      s.expiresAt !== b.expiresAt ||
      b.snapshotId !== c.snapshotId ||
      b.identityKey !== c.identityKey ||
      b.storageIdentityKey !== c.sourceStorageIdentityKey ||
      b.chain !== this.storage.chain ||
      this.expiresAt > b.expiresAt
    )
      invalid()
    if (Date.now() >= this.expiresAt || performance.now() >= this.#deadline)
      throw new SnapshotResourceLimitError('Native structured source original deadline ended')
  }
  async fresh(): Promise<void> {
    this.check()
    const allocation = this.working.claim(16384 + 8 * 65536)
    try {
      await this.destination.inspectNativeFieldSession(this.#checkpoint, this.signal, read => {
        return promiseFromSync(() => {
          this.check()
          if (read.sourceUserId !== this.#binding.userId || this.expiresAt > read.expiresAt) invalid()
        })
      })
      this.check()
    } finally {
      allocation.close()
    }
  }
}
export function requireNativeSnapshotSyncStructuredSource(value: NativeSnapshotSyncStructuredSource): void {
  if (!issued.has(value)) invalid()
  value.check()
}

const journalIssued = new WeakSet<NativeSnapshotJournalStructuredSource>()
/** A distinct concrete journal preparation owner. The authenticated field
 * archive remains DATA: actual native root, current window and stage ownership
 * are inspected through the destination's physical writer on every fresh view.
 * No WalletReadSnapshot or full-snapshot session is synthesized. */
export class NativeSnapshotJournalStructuredSource {
  readonly #root
  readonly #origin
  readonly #binding
  readonly #checkpoint
  readonly #receipt
  readonly #deadline
  #mappingRevision?: string
  #transactionRevision?: string
  private constructor(
    readonly storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    checkpoint: SnapshotJournalDestinationCheckpoint,
    receipt: SnapshotJournalDestinationStageReceipt,
    readonly changeIndex: number,
    readonly source: RemoteSnapshotJournalFieldArchive,
    readonly frame: RemoteSnapshotJournalFieldFrame,
    readonly working: Brc38WorkingAllocation,
    readonly expiresAt: number,
    readonly admission: SnapshotJournalWriterAdmission,
    readonly checkComponent: () => void,
    readonly signal?: AbortSignal
  ) {
    this.#root = storage.knex
    this.#origin = ownedNativeRootIdentity(this.#root)
    this.#binding = structuredClone(binding)
    this.#checkpoint = structuredClone(checkpoint)
    this.#receipt = { ...receipt }
    this.#deadline = performance.now() + expiresAt - Date.now()
    journalIssued.add(this)
  }
  static async open(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    checkpoint: SnapshotJournalDestinationCheckpoint,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number,
    source: RemoteSnapshotJournalFieldArchive,
    frame: RemoteSnapshotJournalFieldFrame,
    working: Brc38WorkingAllocation,
    expiresAt: number,
    admission: SnapshotJournalWriterAdmission,
    checkComponent: () => void,
    signal?: AbortSignal
  ): Promise<NativeSnapshotJournalStructuredSource> {
    const actual = new NativeSnapshotJournalStructuredSource(
      storage,
      binding,
      checkpoint,
      receipt,
      changeIndex,
      source,
      frame,
      working,
      expiresAt,
      admission,
      checkComponent,
      signal
    )
    actual.check()
    await admission(
      async () =>
        await storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            actual.check()
            if (backend !== actual.#binding.destinationBackend) invalid()
            await verifySnapshotJournalDestinationSchema(trx)
            await withSnapshotJournalDestinationWindowFence(trx, actual.#binding, actual.#checkpoint, async fenced => {
              actual.#mappingRevision = await readNativeSnapshotJournalMappingRevision(fenced as Knex.Transaction)
              actual.#transactionRevision = await readNativeSnapshotTransactionMembershipRevision(
                fenced as Knex.Transaction
              )
            })
          },
          actual.#binding.destinationBackend,
          signal
        )
    )
    await actual.fresh()
    return actual
  }
  readonly check = (): void => {
    this.signal?.throwIfAborted()
    this.checkComponent()
    assertRemoteSnapshotJournalFieldFrame(this.source, this.frame)
    const b = this.#binding,
      r = this.#receipt,
      c = this.#checkpoint,
      a = this.source.manifest.binding
    if (
      !journalIssued.has(this) ||
      this.#origin?.slot !== 0 ||
      this.#root.isTransaction ||
      this.storage.knex !== this.#root ||
      ownedNativeRootIdentity(this.#root)?.token !== this.#origin.token ||
      brc38WorkingAllocation(this.working) !== this.working ||
      b.fieldEncoding !== 'wallet-journal-fields/1' ||
      c.phase !== 'promoting' ||
      this.frame.tableId !== 9 ||
      r.tableId !== 9 ||
      r.sequence !== this.frame.ordinal + 1 ||
      r.digest !== this.frame.frameDigest ||
      !Number.isSafeInteger(this.changeIndex) ||
      this.changeIndex < 0 ||
      this.frame.page.changes[this.changeIndex]?.present !== true ||
      !Number.isSafeInteger(this.expiresAt) ||
      this.expiresAt > this.source.expiresAt ||
      this.expiresAt > b.receipt.expiresAt ||
      b.source.identityKey !== a.user.identityKey ||
      b.source.chain !== this.storage.chain ||
      snapshotJournalReceiptBinding(b.source) !== snapshotJournalReceiptBinding(a.journal.source) ||
      JSON.stringify(b.receipt) !== JSON.stringify(a.journal.receipt) ||
      b.low !== a.journal.low ||
      (b.bootstrap === true) !== a.journal.bootstrap ||
      typeof this.admission !== 'function'
    )
      invalid()
    if (Date.now() >= this.expiresAt || performance.now() >= this.#deadline)
      throw new SnapshotResourceLimitError('Native journal structured owner reached its original deadline')
  }
  /** Passed SQL is accepted only under the same real native writer/window.
   * Used by the final writer as well as fresh preparation views. */
  async assertCurrent(trx: Knex.Transaction): Promise<void> {
    this.check()
    if (
      !trx.isTransaction ||
      ownedNativeRootIdentity(trx)?.token !== this.#origin?.token ||
      ownedNativeRootIdentity(trx)?.slot !== 0
    )
      invalid()
    await verifySnapshotJournalDestinationSchema(trx)
    await readSnapshotJournalCaptureConfiguration(trx)
    await withSnapshotJournalDestinationWindowFence(trx, this.#binding, this.#checkpoint, async actual => {
      const staged = await readSnapshotJournalDestinationFieldPromotionPage(actual, this.#binding, this.#checkpoint),
        encoded = encodeSnapshotJournalFieldFrame(this.frame.page, { stream: this.frame.stream, tableId: 9 })
      if (
        staged === undefined ||
        staged.receipt.digest !== this.#receipt.digest ||
        staged.receipt.sequence !== this.#receipt.sequence ||
        encoded.length !== this.#receipt.bytes ||
        createHash('sha256').update(encoded).digest('hex') !== this.#receipt.digest ||
        JSON.stringify(staged.page.changes[this.changeIndex]) !==
          JSON.stringify(this.frame.page.changes[this.changeIndex])
      )
        invalid()
      await requireSnapshotJournalCapturedFrame(
        actual,
        this.#binding,
        this.#checkpoint,
        this.#receipt.digest,
        staged.page.changes.length
      )
      const mapping = await readNativeSnapshotJournalMappingRevision(actual as Knex.Transaction),
        membership = await readNativeSnapshotTransactionMembershipRevision(actual as Knex.Transaction)
      if (
        this.#mappingRevision === undefined ||
        this.#transactionRevision === undefined ||
        mapping !== this.#mappingRevision ||
        membership !== this.#transactionRevision
      )
        invalid()
      this.check()
    })
  }
  async inspect<T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    this.check()
    return await this.admission(
      async () =>
        await this.storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            if (backend !== this.#binding.destinationBackend) invalid()
            await this.assertCurrent(trx as Knex.Transaction)
            const result = await operation(trx as Knex.Transaction)
            this.check()
            return result
          },
          this.#binding.destinationBackend,
          this.signal
        )
    )
  }
  async fresh(): Promise<void> {
    const allowance = this.working.claim(16384 + 8 * 65536)
    try {
      await this.inspect(() => {
        return promiseFromSync(() => {
          this.check()
        })
      })
    } finally {
      allowance.close()
    }
  }
}
export type NativeSnapshotStructuredOwner = NativeSnapshotSyncStructuredSource | NativeSnapshotJournalStructuredSource
export function requireNativeSnapshotStructuredOwner(value: NativeSnapshotStructuredOwner): void {
  if (journalIssued.has(value as NativeSnapshotJournalStructuredSource)) {
    value.check()
  } else requireNativeSnapshotSyncStructuredSource(value as NativeSnapshotSyncStructuredSource)
}
