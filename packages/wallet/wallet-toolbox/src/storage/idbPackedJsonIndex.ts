import { awaitFromSync, mapAwaitFromSync } from '../utility/promiseFromSync'
import { getPackedIdbConnection, type PackedIdbConnection } from './idbPackedConnection'
import { requirePackedIdbSnapshotInTransaction, type PackedIdbReadSnapshot } from './idbPackedSnapshot'
import {
  chargePackedIdb,
  packedIdbIsAbortError,
  newPackedIdbId,
  packedIdbInvalid,
  packedIdbStores,
  readPackedIdbClock,
  requirePackedIdbWriter,
  type PackedIdbField,
  type PackedIdbTransaction
} from './idbPackedFields'
import type { Brc38JsonMember, Brc38JsonMemberIndex } from './portable/Brc38StructuredJson'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './portable/Brc38StagingCleanupError'

export interface PackedIdbJsonIndexLimits {
  /** Includes the fixed 512-byte stage charge. Native owner quota also applies. */
  readonly maximumBytes?: number
  readonly maximumMembers?: number
  /** Coordinates for derived multi-source sorting are DATA, not permission to
   * read another field or change this actual retained source. */
  readonly maximumSourceSpanBytes?: number
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
      /* The transaction may already be settled. */
    }
    try {
      await tx.done
    } catch (error) {
      if (error !== error_ && !packedIdbIsAbortError(error))
        throw new AggregateError([error_, error], 'Packed IndexedDB JSON index and transaction cleanup failed', {
          cause: error_
        })
    }
    throw error_
  }
}
function member(value: Record<string, unknown>, length: number): Brc38JsonMember {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    packedIdbInvalid()
  let properties = 0
  for (const name in value)
    if (Object.hasOwn(value, name)) {
      if (++properties > 10) packedIdbInvalid()
      const property = Object.getOwnPropertyDescriptor(value, name)
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) packedIdbInvalid()
    }
  if (typeof value.key !== 'string' || value.key.length > 8192) packedIdbInvalid()
  for (const name of ['keyOffset', 'start', 'end'])
    if (
      typeof value[name] !== 'number' ||
      !Number.isSafeInteger(value[name]) ||
      (value[name] as number) < 0 ||
      (value[name] as number) > length
    )
      packedIdbInvalid()
  if ((value.start as number) <= (value.keyOffset as number) || (value.end as number) <= (value.start as number))
    packedIdbInvalid()
  return {
    key: value.key,
    keyOffset: value.keyOffset as number,
    start: value.start as number,
    end: value.end as number
  }
}
/** Native IndexedDB reads return structured-cloned DATA. Copy only bounded own
 * data properties into this realm before applying the same member validator.
 * Caller-supplied members still require the original local plain prototype;
 * this conversion is never used for snapshot/connection/transaction authority. */
function storedMember(value: Record<string, unknown>, length: number): Brc38JsonMember {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) packedIdbInvalid()
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let properties = 0
  for (const name in value)
    if (Object.hasOwn(value, name)) {
      if (++properties > 10) packedIdbInvalid()
      const property = Object.getOwnPropertyDescriptor(value, name)
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) packedIdbInvalid()
      data[name] = property.value as unknown
    }
  return member(data, length)
}
/** Temporary external sort attached to the actual owner's actual live MVCC
 * snapshot. Its stored spans/digest are data; factory membership never replaces
 * current profile/primary/schema/lease checks. It cannot be reopened after
 * close/expiry or cloned to another connection. */
export class PackedIdbJsonIndex implements Brc38JsonMemberIndex {
  readonly #id = newPackedIdbId()
  readonly #owner: PackedIdbConnection
  readonly #view: PackedIdbReadSnapshot
  readonly #field: Readonly<PackedIdbField>
  readonly #limits: Readonly<{ maximumBytes: number; maximumMembers: number; maximumSourceSpanBytes: number }>
  #epoch = ''
  #closed = false
  #busy = false
  #inFlight?: Promise<unknown>
  #closePromise?: Promise<void>
  private constructor(
    owner: PackedIdbConnection,
    view: PackedIdbReadSnapshot,
    field: PackedIdbField,
    limits: Readonly<{ maximumBytes: number; maximumMembers: number; maximumSourceSpanBytes: number }>
  ) {
    this.#owner = owner
    this.#view = view
    this.#field = Object.freeze({ ...field })
    this.#limits = limits
  }
  static async open(
    owner: PackedIdbConnection,
    view: PackedIdbReadSnapshot,
    field: PackedIdbField,
    selected: PackedIdbJsonIndexLimits = {}
  ): Promise<PackedIdbJsonIndex> {
    const limits = Object.freeze({
      maximumBytes: selected.maximumBytes ?? 2000000512,
      maximumMembers: selected.maximumMembers ?? 2000000000,
      maximumSourceSpanBytes: selected.maximumSourceSpanBytes ?? field.bytes
    })
    if (
      !Number.isSafeInteger(limits.maximumBytes) ||
      limits.maximumBytes < 512 ||
      limits.maximumBytes > 17179869184 ||
      !Number.isSafeInteger(limits.maximumMembers) ||
      limits.maximumMembers < 1 ||
      limits.maximumMembers > 2000000000 ||
      !Number.isSafeInteger(limits.maximumSourceSpanBytes) ||
      limits.maximumSourceSpanBytes < field.bytes ||
      limits.maximumSourceSpanBytes > 1000000000
    )
      packedIdbInvalid()
    if (
      getPackedIdbConnection(owner.database) !== owner ||
      !owner.isOpen ||
      field.kind !== 'utf16' ||
      !Number.isSafeInteger(field.bytes) ||
      field.bytes < 2 ||
      field.bytes > 1000000000 ||
      field.bytes % 2 !== 0 ||
      !/^[0-9a-f]{32}$/.test(field.content) ||
      !/^[0-9a-f]{64}$/.test(field.sha256)
    )
      packedIdbInvalid()
    const result = new PackedIdbJsonIndex(owner, view, field, limits),
      tx = owner.rawTransaction(['settings', 'users'], 'readwrite')
    await drain(tx, async () => {
      await requirePackedIdbSnapshotInTransaction(view, owner, tx)
      const clock = await readPackedIdbClock(tx)
      result.#epoch = clock.epoch
      await chargePackedIdb(tx, 512, 1)
      await tx.objectStore(packedIdbStores.jsonStages).add({
        id: result.#id,
        epoch: clock.epoch,
        lease: view.snapshotId,
        expiresAt: view.expiresAt,
        state: 'pending',
        content: field.content,
        sourceBytes: field.bytes,
        sha256: field.sha256,
        members: 0,
        bytes: 0,
        maximumBytes: limits.maximumBytes,
        maximumMembers: limits.maximumMembers,
        spanBytes: limits.maximumSourceSpanBytes
      })
      await requirePackedIdbSnapshotInTransaction(view, owner, tx)
    })
    return result
  }
  private async fresh(tx: PackedIdbTransaction, state: 'pending' | 'sealed'): Promise<Record<string, unknown>> {
    if (this.#closed || !this.#owner.isOpen) packedIdbInvalid()
    await requirePackedIdbSnapshotInTransaction(this.#view, this.#owner, tx)
    const clock = await readPackedIdbClock(tx),
      stage = await tx.objectStore(packedIdbStores.jsonStages).get(this.#id)
    if (
      clock.epoch !== this.#epoch ||
      stage?.epoch !== this.#epoch ||
      stage.id !== this.#id ||
      stage.lease !== this.#view.snapshotId ||
      stage.expiresAt !== this.#view.expiresAt ||
      stage.state !== state ||
      stage.content !== this.#field.content ||
      stage.sourceBytes !== this.#field.bytes ||
      stage.sha256 !== this.#field.sha256 ||
      stage.maximumMembers !== this.#limits.maximumMembers ||
      stage.maximumBytes !== this.#limits.maximumBytes ||
      stage.spanBytes !== this.#limits.maximumSourceSpanBytes ||
      typeof stage.members !== 'number' ||
      !Number.isSafeInteger(stage.members) ||
      stage.members < 0 ||
      stage.members > this.#limits.maximumMembers ||
      typeof stage.bytes !== 'number' ||
      !Number.isSafeInteger(stage.bytes) ||
      stage.bytes < 0 ||
      stage.bytes > this.#limits.maximumBytes - 512
    )
      packedIdbInvalid()
    return stage
  }
  private async operation<T>(
    mode: 'readonly' | 'readwrite',
    state: 'pending' | 'sealed',
    run: (tx: PackedIdbTransaction, stage: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    if (this.#closed || this.#busy) packedIdbInvalid()
    this.#busy = true
    try {
      const tx = this.#owner.rawTransaction(['settings', 'users'], mode)
      const work = drain(tx, async () => {
        const stage = await this.fresh(tx, state),
          result = await run(tx, stage)
        await requirePackedIdbSnapshotInTransaction(this.#view, this.#owner, tx)
        if (this.#closed) packedIdbInvalid()
        return result
      })
      this.#inFlight = work
      return await work
    } finally {
      this.#busy = false
      this.#inFlight = undefined
    }
  }
  async put(objectOffset: number, selected: Brc38JsonMember): Promise<void> {
    const value = member(selected as unknown as Record<string, unknown>, this.#limits.maximumSourceSpanBytes)
    if (!Number.isSafeInteger(objectOffset) || objectOffset < 0 || objectOffset >= value.keyOffset) packedIdbInvalid()
    const bytes = 256 + value.key.length * 2
    await this.operation('readwrite', 'pending', async (tx, stage) => {
      const writer = requirePackedIdbWriter(tx),
        store = writer.objectStore(packedIdbStores.jsonMembers),
        key = [this.#id, objectOffset, value.key],
        prior = await store.get(key)
      const priorValue = prior === undefined ? undefined : storedMember(prior, this.#limits.maximumSourceSpanBytes),
        oldBytes = priorValue === undefined ? 0 : 256 + priorValue.key.length * 2
      if (
        prior !== undefined &&
        (prior.stage !== this.#id ||
          prior.objectOffset !== objectOffset ||
          prior.charge !== oldBytes ||
          typeof prior.firstKeyOffset !== 'number' ||
          !Number.isSafeInteger(prior.firstKeyOffset) ||
          prior.firstKeyOffset <= objectOffset ||
          prior.firstKeyOffset > priorValue!.keyOffset)
      )
        packedIdbInvalid()
      const count = prior === undefined ? 1 : 0
      if (
        count > this.#limits.maximumMembers - (stage.members as number) ||
        bytes - oldBytes > this.#limits.maximumBytes - 512 - (stage.bytes as number)
      )
        throw new SnapshotResourceLimitError('Packed JSON index exceeds its original member/byte allowance')
      await chargePackedIdb(tx, bytes - oldBytes, count)
      const firstKeyOffset =
        prior === undefined ? value.keyOffset : Math.min(prior.firstKeyOffset as number, value.keyOffset)
      await store.put({ stage: this.#id, objectOffset, ...value, charge: bytes, firstKeyOffset })
      await writer.objectStore(packedIdbStores.jsonStages).put({
        ...stage,
        members: (stage.members as number) + count,
        bytes: (stage.bytes as number) + bytes - oldBytes
      })
    })
  }
  async seal(): Promise<void> {
    await this.operation('readwrite', 'pending', async (tx, stage) => {
      const writer = requirePackedIdbWriter(tx)
      if ((await tx.objectStore(packedIdbStores.jsonMembers).index('stage').count(this.#id)) !== stage.members)
        packedIdbInvalid()
      await writer.objectStore(packedIdbStores.jsonStages).put({ ...stage, state: 'sealed' })
    })
  }
  lookup(
    objectOffset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined> {
    return awaitFromSync(() => {
      if (
        !Number.isSafeInteger(objectOffset) ||
        objectOffset < 0 ||
        objectOffset >= this.#limits.maximumSourceSpanBytes ||
        typeof key !== 'string' ||
        key.length > 8192
      )
        packedIdbInvalid()
      return this.operation('readonly', 'sealed', tx =>
        mapAwaitFromSync(
          () => tx.objectStore(packedIdbStores.jsonMembers).get([this.#id, objectOffset, key]),
          row => {
            if (row === undefined) return undefined
            const value = storedMember(row, this.#limits.maximumSourceSpanBytes)
            if (
              row.stage !== this.#id ||
              row.objectOffset !== objectOffset ||
              row.key !== key ||
              row.charge !== 256 + key.length * 2 ||
              typeof row.firstKeyOffset !== 'number' ||
              !Number.isSafeInteger(row.firstKeyOffset) ||
              row.firstKeyOffset <= objectOffset ||
              row.firstKeyOffset > value.keyOffset
            )
              packedIdbInvalid()
            return Object.freeze({ ...value, firstKeyOffset: row.firstKeyOffset })
          }
        )
      )
    })
  }
  /** One keyset member in one short owned read; no native cursor survives
   * this return. The original stage/view/expiry/content checks repeat. */
  nextEntry(objectOffset: number, after?: string): Promise<Brc38JsonMember | undefined> {
    return awaitFromSync(() => {
      if (
        !Number.isSafeInteger(objectOffset) ||
        objectOffset < 0 ||
        objectOffset >= this.#limits.maximumSourceSpanBytes ||
        (after !== undefined && (typeof after !== 'string' || after.length > 8192))
      )
        packedIdbInvalid()
      return this.operation('readonly', 'sealed', async tx => {
        const range = IDBKeyRange.bound(
            after === undefined ? [this.#id, objectOffset] : [this.#id, objectOffset, after],
            [this.#id, objectOffset, []],
            after !== undefined
          ),
          cursor = await tx.objectStore(packedIdbStores.jsonMembers).openCursor(range)
        if (cursor === null) return undefined
        const row = cursor.value,
          item = storedMember(row, this.#limits.maximumSourceSpanBytes)
        if (
          row.stage !== this.#id ||
          row.objectOffset !== objectOffset ||
          row.charge !== 256 + item.key.length * 2 ||
          (after !== undefined && item.key <= after)
        )
          packedIdbInvalid()
        return item
      })
    })
  }
  async *entries(objectOffset: number): AsyncGenerator<Brc38JsonMember> {
    if (!Number.isSafeInteger(objectOffset) || objectOffset < 0 || objectOffset >= this.#limits.maximumSourceSpanBytes)
      packedIdbInvalid()
    let after: string | undefined,
      done = false
    while (!done) {
      const page = await this.operation('readonly', 'sealed', async tx => {
        const range = IDBKeyRange.bound(
          after === undefined ? [this.#id, objectOffset] : [this.#id, objectOffset, after],
          [this.#id, objectOffset, []],
          after !== undefined
        )
        let cursor = await tx.objectStore(packedIdbStores.jsonMembers).openCursor(range)
        const rows: Brc38JsonMember[] = []
        while (cursor !== null && rows.length < 4) {
          const value = cursor.value,
            item = storedMember(value, this.#limits.maximumSourceSpanBytes)
          if (
            value.stage !== this.#id ||
            value.objectOffset !== objectOffset ||
            value.charge !== 256 + item.key.length * 2 ||
            (after !== undefined && item.key <= after)
          )
            packedIdbInvalid()
          rows.push(item)
          cursor = await cursor.continue()
        }
        return { rows, done: cursor === null }
      })
      done = page.done
      for (const item of page.rows) {
        if (this.#closed || !this.#view.isOpen) packedIdbInvalid()
        after = item.key
        yield item
      }
    }
  }
  /** Revoke first and drain current work, then retire THIS actual index in
   * finite 128-record writers. A 30-second cleanup attempt cannot renew source
   * authority; failure retains a concrete retry until physical rows/charges
   * are gone. Unrelated expired indexes cannot starve this cleanup. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#closePromise = (async () => {
      const wall = Date.now() + 30000,
        monotonic = performance.now() + 30000
      try {
        try {
          await this.#inFlight
        } catch {
          /* Original caller retains its failure. */
        }
        let rounds = 0,
          maximumRounds: number | undefined
        for (;;) {
          if (!this.#owner.isOpen || getPackedIdbConnection(this.#owner.database) !== this.#owner) packedIdbInvalid()
          if (Date.now() >= wall || performance.now() >= monotonic)
            throw new SnapshotResourceLimitError('Packed JSON index cleanup attempt reached its original deadline')
          const tx = this.#owner.rawTransaction([], 'readwrite'),
            remaining = await drain(tx, async () => {
              const clock = await readPackedIdbClock(tx),
                stages = tx.objectStore(packedIdbStores.jsonStages)
              if (clock.epoch !== this.#epoch) packedIdbInvalid()
              const stage = await stages.get(this.#id)
              if (stage === undefined) return false
              if (
                stage.id !== this.#id ||
                stage.epoch !== this.#epoch ||
                stage.lease !== this.#view.snapshotId ||
                typeof stage.expiresAt !== 'number' ||
                !Number.isSafeInteger(stage.expiresAt) ||
                (stage.state !== 'retiring' && stage.expiresAt !== this.#view.expiresAt) ||
                stage.content !== this.#field.content ||
                stage.sourceBytes !== this.#field.bytes ||
                stage.sha256 !== this.#field.sha256 ||
                stage.maximumBytes !== this.#limits.maximumBytes ||
                stage.maximumMembers !== this.#limits.maximumMembers ||
                stage.spanBytes !== this.#limits.maximumSourceSpanBytes ||
                typeof stage.members !== 'number' ||
                !Number.isSafeInteger(stage.members) ||
                stage.members < 0 ||
                stage.members > this.#limits.maximumMembers ||
                typeof stage.bytes !== 'number' ||
                !Number.isSafeInteger(stage.bytes) ||
                stage.bytes < 0 ||
                stage.bytes > this.#limits.maximumBytes - 512
              )
                packedIdbInvalid()
              maximumRounds ??= Math.ceil(stage.members / 128) + 1
              if (++rounds > maximumRounds) packedIdbInvalid()
              if (stage.state !== 'retiring') {
                if (!['pending', 'sealed'].includes(stage.state as string)) packedIdbInvalid()
                await stages.put({ ...stage, state: 'retiring', expiresAt: Date.now() })
              }
              const removed = await collectPackedIdbJsonIndexes(tx, 128, this.#id),
                after = await stages.get(this.#id)
              if (after !== undefined && (removed < 1 || after.members !== stage.members - removed)) packedIdbInvalid()
              return after !== undefined
            })
          if (!remaining) return
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed JSON index retains physical temporary rows and charges until actual bounded cleanup',
          () => this.close()
        )
      }
    })()
    void this.#closePromise.catch(() => {
      this.#closePromise = undefined
    })
    return this.#closePromise
  }
}
/** One expired index, at most the caller's finite member budget. Charges are
 * released with each actual deletion; no browser filesystem-reclamation claim. */
export async function collectPackedIdbJsonIndexes(
  tx: PackedIdbTransaction,
  maximum = 128,
  selectedId?: string
): Promise<number> {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 256 ||
    tx.mode !== 'readwrite' ||
    (selectedId !== undefined && !/^[0-9a-f]{32}$/.test(selectedId))
  )
    packedIdbInvalid()
  const writer = requirePackedIdbWriter(tx),
    clock = await readPackedIdbClock(tx),
    stages = writer.objectStore(packedIdbStores.jsonStages),
    stage =
      selectedId === undefined
        ? (await stages.index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now())))?.value
        : await stages.get(selectedId)
  if (stage === undefined) return 0
  if (
    typeof stage.id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(stage.id) ||
    (selectedId !== undefined && stage.id !== selectedId) ||
    stage.epoch !== clock.epoch ||
    typeof stage.lease !== 'string' ||
    !/^[0-9a-f]{32}$/.test(stage.lease) ||
    typeof stage.content !== 'string' ||
    !/^[0-9a-f]{32}$/.test(stage.content) ||
    typeof stage.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stage.sha256) ||
    !['pending', 'sealed', 'retiring'].includes(stage.state as string) ||
    typeof stage.expiresAt !== 'number' ||
    !Number.isSafeInteger(stage.expiresAt) ||
    stage.expiresAt > Date.now() ||
    typeof stage.maximumMembers !== 'number' ||
    !Number.isSafeInteger(stage.maximumMembers) ||
    stage.maximumMembers < 1 ||
    stage.maximumMembers > 2000000000 ||
    typeof stage.maximumBytes !== 'number' ||
    !Number.isSafeInteger(stage.maximumBytes) ||
    stage.maximumBytes < 512 ||
    stage.maximumBytes > 17179869184 ||
    typeof stage.members !== 'number' ||
    !Number.isSafeInteger(stage.members) ||
    stage.members < 0 ||
    stage.members > stage.maximumMembers ||
    typeof stage.bytes !== 'number' ||
    !Number.isSafeInteger(stage.bytes) ||
    stage.bytes < 0 ||
    typeof stage.sourceBytes !== 'number' ||
    stage.bytes > stage.maximumBytes - 512 ||
    !Number.isSafeInteger(stage.sourceBytes) ||
    stage.sourceBytes < 2 ||
    stage.sourceBytes > 1000000000 ||
    stage.sourceBytes % 2 !== 0 ||
    typeof stage.spanBytes !== 'number' ||
    !Number.isSafeInteger(stage.spanBytes) ||
    stage.spanBytes < stage.sourceBytes ||
    stage.spanBytes > 1000000000
  )
    packedIdbInvalid()
  let cursor = await writer.objectStore(packedIdbStores.jsonMembers).index('stage').openCursor(stage.id),
    removed = 0,
    bytes = 0
  while (cursor !== null && removed < maximum) {
    const item = storedMember(cursor.value, stage.spanBytes),
      charge = 256 + item.key.length * 2
    if (cursor.value.stage !== stage.id || cursor.value.charge !== charge) packedIdbInvalid()
    await cursor.delete()
    await chargePackedIdb(tx, -charge, -1)
    bytes += charge
    removed++
    cursor = await cursor.continue()
  }
  const remaining = (stage.members as number) - removed,
    retainedBytes = (stage.bytes as number) - bytes
  if (remaining < 0 || retainedBytes < 0) packedIdbInvalid()
  if (cursor === null) {
    if (remaining !== 0 || retainedBytes !== 0) packedIdbInvalid()
    await stages.delete(stage.id)
    await chargePackedIdb(tx, -512, -1)
  } else await stages.put({ ...stage, state: 'retiring', members: remaining, bytes: retainedBytes })
  return removed
}
