import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Knex } from 'knex'
import { readBrc38NativeLocalFieldBytes, withBrc38NativeLocalFieldExtent } from './Brc38NativeLocalFieldReadNode'
import type { Brc38NativeLocalFieldCoordinate } from './Brc38NativeLocalFieldProtocol'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

/** UNRUN. A finite controller supplies its actual retained native source and
 * independently constructed fixture bytes for all eighteen local field cells.
 * This exercises real metadata, native framing, scoped accounting and wipe;
 * it does not establish coherent baseline-copy or activation acceptance. */
export async function verifyBrc38NativeLocalFieldReads(
  trx: Knex.Transaction,
  fixtures: readonly Readonly<{ coordinate: Brc38NativeLocalFieldCoordinate; expected: Uint8Array | null }>[],
  expiresAt: number
): Promise<void> {
  if (
    fixtures.length !== 18 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 120000
  )
    throw new Error('Independent finite local field fixtures required')
  const expectedCells = new Set([
      'prepared_beefs.beef',
      'action_batch_blobs.bytes',
      'sync_transfer_parts.bytes',
      'action_batches.uploadDigests',
      'action_batches.result',
      'action_batches.manifest',
      'sync_transfers.result',
      'monitor_events.details',
      'snapshot_reconciliation_stage_pages.payload',
      'snapshot_reconciliation_provenance.payload',
      'brc38_import_original.originalJson',
      'brc38_import_streamed_original.originalJson',
      'brc38_import_structured_original.originalJson',
      'private_binary_chunks.payload',
      'private_text_chunks.payload',
      'private_structured_chunks.payload',
      'private_canonical_structured_chunks.payload',
      'private_projected_structured_chunks.payload'
    ]),
    working = new Brc38WorkingAllocation(1048576),
    deadline = performance.now() + expiresAt - Date.now(),
    check = (): void => {
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Local field case reached its original deadline')
    }
  for (const fixture of fixtures) {
    const coordinate = Object.freeze({ ...fixture.coordinate }),
      key = coordinate.table + '.' + coordinate.field,
      expected = fixture.expected
    if (
      !expectedCells.delete(key) ||
      (expected !== null && (expected.byteLength > 131072 || !(expected instanceof Uint8Array)))
    )
      throw new Error('Independent local field fixture differs')
    check()
    if ((await readBrc38NativeLocalFieldBytes(trx, coordinate)) !== (expected?.byteLength ?? null))
      throw new Error('Actual local field metadata differs from independent bytes')
    if (expected === null) continue
    for (let offset = 0; offset < expected.byteLength;) {
      check()
      const length = Math.min(997, expected.byteLength - offset)
      let escaped: Uint8Array | undefined
      await withBrc38NativeLocalFieldExtent(
        trx,
        { ...coordinate, offset, length, totalBytes: expected.byteLength },
        working,
        bytes => {
          return promiseFromSync(() => {
            escaped = bytes
            if (working.used !== 4096 + 32 * length)
              throw new Error('Local field scoped bytes lost their actual charge')
            for (let at = 0; at < length; at++)
              if (bytes[at] !== expected[offset + at])
                throw new Error('Actual local field differs from independent fixture bytes')
          })
        }
      )
      if (working.used !== 0 || escaped === undefined || escaped.some(byte => byte !== 0))
        throw new Error('Local field callback retained transport bytes or charge')
      offset += length
    }
  }
  if (expectedCells.size !== 0) throw new Error('Local field case omitted an independent cell oracle')
  const nonempty = fixtures.find(fixture => fixture.expected !== null && fixture.expected.byteLength > 0)
  if (nonempty === undefined) throw new Error('Local field case requires a nonempty independent extent')
  const failedCallback = new Error('Independent local field consumer failed'),
    selected = { ...nonempty.coordinate, offset: 0, totalBytes: nonempty.expected!.byteLength, length: 1 }
  let retained: Uint8Array | undefined, failure: unknown
  try {
    await withBrc38NativeLocalFieldExtent(trx, selected, working, bytes => {
      return promiseFromSync(() => {
        retained = bytes
        throw failedCallback
      })
    })
  } catch (error) {
    failure = error
  }
  if (failure !== failedCallback || retained?.byteLength !== 1 || retained[0] !== 0 || working.used !== 0)
    throw new Error('Failed local field consumer retained bytes/accounting or lost its error')
  let queried = false
  const raw = (): never => {
    queried = true
    throw new Error('Copied actor must issue no native metadata read')
  }
  let refused = false
  try {
    await readBrc38NativeLocalFieldBytes({ raw, isTransaction: true } as unknown as Knex.Transaction, {
      table: 'prepared_beefs',
      field: 'beef',
      rowId: 1
    })
  } catch {
    refused = true
  }
  if (!refused || queried) throw new Error('Copied transaction was admitted as a native local source')
  const controller = new AbortController(),
    reason = new Error('Independent original local-field cancellation')
  controller.abort(reason)
  failure = undefined
  try {
    await withBrc38NativeLocalFieldExtent(
      trx,
      selected,
      working,
      () => {
        return promiseFromSync(() => {
          queried = true
        })
      },
      controller.signal
    )
  } catch (error) {
    failure = error
  }
  if (failure !== reason || queried || working.used !== 0)
    throw new Error('Aborted local field operation lost its original cancellation or acquired resources')
}
