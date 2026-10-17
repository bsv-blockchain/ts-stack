import type { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import {
  brc38JsonStreamedFieldPolicy,
  type Brc38JsonStreamedFieldPolicy,
  type Brc38JsonStreamedFieldSink
} from './Brc38JsonBinaryFields'

/** Explicit parser/actual private IDB actor binding. No active wallet receiver,
 * authentication verdict, native adapter or capability is supplied here. */
export function brc38IdbStreamedFieldSink(
  store: Brc38PrivateIdbStage,
  selected: Brc38JsonStreamedFieldPolicy,
  row: Brc38JsonStreamedFieldSink['row']
): Readonly<Brc38JsonStreamedFieldSink> {
  const policy = brc38JsonStreamedFieldPolicy(selected)
  if (
    policy.maximumBinaryBytes > store.limits.maximumLogicalBytes ||
    4096 + 32 * policy.maximumChunkBytes > store.limits.maximumRowAllocationBytes
  )
    throw new RangeError('Private browser binary and original staging allocation differ')
  return Object.freeze({
    begin: async (table, index, field, encoding) =>
      await store.beginBinaryField(table, index, field, encoding, policy.maximumBinaryBytes),
    append: async (table, index, field, offset, bytes) =>
      await store.appendBinaryField(table, index, field, offset, bytes),
    finish: async (table, index, field) => await store.finishBinaryField(table, index, field),
    row
  } satisfies Brc38JsonStreamedFieldSink)
}
