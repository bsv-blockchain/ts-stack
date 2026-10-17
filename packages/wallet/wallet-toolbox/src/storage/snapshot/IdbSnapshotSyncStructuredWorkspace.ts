import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import { PackedIdbJsonIndex } from '../idbPackedJsonIndex'
import {
  openPackedIdbSnapshot,
  requirePackedIdbSnapshotInTransaction,
  type PackedIdbReadSnapshot
} from '../idbPackedSnapshot'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import type { PackedIdbField } from '../idbPackedFields'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from '../portable/Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from '../portable/Brc38StructuredProjectionOwners'
import type { Brc38WorkingAllocation, Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import {
  IdbSnapshotSyncJournal,
  captureIdbSnapshotSyncCheckpoint,
  type IdbSnapshotSyncFieldLoan
} from './IdbSnapshotSyncJournal'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'

/** Preparation-only JSON workspace. A real destination snapshot leases its
 * temporary indexes; actual issued stages/current journal readers supply
 * bytes separately. Index spans never establish source or write authority.
 * Every operation enters a fresh, drained current session/profile fence. */
export class IdbSnapshotSyncStructuredWorkspace {
  readonly #indexes = new Set<Brc38JsonMemberIndex>()
  readonly #sources = new Set<() => void>()
  readonly #pending = new Set<Promise<unknown>>()
  #indexBytes = 0
  #closed = false
  #closing?: Promise<void>
  private constructor(
    readonly storage: StorageIdb,
    readonly journal: IdbSnapshotSyncJournal,
    readonly checkpoint: SnapshotSyncCheckpoint,
    readonly working: Brc38WorkingAllocation,
    readonly expiresAt: number,
    readonly checkSource: () => void,
    readonly owner: PackedIdbConnection,
    readonly view: PackedIdbReadSnapshot,
    readonly retained: Brc38WorkingCharge,
    readonly signal?: AbortSignal,
    readonly maximumIndexBytes = 67108864,
    readonly maximumMembers = 1000000,
    readonly deadline = performance.now() + expiresAt - Date.now()
  ) {}
  static async open(
    storage: StorageIdb,
    journal: IdbSnapshotSyncJournal,
    selected: SnapshotSyncCheckpoint,
    working: Brc38WorkingAllocation,
    expiresAt: number,
    checkSource: () => void,
    signal?: AbortSignal
  ): Promise<IdbSnapshotSyncStructuredWorkspace> {
    const checkpoint = captureIdbSnapshotSyncCheckpoint(selected)
    journal.requireStorage(storage)
    signal?.throwIfAborted()
    checkSource()
    const db = storage.db,
      owner = db === undefined ? undefined : getPackedIdbConnection(db)
    if (db === undefined || owner === undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new Error('Current structured workspace admission differs')
    const retained = working.claim(16384 + 8 * 65536)
    let view: PackedIdbReadSnapshot | undefined
    try {
      await journal.inspect(checkpoint, async read => {
        if (expiresAt > read.expiresAt) throw new Error('Structured workspace cannot extend the original session')
      })
      view = await openPackedIdbSnapshot(db, checkpoint.identityKey, storage.chain, {
        lifetimeMs: expiresAt - Date.now(),
        signal
      })
      const result = new IdbSnapshotSyncStructuredWorkspace(
        storage,
        journal,
        checkpoint,
        working,
        expiresAt,
        checkSource,
        owner,
        view,
        retained,
        signal
      )
      await result.fresh()
      return result
    } catch (cause) {
      const cleanup = async (): Promise<void> => {
        await view?.close()
        retained.close()
      }
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Structured workspace acquisition retains its actual lease',
          cleanup
        )
      }
      throw cause
    }
  }
  readonly check = (): void => {
    this.signal?.throwIfAborted()
    this.checkSource()
    this.journal.requireStorage(this.storage)
    if (this.#closed || !this.view.isOpen || getPackedIdbConnection(this.owner.database) !== this.owner)
      throw new Error('Structured workspace owner or lease changed')
    if (Date.now() >= this.expiresAt || performance.now() >= this.deadline)
      throw new SnapshotResourceLimitError('Structured workspace original deadline ended')
  }
  async fresh(): Promise<void> {
    this.check()
    const allocation = this.working.claim(16384 + 8 * 65536)
    try {
      await this.journal.inspect(this.checkpoint, async read => {
        await requirePackedIdbSnapshotInTransaction(this.view, this.owner, read.transaction)
      })
      this.check()
    } finally {
      allocation.close()
    }
  }
  /** Call only after the caller's complete grammar/projection pass has drained
   * its iterators. No bytes from that pass remain in use. This prevents completed
   * independent sources retaining one native window each until final close. */
  releaseReadWindows(): void {
    if (this.#pending.size !== 0) throw new Error('Structured reads must drain before releasing their windows')
    for (const release of this.#sources) release()
  }
  async #own<T>(work: () => Promise<T>): Promise<T> {
    this.check()
    const pending = (async () => {
      await this.fresh()
      const result = await work()
      await this.fresh()
      return result
    })()
    this.#pending.add(pending)
    try {
      return await pending
    } finally {
      this.#pending.delete(pending)
    }
  }
  readonly openIndex = async (
    selected: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0],
    field: Readonly<PackedIdbField>
  ): Promise<Brc38JsonMemberIndex> => {
    const policy = Object.freeze({ ...selected })
    this.check()
    if (
      policy.workingAllocation !== this.working ||
      policy.expiresAt > this.expiresAt ||
      !Number.isSafeInteger(policy.maximumTemporaryIndexBytes) ||
      policy.maximumTemporaryIndexBytes < 512 ||
      policy.maximumTemporaryIndexBytes > this.maximumIndexBytes - this.#indexBytes ||
      policy.maximumTemporaryPhysicalBytes < policy.maximumTemporaryIndexBytes ||
      policy.maximumTemporaryPhysicalBytes > this.maximumIndexBytes ||
      !Number.isSafeInteger(policy.sourceBytes) ||
      policy.sourceBytes < 4 ||
      policy.sourceBytes > 1000000000 ||
      !Number.isSafeInteger(policy.maximumMembers) ||
      policy.maximumMembers < 1 ||
      policy.maximumMembers > this.maximumMembers ||
      (policy.maximumAllocationBytes !== undefined &&
        (policy.maximumAllocationBytes < 4096 || policy.maximumAllocationBytes > this.working.maximum))
    )
      throw new SnapshotResourceLimitError('Structured index exceeds its original aggregate admission')
    const retained = this.working.claim(4096 + 16 * 8192)
    this.#indexBytes += policy.maximumTemporaryIndexBytes
    let actual: PackedIdbJsonIndex | undefined,
      released = false
    const release = async (): Promise<void> => {
      if (released) return
      await actual?.close()
      this.#indexBytes -= policy.maximumTemporaryIndexBytes
      retained.close()
      released = true
    }
    try {
      await this.#own(async () => {
        actual = await PackedIdbJsonIndex.open(this.owner, this.view, field, {
          maximumBytes: policy.maximumTemporaryIndexBytes,
          maximumMembers: policy.maximumMembers,
          maximumSourceSpanBytes: Math.max(32, field.bytes, policy.sourceBytes)
        })
      })
      let closed = false,
        closing: Promise<void> | undefined
      const iterators = new Set<AsyncGenerator<Brc38JsonMember>>(),
        operation = async <T>(work: () => Promise<T>): Promise<T> => {
          this.check()
          policy.signal?.throwIfAborted()
          if (closed || Date.now() >= policy.expiresAt) throw new Error('Structured index operation ended')
          const allocation = this.working.claim(8192 + 32 * 8192)
          try {
            return await this.#own(work)
          } finally {
            allocation.close()
          }
        },
        index: Brc38JsonMemberIndex = Object.freeze({
          put: async (offset: number, member: Brc38JsonMember) => {
            const captured = Object.freeze({
              key: member.key,
              keyOffset: member.keyOffset,
              start: member.start,
              end: member.end
            })
            await operation(async () => await actual!.put(offset, captured))
          },
          seal: async () => await operation(async () => await actual!.seal()),
          lookup: async (offset: number, key: string) => await operation(async () => await actual!.lookup(offset, key)),
          nextEntry: async (offset: number, after?: string) => {
            this.check()
            if (closed || iterators.size !== 0) throw new Error('Structured index iterator already retained')
            return await operation(async () => await actual!.nextEntry(offset, after))
          },
          entries: (offset: number) => {
            this.check()
            if (closed || iterators.size !== 0) throw new Error('Structured index iterator already retained')
            const source = actual!.entries(offset)
            let output: AsyncGenerator<Brc38JsonMember> | undefined
            output = (async function* (workspace: IdbSnapshotSyncStructuredWorkspace): AsyncGenerator<Brc38JsonMember> {
              try {
                for (;;) {
                  workspace.check()
                  const next = await operation(async () => await source.next())
                  if (next.done) return
                  yield next.value
                }
              } finally {
                await source.return(undefined)
                if (output !== undefined) iterators.delete(output)
              }
            })(this)
            iterators.add(output)
            return output
          },
          close: (): Promise<void> => {
            if (closing !== undefined) return closing
            closed = true
            closing = (async () => {
              await Promise.allSettled(this.#pending)
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
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Structured index acquisition retains its original allocation and actual cleanup',
          release
        )
      }
      throw cause
    }
  }
  /** The issued stage is re-entered for every byte window. No descriptor or
   * copied prototype can manufacture staged content membership. */
  stagedSource(stage: PackedIdbStagedField): Brc38StreamedStructured {
    stage.requireOwner(this.owner)
    const field = stage.descriptor
    if (field.kind !== 'utf16' || field.bytes < 2) throw new Error('Structured source needs actual staged UTF-16 text')
    return this.source(field, async (offset, length) => {
      const allocation = this.working.claim(8192 + 32 * 65536 + 4 * length)
      let bytes: Uint8Array | undefined
      try {
        stage.requireOwner(this.owner)
        bytes = await stage.read(offset, length)
        stage.requireOwner(this.owner)
        return {
          bytes,
          close: () => {
            bytes?.fill(0)
            allocation.close()
          }
        }
      } catch (cause) {
        bytes?.fill(0)
        allocation.close()
        throw cause
      }
    })
  }
  /** Current field callback must use actual journal/native current-extent
   * loans; this envelope owns their buffer/charge through consumption. */
  source(
    field: Readonly<PackedIdbField>,
    read: (offset: number, length: number) => Promise<IdbSnapshotSyncFieldLoan>
  ): Brc38StreamedStructured {
    const descriptor = Object.freeze({ ...field })
    let loan: IdbSnapshotSyncFieldLoan | undefined,
      busy = false
    const release = (): void => {
      loan?.close()
      loan = undefined
    }
    this.#sources.add(release)
    return Object.freeze({
      encoding: 'utf16le' as const,
      length: descriptor.bytes,
      sha256: descriptor.sha256,
      read: async (offset: number, length: number) => {
        this.check()
        if (
          busy ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 16384 ||
          offset + length > descriptor.bytes
        )
          throw new Error('Structured source transfer differs from its original window')
        busy = true
        release()
        let actual: IdbSnapshotSyncFieldLoan | undefined
        try {
          await this.#own(async () => {
            actual = await read(offset, length)
          })
          if (actual === undefined) throw new Error('Structured source returned no owned window')
          if (!(actual.bytes instanceof Uint8Array) || actual.bytes.length !== length)
            throw new Error('Structured source extent changed')
          loan = actual
          return actual.bytes
        } catch (cause) {
          actual?.close()
          throw cause
        } finally {
          busy = false
        }
      },
      openIndex: async () =>
        await this.openIndex(
          {
            sourceBytes: Math.max(4, descriptor.bytes),
            maximumTemporaryIndexBytes: 8388608,
            maximumTemporaryPhysicalBytes: 8388608,
            maximumMembers: this.maximumMembers,
            workingAllocation: this.working,
            maximumAllocationBytes: this.working.maximum,
            expiresAt: this.expiresAt,
            signal: this.signal
          },
          descriptor
        )
    })
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      await Promise.allSettled(this.#pending)
      for (const release of this.#sources) release()
      const causes: unknown[] = []
      for (const index of this.#indexes)
        try {
          await index.close()
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(causes, 'Structured workspace retains actual index cleanup', () =>
          this.close()
        )
      await this.view.close()
      this.#sources.clear()
      this.retained.close()
    })()
    void this.#closing.catch(() => {
      this.#closing = undefined
    })
    return this.#closing
  }
}
