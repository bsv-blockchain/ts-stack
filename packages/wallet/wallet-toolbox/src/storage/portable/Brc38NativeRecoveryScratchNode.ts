import type { Knex } from 'knex'
import { readdir, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import {
  requirePrivatePath,
  requirePrivateDescriptor,
  createPrivateTemporaryDirectory,
  createPrivateFile
} from './Brc38PrivateFilesystemNode'
import { join, resolve } from 'node:path'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

interface Driver {
  copyOwnedNativeRecoveryDatabaseSnapshot(
    database: Knex,
    policy: Readonly<{
      directory: string
      maximumPhysicalBytes: number
      expiresAt: number
      monotonicDeadline: number
      signal?: AbortSignal
    }>
  ): Promise<Readonly<{ pages: number; bytes: number }>>
  copyOwnedNativeRecoverySnapshot(
    transaction: Knex.Transaction,
    policy: Readonly<{
      directory: string
      maximumPhysicalBytes: number
      expiresAt: number
      monotonicDeadline: number
      signal?: AbortSignal
    }>
  ): Promise<Readonly<{ pages: number; bytes: number }>>
  NativeRecoveryCopyCleanupError: new (...args: never[]) => AggregateError & { retryCleanup(): Promise<void> }
}
const actualScratch = new WeakSet<Brc38NativeRecoveryScratchNode>(),
  issuer = Object.freeze({})
let transport: Driver | undefined
function driver(): Driver {
  return (transport ??= require('./NativeProfileSqlite.cjs') as Driver)
}
function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Native recovery scratch resource bound differs')
}

/** Aggregate temporary extent reservation only, with no import, source or
 * profile authority. Share one instance across simultaneous recovery copies
 * and derived indexes; an independently reserved permanent target is separate.
 * This accounts file extent allowances, not filesystem blocks or process RSS. */
export class Brc38NativeRecoveryTemporaryQuota {
  #used = 0
  readonly #maximum: number
  constructor(maximum: number) {
    integer(maximum, 1048576, Number.MAX_SAFE_INTEGER)
    this.#maximum = maximum
  }
  get maximum(): number {
    return this.#maximum
  }
  get used(): number {
    return this.#used
  }
  claim(bytes: number): Readonly<{ close(): void }> {
    integer(bytes, 1, this.#maximum)
    if (bytes > this.#maximum - this.#used) throw new Error('Native recovery temporary capacity is already reserved')
    this.#used += bytes
    let closed = false
    return Object.freeze({
      close: (): void => {
        if (!closed) {
          this.#used -= bytes
          closed = true
        }
      }
    })
  }
}
export interface Brc38NativeRecoveryScratchPolicy {
  readonly privateParent: string
  readonly maximumPhysicalBytes: number
  readonly temporaryQuota: Brc38NativeRecoveryTemporaryQuota
  readonly workingAllocation: Brc38WorkingAllocation
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
type Identity = Readonly<{ device: bigint; inode: bigint }>

/** One actual new scratch lifetime. It copies the permanent target's coherent
 * SQLite view without opening, renewing or re-admitting the old reservation.
 * The native source owner must be unadmitted, actual Root3 and read-only.
 * Upper recovery factories still owe fresh complete archive authentication,
 * all local semantic reconstruction and independent target admission.
 * A scratch instance, copied image or matching path grants none of those. */
export class Brc38NativeRecoveryScratchNode {
  #live = true
  readonly #deadline: number
  readonly #fileIdentities: ReadonlyMap<string, Identity>
  private constructor(
    token: object,
    readonly directory: string,
    readonly policy: Readonly<Brc38NativeRecoveryScratchPolicy>,
    readonly copy: Readonly<{ pages: number; bytes: number }>,
    readonly identity: Identity,
    fileIdentities: ReadonlyMap<string, Identity>,
    monotonicDeadline: number
  ) {
    if (token !== issuer) throw new Error('Native recovery scratch requires its actual copy factory')
    this.#deadline = monotonicDeadline
    this.#fileIdentities = new Map(fileIdentities)
    actualScratch.add(this)
    Object.freeze(this)
  }
  assertRetained(): void {
    if (
      !actualScratch.has(this) ||
      !this.#live ||
      Date.now() >= this.policy.expiresAt ||
      performance.now() >= this.#deadline
    )
      throw new Error('Native recovery scratch lifetime is unavailable')
    this.policy.signal?.throwIfAborted()
  }
  get monotonicDeadline(): number {
    this.assertRetained()
    return this.#deadline
  }
  async assertPhysical(): Promise<void> {
    this.assertRetained()
    const current = await requirePrivatePath(this.directory, true)
    if (current.dev !== this.identity.device || current.ino !== this.identity.inode)
      throw new Error('Native recovery scratch physical owner changed')
    let bytes = 0n
    const names = await readdir(this.directory)
    if (
      names.length > 4 ||
      names.some(
        name =>
          !['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'].includes(name)
      )
    )
      throw new Error('Native recovery scratch contains an unowned file family')
    for (const name of names) {
      const value = await requirePrivatePath(join(this.directory, name), false)
      const expected = this.#fileIdentities.get(name)
      if (expected !== undefined && (value.dev !== expected.device || value.ino !== expected.inode))
        throw new Error('Native recovery scratch file identity differs')
      bytes += value.size
    }
    if (
      !names.includes('stage.sqlite') ||
      !names.includes('brc38-owner.sqlite') ||
      bytes > BigInt(this.policy.maximumPhysicalBytes)
    )
      throw new Error('Native recovery scratch extent exceeds its reservation')
    this.assertRetained()
  }
  static async withCopiedSnapshot<T>(
    transaction: Knex.Transaction,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline?: number
  ): Promise<T> {
    return await this.#withCopy(transaction, true, selected, work, maximumMonotonicDeadline)
  }
  /** Borrow and fully drain a new actual Root3 before the consumer uses scratch.
   * This keeps permanent target SQL readers out of later recovery writers. */
  static async withCopiedDatabase<T>(
    database: Knex,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline?: number
  ): Promise<T> {
    return await this.#withCopy(database, false, selected, work, maximumMonotonicDeadline)
  }
  static async #withCopy<T>(
    database: Knex,
    retainedRead: boolean,
    selected: Brc38NativeRecoveryScratchPolicy,
    work: (scratch: Brc38NativeRecoveryScratchNode) => Promise<T>,
    maximumMonotonicDeadline?: number
  ): Promise<T> {
    const policy = Object.freeze({
        privateParent: resolve(selected.privateParent),
        maximumPhysicalBytes: selected.maximumPhysicalBytes,
        temporaryQuota: selected.temporaryQuota,
        workingAllocation: selected.workingAllocation,
        expiresAt: selected.expiresAt,
        signal: selected.signal
      }),
      ownDeadline = performance.now() + Math.max(0, policy.expiresAt - Date.now()),
      deadline = maximumMonotonicDeadline === undefined ? ownDeadline : Math.min(ownDeadline, maximumMonotonicDeadline)
    integer(policy.maximumPhysicalBytes, 1048576, Number.MAX_SAFE_INTEGER)
    integer(policy.expiresAt, Date.now() + 1, Date.now() + 3600000)
    if (!Number.isFinite(deadline)) throw new RangeError('Native recovery scratch monotonic deadline differs')
    if (
      !(policy.temporaryQuota instanceof Brc38NativeRecoveryTemporaryQuota) ||
      !(policy.workingAllocation instanceof Brc38WorkingAllocation) ||
      typeof work !== 'function'
    )
      throw new Error('Native recovery scratch requires actual shared resource owners')
    const check = (): void => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
        throw new Error('Native recovery scratch copy lifetime expired')
    }
    check()
    const parent = await requirePrivatePath(policy.privateParent, true)
    const extent = Brc38NativeRecoveryTemporaryQuota.prototype.claim.call(
      policy.temporaryQuota,
      policy.maximumPhysicalBytes
    )
    let working: Brc38WorkingCharge | undefined,
      directory: string | undefined,
      identity: Identity | undefined,
      scratch: Brc38NativeRecoveryScratchNode | undefined,
      nativeFailure: unknown
    const files = new Map<string, Identity>(),
      descriptors = new Set<FileHandle>()
    const cleanup = async (): Promise<void> => {
      if (nativeFailure instanceof driver().NativeRecoveryCopyCleanupError) await nativeFailure.retryCleanup()
      for (const file of descriptors) {
        await file.close()
        descriptors.delete(file)
      }
      if (directory !== undefined && identity !== undefined) {
        const current = await requirePrivatePath(directory, true).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return undefined
          throw cause
        })
        if (current !== undefined) {
          if (!current.isDirectory() || current.dev !== identity.device || current.ino !== identity.inode)
            throw new Error('Recovery cleanup refuses a replaced scratch directory')
          for (const name of await readdir(directory)) {
            const expected = files.get(name),
              value = await requirePrivatePath(join(directory, name), false)
            if (
              (expected === undefined && !['stage.sqlite-journal', 'brc38-owner.sqlite-journal'].includes(name)) ||
              (expected !== undefined && (value.dev !== expected.device || value.ino !== expected.inode))
            )
              throw new Error('Recovery cleanup refuses an unowned or replaced scratch file')
            await unlink(join(directory, name))
          }
          await rmdir(directory)
        }
      }
      working?.close()
      extent.close()
    }
    try {
      working = Brc38WorkingAllocation.prototype.claim.call(policy.workingAllocation, 65536)
      check()
      directory = await createPrivateTemporaryDirectory(join(policy.privateParent, 'brc38-recovery-copy-'))
      const actual = await requirePrivatePath(directory, true)
      identity = Object.freeze({ device: actual.dev, inode: actual.ino })
      const retainedParent = await requirePrivatePath(policy.privateParent, true)
      if (retainedParent.dev !== parent.dev || retainedParent.ino !== parent.ino)
        throw new Error('Recovery scratch parent changed during directory creation')
      for (const name of ['stage.sqlite', 'brc38-owner.sqlite']) {
        const file = await createPrivateFile(join(directory, name), true)
        descriptors.add(file)
        const stat = await requirePrivateDescriptor(file)
        files.set(name, Object.freeze({ device: stat.dev, inode: stat.ino }))
        await file.sync()
        await file.close()
        descriptors.delete(file)
      }
      check()
      let copy: Readonly<{ pages: number; bytes: number }>
      const captured = Object.freeze({
        directory,
        maximumPhysicalBytes: policy.maximumPhysicalBytes,
        expiresAt: policy.expiresAt,
        monotonicDeadline: deadline,
        signal: policy.signal
      })
      try {
        copy = retainedRead
          ? await driver().copyOwnedNativeRecoverySnapshot(database as Knex.Transaction, captured)
          : await driver().copyOwnedNativeRecoveryDatabaseSnapshot(database, captured)
      } catch (cause) {
        nativeFailure = cause
        throw cause
      }
      check()
      scratch = new Brc38NativeRecoveryScratchNode(issuer, directory, policy, copy, identity, new Map(files), deadline)
      await scratch.assertPhysical()
      const value = await work(scratch)
      await scratch.assertPhysical()
      check()
      scratch.#live = false
      await cleanup()
      return value
    } catch (cause) {
      if (scratch !== undefined) scratch.#live = false
      const cleanupOriginal = async (): Promise<void> => {
        if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
        await cleanup()
      }
      try {
        await cleanupOriginal()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Native recovery scratch retains cleanup and capacity',
          cleanupOriginal
        )
      }
      throw cause
    }
  }
}
