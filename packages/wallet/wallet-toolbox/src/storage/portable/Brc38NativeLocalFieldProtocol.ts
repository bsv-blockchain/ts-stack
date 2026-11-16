/** Private coherent-baseline transport DATA. These fields remain outside the
 * BRC-38 archive format. No coordinate grants source, profile or row authority.
 * IDs 0..7 and their original binary/TEXT encodings remain unchanged. */
export type Brc38NativeLocalFieldCoordinate =
  | Readonly<{ table: 'transactions'; field: 'rawTx' | 'inputBEEF' | 'noSendExpiryReclaimRawTx'; rowId: number }>
  | Readonly<{ table: 'proven_txs'; field: 'rawTx' | 'merklePath'; rowId: number }>
  | Readonly<{ table: 'proven_tx_reqs'; field: 'rawTx' | 'inputBEEF'; rowId: number }>
  | Readonly<{ table: 'outputs' | 'commissions'; field: 'lockingScript'; rowId: number }>
  | Readonly<{ table: 'prepared_beefs'; field: 'beef'; rowId: number }>
  | Readonly<{ table: 'action_batch_blobs'; field: 'bytes'; rowId: number }>
  | Readonly<{ table: 'sync_transfer_parts'; field: 'bytes'; rowId: number }>
  | Readonly<{ table: 'action_batches'; field: 'uploadDigests' | 'result' | 'manifest'; rowId: number }>
  | Readonly<{ table: 'sync_transfers'; field: 'result'; rowId: number }>
  | Readonly<{ table: 'monitor_events'; field: 'details'; rowId: number }>
  | Readonly<{
      table: 'snapshot_reconciliation_stage_pages' | 'snapshot_reconciliation_provenance'
      field: 'payload'
      rowId: number
    }>
  | Readonly<{
      table: 'brc38_import_original' | 'brc38_import_streamed_original' | 'brc38_import_structured_original'
      field: 'originalJson'
      rowId: number
    }>
  | Readonly<{
      table:
        | 'private_binary_chunks'
        | 'private_text_chunks'
        | 'private_structured_chunks'
        | 'private_canonical_structured_chunks'
        | 'private_projected_structured_chunks'
      field: 'payload'
      rowId: number
    }>
export type Brc38NativeLocalFieldRead = Brc38NativeLocalFieldCoordinate &
  Readonly<{ offset: number; totalBytes: number; length: number }>

const sources = Object.freeze([
  Object.freeze({
    id: 0,
    table: 'transactions',
    fields: Object.freeze(['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']),
    kind: 'blob' as const
  }),
  Object.freeze({ id: 1, table: 'proven_txs', fields: Object.freeze(['rawTx', 'merklePath']), kind: 'blob' as const }),
  Object.freeze({
    id: 2,
    table: 'proven_tx_reqs',
    fields: Object.freeze(['rawTx', 'inputBEEF']),
    kind: 'blob' as const
  }),
  Object.freeze({ id: 3, table: 'outputs', fields: Object.freeze(['lockingScript']), kind: 'blob' as const }),
  Object.freeze({ id: 4, table: 'commissions', fields: Object.freeze(['lockingScript']), kind: 'blob' as const }),
  Object.freeze({ id: 8, table: 'prepared_beefs', fields: Object.freeze(['beef']), kind: 'blob' as const }),
  Object.freeze({ id: 9, table: 'action_batch_blobs', fields: Object.freeze(['bytes']), kind: 'blob' as const }),
  Object.freeze({ id: 10, table: 'sync_transfer_parts', fields: Object.freeze(['bytes']), kind: 'blob' as const }),
  Object.freeze({
    id: 11,
    table: 'action_batches',
    fields: Object.freeze(['uploadDigests', 'result', 'manifest']),
    kind: 'text' as const
  }),
  Object.freeze({ id: 12, table: 'sync_transfers', fields: Object.freeze(['result']), kind: 'text' as const }),
  Object.freeze({ id: 13, table: 'monitor_events', fields: Object.freeze(['details']), kind: 'text' as const }),
  Object.freeze({
    id: 14,
    table: 'snapshot_reconciliation_stage_pages',
    fields: Object.freeze(['payload']),
    kind: 'blob' as const
  }),
  Object.freeze({
    id: 15,
    table: 'snapshot_reconciliation_provenance',
    fields: Object.freeze(['payload']),
    kind: 'blob' as const
  }),
  Object.freeze({
    id: 16,
    table: 'brc38_import_original',
    fields: Object.freeze(['originalJson']),
    kind: 'text' as const
  }),
  Object.freeze({
    id: 17,
    table: 'brc38_import_streamed_original',
    fields: Object.freeze(['originalJson']),
    kind: 'text' as const
  }),
  Object.freeze({
    id: 18,
    table: 'brc38_import_structured_original',
    fields: Object.freeze(['originalJson']),
    kind: 'text' as const
  }),
  Object.freeze({ id: 19, table: 'private_binary_chunks', fields: Object.freeze(['payload']), kind: 'blob' as const }),
  Object.freeze({ id: 20, table: 'private_text_chunks', fields: Object.freeze(['payload']), kind: 'blob' as const }),
  Object.freeze({
    id: 21,
    table: 'private_structured_chunks',
    fields: Object.freeze(['payload']),
    kind: 'blob' as const
  }),
  Object.freeze({
    id: 22,
    table: 'private_canonical_structured_chunks',
    fields: Object.freeze(['payload']),
    kind: 'blob' as const
  }),
  Object.freeze({
    id: 23,
    table: 'private_projected_structured_chunks',
    fields: Object.freeze(['payload']),
    kind: 'blob' as const
  })
])
export function brc38NativeLocalFieldCoordinate(input: Brc38NativeLocalFieldCoordinate): readonly [number, number] {
  const table = sources.findIndex(source => source.table === input.table),
    field = table < 0 ? -1 : sources[table].fields.indexOf(input.field)
  if (table < 0 || field < 0 || !Number.isSafeInteger(input.rowId))
    throw new TypeError('Invalid fixed local native field coordinate')
  return Object.freeze([sources[table].id, field])
}
export function brc38NativeLocalFieldKind(input: Brc38NativeLocalFieldCoordinate): 'blob' | 'text' {
  const [id] = brc38NativeLocalFieldCoordinate(input)
  return sources.find(source => source.id === id)!.kind
}
/** One bounded extent only. Composite and non-integer primary keys use their
 * actual signed safe SQLite physical rowid in the same retained read view. */
export function encodeBrc38NativeLocalFieldRead(input: Brc38NativeLocalFieldRead): Uint8Array {
  const [table, field] = brc38NativeLocalFieldCoordinate(input)
  if (
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes < 1 ||
    input.totalBytes > 1000000000 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset >= input.totalBytes ||
    !Number.isSafeInteger(input.length) ||
    input.length < 1 ||
    input.length > 65536 ||
    input.length > input.totalBytes - input.offset
  )
    throw new TypeError('Invalid local native field extent')
  const body = new Uint8Array(28),
    view = new DataView(body.buffer)
  body[0] = table
  body[1] = field
  view.setBigInt64(4, BigInt(input.rowId), true)
  view.setUint32(12, input.offset, true)
  view.setUint32(16, input.totalBytes, true)
  view.setUint32(20, input.length, true)
  return body
}

/** Original local coordinates work with ABI1/2/3; journal BLOBs require
 * ABI2/3 and original-import cells require ABI3. This version check grants no transaction authority. */
export function brc38NativeLocalFieldProtocolMatches(input: Brc38NativeLocalFieldCoordinate, abi: unknown): boolean {
  const [table] = brc38NativeLocalFieldCoordinate(input)
  return abi === 3 || (abi === 2 && table < 16) || (abi === 1 && table < 14)
}
