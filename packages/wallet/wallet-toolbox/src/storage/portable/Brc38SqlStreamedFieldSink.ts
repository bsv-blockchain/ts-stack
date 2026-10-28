import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  brc38JsonStreamedFieldPolicy,
  type Brc38JsonStreamedFieldPolicy,
  type Brc38JsonStreamedFieldSink
} from './Brc38JsonBinaryFields'

/** Internal private parser/store binding. The caller supplies field-aware
 * semantic row staging; no missing-binary placeholder enters the ordinary
 * semantic store. Authentication, full relations and native activation remain
 * separate actual operations. Construction grants none of those admissions. */
export function brc38SqlStreamedFieldSink(
  store: KnexBrc38StagingStore,
  selected: Brc38JsonStreamedFieldPolicy,
  row: Brc38JsonStreamedFieldSink['row']
): Readonly<Brc38JsonStreamedFieldSink> {
  const policy = brc38JsonStreamedFieldPolicy(selected)
  const sink: Brc38JsonStreamedFieldSink = {
    begin: async (table, index, field, encoding) =>
      await store.beginBinaryField(table, index, field, encoding, policy.maximumBinaryBytes),
    append: async (table, index, field, offset, bytes) =>
      await store.appendBinaryField(table, index, field, offset, bytes),
    finish: async (table, index, field) => await store.finishBinaryField(table, index, field),
    row
  }
  return Object.freeze(sink)
}
