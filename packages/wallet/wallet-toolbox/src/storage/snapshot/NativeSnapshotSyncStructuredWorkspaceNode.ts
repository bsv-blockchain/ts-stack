import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38NodeJsonIndex } from '../portable/Brc38NodeJsonIndex'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from '../portable/Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from '../portable/Brc38StructuredProjectionOwners'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import type { Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import {
  type NativeSnapshotStructuredOwner,
  requireNativeSnapshotStructuredOwner
} from './NativeSnapshotSyncStructuredSourceNode'
import {
  assertPreparedPackedNativeSnapshotField,
  type PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

export interface NativeSnapshotSyncFieldLoan {
  readonly bytes: Uint8Array
  close(): void
}
/** Preparation-only private filesystem/index owner. There is no retained SQL
 * pool: every source/index operation enters and drains a fresh actual session
 * view. Temporary spans, SHA values and index entries are comparison DATA;
 * they cannot manufacture source reads or final writer policy. */
export class NativeSnapshotSyncStructuredWorkspace {
  readonly #indexes = new Set<Brc38JsonMemberIndex>()
  readonly #sources = new Set<() => void>()
  readonly #pending = new Set<Promise<unknown>>()
  #indexBytes = 0
  #closed = false
  #closing?: Promise<void>
  private constructor(
    readonly owner: NativeSnapshotStructuredOwner,
    readonly directory: string,
    readonly identity: Readonly<{ dev: number; ino: number; uid: number }>,
    readonly retained: Brc38WorkingCharge,
    readonly maximumIndexBytes = 67108864,
    readonly maximumMembers = 1000000
  ) {}
  static async open(owner: NativeSnapshotStructuredOwner): Promise<NativeSnapshotSyncStructuredWorkspace> {
    requireNativeSnapshotStructuredOwner(owner)
    await owner.fresh()
    const retained = owner.working.claim(16384)
    let directory: string | undefined
    let identity: Readonly<{ dev: number; ino: number; uid: number }> | undefined
    const cleanup = async (): Promise<void> => {
      if (directory !== undefined) {
        if (identity === undefined)
          throw new Error('Unidentified native structured directory requires explicit recovery')
        const actual = await lstat(directory)
        if (
          !actual.isDirectory() ||
          actual.isSymbolicLink() ||
          actual.dev !== identity.dev ||
          actual.ino !== identity.ino ||
          actual.uid !== identity.uid ||
          (actual.mode & 0o077) !== 0
        )
          throw new Error('Native structured acquisition cleanup refuses a substituted directory')
        await rmdir(directory)
      }
      retained.close()
    }
    try {
      directory = await mkdtemp(join(await realpath(tmpdir()), 'wallet-sync-json-'))
      const opened = await lstat(directory),
        uid = process.getuid?.()
      if (
        !opened.isDirectory() ||
        opened.isSymbolicLink() ||
        uid === undefined ||
        opened.uid !== uid ||
        !Number.isSafeInteger(opened.dev) ||
        !Number.isSafeInteger(opened.ino)
      )
        throw new Error('Native structured directory acquisition differs')
      identity = Object.freeze({ dev: opened.dev, ino: opened.ino, uid })
      const actual = await lstat(directory)
      if (
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        uid === undefined ||
        actual.uid !== uid ||
        (actual.mode & 0o777) !== 0o700 ||
        actual.dev !== identity.dev ||
        actual.ino !== identity.ino
      )
        throw new Error('Native structured workspace requires its actual private owned directory')
      const result = new NativeSnapshotSyncStructuredWorkspace(owner, directory, identity, retained)
      await result.fresh()
      return result
    } catch (cause) {
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Native structured acquisition retains its actual directory',
          cleanup
        )
      }
      throw cause
    }
  }
  readonly check = (): void => {
    requireNativeSnapshotStructuredOwner(this.owner)
    if (this.#closed) throw new Error('Native structured workspace closed')
  }
  async #directory(): Promise<void> {
    const actual = await lstat(this.directory)
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== this.identity.dev ||
      actual.ino !== this.identity.ino ||
      actual.uid !== this.identity.uid ||
      (actual.mode & 0o777) !== 0o700
    )
      throw new Error('Native structured directory identity changed')
  }
  async fresh(): Promise<void> {
    this.check()
    await this.#directory()
    await this.owner.fresh()
    this.check()
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
  releaseReadWindows(): void {
    if (this.#pending.size !== 0) throw new Error('Native structured reads must drain before releasing their windows')
    for (const release of this.#sources) release()
  }
  readonly openIndex = async (
    selected: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]
  ): Promise<Brc38JsonMemberIndex> => {
    const policy = Object.freeze({ ...selected }),
      working = this.owner.working
    this.check()
    if (
      policy.workingAllocation !== working ||
      policy.expiresAt > this.owner.expiresAt ||
      !Number.isSafeInteger(policy.sourceBytes) ||
      policy.sourceBytes < 1 ||
      policy.sourceBytes > 1000000000 ||
      !Number.isSafeInteger(policy.maximumTemporaryIndexBytes) ||
      policy.maximumTemporaryIndexBytes < 1048576 ||
      policy.maximumTemporaryIndexBytes > this.maximumIndexBytes - this.#indexBytes ||
      !Number.isSafeInteger(policy.maximumTemporaryPhysicalBytes) ||
      policy.maximumTemporaryPhysicalBytes < policy.maximumTemporaryIndexBytes ||
      policy.maximumTemporaryPhysicalBytes > this.maximumIndexBytes - this.#indexBytes ||
      !Number.isSafeInteger(policy.maximumMembers) ||
      policy.maximumMembers < 1 ||
      policy.maximumMembers > this.maximumMembers ||
      (policy.maximumAllocationBytes !== undefined &&
        (!Number.isSafeInteger(policy.maximumAllocationBytes) ||
          policy.maximumAllocationBytes < 4096 ||
          policy.maximumAllocationBytes > working.maximum))
    )
      throw new SnapshotResourceLimitError('Native structured index exceeds its original aggregate admission')
    const retained = working.claim(4096 + 16 * 8192),
      reserved = policy.maximumTemporaryPhysicalBytes
    this.#indexBytes += reserved
    let actual: Brc38NodeJsonIndex | undefined,
      released = false
    const release = async (): Promise<void> => {
      if (released) return
      await actual?.close()
      this.#indexBytes -= reserved
      retained.close()
      released = true
    }
    try {
      await this.#own(async () => {
        actual = await Brc38NodeJsonIndex.open({
          privateParent: this.directory,
          sourceBytes: policy.sourceBytes,
          maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes,
          maximumTemporaryPhysicalBytes: reserved,
          maximumMembers: policy.maximumMembers,
          maximumAllocationBytes: policy.maximumAllocationBytes,
          workingAllocation: working,
          expiresAt: policy.expiresAt,
          signal: policy.signal
        })
      })
      let closed = false,
        closing: Promise<void> | undefined
      const iterators = new Set<AsyncGenerator<Brc38JsonMember>>(),
        operation = async <T>(work: () => Promise<T>): Promise<T> => {
          this.check()
          policy.signal?.throwIfAborted()
          if (closed || Date.now() >= policy.expiresAt) throw new Error('Native structured index operation ended')
          return await this.#own(work)
        },
        index: Brc38JsonMemberIndex = Object.freeze({
          put: async (offset: number, member: Brc38JsonMember) =>
            await operation(
              async () =>
                await actual!.put(
                  offset,
                  Object.freeze({ key: member.key, keyOffset: member.keyOffset, start: member.start, end: member.end })
                )
            ),
          seal: async () => await operation(async () => await actual!.seal()),
          lookup: async (offset: number, key: string) => await operation(async () => await actual!.lookup(offset, key)),
          nextEntry: async (offset: number, after?: string) => {
            this.check()
            if (closed || iterators.size !== 0) throw new Error('Native structured index iterator already retained')
            return await operation(async () => await actual!.nextEntry(offset, after))
          },
          entries: (offset: number) => {
            this.check()
            if (closed || iterators.size !== 0) throw new Error('Native structured index iterator already retained')
            const input = actual!.entries(offset)
            let output: AsyncGenerator<Brc38JsonMember> | undefined
            output = (async function* (): AsyncGenerator<Brc38JsonMember> {
              try {
                for (;;) {
                  const next = await operation(async () => await input.next())
                  if (next.done) return
                  yield next.value
                }
              } finally {
                await input.return(undefined)
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
        throw new Brc38StagingCleanupError([cause, error_], 'Native structured index retains actual cleanup', release)
      }
      throw cause
    }
  }
  stagedSource(stage: PreparedPackedNativeSnapshotField, field: 'history' | 'notify'): Brc38StreamedStructured {
    assertPreparedPackedNativeSnapshotField(this.owner.storage, 'provenTxReqs', field, stage)
    if (stage.descriptor.kind !== 'utf8' || stage.descriptor.bytes < 1)
      throw new Error('Native structured source needs actual issued UTF-8 content')
    return this.source(stage.descriptor, async (offset, length) => {
      const allocation = this.owner.working.claim(16384 + 8 * 65536 + 4 * length)
      let bytes: Uint8Array | undefined
      try {
        assertPreparedPackedNativeSnapshotField(this.owner.storage, 'provenTxReqs', field, stage)
        bytes = await stage.read(offset, length)
        assertPreparedPackedNativeSnapshotField(this.owner.storage, 'provenTxReqs', field, stage)
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
  /** Establish complete hash DATA for an ordinary current SQL field before
   * exposing a structured reader. Every window uses the actual fresh session
   * view and keeps its original allocation until the loan is closed. */
  async currentSource(
    field: Readonly<{ bytes: number; sha256?: string }>,
    read: (offset: number, length: number) => Promise<NativeSnapshotSyncFieldLoan>
  ): Promise<Brc38StreamedStructured> {
    const descriptor = Object.freeze({ ...field })
    this.check()
    if (
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 ||
      descriptor.bytes > 1000000000 ||
      (descriptor.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(descriptor.sha256))
    )
      throw new Error('Native current structured extent differs')
    if (descriptor.sha256 !== undefined)
      return this.source({ bytes: descriptor.bytes, sha256: descriptor.sha256 }, read)
    const hash = createHash('sha256')
    for (let offset = 0; offset < descriptor.bytes;) {
      const length = Math.min(16384, descriptor.bytes - offset)
      await this.#own(async () => {
        const loan = await read(offset, length)
        try {
          this.check()
          if (!(loan.bytes instanceof Uint8Array) || loan.bytes.length !== length)
            throw new Error('Native current structured hash window differs')
          hash.update(loan.bytes)
        } finally {
          loan.close()
        }
      })
      offset += length
    }
    this.check()
    return this.source({ bytes: descriptor.bytes, sha256: hash.digest('hex') }, read)
  }
  source(
    field: Readonly<{ bytes: number; sha256: string }>,
    read: (offset: number, length: number) => Promise<NativeSnapshotSyncFieldLoan>
  ): Brc38StreamedStructured {
    const descriptor = Object.freeze({ ...field })
    if (
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 ||
      descriptor.bytes > 1000000000 ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(descriptor.sha256)
    )
      throw new Error('Native structured source extent differs')
    let loan: NativeSnapshotSyncFieldLoan | undefined,
      busy = false
    const release = (): void => {
      loan?.close()
      loan = undefined
    }
    this.#sources.add(release)
    return Object.freeze({
      encoding: 'utf8' as const,
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
          throw new Error('Native structured source exceeds its original window')
        busy = true
        release()
        let actual: NativeSnapshotSyncFieldLoan | undefined
        try {
          await this.#own(async () => {
            actual = await read(offset, length)
          })
          if (actual === undefined || !(actual.bytes instanceof Uint8Array) || actual.bytes.length !== length)
            throw new Error('Native structured source returned a different window')
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
        await this.openIndex({
          sourceBytes: descriptor.bytes,
          maximumTemporaryIndexBytes: 8388608,
          maximumTemporaryPhysicalBytes: 8388608,
          maximumMembers: this.maximumMembers,
          maximumAllocationBytes: this.owner.working.maximum,
          workingAllocation: this.owner.working,
          expiresAt: this.owner.expiresAt,
          signal: this.owner.signal
        })
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
        throw new Brc38StagingCleanupError(causes, 'Native structured workspace retains actual indexes', () =>
          this.close()
        )
      await this.#directory()
      await rmdir(this.directory)
      this.#sources.clear()
      this.retained.close()
    })()
    void this.#closing.catch(() => {
      this.#closing = undefined
    })
    return this.#closing
  }
}
