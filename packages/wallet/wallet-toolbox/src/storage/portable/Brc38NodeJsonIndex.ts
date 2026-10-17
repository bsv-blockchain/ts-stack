import {
  requirePrivatePath,
  requirePrivateDescriptor,
  createPrivateTemporaryDirectory,
  createPrivateFile
} from './Brc38PrivateFilesystemNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { realpath, rmdir, unlink, statfs, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import type { Brc38JsonMember, Brc38JsonMemberIndex } from './Brc38StructuredJson'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38NodeJsonIndexPolicy {
  /** Existing private, owned, non-symlink directory. Every index creates a new child. */
  privateParent: string
  sourceBytes: number
  maximumTemporaryFileBytes: number
  /** Explicit physical reservation, including allocated blocks, rounded logical
   * extents and conservative directory/inode headroom. Legacy length-only
   * callers remain unchanged. Actual filesystem qualification is separate. */
  maximumTemporaryPhysicalBytes?: number
  maximumMembers: number
  /** Optional original working allocation. Charges reachable record metadata,
   * decoded UTF-16 keys, sort references and explicit I/O buffers before their
   * allocation. This is not a JavaScript VM or filesystem physical-memory cap.
   * Omitting it retains the original 256 KiB sort-window behavior. */
  maximumAllocationBytes?: number
  /** Retained observed high-water reservation in the shared original allowance until physical close. */
  workingAllocation?: Brc38WorkingAllocation
  /** Original source expiry; neither seal nor a merge pass renews it. */
  expiresAt: number
  signal?: AbortSignal
}
type State = 'writing' | 'sealing' | 'sealed' | 'failed' | 'closing' | 'closed'
interface Identity {
  dev: bigint
  ino: bigint
}
interface OwnedFile extends Identity {
  handle: FileHandle
  name: string
  id: number
  generation: number
  size: number
  closed: boolean
  removed: boolean
}
interface RecordValue extends Brc38JsonMember {
  object: number
  sequence: number
  firstKeyOffset: number
}
interface Run {
  remaining: number
  position: number
  end: number
}
const RUN_HEADER = 48,
  OBJECT_ENTRY = 80,
  KEY_ENTRY = 64,
  RECORD_FIXED = 88,
  WINDOW_CHARGE = 262144
const KEY_UNITS = 8192,
  FILE_LIMIT = 17179869184,
  MEMBER_LIMIT = 2000000000
const issuer = Object.freeze({})
function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid native structured index ${name}`)
  return value
}
function same(first: Identity, second: Identity): boolean {
  return first.dev === second.dev && first.ino === second.ino
}
function compare(first: RecordValue, second: RecordValue): number {
  if (first.object !== second.object) return first.object < second.object ? -1 : 1
  if (first.key !== second.key) return first.key < second.key ? -1 : 1
  return second.sequence - first.sequence
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Fresh, private Node external merge index. It owns no native process,
 * SQL connection, source admission or persistent profile catalogue. Temporary
 * byte accounting covers the actual four file lengths. The explicit physical
 * policy additionally checks allocated blocks, rounded extents, namespace
 * headroom and current filesystem availability. Integrity tags bind derived records to this instance, file,
 * truncation generation and byte position; they never authorize source reads. */
export class Brc38NodeJsonIndex implements Brc38JsonMemberIndex {
  #state: State = 'writing'
  #busy = false
  #active: Promise<void> = Promise.resolve()
  #closing?: Promise<void>
  #key = randomBytes(32)
  #members = 0
  #objects = 0
  #keys = 0
  #data?: OwnedFile
  #started = performance.now()
  #remainingLifetime: number
  #reservationBytes = 4096

  private constructor(
    token: object,
    private readonly policy: Readonly<Brc38NodeJsonIndexPolicy>,
    private readonly directory: string,
    private readonly directoryIdentity: Identity,
    private readonly files: OwnedFile[],
    private readonly parentIdentity: Identity,
    private readonly allocationUnit: number,
    private readonly workingBase: number,
    private readonly reservation?: Brc38WorkingCharge
  ) {
    if (token !== issuer) throw new Error('Native structured index must be created by its fresh private factory')
    this.#remainingLifetime = policy.expiresAt - Date.now()
    this.#reservationBytes = workingBase
  }

  static async open(selected: Brc38NodeJsonIndexPolicy): Promise<Brc38NodeJsonIndex> {
    // Copy all policy data before the first filesystem await.
    const policy = Object.freeze({
      privateParent: selected.privateParent,
      sourceBytes: integer(selected.sourceBytes, 1, 1000000000, 'source byte length'),
      maximumTemporaryFileBytes: integer(selected.maximumTemporaryFileBytes, 1048576, FILE_LIMIT, 'temporary bytes'),
      maximumTemporaryPhysicalBytes:
        selected.maximumTemporaryPhysicalBytes === undefined
          ? undefined
          : integer(selected.maximumTemporaryPhysicalBytes, 1048576, FILE_LIMIT, 'physical temporary bytes'),
      maximumMembers: integer(selected.maximumMembers, 1, MEMBER_LIMIT, 'member count'),
      maximumAllocationBytes:
        selected.maximumAllocationBytes === undefined
          ? undefined
          : integer(selected.maximumAllocationBytes, 4096, 16777216, 'working allocation bytes'),
      workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
      expiresAt: integer(selected.expiresAt, 1, Number.MAX_SAFE_INTEGER, 'expiry'),
      signal: selected.signal
    })
    const workingBase = 4096 + 16 * Buffer.byteLength(policy.privateParent)
    if (policy.maximumAllocationBytes !== undefined && workingBase > policy.maximumAllocationBytes)
      throw new SnapshotResourceLimitError('Native index private paths exceed its original working allocation')
    const reservation = policy.workingAllocation?.claim(workingBase)
    try {
      return await Brc38NodeJsonIndex.acquire(policy, workingBase, reservation)
    } catch (error) {
      if (error instanceof Brc38StagingCleanupError)
        throw new Brc38StagingCleanupError(
          [error],
          'Native index retains its original working reservation with acquisition cleanup',
          async () => {
            await error.retryCleanup()
            reservation?.close()
          }
        )
      reservation?.close()
      throw error
    }
  }
  private static async acquire(
    policy: Readonly<Brc38NodeJsonIndexPolicy>,
    workingBase: number,
    reservation?: Brc38WorkingCharge
  ): Promise<Brc38NodeJsonIndex> {
    const began = performance.now(),
      lifetime = policy.expiresAt - Date.now()
    policy.signal?.throwIfAborted()
    if (lifetime < 1 || lifetime > 3600000)
      throw new SnapshotResourceLimitError('Native structured index source is expired')
    if (
      typeof policy.privateParent !== 'string' ||
      !isAbsolute(policy.privateParent) ||
      resolve(policy.privateParent) !== policy.privateParent
    )
      throw new TypeError('Native structured index requires an absolute normalized private parent')
    const parent = await requirePrivatePath(policy.privateParent, true)
    if ((await realpath(policy.privateParent)) !== policy.privateParent)
      throw new Error('Native structured index parent is not a private owned directory')
    const filesystem =
        policy.maximumTemporaryPhysicalBytes === undefined ? undefined : await statfs(policy.privateParent),
      allocationUnit =
        filesystem === undefined ? 4096 : integer(filesystem.bsize, 512, 1048576, 'filesystem allocation unit')
    if (policy.maximumTemporaryPhysicalBytes !== undefined) {
      const available =
          integer(filesystem!.bavail, 0, Number.MAX_SAFE_INTEGER, 'filesystem available blocks') * allocationUnit,
        acquisition = 12 * Math.max(4096, allocationUnit)
      if (
        !Number.isSafeInteger(available) ||
        acquisition > policy.maximumTemporaryPhysicalBytes ||
        acquisition > available
      )
        throw new SnapshotResourceLimitError('Native structured index cannot admit its physical acquisition')
    }
    policy.signal?.throwIfAborted()
    if (Date.now() >= policy.expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Native structured index source expired during acquisition')
    const directory = await createPrivateTemporaryDirectory(join(policy.privateParent, 'brc38-json-'))
    const files: OwnedFile[] = []
    let owner: Brc38NodeJsonIndex | undefined
    let originalDirectory: Identity | undefined
    const cleanUnopenedDirectory = async (): Promise<void> => {
      if (originalDirectory === undefined)
        throw new Error('Unidentified native index directory requires explicit recovery')
      const stat = await requirePrivatePath(directory, true)
      if (!same(stat, originalDirectory) || (await realpath(directory)) !== directory)
        throw new Error('Native index acquisition cleanup refuses a substituted directory')
      await rmdir(directory)
    }
    try {
      const identity = await requirePrivatePath(directory, true)
      originalDirectory = identity
      if ((await realpath(directory)) !== directory)
        throw new Error('Native structured index directory changed during acquisition')
      owner = new Brc38NodeJsonIndex(
        issuer,
        policy,
        directory,
        identity,
        files,
        parent,
        allocationUnit,
        workingBase,
        reservation
      )
      // Include acquisition in the original monotonic lifetime.
      owner.#started = began
      owner.#remainingLifetime = lifetime
      for (const [id, leaf] of ['input', 'runs-a', 'runs-b', 'keys'].entries()) {
        owner.check()
        const name = join(directory, leaf)
        const handle = await createPrivateFile(name, true)
        // Register the real descriptor before any fallible follow-up check.
        const file: OwnedFile = {
          handle,
          name,
          id,
          dev: -1n,
          ino: -1n,
          generation: 0,
          size: 0,
          closed: false,
          removed: false
        }
        files.push(file)
        const stat = await requirePrivateDescriptor(handle)
        file.dev = stat.dev
        file.ino = stat.ino
        await owner.current()
      }
      return owner
    } catch (error) {
      const cleanupOriginal = async (): Promise<void> => {
        if (error instanceof Brc38StagingCleanupError) await error.retryCleanup()
        if (owner !== undefined) await owner.close()
        else await cleanUnopenedDirectory()
      }
      try {
        await cleanupOriginal()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [error, error_],
          'Native structured index acquisition retains physical cleanup',
          cleanupOriginal
        )
      }
      throw error
    }
  }

  private check(): void {
    this.policy.signal?.throwIfAborted()
    if (this.#state === 'closing' || this.#state === 'closed' || this.#state === 'failed')
      throw new Error('Native structured index is revoked')
    if (Date.now() >= this.policy.expiresAt || performance.now() - this.#started >= this.#remainingLifetime)
      throw new SnapshotResourceLimitError('Native structured index source expired')
  }
  private async directoryCurrent(): Promise<void> {
    const parent = await requirePrivatePath(this.policy.privateParent, true)
    if (!same(parent, this.parentIdentity) || (await realpath(this.policy.privateParent)) !== this.policy.privateParent)
      throw new Error('Native structured index parent identity changed')
    const stat = await requirePrivatePath(this.directory, true)
    if (!same(stat, this.directoryIdentity) || (await realpath(this.directory)) !== this.directory)
      throw new Error('Native structured index directory identity changed')
  }
  private async fileCurrent(file: OwnedFile, requireSize: boolean): Promise<void> {
    if (file.closed || file.removed) throw new Error('Native structured index descriptor is closed')
    const descriptor = await requirePrivateDescriptor(file.handle),
      path = await requirePrivatePath(file.name, false)
    if (!same(descriptor, file) || !same(path, file) || (requireSize && descriptor.size !== BigInt(file.size)))
      throw new Error('Native structured index file identity or length changed')
  }
  private async current(): Promise<void> {
    this.check()
    await this.directoryCurrent()
    let total = 0
    for (const file of this.files) {
      await this.fileCurrent(file, true)
      total += file.size
    }
    if (!Number.isSafeInteger(total) || total > this.policy.maximumTemporaryFileBytes)
      throw new SnapshotResourceLimitError('Native structured index exceeds its actual temporary-file policy')
    if (this.policy.maximumTemporaryPhysicalBytes !== undefined) await this.physicalCurrent()
    this.check()
  }
  private async physicalCurrent(growth = 0): Promise<void> {
    const maximum = this.policy.maximumTemporaryPhysicalBytes
    if (maximum === undefined) return
    await this.directoryCurrent()
    const directory = await requirePrivatePath(this.directory, true),
      filesystem = await statfs(this.directory)
    if (filesystem.bsize !== this.allocationUnit) throw new Error('Native structured index filesystem changed')
    const allocated = (size: bigint, blocks: bigint): number => {
      if (size < 0n || size > BigInt(FILE_LIMIT) || blocks < 0n || blocks > BigInt(Number.MAX_SAFE_INTEGER) / 512n)
        throw new SnapshotResourceLimitError('Native structured index physical extent differs')
      const value = Math.max(Math.ceil(Number(size) / this.allocationUnit) * this.allocationUnit, Number(blocks * 512n))
      if (!Number.isSafeInteger(value))
        throw new SnapshotResourceLimitError('Native structured index physical extent overflows')
      return value
    }
    // Charge bounded namespace/inode headroom independently of file lengths.
    // Physical and rounded logical extents both count, including delayed writes.
    let physical = allocated(directory.size, directory.blocks) + 12 * Math.max(4096, this.allocationUnit)
    for (const file of this.files) {
      await this.fileCurrent(file, true)
      const actual = await requirePrivateDescriptor(file.handle)
      physical += allocated(actual.size, actual.blocks)
    }
    const reservedGrowth =
        growth === 0 ? 0 : Math.ceil(growth / this.allocationUnit) * this.allocationUnit + 2 * this.allocationUnit,
      available =
        integer(filesystem.bavail, 0, Number.MAX_SAFE_INTEGER, 'filesystem available blocks') * this.allocationUnit
    if (
      !Number.isSafeInteger(physical) ||
      !Number.isSafeInteger(available) ||
      physical > maximum ||
      reservedGrowth > maximum - physical ||
      reservedGrowth > available
    )
      throw new SnapshotResourceLimitError('Native structured index exceeds its current physical reservation')
    await this.directoryCurrent()
    this.check()
  }
  private own<T>(action: () => Promise<T>): Promise<T> {
    if (this.#busy) return Promise.reject(new Error('Native structured index already owns an operation'))
    try {
      this.check()
    } catch (error) {
      return Promise.reject(error)
    }
    this.#busy = true
    const result = Promise.resolve()
      .then(() => {
        // Close may revoke admission before this queued action starts.
        this.check()
        return action()
      })
      .catch(error => {
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed'
        throw error
      })
      .finally(() => {
        this.#busy = false
      })
    this.#active = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private allocation(resident: number, scratch: number): void {
    const maximum = this.policy.maximumAllocationBytes ?? this.policy.workingAllocation?.maximum
    if (maximum === undefined) return
    if (
      !Number.isSafeInteger(resident) ||
      resident < 0 ||
      !Number.isSafeInteger(scratch) ||
      scratch < 0 ||
      resident > maximum - this.workingBase ||
      scratch > maximum - this.workingBase - resident
    )
      throw new SnapshotResourceLimitError('Native structured index exceeds its original working allocation')
    // Retain the observed high-water reservation even while idle. Records may
    // still be reachable through a suspended entries iterator or merge scope.
    const required = this.workingBase + resident + scratch
    if (required > this.#reservationBytes) {
      this.reservation?.resize(required)
      this.#reservationBytes = required
    }
  }
  private recordCharge(units: number): number {
    return 512 + units * 4
  }
  private recordsCharge(...records: (RecordValue | undefined)[]): number {
    let total = 0
    // A selected record often also is the previous output record. Count actual
    // reachable records once; this does not cache any source or schema verdict.
    for (const record of new Set(records)) if (record !== undefined) total += this.recordCharge(record.key.length)
    return total
  }
  private async recordSize(file: OwnedFile, position: number): Promise<number> {
    const prefix = await this.read(file, position, 4)
    try {
      return integer(prefix.readUInt32LE(0), RECORD_FIXED, RECORD_FIXED + KEY_UNITS * 2, 'record length')
    } finally {
      prefix.fill(0)
    }
  }
  private tag(kind: string, file: OwnedFile, position: number, body: Uint8Array): Buffer {
    const context = Buffer.alloc(24)
    context.writeBigUInt64LE(BigInt(file.id), 0)
    context.writeBigUInt64LE(BigInt(file.generation), 8)
    context.writeBigUInt64LE(BigInt(position), 16)
    return createHmac('sha256', this.#key).update(kind).update(context).update(body).digest()
  }
  private async read(file: OwnedFile, position: number, length: number): Promise<Buffer> {
    integer(position, 0, file.size, 'read position')
    integer(length, 1, 65536, 'read length')
    if (length > file.size - position) throw new Error('Native structured index read is truncated')
    await this.current()
    const bytes = Buffer.alloc(length)
    for (let offset = 0; offset < length;) {
      this.check()
      const { bytesRead } = await file.handle.read(bytes, offset, length - offset, position + offset)
      integer(bytesRead, 1, length - offset, 'read progress')
      offset += bytesRead
    }
    await this.current()
    return bytes
  }
  private async write(file: OwnedFile, position: number, bytes: Buffer): Promise<void> {
    integer(position, 0, file.size, 'write position')
    integer(bytes.length, 1, 65536, 'write length')
    await this.current()
    const growth = Math.max(0, position + bytes.length - file.size)
    const total = this.files.reduce((sum, owned) => sum + owned.size, 0)
    if (growth > this.policy.maximumTemporaryFileBytes - total)
      throw new SnapshotResourceLimitError('Native structured index would exceed its temporary-file budget')
    await this.physicalCurrent(growth)
    for (let offset = 0; offset < bytes.length;) {
      this.check()
      const { bytesWritten } = await file.handle.write(bytes, offset, bytes.length - offset, position + offset)
      integer(bytesWritten, 1, bytes.length - offset, 'write progress')
      offset += bytesWritten
      file.size = Math.max(file.size, position + offset)
    }
    await this.current()
  }
  private async truncate(file: OwnedFile): Promise<void> {
    await this.current()
    await file.handle.truncate(0)
    file.size = 0
    file.generation++
    await this.current()
  }
  private record(source: RecordValue): RecordValue {
    if (typeof source.key !== 'string' || source.key.length > KEY_UNITS)
      throw new TypeError('Invalid native structured index key')
    const object = integer(source.object, 0, this.policy.sourceBytes - 1, 'object offset'),
      keyOffset = integer(source.keyOffset, object + 1, this.policy.sourceBytes - 1, 'key offset'),
      start = integer(source.start, keyOffset + 1, this.policy.sourceBytes - 1, 'value start'),
      end = integer(source.end, start + 1, this.policy.sourceBytes, 'value end'),
      sequence = integer(source.sequence, 1, this.policy.maximumMembers, 'member sequence'),
      firstKeyOffset = integer(source.firstKeyOffset, object + 1, keyOffset, 'first key insertion offset')
    return { object, key: source.key, keyOffset, start, end, sequence, firstKeyOffset }
  }
  private async append(file: OwnedFile, value: RecordValue, resident = this.recordsCharge(value)): Promise<void> {
    const record = this.record(value),
      size = RECORD_FIXED + record.key.length * 2
    this.allocation(resident, size + 512)
    // One owned serialization buffer, with a view for HMAC input. Preserve the
    // existing record bytes while avoiding body + tag + concatenation copies.
    const bytes = Buffer.alloc(size),
      body = bytes.subarray(0, size - 32)
    try {
      body.writeUInt32LE(size, 0)
      for (const [index, number] of [
        record.object,
        record.keyOffset,
        record.start,
        record.end,
        record.sequence,
        record.firstKeyOffset
      ].entries())
        body.writeBigUInt64LE(BigInt(number), 4 + index * 8)
      body.writeUInt32LE(record.key.length, 52)
      for (let index = 0; index < record.key.length; index++)
        body.writeUInt16BE(record.key.charCodeAt(index), 56 + index * 2)
      const position = file.size,
        tag = this.tag('member/v2', file, position, body)
      try {
        bytes.set(tag, size - 32)
      } finally {
        tag.fill(0)
      }
      await this.write(file, position, bytes)
    } finally {
      bytes.fill(0)
    }
  }
  private async nextRecord(
    file: OwnedFile,
    position: number,
    resident = 0
  ): Promise<{ value: RecordValue; end: number }> {
    const size = await this.recordSize(file, position),
      units = (size - RECORD_FIXED) / 2
    integer(units, 0, KEY_UNITS, 'record key units')
    this.allocation(resident + this.recordCharge(units), size + 512)
    const bytes = await this.read(file, position, size),
      body = bytes.subarray(0, size - 32)
    try {
      const tag = this.tag('member/v2', file, position, body)
      try {
        if (body.readUInt32LE(0) !== size || !timingSafeEqual(bytes.subarray(size - 32), tag))
          throw new Error('Native structured index record integrity changed')
      } finally {
        tag.fill(0)
      }
      if (body.readUInt32LE(52) !== units) throw new Error('Invalid native structured index record size')
      const numbers = [0, 1, 2, 3, 4, 5].map(index => Number(body.readBigUInt64LE(4 + index * 8)))
      // Verify the original bytes first, then decode the owned UTF-16 region in
      // place. Node's UTF-16 decoder preserves code units, including unpaired
      // surrogates; the later portable-value validator retains its own checks.
      const keyBytes = body.subarray(56)
      keyBytes.swap16()
      const key = keyBytes.toString('utf16le')
      return {
        value: this.record({
          object: numbers[0],
          keyOffset: numbers[1],
          start: numbers[2],
          end: numbers[3],
          sequence: numbers[4],
          firstKeyOffset: numbers[5],
          key
        }),
        end: position + size
      }
    } finally {
      bytes.fill(0)
    }
  }
  put(objectOffset: number, member: Brc38JsonMember): Promise<void> {
    if (this.#state !== 'writing') return Promise.reject(new Error('Native structured index is not writable'))
    if (this.#members >= this.policy.maximumMembers)
      return Promise.reject(
        new SnapshotResourceLimitError('Native structured index exceeds its selected member policy')
      )
    // Primitive copies before admission; no input object is retained across I/O.
    let value: RecordValue
    try {
      value = this.record({
        object: objectOffset,
        key: member.key,
        keyOffset: member.keyOffset,
        start: member.start,
        end: member.end,
        sequence: this.#members + 1,
        firstKeyOffset: member.keyOffset
      })
    } catch (error) {
      return Promise.reject(error)
    }
    try {
      this.allocation(this.recordsCharge(value), RECORD_FIXED + value.key.length * 2 + 512)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.own(async () => {
      await this.append(this.files[0], value)
      this.#members++
    })
  }
  private async header(file: OwnedFile, position: number, count: number, bytes: number): Promise<void> {
    const body = Buffer.alloc(16)
    body.writeBigUInt64LE(BigInt(count), 0)
    body.writeBigUInt64LE(BigInt(bytes), 8)
    await this.write(file, position, Buffer.concat([body, this.tag('run/v1', file, position, body)]))
  }
  private async run(file: OwnedFile, position: number): Promise<Run> {
    const bytes = await this.read(file, position, RUN_HEADER),
      body = bytes.subarray(0, 16)
    if (!timingSafeEqual(bytes.subarray(16), this.tag('run/v1', file, position, body)))
      throw new Error('Native structured index run integrity changed')
    const count = integer(Number(body.readBigUInt64LE(0)), 1, this.#members, 'run count'),
      length = integer(Number(body.readBigUInt64LE(8)), RECORD_FIXED, file.size - position - RUN_HEADER, 'run bytes')
    return { remaining: count, position: position + RUN_HEADER, end: position + RUN_HEADER + length }
  }
  private async take(file: OwnedFile, run: Run, resident = 0): Promise<RecordValue | undefined> {
    if (run.remaining === 0) {
      if (run.position !== run.end) throw new Error('Native structured index run count changed')
      return undefined
    }
    const record = await this.nextRecord(file, run.position, resident)
    if (record.end > run.end) throw new Error('Native structured index record crosses its run')
    run.position = record.end
    run.remaining--
    if (run.remaining === 0 && run.position !== run.end) throw new Error('Native structured index run is truncated')
    return record.value
  }
  private async initialRuns(input: OwnedFile, output: OwnedFile): Promise<number> {
    let position = 0,
      runs = 0,
      seen = 0
    while (position < input.size) {
      const window: RecordValue[] = []
      let charge = 0
      while (position < input.size) {
        const size = await this.recordSize(input, position),
          units = (size - RECORD_FIXED) / 2,
          amount = this.recordCharge(integer(units, 0, KEY_UNITS, 'sort key units')),
          windowLimit =
            (this.policy.maximumAllocationBytes ?? this.policy.workingAllocation?.maximum) === undefined
              ? WINDOW_CHARGE
              : Math.min(
                  WINDOW_CHARGE,
                  Math.floor(
                    ((this.policy.maximumAllocationBytes ?? this.policy.workingAllocation!.maximum) -
                      this.workingBase) /
                      2
                  )
                )
        // Read only the fixed prefix before deciding whether another decoded
        // key can join this window. A full next record is never speculative.
        if (window.length > 0 && amount > windowLimit - charge) break
        const record = await this.nextRecord(input, position, charge)
        if (record.value.sequence !== seen + 1) throw new Error('Native structured index input sequence changed')
        position = record.end
        seen++
        window.push(record.value)
        charge += amount
      }
      window.sort(compare)
      const start = output.size
      await this.header(output, start, window.length, 0)
      for (const value of window) await this.append(output, value, charge)
      await this.header(output, start, window.length, output.size - start - RUN_HEADER)
      window.length = 0
      runs++
    }
    if (seen !== this.#members) throw new Error('Native structured index input member count changed')
    return runs
  }
  private async merge(input: OwnedFile, output: OwnedFile): Promise<number> {
    let position = 0,
      runs = 0,
      seen = 0
    while (position < input.size) {
      const first = await this.run(input, position)
      position = first.end
      const second = position < input.size ? await this.run(input, position) : undefined
      if (second !== undefined) position = second.end
      const count = first.remaining + (second?.remaining ?? 0),
        start = output.size
      await this.header(output, start, count, 0)
      let left = await this.take(input, first),
        right = second === undefined ? undefined : await this.take(input, second, this.recordsCharge(left)),
        previous: RecordValue | undefined
      while (left !== undefined || right !== undefined) {
        const takeLeft = right === undefined || (left !== undefined && compare(left, right) < 0),
          value = takeLeft ? left! : right!
        if (previous !== undefined && compare(previous, value) >= 0)
          throw new Error('Native structured index sort order or sequence changed')
        await this.append(output, value, this.recordsCharge(left, right, previous))
        previous = value
        seen++
        if (takeLeft) left = await this.take(input, first, this.recordsCharge(left, right, previous))
        else right = await this.take(input, second!, this.recordsCharge(left, right, previous))
      }
      await this.header(output, start, count, output.size - start - RUN_HEADER)
      runs++
    }
    if (seen !== this.#members) throw new Error('Native structured index merge member count changed')
    return runs
  }
  private async objectEntry(
    file: OwnedFile,
    object: number,
    start: number,
    end: number,
    keyStart: number,
    keyCount: number
  ): Promise<void> {
    const body = Buffer.alloc(48),
      position = file.size
    for (const [index, value] of [this.#objects, object, start, end, keyStart, keyCount].entries())
      body.writeBigUInt64LE(BigInt(value), index * 8)
    await this.write(file, position, Buffer.concat([body, this.tag('object/v2', file, position, body)]))
    this.#objects++
  }
  private async keyEntry(object: number, start: number, end: number): Promise<void> {
    const file = this.files[3],
      body = Buffer.alloc(32),
      position = file.size
    for (const [index, value] of [this.#keys, object, start, end].entries())
      body.writeBigUInt64LE(BigInt(value), index * 8)
    await this.write(file, position, Buffer.concat([body, this.tag('key/v1', file, position, body)]))
    this.#keys++
  }
  private async compact(input: OwnedFile, data: OwnedFile, objects: OwnedFile): Promise<void> {
    const run = await this.run(input, 0)
    if (run.end !== input.size || run.remaining !== this.#members)
      throw new Error('Native structured index final run changed')
    let previous: RecordValue | undefined,
      pending: RecordValue | undefined,
      object: number | undefined,
      start = 0,
      keyStart = 0
    const flush = async (current?: RecordValue): Promise<void> => {
      if (pending === undefined) return
      if (object !== pending.object) {
        if (object !== undefined)
          await this.objectEntry(objects, object, start, data.size, keyStart, this.#keys - keyStart)
        object = pending.object
        start = data.size
        keyStart = this.#keys
      }
      const at = data.size
      await this.append(data, pending, this.recordsCharge(pending, previous, current))
      await this.keyEntry(pending.object, at, data.size)
    }
    for (
      let value = await this.take(input, run);
      value !== undefined;
      value = await this.take(input, run, this.recordsCharge(pending, previous))
    ) {
      if (previous !== undefined && compare(previous, value) >= 0)
        throw new Error('Native structured index final order changed')
      const duplicate = pending !== undefined && pending.object === value.object && pending.key === value.key
      previous = value
      if (duplicate) pending = { ...pending!, firstKeyOffset: Math.min(pending!.firstKeyOffset, value.firstKeyOffset) }
      else {
        await flush(value)
        pending = value
      }
    }
    await flush()
    if (object !== undefined) await this.objectEntry(objects, object, start, data.size, keyStart, this.#keys - keyStart)
  }
  seal(): Promise<void> {
    if (this.#state !== 'writing') return Promise.reject(new Error('Native structured index cannot be sealed twice'))
    return this.own(async () => {
      this.#state = 'sealing'
      const [input, first, second] = this.files
      if (this.#members === 0) {
        await this.current()
        this.#data = first
        this.#state = 'sealed'
        return
      }
      let runs = await this.initialRuns(input, first)
      await this.truncate(input)
      let from = first,
        to = second
      while (runs > 1) {
        runs = await this.merge(from, to)
        await this.truncate(from)
        const old = from
        from = to
        to = old
      }
      await this.compact(from, to, input)
      await this.truncate(from)
      await this.current()
      this.#data = to
      this.#state = 'sealed'
    })
  }
  private async locate(
    object: number
  ): Promise<{ start: number; end: number; keyStart: number; keyCount: number } | undefined> {
    let low = 0,
      high = this.#objects
    const file = this.files[0],
      data = this.#data!
    if (file.size !== this.#objects * OBJECT_ENTRY) throw new Error('Native structured index object count changed')
    while (low < high) {
      const middle = Math.floor((low + high) / 2),
        position = middle * OBJECT_ENTRY,
        bytes = await this.read(file, position, OBJECT_ENTRY),
        body = bytes.subarray(0, 48)
      if (
        !timingSafeEqual(bytes.subarray(48), this.tag('object/v2', file, position, body)) ||
        Number(body.readBigUInt64LE(0)) !== middle
      )
        throw new Error('Native structured index object integrity changed')
      const id = integer(Number(body.readBigUInt64LE(8)), 0, this.policy.sourceBytes - 1, 'indexed object'),
        start = integer(Number(body.readBigUInt64LE(16)), 0, data.size - 1, 'indexed start'),
        end = integer(Number(body.readBigUInt64LE(24)), start + RECORD_FIXED, data.size, 'indexed end'),
        keyStart = integer(Number(body.readBigUInt64LE(32)), 0, this.#keys - 1, 'indexed key start'),
        keyCount = integer(Number(body.readBigUInt64LE(40)), 1, this.#keys - keyStart, 'indexed key count')
      if (id === object) return { start, end, keyStart, keyCount }
      if (id < object) low = middle + 1
      else high = middle
    }
    return undefined
  }
  private async indexedRecord(
    objectOffset: number,
    range: Readonly<{ start: number; end: number }>,
    ordinal: number,
    resident: number
  ): Promise<RecordValue> {
    const file = this.files[3]
    if (file.size !== this.#keys * KEY_ENTRY) throw new Error('Native structured key count changed')
    const position = ordinal * KEY_ENTRY,
      bytes = await this.read(file, position, KEY_ENTRY),
      body = bytes.subarray(0, 32)
    if (
      !timingSafeEqual(bytes.subarray(32), this.tag('key/v1', file, position, body)) ||
      Number(body.readBigUInt64LE(0)) !== ordinal ||
      Number(body.readBigUInt64LE(8)) !== objectOffset
    )
      throw new Error('Native structured key integrity changed')
    const start = integer(Number(body.readBigUInt64LE(16)), range.start, range.end - RECORD_FIXED, 'key record start'),
      end = integer(Number(body.readBigUInt64LE(24)), start + RECORD_FIXED, range.end, 'key record end'),
      record = await this.nextRecord(this.#data!, start, resident)
    if (record.end !== end || record.value.object !== objectOffset)
      throw new Error('Native structured key record differs')
    return record.value
  }
  /** Indexed original property insertion position plus the selected last
   * value. This is derived span DATA, not source/schema admission. The existing
   * entries() shape and raw UTF16 ordering remain unchanged. */
  async lookup(
    objectOffset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined> {
    integer(objectOffset, 0, this.policy.sourceBytes - 1, 'selected object')
    if (typeof key !== 'string' || key.length > KEY_UNITS || this.#state !== 'sealed')
      throw new Error('Native structured index lookup is unavailable')
    return await this.own(async () => {
      await this.current()
      const range = await this.locate(objectOffset)
      if (range === undefined) return undefined
      let low = range.keyStart,
        high = low + range.keyCount
      while (low < high) {
        const ordinal = Math.floor((low + high) / 2),
          record = await this.indexedRecord(objectOffset, range, ordinal, this.recordCharge(key.length))
        if (record.key === key) {
          const { keyOffset, firstKeyOffset, start, end } = record
          await this.current()
          return Object.freeze({ key, keyOffset, firstKeyOffset, start, end })
        }
        if (record.key < key) low = ordinal + 1
        else high = ordinal
      }
      await this.current()
      return undefined
    })
  }
  /** One authenticated member strictly after the caller's key. Binary search
   * uses the sealed ordinal index; no file iterator survives the owned read. */
  async nextEntry(objectOffset: number, after?: string): Promise<Brc38JsonMember | undefined> {
    integer(objectOffset, 0, this.policy.sourceBytes - 1, 'selected object')
    if ((after !== undefined && (typeof after !== 'string' || after.length > KEY_UNITS)) || this.#state !== 'sealed')
      throw new Error('Native structured index lookup is unavailable')
    return await this.own(async () => {
      await this.current()
      const range = await this.locate(objectOffset)
      if (range === undefined) {
        await this.current()
        return undefined
      }
      let low = range.keyStart,
        high = low + range.keyCount
      const resident = after === undefined ? 0 : this.recordCharge(after.length)
      if (after !== undefined)
        while (low < high) {
          const ordinal = Math.floor((low + high) / 2),
            record = await this.indexedRecord(objectOffset, range, ordinal, resident)
          if (record.key <= after) low = ordinal + 1
          else high = ordinal
        }
      if (low === range.keyStart + range.keyCount) {
        await this.current()
        return undefined
      }
      const { key, keyOffset, start, end } = await this.indexedRecord(objectOffset, range, low, resident)
      if (after !== undefined && key <= after) throw new Error('Native structured index object order changed')
      await this.current()
      return Object.freeze({ key, keyOffset, start, end })
    })
  }
  async *entries(objectOffset: number): AsyncGenerator<Brc38JsonMember> {
    integer(objectOffset, 0, this.policy.sourceBytes - 1, 'selected object')
    if (this.#state !== 'sealed') throw new Error('Native structured index is not sealed')
    const range = await this.own(async () => {
      await this.current()
      return this.locate(objectOffset)
    })
    if (range === undefined) return
    let position = range.start,
      previous: string | undefined
    while (position < range.end) {
      const record = await this.own(async () => {
        if (this.#state !== 'sealed') throw new Error('Native structured index is revoked')
        return this.nextRecord(this.#data!, position, previous === undefined ? 0 : this.recordCharge(previous.length))
      })
      if (
        record.end > range.end ||
        record.value.object !== objectOffset ||
        (previous !== undefined && record.value.key <= previous)
      )
        throw new Error('Native structured index object order changed')
      position = record.end
      previous = record.value.key
      const { key, keyOffset, start, end } = record.value
      yield { key, keyOffset, start, end }
    }
    if (position !== range.end) throw new Error('Native structured index object extent changed')
  }
  close(): Promise<void> {
    if (this.#state === 'closed') return Promise.resolve()
    if (this.#closing !== undefined) return this.#closing
    this.#state = 'closing' // Revoke before waiting; expiry/cancellation cannot block cleanup.
    this.#closing = (async () => {
      await this.#active
      const failures: unknown[] = []
      for (const file of this.files) {
        if (!file.closed) {
          // A descriptor is registered before its first fallible fstat. If
          // that syscall failed, retain and retry identification before close;
          // never turn the pathname into guessed cleanup ownership.
          if (file.dev < 0n || file.ino < 0n) {
            try {
              const stat = await requirePrivateDescriptor(file.handle)
              file.dev = stat.dev
              file.ino = stat.ino
            } catch (error) {
              failures.push(error)
              continue
            }
          }
          try {
            await file.handle.close()
            file.closed = true
          } catch (error) {
            failures.push(error)
          }
        }
        if (file.closed && !file.removed) {
          try {
            await this.directoryCurrent()
            let path
            try {
              path = await requirePrivatePath(file.name, false)
            } catch (error) {
              if (!missing(error)) throw error
            }
            if (path !== undefined) {
              if (!same(path, file)) throw new Error('Native structured index cleanup refuses a substituted file')
              await unlink(file.name)
            }
            file.removed = true
          } catch (error) {
            failures.push(error)
          }
        }
      }
      if (this.files.every(file => file.closed)) this.#key.fill(0)
      if (failures.length === 0) {
        try {
          await this.directoryCurrent()
          await rmdir(this.directory)
          this.#key.fill(0)
          this.#state = 'closed'
          this.reservation?.close()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length !== 0) throw new AggregateError(failures, 'Native structured index physical cleanup failed')
    })().catch(error => {
      this.#closing = undefined
      throw error
    })
    return this.#closing
  }
}
