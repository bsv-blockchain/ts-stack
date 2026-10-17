import type { StorageKnex } from '../StorageKnex'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import {
  Brc38NativeLocalBaselineSource,
  brc38NativeLocalBaselineTables,
  type Brc38NativeLocalBaselinePolicy,
  type Brc38NativeLocalBaselineRow,
  type Brc38NativeLocalBaselineTable
} from './Brc38NativeLocalBaselineSourceNode'

interface IndependentRow {
  readonly rowId: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly fields: Readonly<Record<string, Uint8Array | null>>
}
function comparable(value: unknown): string {
  const normalized = (cell: unknown): unknown => {
    if (typeof cell === 'bigint') return { sqliteInteger: cell.toString() }
    if (cell instanceof Uint8Array) return { sqliteBlob: Buffer.from(cell).toString('hex') }
    if (Array.isArray(cell)) return cell.map(normalized)
    if (cell !== null && typeof cell === 'object')
      return Object.fromEntries(
        Object.entries(cell)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalized(item)])
      )
    return cell
  }
  return JSON.stringify(normalized(value))
}
/** UNRUN actual-source case. The controller supplies independently populated
 * all48-table native fixtures, including exact signed INTEGER metadata and
 * separate large-field bytes. No expected row is derived from the source under
 * test. This qualifies the reader only, not baseline copy/primary activation. */
export async function verifyBrc38NativeLocalBaselineSource(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalBaselinePolicy,
  fixtures: Readonly<Record<Brc38NativeLocalBaselineTable, readonly IndependentRow[]>>
): Promise<void> {
  let escaped: Brc38NativeLocalBaselineSource | undefined,
    escapedRow: Readonly<Brc38NativeLocalBaselineRow> | undefined,
    totalExpectedBytes = 0,
    owned = policy.workingAllocation.used
  for (const table of brc38NativeLocalBaselineTables) {
    const rows = fixtures[table]
    if (!Array.isArray(rows) || rows.length > 128) throw new Error('Independent all48 local row fixture required')
    for (const row of rows) {
      if (!Number.isSafeInteger(row.rowId)) throw new Error('Independent signed physical rowid required')
      for (const bytes of Object.values(row.fields)) {
        if (bytes !== null && !(bytes instanceof Uint8Array)) throw new Error('Independent local field bytes required')
        totalExpectedBytes += bytes?.byteLength ?? 0
      }
    }
  }
  if (totalExpectedBytes > 1048576) throw new Error('Local source case exceeds its independent finite fixture budget')
  await Brc38NativeLocalBaselineSource.with(storage, selection, receiptPolicy, policy, async source => {
    escaped = source
    for (const table of brc38NativeLocalBaselineTables) {
      const expected = [...fixtures[table]].sort((a, b) => a.rowId - b.rowId)
      let after: number | null = null,
        next = 0
      for (;;) {
        const page = await source.page(table, after, 3)
        if (page.length === 0) break
        for (const rowId of page) {
          const row = expected[next++]
          if (row === undefined || row.rowId !== rowId)
            throw new Error('Native local keyset lost or substituted a physical row')
          await source.withRow(table, rowId, async actual => {
            if (actual.fields.some(field => field.bytes !== null && field.bytes > 0)) escapedRow = actual
            if (
              comparable(actual.metadata) !== comparable(row.metadata) ||
              comparable(actual.fields.map(field => field.field).sort((a, b) => Number(a > b) - Number(a < b))) !==
                comparable(Object.keys(row.fields).sort((a, b) => Number(a > b) - Number(a < b)))
            )
              throw new Error('Complete local row metadata or separate field inventory differs')
            for (const field of actual.fields) {
              const bytes = row.fields[field.field]
              if (field.bytes !== (bytes?.byteLength ?? null))
                throw new Error('Local field length lost null/empty/original bytes')
              if (bytes === null) continue
              for (let offset = 0; offset < bytes.byteLength;) {
                const length = Math.min(997, policy.maximumReadBytes, bytes.byteLength - offset)
                let retained: Uint8Array | undefined
                await actual.withFieldExtent(field.field, offset, length, async chunk => {
                  retained = chunk
                  for (let at = 0; at < length; at++)
                    if (chunk[at] !== bytes[offset + at])
                      throw new Error('Actual local baseline field differs from the independent fixture')
                })
                if (retained === undefined || retained.some(byte => byte !== 0))
                  throw new Error('Local source field retained transport bytes')
                offset += length
              }
            }
          })
          after = rowId
        }
      }
      if (next !== expected.length) throw new Error('Local table keyset omitted an independent row')
    }
  })
  if (policy.workingAllocation.used !== owned || escaped === undefined)
    throw new Error('Local source cleanup retained a working reservation')
  let refused = false
  try {
    await escaped.page('users', null, 1)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('Escaped local source reacquired a closed native snapshot')
  if (escapedRow !== undefined && escapedRow.fields.some(field => field.bytes !== null && field.bytes > 0)) {
    const field = escapedRow.fields.find(value => value.bytes !== null && value.bytes > 0)!
    refused = false
    try {
      await escapedRow.withFieldExtent(field.field, 0, 1, async () => undefined)
    } catch {
      refused = true
    }
    if (!refused) throw new Error('Escaped local row reacquired a closed field source')
  }
}

/** UNRUN genuine WAL-source race case. One independent actual core, pending,
 * auxiliary, payload-pointer or primary mutation commits through the original
 * enrolled root while the retained source snapshot remains open. Call this on
 * separately created fixtures for each variant. The old snapshot must remain
 * coherent, while inspectCurrent reads the newer actual LIVE generation and
 * refuses to report that snapshot as current. A fake mutation/actor is invalid. */
export async function verifyBrc38NativeLocalCurrentSource(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalBaselinePolicy,
  mutateLive: () => Promise<void>
): Promise<void> {
  const working = policy.workingAllocation.used
  let escaped: Brc38NativeLocalBaselineSource | undefined
  await Brc38NativeLocalBaselineSource.with(storage, selection, receiptPolicy, policy, async source => {
    escaped = source
    const original = await Brc38NativeLocalBaselineSource.facts(source),
      first = await Brc38NativeLocalBaselineSource.inspectCurrent(source)
    if (
      !first.current ||
      comparable(first.fence) !== comparable(original.fence) ||
      comparable(first.generation) !== comparable(original.generation)
    )
      throw new Error('Actual live source initially differs from its independently retained source')
    await mutateLive()
    const retained = await Brc38NativeLocalBaselineSource.facts(source),
      actual = await Brc38NativeLocalBaselineSource.inspectCurrent(source)
    if (
      actual.current ||
      comparable(retained) !== comparable(original) ||
      actual.generation.epoch !== original.generation.epoch ||
      BigInt(actual.generation.revision) <= BigInt(original.generation.revision)
    )
      throw new Error(
        'Fresh actual source writer reused the retained old snapshot or missed a committed all48 mutation'
      )
    let committed = false
    const refused = await Brc38NativeLocalBaselineSource.withCurrentDataFence(source, async () => {
      committed = true
    })
    if (refused.current || committed)
      throw new Error('Changed live source admitted a destination commit from an old retained snapshot')
  })
  if (policy.workingAllocation.used !== working || escaped === undefined)
    throw new Error('Actual current-source inspection retained its allocation')
  let refused = false
  try {
    await Brc38NativeLocalBaselineSource.inspectCurrent(escaped)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('Escaped source acquired a live root writer after its actual source lease closed')
}

interface ActualCurrentCommitController {
  /** Perform ONE prepared bounded commit through a distinct actual destination
   * owner. In that callback attempt an independent source WAL writer with
   * busy_timeout=0, prove SQLITE_BUSY, then commit and physically drain the
   * destination. Never substitute a mocked writer/fence or a sleep timer. */
  commitWhileSourceWriterHeld(): Promise<string>
  /** A real source mutation after the root reservation has drained. */
  mutateAfterFence(): Promise<void>
  readDestinationReceipt(): Promise<string>
  check(): void
}
/** UNRUN retained current-data exclusion, actual destination commit and stale
 * snapshot refusal. A source writer may run after the scope drains, but cannot
 * cross the original root reservation while the destination commit runs. */
export async function verifyBrc38NativeLocalCurrentCommitFence(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalBaselinePolicy,
  controller: ActualCurrentCommitController
): Promise<void> {
  const working = policy.workingAllocation.used
  let escaped: Brc38NativeLocalBaselineSource | undefined,
    calls = 0
  await Brc38NativeLocalBaselineSource.with(storage, selection, receiptPolicy, policy, async source => {
    escaped = source
    const result = await Brc38NativeLocalBaselineSource.withCurrentDataFence(source, async () => {
      calls++
      controller.check()
      return await controller.commitWhileSourceWriterHeld()
    })
    if (!result.current || calls !== 1 || result.value !== (await controller.readDestinationReceipt()))
      throw new Error('Actual current source exclusion or destination commit receipt differs')
    await controller.mutateAfterFence()
    const changed = await Brc38NativeLocalBaselineSource.withCurrentDataFence(source, async () => {
      calls++
      return 'forbidden'
    })
    if (changed.current || calls !== 1) throw new Error('A fresh stale-source fence ran destination work')
  })
  if (policy.workingAllocation.used !== working || escaped === undefined)
    throw new Error('Current source commit fence did not drain')
  let refused = false
  try {
    await Brc38NativeLocalBaselineSource.withCurrentDataFence(escaped, async () => {
      calls++
      return 'forbidden'
    })
  } catch {
    refused = true
  }
  if (!refused || calls !== 1) throw new Error('Escaped current source acquired commit exclusion after close')
  controller.check()
}
