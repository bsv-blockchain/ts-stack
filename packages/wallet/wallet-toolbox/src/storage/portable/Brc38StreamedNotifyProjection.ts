import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import {
  visitBrc38StructuredWalletField,
  visitBrc38StructuredJsonValues,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured,
  type Brc38StructuredVisitor
} from './Brc38StructuredJson'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38StreamedNotifyProjectionPolicy {
  /** Combined backend index ceiling for the two projection indexes. Actual
   * owners separately admit their grammar index and physical backend space. */
  readonly maximumTemporaryIndexBytes: number
  readonly maximumMembers: number
  readonly maximumOutputBytes: number
  /** Optional original per-index working and source/output transfer bounds.
   * Two indexes and the source grammar still require aggregate admission. */
  readonly maximumIndexAllocationBytes?: number
  readonly maximumGrammarAllocationBytes?: number
  readonly workingAllocation?: Brc38WorkingAllocation
  readonly maximumReadBytes?: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
  /** Explicit ordinary-replica path after EntityProvenTxReq normalization.
   * Preserve Number.isInteger's legacy finite values, including unsafe local
   * IDs. Canonical archive validation keeps its existing safe-ID contract. */
  readonly legacyNormalizedIntegers?: boolean
}
const ordinal = (value: number): string =>
  value < 0 ? '0' + String(Number.MAX_SAFE_INTEGER + value).padStart(16, '0') : '1' + String(value).padStart(16, '0')
function decodedOrdinal(value: string, legacy = false): number {
  if (legacy && /^2[0-9a-f]{16}$/.test(value)) {
    const bytes = Uint8Array.from(
      value
        .slice(1)
        .match(/../g)!
        .map(unit => Number.parseInt(unit, 16))
    )
    if (bytes[0] & 128) bytes[0] ^= 128
    else for (let index = 0; index < bytes.length; index++) bytes[index] ^= 255
    const number = new DataView(bytes.buffer).getFloat64(0)
    if (!Number.isInteger(number) || legacyOrdinal(number) !== value)
      throw new Error('Private legacy notification sort record differs')
    return number
  }
  if (!/^[01][0-9]{16}$/.test(value)) throw new Error('Private notification sort record differs')
  const result = Number(value.slice(1)) - (value[0] === '0' ? Number.MAX_SAFE_INTEGER : 0)
  if (!Number.isSafeInteger(result) || ordinal(result) !== value)
    throw new Error('Private notification sort identity differs')
  return result
}
/** Big-endian IEEE-754 order, with the sign transform preserving numeric order
 * over all finite integer Number values. -0 and +0 share one normalized key. */
function legacyOrdinal(value: number): string {
  if (!Number.isInteger(value)) throw new Error('Private legacy notification ID differs')
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value)
  if (bytes[0] & 128) for (let index = 0; index < bytes.length; index++) bytes[index] ^= 255
  else bytes[0] ^= 128
  return '2' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Private one-use sorted notification-ID output. This preserves the original
 * distinct incoming IDs, optional mappings, missing count and ascending unique
 * destination IDs without a whole array, Set or ID map in memory. Original raw
 * notification fields remain separately retained; this projects only the
 * transactionIds member and never activates a checkpoint or provider. */
export class Brc38StreamedNotifyProjection {
  #consumed = false
  #measured = false
  #measurementEnded = false
  #closed = false
  #active: Promise<void> = Promise.resolve()
  #closing?: Promise<void>
  #iterator?: AsyncGenerator<Uint8Array>
  private constructor(
    private readonly index: Brc38JsonMemberIndex,
    readonly unmappedIds: number,
    readonly mappedIncomingIds: number,
    readonly incomingIdsPresent: boolean,
    readonly existingIdsPresent: boolean,
    private readonly policy: Readonly<Brc38StreamedNotifyProjectionPolicy>,
    private readonly began: number,
    private readonly lifetime: number,
    private readonly checkActor: () => void,
    private readonly reservation?: Brc38WorkingCharge
  ) {}

  static async prepare(
    selectedOwners: Brc38StructuredProjectionOwners,
    selectedSource: Brc38StreamedStructured,
    selected: Brc38StreamedNotifyProjectionPolicy,
    selectedExisting?: Brc38StreamedStructured
  ): Promise<Brc38StreamedNotifyProjection> {
    const policy = Object.freeze({
        maximumTemporaryIndexBytes: selected.maximumTemporaryIndexBytes,
        maximumMembers: selected.maximumMembers,
        maximumOutputBytes: selected.maximumOutputBytes,
        maximumIndexAllocationBytes: selected.maximumIndexAllocationBytes,
        maximumGrammarAllocationBytes: selected.maximumGrammarAllocationBytes,
        workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
        maximumReadBytes: selected.maximumReadBytes,
        expiresAt: selected.expiresAt,
        signal: selected.signal,
        legacyNormalizedIntegers: selected.legacyNormalizedIntegers
      }),
      owners = Object.freeze({ ...selectedOwners }),
      source = Object.freeze({ ...selectedSource }),
      existing = selectedExisting === undefined ? undefined : Object.freeze({ ...selectedExisting }),
      began = performance.now(),
      lifetime = policy.expiresAt - Date.now()
    const check = (): void => {
      policy.signal?.throwIfAborted()
      owners.check()
      if (Date.now() >= policy.expiresAt || performance.now() - began >= lifetime)
        throw new SnapshotResourceLimitError('Private notification projection source expired')
    }
    check()
    if (
      !Number.isSafeInteger(policy.expiresAt) ||
      lifetime < 1 ||
      lifetime > 3600000 ||
      !Number.isSafeInteger(policy.maximumTemporaryIndexBytes) ||
      policy.maximumTemporaryIndexBytes < 2097152 ||
      policy.maximumTemporaryIndexBytes > 17179869184 ||
      !Number.isSafeInteger(policy.maximumMembers) ||
      policy.maximumMembers < 1 ||
      policy.maximumMembers > 2000000000 ||
      !Number.isSafeInteger(policy.maximumOutputBytes) ||
      policy.maximumOutputBytes < 2 ||
      policy.maximumOutputBytes > 1000000000 ||
      (policy.maximumReadBytes !== undefined &&
        (!Number.isSafeInteger(policy.maximumReadBytes) ||
          policy.maximumReadBytes < 64 ||
          policy.maximumReadBytes > 65536)) ||
      (policy.maximumIndexAllocationBytes !== undefined &&
        (!Number.isSafeInteger(policy.maximumIndexAllocationBytes) ||
          policy.maximumIndexAllocationBytes < 4096 ||
          policy.maximumIndexAllocationBytes > 16777216)) ||
      (policy.maximumGrammarAllocationBytes !== undefined &&
        (!Number.isSafeInteger(policy.maximumGrammarAllocationBytes) ||
          policy.maximumGrammarAllocationBytes < 4096 ||
          policy.maximumGrammarAllocationBytes > 16777216))
    )
      throw new RangeError('Invalid private notification projection policy')
    const reservation = policy.workingAllocation?.claim(4096)
    let incoming: Brc38JsonMemberIndex | undefined, mapped: Brc38JsonMemberIndex | undefined
    let groupCharge: Brc38WorkingCharge | undefined
    const acquisitionCleanup = new Set<Brc38StagingCleanupError>()
    let incomingIdsPresent = false,
      existingIdsPresent = false
    const close = async (): Promise<void> => {
      groupCharge?.close()
      groupCharge = undefined
      const failures: unknown[] = []
      for (const index of [incoming, mapped])
        if (index !== undefined) {
          try {
            await index.close()
          } catch (cause) {
            failures.push(cause)
          }
        }
      for (const retained of acquisitionCleanup) {
        try {
          await retained.retryCleanup()
          acquisitionCleanup.delete(retained)
        } catch (cause) {
          failures.push(cause)
        }
      }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(failures, 'Private notification projection retains index cleanup', close)
      reservation?.close()
    }
    const indexPolicy = {
      sourceBytes: Math.max(4, source.length, existing?.length ?? 0),
      maximumTemporaryIndexBytes: Math.floor(policy.maximumTemporaryIndexBytes / 2),
      maximumTemporaryPhysicalBytes: Math.floor(policy.maximumTemporaryIndexBytes / 2),
      maximumMembers: policy.maximumMembers,
      maximumAllocationBytes: policy.maximumIndexAllocationBytes,
      workingAllocation: policy.workingAllocation,
      expiresAt: policy.expiresAt,
      signal: policy.signal
    }
    // Fixed synthetic spans belong only to derived sort records. They are DATA,
    // never interpreted as JSON/source coordinates or admission credentials.
    const record = (key: string) => ({ key, keyOffset: 1, start: 2, end: 3 })
    const sortKey = policy.legacyNormalizedIntegers === true ? legacyOrdinal : ordinal,
      visit = async (value: Brc38StreamedStructured, path: string, visitor: Brc38StructuredVisitor): Promise<void> => {
        const grammar = {
          maximumInputBytes: 1000000000,
          maximumOutputBytes: 1000000000,
          maximumChunkBytes: policy.maximumReadBytes ?? 65536,
          maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
          workingAllocation: policy.workingAllocation,
          signal: policy.signal
        }
        if (policy.legacyNormalizedIntegers !== true) {
          await visitBrc38StructuredWalletField('notify', value, grammar, path, visitor)
          return
        }
        await visitBrc38StructuredJsonValues(value, grammar, {
          ...visitor,
          enter: async (member, kind, offset) => {
            check()
            if (
              (member.length === 0 && kind !== 'object') ||
              (member[0] === 'transactionIds' &&
                ((member.length === 1 && kind !== 'array' && kind !== 'null') ||
                  (member.length === 2 && kind !== 'number')))
            )
              throw new Error('Private normalized legacy notification differs')
            await visitor.enter?.(member, kind, offset)
          },
          number: async (member, number) => {
            if (member.length === 2 && member[0] === 'transactionIds' && !Number.isInteger(number))
              throw new Error('Private normalized legacy notification ID differs')
            await visitor.number?.(member, number)
          }
        })
      }
    try {
      incoming = await owners.openIndex(indexPolicy)
      mapped = await owners.openIndex(indexPolicy)
      // Existing IDs are already in the current destination namespace. Keep
      // them unchanged, including legacy zero/signed IDs, and never apply the
      // incoming archive's ID map to them. Both original source passes finish
      // under their concrete host owners before derived output is returned.
      if (existing !== undefined)
        await visit(existing, 'provenTxReqs.existing.notify', {
          enter: (path, kind) => {
            check()
            if (path.length === 1 && path[0] === 'transactionIds' && kind === 'array') existingIdsPresent = true
          },
          number: async (path, value) => {
            check()
            if (path.length === 2 && path[0] === 'transactionIds') {
              if (!(policy.legacyNormalizedIntegers === true ? Number.isInteger(value) : Number.isSafeInteger(value)))
                throw new Error('Private existing notification ID differs')
              await mapped!.put(0, record(sortKey(value)))
            }
            check()
          }
        })
      await visit(source, 'provenTxReqs.notify', {
        enter: (path, kind) => {
          check()
          if (path.length === 1 && path[0] === 'transactionIds' && kind === 'array') incomingIdsPresent = true
        },
        number: async (path, value) => {
          check()
          if (path.length === 2 && path[0] === 'transactionIds') await incoming!.put(0, record(String(value)))
          check()
        }
      })
      check()
      await incoming.seal()
      check()
      const groupLimit =
        policy.workingAllocation === undefined
          ? 128
          : Math.min(
              128,
              Math.max(1, Math.floor((policy.workingAllocation.maximum - policy.workingAllocation.used - 4608) / 1280))
            )
      let missing = 0,
        mappedIncoming = 0,
        group: number[] = []
      const flush = async (): Promise<void> => {
        check()
        const scratch = policy.workingAllocation?.claim(4096 + 1152 * group.length)
        try {
          const loaded = await owners.readMappings('transaction', group)
          check()
          if (loaded.length !== group.length) throw new Error('Private notification mapping batch differs')
          for (let position = 0; position < group.length; position++) {
            if (loaded[position] !== undefined) {
              const destination = loaded[position]!
              if (!Number.isSafeInteger(destination)) throw new Error('Private notification destination ID differs')
              await mapped!.put(0, record(sortKey(destination)))
              mappedIncoming++
            } else missing++
            check()
          }
          group = []
          groupCharge?.close()
          groupCharge = undefined
        } finally {
          scratch?.close()
        }
      }
      for await (const entry of incoming.entries(0)) {
        check()
        const value = Number(entry.key)
        if (!Number.isInteger(value) || String(value) !== entry.key)
          throw new Error('Private notification incoming ID differs')
        const bytes = 512 + 128 * (group.length + 1)
        if (groupCharge === undefined) groupCharge = policy.workingAllocation?.claim(bytes)
        else groupCharge.resize(bytes)
        group.push(value)
        if (group.length === groupLimit) await flush()
      }
      if (group.length !== 0) await flush()
      check()
      await mapped.seal()
      check()
      await incoming.close()
      incoming = undefined
      return new Brc38StreamedNotifyProjection(
        mapped,
        missing,
        mappedIncoming,
        incomingIdsPresent,
        existingIdsPresent,
        policy,
        began,
        lifetime,
        owners.check,
        reservation
      )
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) acquisitionCleanup.add(cause)
      try {
        await close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private notification projection failed with retained cleanup',
          close
        )
      }
      throw cause
    }
  }
  private check(): void {
    this.policy.signal?.throwIfAborted()
    this.checkActor()
    if (this.#closed || Date.now() >= this.policy.expiresAt || performance.now() - this.began >= this.lifetime)
      throw new SnapshotResourceLimitError('Private notification projection is closed or expired')
  }
  chunks(maximumChunkBytes = 65536): AsyncGenerator<Uint8Array> {
    this.check()
    if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 64 || maximumChunkBytes > 65536)
      throw new RangeError('Invalid private notification output chunk bound')
    if (this.policy.maximumReadBytes !== undefined && maximumChunkBytes > this.policy.maximumReadBytes)
      throw new SnapshotResourceLimitError('Notification output exceeds its original transfer window')
    if (this.#consumed) throw new Error('Private notification projection was already consumed')
    if (this.#measured && !this.#measurementEnded)
      throw new Error('Notification measurement must reach actual EOF before replay')
    this.#consumed = true
    this.#iterator = this.produce(maximumChunkBytes)
    return this.#iterator
  }
  /** Optional measurement plus one fresh final traversal of immutable sort
   * DATA. EOF is progress only; concrete actors and deadlines remain checked. */
  measureChunks(maximumChunkBytes = 65536): AsyncGenerator<Uint8Array> {
    this.check()
    if (
      !Number.isSafeInteger(maximumChunkBytes) ||
      maximumChunkBytes < 64 ||
      maximumChunkBytes > (this.policy.maximumReadBytes ?? 65536)
    )
      throw new RangeError('Notification measurement exceeds its original transfer window')
    if (this.#measured || this.#consumed)
      throw new Error('Notification measurement was already requested or output consumed')
    this.#measured = true
    this.#iterator = this.produceMeasurement(maximumChunkBytes)
    return this.#iterator
  }
  private async *produceMeasurement(maximumChunkBytes: number): AsyncGenerator<Uint8Array> {
    yield* this.produce(maximumChunkBytes)
    this.check()
    this.#measurementEnded = true
  }
  private async *produce(maximumChunkBytes: number): AsyncGenerator<Uint8Array> {
    this.check()
    let drain!: () => void
    this.#active = new Promise<void>(resolve => {
      drain = resolve
    })
    let scratch: Brc38WorkingCharge | undefined
    const encoder = new TextEncoder()
    let total = 2,
      first = true,
      buffer = '['
    try {
      scratch = this.policy.workingAllocation?.claim(1024 + 16 * maximumChunkBytes)
      for await (const entry of this.index.entries(0)) {
        this.check()
        const part =
          (first ? '' : ',') + String(decodedOrdinal(entry.key, this.policy.legacyNormalizedIntegers === true))
        if (part.length > this.policy.maximumOutputBytes - total)
          throw new SnapshotResourceLimitError('Private notification projection exceeds its output byte limit')
        total += part.length
        first = false
        if (part.length > maximumChunkBytes - buffer.length) {
          yield encoder.encode(buffer)
          buffer = ''
        }
        buffer += part
        this.check()
      }
      this.check()
      if (buffer.length === maximumChunkBytes) {
        yield encoder.encode(buffer)
        buffer = ''
      }
      yield encoder.encode(buffer + ']')
      this.check()
    } finally {
      buffer = ''
      scratch?.close()
      drain()
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    if (this.#closing !== undefined) return await this.#closing
    this.#closing = (async () => {
      let failed = false,
        original: unknown
      try {
        if (this.#iterator !== undefined) await this.#iterator.return(undefined)
      } catch (cause) {
        failed = true
        original = cause
      }
      await this.#active
      try {
        await this.index.close()
        this.reservation?.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          failed ? [original, error_] : [error_],
          'Private notification output retains physical index cleanup',
          () => this.close()
        )
      }
      if (failed) throw original
    })()
    try {
      await this.#closing
    } catch (cause) {
      this.#closing = undefined
      throw cause
    }
  }
}
