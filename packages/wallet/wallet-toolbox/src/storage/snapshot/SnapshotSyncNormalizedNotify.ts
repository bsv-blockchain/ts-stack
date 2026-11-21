import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Brc38StructuredProjectionOwners } from '../portable/Brc38StructuredProjectionOwners'
import {
  stringifyBrc38StructuredJsonSpan,
  visitBrc38StructuredJsonValues,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured,
  type Brc38StructuredJsonPolicy
} from '../portable/Brc38StructuredJson'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'

/** EntityProvenTxReq.unpackApi normalization, before any incoming ID mapping:
 * discard non-integers, retain the first occurrence and preserve its original
 * order. Keep absent/null members and all other JSON properties. Two actual
 * temporary indexes avoid a retained whole ID array or Set. This selects DATA;
 * the concrete destination still owns original source/current-row fences. */
export async function prepareSnapshotSyncNormalizedNotify(
  source: Brc38StreamedStructured,
  owners: Brc38StructuredProjectionOwners,
  selected: Brc38StructuredJsonPolicy,
  selectedIndexPolicy?: Readonly<Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]>
): Promise<
  Readonly<{
    measureChunks(): AsyncIterable<Uint8Array>
    chunks(): AsyncIterable<Uint8Array>
    close(): Promise<void>
  }>
> {
  const policy = Object.freeze({ ...selected }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    indexPolicy = selectedIndexPolicy === undefined ? undefined : Object.freeze({ ...selectedIndexPolicy })
  if (working === undefined)
    throw new Error('Notification normalization requires its original aggregate working allocation')
  if (
    indexPolicy !== undefined &&
    (indexPolicy.workingAllocation !== working ||
      indexPolicy.signal !== policy.signal ||
      !Number.isSafeInteger(indexPolicy.sourceBytes) ||
      indexPolicy.sourceBytes < source.length ||
      !Number.isSafeInteger(indexPolicy.maximumTemporaryIndexBytes) ||
      indexPolicy.maximumTemporaryIndexBytes < 1048576 ||
      !Number.isSafeInteger(indexPolicy.maximumTemporaryPhysicalBytes) ||
      indexPolicy.maximumTemporaryPhysicalBytes < indexPolicy.maximumTemporaryIndexBytes ||
      !Number.isSafeInteger(indexPolicy.maximumMembers) ||
      indexPolicy.maximumMembers < 1)
  )
    throw new RangeError('Notification normalization index policy differs from its original resource owner')
  let unique: Brc38JsonMemberIndex | undefined,
    order: Brc38JsonMemberIndex | undefined,
    replace = false,
    ordinal = 0,
    closed = false,
    measured = false,
    measurementEnded = false,
    consumed = false,
    closing: Promise<void> | undefined
  const iterators = new Set<AsyncGenerator<Uint8Array>>(),
    failures = new Set<Brc38StagingCleanupError>(),
    check = (): void => {
      policy.signal?.throwIfAborted()
      owners.check()
      if (closed) throw new Error('Notification normalization ended')
    },
    cleanup = async (): Promise<void> => {
      const causes: unknown[] = []
      for (const index of [unique, order])
        if (index !== undefined)
          try {
            await index.close()
          } catch (cause) {
            causes.push(cause)
          }
      for (const failure of failures)
        try {
          await failure.retryCleanup()
          failures.delete(failure)
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(causes, 'Notification normalization retains actual index cleanup', cleanup)
    },
    invalid = (): never => {
      throw new TypeError('Legacy notification transactionIds is not iterable')
    }
  try {
    const open = async () =>
      indexPolicy === undefined ? await source.openIndex() : await owners.openIndex(indexPolicy)
    check()
    unique = await open()
    check()
    order = await open()
    check()
    await visitBrc38StructuredJsonValues(source, policy, {
      enter: (path, kind) => {
        check()
        if (path.length === 0 && kind !== 'object') invalid()
        if (path.length === 1 && path[0] === 'transactionIds') {
          if (kind === 'array' || kind === 'string') replace = true
          else if (kind !== 'null') invalid()
        }
      },
      number: async (path, value) => {
        check()
        if (path.length === 1 && path[0] === 'transactionIds') invalid()
        if (path.length !== 2 || path[0] !== 'transactionIds' || !Number.isInteger(value)) return
        // String(-0) === String(0), matching Array.includes/SameValueZero.
        const key = String(value)
        // Pending indexes only accept writes. Their original-first-position
        // lookup is available after seal; duplicate puts retain that position.
        await unique!.put(0, { key, keyOffset: ordinal + 1, start: ordinal + 2, end: ordinal + 3 })
        ordinal++
        check()
      },
      boolean: path => {
        check()
        if (path.length === 1 && path[0] === 'transactionIds') invalid()
      }
    })
    check()
    await unique.seal()
    check()
    if (unique.lookup === undefined) throw new Error('Actual notification index requires first-value lookup')
    for await (const entry of unique.entries(0)) {
      check()
      const actual = await unique.lookup(0, entry.key)
      if (
        actual === undefined ||
        actual.key !== entry.key ||
        !Number.isSafeInteger(actual.firstKeyOffset) ||
        actual.firstKeyOffset < 1 ||
        actual.firstKeyOffset > ordinal
      )
        throw new Error('Notification first position differs')
      await order.put(0, {
        key: String(actual.firstKeyOffset).padStart(16, '0') + '/' + entry.key,
        keyOffset: 1,
        start: 2,
        end: 3
      })
    }
    check()
    await order.seal()
    check()
    const ids = async function* (width: number): AsyncGenerator<Uint8Array> {
        const allowance = working.claim(1024 + 16 * width)
        let buffer = '[',
          first = true
        try {
          for await (const row of order!.entries(0)) {
            check()
            const slash = row.key.indexOf('/'),
              value = Number(row.key.slice(slash + 1))
            if (slash !== 16 || !Number.isInteger(value) || String(value) !== row.key.slice(slash + 1))
              throw new Error('Notification order index differs')
            const part = (first ? '' : ',') + String(value)
            first = false
            if (buffer.length + part.length > width) {
              yield new TextEncoder().encode(buffer)
              buffer = ''
            }
            buffer += part
          }
          check()
          if (buffer.length === width) {
            yield new TextEncoder().encode(buffer)
            buffer = ''
          }
          yield new TextEncoder().encode(buffer + ']')
        } finally {
          buffer = ''
          allowance.close()
        }
      },
      produce = async function* (measurement: boolean): AsyncGenerator<Uint8Array> {
        try {
          check()
          for await (const bytes of stringifyBrc38StructuredJsonSpan(
            source,
            { start: 0, end: source.length },
            policy,
            undefined,
            !replace
              ? undefined
              : { member: 'transactionIds', check, chunks: ids, close: () => promiseFromSync(() => undefined) }
          )) {
            check()
            yield bytes
          }
          check()
          if (measurement) measurementEnded = true
        } finally {
          iterators.delete(output)
        }
      }
    let output: AsyncGenerator<Uint8Array>
    return Object.freeze({
      measureChunks: () => {
        check()
        if (measured || consumed) throw new Error('Notification normalization measurement already requested')
        measured = true
        output = produce(true)
        iterators.add(output)
        return output
      },
      chunks: () => {
        check()
        if (consumed || (measured && !measurementEnded))
          throw new Error('Notification normalization requires complete measurement before replay')
        consumed = true
        output = produce(false)
        iterators.add(output)
        return output
      },
      close: async () => {
        closed = true
        if (closing !== undefined) return await closing
        closing = (async () => {
          for (const iterator of iterators) await iterator.return(undefined)
          await cleanup()
        })()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    closed = true
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Notification normalization failed with retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
