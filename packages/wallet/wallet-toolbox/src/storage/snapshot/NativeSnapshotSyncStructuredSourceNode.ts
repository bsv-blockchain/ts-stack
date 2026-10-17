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
      await this.destination.inspectNativeFieldSession(this.#checkpoint, this.signal, async read => {
        this.check()
        if (read.sourceUserId !== this.#binding.userId || this.expiresAt > read.expiresAt) invalid()
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
