import type { Brc38NativeBlobRead, Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { brc38NativeTextCoordinate, encodeBrc38NativeTextRead } from './Brc38NativeBlobProtocol'
import type { Brc38NativeLocalFieldCoordinate } from './Brc38NativeLocalFieldProtocol'
import {
  brc38NativeLocalFieldCoordinate,
  brc38NativeLocalFieldKind,
  encodeBrc38NativeLocalFieldRead
} from './Brc38NativeLocalFieldProtocol'

export type Brc38NativePackedBinaryCoordinate =
  | Pick<Brc38NativeBlobRead, 'table' | 'field' | 'rowId'>
  | Extract<
      Brc38NativeLocalFieldCoordinate,
      {
        table:
          | 'prepared_beefs'
          | 'action_batch_blobs'
          | 'sync_transfer_parts'
          | 'snapshot_reconciliation_stage_pages'
          | 'snapshot_reconciliation_provenance'
      }
    >
export type Brc38NativePackedTextCoordinate =
  | Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'>
  | Extract<Brc38NativeLocalFieldCoordinate, { table: 'action_batches' | 'sync_transfers' | 'monitor_events' }>
export type Brc38NativePackedBinaryRead = Brc38NativePackedBinaryCoordinate &
  Readonly<{ offset: number; totalBytes: number; length: number }>
export type Brc38NativePackedTextRead = Brc38NativePackedTextCoordinate &
  Readonly<{ offset: number; totalBytes: number; length: number }>
function binaryLocal(input: Brc38NativePackedBinaryCoordinate): Brc38NativeLocalFieldCoordinate {
  return {
    ...input,
    table: input.table === 'provenTxs' ? 'proven_txs' : input.table === 'provenTxReqs' ? 'proven_tx_reqs' : input.table
  } as Brc38NativeLocalFieldCoordinate
}
/** Internal pointer coordinates only; the original operation6/7 encoders keep
 * their positive-ID writer/read contracts. No packet is sent by this helper. */
export function brc38NativePackedBinaryCoordinate(input: Brc38NativePackedBinaryCoordinate): readonly [number, number] {
  const local = binaryLocal(input)
  if (brc38NativeLocalFieldKind(local) !== 'blob') throw new TypeError('Invalid packed binary coordinate')
  return brc38NativeLocalFieldCoordinate(local)
}
export function validateBrc38NativePackedBinaryRead(input: Brc38NativePackedBinaryRead): void {
  brc38NativePackedBinaryCoordinate(input)
  encodeBrc38NativeLocalFieldRead({
    ...binaryLocal(input),
    offset: input.offset,
    totalBytes: input.totalBytes,
    length: input.length
  })
}
export function brc38NativePackedTextCoordinate(input: Brc38NativePackedTextCoordinate): readonly [number, number] {
  if (!Number.isSafeInteger(input.rowId)) throw new TypeError('Invalid packed TEXT key')
  if (input.table === 'action_batches' || input.table === 'sync_transfers' || input.table === 'monitor_events') {
    if (brc38NativeLocalFieldKind(input) !== 'text') throw new TypeError('Invalid packed TEXT coordinate')
    return brc38NativeLocalFieldCoordinate(input)
  }
  return brc38NativeTextCoordinate(input.table, input.field)
}
export function validateBrc38NativePackedTextRead(input: Brc38NativePackedTextRead): void {
  brc38NativePackedTextCoordinate(input)
  if (input.table === 'action_batches' || input.table === 'sync_transfers' || input.table === 'monitor_events')
    encodeBrc38NativeLocalFieldRead(input)
  else encodeBrc38NativeTextRead(input)
}
