import { awaitFromSync } from '../utility/promiseFromSync'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { getPackedIdbConnection, type PackedIdbConnection } from './idbPackedConnection'
import {
  chargePackedIdb,
  packedIdbIsUint8Array,
  packedIdbIsAbortError,
  newPackedIdbId,
  packIdbRow,
  packedIdbChunkBytes,
  packedIdbInvalid,
  packedIdbMetadataCharge,
  packedIdbStores,
  readPackedIdbClock,
  readPackedIdbMetadataRequests,
  type PackedIdbField,
  type PackedIdbRow,
  type PackedIdbTransaction
} from './idbPackedFields'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'

export interface PackedIdbStageOptions {
  kind: PackedIdbField['kind']
  bytes: number
  sha256: string
  lifetimeMs?: number
  /** Optional original absolute admission ceiling; staging cannot renew it. */
  expiresAt?: number
  signal?: AbortSignal
}
interface StageIdentity {
  owner: PackedIdbConnection
  epoch: string
  field: Readonly<PackedIdbField>
  expiresAt: number
  monotonicExpires: number
  signal?: AbortSignal
  closed: boolean
}
const stages = new WeakMap<object, StageIdentity>()
function actualStage(stage: PackedIdbStagedField, owner?: PackedIdbConnection): StageIdentity {
  const actual = stages.get(stage)
  if (
    actual === undefined ||
    actual.closed ||
    (owner !== undefined && actual.owner !== owner) ||
    getPackedIdbConnection(actual.owner.database) !== actual.owner ||
    !actual.owner.isOpen
  )
    packedIdbInvalid()
  actual.signal?.throwIfAborted()
  if (Date.now() >= actual.expiresAt || performance.now() >= actual.monotonicExpires)
    throw new SnapshotResourceLimitError('Packed IndexedDB field stage expired')
  return actual
}
async function durableStage(
  tx: PackedIdbTransaction,
  identity: StageIdentity,
  sealed: boolean
): Promise<Record<string, unknown>> {
  const [clock, actual] = await readPackedIdbMetadataRequests(
    () => readPackedIdbClock(tx),
    () => tx.objectStore(packedIdbStores.contents).get(identity.field.content)
  )
  if (
    clock.epoch !== identity.epoch ||
    actual?.id !== identity.field.content ||
    actual.kind !== identity.field.kind ||
    actual.sha256 !== identity.field.sha256 ||
    actual.bytes !== identity.field.bytes ||
    !(actual.state === 'sealed' || (!sealed && actual.state === 'pending')) ||
    typeof actual.refs !== 'number' ||
    !Number.isSafeInteger(actual.refs) ||
    actual.refs < 0 ||
    typeof actual.received !== 'number' ||
    !Number.isSafeInteger(actual.received) ||
    actual.received < 0 ||
    actual.received > identity.field.bytes ||
    (actual.refs === 0 && (actual.expiresAt !== identity.expiresAt || actual.retired !== 0)) ||
    (sealed && actual.received !== identity.field.bytes)
  )
    packedIdbInvalid()
  return actual
}
async function drain<T>(tx: PackedIdbTransaction, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run()
    await tx.done
    return value
  } catch (error_) {
    try {
      tx.abort()
    } catch {
      /* It may already be settled. */
    }
    try {
      await tx.done
    } catch (error) {
      if (error !== error_ && !packedIdbIsAbortError(error))
        throw new AggregateError([error_, error], 'Packed IndexedDB field stage and cleanup failed', {
          cause: error_
        })
    }
    throw error_
  }
}
/** Actual owner-issued stage. Chunks commit in separate short transactions;
 * no source callback, network operation or Blob conversion holds a writer.
 * Descriptor hashes/positions are data. Only this actual stage can be attached. */
export class PackedIdbStagedField {
  #busy = false
  #inFlight?: Promise<unknown>
  #closePromise?: Promise<void>
  private constructor() {}
  static async open(owner: PackedIdbConnection, selected: PackedIdbStageOptions): Promise<PackedIdbStagedField> {
    const options = Object.freeze({ ...selected })
    if (
      getPackedIdbConnection(owner.database) !== owner ||
      !owner.isOpen ||
      !['array', 'typed', 'utf16'].includes(options.kind) ||
      !Number.isSafeInteger(options.bytes) ||
      options.bytes < 0 ||
      options.bytes > 1000000000 ||
      (options.kind === 'utf16' && options.bytes % 2 !== 0) ||
      !/^[0-9a-f]{64}$/.test(options.sha256)
    )
      packedIdbInvalid()
    const lifetimeMs = options.lifetimeMs ?? 300000
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3600000) packedIdbInvalid()
    options.signal?.throwIfAborted()
    const now = Date.now(),
      selectedExpiry = options.expiresAt ?? now + lifetimeMs
    if (!Number.isSafeInteger(selectedExpiry) || selectedExpiry <= now) packedIdbInvalid()
    const stage = new PackedIdbStagedField(),
      expiresAt = Math.min(now + lifetimeMs, selectedExpiry),
      monotonicExpires = performance.now() + (expiresAt - now),
      field = Object.freeze({
        content: newPackedIdbId(),
        kind: options.kind,
        bytes: options.bytes,
        sha256: options.sha256
      })
    const tx = owner.rawTransaction([], 'readwrite')
    const epoch = await drain(tx, async () => {
      const clock = await readPackedIdbClock(tx)
      await chargePackedIdb(tx, field.bytes + 512, 1)
      await tx.objectStore(packedIdbStores.contents).add({
        id: field.content,
        kind: field.kind,
        bytes: field.bytes,
        sha256: field.sha256,
        state: 'pending',
        refs: 0,
        retired: 0,
        expiresAt,
        received: 0
      })
      options.signal?.throwIfAborted()
      owner.assertOpen()
      if (Date.now() >= expiresAt || performance.now() >= monotonicExpires)
        throw new SnapshotResourceLimitError('Packed IndexedDB stage opening expired')
      return clock.epoch
    })
    stages.set(stage, { owner, epoch, field, expiresAt, monotonicExpires, signal: options.signal, closed: false })
    return stage
  }
  get descriptor(): Readonly<PackedIdbField> {
    return { ...actualStage(this).field }
  }
  /** Concrete issuer/lifecycle only, never source or semantic admission. */
  requireOwner(owner: PackedIdbConnection): void {
    actualStage(this, owner)
  }
  /** Actual sealed-stage bytes for preparation only. Descriptor copies cannot
   * open this actor. Each bounded window rechecks its original issuer, durable
   * content, epoch and lifetime and drains its native read before returning.
   * The caller owns the returned buffer and its original allocation. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const original = actualStage(this)
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 65536 ||
      offset + length > original.field.bytes
    )
      packedIdbInvalid()
    let bytes: Uint8Array | undefined
    try {
      return await this.operation(current =>
        awaitFromSync(() => {
          const tx = current.owner.rawTransaction([], 'readonly')
          return drain(tx, async () => {
            await durableStage(tx, current, true)
            // An unpromoted, sealed stage has zero row references and is not
            // retired. Only this actual live stage may read it; the operational
            // row reader keeps its original referenced/retired-content guard.
            bytes = new Uint8Array(length)
            for (let used = 0; used < length;) {
              actualStage(this)
              const index = Math.floor((offset + used) / packedIdbChunkBytes),
                start = (offset + used) % packedIdbChunkBytes,
                chunk = await tx.objectStore(packedIdbStores.chunks).get([current.field.content, index])
              if (
                chunk?.content !== current.field.content ||
                chunk.index !== index ||
                !packedIdbIsUint8Array(chunk.data) ||
                chunk.data.length !==
                  Math.min(packedIdbChunkBytes, current.field.bytes - index * packedIdbChunkBytes) ||
                typeof chunk.sha256 !== 'string' ||
                new SHA256().update(chunk.data).digestHex() !== chunk.sha256
              )
                packedIdbInvalid()
              const count = Math.min(length - used, chunk.data.length - start)
              if (count < 1) packedIdbInvalid()
              bytes.set(chunk.data.subarray(start, start + count), used)
              used += count
            }
            await durableStage(tx, current, true)
            actualStage(this)
            return bytes
          })
        })
      )
    } catch (cause) {
      bytes?.fill(0)
      throw cause
    }
  }
  private async operation<T>(run: (identity: StageIdentity) => Promise<T>): Promise<T> {
    const identity = actualStage(this)
    if (this.#busy) packedIdbInvalid()
    this.#busy = true
    try {
      const work = run(identity)
      this.#inFlight = work
      const result = await work
      actualStage(this)
      return result
    } finally {
      this.#busy = false
      this.#inFlight = undefined
    }
  }
  async append(offset: number, input: Uint8Array): Promise<void> {
    const identity = actualStage(this)
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % packedIdbChunkBytes !== 0 ||
      !packedIdbIsUint8Array(input) ||
      input.length !== Math.min(packedIdbChunkBytes, identity.field.bytes - offset) ||
      input.length < 1
    )
      packedIdbInvalid()
    // Detach BEFORE the first await; mutations to a transport buffer cannot
    // alter the persisted chunk or its digest.
    const data = input.slice(),
      sha256 = new SHA256().update(data).digestHex()
    await this.operation(async current => {
      const tx = current.owner.rawTransaction([], 'readwrite')
      await drain(tx, async () => {
        const actual = await durableStage(tx, current, false)
        if (offset < (actual.received as number)) {
          const prior = await tx
            .objectStore(packedIdbStores.chunks)
            .get([current.field.content, offset / packedIdbChunkBytes])
          if (
            prior?.sha256 !== sha256 ||
            !packedIdbIsUint8Array(prior.data) ||
            prior.data.length !== data.length ||
            new SHA256().update(prior.data).digestHex() !== sha256
          )
            packedIdbInvalid()
          return
        }
        if (actual.state !== 'pending' || actual.received !== offset) packedIdbInvalid()
        await chargePackedIdb(tx, 256, 1)
        await tx
          .objectStore(packedIdbStores.chunks)
          .add({ content: current.field.content, index: offset / packedIdbChunkBytes, data, sha256 })
        await tx.objectStore(packedIdbStores.contents).put({ ...actual, received: offset + data.length })
        actualStage(this)
      })
    })
  }
  finish(): Promise<Readonly<PackedIdbField>> {
    return awaitFromSync(() => {
      return this.operation(async identity => {
        const hash = new SHA256()
        for (let offset = 0; offset < identity.field.bytes; offset += packedIdbChunkBytes) {
          actualStage(this)
          const tx = identity.owner.rawTransaction([], 'readonly')
          const data = await drain(tx, async () => {
            const actual = await durableStage(tx, identity, false)
            if (actual.received !== identity.field.bytes) packedIdbInvalid()
            const chunk = await tx
              .objectStore(packedIdbStores.chunks)
              .get([identity.field.content, offset / packedIdbChunkBytes])
            if (
              chunk?.content !== identity.field.content ||
              chunk.index !== offset / packedIdbChunkBytes ||
              !packedIdbIsUint8Array(chunk.data) ||
              chunk.data.length !== Math.min(packedIdbChunkBytes, identity.field.bytes - offset) ||
              typeof chunk.sha256 !== 'string' ||
              new SHA256().update(chunk.data).digestHex() !== chunk.sha256
            )
              packedIdbInvalid()
            actualStage(this)
            return chunk.data
          })
          hash.update(data)
        }
        if (hash.digestHex() !== identity.field.sha256) packedIdbInvalid()
        const seal = identity.owner.rawTransaction([], 'readwrite')
        await drain(seal, async () => {
          const actual = await durableStage(seal, identity, false)
          if (
            actual.received !== identity.field.bytes ||
            (await seal.objectStore(packedIdbStores.chunks).index('content').count(identity.field.content)) !==
              Math.ceil(identity.field.bytes / packedIdbChunkBytes)
          )
            packedIdbInvalid()
          await seal.objectStore(packedIdbStores.contents).put({ ...actual, state: 'sealed' })
          actualStage(this)
        })
        return { ...identity.field }
      })
    })
  }
  /** Revokes admission first, drains this stage's actual operation, then makes
   * unreferenced storage eligible for finite collection. Adopted rows remain. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    const identity = stages.get(this)
    if (identity === undefined) packedIdbInvalid()
    identity.closed = true
    this.#closePromise = (async () => {
      try {
        await this.#inFlight
      } catch {
        /* The operation caller retains its error. */
      }
      if (!identity.owner.isOpen) return
      const tx = identity.owner.rawTransaction([], 'readwrite')
      await drain(tx, async () => {
        const clock = await readPackedIdbClock(tx)
        if (clock.epoch !== identity.epoch) packedIdbInvalid()
        const actual = await tx.objectStore(packedIdbStores.contents).get(identity.field.content)
        if (actual !== undefined && actual.refs === 0)
          await tx.objectStore(packedIdbStores.contents).put({ ...actual, expiresAt: Date.now(), retired: 1 })
      })
    })()
    void this.#closePromise.catch(() => {
      this.#closePromise = undefined
    })
    return this.#closePromise
  }
}

/** Called only by the real provider writer. Plain marker objects, descriptor
 * copies and a stage from another database cannot substitute for the issuer. */
export async function attachPackedIdbStages(
  owner: PackedIdbConnection,
  tx: PackedIdbTransaction<'readwrite'>,
  input: unknown,
  staged: Readonly<Record<string, PackedIdbStagedField>>,
  indexedFields: ReadonlySet<string>
): Promise<PackedIdbRow> {
  if (Object.keys(staged).length > 128) packedIdbInvalid()
  const row = await packIdbRow(tx, input, indexedFields)
  const entries = Object.entries(staged)
  if (entries.length > 128) packedIdbInvalid()
  for (const [name, stage] of entries) {
    if (
      name.length > 128 ||
      ['__proto__', 'constructor', 'prototype', '__walletPackedV1'].includes(name) ||
      indexedFields.has(name) ||
      Object.hasOwn(row.fields, name) ||
      Object.hasOwn(row.extents, name)
    )
      packedIdbInvalid()
    const identity = actualStage(stage, owner)
    await durableStage(tx, identity, true)
    if (
      (await tx.objectStore(packedIdbStores.chunks).index('content').count(identity.field.content)) !==
      Math.ceil(identity.field.bytes / packedIdbChunkBytes)
    )
      packedIdbInvalid()
    row.extents[name] = { ...identity.field }
    actualStage(stage, owner)
  }
  if (packedIdbMetadataCharge(row.fields) + Object.keys(row.extents).length * 256 > 65536) packedIdbInvalid()
  // Validate every field while its original stage is still pinned. One genuine
  // stage can supply several fields; unpinning it during the first field would
  // make the second field fail its fresh durable-stage check.
  for (let index = 0; index < entries.length; index++) {
    const [name, stage] = entries[index],
      identity = actualStage(stage, owner)
    let alreadyUnpinned = false
    for (let previous = 0; previous < index; previous++)
      if (row.extents[entries[previous][0]].content === row.extents[name].content) alreadyUnpinned = true
    if (!alreadyUnpinned) {
      const actual = await durableStage(tx, identity, true),
        { expiresAt: _expiresAt, ...unpin } = actual
      // The same actual writer immediately creates every version reference.
      // Deduplication groups data within this transaction; it grants no owner
      // or retained admission, and each actual stage is checked again below.
      await tx.objectStore(packedIdbStores.contents).put({ ...unpin, retired: actual.refs === 0 ? 1 : 0 })
    }
    actualStage(stage, owner)
  }
  return row
}
