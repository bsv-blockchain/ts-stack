import type { Knex } from 'knex'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { brc38ImportTableOrder } from './Brc38ImportPage'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { requireBrc38StructuredProjectionRead } from './Brc38PublishedStructuredSourceNode'
import type { Brc38StructuredNativeFieldInventoryPolicy } from './Brc38StructuredNativeFieldInventoryNode'
import { inspectBrc38StructuredNativeRestoreInventory } from './Brc38StreamedNativeInventoryNode'

/** Authored UNRUN. A fresh packaged native controller must construct its
 * independent all13 completed fixture with the original 64KiB admission,
 * authenticated source, destination and retained read-only actor. Shared
 * current index/grammar/projection/transport/journal and metadata-scope
 * admission replaces the former unconditional 256KiB safety reservation.
 * This oracle grants no source/import admission, does not substitute for
 * independent fixture construction and supplies no qualification evidence. */
export async function verifyOriginal64KiBNativeInventoryOracle(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'private' | 'published-native' | 'published-copy',
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  selected: Readonly<{
    tableCounts: Readonly<Record<Brc38StageTable, number>>
    rows: number
    mappedIds: number
    binaryBytes: number
  }>,
  assertCurrent: () => void
): Promise<void> {
  return await verifyInitialNativeInventoryOracle(k, admission, runtime, policy, selected, assertCurrent, 65536)
}

/** Separate measured128KiB initial admission. Original64KiB reference remains exact. */
export async function verifyMeasured128KiBNativeInventoryOracle(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'private' | 'published-native' | 'published-copy',
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  selected: Readonly<{
    tableCounts: Readonly<Record<Brc38StageTable, number>>
    rows: number
    mappedIds: number
    binaryBytes: number
  }>,
  assertCurrent: () => void
): Promise<void> {
  return await verifyInitialNativeInventoryOracle(k, admission, runtime, policy, selected, assertCurrent, 131072)
}

async function verifyInitialNativeInventoryOracle(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'private' | 'published-native' | 'published-copy',
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  selected: Readonly<{
    tableCounts: Readonly<Record<Brc38StageTable, number>>
    rows: number
    mappedIds: number
    binaryBytes: number
  }>,
  assertCurrent: () => void,
  originalAllocationBytes: 65536 | 131072
): Promise<void> {
  requireBrc38StructuredProjectionRead(k)
  const limits = JSON.parse(admission.originalLimitsJson) as unknown,
    expected = Object.freeze({
      rows: selected.rows,
      mappedIds: selected.mappedIds,
      binaryBytes: selected.binaryBytes,
      tableCounts: Object.freeze(
        Object.fromEntries(brc38ImportTableOrder.map(table => [table, selected.tableCounts[table]]))
      )
    }),
    window = policy.sourcePolicy.maximumReadBytes
  if (
    !Array.isArray(limits) ||
    limits.length !== 6 ||
    limits[4] !== originalAllocationBytes ||
    window === undefined ||
    !Number.isSafeInteger(window) ||
    window < 64 ||
    window > 1024 ||
    ![expected.rows, expected.mappedIds, expected.binaryBytes].every(
      value => Number.isSafeInteger(value) && value >= 0
    ) ||
    brc38ImportTableOrder.some(
      table => !Number.isSafeInteger(expected.tableCounts[table]) || expected.tableCounts[table] < 1
    ) ||
    brc38ImportTableOrder.reduce((total, table) => total + expected.tableCounts[table], 1) !== expected.rows
  )
    throw new RangeError('Independent all13 original allocation and explicit transfer window required')
  let transfers = 0
  const observe = (response: unknown): void => {
    for (const row of Array.isArray(response) ? response : [response]) {
      if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'payload')) continue
      const payload = (row as { payload: unknown }).payload
      // Metadata payloads are separately byte-preflighted by the inventory.
      // Observe actual native BLOB transfers without treating descriptors or
      // observer flags as positive resource/physical-memory evidence.
      if (!(payload instanceof Uint8Array)) continue
      if (payload.byteLength > window) throw new Error('Native all13 inventory exceeded its original transfer window')
      transfers++
    }
  }
  k.on('query-response', observe)
  try {
    assertCurrent()
    const actual = await inspectBrc38StructuredNativeRestoreInventory(
      k,
      admission,
      runtime,
      policy,
      policy.sourcePolicy.signal
    )
    if (
      actual.rows !== expected.rows ||
      actual.mappedIds !== expected.mappedIds ||
      actual.binaryBytes !== expected.binaryBytes ||
      (expected.binaryBytes > 0 && transfers === 0)
    )
      throw new Error('Independent all13 native inventory oracle differs')
    for (const table of brc38ImportTableOrder) {
      assertCurrent()
      requireBrc38StructuredProjectionRead(k)
      const count = (await k('table_counts').where({ tableName: table }).first('rows')) as { rows: unknown } | undefined
      if (count?.rows !== expected.tableCounts[table]) throw new Error('Independent all13 source fixture count differs')
    }
    if (JSON.parse(admission.originalLimitsJson)[4] !== originalAllocationBytes)
      throw new Error('Original inventory allocation was renewed')
    assertCurrent()
  } finally {
    k.removeListener('query-response', observe)
  }
}
