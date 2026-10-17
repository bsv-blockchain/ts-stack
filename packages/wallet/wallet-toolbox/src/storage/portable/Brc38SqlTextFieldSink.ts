import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  brc38JsonTextFieldPolicy,
  type Brc38JsonTextFieldPolicy,
  type Brc38JsonTextFieldSink
} from './Brc38JsonTextFields'

/** Binds decoded scalar strings to the actual quota/expiry-owned private store.
 * Row admission still requires whole authentication and fresh original semantics. */
export function brc38SqlTextFieldSink(
  store: KnexBrc38StagingStore,
  selected: Brc38JsonTextFieldPolicy,
  row: Brc38JsonTextFieldSink['row']
): Readonly<Brc38JsonTextFieldSink> {
  const policy = brc38JsonTextFieldPolicy(selected)
  return Object.freeze({
    begin: async (table, index, field) => await store.beginTextField(table, index, field, policy.maximumTextBytes),
    append: async (table, index, field, offset, bytes) =>
      await store.appendTextField(table, index, field, offset, bytes),
    finish: async (table, index, descriptor) => await store.finishTextField(table, index, descriptor),
    row
  } satisfies Brc38JsonTextFieldSink)
}
