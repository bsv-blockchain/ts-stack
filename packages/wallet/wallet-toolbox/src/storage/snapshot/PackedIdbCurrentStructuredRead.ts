import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import type { PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { openPackedIdbSnapshot, type PackedIdbReadSnapshot } from '../idbPackedSnapshot'
import { PackedIdbJsonIndex } from '../idbPackedJsonIndex'
import type { PackedIdbField } from '../idbPackedFields'
import type { WalletSnapshotCursor, WalletSnapshotTable } from './WalletReadSnapshot'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from '../portable/Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from '../portable/Brc38StructuredProjectionOwners'
import {
  brc38WorkingAllocation,
  type Brc38WorkingAllocation,
  type Brc38WorkingCharge
} from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

export interface PackedIdbCurrentStructuredLimits {
  readonly maximumMetadataBytes: number
  readonly maximumStructuredBytes: number
  readonly maximumReadBytes: number
  /** Combined original logical storage charge for every simultaneously open
   * index, including each fixed stage charge. Browser filesystem size is not
   * measured by this allowance. Native owner quota also applies. */
  readonly maximumTemporaryIndexBytes: number
  readonly maximumGrammarIndexBytes: number
  readonly maximumIndexMembers: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
type Current = Readonly<{ metadata: Readonly<PackedIdbCurrentMetadata>; expiresAt: number }>
type CurrentRead = (view?: PackedIdbReadSnapshot) => Promise<Current>
function invalid(): never {
  throw new Error('Occupied packed field source, current row, session or original limits changed')
}
function bound(value: number, low: number, high: number): void {
  if (!Number.isSafeInteger(value) || value < low || value > high) invalid()
}
function same(a: Current, b: Current, field: string): void {
  const left = a.metadata,
    right = b.metadata,
    x = left.extents[field],
    y = right.extents[field]
  if (
    a.expiresAt !== b.expiresAt ||
    left.store !== right.store ||
    indexedDB.cmp(left.key, right.key) !== 0 ||
    left.revision !== right.revision ||
    x === undefined ||
    y === undefined ||
    x.content !== y.content ||
    x.kind !== y.kind ||
    x.bytes !== y.bytes ||
    x.sha256 !== y.sha256
  )
    invalid()
}

/** Internal occupied-target reader. The journal supplies a concrete current
 * session read; each operation repeats it in an actual drained native view.
 * The retained snapshot is opened here by the real factory, never supplied by
 * a descriptor or copied caller object. Revision/extent/hash values are DATA;
 * a final writer must still freshly reconcile the target and checkpoint. */
export class PackedIdbCurrentStructuredRead {
  readonly metadata: Readonly<PackedIdbCurrentMetadata>
  readonly source: Brc38StreamedStructured
  readonly #storage: StorageIdb
  readonly #owner: PackedIdbConnection
  readonly #view: PackedIdbReadSnapshot
  readonly #initial: Current
  readonly #field: string
  readonly #extent: Readonly<PackedIdbField>
  readonly #table: WalletSnapshotTable
  readonly #cursor: WalletSnapshotCursor
  readonly #limits: Readonly<PackedIdbCurrentStructuredLimits>
  readonly #working: Brc38WorkingAllocation
  readonly #retained: Brc38WorkingCharge
  readonly #current: CurrentRead
  readonly #deadline: number
  readonly #indexes = new Set<Brc38JsonMemberIndex>()
  readonly #acquisitions = new Set<() => Promise<void>>()
  #indexBytes = 0
  #closed = false
  #busy = false
  #active: Promise<unknown> = Promise.resolve()
  #closing?: Promise<void>
  #loan?: { bytes: Uint8Array; charge: Brc38WorkingCharge }
  private constructor(
    storage: StorageIdb,
    owner: PackedIdbConnection,
    view: PackedIdbReadSnapshot,
    initial: Current,
    table: WalletSnapshotTable,
    field: string,
    limits: Readonly<PackedIdbCurrentStructuredLimits>,
    working: Brc38WorkingAllocation,
    retained: Brc38WorkingCharge,
    current: CurrentRead,
    deadline: number
  ) {
    this.#storage = storage
    this.#owner = owner
    this.#view = view
    this.#initial = initial
    this.metadata = initial.metadata
    this.#field = field
    this.#extent = Object.freeze({ ...initial.metadata.extents[field] })
    this.#table = table
    this.#limits = limits
    this.#working = working
    this.#retained = retained
    this.#current = current
    this.#deadline = deadline
    this.#cursor = Object.freeze({
      version: 1,
      snapshotId: view.snapshotId,
      table,
      after: Object.freeze(
        Array.isArray(initial.metadata.key) ? [...initial.metadata.key] : [initial.metadata.key]
      ) as unknown as Array<number | string>
    })
    this.source = Object.freeze({
      encoding: 'utf16le' as const,
      length: this.#extent.bytes,
      sha256: this.#extent.sha256,
      read: (offset: number, length: number) => this.read(offset, length),
      openIndex: () =>
        this.openIndex({
          sourceBytes: this.#extent.bytes,
          maximumTemporaryIndexBytes: limits.maximumGrammarIndexBytes,
          maximumTemporaryPhysicalBytes: limits.maximumGrammarIndexBytes,
          maximumMembers: limits.maximumIndexMembers,
          maximumAllocationBytes: working.maximum,
          workingAllocation: working,
          expiresAt: limits.expiresAt,
          signal: limits.signal
        })
    })
  }
  static async open(
    storage: StorageIdb,
    owner: PackedIdbConnection,
    identityKey: string,
    table: WalletSnapshotTable,
    field: string,
    selected: PackedIdbCurrentStructuredLimits,
    selectedWorking: Brc38WorkingAllocation,
    current: CurrentRead
  ): Promise<PackedIdbCurrentStructuredRead> {
    const limits = Object.freeze({
        maximumMetadataBytes: selected.maximumMetadataBytes,
        maximumStructuredBytes: selected.maximumStructuredBytes,
        maximumReadBytes: selected.maximumReadBytes,
        maximumTemporaryIndexBytes: selected.maximumTemporaryIndexBytes,
        maximumIndexMembers: selected.maximumIndexMembers,
        maximumGrammarIndexBytes: selected.maximumGrammarIndexBytes,
        expiresAt: selected.expiresAt,
        signal: selected.signal
      }),
      working = brc38WorkingAllocation(selectedWorking)!
    bound(limits.maximumMetadataBytes, 1, 16777216)
    bound(limits.maximumStructuredBytes, 2, 1000000000)
    bound(limits.maximumReadBytes, 64, 65536)
    bound(limits.maximumTemporaryIndexBytes, 512, 17179869184)
    bound(limits.maximumGrammarIndexBytes, 512, limits.maximumTemporaryIndexBytes)
    bound(limits.maximumIndexMembers, 1, 2000000000)
    bound(limits.expiresAt, Date.now() + 1, Date.now() + 3600000)
    if (
      working === undefined ||
      typeof identityKey !== 'string' ||
      identityKey.length < 1 ||
      identityKey.length > 130 ||
      typeof field !== 'string' ||
      field.length < 1 ||
      field.length > 128 ||
      !owner.isOpen ||
      storage.db !== owner.database ||
      storage.dbName !== owner.database.name ||
      getPackedIdbConnection(owner.database) !== owner
    )
      invalid()
    limits.signal?.throwIfAborted()
    const deadline = performance.now() + limits.expiresAt - Date.now(),
      retained = working.claim(8192 + 8 * limits.maximumMetadataBytes)
    let view: PackedIdbReadSnapshot | undefined
    const cleanup = async (): Promise<void> => {
      await view?.close()
      retained.close()
    }
    try {
      const initial = await current(),
        extent = initial.metadata.extents[field]
      if (
        limits.expiresAt > initial.expiresAt ||
        initial.metadata.allocationBytes > limits.maximumMetadataBytes ||
        extent === undefined ||
        extent.kind !== 'utf16' ||
        extent.bytes % 2 !== 0
      )
        invalid()
      bound(extent.bytes, 2, limits.maximumStructuredBytes)
      limits.signal?.throwIfAborted()
      const lifetimeMs = limits.expiresAt - Date.now()
      bound(lifetimeMs, 1, 3600000)
      view = await openPackedIdbSnapshot(owner.database, identityKey, storage.chain, {
        lifetimeMs,
        signal: limits.signal
      })
      // The journal's factory wrapper supplies the actual destination profile;
      // it is not derived from a global request row or an incoming archive ID.
      same(initial, await current(view), field)
      const result = new PackedIdbCurrentStructuredRead(
        storage,
        owner,
        view,
        initial,
        table,
        field,
        limits,
        working,
        retained,
        current,
        deadline
      )
      await result.#run(async () => {
        await view!.readFieldExtent(table, result.#cursor, field, 0, 0, result.#extent)
      })
      return result
    } catch (cause) {
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Occupied field acquisition retains its actual snapshot and allocation',
          cleanup
        )
      }
      throw cause
    }
  }
  readonly check = (): void => {
    this.#limits.signal?.throwIfAborted()
    if (
      this.#closed ||
      !this.#owner.isOpen ||
      !this.#view.isOpen ||
      this.#storage.db !== this.#owner.database ||
      this.#storage.dbName !== this.#owner.database.name ||
      getPackedIdbConnection(this.#owner.database) !== this.#owner
    )
      invalid()
    if (Date.now() >= this.#limits.expiresAt || performance.now() >= this.#deadline)
      throw new SnapshotResourceLimitError('Occupied packed field reached its original source deadline')
  }
  async #run<T>(work: () => Promise<T>): Promise<T> {
    this.check()
    if (this.#busy) invalid()
    this.#busy = true
    const operation = (async () => {
      same(this.#initial, await this.#current(this.#view), this.#field)
      this.check()
      const result = await work()
      same(this.#initial, await this.#current(this.#view), this.#field)
      this.check()
      return result
    })()
    this.#active = operation
    try {
      return await operation
    } finally {
      this.#busy = false
    }
  }
  #releaseLoan(): void {
    this.#loan?.bytes.fill(0)
    this.#loan?.charge.close()
    this.#loan = undefined
  }
  /** Loan survives until the next read or close. Physical chunk reads and the
   * returned bytes share the original aggregate allowance; no complete TEXT. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.check()
    bound(offset, 0, this.#extent.bytes)
    bound(length, 0, Math.min(this.#limits.maximumReadBytes, this.#extent.bytes - offset))
    if (this.#busy) invalid()
    this.#releaseLoan()
    const charge = this.#working.claim(4096 + 32 * 65536 + 4 * length)
    let bytes: Uint8Array | undefined
    try {
      await this.#run(async () => {
        bytes = await this.#view.readFieldExtent(this.#table, this.#cursor, this.#field, offset, length, this.#extent)
      })
      if (bytes === undefined) invalid()
      this.#loan = { bytes, charge }
      return bytes
    } catch (cause) {
      bytes?.fill(0)
      charge.close()
      throw cause
    }
  }
  readonly openIndex = async (
    selected: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]
  ): Promise<Brc38JsonMemberIndex> => {
    const policy = Object.freeze({ ...selected })
    this.check()
    bound(policy.sourceBytes, 4, this.#limits.maximumStructuredBytes)
    bound(policy.maximumTemporaryIndexBytes, 512, this.#limits.maximumTemporaryIndexBytes)
    bound(
      policy.maximumTemporaryPhysicalBytes,
      policy.maximumTemporaryIndexBytes,
      this.#limits.maximumTemporaryIndexBytes
    )
    bound(policy.maximumMembers, 1, this.#limits.maximumIndexMembers)
    bound(policy.expiresAt, Date.now() + 1, this.#limits.expiresAt)
    if (
      policy.workingAllocation !== this.#working ||
      policy.maximumTemporaryIndexBytes > this.#limits.maximumTemporaryIndexBytes - this.#indexBytes
    )
      invalid()
    const maximumAllocation = policy.maximumAllocationBytes ?? this.#working.maximum
    bound(maximumAllocation, 4096, this.#working.maximum)
    if (8192 + 8 * this.#limits.maximumMetadataBytes + 4096 + 16 * 8192 + 8192 + 32 * 8192 > maximumAllocation)
      throw new SnapshotResourceLimitError('Occupied JSON index exceeds its original individual working allowance')
    policy.signal?.throwIfAborted()
    const retained = this.#working.claim(4096 + 16 * 8192)
    this.#indexBytes += policy.maximumTemporaryIndexBytes
    let actual: PackedIdbJsonIndex | undefined,
      released = false
    const release = async (): Promise<void> => {
      if (released) return
      await actual?.close()
      retained.close()
      this.#indexBytes -= policy.maximumTemporaryIndexBytes
      released = true
      this.#acquisitions.delete(release)
    }
    try {
      await this.#run(async () => {
        actual = await PackedIdbJsonIndex.open(this.#owner, this.#view, this.#extent, {
          maximumBytes: policy.maximumTemporaryIndexBytes,
          maximumMembers: policy.maximumMembers,
          maximumSourceSpanBytes: Math.max(this.#extent.bytes, policy.sourceBytes)
        })
      })
      let closed = false,
        closing: Promise<void> | undefined
      const iterators = new Set<AsyncGenerator<Brc38JsonMember>>()
      const operation = async <T>(work: () => Promise<T>): Promise<T> => {
        this.check()
        policy.signal?.throwIfAborted()
        if (closed || Date.now() >= policy.expiresAt) invalid()
        const scratch = this.#working.claim(8192 + 32 * 8192)
        try {
          return await this.#run(work)
        } finally {
          scratch.close()
        }
      }
      const index: Brc38JsonMemberIndex = Object.freeze({
        put: (offset: number, value: Brc38JsonMember) => {
          const captured = Object.freeze({
            key: value.key,
            keyOffset: value.keyOffset,
            start: value.start,
            end: value.end
          })
          return operation(async () => await actual!.put(offset, captured))
        },
        seal: () => operation(async () => await actual!.seal()),
        lookup: (offset: number, key: string) => operation(async () => await actual!.lookup(offset, key)),
        nextEntry: (offset: number, after?: string) => {
          this.check()
          if (closed || iterators.size !== 0) invalid()
          return operation(async () => await actual!.nextEntry(offset, after))
        },
        entries: (offset: number) => {
          this.check()
          if (closed || iterators.size !== 0) invalid()
          const source = actual!.entries(offset)
          let output: AsyncGenerator<Brc38JsonMember> | undefined
          output = (async function* (): AsyncGenerator<Brc38JsonMember> {
            try {
              for (;;) {
                const next = await operation(async () => await source.next())
                if (next.done) return
                yield next.value
              }
            } finally {
              await source.return(undefined)
              if (output !== undefined) iterators.delete(output)
            }
          })()
          iterators.add(output)
          return output
        },
        close: (): Promise<void> => {
          if (closing !== undefined) return closing
          closed = true
          closing = (async () => {
            await Promise.allSettled([this.#active])
            for (const iterator of iterators) await iterator.return(undefined)
            await release()
            this.#indexes.delete(index)
          })()
          void closing.catch(() => {
            closing = undefined
          })
          return closing
        }
      })
      this.#indexes.add(index)
      return index
    } catch (cause) {
      try {
        await release()
      } catch (error_) {
        this.#acquisitions.add(release)
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Occupied field retains its actual acquired index and reservation',
          release
        )
      }
      throw cause
    }
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      await Promise.allSettled([this.#active])
      this.#releaseLoan()
      const failures: unknown[] = []
      for (const index of this.#indexes)
        try {
          await index.close()
        } catch (cause) {
          failures.push(cause)
        }
      for (const release of this.#acquisitions)
        try {
          await release()
        } catch (cause) {
          failures.push(cause)
        }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(
          failures,
          'Occupied field retains native indexes and original allocations until actual cleanup',
          () => this.close()
        )
      try {
        await this.#view.close()
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          [cause],
          'Occupied field retains its actual snapshot lease and allocation',
          () => this.close()
        )
      }
      this.#retained.close()
    })()
    void this.#closing.catch(() => {
      this.#closing = undefined
    })
    return this.#closing
  }
}
