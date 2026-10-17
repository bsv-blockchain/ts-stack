import type { StorageKnex } from '../StorageKnex'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativeLocalBaselinePolicy,
  type Brc38NativePriorImportRow
} from './Brc38NativeLocalBaselineSourceNode'
import { brc38NativePriorImportTables, type Brc38NativePriorImportTable } from './Brc38NativePriorImportTables'

interface IndependentRow {
  readonly rowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly field: Uint8Array | undefined
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent prior-import source case differs')
}
function equal(left: unknown, right: unknown): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array
    ? left.byteLength === right.byteLength && left.every((byte, at) => byte === right[at])
    : Object.is(left, right)
}
/** UNRUN. Independently authored real native source fixtures for all eighteen
 * families, including explicit absent/empty variants, signed physical IDs,
 * full original JSON and retained raw/canonical/projected chunks. No hashes or
 * fixture labels stand in for the actual source owner and original policy. */
export async function verifyBrc38NativePriorImportSource(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalBaselinePolicy,
  expected: Readonly<Record<Brc38NativePriorImportTable, readonly Readonly<IndependentRow>[] | null>>
): Promise<void> {
  requireCase(
    Object.keys(expected).length === 18 && brc38NativePriorImportTables.every(table => Object.hasOwn(expected, table))
  )
  const owned = policy.workingAllocation.used
  let escaped: Brc38NativeLocalBaselineSource | undefined,
    escapedRow: Readonly<Brc38NativePriorImportRow> | undefined,
    total = 0,
    logical = 0
  await Brc38NativeLocalBaselineSource.with(storage, selection, receiptPolicy, policy, async source => {
    escaped = source
    for (const table of brc38NativePriorImportTables) {
      const rows = expected[table]
      requireCase(
        rows === null ||
          (rows.length <= 16 &&
            rows.every(
              (row, at) =>
                Number.isSafeInteger(row.rowId) &&
                (at === 0 || row.rowId > rows[at - 1].rowId) &&
                Object.keys(row.metadata).length <= 32 &&
                (row.field === undefined || (row.field instanceof Uint8Array && row.field.byteLength <= 131072))
            ))
      )
      const page = await Brc38NativeLocalBaselineSource.ownedPriorImportPage(source, table, null, 16)
      requireCase(
        page.present === (rows !== null) &&
          page.rows.length === (rows?.length ?? 0) &&
          page.rows.every((id, at) => id === rows![at].rowId)
      )
      if (rows === null) continue
      for (const expectedRow of rows) {
        requireCase(++total <= 128)
        await Brc38NativeLocalBaselineSource.withOwnedPriorImportRow(source, table, expectedRow.rowId, async actual => {
          escapedRow = actual
          requireCase(
            Object.keys(actual.metadata).length === Object.keys(expectedRow.metadata).length &&
              Object.keys(expectedRow.metadata).every(name =>
                equal(actual.metadata[name], expectedRow.metadata[name])
              ) &&
              actual.field?.bytes === expectedRow.field?.byteLength
          )
          if (expectedRow.field === undefined) return
          logical += expectedRow.field.byteLength
          requireCase(logical <= 1048576)
          for (let offset = 0; offset < expectedRow.field.byteLength;) {
            const length = Math.min(997, policy.maximumReadBytes, expectedRow.field.byteLength - offset)
            let retained: Uint8Array | undefined
            await actual.withFieldExtent(offset, length, async bytes => {
              retained = bytes
              requireCase(bytes.every((byte, at) => byte === expectedRow.field![offset + at]))
            })
            requireCase(retained !== undefined && retained.every(byte => byte === 0))
            offset += length
          }
        })
      }
      if (rows.length)
        requireCase(
          (await Brc38NativeLocalBaselineSource.ownedPriorImportPage(source, table, rows[rows.length - 1].rowId, 1))
            .rows.length === 0
        )
    }
  })
  requireCase(policy.workingAllocation.used === owned && escaped !== undefined)
  let refused = false
  try {
    await Brc38NativeLocalBaselineSource.ownedPriorImportPage(escaped, 'brc38_import_journal', null, 1)
  } catch {
    refused = true
  }
  requireCase(refused)
  if (escapedRow?.field !== undefined) {
    refused = false
    try {
      await escapedRow.withFieldExtent(0, 1, async () => undefined)
    } catch {
      refused = true
    }
    requireCase(refused)
  }
}
