import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import {
  canonicalBrc38StructuredStringSpan,
  visitBrc38StructuredWalletField,
  validateBrc38StructuredWalletField,
  verifyBrc38StructuredSourceDigest,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import type { Brc38StreamedNotifyProjectionPolicy } from './Brc38StreamedNotifyProjection'

export interface Brc38StreamedSyncMapProjectionPolicy extends Brc38StreamedNotifyProjectionPolicy {
  /** Fixed allowance for one decoded date scalar, charged before appending.
   * Large entity names and ID maps are streamed, never retained as strings. */
  readonly maximumScalarBytes: number
}
type Entity = keyof SyncMap
interface Entry {
  readonly entity: Entity
  object: boolean
  count: number
  idMapOffset?: number
  entityName?: { start: number; end: number }
  maxUpdated_at?: string
}
const entities = Object.freeze((Object.keys(createSyncMap()) as Entity[]).sort((a, b) => Number(a > b) - Number(a < b)))
function arrayIndex(key: string): boolean {
  const value = Number(key)
  return Number.isInteger(value) && value >= 0 && value < 4294967295 && String(value) === key
}
/** Normalized map keys retain JavaScript's original enumeration precedence:
 * integer-index properties precede other properties; the latter use their
 * FIRST insertion position even when a duplicate supplies the selected value.
 * Ranking and spans are derived DATA, never admission/profile verdicts. */
export class Brc38StreamedSyncMapProjection {
  #consumed = false
  #closed = false
  #active: Promise<void> = Promise.resolve()
  #closing?: Promise<void>
  #iterator?: AsyncGenerator<Uint8Array>
  private constructor(
    private readonly index: Brc38JsonMemberIndex,
    private readonly source: Readonly<Brc38StreamedStructured>,
    private readonly entries: readonly Entry[],
    readonly unmappedIds: number,
    private readonly policy: Readonly<Brc38StreamedSyncMapProjectionPolicy>,
    private readonly began: number,
    private readonly lifetime: number,
    private readonly checkActor: () => void,
    private readonly reservation?: Brc38WorkingCharge
  ) {}

  static async prepare(
    selectedOwners: Brc38StructuredProjectionOwners,
    selectedSource: Brc38StreamedStructured,
    selected: Brc38StreamedSyncMapProjectionPolicy
  ): Promise<Brc38StreamedSyncMapProjection> {
    const policy = Object.freeze({
        maximumTemporaryIndexBytes: selected.maximumTemporaryIndexBytes,
        maximumMembers: selected.maximumMembers,
        maximumOutputBytes: selected.maximumOutputBytes,
        maximumScalarBytes: selected.maximumScalarBytes,
        maximumIndexAllocationBytes: selected.maximumIndexAllocationBytes,
        maximumGrammarAllocationBytes: selected.maximumGrammarAllocationBytes,
        workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
        maximumReadBytes: selected.maximumReadBytes,
        expiresAt: selected.expiresAt,
        signal: selected.signal
      }),
      owners = Object.freeze({ ...selectedOwners }),
      source = Object.freeze({ ...selectedSource }),
      began = performance.now(),
      lifetime = policy.expiresAt - Date.now()
    const check = (): void => {
      policy.signal?.throwIfAborted()
      owners.check()
      if (Date.now() >= policy.expiresAt || performance.now() - began >= lifetime)
        throw new SnapshotResourceLimitError('Private sync-map projection source expired')
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
      !Number.isSafeInteger(policy.maximumScalarBytes) ||
      policy.maximumScalarBytes < 2 ||
      policy.maximumScalarBytes > 16777216 ||
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
      throw new RangeError('Invalid private sync-map projection policy')
    const reservation = policy.workingAllocation?.claim(8192)
    const entries: Entry[] = entities.map(entity => ({ entity, object: false, count: 0 })),
      byEntity = new Map<Entity, Entry>(entries.map(entry => [entry.entity, entry])),
      indexPolicy = {
        sourceBytes: Math.max(32, source.length),
        maximumTemporaryIndexBytes: Math.floor(policy.maximumTemporaryIndexBytes / 2),
        maximumTemporaryPhysicalBytes: Math.floor(policy.maximumTemporaryIndexBytes / 2),
        maximumMembers: policy.maximumMembers,
        maximumAllocationBytes: policy.maximumIndexAllocationBytes,
        workingAllocation: policy.workingAllocation,
        expiresAt: policy.expiresAt,
        signal: policy.signal
      }
    let incoming: Brc38JsonMemberIndex | undefined,
      mapped: Brc38JsonMemberIndex | undefined,
      actualGrammar: Brc38JsonMemberIndex | undefined,
      date = '',
      dateEntity: Entity | undefined,
      dateCharge: Brc38WorkingCharge | undefined
    let groupCharge: Brc38WorkingCharge | undefined
    const acquisitionCleanup = new Set<Brc38StagingCleanupError>()
    const close = async (): Promise<void> => {
      date = ''
      dateCharge?.close()
      dateCharge = undefined
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
        throw new Brc38StagingCleanupError(failures, 'Private sync-map projection retains index cleanup', close)
      reservation?.close()
    }
    const selectedEntry = (path: readonly (string | number)[]): Entry | undefined =>
      typeof path[0] === 'string' ? byEntity.get(path[0] as Entity) : undefined
    try {
      incoming = await owners.openIndex(indexPolicy)
      mapped = await owners.openIndex(indexPolicy)
      await visitBrc38StructuredWalletField(
        'syncMap',
        {
          ...source,
          openIndex: async () => {
            check()
            const index = await source.openIndex()
            actualGrammar = index
            try {
              check()
              return index
            } catch (cause) {
              try {
                await index.close()
              } catch (error_) {
                throw new Brc38StagingCleanupError([cause, error_], 'Sync-map source acquisition retains cleanup', () =>
                  index.close()
                )
              }
              throw cause
            }
          }
        },
        {
          maximumInputBytes: 1000000000,
          maximumOutputBytes: 1000000000,
          maximumChunkBytes: policy.maximumReadBytes ?? 65536,
          maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
          workingAllocation: policy.workingAllocation,
          signal: policy.signal
        },
        'syncStates.syncMap',
        {
          enter: (path, kind, offset) => {
            check()
            const entry = selectedEntry(path)
            if (entry === undefined) return
            if (path.length === 1) entry.object = kind === 'object'
            if (!entry.object || path.length !== 2) return
            if (path[1] === 'idMap' && kind === 'object') entry.idMapOffset = offset
            if (path[1] === 'entityName' && kind === 'string') entry.entityName = { start: offset, end: offset }
            if (path[1] === 'maxUpdated_at' && kind === 'string') {
              date = ''
              dateCharge?.close()
              dateCharge = undefined
              dateEntity = entry.entity
            }
          },
          text: (path, value) => {
            check()
            if (path.length === 2 && path[0] === dateEntity && path[1] === 'maxUpdated_at') {
              if (value.length * 2 > policy.maximumScalarBytes - date.length * 2)
                throw new SnapshotResourceLimitError('Private sync-map date exceeds its fixed scalar allocation')
              const bytes = 1024 + 16 * (date.length + value.length)
              if (dateCharge === undefined) dateCharge = policy.workingAllocation?.claim(bytes)
              else dateCharge.resize(bytes)
              date += value
            }
          },
          number: async (path, value) => {
            check()
            const entry = selectedEntry(path)
            if (entry === undefined || !entry.object || !Number.isInteger(value)) return
            if (path.length === 2 && path[1] === 'count') entry.count = value
            if (
              path.length !== 3 ||
              path[1] !== 'idMap' ||
              typeof path[2] !== 'string' ||
              entry.idMapOffset === undefined
            )
              return
            const remote = Number(path[2])
            if (!Number.isInteger(remote)) return
            if (actualGrammar?.lookup === undefined)
              throw new Error('Sync-map projection requires actual bounded insertion lookup')
            const member = await actualGrammar.lookup(entry.idMapOffset, path[2])
            check()
            if (member === undefined) throw new Error('Private sync-map selected member is absent')
            const rank = arrayIndex(path[2]) ? 0 : member.firstKeyOffset,
              key = String(remote) + '!' + String(rank).padStart(10, '0')
            await incoming!.put(entry.idMapOffset, {
              key,
              keyOffset: member.keyOffset,
              start: member.start,
              end: member.end
            })
            check()
          },
          end: (path, end) => {
            check()
            const entry = selectedEntry(path)
            if (entry === undefined || !entry.object || path.length !== 2) return
            if (path[1] === 'entityName' && entry.entityName !== undefined) entry.entityName.end = end
            if (path[1] === 'maxUpdated_at' && dateEntity === entry.entity) {
              const when = new Date(date)
              if (!Number.isNaN(when.getTime())) entry.maxUpdated_at = when.toISOString()
              date = ''
              dateCharge?.close()
              dateCharge = undefined
              dateEntity = undefined
            }
          }
        }
      )
      date = ''
      dateCharge?.close()
      dateCharge = undefined
      actualGrammar = undefined
      check()
      await incoming.seal()
      check()
      const groupLimit =
        policy.workingAllocation === undefined
          ? 128
          : Math.min(
              128,
              Math.max(1, Math.floor((policy.workingAllocation.maximum - policy.workingAllocation.used - 4608) / 1664))
            )
      let missing = 0
      for (const entry of entries) {
        const idMapOffset = entry.idMapOffset
        if (idMapOffset === undefined) continue
        let group: Array<readonly [string, number]> = [],
          pending: { remote: string; start: number; end: number } | undefined
        const flush = async (): Promise<void> => {
          check()
          const scratch = policy.workingAllocation?.claim(4096 + 1152 * group.length)
          try {
            const loaded = await owners.readMappings(
              entry.entity,
              group.map(([, incomingId]) => incomingId)
            )
            check()
            if (loaded.length !== group.length) throw new Error('Private sync-map mapping batch differs')
            for (let ordinal = 0; ordinal < group.length; ordinal++) {
              const remote = group[ordinal][0]
              if (loaded[ordinal] !== undefined) {
                const destination = loaded[ordinal]!
                if (!Number.isSafeInteger(destination)) throw new Error('Private sync-map destination ID differs')
                // Fixed spans are DATA for derived output records only.
                await mapped!.put(idMapOffset, {
                  key: remote + '!' + String(destination),
                  keyOffset: idMapOffset + 1,
                  start: idMapOffset + 2,
                  end: idMapOffset + 3
                })
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
        const retain = async (): Promise<void> => {
          if (pending === undefined) return
          const length = pending.end - pending.start
          if (!Number.isSafeInteger(length) || length < 1 || length > 16384)
            throw new Error('Private sync-map number span differs')
          check()
          const width = policy.maximumReadBytes ?? 65536,
            scratch = policy.workingAllocation?.claim(1024 + 16 * length + 4 * Math.min(width, length))
          let bytes: Uint8Array | undefined
          try {
            bytes = new Uint8Array(length)
            for (let offset = 0; offset < length;) {
              const amount = Math.min(width, length - offset),
                supplied = await source.read(pending.start + offset, amount)
              check()
              if (!(supplied instanceof Uint8Array) || supplied.length !== amount)
                throw new Error('Private sync-map number range differs')
              bytes.set(supplied, offset)
              offset += amount
            }
            const value: unknown = JSON.parse(
              new TextDecoder(source.encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true }).decode(bytes)
            )
            if (typeof value !== 'number' || !Number.isInteger(value))
              throw new Error('Private sync-map selected ID differs')
            const allocation = 512 + 512 * (group.length + 1)
            if (groupCharge === undefined) groupCharge = policy.workingAllocation?.claim(allocation)
            else groupCharge.resize(allocation)
            group.push([pending.remote, value])
          } finally {
            bytes?.fill(0)
            scratch?.close()
          }
          if (group.length === groupLimit) await flush()
        }
        for await (const member of incoming.entries(idMapOffset)) {
          check()
          const separator = member.key.indexOf('!'),
            remote = member.key.slice(0, separator)
          if (
            separator < 1 ||
            !Number.isInteger(Number(remote)) ||
            String(Number(remote)) !== remote ||
            !/^[0-9]{10}$/.test(member.key.slice(separator + 1))
          )
            throw new Error('Private sync-map rank record differs')
          if (pending !== undefined && pending.remote !== remote) await retain()
          pending = { remote, start: member.start, end: member.end }
        }
        await retain()
        if (group.length !== 0) await flush()
      }
      check()
      await mapped.seal()
      check()
      await incoming.close()
      incoming = undefined
      return new Brc38StreamedSyncMapProjection(
        mapped,
        source,
        Object.freeze(
          entries.map(entry =>
            Object.freeze({
              ...entry,
              entityName: entry.entityName === undefined ? undefined : Object.freeze({ ...entry.entityName })
            })
          )
        ),
        missing,
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
          'Private sync-map projection failed with retained cleanup',
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
      throw new SnapshotResourceLimitError('Private sync-map projection is closed or expired')
  }
  chunks(maximumChunkBytes = 65536, selectedAssembly?: Brc38StreamedStructured): AsyncGenerator<Uint8Array> {
    this.check()
    if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 64 || maximumChunkBytes > 65536)
      throw new RangeError('Invalid private sync-map output chunk bound')
    if (this.policy.maximumReadBytes !== undefined && maximumChunkBytes > this.policy.maximumReadBytes)
      throw new SnapshotResourceLimitError('Sync-map output exceeds its original transfer window')
    if (this.#consumed) throw new Error('Private sync-map projection was already consumed')
    if (selectedAssembly === undefined) throw new Error('Sync-map output requires a fresh retained assembly source')
    const assembly = Object.freeze({ ...selectedAssembly })
    if (
      assembly.length !== this.source.length ||
      assembly.encoding !== this.source.encoding ||
      assembly.sha256 !== this.source.sha256
    )
      throw new Error('Private sync-map assembly descriptor differs')
    this.#consumed = true
    this.#iterator = this.produce(maximumChunkBytes, assembly)
    return this.#iterator
  }
  private async *parts(
    maximumChunkBytes: number,
    source: Readonly<Brc38StreamedStructured>
  ): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder(),
      bytes = (value: string) => encoder.encode(value)
    yield bytes('{')
    for (let ordinal = 0; ordinal < this.entries.length; ordinal++) {
      this.check()
      const entry = this.entries[ordinal]
      yield bytes(
        (ordinal === 0 ? '' : ',') +
          JSON.stringify(entry.entity) +
          ':{"count":' +
          JSON.stringify(entry.count) +
          ',"entityName":'
      )
      if (entry.entityName === undefined) yield bytes(JSON.stringify(entry.entity))
      else
        yield* canonicalBrc38StructuredStringSpan(source, entry.entityName, {
          maximumInputBytes: 1000000000,
          maximumOutputBytes: this.policy.maximumOutputBytes,
          maximumChunkBytes,
          maximumAllocationBytes: this.policy.maximumGrammarAllocationBytes,
          workingAllocation: this.policy.workingAllocation,
          signal: this.policy.signal
        })
      yield bytes(',"idMap":{')
      let first = true,
        previous: string | undefined
      if (entry.idMapOffset !== undefined)
        for await (const member of this.index.entries(entry.idMapOffset)) {
          this.check()
          const separator = member.key.indexOf('!'),
            remote = member.key.slice(0, separator),
            local = member.key.slice(separator + 1)
          if (
            separator < 1 ||
            !Number.isInteger(Number(remote)) ||
            String(Number(remote)) !== remote ||
            !Number.isSafeInteger(Number(local)) ||
            String(Number(local)) !== local ||
            (previous !== undefined && remote <= previous)
          )
            throw new Error('Private sync-map output record differs')
          previous = remote
          yield bytes((first ? '' : ',') + JSON.stringify(remote) + ':' + local)
          first = false
        }
      yield bytes(
        '}' + (entry.maxUpdated_at === undefined ? '' : ',"maxUpdated_at":' + JSON.stringify(entry.maxUpdated_at)) + '}'
      )
    }
    this.check()
    yield bytes('}')
  }
  private async *produce(
    maximumChunkBytes: number,
    source: Readonly<Brc38StreamedStructured>
  ): AsyncGenerator<Uint8Array> {
    this.check()
    let drain!: () => void
    this.#active = new Promise<void>(resolve => {
      drain = resolve
    })
    let buffer: Uint8Array | undefined,
      owned = true,
      used = 0,
      total = 0
    let scratch: Brc38WorkingCharge | undefined
    try {
      scratch = this.policy.workingAllocation?.claim(4096 + 16 * maximumChunkBytes)
      buffer = new Uint8Array(maximumChunkBytes)
      // Re-read the actual complete source and fresh grammar index around
      // derived output. Preparation metadata is never a reusable verdict.
      const sourcePolicy = {
        maximumInputBytes: 1000000000,
        maximumOutputBytes: 1000000000,
        maximumChunkBytes,
        maximumAllocationBytes: this.policy.maximumGrammarAllocationBytes,
        workingAllocation: this.policy.workingAllocation,
        signal: this.policy.signal
      }
      await validateBrc38StructuredWalletField('syncMap', source, sourcePolicy, 'syncStates.syncMap')
      this.check()
      for await (const part of this.parts(maximumChunkBytes, source)) {
        this.check()
        if (part.length > this.policy.maximumOutputBytes - total)
          throw new SnapshotResourceLimitError('Private sync-map projection exceeds its output byte limit')
        total += part.length
        for (let offset = 0; offset < part.length;) {
          const count = Math.min(part.length - offset, maximumChunkBytes - used)
          buffer.set(part.subarray(offset, offset + count), used)
          offset += count
          used += count
          if (used === maximumChunkBytes) {
            owned = false
            yield buffer
            buffer = new Uint8Array(maximumChunkBytes)
            owned = true
            used = 0
          }
        }
      }
      await verifyBrc38StructuredSourceDigest(
        source,
        1000000000,
        this.policy.signal,
        maximumChunkBytes,
        this.policy.maximumGrammarAllocationBytes,
        this.policy.workingAllocation
      )
      this.check()
      if (used !== 0) yield buffer.slice(0, used)
    } finally {
      if (owned) buffer?.fill(0)
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
          'Private sync-map output retains physical index cleanup',
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
