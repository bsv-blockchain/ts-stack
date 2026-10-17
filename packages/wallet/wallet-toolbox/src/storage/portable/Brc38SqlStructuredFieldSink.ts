import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  brc38JsonStructuredFieldPolicy,
  type Brc38JsonStructuredFieldPolicy,
  type Brc38JsonStructuredFieldSink
} from './Brc38JsonStructuredFields'

/** Actual private store binding for provisional UTF8 JSON chunks. The row
 * consumer uses the actual indexed semantic adapter and canonical private
 * field store. Bytes/hash/framing alone cannot seal, restore, publish or
 * activate a wallet; the full native structured destination remains required. */
export function brc38SqlStructuredFieldSink(
  store: KnexBrc38StagingStore,
  selected: Brc38JsonStructuredFieldPolicy,
  row: Brc38JsonStructuredFieldSink['row']
): Readonly<Brc38JsonStructuredFieldSink> {
  const policy = brc38JsonStructuredFieldPolicy(selected)
  return Object.freeze({
    begin: async (table, index, field) =>
      await store.beginStructuredField(table, index, field, policy.maximumStructuredBytes),
    append: async (table, index, field, offset, bytes) =>
      await store.appendStructuredField(table, index, field, offset, bytes),
    finish: async (table, index, descriptor) => await store.finishStructuredField(table, index, descriptor),
    row
  } satisfies Brc38JsonStructuredFieldSink)
}
