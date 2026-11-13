import {
  Brc38IdbImportJournal,
  type Brc38IdbImportEntity,
  type Brc38IdbImportMappingRequest
} from './Brc38IdbImportJournal'
import { boundedJson, digest, type Brc38ImportJournalReceipt } from './Brc38ImportJournalContract'
import type { Brc38ImportHistoryProjection } from './Brc38IdbRestoreMetadata'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { chargeBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38IdbRestoreHistory {
  readonly projection: Readonly<Brc38ImportHistoryProjection>
  /** Drop the prepared projection before releasing its original reservation. */
  close(): void
}
// Match the established SyncMap family enumeration. These are schema DATA;
// each map batch independently reads the actual current isolated journal.
const families: readonly Brc38IdbImportEntity[] = Object.freeze([
  'provenTx',
  'outputBasket',
  'transaction',
  'provenTxReq',
  'txLabel',
  'txLabelMap',
  'output',
  'outputTag',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission'
])
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function invalid(): never {
  throw new Error('IndexedDB inactive restore history differs from its bounded preparation')
}
function* groups(values: Iterable<readonly [number, number]>): Generator<Array<readonly [number, number]>> {
  let group: Array<readonly [number, number]> = []
  for (const value of values) {
    group.push(value)
    if (group.length === 128) {
      yield group
      group = []
    }
  }
  if (group.length !== 0) yield group
}

/** Inline history preparation only: no wallet writer, source/network/proof
 * work or activation. The encrypted source owner must authenticate/replay
 * independently. Large structured history uses the separate streamed path.
 * Original JSON stays byte-identical as provenance; only operational IDs are
 * remapped. Input parse, normalization, output and live map batches all use
 * the journal's ORIGINAL shared allocation, retained until actual disposal.
 * Missing historical IDs are omitted and counted, never activated or guessed. */
export async function prepareBrc38IdbRestoreHistory(
  journal: Brc38IdbImportJournal,
  current: Readonly<Brc38ImportJournalReceipt>,
  field: 'notify' | 'syncMap',
  originalJson: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Readonly<Brc38IdbRestoreHistory>> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 65536 ||
    typeof originalJson !== 'string' ||
    originalJson.length > maximumBytes ||
    !['notify', 'syncMap'].includes(field)
  )
    invalid()
  signal?.throwIfAborted()
  const working = journal.workingAllocation
  if (working === undefined) throw new Error('IndexedDB history requires the original shared working allocation')
  // A conservative input-length ceiling admits parse storage before JSON.parse;
  // a bounded depth/value preflight below rejects unsupported decoded shapes.
  // Include simultaneously retained normalization/canonical chunks/string and
  // their temporary copies. This is explicit JS allowance, not browser RSS.
  const allowance = working.claim(8192 + 256 * originalJson.length + 32 * maximumBytes)
  try {
    const receiptSha256 = digest(boundedJson(current)),
      input = new TextEncoder().encode(originalJson)
    if (input.byteLength > maximumBytes) invalid()
    const source: unknown = JSON.parse(originalJson)
    if (!object(source)) invalid()
    chargeBrc38ImportDecodedValue(
      { maximum: 256 * originalJson.length + 4096, remaining: 256 * originalJson.length + 4096, signal },
      source
    )
    let unmappedIds = 0
    const remap = async (entity: Brc38IdbImportEntity, values: Iterable<readonly [number, number]>) => {
      const ids: Record<string, number> = Object.create(null)
      for (const group of groups(values)) {
        signal?.throwIfAborted()
        const requests: Brc38IdbImportMappingRequest[] = group.map(([, incomingId]) => ({
            entity,
            incomingId,
            required: false
          })),
          read = await journal.readMappings(receiptSha256, requests)
        try {
          for (let index = 0; index < group.length; index++) {
            const localId = read.mappings[index].localId
            if (localId === undefined) unmappedIds++
            else ids[String(group[index][0])] = localId
          }
        } finally {
          read.close()
        }
      }
      return ids
    }
    let target: Record<string, unknown>
    if (field === 'notify') {
      function* notifications(): Generator<readonly [number, number]> {
        if (!object(source) || !Array.isArray(source.transactionIds)) return
        const seen = new Set<number>()
        for (const id of source.transactionIds)
          if (typeof id === 'number' && Number.isInteger(id) && !seen.has(id)) {
            seen.add(id)
            yield [id, id]
          }
      }
      const ids = await remap('transaction', notifications())
      target = { ...source, transactionIds: [...new Set(Object.values(ids))].sort((a, b) => a - b) }
    } else {
      target = Object.create(null)
      for (const entity of families) {
        const original = source[entity],
          entry: Record<string, unknown> = { entityName: entity, count: 0 },
          normalized: Record<string, number> = Object.create(null)
        if (object(original)) {
          if (typeof original.entityName === 'string') entry.entityName = original.entityName
          if (typeof original.count === 'number' && Number.isInteger(original.count)) entry.count = original.count
          if (typeof original.maxUpdated_at === 'string') {
            const when = new Date(original.maxUpdated_at)
            if (Number.isFinite(when.getTime())) entry.maxUpdated_at = when.toISOString()
          }
          if (object(original.idMap))
            for (const key in original.idMap) {
              if (!Object.hasOwn(original.idMap, key)) continue
              const remote = Number(key),
                local = original.idMap[key]
              if (Number.isInteger(remote) && typeof local === 'number' && Number.isInteger(local))
                normalized[String(remote)] = local
            }
        }
        function* ids(): Generator<readonly [number, number]> {
          for (const key in normalized) yield [Number(key), normalized[key]]
        }
        entry.idMap = await remap(entity, ids())
        target[entity] = entry
      }
    }
    // Even a history containing no map IDs must freshly establish its current
    // checkpoint; zero batches cannot bypass actor/profile/expiry checks.
    const finalRead = await journal.readMappings(receiptSha256, [])
    finalRead.close()
    const decoder = new TextDecoder(),
      parts: string[] = []
    let bytes = 0
    for (const chunk of canonicalPortableChunks(target, {
      maximumValueBytes: Math.min(16777216, 256 * originalJson.length + 4096),
      maximumChunkBytes: Math.max(64, Math.min(4096, maximumBytes)),
      signal
    })) {
      bytes += chunk.byteLength
      if (bytes > maximumBytes)
        throw new SnapshotResourceLimitError('IndexedDB mapped history exceeds its original output ceiling')
      parts.push(decoder.decode(chunk, { stream: true }))
    }
    parts.push(decoder.decode())
    signal?.throwIfAborted()
    const projection: Brc38ImportHistoryProjection = Object.freeze({
      field,
      originalJson,
      mappedJson: parts.join(''),
      unmappedIds,
      activated: false
    })
    return Object.freeze({ projection, close: () => allowance.close() })
  } catch (cause) {
    allowance.close()
    throw cause
  }
}
