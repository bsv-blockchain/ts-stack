import { awaitFromSync } from '../../utility/promiseFromSync'
import type { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import {
  brc38JsonStructuredFieldPolicy,
  type Brc38JsonStructuredFieldPolicy,
  type Brc38JsonStructuredFieldSink
} from './Brc38JsonStructuredFields'

/** Explicit actual browser actor binding. Raw structured bytes remain private;
 * grammar and digests never replace fresh indexed semantic validation. */
export function brc38IdbStructuredFieldSink(
  store: Brc38PrivateIdbStage,
  selected: Brc38JsonStructuredFieldPolicy,
  row: Brc38JsonStructuredFieldSink['row']
): Readonly<Brc38JsonStructuredFieldSink> {
  const policy = brc38JsonStructuredFieldPolicy(selected)
  if (
    policy.maximumStructuredBytes > store.limits.maximumLogicalBytes ||
    4096 + 32 * policy.maximumChunkBytes > store.limits.maximumRowAllocationBytes
  )
    throw new RangeError('Private browser structured chunks and original allocation differ')
  return Object.freeze({
    begin: (table, index, field) =>
      awaitFromSync(() => store.beginStructuredField(table, index, field, policy.maximumStructuredBytes)),
    append: (table, index, field, offset, bytes) =>
      awaitFromSync(() => store.appendStructuredField(table, index, field, offset, bytes)),
    finish: (table, index, field) => awaitFromSync(() => store.finishStructuredField(table, index, field)),
    row
  } satisfies Brc38JsonStructuredFieldSink)
}
